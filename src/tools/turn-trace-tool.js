'use strict';

/**
 * turn-trace-tool.js — AI 可调用的回合轨迹工具
 *
 * 工具:
 *   StartTurnTrace  — 开启新回合
 *   RecordToolCall  — 记录一次工具调用
 *   RecordResponse  — 记录响应片段
 *   CompleteTurn    — 结束当前回合
 *   GetTurnTrace    — 查询历史回合
 *   GetTraceStats   — 回合统计
 */

const { registry } = require('./registry');
const { getTurnTraceManager, TURN_STATES: _TURN_STATES, TOOL_STATUS } = require('../core/turn-trace');

let _currentTurnBySession = new Map();  // sessionId -> turnId

function _unwrap(res) {
  if (!res) return res;
  if (res.data && typeof res.data === 'object') return res.data;
  return res;
}

// ── StartTurnTrace ──────────────────────────────────
registry.register({
  name: 'StartTurnTrace',
  toolset: 'observability',
  category: 'trace',
  description: '开启一个回合轨迹。返回 turnId，后续工具调用和响应都挂到该 turn 上，便于事后回放、调试、统计。',
  schema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      userId: { type: 'string' },
      userInput: { type: 'string', description: '本回合用户输入' },
    },
    required: ['userInput'],
  },
  handler: async (params, ctx) => {
    const mgr = getTurnTraceManager();
    const sessionId = params.sessionId || ctx?.sessionId || 'default';
    const userId = params.userId || ctx?.userId || 'default';
    const trace = mgr.startTurn({ sessionId, userId, userInput: params.userInput });
    _currentTurnBySession.set(sessionId, trace.turnId);
    return {
      success: true,
      turnId: trace.turnId,
      sessionId,
      state: trace.state,
      concepts: trace.concepts ? { hash: trace.concepts.hash, summary: trace.concepts.summary } : null,
    };
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── RecordToolCall ───────────────────────────────
registry.register({
  name: 'RecordToolCall',
  toolset: 'observability',
  category: 'trace',
  description: '记录一次工具调用到当前回合。如果不指定 turnId，自动取该 session 上一个 StartTurnTrace。',
  schema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      turnId: { type: 'string' },
      tool: { type: 'string' },
      params: { type: 'object' },
      result: {},
      status: { type: 'string', enum: ['pending', 'running', 'success', 'failed', 'blocked', 'timeout'], default: 'success' },
      error: { type: 'string' },
    },
    required: ['tool'],
  },
  handler: async (params, ctx) => {
    const mgr = getTurnTraceManager();
    const sessionId = params.sessionId || ctx?.sessionId || 'default';
    let turnId = params.turnId || _currentTurnBySession.get(sessionId);
    if (!turnId) {
      // 没有 active turn，自动开启
      const trace = mgr.startTurn({ sessionId, userInput: '(auto)' });
      turnId = trace.turnId;
      _currentTurnBySession.set(sessionId, turnId);
    }
    const trace = mgr.getTrace(turnId);
    if (!trace) return { success: false, error: 'Turn not found' };
    const status = Object.values(TOOL_STATUS).includes(params.status) ? params.status : TOOL_STATUS.SUCCESS;
    const now = Date.now();
    const tc = trace.recordToolCall({
      tool: params.tool,
      params: params.params || {},
      result: params.result,
      status,
      error: params.error,
      startedAt: now,
      endedAt: status === 'pending' || status === 'running' ? null : now,
    });
    return { success: true, turnId, seq: tc.seq, tool: tc.tool, status: tc.status, durationMs: tc.durationMs };
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── RecordResponse ──────────────────────────────
registry.register({
  name: 'RecordResponse',
  toolset: 'observability',
  category: 'trace',
  description: '记录一次响应片段（中间 / 最终）。',
  schema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      turnId: { type: 'string' },
      text: { type: 'string' },
      kind: { type: 'string', enum: ['intermediate', 'final', 'tool-summary', 'error'], default: 'final' },
    },
    required: ['text'],
  },
  handler: async (params, ctx) => {
    const mgr = getTurnTraceManager();
    const sessionId = params.sessionId || ctx?.sessionId || 'default';
    const turnId = params.turnId || _currentTurnBySession.get(sessionId);
    if (!turnId) return { success: false, error: 'No active turn' };
    const trace = mgr.getTrace(turnId);
    if (!trace) return { success: false, error: 'Turn not found' };
    const r = trace.recordResponse(params.text, params.kind || 'final');
    return { success: true, turnId, at: r.at, kind: r.kind, responseCount: trace.responses.length };
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── CompleteTurn ────────────────────────────────
registry.register({
  name: 'CompleteTurn',
  toolset: 'observability',
  category: 'trace',
  description: '结束当前回合。',
  schema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      turnId: { type: 'string' },
      response: { type: 'string' },
      error: { type: 'string' },
      aborted: { type: 'boolean' },
    },
  },
  handler: async (params, ctx) => {
    const mgr = getTurnTraceManager();
    const sessionId = params.sessionId || ctx?.sessionId || 'default';
    const turnId = params.turnId || _currentTurnBySession.get(sessionId);
    if (!turnId) return { success: false, error: 'No active turn' };
    const trace = mgr.getTrace(turnId);
    if (!trace) return { success: false, error: 'Turn not found' };
    trace.complete({ response: params.response, error: params.error, aborted: params.aborted });
    _currentTurnBySession.delete(sessionId);
    return { success: true, summary: trace.summary() };
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── GetTurnTrace ───────────────────────────────
registry.register({
  name: 'GetTurnTrace',
  toolset: 'observability',
  category: 'trace',
  description: '查询历史回合轨迹。',
  schema: {
    type: 'object',
    properties: {
      turnId: { type: 'string' },
      sessionId: { type: 'string' },
      limit: { type: 'number', default: 5 },
    },
  },
  handler: async (params) => {
    const mgr = getTurnTraceManager();
    if (params.turnId) {
      const t = mgr.getTrace(params.turnId);
      return { success: !!t, turn: t ? t.toJSON() : null };
    }
    const list = mgr.listTraces({ sessionId: params.sessionId }).slice(-(params.limit || 5));
    return {
      success: true,
      count: list.length,
      turns: list.map(t => ({ ...t.toJSON(), _summary: t.summary() })),
    };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── GetTraceStats ──────────────────────────────
registry.register({
  name: 'GetTraceStats',
  toolset: 'observability',
  category: 'trace',
  description: '回合级统计：总数/状态分布/工具调用数/平均耗时/错误数。',
  schema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      since: { type: 'number', description: '起始时间（Unix ms）' },
    },
  },
  handler: async (params) => {
    const mgr = getTurnTraceManager();
    const stats = mgr.getStats({
      sessionId: params.sessionId,
      since: params.since,
    });
    return { success: true, stats };
  },
  isReadOnly: true,
  timeout: 3000,
});

console.log('🛰️ turn-trace 工具已注册 (StartTurnTrace, RecordToolCall, RecordResponse, CompleteTurn, GetTurnTrace, GetTraceStats)');

module.exports = {
  StartTurnTrace: 'StartTurnTrace',
  RecordToolCall: 'RecordToolCall',
  RecordResponse: 'RecordResponse',
  CompleteTurn: 'CompleteTurn',
  GetTurnTrace: 'GetTurnTrace',
  GetTraceStats: 'GetTraceStats',
};
