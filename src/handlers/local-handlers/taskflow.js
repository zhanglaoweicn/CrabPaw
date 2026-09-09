// taskflow.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { handleTaskFlowRequest } = require('../../handlers/taskflow-handler');

async function handleTaskFlows(req, res, ctx) {
  const pathname = ctx.url.pathname;
  await handleTaskFlowRequest(req, res, pathname);
}

async function handleTaskFlowStats(req, res, _ctx) {
  await handleTaskFlowRequest(req, res, '/api/taskflows/stats');
}

module.exports = {
  handleTaskFlows,
  handleTaskFlowStats,
};
