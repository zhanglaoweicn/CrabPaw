// feedback-loop.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson, sendError } = require('../http-utils');

// ===== 技能反馈闭环 API 处理函数 =====

function _getFeedbackLoop() {
  try {
    const { getFeedbackLoopEngine } = require('../../core/skill/feedback-loop-engine');
    return getFeedbackLoopEngine();
  } catch {
    return null;
  }
}

async function handleFeedbackLoopStatus(req, res, _ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized) {
    return sendJson(res, 200, { success: true, initialized: false, message: '反馈闭环引擎未初始化' });
  }
  sendJson(res, 200, { success: true, ...engine.getStatus() });
}

async function handleFeedbackLoopQuality(req, res, _ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized) {
    return sendJson(res, 200, { success: true, skills: [], degraded: [] });
  }
  sendJson(res, 200, { success: true, ...engine.getQualityDashboard() });
}

async function handleFeedbackLoopEvolutionHistory(req, res, ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized) {
    return sendJson(res, 200, { success: true, history: [] });
  }
  const skillName = ctx.url.searchParams.get('skill');
  const limit = parseInt(ctx.url.searchParams.get('limit') || '20', 10);
  const history = engine._evolver ? engine._evolver.getHistory(skillName, limit) : [];
  sendJson(res, 200, { success: true, history });
}

async function handleFeedbackLoopEvolve(req, res, _ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized) {
    return sendError(res, 400, '反馈闭环引擎未初始化');
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { skillName, type = 'fix', reason = '手动触发' } = data;
      if (!skillName) {
        return sendError(res, 400, '缺少 skillName');
      }
      const record = await engine.manualEvolve(skillName, type, reason);
      sendJson(res, 200, { success: true, record });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleFeedbackLoopRollback(req, res, _ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized) {
    return sendError(res, 400, '反馈闭环引擎未初始化');
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { skillName, targetVersion } = data;
      if (!skillName || !targetVersion) {
        return sendError(res, 400, 'Missing required fields');
      }
      const success = await engine.rollbackSkill(skillName, targetVersion);
      sendJson(res, 200, { success });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleFeedbackLoopVersions(req, res, ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized || !engine._versionStore) {
    return sendJson(res, 200, { success: true, versions: [] });
  }
  const skillName = ctx.url.pathname.split('/').pop();
  const versions = engine._versionStore.getVersionHistory(skillName);
  sendJson(res, 200, { success: true, skillName, versions });
}

async function handleFeedbackLoopLineage(req, res, ctx) {
  const engine = _getFeedbackLoop();
  if (!engine || !engine._initialized || !engine._versionStore) {
    return sendJson(res, 200, { success: true, lineage: [] });
  }
  const skillName = ctx.url.pathname.split('/').pop();
  const lineage = engine._versionStore.getLineage(skillName);
  sendJson(res, 200, { success: true, skillName, lineage });
}

module.exports = {
  handleFeedbackLoopStatus,
  handleFeedbackLoopQuality,
  handleFeedbackLoopEvolutionHistory,
  handleFeedbackLoopEvolve,
  handleFeedbackLoopRollback,
  handleFeedbackLoopVersions,
  handleFeedbackLoopLineage,
};
