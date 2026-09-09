// panel-routes.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { handlePanelApi, handleSceneApi } = require('../../handlers/panel-handler');

// 面板/Scene API 路由（委托给 panel-handler.js）
async function handlePanelRoute(req, res, ctx) {
  const handled = await handlePanelApi(req, res, ctx.url.pathname);
  if (!handled) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Panel Not Found' }));
  }
}
async function handleSceneRoute(req, res, ctx) {
  const handled = await handleSceneApi(req, res, ctx.url.pathname);
  if (!handled) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Scene API Not Found' }));
  }
}

module.exports = {
  handlePanelRoute,
  handleSceneRoute,
};
