/** commodity.js — 商品查询 API（卡片内直接查询；与 ShowCommodityQuery 工具共用引擎） */
const { readJsonBody, sendJson } = require('../http-utils');

async function handleCommoditySearch(req, res) {
  try {
    const body = await readJsonBody(req);
    const { commoditySearch } = require('../../core/commodity/commodity-service');
    const result = await commoditySearch(body.query || '', { source: body.source });
    try {
      const { getSceneStore } = require('../../core/scene/scene-store');
      getSceneStore().upsertSurface('commodity-panel', {
        kind: 'commodity',
        data: { query: body.query, source: result.source, items: result.items, note: result.note, stage: result.stage, screenshot: result.screenshot },
        intent: 'inform',
      });
    } catch (e) { console.warn('[commodity] surface upsert 失败(不阻塞):', e.message); }
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendJson(res, 500, { success: false, error: e.message || '商品查询失败' });
  }
}

async function handleCommodityHistory(req, res) {
  try {
    const { listCommodityHistory } = require('../../core/commodity/commodity-service');
    const r = listCommodityHistory(20);
    sendJson(res, 200, { success: r.ok, rows: r.rows || [] });
  } catch (e) { sendJson(res, 500, { success: false, error: e.message }); }
}

async function handleCommodityLogin(req, res) {
  try {
    const body = await readJsonBody(req);
    const { commodityLogin } = require('../../core/commodity/commodity-service');
    const r = await commodityLogin(body.source);
    sendJson(res, r.ok ? 200 : 400, { success: r.ok, loginUrl: r.loginUrl, error: r.error });
  } catch (e) { sendJson(res, 500, { success: false, error: e.message }); }
}

module.exports = { handleCommoditySearch, handleCommodityHistory, handleCommodityLogin };