/**
 * poster.js — 海报/品牌包 HTTP 端点（P1：设置页品牌包 UI 的数据通道）
 *
 * GET  /api/poster/brand-kit            → 当前品牌包
 * POST /api/poster/brand-kit            → 更新品牌包（只传需要改的字段）
 * GET  /api/poster/templates            → 可用模板清单
 */
const poster = require('../../core/poster');

async function handlePosterBrandKitApi(req, res, ctx) {
  const sendJson = ctx?.sendJson || ((r, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { success: true, data: poster.loadBrandKit() });
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { success: false, error: 'JSON 解析失败' }); }
      const saved = poster.saveBrandKit(data);
      return sendJson(res, 200, { success: true, data: saved });
    }
    res.writeHead(405); res.end('Method Not Allowed');
  } catch (err) {
    return sendJson(res, 500, { success: false, error: err.message });
  }
}

async function handlePosterTemplatesApi(req, res, ctx) {
  const sendJson = ctx?.sendJson || ((r, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); });
  return sendJson(res, 200, { success: true, data: poster.listTemplates() });
}

module.exports = { handlePosterBrandKitApi, handlePosterTemplatesApi };
