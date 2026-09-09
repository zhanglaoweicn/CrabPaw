'use strict';
// doc-artifacts.js — 文档产物注册表查询 API（SP-4/SA-1, 2026-08-28）
// GET /api/doc-artifacts?limit=20 → 历史产物列表（SA-2 FileGenPanel 历史产物区消费）。
// 只读查询——数据源 doc-artifacts/registry（filegen:done 统一注册）。
const { sendJson } = require('../http-utils');

async function handleDocArtifactsList(req, res, _ctx) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 200);
    const { listArtifacts } = require('../../core/doc-artifacts/registry');
    sendJson(res, 200, { success: true, data: { artifacts: listArtifacts(limit) } });
  } catch (e) {
    console.error('[doc-artifacts] 列表失败:', e.message);
    sendJson(res, 500, { success: false, error: e.message });
  }
}

module.exports = { handleDocArtifactsList };
