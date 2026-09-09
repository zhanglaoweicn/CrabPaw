// evolution.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');

async function handleEvolutionStatus(req, res, _ctx) {
  try {
    const { getEvolutionSystemStatus } = require('../../core/evolution-system');
    const status = await getEvolutionSystemStatus();
    return sendJson(res, 200, { success: true, data: status || {} });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { initialized: false, status: 'unavailable' } });
  }
}

async function handleEvolutionRecord(req, res, _ctx) {
  try {
    const { collectFeedback } = require('../../core/evolution-system');
    const body = await readJsonBody(req);
    const result = await collectFeedback(body || {});
    return sendJson(res, 200, { success: true, result });
  } catch (e) {
    return sendJson(res, 200, { success: true, result: { feedbackId: null } });
  }
}

async function handleEvolutionHistory(req, res, ctx) {
  try {
    const { getEvolutionLog } = require('../../core/evolution-system');
    const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10) || 100;
    const history = await getEvolutionLog({ limit });
    return sendJson(res, 200, { success: true, history: history || [] });
  } catch (e) {
    return sendJson(res, 200, { success: true, history: [] });
  }
}

async function handleEvolutionLog(req, res, ctx) {
  try {
    const { getEvolutionLog } = require('../../core/evolution-system');
    const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10) || 100;
    const log = await getEvolutionLog({ limit });
    return sendJson(res, 200, { success: true, log: log || [] });
  } catch (e) {
    return sendJson(res, 200, { success: true, log: [] });
  }
}

async function handleTaskEvolutionStatus(req, res, _ctx) {
  try {
    const { getEvolutionSystemStatus } = require('../../core/evolution-system');
    const evolution = await getEvolutionSystemStatus();
    return sendJson(res, 200, { success: true, data: { evolution: evolution || {} } });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { evolution: { initialized: false } } });
  }
}

async function handleTaskEvolutionTrigger(req, res, _ctx) {
  try {
    const { triggerEvolution } = require('../../core/evolution-system');
    const result = await triggerEvolution();
    return sendJson(res, 200, { success: true, result });
  } catch (e) {
    return sendJson(res, 200, { success: true, result: { triggered: false, reason: e.message } });
  }
}

async function handleTaskEvolutionMetrics(req, res, _ctx) {
  try {
    const { getEvolutionLog } = require('../../core/evolution-system');
    const log = await getEvolutionLog({ limit: 100 });
    const total = (log || []).length;
    return sendJson(res, 200, { success: true, metrics: { total, recent: log || [] } });
  } catch (e) {
    return sendJson(res, 200, { success: true, metrics: { total: 0, recent: [] } });
  }
}

async function handleTaskEvolutionRecommendations(req, res, _ctx) {
  try {
    const { getEvolutionRecommendations } = require('../../core/skill/skill-evolution-graph');
    const recommendations = getEvolutionRecommendations() || [];
    return sendJson(res, 200, { success: true, recommendations });
  } catch (e) {
    return sendJson(res, 200, { success: true, recommendations: [] });
  }
}

module.exports = {
  handleEvolutionStatus,
  handleEvolutionRecord,
  handleEvolutionHistory,
  handleEvolutionLog,
  handleTaskEvolutionStatus,
  handleTaskEvolutionTrigger,
  handleTaskEvolutionMetrics,
  handleTaskEvolutionRecommendations,
};
