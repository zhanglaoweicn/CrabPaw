// dashboard.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

async function handleDashboardSnapshot(req, res, _ctx) {
  const { sendJson } = require('../http-utils') // 2026-08-15 T7(累积A): 修正坏路径(../../cli/http-utils 不存在 → MODULE_NOT_FOUND);
  try {
    const { globalDashboard } = require('../../core/dashboard');
    const result = globalDashboard.takeSnapshot();
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function handleDashboardDiff(req, res, _ctx) {
  const { sendJson } = require('../http-utils') // 2026-08-15 T7(累积A): 修正坏路径(../../cli/http-utils 不存在 → MODULE_NOT_FOUND);
  try {
    const { globalDashboard } = require('../../core/dashboard');
    // Take a snapshot first to diff against last
    const snapshot = globalDashboard.takeSnapshot();
    const diff = globalDashboard.getDiffFromLast();
    sendJson(res, 200, { snapshot, diff });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

async function handleDashboardMetrics(req, res, _ctx) {
  const { sendJson } = require('../http-utils') // 2026-08-15 T7(累积A): 修正坏路径(../../cli/http-utils 不存在 → MODULE_NOT_FOUND);
  try {
    const { globalDashboard } = require('../../core/dashboard');
    const snapshot = globalDashboard.getSnapshot();
    if (req.url && req.url.includes('?html')) {
      const { globalDashboard: dash } = require('../../core/dashboard');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dash.renderHTML());
      return;
    }
    sendJson(res, 200, snapshot);
  } catch (e) {
    sendJson(res, 500, { error: e.message, message: 'Dashboard metrics unavailable' });
  }
}

module.exports = {
  handleDashboardSnapshot,
  handleDashboardDiff,
  handleDashboardMetrics,
};
