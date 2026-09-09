/**
 * Stock Holdings Tools — 老板持仓管理（语音增删查）
 */

const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');
const { getDataDir } = require('../core/config');

const HOLDINGS_FILE = path.join(getDataDir(), 'stock', 'holdings.json');

function ensureDir() { fs.mkdirSync(path.dirname(HOLDINGS_FILE), { recursive: true }); }

function loadHoldings() {
  try {
    if (!fs.existsSync(HOLDINGS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(HOLDINGS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[stock-holdings] 读取持仓失败:', e.message || e);
    return [];
  }
}

function saveHoldings(list) { ensureDir(); fs.writeFileSync(HOLDINGS_FILE, JSON.stringify(list, null, 2), 'utf8'); }

function addHolding({ code, name, shares, cost }) {
  if (!code || typeof code !== 'string') return { error: '缺少 code' };
  const n = Number(shares);
  const c = Number(cost);
  if (!Number.isFinite(n) || n <= 0) return { error: 'shares 必须为正数' };
  if (!Number.isFinite(c) || c <= 0) return { error: 'cost 必须为正数' };
  const list = loadHoldings();
  const idx = list.findIndex((h) => h.code === code);
  const entry = { code, name: name || code, shares: n, cost: c, addedAt: Date.now() };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  saveHoldings(list);
  return { success: true, holding: entry };
}

function listHoldings() { return loadHoldings(); }

function removeHolding(code) {
  const list = loadHoldings();
  const next = list.filter((h) => h.code !== code);
  if (next.length === list.length) return false;
  saveHoldings(next);
  return true;
}

/**
 * 2026-08-12 接线：把持仓摘要卡片发射到 SceneStore（此前 stock-helper.buildHoldingsSummary
 * 的 card 从未被任何调用方消费，审计 P1-4）。懒加载避免循环依赖，失败不阻塞主流程。
 */
function publishHoldingsCard() {
  try {
    const { buildHoldingsSummary } = require('../core/stock-helper');
    const { getSceneStore } = require('../core/scene/scene-store');
    const store = getSceneStore();
    if (!store) return;
    const summary = buildHoldingsSummary(listHoldings());
    store.upsertSurface('stocks-card', {
      kind: 'stocks',
      data: { items: summary.card.items },
      intent: 'inform',
    });
  } catch (e) {
    console.error('[stock-holdings] 持仓卡片发射失败:', e.message || e);
  }
}

registry.register({
  name: 'HoldingAdd',
  toolset: 'stock',
  category: 'stock',
  description: '添加/更新老板股票持仓（代码/名称/股数/成本价），用于"今天持仓怎么样"批量播报与开盘早报。',
  whenNotToUse: ['查询行情时（用 StockQuery）', '删除持仓时（用 HoldingRemove）'],
  riskLevel: 'medium',
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '股票代码（如 600519）' },
      name: { type: 'string', description: '股票名称（如 贵州茅台）' },
      shares: { type: 'number', description: '持股数量（正数）' },
      cost: { type: 'number', description: '成本价（正数）' },
    },
    required: ['code', 'shares', 'cost'],
  },
  handler: async (params) => {
    const result = addHolding(params);
    if (result.success) publishHoldingsCard();
    return result;
  },
  timeout: 10000,
});

registry.register({
  name: 'HoldingList',
  toolset: 'stock',
  category: 'stock',
  description: '列出老板全部持仓。',
  whenNotToUse: ['添加持仓时（用 HoldingAdd）'],
  riskLevel: 'low',
  schema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const holdings = listHoldings();
    publishHoldingsCard();
    // P6(GUI 全量修复 P1): 补实时行情字段(price/changePct)——StockPanel 渲染
    // 红绿涨跌/盈亏但旧实现后端永不给 → 恒空白半成品卡。行情源复用东方财富
    // 免费源(stock-data-source-manager, 与 stock-tools 同源); 单支失败/全部
    // 失败均降级保留基础持仓(不阻塞列表)。
    try {
      const { getStockDataSourceManager } = require('../core/stock-data-source-manager');
      const mgr = getStockDataSourceManager();
      const withQuote = await Promise.all(holdings.map(async (h) => {
        try {
          const q = await mgr.fetchWithRedundancy(h.code, ['quote']);
          const d = q?.data || null;
          return {
            ...h,
            price: d?.price ?? null,
            changePct: d?.changePct ?? null,
            signal: null,
          };
        } catch (e) {
          console.warn(`[stock-holdings] ${h.code} 行情获取失败(降级无行情):`, e?.message || e);
          return { ...h, price: null, changePct: null, signal: null };
        }
      }));
      return { success: true, holdings: withQuote };
    } catch (e) {
      console.warn('[stock-holdings] 行情批量获取失败(降级无行情):', e?.message || e);
      return { success: true, holdings };
    }
  },
  timeout: 20000,
});

registry.register({
  name: 'HoldingRemove',
  toolset: 'stock',
  category: 'stock',
  description: '删除一笔持仓。',
  whenNotToUse: ['添加持仓时（用 HoldingAdd）'],
  riskLevel: 'medium',
  schema: { type: 'object', properties: { code: { type: 'string', description: '股票代码' } }, required: ['code'] },
  handler: async (params) => {
    const ok = removeHolding(params.code);
    if (ok) publishHoldingsCard();
    return { success: ok };
  },
  timeout: 10000,
});

module.exports = { addHolding, listHoldings, removeHolding, publishHoldingsCard, HOLDINGS_FILE };
