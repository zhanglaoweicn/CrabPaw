'use strict';
// 数据出处链端点（2026-09-30，P2「这数从哪来」）。
// 设计：与 briefing-handler 同构——业务库真身走 business-data-registry 单源
// （BUSINESS_DIR），不自己拼路径（此前 briefing-handler 自拼 DATA_DIR/business
// 曾与注册表分裂，导致取数恒空）。
//
// 诚实降级（本端点最重要的契约）：库不可读/视图缺失/视图查询失败一律
// 返回 ok:false + unavailableReason，绝不用 rows:0 冒充——对老板而言
// "没有数据"与"取不到数据"是完全不同的两件事。
const { sendJson } = require('../http-utils');

/** 默认业务库路径（与 business-card-tools / risk-alert-service 同源） */
function defaultBusinessDbPath() {
  try {
    const { BUSINESS_DIR } = require('../../core/business-data-registry');
    return require('path').join(BUSINESS_DIR, 'business.db');
  } catch (e) {
    return null;
  }
}

/** 支持的指标白名单（避免任意串进查询） */
const ALLOWED_METRICS = new Set([
  'revenue', 'receivable', 'contract', 'purchase', 'payable', 'inventory', 'commodity',
]);

async function handleBusinessProvenance(req, res, _ctx) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const metric = String(url.searchParams.get('metric') || 'revenue').toLowerCase();
    if (!ALLOWED_METRICS.has(metric)) {
      return sendJson(res, 400, {
        success: false,
        error: `不支持的指标：${metric}（可用：${[...ALLOWED_METRICS].join(', ')}）`,
      });
    }
    const { buildProvenance } = require('../../core/business/data-provenance');
    const data = buildProvenance({ dbPath: defaultBusinessDbPath(), metric });
    // ok:false 也用 200 返回：这是"业务上取不到数"，不是 HTTP 层错误。
    // 前端据 data.ok 决定显示链路还是显示失败原因（与 briefing 端点同口径）。
    return sendJson(res, 200, { success: true, data });
  } catch (e) {
    console.error('[provenance] 构建出处链失败:', e?.message || e);
    return sendJson(res, 500, { success: false, error: e?.message || '出处链构建失败' });
  }
}

module.exports = { handleBusinessProvenance, ALLOWED_METRICS };
