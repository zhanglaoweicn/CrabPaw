/**
 * Panel Handler — 信息面板 HTTP API 端点
 *
 * 为 CrabPaw 提供 /panels/* 端点，遵循其他 handler 的 (req, res, pathname) 约定。
 * 返回 true = 请求已被处理，false = 未命中，调用方继续下一个 handler。
 *
 * 端点：
 * GET /panels — 面板列表
 * GET /panels/weather — 天气面板
 * GET /panels/hotspot — 热点面板（单个）
 * GET /panels/hotspot/all — 所有热点
 * GET /panels/status — 系统状态
 * GET /panels/activity — 活动流
 * GET /panels/activity/state — 当前活动状态
 * GET /api/scene — SceneStore 快照（：UI = f(scene)）
 * GET /api/scene/manifest — 紧凑 manifest（注入 Agent 上下文用）
 * POST /api/scene/upsert — upsert surface（id 幂等）
 * POST /api/scene/remove — remove surface by id
 * POST /api/scene/clear — 清空 scene
 * POST /api/scene/intent — UI → Agent intent 队列推送
 */

const panelsIndex = require('../core/panels');
// 2026-09-06: filegen 取消路由复用本文件既有的 readJsonBody（见下方定义）

// 2026-08-16: surface id → panel-state key 映射上收至 panel-state.js（单一事实源），
// 供 /api/scene/upsert（open/closed 双向）、/api/scene/remove（closed）与 SceneSet 关闭链路共用。
const { SURFACE_PANEL_MAP, setPanelState } = require('../core/panel-state');

async function handlePanelApi(req, res, pathname) {
 // 只处理 /panels、/api/filegen、/api/proactive 开头的路径（面板状态/主动提醒确认端点挂在面板 handler 层）
 // 2026-09-07: 补放行 /api/proactive——09-06 加 /api/proactive/ack 时漏改本守卫，
 // ack 分支成死代码，前端"今日不再提醒"回传恒 404（Panel Not Found），告警全天重复播。
 // 2026-08-17: /api/document/convert 与 /api/files/read 的旧放行与分支已删除——
 // 这两条路径在 ROUTE_TABLE 中由 media.js handleDocumentConvert / file-handler.js
 // handleFileRead 实况承接（此前 panel-handler 分支被路由表遮蔽为死代码）。
 if (!pathname.startsWith('/panels')
   && !pathname.startsWith('/api/filegen')
   && !pathname.startsWith('/api/proactive')) return false;

 const url = new URL(req.url, 'http://localhost');
 const params = Object.fromEntries(url.searchParams);

 try {
 // GET /panels — 面板列表
 if ((pathname === '/panels' || pathname === '/panels/') && req.method === 'GET') {
 const list = panelsIndex.getPanels();
 return sendJson(res, 200, { success: true, data: { panels: list } });
 }

 // GET /panels/weather — 天气面板
 if (pathname === '/panels/weather' && req.method === 'GET') {
 const data = await panelsIndex.weather.getWeather(params.city || '北京', {
 forceRefresh: params.refresh === '1',
 });
 if (params.format === 'text') {
 return sendText(res, 200, panelsIndex.weather.render(data));
 }
 return sendJson(res, 200, { success: true, data: { data, compact: panelsIndex.weather.renderCompact(data) } });
   }
  
   // GET /panels/hotspot — 热点面板（单个平台）
   if (pathname === '/panels/hotspot' && req.method === 'GET') {
   const platform = params.platform || 'weibo';
   const data = await panelsIndex.hotspot.getHotspot(platform, params.refresh === '1');
   if (params.format === 'text') {
   return sendText(res, 200, panelsIndex.hotspot.render(data));
   }
   return sendJson(res, 200, { success: true, data: { data, compact: panelsIndex.hotspot.renderCompact(data) } });
   }
  
   // GET /panels/hotspot/all — 所有热点平台
   if (pathname === '/panels/hotspot/all' && req.method === 'GET') {
   const allData = await panelsIndex.hotspot.getAllHotspots(params.refresh === '1');
   return sendJson(res, 200, { success: true, data: allData });
 }

 // GET /panels/status — 系统状态
 if (pathname === '/panels/status' && req.method === 'GET') {
 if (params.format === 'text') {
 const rendered = await panelsIndex.status.render();
 return sendText(res, 200, rendered);
 }
 const status = await panelsIndex.status.getStatus();
   return sendJson(res, 200, { success: true, data: { data: status, compact: await panelsIndex.status.renderCompact() } });
 }

 // GET /panels/memory-graph — 记忆图谱
 if (pathname === '/panels/memory-graph' && req.method === 'GET') {
 const maxNodes = parseInt(params.maxNodes, 10) || 200;
 const maxEdges = parseInt(params.maxEdges, 10) || 500;
 const data = await panelsIndex.memoryGraph.getGraphData({
 forceRefresh: params.refresh === '1',
 maxNodes,
 maxEdges,
 });
 if (params.format === 'compact') {
   return sendJson(res, 200, { success: true, data: { stats: data.stats, compact: await panelsIndex.memoryGraph.renderCompact() } });
   }
   return sendJson(res, 200, { success: true, data });
 }

 // 2026-08-15 交互对齐(参考实现"面板前端直接 GET 数据"模式): 台风/股票面板
 // 自取数据路由——面板打开后可轮询/手动刷新, 后端同步 upsert surface
 // 推送新数据(前端 useSceneClient 自动重渲染), 失败返回 500 错误供前端横幅展示。
 // GET /panels/typhoon — 台风面板数据(?refresh=1 强制绕过 60s 缓存)
 if (pathname === '/panels/typhoon' && req.method === 'GET') {
 try {
 // 2026-08-26: tfid 透传——前端多台风 tab 切换依赖（此前被忽略，切 tab 恒显示同一台风）
 const data = await panelsIndex.typhoon.getTyphoon(null, params.refresh === '1', params.tfid || null);
 try {
 getSceneStore()?.upsertSurface('typhoon-panel', { kind: 'typhoon', data, intent: 'inform' });
 } catch (e) { console.warn('[PanelHandler] 台风 surface 更新失败:', e.message); }
 try { if (SURFACE_PANEL_MAP['typhoon-panel']) setPanelState(SURFACE_PANEL_MAP['typhoon-panel'], 'open'); } catch (e) { console.warn('[PanelHandler] 台风面板状态同步失败:', e && e.message); }
 return sendJson(res, 200, { success: true, data: { updatedAt: data.updatedAt } });
 } catch (e) {
 // 2026-08-15: "暂无活跃台风"不是失败——推空态 surface(与 ShowTyphoon 同口径),
 // 面板以空态打开/刷新, 前端不显示"刷新失败"横幅
 if (/暂无活跃台风|没有活跃台风/i.test(e.message || '')) {
 const emptyData = { empty: true, message: e.message, updatedAt: new Date().toISOString(), disclaimer: '台风信息以官方发布为准。' };
 try {
 getSceneStore()?.upsertSurface('typhoon-panel', { kind: 'typhoon', data: emptyData, intent: 'inform' });
 } catch (e2) { console.warn('[PanelHandler] 台风空态 surface 更新失败:', e2.message); }
 try { if (SURFACE_PANEL_MAP['typhoon-panel']) setPanelState(SURFACE_PANEL_MAP['typhoon-panel'], 'open'); } catch (e) { console.warn('[PanelHandler] 台风面板状态同步失败:', e && e.message); }
 return sendJson(res, 200, { success: true, data: { updatedAt: emptyData.updatedAt } });
 }
 return sendJson(res, 500, { success: false, error: e.message });
 }
 }

 // 2026-08-16 历史台风入口: 列表 + 详情（apizero status=all, 60min 缓存, ?refresh=1 绕过）
 // GET /panels/typhoon/history — 历史台风列表
 if (pathname === '/panels/typhoon/history' && req.method === 'GET') {
 try {
 const data = await panelsIndex.typhoon.getTyphoonHistory(null, params.refresh === '1');
 return sendJson(res, 200, { success: true, data });
 } catch (e) {
 return sendJson(res, 500, { success: false, error: e.message });
 }
 }

 // GET /panels/typhoon/history/detail?id=xxx — 历史台风完整数据（路径点/强度）
 if (pathname === '/panels/typhoon/history/detail' && req.method === 'GET') {
 try {
 const data = await panelsIndex.typhoon.getTyphoonHistoryDetail(null, params.id, params.refresh === '1');
 return sendJson(res, 200, { success: true, data });
 } catch (e) {
 return sendJson(res, 500, { success: false, error: e.message });
 }
 }

 // GET /api/filegen/status — 文件生成面板当前任务快照（面板重开恢复）
 if (pathname === '/api/filegen/status' && req.method === 'GET') {
 const { getFileGenStatus } = require('../core/filegen-events');
 const state = getFileGenStatus();
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: true, data: state }));
 return true;
 }

 // POST /api/filegen/cancel — 取消进行中的文件生成任务（2026-09-06 状态机 v2：
 // 卡片"取消"按钮 + 卡住兜底共用；终态任务返回 ok:false）
 if (pathname === '/api/filegen/cancel' && req.method === 'POST') {
 try {
 const body = await readJsonBody(req).catch(() => ({}));
 const { cancelFileGen } = require('../core/filegen-events');
 const ok = cancelFileGen(body?.taskId);
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: ok, data: { cancelled: ok } }));
 } catch (e) {
 console.error('[PanelHandler] 取消文件生成任务失败:', e.message);
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: false, error: e.message }));
 }
 return true;
 }

 // POST /api/proactive/ack — 主动提醒用户确认（2026-09-06 风险告警轮：
 // 前端通知卡"今日不再提醒"对 risk_alert 回传确认，当日同内容不再重复播报；
 // 数据变化后文本哈希变化自动恢复）
 if (pathname === '/api/proactive/ack' && req.method === 'POST') {
 try {
 const body = await readJsonBody(req).catch(() => ({}));
 const { trigger, text } = body || {};
 if (!trigger || !text) {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: false, error: 'trigger/text required' }));
 return true;
 }
 require('../core/proactive/ack-store').ack(String(trigger), String(text));
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: true }));
 } catch (e) {
 console.error('[PanelHandler] 主动提醒确认失败:', e.message);
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ success: false, error: e.message }));
 }
 return true;
 }

 // GET /panels/stock — 股票行情面板数据(?queries=逗号分隔, ?refresh=1 绕过 30s 缓存)
 if (pathname === '/panels/stock' && req.method === 'GET') {
 const data = await panelsIndex.stock.getStockPanelData({ queries: params.queries, force: params.refresh === '1', period: params.period === 'week' ? 'week' : 'day' });
 try {
 getSceneStore()?.upsertSurface('stock-panel', { kind: 'stock-panel', data, intent: 'inform' });
 } catch (e) { console.warn('[PanelHandler] 股票 surface 更新失败:', e.message); }
 try { if (SURFACE_PANEL_MAP['stock-panel']) setPanelState(SURFACE_PANEL_MAP['stock-panel'], 'open'); } catch (e) { console.warn('[PanelHandler] 股票面板状态同步失败:', e && e.message); }
 return sendJson(res, 200, { success: true, data: { updatedAt: data.updatedAt } });
 }

 // GET /panels/stock/watchlist — 收藏列表（2026-08-16）
 if (pathname === '/panels/stock/watchlist' && req.method === 'GET') {
 try {
 const { listWatchlist } = require('../tools/stock-watchlist');
 const list = listWatchlist();
 return sendJson(res, 200, { success: true, data: { list, total: list.length } });
 } catch (e) {
 console.error('[PanelHandler] 收藏列表失败:', e.message || e);
 return sendJson(res, 500, { success: false, error: e.message });
 }
 }

 // POST /panels/stock/watchlist — 收藏（body {code,name}）
 if (pathname === '/panels/stock/watchlist' && req.method === 'POST') {
 try {
 const { addWatchlist, listWatchlist } = require('../tools/stock-watchlist');
 const body = await readJsonBody(req);
 const r = addWatchlist(body || {});  // body 为字面 null 时走 {} → 缺 code → 400（修复 M-2: null 解构 TypeError → 500）
 if (r && r.error) return sendJson(res, 400, { success: false, error: r.error });
 return sendJson(res, 200, { success: true, data: { entry: r.entry, total: listWatchlist().length } });
 } catch (e) {
 console.error('[PanelHandler] 收藏失败:', e.message || e);
 return sendJson(res, 500, { success: false, error: e.message });
 }
 }

 // DELETE /panels/stock/watchlist?code= — 取消收藏
 if (pathname === '/panels/stock/watchlist' && req.method === 'DELETE') {
 try {
 const { removeWatchlist } = require('../tools/stock-watchlist');
 const ok = removeWatchlist(params.code);
 return sendJson(res, 200, { success: true, data: { ok } });
 } catch (e) {
 console.error('[PanelHandler] 取消收藏失败:', e.message || e);
 return sendJson(res, 500, { success: false, error: e.message });
 }
 }

 // GET /panels/activity — 活动流历史
 if (pathname === '/panels/activity' && req.method === 'GET') {
 const as = getActivityStream();
 if (!as) return sendJson(res, 200, { success: true, data: { activities: [] } });
   const limit = parseInt(params.limit, 10) || 30;
   if (params.stats === '1') {
   return sendJson(res, 200, { success: true, data: { stats: as.getStats() } });
   }
   return sendJson(res, 200, { success: true, data: { activities: as.recent(limit) } });
 }

 // GET /panels/activity/state — 当前活动状态
 if (pathname === '/panels/activity/state' && req.method === 'GET') {
 const as = getActivityState();
 if (!as) return sendJson(res, 200, { success: true, data: { state: 'unknown' } });
   return sendJson(res, 200, { success: true, data: {
   state: as.state,
   meta: as.meta,
   summary: as.summary,
   elapsed: as.elapsed,
   diagnostics: as.getDiagnostics(),
   } });
 }

 // /panels/* 路径已匹配但没有子路径命中 → 404
 return sendJson(res, 404, { success: false, error: `未知面板端点: ${pathname}` });
 } catch (e) {
 return sendJson(res, 500, { success: false, error: e.message });
 }
}

function sendJson(res, statusCode, data) {
 res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
 res.end(JSON.stringify(data));
 return true; // 信号：已处理
}

function sendText(res, statusCode, text) {
 res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
 res.end(text);
 return true;
}

function getActivityStream() {
 try { return require('../core/activity-stream').globalActivityStream; } catch { return null; }
}
function getActivityState() {
 try { return require('../core/activity-state').globalActivityState; } catch { return null; }
}

// ── SceneStore HTTP 接入（、§四） ─────────────────
function getSceneStore() {
 try { return require('../core/scene').getSceneStore(); } catch { return null; }
}

async function readJsonBody(req) {
   return new Promise((resolve, reject) => {
   let data = '';
   req.on('data', chunk => { data += chunk });
   req.on('end', () => {
   try { resolve(data ? JSON.parse(data) : {}); }
   catch (e) { console.warn('[PanelHandler] JSON parse error:', e.message); reject(new Error('Invalid JSON: ' + e.message)); }
   });
   req.on('error', (e) => { console.warn('[PanelHandler] request read error:', e.message); reject(e); });
   });
  }

async function handleSceneApi(req, res, pathname) {
   if (!pathname.startsWith('/api/scene')) return false;
   const store = getSceneStore();
   if (!store) {
   sendJson(res, 503, { success: false, error: 'SceneStore unavailable' });
   return true;
   }

   try {

 // GET /api/scene — 全量快照
 if (pathname === '/api/scene' && req.method === 'GET') {
 sendJson(res, 200, { success: true, data: store.getSnapshot() });
 return true;
 }

 // GET /api/scene/manifest — 紧凑 manifest
 if (pathname === '/api/scene/manifest' && req.method === 'GET') {
 sendJson(res, 200, { success: true, data: store.getManifest() });
 return true;
 }

 // POST /api/scene/upsert { id, data }
 if (pathname === '/api/scene/upsert' && req.method === 'POST') {
 const body = await readJsonBody(req);
 const { id, data } = body;
 if (!id) { sendJson(res, 400, { success: false, error: 'id required' }); return true; }
   const result = data == null
   ? store.removeSurface(id)
   : store.upsertSurface(id, data);
    // 2026-08-15: 已知面板 surface 打开 → 同步 panel-state open（覆盖前端手动打开链路）
    if (data != null && SURFACE_PANEL_MAP[id]) {
      try {
        const { setPanelState } = require('../core/panel-state');
        setPanelState(SURFACE_PANEL_MAP[id], 'open');
      } catch (e) { console.warn('[panel-handler.js] upsert 面板状态同步失败:', e && e.message); }
    }
    // 2026-08-16: data==null 关闭链路同步 panel-state closed（前端手动关闭/删除语义，
    // 此前 surface 消失但 panel-state 残留 open → 下一轮注入幻觉"已打开"）
    if (data == null && SURFACE_PANEL_MAP[id]) {
      try {
        const { setPanelState } = require('../core/panel-state');
        setPanelState(SURFACE_PANEL_MAP[id], 'closed');
      } catch (e) { console.warn('[panel-handler.js] upsert(null) 面板状态同步失败:', e && e.message); }
    }
   sendJson(res, 200, { success: true, data: result });
 return true;
 }

 // POST /api/scene/remove { id }
 if (pathname === '/api/scene/remove' && req.method === 'POST') {
 const body = await readJsonBody(req);
 const { id } = body;
 if (!id) { sendJson(res, 400, { success: false, error: 'id required' }); return true; }
 const result = store.removeSurface(id);
 // 面板 surface 被移除时自动同步 panel-state（SURFACE_PANEL_MAP 单一事实源）
 if (result.found && SURFACE_PANEL_MAP[id]) {
  try {
  const { setPanelState } = require('../core/panel-state');
  setPanelState(SURFACE_PANEL_MAP[id], 'closed');
  } catch (e) {
    /* ignore */
    console.warn('[panel-handler.js] 空 catch 补日志:', e && e.message);
  }
 }
   sendJson(res, 200, { success: true, data: result });
 return true;
 }

 // POST /api/scene/clear
 if (pathname === '/api/scene/clear' && req.method === 'POST') {
 sendJson(res, 200, { success: true, data: store.clear() });
 return true;
 }

 // POST /api/scene/intent { surfaceId, name, data }
 if (pathname === '/api/scene/intent' && req.method === 'POST') {
 const body = await readJsonBody(req);
 const { surfaceId, name, data } = body;
 if (!surfaceId || !name) { sendJson(res, 400, { success: false, error: 'surfaceId and name required' }); return true; }
   store.pushIntent(surfaceId, name, data);
   sendJson(res, 200, { success: true, data: {} });
   return true;
   }

   // POST /api/panel-state { panel, state }
   if (pathname === '/api/scene/panel-state' && req.method === 'POST') {
   const body = await readJsonBody(req);
   const { panel, state } = body;
   if (!panel || !['open', 'closed'].includes(state)) {
    sendJson(res, 400, { success: false, error: 'panel (string) and state (open|closed) required' });
    return true;
   }
   const { setPanelState } = require('../core/panel-state');
   setPanelState(panel, state);
   sendJson(res, 200, { success: true, data: { panel, state } });
   return true;
   }

   } catch (e) {
   sendJson(res, 400, { success: false, error: e.message || 'Bad request' });
   return true;
   }

   return false;
}

module.exports = { handlePanelApi, handleSceneApi };
