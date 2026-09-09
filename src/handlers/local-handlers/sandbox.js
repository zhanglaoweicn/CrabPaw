// sandbox.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');
const { _getPerceptionLayer } = require('./perception');
const { _readJsonBodyOptional, _safeCallMethod } = require('./_shared');

async function handleSandboxStatus(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const data = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'getStatus') || {};
  return sendJson(res, 200, { success: true, data });
}

async function handleSandboxExperiments(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const experiments = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'getActiveExperiments') || [];
  return sendJson(res, 200, { success: true, experiments });
}

async function handleSandboxCompleted(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10) || 100;
  const experiments = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'getCompletedExperiments', limit) || [];
  return sendJson(res, 200, { success: true, experiments });
}

async function handleSandboxCreate(req, res, _ctx) {
  const perception = _getPerceptionLayer();
  const body = await readJsonBody(req);
  if (!body || !body.name) {
    return sendJson(res, 400, { success: false, error: 'Missing required parameter: name' });
  }
  const experiment = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'createExperiment', body);
  return sendJson(res, 200, { success: true, experiment });
}

function _sandboxIdFromPath(ctx, suffix) {
  const regex = new RegExp(`^\\/api\\/sandbox\\/([^/]+)\\/${suffix}$`);
  const match = ctx.url.pathname.match(regex);
  return match ? match[1] : null;
}

async function handleSandboxStart(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const id = _sandboxIdFromPath(ctx, 'start');
  if (!id) return sendJson(res, 400, { success: false, error: 'Missing experiment id' });
  const result = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'startExperiment', id);
  return sendJson(res, 200, { success: true, id, result });
}

async function handleSandboxRecord(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const id = _sandboxIdFromPath(ctx, 'record');
  if (!id) return sendJson(res, 400, { success: false, error: 'Missing experiment id' });
  const body = await _readJsonBodyOptional(req);
  const result = _safeCallMethod(
    perception && perception.globalEvolutionSandbox,
    'recordMetric',
    id,
    body.group,
    body.metric,
    body.value
  );
  return sendJson(res, 200, { success: true, id, result });
}

async function handleSandboxAnalyze(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const id = _sandboxIdFromPath(ctx, 'analyze');
  if (!id) return sendJson(res, 400, { success: false, error: 'Missing experiment id' });
  const result = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'analyzeExperiment', id);
  return sendJson(res, 200, { success: true, id, result });
}

async function handleSandboxComplete(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const id = _sandboxIdFromPath(ctx, 'complete');
  if (!id) return sendJson(res, 400, { success: false, error: 'Missing experiment id' });
  const result = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'completeExperiment', id);
  return sendJson(res, 200, { success: true, id, result });
}

async function handleSandboxCancel(req, res, ctx) {
  const perception = _getPerceptionLayer();
  const id = _sandboxIdFromPath(ctx, 'cancel');
  if (!id) return sendJson(res, 400, { success: false, error: 'Missing experiment id' });
  const result = _safeCallMethod(perception && perception.globalEvolutionSandbox, 'cancelExperiment', id);
  return sendJson(res, 200, { success: true, id, result });
}

module.exports = {
  handleSandboxStatus,
  handleSandboxExperiments,
  handleSandboxCompleted,
  handleSandboxCreate,
  handleSandboxStart,
  handleSandboxRecord,
  handleSandboxAnalyze,
  handleSandboxComplete,
  handleSandboxCancel,
};
