// perception.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');
const { _readJsonBodyOptional, _safeCallMethod } = require('./_shared');

// Local fallbacks for routes that were registered without an implementation.
function _getPerceptionLayer() {
  try {
    return require('../../core/perception');
  } catch (e) {
    return null;
  }
}

async function handlePerceptionStatus(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const data = {
    system: _safeCallMethod(perception && perception.globalSystemHealthSensor, 'getStatus'),
    user: _safeCallMethod(perception && perception.globalUserBehaviorSensor, 'getStatus'),
    business: _safeCallMethod(perception && perception.globalBusinessContextSensor, 'getStatus'),
    cost: _safeCallMethod(perception && perception.globalCostSensor, 'getStatus'),
    proactive: _safeCallMethod(perception && perception.globalProactiveEngine, 'getFullStatus'),
    preloader: _safeCallMethod(perception && perception.globalContextPreloader, 'getStatus'),
    strategy: _safeCallMethod(perception && perception.globalStrategyOptimizer, 'getStatus'),
    adaptive: _safeCallMethod(perception && perception.globalAdaptiveTuner, 'getStatus'),
  };
  return sendJson(res, 200, { success: true, data });
}

async function handlePerceptionSignals(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const type = ctx.url.searchParams.get('type') || null;
  const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50;
  const data = {
    signals: _safeCallMethod(perception && perception.globalSignalBus, 'getRecentSignals', type, limit) || [],
    stats: _safeCallMethod(perception && perception.globalSignalBus, 'getSignalStats') || {},
  };
  return sendJson(res, 200, { success: true, data });
}

async function handlePerceptionCost(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const data = _safeCallMethod(perception && perception.globalCostSensor, 'getStatus') || {};
  return sendJson(res, 200, { success: true, data });
}

async function handlePerceptionDomains(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const domains = _safeCallMethod(perception && perception.globalBusinessContextSensor, 'getActiveDomains') || [];
  return sendJson(res, 200, { success: true, domains });
}

async function handlePerceptionUser(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const userId = decodeURIComponent(ctx.url.pathname.replace(/^\/api\/perception\/user\//, '') || '');
  const profile = _safeCallMethod(perception && perception.globalUserBehaviorSensor, 'getUserProfile', userId);
  return sendJson(res, 200, { success: true, userId, profile: profile || null });
}

async function handleProactivePredict(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const userId = ctx.url.searchParams.get('userId');
  const message = ctx.url.searchParams.get('message');
  if (!message) {
    return sendJson(res, 200, { success: true, prediction: null });
  }
  const prediction = _safeCallMethod(perception && perception.globalIntentPredictor, 'predict', userId, message, {});
  return sendJson(res, 200, { success: true, prediction });
}

async function handleProactiveActions(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const userId = ctx.url.searchParams.get('userId');
  const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50;
  const data = {
    actions: _safeCallMethod(perception && perception.globalProactivePlanner, 'getPendingActions', userId) || [],
    history: _safeCallMethod(perception && perception.globalProactivePlanner, 'getActionHistory', limit) || [],
  };
  return sendJson(res, 200, { success: true, data });
}

async function handleProactiveRules(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const rules = _safeCallMethod(perception && perception.globalProactivePlanner, 'getRules') || [];
  return sendJson(res, 200, { success: true, rules });
}

async function handleProactiveActionExecute(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const match = ctx.url.pathname.match(/^\/api\/proactive\/action\/([^/]+)\/execute$/);
  const actionId = match ? match[1] : null;
  if (!actionId) {
    return sendJson(res, 400, { success: false, error: 'Missing action id' });
  }
  const body = await _readJsonBodyOptional(req);
  const result = body.result || body;
  const updated = _safeCallMethod(perception && perception.globalProactivePlanner, 'markActionExecuted', actionId, result);
  return sendJson(res, 200, { success: true, actionId, updated });
}

async function handleProactiveActionDismiss(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const match = ctx.url.pathname.match(/^\/api\/proactive\/action\/([^/]+)\/dismiss$/);
  const actionId = match ? match[1] : null;
  if (!actionId) {
    return sendJson(res, 400, { success: false, error: 'Missing action id' });
  }
  await _readJsonBodyOptional(req);
  const updated = _safeCallMethod(perception && perception.globalProactivePlanner, 'markActionDismissed', actionId);
  return sendJson(res, 200, { success: true, actionId, updated });
}

async function handlePreloaderStatus(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const data = _safeCallMethod(perception && perception.globalContextPreloader, 'getStatus') || {};
  return sendJson(res, 200, { success: true, data });
}

async function handlePreloaderRegistry(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const registry = _safeCallMethod(perception && perception.globalContextPreloader, 'getRegistry') || [];
  return sendJson(res, 200, { success: true, registry });
}

async function handleMetaStrategies(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const strategies = _safeCallMethod(perception && perception.globalStrategyOptimizer, 'getAllStrategies') || {};
  return sendJson(res, 200, { success: true, strategies });
}

async function handleMetaOptimizations(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10) || 50;
  const optimizations = _safeCallMethod(perception && perception.globalStrategyOptimizer, 'getOptimizationHistory', limit) || [];
  return sendJson(res, 200, { success: true, optimizations });
}

async function handleMetaReplay(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const body = await _readJsonBodyOptional(req);
  const replay = perception && perception.getGlobalExperienceReplay ? perception.getGlobalExperienceReplay() : null;
  if (!replay || typeof replay.replay !== 'function') {
    return sendJson(res, 200, { success: true, replayed: false, reason: 'replay_engine_unavailable' });
  }
  const result = await replay.replay(body.trigger || undefined, body.options || {});
  return sendJson(res, 200, { success: true, replayed: true, result });
}

async function handleMetaPatterns(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const replay = perception && perception.getGlobalExperienceReplay ? perception.getGlobalExperienceReplay() : null;
  const patterns = _safeCallMethod(replay, 'getLearnedPatterns') || [];
  return sendJson(res, 200, { success: true, patterns });
}

async function handleMetaParams(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const params = _safeCallMethod(perception && perception.globalAdaptiveTuner, 'getAllParams') || {};
  return sendJson(res, 200, { success: true, params });
}

async function handleMetaParamUpdate(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const match = ctx.url.pathname.match(/^\/api\/meta\/params\/([^/]+)$/);
  const key = match ? decodeURIComponent(match[1]) : null;
  if (!key) {
    return sendJson(res, 400, { success: false, error: 'Missing param key' });
  }
  const body = await readJsonBody(req);
  const updated = _safeCallMethod(perception && perception.globalAdaptiveTuner, 'setParam', key, body && body.value);
  return sendJson(res, 200, { success: true, key, value: body && body.value, updated });
}

async function handleMetaParamsReset(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const body = await _readJsonBodyOptional(req);
  let updated = null;
  if (body.all) {
    updated = _safeCallMethod(perception && perception.globalAdaptiveTuner, 'resetAll');
  } else if (body.key) {
    updated = _safeCallMethod(perception && perception.globalAdaptiveTuner, 'resetParam', body.key);
  } else {
    return sendJson(res, 400, { success: false, error: 'Missing key or all flag' });
  }
  return sendJson(res, 200, { success: true, key: body.key || null, all: !!body.all, updated });
}

async function handleKGStatus(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const kg = perception && perception.getGlobalKnowledgeGraphEvolver ? perception.getGlobalKnowledgeGraphEvolver() : null;
  const data = _safeCallMethod(kg, 'getStatus') || { available: false };
  const stats = _safeCallMethod(kg, 'getStats') || {};
  return sendJson(res, 200, { success: true, data, stats });
}

async function handleKGEvolutions(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const kg = perception && perception.getGlobalKnowledgeGraphEvolver ? perception.getGlobalKnowledgeGraphEvolver() : null;
  const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10) || 100;
  const evolutions = _safeCallMethod(kg, 'getEvolutionLog', limit) || [];
  return sendJson(res, 200, { success: true, evolutions });
}

async function handleKGDiscoveries(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const kg = perception && perception.getGlobalKnowledgeGraphEvolver ? perception.getGlobalKnowledgeGraphEvolver() : null;
  const discoveries = _safeCallMethod(kg, 'getDiscoveredRelations') || [];
  return sendJson(res, 200, { success: true, discoveries });
}

async function handleKGMerges(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const kg = perception && perception.getGlobalKnowledgeGraphEvolver ? perception.getGlobalKnowledgeGraphEvolver() : null;
  const merges = _safeCallMethod(kg, 'getMergedEntities') || [];
  return sendJson(res, 200, { success: true, merges });
}

async function handleKGEvolve(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const kg = perception && perception.getGlobalKnowledgeGraphEvolver ? perception.getGlobalKnowledgeGraphEvolver() : null;
  if (!kg || typeof kg._evolutionCycle !== 'function') {
    return sendJson(res, 200, { success: true, evolved: false, reason: 'kg_evolver_unavailable' });
  }
  await kg._evolutionCycle();
  return sendJson(res, 200, { success: true, evolved: true });
}

module.exports = {
  _getPerceptionLayer,
  handlePerceptionStatus,
  handlePerceptionSignals,
  handlePerceptionCost,
  handlePerceptionDomains,
  handlePerceptionUser,
  handleProactivePredict,
  handleProactiveActions,
  handleProactiveRules,
  handleProactiveActionExecute,
  handleProactiveActionDismiss,
  handlePreloaderStatus,
  handlePreloaderRegistry,
  handleMetaStrategies,
  handleMetaOptimizations,
  handleMetaReplay,
  handleMetaPatterns,
  handleMetaParams,
  handleMetaParamUpdate,
  handleMetaParamsReset,
  handleKGStatus,
  handleKGEvolutions,
  handleKGDiscoveries,
  handleKGMerges,
  handleKGEvolve,
};
