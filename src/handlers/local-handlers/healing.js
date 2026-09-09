// healing.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson } = require('../http-utils');

async function handleHealingStatus(req, res, _ctx) {
  try {
    const { globalSelfHealingEngine } = require('../../core/self-healing-engine');
    return sendJson(res, 200, { success: true, data: globalSelfHealingEngine.getStatus() || {} });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { state: 'unavailable' } });
  }
}

async function handleHealingHistory(req, res, ctx) {
  try {
    const { globalSelfHealingEngine } = require('../../core/self-healing-engine');
    const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10) || 100;
    return sendJson(res, 200, { success: true, history: globalSelfHealingEngine.getHistory(limit) || [] });
  } catch (e) {
    return sendJson(res, 200, { success: true, history: [] });
  }
}

async function handleHealingRules(req, res, _ctx) {
  try {
    const { globalSelfHealingEngine } = require('../../core/self-healing-engine');
    return sendJson(res, 200, { success: true, rules: globalSelfHealingEngine.getRules() || [] });
  } catch (e) {
    return sendJson(res, 200, { success: true, rules: [] });
  }
}

module.exports = {
  handleHealingStatus,
  handleHealingHistory,
  handleHealingRules,
};
