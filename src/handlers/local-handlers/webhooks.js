// webhooks.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson, sendError } = require('../http-utils');

// ===== Webhook 管理 API 处理函数 =====

function _getWebhookManager() {
  try {
    const { getWebhookManager } = require('../../core/webhook-manager');
    return getWebhookManager();
  } catch {
    return null;
  }
}

async function handleWebhooksList(req, res, _ctx) {
  const wh = _getWebhookManager();
  if (!wh || !wh._initialized) {
    return sendJson(res, 200, { success: true, webhooks: [] });
  }
  sendJson(res, 200, { success: true, webhooks: wh.listWebhooks() });
}

async function handleWebhooksRegister(req, res, _ctx) {
  const wh = _getWebhookManager();
  if (!wh || !wh._initialized) {
    return sendError(res, 400, 'Webhook manager not initialized');
  }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { url, events, secret } = data;
      if (!url) return sendError(res, 400, '缺少 url');
      const result = wh.register(url, { events, secret });
      sendJson(res, 200, { success: true, webhook: result });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleWebhooksUnregister(req, res, _ctx) {
  const wh = _getWebhookManager();
  if (!wh || !wh._initialized) {
    return sendError(res, 400, 'Webhook manager not initialized');
  }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { webhookId } = data;
      if (!webhookId) return sendError(res, 400, '缺少 webhookId');
      const success = wh.unregister(webhookId);
      sendJson(res, 200, { success });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleWebhooksDeliveryLog(req, res, ctx) {
  const wh = _getWebhookManager();
  if (!wh || !wh._initialized) {
    return sendJson(res, 200, { success: true, logs: [] });
  }
  const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10);
  const logs = wh.getDeliveryLog({ limit });
  sendJson(res, 200, { success: true, logs });
}

async function handleWebhooksStats(req, res, _ctx) {
  const wh = _getWebhookManager();
  if (!wh || !wh._initialized) {
    return sendJson(res, 200, { success: true, stats: {} });
  }
  sendJson(res, 200, { success: true, stats: wh.getStats() });
}

module.exports = {
  handleWebhooksList,
  handleWebhooksRegister,
  handleWebhooksUnregister,
  handleWebhooksDeliveryLog,
  handleWebhooksStats,
};
