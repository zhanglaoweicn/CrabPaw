/**
 * Stock Watchlist — 股票收藏/自选（2026-08-16 新增）
 *
 * 仿 stock-holdings-tools.js 模式：JSON 文件持久化 + 工具注册。
 * 前端收藏条切换、语音"收藏/取消收藏"、面板自动收藏（分析过的股票）共用此模块。
 * 所有函数接受可选 file 参数（测试注入 tmp 路径，默认 getDataDir()/stock/watchlist.json）。
 */

const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');
const { getDataDir } = require('../core/config');

const WATCHLIST_FILE = path.join(getDataDir(), 'stock', 'watchlist.json');
const WATCHLIST_LIMIT = 30;

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function loadWatchlist(file = WATCHLIST_FILE) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    console.error('[stock-watchlist] 读取收藏失败:', e.message || e);
    return [];
  }
}

function saveWatchlist(list, file) { ensureDir(file); fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8'); }

function listWatchlist(file = WATCHLIST_FILE) { return loadWatchlist(file); }

function addWatchlist({ code, name }, file = WATCHLIST_FILE) {
  if (!code || typeof code !== 'string') return { error: '缺少 code' };
  const list = loadWatchlist(file);
  if (list.length >= WATCHLIST_LIMIT && !list.some(x => x.code === code)) {
    return { error: `收藏已达上限(${WATCHLIST_LIMIT}只)，请先移除再添加` };
  }
  if (list.some(x => x.code === code)) return { success: true, entry: list.find(x => x.code === code) };
  const entry = { code, name: name || code, addedAt: Date.now() };
  list.push(entry);
  saveWatchlist(list, file);
  return { success: true, entry };
}

function removeWatchlist(code, file = WATCHLIST_FILE) {
  const list = loadWatchlist(file);
  const next = list.filter(x => x.code !== code);
  if (next.length === list.length) return false;
  saveWatchlist(next, file);
  return true;
}

registry.register({
  name: 'WatchlistAdd',
  toolset: 'stock',
  category: 'stock',
  description: '收藏一只股票到自选列表（用于"收藏海康威视"）。面板查询过的股票会自动收藏，一般无需手动调用。',
  whenNotToUse: ['查询行情时（用 StockQuery）', '移除收藏时（用 WatchlistRemove）'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '股票代码（如 600519）' },
      name: { type: 'string', description: '股票名称（如 贵州茅台）' },
    },
    required: ['code'],
  },
  handler: async (params) => addWatchlist(params),
  timeout: 10000,
});

registry.register({
  name: 'WatchlistRemove',
  toolset: 'stock',
  category: 'stock',
  description: '取消收藏一只股票（用于"取消收藏海康威视"）。',
  whenNotToUse: ['添加收藏时（用 WatchlistAdd）'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: { code: { type: 'string', description: '股票代码' } },
    required: ['code'],
  },
  handler: async (params) => ({ success: removeWatchlist(params.code) }),
  timeout: 10000,
});

module.exports = {
  addWatchlist, removeWatchlist, listWatchlist,
  loadWatchlist, saveWatchlist, WATCHLIST_FILE, WATCHLIST_LIMIT,
};
