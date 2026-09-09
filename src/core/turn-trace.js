'use strict';

/**
 * turn-trace.js — 回合级运行轨迹
 *
 * 设计参考 的 turn-level trace 系统：
 * 1. 每个对话回合（user→assistant）生成一个 TurnTrace
 * 2. 记录：用户输入、概念指纹、自我感知、工具调用链、最终响应、状态变化
 * 3. 支持持久化、查询、回放、性能分析
 * 4. 与 trace-context 集成，子调用自动挂到当前 turn
 *
 * 用途：
 * - 调试：复盘某轮工具调用顺序与结果
 * - 评估：检查 turn 完成度（计划/工具/响应数）
 * - 自适应：基于历史 turn 调整后续行为
 * - 审计：保留 turn 历史用于回溯
 *
 * 公开 API:
 * - TurnTrace 类（单回合）
 * - TurnTraceManager 类（多回合聚合）
 * - globalTurnTraceManager 单例
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { globalTraceContext } = require('./trace-context');
const { getConceptExtractor } = require('./concept-extractor');

// ── 持久化配置 ─────────────────────────────────
const MAX_TURNS = 200; // 内存保留上限
const PERSIST_FILE_MAX_BYTES = 12 * 1024 * 1024; // JSONL 文件上限 12MB

function _getPersistDir() {
 try {
 const { getDataDir } = require('./config');
 const dir = path.join(getDataDir(), 'traces');
 fs.mkdirSync(dir, { recursive: true });
 return dir;
 } catch {
 return null;
 }
}

function _persistFile() {
 const dir = _getPersistDir();
 return dir ? path.join(dir, 'turn-traces.jsonl') : null;
}

// ── Turn 状态 ─────────────────────────────────────
const TURN_STATES = {
 STARTED: 'started', // 回合开始
 ANALYZED: 'analyzed', // 已做概念/自我感知分析
 PLAN_READY: 'plan_ready', // 已确定计划（可选）
 TOOL_RUNNING: 'tool_running', // 正在执行工具
 TOOL_DONE: 'tool_done', // 工具全部完成
 RESPONDING: 'responding', // 生成响应中
 COMPLETED: 'completed', // 回合完成
 FAILED: 'failed', // 失败
 ABORTED: 'aborted', // 中止
};

const TOOL_STATUS = {
 PENDING: 'pending',
 RUNNING: 'running',
 SUCCESS: 'success',
 FAILED: 'failed',
 BLOCKED: 'blocked',
 TIMEOUT: 'timeout',
};

// ── Turn 记录结构 ─────────────────────────────────
class TurnTrace extends EventEmitter {
 /**
 * @param {object} options
 * @param {string} options.turnId - 唯一 ID
 * @param {string} options.sessionId
 * @param {string} options.userId
 * @param {string} options.userInput
 * @param {object} [options.context] - 附加上下文
 */
 constructor(options = {}) {
 super();
 this.turnId = options.turnId || globalTraceContext.createChildTraceId() || `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
 this.sessionId = options.sessionId || 'default';
 this.userId = options.userId || 'default';
 this.userInput = options.userInput || '';
 this.context = options.context || {};
 this.startedAt = Date.now();
 this.endedAt = null;
 this.state = TURN_STATES.STARTED;
 this.concepts = null;
 this.selfAwareness = null;
 this.plan = null;
 this.toolCalls = [];
 this.rounds = []; // LLM 调用轮次记录（用于细粒度调试）
 this.responses = [];
 this.messages = []; // 结束时快照消息（可选）
 this.error = null;
 this.metadata = {};
 }

 /**
 * 记录一轮 LLM 调用
 * @param {object} data
 * @param {number} [data.round] - 轮次序号
 * @param {string} [data.content] - 输出内容
 * @param {string} [data.reasoning] - 推理内容
 * @param {Array} [data.toolCalls] - [{ name, args }]
 * @param {boolean} [data.aborted] - 是否被终止
 */
 recordRound(data = {}) {
 const r = {
 round: data.round != null ? data.round : this.rounds.length,
 at: Date.now(),
 content: data.content || '',
 reasoning: data.reasoning || '',
 toolCalls: Array.isArray(data.toolCalls) ? data.toolCalls.map(tc => ({ name: tc.name || '?', args: tc.args })) : [],
 aborted: !!data.aborted,
 };
 this.rounds.push(r);
 this.emit('round', r);
 return r;
 }

 setState(state) {
 const oldState = this.state;
 this.state = state;
 this.emit('state', { turnId: this.turnId, from: oldState, to: state, at: Date.now() });
 }

 setConcepts(concepts) {
 this.concepts = concepts;
 this.setState(TURN_STATES.ANALYZED);
 }

 setSelfAwareness(awText) {
 this.selfAwareness = awText;
 }

 setPlan(plan) {
 this.plan = plan;
 this.setState(TURN_STATES.PLAN_READY);
 }

 /**
 * 记录一次工具调用
 * @param {object} call
 * { tool, params, result?, status, error?, startedAt, endedAt? }
 */
 recordToolCall(call) {
 const record = {
 seq: this.toolCalls.length + 1,
 tool: call.tool,
 params: call.params || {},
 result: call.result,
 status: call.status || TOOL_STATUS.PENDING,
 error: call.error,
 startedAt: call.startedAt || Date.now(),
 endedAt: call.endedAt,
 durationMs: call.endedAt ? (call.endedAt - call.startedAt) : 0,
 childTraceId: call.childTraceId || null,
 };
 this.toolCalls.push(record);
 this.setState(TURN_STATES.TOOL_RUNNING);
 this.emit('toolCall', record);
 return record;
 }

 completeToolCall(seq, patch = {}) {
 const tc = this.toolCalls.find(c => c.seq === seq);
 if (tc) {
 Object.assign(tc, patch);
 tc.endedAt = tc.endedAt || Date.now();
 tc.durationMs = tc.endedAt - tc.startedAt;
 }
 return tc;
 }

 recordResponse(text, kind = 'final') {
 const r = { kind, text, at: Date.now() };
 this.responses.push(r);
 this.setState(TURN_STATES.RESPONDING);
 return r;
 }

 /**
 * 结束回合
 * @param {object} opts
 * @param {string} [opts.response] - 最终响应
 * @param {string} [opts.error] - 错误消息
 * @param {boolean} [opts.aborted] - 是否中止
 * @param {Array} [opts.messages] - 最终消息快照（用于调试角色混淆）
 */
 complete({ response, error, aborted, messages } = {}) {
 if (response) this.recordResponse(response, 'final');
 if (messages && Array.isArray(messages)) {
 this.messages = messages.map(m => {
 if (!m || typeof m !== 'object') return { role: 'unknown', content: '' };
 return {
 role: m.role || 'unknown',
 content: String(m.content || ''),
 tool_calls: Array.isArray(m.tool_calls) ? m.tool_calls.map(tc => ({
 name: tc?.function?.name || tc?.name || '?',
 args: tc?.arguments || tc?.args || {},
 })) : undefined,
 };
 });
 }
 if (error) {
 this.error = error;
 this.setState(TURN_STATES.FAILED);
 } else if (aborted) {
 this.setState(TURN_STATES.ABORTED);
 } else {
 this.setState(TURN_STATES.COMPLETED);
 }
 this.endedAt = Date.now();
 this.totalDurationMs = this.endedAt - this.startedAt;
 this.emit('complete', this);
 }

 /**
 * 导出为可序列化 JSON
 */
 toJSON() {
 return {
 turnId: this.turnId,
 sessionId: this.sessionId,
 userId: this.userId,
 userInput: this.userInput,
 context: this.context,
 startedAt: this.startedAt,
 endedAt: this.endedAt,
 totalDurationMs: this.totalDurationMs || (this.endedAt ? this.endedAt - this.startedAt : null),
 state: this.state,
 concepts: this.concepts,
 selfAwareness: this.selfAwareness,
 plan: this.plan,
 toolCalls: this.toolCalls,
 rounds: this.rounds,
 responses: this.responses,
 messages: this.messages,
 error: this.error,
 metadata: this.metadata,
 };
 }

 /**
 * 简明摘要（适合日志/UI）
 */
 summary() {
 const toolStats = { total: this.toolCalls.length, success: 0, failed: 0 };
 for (const tc of this.toolCalls) {
 if (tc.status === TOOL_STATUS.SUCCESS) toolStats.success++;
 if (tc.status === TOOL_STATUS.FAILED) toolStats.failed++;
 }
 return {
 turnId: this.turnId,
 state: this.state,
 durationMs: this.totalDurationMs || (Date.now() - this.startedAt),
 toolStats,
 responseCount: this.responses.length,
 hasError: !!this.error,
 };
 }
}

// ── Manager ─────────────────────────────────────
class TurnTraceManager extends EventEmitter {
 constructor() {
 super();
 this._traces = new Map(); // turnId -> TurnTrace
 this._sessionTraces = new Map(); // sessionId -> [turnId]
 this._maxRetained = MAX_TURNS;
 this.setMaxListeners(100);
 }

 /**
 * 开始新回合
 * @param {object} options
 * @returns {TurnTrace}
 */
 startTurn(options = {}) {
 const ext = getConceptExtractor();
 const trace = new TurnTrace(options);
 // 自动分析概念
 if (trace.userInput) {
 try {
 trace.setConcepts(ext.extract(trace.userInput));
 } catch (e) {
   /* ignore */
   console.warn('[turn-trace.js] 空 catch 补日志:', e && e.message);
 }
 }
 this._traces.set(trace.turnId, trace);
 // 按 session 索引
 if (!this._sessionTraces.has(trace.sessionId)) {
 this._sessionTraces.set(trace.sessionId, []);
 }
 this._sessionTraces.get(trace.sessionId).push(trace.turnId);

 // 自动 GC
 if (this._traces.size > this._maxRetained) {
 const toRemove = this._traces.size - this._maxRetained;
 const keys = Array.from(this._traces.keys()).slice(0, toRemove);
 for (const k of keys) {
 const t = this._traces.get(k);
 this._traces.delete(k);
 // 也从 session 索引中删除
 const list = this._sessionTraces.get(t.sessionId);
 if (list) {
 const idx = list.indexOf(k);
 if (idx >= 0) list.splice(idx, 1);
 }
 }
 }

 this.emit('start', trace);

 // 自动持久化：turn 完成时写入磁盘
 trace.on('complete', (t) => {
 this._persistTrace(t);
 });

 return trace;
 }

 getTrace(turnId) {
 return this._traces.get(turnId);
 }

 getSessionTraces(sessionId) {
 const ids = this._sessionTraces.get(sessionId) || [];
 return ids.map(id => this._traces.get(id)).filter(Boolean);
 }

 /**
 * 获取回合列表（按时间排序）
 */
 listTraces(filter = {}) {
 let traces = Array.from(this._traces.values());
 if (filter.sessionId) traces = traces.filter(t => t.sessionId === filter.sessionId);
 if (filter.userId) traces = traces.filter(t => t.userId === filter.userId);
 if (filter.state) traces = traces.filter(t => t.state === filter.state);
 if (filter.since) traces = traces.filter(t => t.startedAt >= filter.since);
 return traces.sort((a, b) => a.startedAt - b.startedAt);
 }

 /**
 * 全局统计
 */
 getStats(filter = {}) {
 const traces = this.listTraces(filter);
 const stats = {
 total: traces.length,
 byState: {},
 totalToolCalls: 0,
 avgDurationMs: 0,
 errorCount: 0,
 };
 let totalDur = 0;
 let durCount = 0;
 for (const t of traces) {
 stats.byState[t.state] = (stats.byState[t.state] || 0) + 1;
 stats.totalToolCalls += t.toolCalls.length;
 if (t.totalDurationMs) {
 totalDur += t.totalDurationMs;
 durCount++;
 }
 if (t.error) stats.errorCount++;
 }
 stats.avgDurationMs = durCount > 0 ? Math.round(totalDur / durCount) : 0;
 return stats;
 }

 /**
 * 导出会话的所有回合
 */
 exportSession(sessionId) {
 const traces = this.getSessionTraces(sessionId);
 return {
 sessionId,
 exportedAt: Date.now(),
 count: traces.length,
 turns: traces.map(t => t.toJSON()),
 };
 }

 clear() {
 this._traces.clear();
 this._sessionTraces.clear();
 // 清除磁盘文件
 try {
 const file = _persistFile();
 if (file && fs.existsSync(file)) fs.unlinkSync(file);
 } catch (e) {
   /* ignore */
   console.warn('[turn-trace.js] 空 catch 补日志:', e && e.message);
 }
 this.emit('cleared', {});
 }

 get size() {
 return this._traces.size;
 }

 // ── 持久化 ─────────────────────────────────────
 _persistenceEnabled = true;

 setPersistenceEnabled(enabled) {
 this._persistenceEnabled = !!enabled;
 }

 /**
 * 从磁盘恢复历史 traces
 */
 restoreFromDisk() {
 if (!this._persistenceEnabled) return;
 try {
 const file = _persistFile();
 if (!file || !fs.existsSync(file)) return;
 const raw = fs.readFileSync(file, 'utf-8');
 const lines = raw.split('\n').filter(Boolean);
 // 只恢复最近 MAX_TURNS 条
 const tail = lines.slice(-MAX_TURNS);
 for (const line of tail) {
 try {
 const data = JSON.parse(line);
 if (!data || !data.turnId) continue;
 // 用已有数据还原 Trace 对象（不重建完整 TurnTrace 实例，保留序列化数据）
 const trace = new TurnTrace({
 turnId: data.turnId,
 sessionId: data.sessionId,
 userId: data.userId,
 userInput: data.userInput,
 context: data.context,
 });
 trace.startedAt = data.startedAt;
 trace.endedAt = data.endedAt;
 trace.state = data.state || TURN_STATES.COMPLETED;
 trace.totalDurationMs = data.totalDurationMs;
 trace.concepts = data.concepts;
 trace.selfAwareness = data.selfAwareness;
 trace.plan = data.plan;
 trace.toolCalls = data.toolCalls || [];
 trace.rounds = data.rounds || [];
 trace.responses = data.responses || [];
 trace.messages = data.messages || [];
 trace.error = data.error;
 trace.metadata = data.metadata || {};
 this._traces.set(trace.turnId, trace);
 if (!this._sessionTraces.has(trace.sessionId)) {
 this._sessionTraces.set(trace.sessionId, []);
 }
 this._sessionTraces.get(trace.sessionId).push(trace.turnId);
 } catch (e) {
   /* 跳过坏行 */
   console.warn('[turn-trace.js] 空 catch 补日志:', e && e.message);
 }
 }
 } catch (e) {
   /* 恢复失败静默 */
   console.warn('[turn-trace.js] 空 catch 补日志:', e && e.message);
 }
 }

 /**
 * 持久化一条 trace 到磁盘（append-only JSONL）
 */
 _persistTrace(trace) {
   if (!this._persistenceEnabled) return;
   try {
   const file = _persistFile();
   if (!file) return;
   const data = trace.toJSON ? trace.toJSON() : trace;
   fs.appendFileSync(file, JSON.stringify(data) + '\n', 'utf-8');
   // 文件过大时重写（保留当前内存中的 recent traces）
   const stat = fs.statSync(file);
   if (stat.size > PERSIST_FILE_MAX_BYTES) {
   const body = Array.from(this._traces.values())
   .slice(-MAX_TURNS)
   .map(t => JSON.stringify(t.toJSON()))
   .join('\n') + '\n';
   fs.writeFileSync(file, body, 'utf-8');
   }
   } catch (e) {
     /* 持久化失败静默 */
     console.warn('[turn-trace.js] 空 catch 补日志:', e && e.message);
   }

 }
}

let _instance = null;
function getTurnTraceManager() {
 if (!_instance) {
 _instance = new TurnTraceManager();
 // ── 初始化时从磁盘恢复 ──
 try {
 _instance.restoreFromDisk();
 } catch (e) {
   /* ignore */
   console.warn('[turn-trace.js] 空 catch 补日志:', e && e.message);
 }
 }
 return _instance;
}

module.exports = {
 TurnTrace,
 TurnTraceManager,
 getTurnTraceManager,
 TURN_STATES,
 TOOL_STATUS,
 MAX_TURNS,
};
