/**
 * commodity-service.js — 商品查询服务（2026-08-25, 插件卡「商品」数据引擎）
 *
 * 真查询闭环（多模态核心用武之地）：
 *   BrowserControl 导航（免登录源优先: 京东/淘宝/拼多多/苏宁/什么值得买/当当；1688 登录型可选）
 *   → 视口截图 → **多模态视觉模型解析截图**（prompt 输出结构化 JSON: 名称/价格/销量/店铺）
 *   → 规范化 items → 卡片表格化渲染；截图缩略图随卡展示。
 * 降级: 浏览器不可用→stage=browser_unavailable（UI 引导安装/登录）；vision 解析失败→aria snapshot 文本兜底。
 * 历史: commodity_history 落库（查询历史记录, DataPoint 家族）。
 */
const path = require('path');

const DATA_SOURCES_PATH = path.join(__dirname, '..', '..', '..', 'data', 'data-sources.json');
const HISTORY_TABLE = 'commodity_history';

/** 默认源偏好顺序（内容型/免登录墙最稳优先: 什么值得买/当当/苏宁 > 京东/淘宝/拼多多(未登录易出验证/登录墙) > 1688(登录型)） */
const SOURCE_PREF = ['什么值得买', '当当图书搜索', '苏宁易购商品搜索', '京东商品搜索', '淘宝商品搜索', '拼多多商品搜索', '1688 商品搜索'];

/** 从 data-sources.json 取 ecommerce 源（免登录优先排序） */
function listCommerceSources() {
  try {
    const j = require(DATA_SOURCES_PATH);
    const arr = Array.isArray(j) ? j : (j.sources || Object.values(j));
    return (arr || [])
      .filter((s) => s && s.type === 'ecommerce' && s.searchUrl)
      .sort((a, b) => {
        const ia = SOURCE_PREF.indexOf(a.name);
        const ib = SOURCE_PREF.indexOf(b.name);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map((s) => ({ name: s.name, url: s.searchUrl, loginRequired: !!s.loginRequired }));
  } catch { return []; }
}

/** 视觉解析 prompt：多模态模型从截图提取结构化商品列表 */
function buildVisionPrompt(query) {
  return '你是商品信息提取器。从截图中提取商品搜索列表，输出严格 JSON：' +
    '{"items":[{"name":"商品名","price":数字,"sales":"销量文本","shop":"店铺名"}]}。' +
    '规则：只提取列表中商品卡片；价格只放数字（去除¥/元/逗号）；无销量填""；' +
    '若截图是登录页/验证码/搜索框空态，输出 {"items":[]} 且追加 "note":"需要登录" 或 "note":"无结果"。' +
    '不要输出 JSON 以外的任何文字。查询词：' + JSON.stringify(query);
}

/** 解析/规范化视觉模型返回（纯函数 — 可单测） */
function parseItemsText(text) {
  if (!text) return { items: [], note: null };
  let m = text.match(/\{[\s\S]*\}/);
  if (!m) return { items: [], note: '解析失败' };
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return { items: [], note: '解析失败' }; }
  const raw = Array.isArray(obj) ? obj : obj.items;
  if (!Array.isArray(raw)) return { items: [], note: '结构异常' };
  const items = raw.map((it) => ({
    name: String(it?.name || '').trim(),
    price: Number(String(it?.price || '').replace(/[^\d.]/g, '')) || null,
    sales: String(it?.sales || '').trim(),
    shop: String(it?.shop || '').trim(),
  })).filter((it) => it.name);
  return { items, note: obj.note || null };
}

/** 商品查询历史落库 + 读取（DataPoint 家族 — commodity_history） */
function recordCommodityHistory(entry) {
  try {
    const Database = require('better-sqlite3');
    const { BUSINESS_DIR } = require('../business-data-registry');
    const db = new Database(path.join(BUSINESS_DIR, 'business.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, source TEXT,
      count INTEGER DEFAULT 0, status TEXT, created_at INTEGER NOT NULL)`);
    const info = db.prepare(`INSERT INTO ${HISTORY_TABLE} (query, source, count, status, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.query || '', entry.source || '', entry.count || 0, entry.status || 'ok', Date.now());
    db.close();
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) { return { ok: false, error: e.message }; }
}

function listCommodityHistory(limit = 20) {
  try {
    const Database = require('better-sqlite3');
    const { BUSINESS_DIR } = require('../business-data-registry');
    const db = new Database(path.join(BUSINESS_DIR, 'business.db'));
    try {
      const rows = db.prepare(`SELECT * FROM ${HISTORY_TABLE} ORDER BY created_at DESC LIMIT ?`).all(limit);
      return { ok: true, rows };
    } finally { db.close(); }
  } catch (e) { return { ok: false, error: e.message, rows: [] }; }
}

/** aria snapshot 文本兜底 → 轻量启发式行提取（价格/名称模式） */
function parseAriaText(text, limit = 20) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const l of lines) {
    if (items.length >= limit) break;
    const priceM = l.match(/([¥￥]?\s*\d+(?:\.\d+)?)/);
    const name = l.replace(/[¥￥]\s*\d+(?:\.\d+)?/g, '').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 60);
    if (name.length >= 4 && (priceM || /销量|已售|成交/.test(l))) {
      items.push({ name, price: priceM ? Number(priceM[1].replace(/[^\d.]/g, '')) : null, sales: '', shop: '' });
    }
  }
  return items;
}

/**
 * 商品查询主入口。
 * @returns {Promise<{ok:boolean, stage:string, items:Array, note?:string, source:string|null, query:string, screenshot?:string}>}
 */
async function commoditySearch(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, stage: 'bad_input', items: [], source: null, query: q, note: '查询词不能为空' };

  const { getBrowserControlManager, isAnyBrowserAvailable } = require('../browser-control');
  if (!isAnyBrowserAvailable()) {
    return { ok: false, stage: 'browser_unavailable', items: [], source: null, query: q, note: '浏览器自动化不可用（需安装 Chromium）' };
  }
  const sources = listCommerceSources();
  const sourceName = opts.source && sources.find((s) => s.name === opts.source) ? opts.source : (sources[0] && sources[0].name) || null;
  const ds = sources.find((s) => s.name === sourceName);
  if (!ds) return { ok: false, stage: 'no_source', items: [], source: null, query: q, note: '未配置商品源' };

  const bc = getBrowserControlManager();
  const profile = opts.profile || 'persistent';
  const url = ds.url.replace('{query}', encodeURIComponent(q));

  try {
    await bc.navigate(url, profile);
    // 等渲染（商品列表惰性加载；1.6s 与分页抓取折中）
    await new Promise((r) => setTimeout(r, opts.waitMs || 3200));

    // 多模态主路径: 截图 → 视觉模型提取
    let items = [];
    let note = null;
    let screenshotB64 = null;
    try {
      const vr = await bc.vision(profile, { prompt: buildVisionPrompt(q), fullPage: false });
      const parsed = parseItemsText(vr && vr.analysis);
      console.warn('[commodity] vision 分析原文(前240):', String((vr && vr.analysis) || '(空)').slice(0, 240));
      items = parsed.items;
      note = parsed.note || null;
      if (vr && vr.screenshot && typeof vr.screenshot.base64 === 'string' && vr.screenshot.base64.length < 900000) {
        screenshotB64 = vr.screenshot.base64; // 首屏截图作为卡片缩略图
      }
    } catch (visionErr) {
      console.warn('[commodity] vision 解析失败, aria 兜底:', visionErr.message || visionErr);
    }
    if (items.length === 0) {
      try { items = parseAriaText(await bc.snapshot(profile, { mode: 'aria' })); } catch { /* 兜底失败 */ }
    }
    if (items.length === 0 && note === '需要登录') {
      if (ds.loginRequired) {
        note = '该源需要登录（1688 等）——请切换免登录源（京东/淘宝/拼多多/苏宁）。';
      } else {
        note = '当前源返回空/异常（可能是风控验证或页面未加载完）——建议切换京东重试，或稍后再查。';
      }
    }
    recordCommodityHistory({ query: q, source: sourceName, count: items.length, status: ds.loginRequired ? 'login_needed' : 'ok' });
    return { ok: true, stage: 'ok', items, note, source: sourceName, query: q, screenshot: screenshotB64 || undefined };
  } catch (e) {
    console.error('[commodity] 查询失败:', e.message || e);
    recordCommodityHistory({ query: q, source: sourceName, count: 0, status: 'error' });
    return { ok: false, stage: 'error', items: [], source: sourceName, query: q, note: e.message || '查询失败' };
  }
}


/** 登录引导：打开指定源的登录页（persistent profile——登录态落盘, 后续查询自动复用） */
async function commodityLogin(source) {
  const sources = listCommerceSources();
  const ds = sources.find((s) => s.name === source);
  if (!ds) return { ok: false, error: "未知数据源: " + source };
  const { getBrowserControlManager, isAnyBrowserAvailable } = require('../browser-control');
  if (!isAnyBrowserAvailable()) return { ok: false, error: '浏览器自动化不可用' };
  try {
    const bc = getBrowserControlManager();
    const loginUrl = (ds.name === '1688 商品搜索' ? 'https://login.1688.com' : ds.url.split('?{query}')[0]) || ds.url;
    await bc.navigate(loginUrl, 'persistent');
    return { ok: true, loginUrl };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { commoditySearch, commodityLogin, parseItemsText, parseAriaText, listCommerceSources, recordCommodityHistory, listCommodityHistory };
