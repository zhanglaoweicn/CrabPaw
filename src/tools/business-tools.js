/**
 * business-tools.js — 经营日报工具（ShowBusinessReport, 2026-08-25）
 * 模式对齐 ShowTyphoon（show/hide + surface + panel-state 三件套）。
 * 数据引擎 = business 数据源/导入表（data-import-tools + business-data-registry）。
 */
const { registry } = require('./registry');

async function handleShowBusinessReport(params) {
  try {
    const action = params.action || 'show';
    const { getSceneStore } = require('../core/scene/scene-store');
    const { setPanelState, SURFACE_PANEL_MAP } = require('../core/panel-state');
    if (action === 'hide') {
      try { getSceneStore().removeSurface('business-panel'); } catch (e) { console.warn('[ShowBusinessReport] 移除 surface 失败:', e.message); }
      setPanelState('businessReport', 'closed');
      return { success: true, content: '经营日报已关闭。' };
    }
    const { listTables } = require('../core/business-data-registry');
    const tables = listTables();
    getSceneStore().upsertSurface('business-panel', {
      kind: 'business',
      data: { tableCount: tables.length, tables: tables.map((t) => ({ name: t.name, role: t.role, rowCount: t.rowCount })) },
      intent: 'inform',
    });
    setPanelState('businessReport', 'open');
    return {
      success: true,
      content: tables.length
        ? `经营日报已打开（当前 ${tables.length} 张数据表：${tables.map((t) => t.name).join('、')}）。`
        : '经营日报已打开（尚无数据：请先发送 CSV/Excel 报表文件导入，或说"导入报表"）。',
    };
  } catch (e) {
    console.error('[ShowBusinessReport] 失败:', e.message || e);
    return { success: false, error: e.message || '经营日报打开失败' };
  }
}

// ── 契约（PascalCase, 双端对齐 tool-contract.js）──
const CONTRACT = {
  name: 'ShowBusinessReport',
  toolset: 'panel',
  category: 'information',
  description: '展示经营日报面板：导入的经营数据表清单/行数/角色（营收/库存/应收），用于"经营日报/经营情况/上个月经营"类请求。数据来自已导入的 CSV/Excel 报表（自动建表+NL2SQL 查询）。无数据时如实提示请先导入。会以可视面板形式展示。',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['show', 'hide'],
        description: 'show=展示经营日报(默认)，hide=关闭面板',
        default: 'show',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  whenNotToUse: ['非经营数据场景（股票/台风等用各自面板）'],
  riskLevel: 'low',
};

registry.register({
  name: CONTRACT.name,
  handler: handleShowBusinessReport,
  category: CONTRACT.category,
  description: CONTRACT.description,
  schema: CONTRACT.schema,
  toolset: CONTRACT.toolset,
  whenNotToUse: CONTRACT.whenNotToUse,
  riskLevel: CONTRACT.riskLevel,
  isReadOnly: true,
  isDangerous: false,
  source: 'builtin:business',
});

module.exports = { handleShowBusinessReport, CONTRACT };
