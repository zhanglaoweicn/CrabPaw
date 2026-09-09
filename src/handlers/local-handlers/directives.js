// directives.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson, sendError } = require('../http-utils');

// ===== Directive 硬规则 API 处理函数 =====

function _getDirectiveManager() {
  try {
    const { getDirectiveManager } = require('../../core/directive-manager');
    return getDirectiveManager();
  } catch {
    return null;
  }
}

async function handleDirectivesList(req, res, ctx) {
  const dm = _getDirectiveManager();
  if (!dm || !dm._initialized) {
    return sendJson(res, 200, { success: true, directives: [] });
  }
  const category = ctx.url.searchParams.get('category') || null;
  const directives = category ? dm.getActiveDirectives(category) : dm.getAllDirectives();
  sendJson(res, 200, { success: true, directives });
}

async function handleDirectivesAdd(req, res, _ctx) {
  const dm = _getDirectiveManager();
  if (!dm || !dm._initialized) {
    return sendError(res, 400, 'not initialized');
  }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { content, priority, category, tags } = data;
      if (!content) return sendError(res, 400, '缺少 content');
      const result = dm.addDirective(content, { priority, category, tags });
      sendJson(res, 200, { success: true, directive: result });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleDirectivesUpdate(req, res, _ctx) {
  const dm = _getDirectiveManager();
  if (!dm || !dm._initialized) {
    return sendError(res, 400, 'not initialized');
  }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { directiveId, ...updates } = data;
      if (!directiveId) return sendError(res, 400, '缺少 directiveId');
      const result = dm.updateDirective(directiveId, updates);
      sendJson(res, 200, { success: true, directive: result });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleDirectivesRemove(req, res, _ctx) {
  const dm = _getDirectiveManager();
  if (!dm || !dm._initialized) {
    return sendError(res, 400, 'not initialized');
  }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const { directiveId } = data;
      if (!directiveId) return sendError(res, 400, '缺少 directiveId');
      const success = dm.removeDirective(directiveId);
      sendJson(res, 200, { success });
    } catch (e) {
      sendError(res, 400, e.message);
    }
  });
}

async function handleDirectivesStats(req, res, _ctx) {
  const dm = _getDirectiveManager();
  if (!dm || !dm._initialized) {
    return sendJson(res, 200, { success: true, stats: {} });
  }
  sendJson(res, 200, { success: true, stats: dm.getStats() });
}

module.exports = {
  handleDirectivesList,
  handleDirectivesAdd,
  handleDirectivesUpdate,
  handleDirectivesRemove,
  handleDirectivesStats,
};
