// tasks.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { DEFAULT_PORT } = require('../../core/config');
const { handleTemplates, handleTaskCancel: _handleTaskCancelEnhanced, handleTaskVersions: _handleTaskVersionsEnhanced } = require('../../tasks/core/task-api-enhanced');

// ── /api/tasks/* 增强端点处理器（接线此前未连接的 task-api-enhanced 死代码）──
// handleTemplates: 读取 query 参数（category/search/tags），无路径参数提取，可安全委派
function handleApiTaskTemplates(req, res, ctx) {
  return handleTemplates(req, res, ctx);
}
// handleTaskCancel: 读取请求体，无路径参数提取，可安全委派
function handleApiTaskCancel(req, res, ctx) {
  return _handleTaskCancelEnhanced(req, res, ctx);
}
// handleTaskVersions: 原实现用 split('/')[3] 提取 taskId，假定路径为 /tasks/versions/:id。
// 现挂载于 /api/tasks/versions/:id（split[3]='versions'），需改写 req.url 后再委派。
async function handleApiTaskVersions(req, res, ctx) {
  try {
    const port = ctx.PORT || process.env.PORT || DEFAULT_PORT;
    const parsed = new URL(req.url, `http://localhost:${port}`);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const versionsIdx = segments.indexOf('versions');
    const taskId = segments[versionsIdx + 1] || '';
    req.url = `/tasks/versions/${taskId}${parsed.search || ''}`;
  } catch (e) {
    console.warn('[api/tasks/versions] url rewrite failed:', e.message);
  }
  return _handleTaskVersionsEnhanced(req, res, ctx);
}
// /api/tasks/workflows: 委派给 workflow-handler 的真实实现（initWorkflowHandler 已在
// server.js 接线初始化；engine 未初始化时 handleWorkflows 内部兜底返回空态）。
function handleApiTaskWorkflows(req, res, ctx) {
  return require('../../handlers/workflow-handler').handleWorkflows(req, res, ctx);
}

module.exports = {
  handleApiTaskTemplates,
  handleApiTaskCancel,
  handleApiTaskVersions,
  handleApiTaskWorkflows,
};
