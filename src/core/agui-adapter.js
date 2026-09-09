/**
 * agui-adapter — AG-UI 双名映射适配层
 *
 * 参考实现: D:\Down\ag-ui-main\docs\concepts\events.mdx + interrupts.mdx
 *
 * 职责: 把本项目自有的 SSE 事件词表(start/chunk/tool_call/run:finished/...)
 * 映射为 AG-UI 标准事件(RUN_STARTED / TEXT_MESSAGE_CHUNK / TOOL_CALL / STEP 等),
 * 在 sse-broadcast 与 chat-handler 的 safeWrite 处双名广播——旧事件名原样保留,
 * 旧前端 12 个订阅文件零改动; 新 AG-UI 客户端订阅标准事件名。
 *
 * 开关: AGUI_DUAL_BROADCAST=0 关闭双写(仅旧名), 便于逐步切换验证。
 *
 * 生命周期约定(与 AG-UI 一致):
 *   RUN_STARTED → (STEP_STARTED/STEP_FINISHED | TEXT_MESSAGE_CHUNK | TOOL_CALL_*)*
 *               → RUN_FINISHED{outcome:{type:'success'}} | RUN_ERROR | RUN_FINISHED{outcome:{type:'interrupt'}}
 *
 * interrupt 契约(interrupts.mdx):
 *   - 审批 = run 假终结: RUN_FINISHED{outcome:{type:'interrupt', interrupts:[{id,reason:'tool_call',...}]}}
 *     后端 waitForApproval 保持挂起(协议上"假终结"即可让标准客户端渲染 HITL UI)
 *   - 客户端以新 run 携带 resume:[{interruptId,status:'resolved'|'cancelled',payload?}] 恢复
 *   - approve-with-edits: payload.editedArgs 全量替换(非合并), 与现有 editedCommand+fail-closed 语义一致
 */

/** AG-UI 事件名(与参考实现 SDK 枚举一致) */
const AGUI = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  TEXT_MESSAGE_CHUNK: 'TEXT_MESSAGE_CHUNK',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  ACTIVITY_DELTA: 'ACTIVITY_DELTA',
  CUSTOM: 'CUSTOM',
};

function isAguiEnabled() {
  // 运行时读取(测试/kill switch 可在进程内切换)
  return process.env.AGUI_DUAL_BROADCAST !== '0';
}

// ── per-run 有界缓冲(thinking 累计全文) ──────────────
const MAX_BUFFER_ENTRIES = 50;
const MAX_THINKING_BYTES = 10 * 1024;
const thinkingBuffers = new Map(); // runId -> { text, ts }

function _prune(map) {
  if (map.size > MAX_BUFFER_ENTRIES) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function getThinkingText(runId, delta) {
  const key = runId || 'anon';
  const cur = thinkingBuffers.get(key);
  const text = (cur ? cur.text : '') + (delta || '');
  const truncated = text.length > MAX_THINKING_BYTES;
  thinkingBuffers.set(key, { text: truncated ? text.slice(-MAX_THINKING_BYTES) : text, ts: Date.now() });
  _prune(thinkingBuffers);
  return truncated ? text.slice(-MAX_THINKING_BYTES) : text;
}

// ── 幂等 LRU(记录已处理的 interruptId, 支持重复 resume 幂等返回) ─────
const RESUME_LRU_MAX = 200;
const handledResumes = new Map(); // interruptId -> true

function markResumeHandled(interruptId) {
  if (!interruptId) return;
  handledResumes.set(interruptId, true);
  if (handledResumes.size > RESUME_LRU_MAX) {
    handledResumes.delete(handledResumes.keys().next().value);
  }
}

function isResumeHandled(interruptId) {
  return handledResumes.has(interruptId);
}

// ── resume 翻译(纯函数: 条目 → 审批系统调用指令) ─────────────────────
/**
 * @param {{interruptId:string, status:'resolved'|'cancelled', payload?:any}} item
 * @returns {{kind:'respond'|'cancel', requestId:string, approved:boolean, scope:string, options:object} | {kind:'error', error:string}}
 */
function translateResume(item) {
  if (!item || typeof item !== 'object') return { kind: 'error', error: 'resume 条目无效' };
  const id = String(item.interruptId || '');
  if (!id) return { kind: 'error', error: 'resume 缺少 interruptId' };
  if (item.status === 'cancelled') {
    return { kind: 'cancel', requestId: id, approved: false, scope: 'once', options: {} };
  }
  if (item.status !== 'resolved') {
    return { kind: 'error', error: `resume status 非法: ${String(item.status)} (仅支持 resolved|cancelled)` };
  }
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  // AG-UI 拒绝表达在 payload 内({approved:false}), 非单独 status
  const approved = payload.approved !== false;
  const scope = ['once', 'session', 'always'].includes(payload.scope) ? payload.scope : 'once';
  const options = {};
  // approve-with-edits: editedArgs 全量替换, 与现有 editedCommand 语义一致
  if (typeof payload.editedArgs === 'string' && payload.editedArgs.trim().length > 0) {
    options.editedCommand = payload.editedArgs.trim();
  }
  if (payload.conversationId) options.conversationId = String(payload.conversationId);
  if (payload.userId) options.userId = String(payload.userId);
  return { kind: 'respond', requestId: id, approved, scope, options };
}

// ── 事件映射 ────────────────────────────────────────────────────────
// 2026-08-15 AG-UI 合规(审计 A 批): run 终态登记——verify 状态机禁止
// RUN_FINISHED/RUN_ERROR 后再收事件(activity:resolve/turn_complete/双通道重复
// 终帧都会被标准客户端拒收断流)。mapToAgui 对已终态 run 返回 [], 双通道
// 重复终帧一并去重。run:start 例外(新一轮开始)。
//
// 2026-08-15 D1(LOOP 修复 P1-1): 终态登记改为「双通道各允许一帧终态」的去重
// 语义——此前布尔拦截导致: /chat 流内 aguiWrite(buildRunFinishedSuccess) 先
// _markTerminal, 随后 /events 通道 broadcastEvent('run:finished') 的 mapToAgui
// 被 _isTerminal 拦截返回 [], /events 客户端永远收不到 RUN_FINISHED(interrupted
// 路径同理)。新语义: 流内 builder 登记时预留 allowance=1, /events 的终态帧仍
// 放行一次(1→0), 之后所有帧(中间帧/重复终帧)一律拦截; 仅 /events 通道的流程
// (无流内 aguiWrite)由 mapToAgui 终态帧自行登记且 allowance=0(该帧即唯一终态帧)。
//
// 2026-08-15 P2-6: 审批中断(approval_requested/taskflow_approval)是「假终结」——
// 不登记终态, resume 后同 run 继续发帧对严格状态机客户端合法; 最终用户可见终态
// 才登记。
const _terminalRuns = new Map(); // runId -> { ts, extra } extra=尚可放行的额外终态帧数
const TERMINAL_EVENT_TYPES = new Set(['run:finished', 'run:error', 'run:interrupt']);
// 2026-08-18 终审: step 边界帧(仅 turn-tracker 派生)——终态守卫豁免判定用 Set(热路径)
const STEP_FRAME_TYPES = new Set(['step:start', 'step:end']);
function _markTerminal(runId, allowOneMore = false) {
  if (!runId) return;
  const cur = _terminalRuns.get(runId);
  if (!cur) {
    _terminalRuns.set(runId, { ts: Date.now(), extra: allowOneMore ? 1 : 0 });
  } else {
    cur.ts = Date.now();
    // 流内 builder 先于 /events 广播时, 保证 /events 终态帧放行一次
    if (allowOneMore) cur.extra = 1;
  }
  if (_thinkingPrev.has(runId)) _thinkingPrev.delete(runId); // 终态即清思考切片记忆
  if (_streamThinkingPrev.has(runId)) _streamThinkingPrev.delete(runId);
  if (_terminalRuns.size > 50) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of _terminalRuns) if (v.ts < cutoff) _terminalRuns.delete(k);
  }
}
/** run 是否已登记终态(中间帧拦截依据) */
function _isMarkedTerminal(runId) {
  return !!runId && _terminalRuns.has(runId);
}
/** 终态帧放行判定: 未登记→登记(allowance=0)并放行; 已登记且 extra>0→extra-- 并放行; 否则拦截 */
function _allowTerminalFrame(runId) {
  if (!runId) return true; // runId 缺失时不拦截(旧事件无归属, 保持旧行为)
  const cur = _terminalRuns.get(runId);
  if (!cur) {
    _markTerminal(runId, false);
    return true;
  }
  if (cur.extra > 0) { cur.extra -= 1; return true; }
  return false;
}

// 2026-08-15 合规: thinking 增量切片记忆(run → 上次累计文本)
const _thinkingPrev = new Map();
// 2026-08-15 P2-2: /chat 流内独立切片游标与累计缓冲——与 /events 的 thinkingBuffers/
// _thinkingPrev 分离, 双通道各自产出正确增量(共享游标会让后消费的通道拿空增量,
// 共享累计缓冲会让文本翻倍)。
const _streamThinkingPrev = new Map();  // runId -> 上次已发累计文本(切片游标)
const _streamThinkingText = new Map();  // runId -> { text, ts } 累计缓冲

function _streamThinkingAccum(runId, delta) {
  const key = runId || 'anon';
  const cur = _streamThinkingText.get(key);
  const text = (cur ? cur.text : '') + (delta || '');
  const truncated = text.length > MAX_THINKING_BYTES;
  _streamThinkingText.set(key, { text: truncated ? text.slice(-MAX_THINKING_BYTES) : text, ts: Date.now() });
  _prune(_streamThinkingText);
  return truncated ? text.slice(-MAX_THINKING_BYTES) : text;
}

function _threadIdOf(data) {
  if (!data || typeof data !== 'object') return undefined;
  return data.threadId || data.conversationId || data.sessionId || data.userId || undefined;
}

function _runIdOf(data) {
  if (!data || typeof data !== 'object') return undefined;
  return data.runId || data.roundId || undefined;
}

/**
 * 把广播事件映射为 AG-UI 帧列表(可能 0 帧——不映射的事件返回 [])
 * @param {string} type 旧事件名
 * @param {any} data 广播 payload
 * @returns {Array<object>} AG-UI 帧(含 type 字段)
 */
function mapToAgui(type, data) {
  if (!isAguiEnabled()) return [];
  const threadId = _threadIdOf(data);
  const runId = _runIdOf(data);
  const custom = (name, value) => ({ type: AGUI.CUSTOM, name, value, threadId, runId });

  // 2026-08-15 合规: 已终态 run 不再发任何帧(verify 终态后禁发)——run:start
  // 例外(新一轮); 终态帧(run:finished/run:error/run:interrupt)走 _allowTerminalFrame
  // 的「双通道各一帧」放行(见 _terminalRuns 注释); runId 缺失时不拦截(旧事件
  // 无归属, 保持旧行为)。
  // 2026-08-18: step:start/step:end 豁免——step 帧仅由 turn-tracker 在
  // broadcastEvent(/events 通道)内派生, 从不经 /chat 流 aguiWrite, 豁免不会造成
  // 跨通道重复; 派生的 STEP_FINISHED 先于 RUN_FINISHED 广播, 顺序保持正确。
  // 否则双通道成功流中 buildRunFinishedSuccess 先 _markTerminal, 派生的最终
  // STEP_FINISHED 被此处吞掉, /events 客户端生命周期失衡(有 START 无 FINISH)。
  if (type !== 'run:start' && !STEP_FRAME_TYPES.has(type) && !TERMINAL_EVENT_TYPES.has(type) && _isMarkedTerminal(runId)) return [];

  switch (type) {
    case 'run:start':
      // 2026-08-15 A3(审计): /events 通道补 RUN_STARTED——此前只连 /events 的
      // 标准客户端永远见不到 run 开始(chat-handler 对称广播 run:start)
      return [{ type: AGUI.RUN_STARTED, threadId, runId }];
    case 'run:finished':
      if (!_allowTerminalFrame(runId)) return [];
      return [{ type: AGUI.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } }];
    case 'run:error':
      if (!_allowTerminalFrame(runId)) return [];
      return [{ type: AGUI.RUN_ERROR, threadId, runId, message: (data && data.error) || 'run error', code: (data && data.code) || undefined }];
    case 'run:interrupt':
      if (!_allowTerminalFrame(runId)) return [];
      return [{
        type: AGUI.RUN_FINISHED, threadId, runId,
        outcome: { type: 'interrupt', interrupts: [{ id: `stop-${runId || 'x'}`, reason: 'crabpaw:user_stop', message: '用户中断了本次对话' }] },
      }];
    case 'tool_call': {
      const toolCallId = data.toolId || `${runId || 'tool'}-${Date.now()}`;
      return [
        { type: AGUI.TOOL_CALL_START, toolCallId, toolCallName: data.toolName || 'tool', threadId, runId },
        { type: AGUI.TOOL_CALL_ARGS, toolCallId, delta: typeof data.toolArgs === 'string' ? data.toolArgs : JSON.stringify(data.toolArgs || {}), threadId, runId },
        { type: AGUI.TOOL_CALL_END, toolCallId, threadId, runId },
      ];
    }
    case 'tool_result': {
      // 2026-08-15 合规: TOOL_CALL_RESULT 补必填 messageId(events.ts 契约)
      const toolCallId = data.toolId || `${runId || 'tool'}-${Date.now()}`;
      return [{
        type: AGUI.TOOL_CALL_RESULT, threadId, runId,
        messageId: `tool-${toolCallId}`,
        toolCallId,
        content: data.result || data.summary || '',
        role: 'tool',
      }];
    }
    case 'step:start':
      return [{ type: AGUI.STEP_STARTED, threadId, runId, stepIndex: data.step, stepName: `step-${data.step}` }];
    case 'step:end':
      return [{ type: AGUI.STEP_FINISHED, threadId, runId, stepIndex: data.step }];
    case 'thinking': {
      // 2026-08-15 合规: thinking 增量语义——getThinkingText 返回累计全文,
      // 但 TEXT_MESSAGE_CHUNK.delta 是增量(客户端 append)。按 run 记 prev,
      // 新文本以旧文本为前缀 → 只发新增切片; 否则(状态消息被替换)发新值。
      const text = getThinkingText(runId, typeof data === 'string' ? data : (data && data.content) || '');
      const prev = _thinkingPrev.get(runId) || '';
      _thinkingPrev.set(runId, text);
      const delta = (prev && text.startsWith(prev)) ? text.slice(prev.length) : text;
      return [{
        type: AGUI.TEXT_MESSAGE_CHUNK, threadId, runId,
        messageId: `${runId || 'anon'}-think`,
        delta,
      }];
    }
    case 'approval_requested': {
      const expiresAtIso = data.expiresAt ? new Date(data.expiresAt).toISOString() : undefined;
      return [{
        type: AGUI.RUN_FINISHED, threadId: data.conversationId || threadId, runId,
        outcome: {
          type: 'interrupt',
          interrupts: [{
            id: data.requestId,
            reason: 'tool_call',
            message: data.message || data.command || '需要您的确认',
            toolCallId: data.requestId,
            expiresAt: expiresAtIso,
            responseSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
                scope: { type: 'string', enum: ['once', 'session', 'always'] },
                editedArgs: { type: 'string', description: '编辑后的命令(全量替换)' },
              },
              required: ['approved'],
            },
          }],
        },
      }];
    }
    case 'taskflow_approval': {
      const expiresAtIso = data.expiresAt ? new Date(data.expiresAt).toISOString() : undefined;
      return [{
        type: AGUI.RUN_FINISHED, threadId: data.conversationId || threadId, runId: data.flowId,
        outcome: {
          type: 'interrupt',
          interrupts: [{
            id: data.approvalId || data.flowId,
            reason: 'crabpaw:workflow_approval',
            message: data.message || '工作流需要您的确认',
            expiresAt: expiresAtIso,
            metadata: { resumeToken: data.resumeToken, flowId: data.flowId },
          }],
        },
      }];
    }
    case 'activity':
    case 'turn_complete':
      // 2026-08-15 合规: ACTIVITY_DELTA 补必填 messageId/activityType/patch
      // (events.ts 契约; 此前缺字段标准客户端 zod 校验失败断流)
      return [{
        type: AGUI.ACTIVITY_DELTA, threadId, runId,
        messageId: (data && (data.id || data.roundId)) || `${runId || 'anon'}-activity`,
        activityType: 'agent_activity',
        patch: [{ op: 'replace', path: '/latest', value: data || {} }],
      }];
    case 'heartbeat':
    case 'connected':
      // 心跳/握手不映射(非业务事件)
      return [];
    default:
      return [custom(type, data)];
  }
}

/** /chat 流内双写辅助——非映射事件(如 start)由调用方显式构造 RUN_STARTED */
function buildRunStarted(ctx) {
  if (!isAguiEnabled()) return null;
  return {
    type: AGUI.RUN_STARTED,
    threadId: ctx.threadId || undefined,
    runId: ctx.runId || undefined,
    input: ctx.input || undefined,
  };
}

function buildRunFinishedSuccess(ctx, result) {
  if (!isAguiEnabled()) return null;
  // allowOneMore: /chat 流内先发终态帧后, /events 通道 broadcastEvent 的
  // mapToAgui 终态帧仍放行一次(双通道各一帧, P1-1)
  _markTerminal(ctx.runId, true);
  return { type: AGUI.RUN_FINISHED, threadId: ctx.threadId, runId: ctx.runId, outcome: { type: 'success' }, result };
}

function buildRunError(ctx, message) {
  if (!isAguiEnabled()) return null;
  _markTerminal(ctx.runId, true);
  return { type: AGUI.RUN_ERROR, threadId: ctx.threadId, runId: ctx.runId, message: message || 'run error' };
}

function buildRunInterrupted(ctx) {
  if (!isAguiEnabled()) return null;
  _markTerminal(ctx.runId, true);
  return {
    type: AGUI.RUN_FINISHED, threadId: ctx.threadId, runId: ctx.runId,
    outcome: { type: 'interrupt', interrupts: [{ id: `stop-${ctx.runId || 'x'}`, reason: 'crabpaw:user_stop', message: '用户中断了本次对话' }] },
  };
}

/** 流内映射: chunk → AG-UI 帧列表(ctx 提供 runId/threadId) */
function mapStreamChunk(type, data, ctx) {
  if (!isAguiEnabled()) return [];
  const threadId = ctx.threadId;
  const runId = ctx.runId;
  const custom = (name, value) => ({ type: AGUI.CUSTOM, name, value, threadId, runId });
  switch (type) {
    case 'chunk':
      return [{ type: AGUI.TEXT_MESSAGE_CHUNK, messageId: `${runId || 'anon'}-msg`, role: 'assistant', delta: data.content, threadId, runId }];
    case 'thinking': {
      // 2026-08-15 P2-2: 与 mapToAgui 同款增量切片——此前把累计全文当 delta,
      // /chat 流内客户端 append 重复拼接(/events 客户端却收到增量, 两通道不同构)。
      const text = _streamThinkingAccum(runId, data.content || '');
      const prev = _streamThinkingPrev.get(runId) || '';
      _streamThinkingPrev.set(runId, text);
      const delta = (prev && text.startsWith(prev)) ? text.slice(prev.length) : text;
      return [{
        type: AGUI.TEXT_MESSAGE_CHUNK, messageId: `${runId || 'anon'}-think`,
        delta, threadId, runId,
      }];
    }
    case 'tool_call': {
      const toolCallId = data.toolId || `${runId || 'tool'}-${Date.now()}`;
      return [
        { type: AGUI.TOOL_CALL_START, toolCallId, toolCallName: data.toolName || 'tool', threadId, runId },
        { type: AGUI.TOOL_CALL_ARGS, toolCallId, delta: typeof data.toolArgs === 'string' ? data.toolArgs : JSON.stringify(data.toolArgs || {}), threadId, runId },
        { type: AGUI.TOOL_CALL_END, toolCallId, threadId, runId },
      ];
    }
    case 'tool_result': {
      // 2026-08-15 P2-2: 补必填 messageId(events.ts 契约, 与 /events mapToAgui 同构)
      const toolCallId = data.toolId || `${runId || 'tool'}-${Date.now()}`;
      return [{
        type: AGUI.TOOL_CALL_RESULT, messageId: `tool-${toolCallId}`, toolCallId, content: data.result || '', role: 'tool', threadId, runId,
      }];
    }
    case 'subagent':
    case 'eval_start':
    case 'eval_done':
    case 'loop_warning':
    case 'file_generated':
      return [custom(type, data)];
    default:
      return [];
  }
}

module.exports = {
  AGUI,
  isAguiEnabled,
  mapToAgui,
  mapStreamChunk,
  buildRunStarted,
  buildRunFinishedSuccess,
  buildRunError,
  buildRunInterrupted,
  translateResume,
  markResumeHandled,
  isResumeHandled,
  // 测试钩子
  _resetBuffers: () => { thinkingBuffers.clear(); _terminalRuns.clear(); _thinkingPrev.clear(); _streamThinkingPrev.clear(); _streamThinkingText.clear(); },
};
