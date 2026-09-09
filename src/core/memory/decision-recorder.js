/**
 * decision-recorder.js — run 级决策折叠纯函数核心（SSE 事件 → Decision 记录）
 * 零 IO、零依赖：折叠状态机 + 哈希数学。存储/接线在 provenance-chain / decision-feed。
 */
const crypto = require('crypto');

const EVIDENCE_TOOLS = ['KbSearch', 'KbList', 'Memory', 'MemoryRecall', 'DecisionTrace'];
const TOOL_DIGEST_MAX = 20;
const INTENT_MAX = 500;
const CONCLUSION_MAX = 2000;
const ARG_MAX = 200;
const EVIDENCE_SUMMARY_MAX = 200;

function createFoldState() {
  return { runs: new Map() };
}

function foldRunEvent(state, eventType, data = {}) {
  const runId = data.runId || data.roundId || data.flowId;
  if (!runId) return { decision: null };
  let run = state.runs.get(runId);

  switch (eventType) {
    case 'run:start': {
      // 2026-08-20 终审 M2: 防御——已打开的 run 不覆写（避免丢弃已折叠的工具摘要）
      if (run) return { decision: null };
      run = {
        runId,
        userIntent: data.userInput ? String(data.userInput).slice(0, INTENT_MAX) : '',
        toolCalls: new Map(), // toolId -> digest
        conclusion: '',
        createdAt: data.ts || Date.now(),
        startedAt: data.ts || Date.now(),
      };
      state.runs.set(runId, run);
      return { decision: null };
    }
    case 'tool_call': {
      if (!run) {
        run = { runId, userIntent: '', toolCalls: new Map(), conclusion: '', createdAt: data.ts || Date.now() };
        state.runs.set(runId, run);
      }
      run.toolCalls.set(data.toolId || 'anon', {
        toolName: data.toolName || 'unknown',
        toolId: data.toolId || 'anon',
        args: String(data.toolArgs || '').slice(0, ARG_MAX),
        success: null,
        resultDigest: null,
      });
      return { decision: null };
    }
    case 'tool_result': {
      if (!run) return { decision: null };
      const digest = run.toolCalls.get(data.toolId || 'anon');
      if (digest) {
        digest.success = data.success !== false;
        digest.resultDigest = data.success === false ? 'FAILED' : String(data.result || '').slice(0, EVIDENCE_SUMMARY_MAX);
      }
      return { decision: null };
    }
    case 'gui_reply': {
      if (!run) return { decision: null };
      if (data.content) run.conclusion = String(data.content).slice(0, CONCLUSION_MAX);
      return { decision: null };
    }
    case 'run:finished': {
      if (!run) return { decision: null };
      // 2026-08-20 终审 C1: 生产顺序 run:finished 先于 gui_reply 广播，而 seal 后
      // 即删除 run——迟到的 gui_reply 永远命中上方守卫，conclusion 恒空。此处从
      // run:finished payload 捕获 content（顺序无关：合成顺序下 gui_reply 已先写入，
      // 同值覆盖不丢结论）。
      if (data.content) run.conclusion = String(data.content).slice(0, CONCLUSION_MAX);
      state.runs.delete(runId);
      return { decision: sealDecision(run, { verdict: 'success' }) };
    }
    case 'run:error': {
      if (!run) return { decision: null };
      state.runs.delete(runId);
      return { decision: sealDecision(run, { verdict: 'failed' }) };
    }
    case 'run:interrupt': {
      if (!run) return { decision: null };
      state.runs.delete(runId);
      return { decision: sealDecision(run, { verdict: 'interrupted' }) };
    }
    default:
      return { decision: null };
  }
}

function sealDecision(run, { verdict }) {
  const digestList = Array.from((run.toolCalls || new Map()).values()).slice(-TOOL_DIGEST_MAX);
  const evidenceRefs = digestList
    .filter((d) => EVIDENCE_TOOLS.includes(d.toolName) && d.success && d.resultDigest && d.resultDigest !== 'FAILED')
    .map((d) => ({ tool: d.toolName, toolId: d.toolId, summary: d.resultDigest }));
  return {
    run_id: run.runId,
    round_id: run.runId,
    user_intent: run.userIntent,
    plan: digestList.length > 0 ? `调用 ${digestList.length} 个工具完成：${digestList.map((d) => d.toolName).join(' → ')}` : '',
    tool_digest: digestList,
    conclusion: run.conclusion,
    verdict,
    evidence_refs: evidenceRefs,
    created_at: run.createdAt,
    recorded_at: Date.now(),
  };
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function computeRecordHash(record) {
  const pick = {
    run_id: record.run_id, round_id: record.round_id, user_intent: record.user_intent,
    plan: record.plan, tool_digest: record.tool_digest, conclusion: record.conclusion,
    verdict: record.verdict, evidence_refs: record.evidence_refs, created_at: record.created_at,
  };
  return crypto.createHash('sha256').update(stableStringify(pick)).digest('hex');
}

function computeChecksum({ sequence_id, previous_checksum, recordHash, recorded_at }) {
  return crypto.createHash('sha256')
    .update(stableStringify({ sequence_id, previous_checksum, recordHash, recorded_at }))
    .digest('hex');
}

module.exports = {
  createFoldState, foldRunEvent, sealDecision,
  computeRecordHash, computeChecksum, stableStringify,
  EVIDENCE_TOOLS, TOOL_DIGEST_MAX, INTENT_MAX, CONCLUSION_MAX, ARG_MAX,
};
