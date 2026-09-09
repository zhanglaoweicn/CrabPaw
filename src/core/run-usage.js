/**
 * RunUsageCollector — per-run 用量采集(B5, Runtime差距分析实施)
 *
 * 此前 token/费用只按 天/类型/Provider/模型 聚合(usage-stats/budget-enforcer),
 * 一次 Run 调用了多少模型、烧了多少 Token 无从回答(文章第 19 节成本治理基准)。
 * 这里按 runId(= roundId)累计 LLM 调用次数/Token/费用与工具调用次数,
 * chat-handler 在 run 终态时随 RunStore 记录持久化。
 *
 * 设计约束: 纯内存 + best-effort——采集失败绝不影响主对话流程;
 * runId 缺失(非 GUI 主链路: 工作流/子代理/内部调用)时所有 API 为 no-op。
 */

const _collectors = new Map(); // runId -> accumulator
const MAX_COLLECTORS = 200;

function _acc(runId) {
  if (!runId) return null;
  return _collectors.get(runId) || null;
}

function _ensure(runId) {
  if (!runId) return null;
  let acc = _collectors.get(runId);
  if (!acc) {
    // 防泄漏: 收集器数量超限时丢弃最旧的(正常生命周期下 run 结束即删除)
    if (_collectors.size >= MAX_COLLECTORS) {
      const oldest = _collectors.keys().next().value;
      if (oldest !== undefined) _collectors.delete(oldest);
    }
    acc = {
      startedAt: Date.now(),
      llmCalls: 0,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      ttftMs: null,
      byModel: {},
    };
    _collectors.set(runId, acc);
  }
  return acc;
}

/**
 * 记录首字节时间(TTFT)——P0-4(Runtime优化轮)。流级指标,只记首次(后续覆盖无效)。
 */
function recordTtft(runId, ms) {
  try {
    const acc = _ensure(runId);
    if (!acc || acc.ttftMs != null) return;
    acc.ttftMs = Number(ms) || 0;
  } catch (e) {
    // best-effort
  }
}

/** 记录一次 LLM 调用用量(chatStream recordUsage 后调用) */
function recordLlmUsage(runId, usage = {}) {
  try {
    const acc = _ensure(runId);
    if (!acc) return;
    acc.llmCalls += 1;
    acc.promptTokens += Number(usage.promptTokens) || 0;
    acc.completionTokens += Number(usage.completionTokens) || 0;
    acc.cachedTokens += Number(usage.cachedTokens) || 0;
    acc.totalTokens += Number(usage.totalTokens) || 0;
    // 2026-09-04 SLO 轮: cost 缺失时按费率表自算(数据自愈)——上游 recordUsage 的
    // cost 传递在真实运行中丢失(runrec 22 个 costUsd 全 0 但 token 齐),不再依赖
    // 上游修复; usage-stats 的 MODEL_PRICING 未覆盖的模型回落 default(保守非零)。
    let cost = Number(usage.cost) || 0;
    if (!cost && (usage.promptTokens || usage.completionTokens)) {
      cost = _estimateCost(usage.model, Number(usage.promptTokens) || 0, Number(usage.completionTokens) || 0, Number(usage.cachedTokens) || 0);
      acc.costEstimated = true;
    }
    acc.costUsd += cost;
    if (usage.model) {
      const m = acc.byModel[usage.model] || { llmCalls: 0, totalTokens: 0 };
      m.llmCalls += 1;
      m.totalTokens += Number(usage.totalTokens) || 0;
      acc.byModel[usage.model] = m;
    }
  } catch (e) {
    // best-effort: 采集失败不影响对话
  }
}

/** 按模型费率估算费用(USD)——模型缺省/未收录回落 usage-stats 的 default 费率 */
function _estimateCost(model, promptTokens, completionTokens, cachedTokens = 0) {
  try {
    const { MODEL_PRICING } = require('./usage-stats');
    const pricing = (MODEL_PRICING && (MODEL_PRICING[model] || MODEL_PRICING.default)) || { prompt: 0.0001, completion: 0.0001, cache: 0.000005 };
    const nonCached = Math.max(0, promptTokens - cachedTokens);
    return (nonCached / 1000) * pricing.prompt + (completionTokens / 1000) * pricing.completion + (cachedTokens / 1000) * (pricing.cache || 0);
  } catch (e) {
    return 0;
  }
}

/** 记录一次工具调用(工具执行开始时调用) */
function recordToolCall(runId, _toolName) {
  try {
    const acc = _ensure(runId);
    if (!acc) return;
    acc.toolCalls += 1;
  } catch (e) {
    // best-effort
  }
}

/** 读取当前累计(不删除) */
function snapshotRunUsage(runId) {
  const acc = _acc(runId);
  return acc ? JSON.parse(JSON.stringify(acc)) : null;
}

/** 结束采集并返回累计值(run 终态时调用; 无记录返回 null) */
function endRunUsage(runId) {
  try {
    const acc = _collectors.get(runId);
    if (!acc) return null;
    _collectors.delete(runId);
    acc.finishedAt = Date.now();
    return acc;
  } catch (e) {
    return null;
  }
}

module.exports = { recordLlmUsage, recordToolCall, recordTtft, snapshotRunUsage, endRunUsage };
