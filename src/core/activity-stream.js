/**
 * Activity Stream — 实时活动流
 *
 * 消费 EventBus / Tool Orchestrator 的事件，格式化为人类可读的活动记录，
 * 同时推送给：
 * - SSE 广播 (供 HTTP 客户端/前端消费)
 * - 终端输出 (命令行模式下的实时状态行)
 * - ActivityState (状态机推导)
 *

 * message_received → stream_start → tool_preparing → tool_executing
 * → tool_result → stream_chunk → response
 *
 * 设计原则：
 * - 每条活动包含：时间戳 + 类型 + 摘要 + 详情（可选）
 * - 工具调用形成可追溯的层次结构
 * - 终端输出按重要性分级（error > warn > info > debug）
 */

const { globalActivityState, STATES: _STATES } = require('./activity-state');
const { broadcastEvent } = require('./sse-broadcast');

// ─── 2026-08-13: 结构化结果 payload(P1-8, ag-ui ActivityDelta 借鉴) ───
// 工具结果附加结构化负载供前端三态卡片展示;2KB 截断先于脱敏(降低处理成本);
// 对象字段经 audit-log-v2 redactSensitive 脱敏,字符串内容经正则遮蔽。
const RESULT_PAYLOAD_MAX = 2048;
const STRING_SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|password\s*[=:]\s*\S+|token\s*[=:]\s*\S+)/gi;

/** 遮蔽密钥匹配段中的 token,保留前缀(sk-/Bearer/等) */
function maskSecret(match) {
  const prefixMatch = /^(sk-|Bearer\s+|password\s*[=:]\s*|token\s*[=:]\s*)/i.exec(match);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const rest = match.slice(prefix.length);
  return prefix + rest.replace(/[A-Za-z0-9._-]{4,}/g, '****');
}

/**
 * 将工具结果构建为可广播的结构化 payload
 * @param {*} result 工具执行返回的原始对象
 * @returns {{ success: boolean, error: string|null, content: string }}
 */
function buildResultPayload(result) {
  try {
    if (result == null) return { success: true, error: null, content: '' };
    let content;
    if (typeof result === 'string') {
      content = result;
    } else {
      const { redactSensitive } = require('./audit-log-v2');
      const redacted = redactSensitive(result);
      content = typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
    }
    content = content.replace(STRING_SECRET_RE, maskSecret);
    const truncated = content.length > RESULT_PAYLOAD_MAX
      ? content.slice(0, RESULT_PAYLOAD_MAX) + '…[截断]'
      : content;
    return {
      success: !result?.error && typeof result?.error !== 'string',
      error: typeof result?.error === 'string' ? result.error.slice(0, 500) : null,
      content: truncated,
    };
  } catch (e) {
    console.warn('[activity-stream] buildResultPayload 失败:', e?.message || e);
    return { success: false, error: 'payload 构建失败', content: '' };
  }
}

// ─── 活动级别 ───
const LEVEL = {
 ERROR: 'error',
 WARN: 'warn',
 INFO: 'info',
 DEBUG: 'debug',
};

// ─── 活动类型 ───
const TYPE = {
  MESSAGE_RECEIVED: 'message_received', // 收到用户消息
  THINKING: 'thinking', // 模型推理中
  TOOL_ACK: 'tool_ack', // 慢操作确认（"正在搜索…"）
  TOOL_PREPARING: 'tool_preparing', // 准备工具
  TOOL_EXECUTING: 'tool_executing', // 执行工具
  TOOL_RESULT: 'tool_result', // 工具结果
  STREAM_CHUNK: 'stream_chunk', // 流式输出块
  RESPONSE: 'response', // 完整回复
  TURN_COMPLETE: 'turn_complete', // 一轮完成（Agent 主动信号）
  TTS_PLAYING: 'tts_playing', // TTS 播放
  SYSTEM: 'system', // 系统事件
  ERROR: 'error', // 出错
  // 2026-08-15 P2-9: 中断相位——用户中断此前记成 error(前端呈现模型出错红标),
  // 独立类型后前端可按事件类型区分(中断≠出错), 状态机回 idle 而非 error。
  INTERRUPT: 'interrupt', // 用户中断/连接断开
};

// ─── 活动级别映射 ───
const TYPE_LEVEL = {
 [TYPE.MESSAGE_RECEIVED]: LEVEL.INFO,
 [TYPE.THINKING]: LEVEL.INFO,
 [TYPE.TOOL_ACK]: LEVEL.INFO,
 [TYPE.TOOL_PREPARING]: LEVEL.INFO,
 [TYPE.TOOL_EXECUTING]: LEVEL.DEBUG,
 [TYPE.TOOL_RESULT]: LEVEL.INFO,
 [TYPE.STREAM_CHUNK]: LEVEL.DEBUG,
 [TYPE.RESPONSE]: LEVEL.INFO,
 [TYPE.TTS_PLAYING]: LEVEL.INFO,
 [TYPE.SYSTEM]: LEVEL.INFO,
 [TYPE.ERROR]: LEVEL.ERROR,
 // 2026-08-15 P2-9: 中断为 INFO 级(非出错)
 [TYPE.INTERRUPT]: LEVEL.INFO,
};

// ─── 活动图标 ───
const TYPE_ICON = {
 [TYPE.MESSAGE_RECEIVED]: '📩',
 [TYPE.THINKING]: '🧠',
 [TYPE.TOOL_ACK]: '⏳',
 [TYPE.TOOL_PREPARING]: '⚙️',
 [TYPE.TOOL_EXECUTING]: '🔧',
 [TYPE.TOOL_RESULT]: '✅',
 [TYPE.STREAM_CHUNK]: '💬',
 [TYPE.RESPONSE]: '✨',
 [TYPE.TTS_PLAYING]: '🔊',
 [TYPE.SYSTEM]: '⚡',
 [TYPE.ERROR]: '❌',
 // 2026-08-15 P2-9: 中断图标(🛑)——区别于 ❌ 错误
 [TYPE.INTERRUPT]: '🛑',
};

// ─── 工具动作动词映射（用于 ACK 文案） ───
function getToolActionVerb(toolName) {
 const verbMap = {
 WebSearch: '搜索', web_search: '搜索', search: '搜索',
 WebFetch: '获取', fetch_url: '获取', fetch: '获取',
 WebExtract: '解析', ImageGenerate: '生成图片', image: '生成',
 VideoGenerate: '生成视频', GenerateMusic: '生成音乐',
 TextToSpeech: '合成语音', speak: '朗读',
 WriteFile: '写入', write_file: '写入',
 ReadFile: '读取', read_file: '读取',
 ExecCommand: '执行', exec_command: '执行', bash: '执行',
 MemorySearch: '检索', search_memory: '检索',
 BrowserControl: '打开网页', browser_read: '读取网页',
 };
 return verbMap[toolName] || '处理';
}

class ActivityStream {
 constructor() {
 this._activities = [];
 this._maxActivities = 200;
 this._enabled = true;
 this._terminalEnabled = true; // 是否在终端输出
 this._sseEnabled = true; // 是否广播 SSE
 this._stateEnabled = true; // 是否推导状态机
 this._onActivity = null; // 外部回调钩子
 // ── 回合追踪（回合追踪 设计：thinking → done 必须共享 roundId）──
 // 每条 LLM 调用有独立 roundId，事件链（thinking → tool_* → response/error）共享
 this._currentRoundId = null;
 this._lastRoundId = null;
 // 2026-08-14 意识心跳: 最近一次活动时间戳——broadcastHeartbeat 判定"活跃/静息"
 this._lastActiveAt = Date.now();
 }

 /** 获取活动历史 */
 get activities() { return [...this._activities]; }

 /** B2/C2(Runtime差距分析): 当前回合 runId 只读访问——工具执行上下文/审计关联用 */
 getCurrentRoundId() { return this._currentRoundId || null; }

 /** 获取最近 N 条活动 */
 recent(n = 20) { return this._activities.slice(-n); }

 /** 启用/禁用 */
 set enabled(v) { this._enabled = v; }
 set terminalEnabled(v) { this._terminalEnabled = v; }
 set sseEnabled(v) { this._sseEnabled = v; }
 set stateEnabled(v) { this._stateEnabled = v; }

 /** 注册外部回调（用于自定义渲染） */
 onActivity(cb) { this._onActivity = cb; }

 /**
 * 记录一条活动
 * @param {string} type 活动类型 (TYPE.*)
 * @param {object} options
 * @param {string} options.summary 单行摘要
 * @param {string} options.detail 详情（可选）
 * @param {string} options.toolName 工具名（可选）
 * @param {string} options.model 模型名（可选）
 * @param {number} options.duration 耗时ms（可选）
 * @param {boolean} options.silent 静默模式（不推状态机）
 */
 record(type, options = {}) {
 if (!this._enabled) return;
 // 2026-08-14 意识心跳: 任何活动事件都刷新活跃时间戳(心跳判定数据源)
 this._lastActiveAt = Date.now();

 // ── 2026-08-15 P1-4: roundId 回退 debug 标记——显式 roundId 缺失且回退到
 // 全局 _currentRoundId 时打日志, 便于发现调用方漏传(并发双流错乱的根因)。
 let resolvedRoundId = null;
 if (options.roundId) {
   resolvedRoundId = options.roundId;
 } else if (this._currentRoundId) {
   console.debug(`[activity-stream] roundId 回退 _currentRoundId(调用方未显式传入): type=${type}, summary=${options.summary || ''}`);
   resolvedRoundId = this._currentRoundId;
 }
 const activity = {
 id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
 type,
 level: TYPE_LEVEL[type] || LEVEL.INFO,
 icon: TYPE_ICON[type] || '•',
 summary: options.summary || type,
 detail: options.detail || null,
 toolName: options.toolName || null,
 model: options.model || null,
 duration: options.duration || null,
 // ── 关键：透传 roundId / status，让前端能正确归并到同一 round ──
 roundId: resolvedRoundId,
 status: options.status || null,
 // 2026-08-13 P1-8: 工具卡三态结构化负载(cardState: running/done/error)
 cardState: options.cardState || null,
 resultPayload: options.resultPayload || null,
 timestamp: Date.now(),
 };

 this._activities.push(activity);
 if (this._activities.length > this._maxActivities) {
 this._activities = this._activities.slice(-this._maxActivities);
 }

 // SSE 广播（异步、不阻塞）
 if (this._sseEnabled) {
 this._broadcastSSE(activity);
 }

 // 终端输出（抑制 DEBUG 级别的高频事件）
 if (this._terminalEnabled && activity.level !== LEVEL.DEBUG) {
 this._printToTerminal(activity);
 }

 // 推导状态机
 if (this._stateEnabled && !options.silent) {
 this._deriveState(activity);
 }

 // 外部回调
 if (this._onActivity) {
 try { this._onActivity(activity); } catch (e) { console.warn('[activity-stream] onActivity 回调失败:', e?.message || e); }
 }
 }

 /**
 * 便捷方法：记录慢工具 ACK
 * 执行时间超过 2s 的工具自动发送 ACK 事件
 */
 recordToolAck(toolName, options = {}) {
 this.record(TYPE.TOOL_ACK, {
 summary: options.summary || `正在${getToolActionVerb(toolName)}…`,
 detail: options.detail,
 toolName,
 roundId: options.roundId || this._currentRoundId || null,
 silent: false,
 });
 }

 /**
 * 便捷方法：记录工具调用
 * voice-wake.js 的 SSE 事件序列
 */
 recordToolEvent(phase, toolName, options = {}) {
 const typeMap = {
 preparing: TYPE.TOOL_PREPARING,
 executing: TYPE.TOOL_EXECUTING,
 result: TYPE.TOOL_RESULT,
 error: TYPE.ERROR,
 ack: TYPE.TOOL_ACK,
 };
 const type = typeMap[phase] || TYPE.TOOL_EXECUTING;

 const summaryMap = {
 preparing: `准备工具: ${toolName}`,
 executing: `执行: ${toolName}`,
 result: `工具完成: ${toolName}`,
 error: `工具出错: ${toolName}`,
 ack: `正在${getToolActionVerb(toolName)}…`,
 };

 // 2026-08-15 审查返工 Minor-6: 显式 roundId 缺失的 debug 标记前移——此前标记
 // 在 record() 内, 但 recordToolEvent 自身先回退 _currentRoundId 再传 record(),
 // 标记永不触发。现在在回退发生处打日志(并发双流错乱的根因线索)。
 if (!options.roundId) {
 console.debug(`[activity-stream] recordToolEvent 未显式传入 roundId(回退 ${this._currentRoundId ? '_currentRoundId' : 'null'}): tool=${toolName}, phase=${phase}`);
 }
 this.record(type, {
 summary: options.summary || summaryMap[phase] || `${toolName}`,
 detail: options.detail,
 toolName,
 duration: options.duration,
 roundId: options.roundId || this._currentRoundId || null, // 工具事件归属当前 round
 silent: options.silent || false,
 // 2026-08-13 P1-8: 三态负载透传(显式字段,不透传任意 options)
 cardState: options.cardState || null,
 resultPayload: options.resultPayload || null,
 });
 }

 /**
 * 便捷方法：记录 LLM 活动
 *
 * 关键设计（回合追踪）：
 * start → 生成新 roundId，记为 _currentRoundId（同时记为 _lastRoundId）
 * chunk → 复用 _currentRoundId（多个 chunk 共享同一 round）
 * end → 复用 _currentRoundId，标记 round 结束
 * error → 复用 _currentRoundId，标记 round 结束（防止卡在"思考中"）
 *
 * 工具事件在 LLM 调用期间会通过 _currentRoundId 自动归属到同一 round
 */
 recordLLMEvent(phase, options = {}) {
 const typeMap = {
 start: TYPE.THINKING,
 chunk: TYPE.STREAM_CHUNK,
 end: TYPE.RESPONSE,
 error: TYPE.ERROR,
 // 2026-08-15 P2-9: 中断相位——用户中断/连接断开(此前记 error → 前端红标)
 interrupt: TYPE.INTERRUPT,
 };
 const type = typeMap[phase] || TYPE.THINKING;

 const summaryMap = {
 start: '模型开始推理',
 chunk: '生成回复中...',
 end: '回复完成',
 error: '模型推理出错',
 // 2026-08-15 P2-9
 interrupt: '对话已中断',
 };

 // 关键：start 阶段生成新 roundId；其他阶段复用
 let roundId = options.roundId;
 if (phase === 'start') {
 roundId = options.roundId || `round-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
 this._currentRoundId = roundId;
 this._lastRoundId = roundId;
 } else if (!roundId) {
 roundId = this._currentRoundId || this._lastRoundId || `round-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
 }
  if (phase === 'end' || phase === 'error' || phase === 'interrupt') {
    // round 结束，保留 _lastRoundId 供 fallback，但不更新 _currentRoundId
    // 关键：回写同一 roundId 的 thinking 条目状态为 done，
    // 防止前端轮询只拿到 thinking 条目时永久显示"思考中"
    // 2026-08-13 P2-2: status 区分——turn_complete 广播携带完成/失败语义
    // 2026-08-15 P2-9: interrupted 终态——前端按 status 区分中断/出错
    this._resolveRound(roundId, phase === 'error' ? 'error' : (phase === 'interrupt' ? 'interrupted' : 'done'));
  }

  this.record(type, {
    summary: options.summary || summaryMap[phase] || '',
    detail: options.detail,
    model: options.model,
    roundId,
    status: (phase === 'end' || phase === 'error') ? 'done' : (phase === 'interrupt' ? 'interrupted' : (phase === 'start' ? 'thinking' : 'streaming')),
    silent: phase === 'chunk', // chunk 是高频事件，不推状态机
  });
  // 2026-08-13 P2-2: start 分支返回 roundId——chat-handler 广播 run 事件需要
  return phase === 'start' ? roundId : undefined;
  }

  /**
   * 回写 roundId 对应的所有 thinking 条目为 done。
   * 当 LLM 调用结束（end/error）时调用，确保前端轮询不会看到卡住的"思考中"。
   */
  _resolveRound(roundId, status = 'done') {
    if (!roundId) return;
    let changed = false;
    for (const activity of this._activities) {
      if (activity.roundId === roundId && activity.type === TYPE.THINKING && activity.status !== 'done') {
        activity.status = 'done';
        activity.summary = activity.summary === '模型开始推理' ? '模型推理完成' : activity.summary;
        changed = true;
      }
    }
    if (changed) {
      // 广播变更，前端可据此刷新
      try {
        broadcastEvent('activity:resolve', { roundId, timestamp: Date.now() });
      } catch (e) { console.warn('[activity-stream] activity:resolve 广播失败:', e?.message || e); }
    }
    // 广播 turn_complete 事件，前端 ActivityStream 立即标记回合完成
    // 2026-08-13 P2-2: payload 携带 status(finished/error),供前端区分终态
    try {
      broadcastEvent('turn_complete', { roundId, status, timestamp: Date.now() });
    } catch (e) { console.warn('[activity-stream] turn_complete 广播失败:', e?.message || e); }
  }

 /**
 * 便捷方法：TTS 活动
 */
 recordTTSEvent(phase, options = {}) {
 const type = phase === 'start' || phase === 'playing'
 ? TYPE.TTS_PLAYING
 : phase === 'end' ? TYPE.RESPONSE : TYPE.ERROR;

 const summaryMap = {
 start: '开始语音播放',
 playing: '语音播放中',
 end: '语音播放完成',
 error: '语音播放失败',
 };

 this.record(type, {
 summary: options.summary || summaryMap[phase] || '',
 detail: options.detail,
 toolName: 'TTS',
 duration: options.duration,
 });
 }

 /**
 * 2026-08-14 意识心跳广播——每 15s 由模块底部循环调用。
 * active=true 表示最近 30s 内有活动事件(对话/工具/思考/TTS 等)——
 * 前端 ECG 据此渲染: 活跃=蓝色脉冲波形, 静息=低幅呼吸基线(非造假,
 * 由真实活动驱动, DingDong 活动驱动心跳对齐)。
 */
 broadcastHeartbeat() {
 try {
 if (!this._enabled) return;
 const active = Date.now() - this._lastActiveAt < 30000;
 broadcastEvent('heartbeat', { active, timestamp: Date.now() });
 } catch (e) {
 // 心跳广播失败不阻塞主流程(2026-08-15 P2-10: 落 debug 日志)
 console.debug('[activity-stream] 心跳广播失败:', e?.message || e);
 }
 }

 // ─── 内部 ───

 _broadcastSSE(activity) {
 try {
 broadcastEvent('activity', {
 // 2026-08-15 合规: 补 id——前端按 id 去重(重连补发/重复帧不再产生
 // 重复日志条目, AG-UI messageId/toolCallId 幂等同款思路)
 id: activity.id,
 type: activity.type,
 level: activity.level,
 summary: activity.summary,
 detail: activity.detail,
 toolName: activity.toolName,
 model: activity.model,
 duration: activity.duration,
 roundId: activity.roundId,
 status: activity.status,
 // 2026-08-13 P1-8: 三态负载透传(显式白名单,不透传任意 options)
 cardState: activity.cardState || null,
 resultPayload: activity.resultPayload || null,
 timestamp: activity.timestamp,
 });
 } catch (e) {
 // SSE 广播失败不阻塞主流程(2026-08-15 P2-10: 落 debug 日志)
 console.debug('[activity-stream] SSE 广播失败:', e?.message || e);
 }
 }

 _printToTerminal(activity) {
 const ts = new Date(activity.timestamp).toLocaleTimeString();
 const prefix = activity.duration
 ? `${activity.icon} [${ts}] ${activity.summary} (${activity.duration}ms)`
 : `${activity.icon} [${ts}] ${activity.summary}`;

 switch (activity.level) {
 case LEVEL.ERROR:
 console.error(`\x1b[31m${prefix}\x1b[0m`); // 红色
 break;
 case LEVEL.WARN:
 console.warn(`\x1b[33m${prefix}\x1b[0m`); // 黄色
 break;
 case LEVEL.INFO:
 console.log(`\x1b[36m${prefix}\x1b[0m`); // 青色
 break;
 default:
 console.log(prefix);
 }
 }

 _deriveState(activity) {
 try {
 const eventMap = {
 [TYPE.MESSAGE_RECEIVED]: 'llm:start',
 [TYPE.THINKING]: 'llm:start',
 [TYPE.TOOL_PREPARING]: 'tool:preparing',
 [TYPE.TOOL_EXECUTING]: 'tool:executing',
 [TYPE.TOOL_RESULT]: 'tool:result',
 [TYPE.STREAM_CHUNK]: 'llm:chunk',
 [TYPE.RESPONSE]: 'llm:end',
 [TYPE.TTS_PLAYING]: 'tts:start',
 [TYPE.ERROR]: 'tool:error',
 // 2026-08-15 P2-9: 中断结束本轮 → 状态机回 idle(不落 error 态)
 [TYPE.INTERRUPT]: 'llm:end',
 };

 const stateEvent = eventMap[activity.type];
 if (stateEvent) {
 globalActivityState.consume(stateEvent, {
 toolName: activity.toolName,
 message: activity.summary,
 });
 }
 } catch (e) {
 // 状态推导失败不影响主流程
 console.warn('[activity-stream] 状态推导失败:', e?.message || e);
 }
 }

 /** 清空活动历史 */
 clear() {
 this._activities = [];
 }

 /** 获取统计 */
 getStats() {
 const counts = {};
 for (const a of this._activities) {
 counts[a.type] = (counts[a.type] || 0) + 1;
 }
 return {
 total: this._activities.length,
 byType: counts,
 state: globalActivityState.state,
 stateElapsed: globalActivityState.elapsed,
 };
 }
}

// ─── 全局单例 ───
const globalActivityStream = new ActivityStream();

// 2026-08-14 意识心跳循环(15s)——广播 heartbeat 事件驱动前端 ECG。
// unref: 定时器不阻止进程退出(jest 加载本模块不挂住测试进程)。
const heartbeatLoop = setInterval(() => globalActivityStream.broadcastHeartbeat(), 15000);
if (heartbeatLoop.unref) heartbeatLoop.unref();

module.exports = {
 ActivityStream,
 globalActivityStream,
 TYPE,
 LEVEL,
 // 2026-08-13 P1-8: 结构化结果 payload 构建(单测入口)
 buildResultPayload,
};
