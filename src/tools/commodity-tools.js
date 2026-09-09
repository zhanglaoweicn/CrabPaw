/**
 * commodity-tools.js — 商品查询工具（ShowCommodityQuery, 2026-08-25）
 * 引擎 = commodity-service（浏览器导航+多模态截图解析）；体验对齐 ShowStock 面板模式。
 */
const { registry } = require('./registry');
const { commoditySearch } = require('../core/commodity/commodity-service');

async function handleShowCommodityQuery(params) {
  try {
    const action = params.action || 'show';
    const { getSceneStore } = require('../core/scene/scene-store');
    const { setPanelState } = require('../core/panel-state');
    if (action === 'hide') {
      try { getSceneStore().removeSurface('commodity-panel'); } catch (e) { console.warn('[commodity] 移除 surface 失败:', e.message); }
      setPanelState('commodity', 'closed');
      return { success: true, content: '商品查询已关闭。' };
    }
    if (!params.query) return { success: false, error: 'query 必填（要搜索的商品关键词）' };
    const result = await commoditySearch(params.query, { source: params.source });
    getSceneStore().upsertSurface('commodity-panel', {
      kind: 'commodity',
      data: { query: params.query, source: result.source, items: result.items, note: result.note, stage: result.stage, screenshot: result.screenshot },
      intent: 'inform',
    });
    setPanelState('commodity', 'open');
    return {
      success: result.ok,
      content: result.items.length
        ? `商品查询完成：${params.query}（${result.source}），提取 ${result.items.length} 条（价格/销量/店铺已表格化在卡片）。`
        : `商品查询未提取到条目${result.note ? `：${result.note}` : ''}。`,
    };
  } catch (e) {
    console.error('[ShowCommodityQuery] 失败:', e.message || e);
    return { success: false, error: e.message || '商品查询失败' };
  }
}

const CONTRACT = {
  name: 'ShowCommodityQuery',
  toolset: 'panel',
  category: 'information',
  description: '商品查询面板：浏览器导航至电商搜索（京东/淘宝/拼多多等免登录源优先），截图后由多模态视觉模型提取商品列表（名称/价格/销量/店铺）并在卡片表格化展示缩略图与排序。用于"查商品/比价/看看某商品价格"类请求。浏览器不可用时如实告知（引导安装 Chromium）；需要登录的源（1688）提示切换免登录源。',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: '商品关键词（如"华为 Mate60"）' },
      source: { type: 'string', description: '数据源名称（可选：京东商品搜索/淘宝商品搜索/1688 商品搜索…，缺省免登录首选）' },
      action: { type: 'string', enum: ['show', 'hide'], description: 'show=查询(默认)，hide=关闭面板', default: 'show' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  whenNotToUse: ['非商品查询（股票/台风等用各自面板）', '用户仅闲聊时不查询'],
  riskLevel: 'low',
};

registry.register({
  name: CONTRACT.name,
  handler: handleShowCommodityQuery,
  category: CONTRACT.category,
  description: CONTRACT.description,
  schema: CONTRACT.schema,
  toolset: CONTRACT.toolset,
  whenNotToUse: CONTRACT.whenNotToUse,
  riskLevel: CONTRACT.riskLevel,
  isReadOnly: true,
  isDangerous: false,
  source: 'builtin:commodity',
});

module.exports = { handleShowCommodityQuery, CONTRACT };
