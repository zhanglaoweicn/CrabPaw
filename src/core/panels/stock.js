/**
 * Stock Panel — 股票行情面板数据模块（2026-08-14 新增）
 *
 * 基于既有股票技能（stock-tools/stock-utils/stock-fundamental）的数据面：
 * 行情走数据源管理器（东方财富主源 + 新浪/腾讯/同花顺备源，3-sigma 异常
 * 检测 + 自动降级）；K线走新浪 quotes.sina.cn。本模块只做「面板数据组装」，
 * 不重复实现取数逻辑。
 *
 * 面板数据模型（surface 'stock-panel' data，前端 StockPanel 契约）：
 * { items: [{ code, name, price, change, changePct }],   // 涨跌色由前端算
 *   kline: { labels: string[], ohlc: [{o,h,l,c}] } | null, // 仅首只股票
 *   index: { name, price, changePct } | null,              // 上证指数
 *   updatedAt, disclaimer, failed: string[] }              // 失败的查询名
 */

// 30s 内存缓存——行情面板反复打开不重复打源（行情本身有源端节流）
let _cache = { at: 0, data: null };
const CACHE_TTL_MS = 30 * 1000;

// 2026-08-16: 深度分析缓存（10min——分析基于日级数据，切换不重复计算）
// key = `${code}|${depth}`；force=true 或 refresh=1 绕过
const ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000;
const _analysisCache = new Map();

// 2026-08-21: 卡片搜索增强 extras 缓存（10min——资讯/事件取数与分析解耦，
// 分析失败时新闻/事件仍可用；key = `${code}|news|events`，force 绕过，失败不写缓存）
const EXTRAS_CACHE_TTL_MS = 10 * 60 * 1000;
const _extrasCache = new Map();

const DISCLAIMER = '数据仅供参考，不构成投资建议。';

/** 查询名 → 6 位代码；知名股票查表，纯数字代码直通，其余走搜索 */
async function resolveCode(name, { POPULAR_STOCKS, searchStockByName }) {
  const q = String(name || '').trim();
  if (!q) return null;
  if (/^\d{5,6}$/.test(q)) return q; // 直接给代码
  if (POPULAR_STOCKS[q]) return POPULAR_STOCKS[q];
  try {
    const hit = await searchStockByName(q);
    if (hit && hit.code) return hit.code;
  } catch (e) {
    console.warn('[stock-panel] 股票搜索失败:', e.message || e);
  }
  return null;
}

/**
 * 获取股票面板数据。全部查询失败时抛可读错误；部分失败时正常返回并附 failed 列表。
 * @param {object} opts { queries?: string|string[], context?: { _fetchImpl },
 *                        force?: boolean,    // force=true 绕过 30s 缓存(手动刷新)
 *                        period?: 'day'|'week' }  // 2026-08-15 P2: K线周期(周线由日线聚合)
 */
async function getStockPanelData(opts = {}) {
  const now = Date.now();
  const period = opts.period === 'week' ? 'week' : 'day';
  const cacheKey = `${Array.isArray(opts.queries) ? opts.queries.join(',') : String(opts.queries || '')}|${period}`;
  if (!opts.force && _cache.data && now - _cache.at < CACHE_TTL_MS && _cache.data.cacheKey === cacheKey) return _cache.data;

  // 函数内懒加载：避免 panels → tools 的模块加载期循环依赖
  const { POPULAR_STOCKS, searchStockByName, fetchKLineData } = require('../../tools/stock/stock-utils');
  const { fetchEastMoneyQuote, fetchMarketIndex, fetchStockNews, fetchStockEvents, buildFundamentalsSummary } = require('../../tools/stock/stock-fundamental');
  const { buildKlineCard } = require('../stock-helper');

  const rawQueries = Array.isArray(opts.queries)
    ? opts.queries.map(String)
    : String(opts.queries || '贵州茅台,上证指数').split(/[,，、\s]+/).filter(Boolean);
  // 2026-08-15: 默认清单=贵州茅台+上证指数——上证指数经搜索可能失败(进 failed
  // 列表), 但茅台成功即面板有数据, 不再整体报"无法获取行情"(用户体验修复)
  const queries = rawQueries.length > 0 ? rawQueries : ['贵州茅台', '上证指数'];

  const items = [];
  const failed = [];
  let kline = null;

  // 逐只解析代码 + 拉行情（串行——数据源管理器内部有并发与限流控制）
  // 2026-09-11 U盘验收: 解析后按代码去重——LLM 常把同一股票以"名称+代码"重复传入
  // queries(实测: 查大华股份 → queries=['大华股份','002236']), 两条同名 items 导致
  // 双名称行 + queries.length!==1 使深度分析永不触发(技术面/估值/资金流/政策全空)。
  const seenCodes = new Set();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const code = await resolveCode(q, { POPULAR_STOCKS, searchStockByName });
    if (!code) {
      failed.push(q);
      console.warn('[stock-panel] 无法解析股票:', q);
      continue;
    }
    if (seenCodes.has(code)) {
      console.log('[stock-panel] 重复代码跳过:', q, '→', code);
      continue;
    }
    seenCodes.add(code);
    try {
      const quote = await fetchEastMoneyQuote(code);
      if (!quote) { failed.push(q); continue; }
      items.push({
        code: quote.code || code,
        name: quote.name || q,
        price: Number(quote.price) || 0,
        change: quote.change != null ? Number(quote.change) : null,
        changePct: quote.changePct != null ? Number(quote.changePct) : null,
      });
      // 仅首只股票附 K线（面板内单图，多只列表不挤）
      if (i === 0) {
        try {
          // 2026-08-15 P2: 周线由日线聚合(诚实标注口径, 新浪源无周线端点)
          const k = period === 'week' ? aggregateWeeklyKline(await fetchKLineData(code, 400)) : await fetchKLineData(code, 60);
          const klineSurface = buildKlineCard({ code, name: quote.name || q, kline: k, limit: 40 });
          if (klineSurface && klineSurface.data) {
            kline = { labels: klineSurface.data.labels, ohlc: klineSurface.data.ohlc, period };
          }
        } catch (e) {
          console.warn('[stock-panel] K线获取失败（不阻塞行情列表）:', e.message || e);
        }
      }
    } catch (e) {
      failed.push(q);
      console.error('[stock-panel] 行情获取失败:', q, e.message || e);
    }
  }

  if (items.length === 0) {
    throw new Error(`无法获取${queries.join('、')}的行情数据（${failed.length ? '失败: ' + failed.join('、') : '请检查名称或代码'}）。`);
  }

  // 2026-08-16: 单股查询附加深度分析（复用 StockQuery 25 维管线，core 深度）
  // 多股查询走轻量路径不加 analysis（避免逐只 25 维拖慢）；失败 → analysis=null
  // 不阻塞行情（前端显示"分析暂不可用"占位，诚实标注）。
  if (opts.analysis !== false && queries.length === 1 && items.length === 1) {
    const depth = opts.depth === 'full' ? 'full' : 'core';
    const aKey = `${items[0].code}|${depth}`;
    const cached = _analysisCache.get(aKey);
    if (cached && now - cached.at < ANALYSIS_CACHE_TTL_MS && !opts.force) {
      items[0].analysis = cached.data;
      items[0].interpret = cached.interpret;  // 2026-08-16: 解读与 analysis 同条目缓存
    } else {
      try {
        const { analyzeStockFull } = require('../../tools/stock-tools');
        const analysis = await analyzeStockFull(items[0].code, { depth });
        _analysisCache.set(aKey, { at: Date.now(), data: analysis });
        items[0].analysis = analysis;
        // 2026-08-16: 自动收藏——分析过的股票进 watchlist（用户需求"所有分析的
        // 股票都收藏起来"）；静默失败不阻塞行情
        try {
          const { addWatchlist } = require('../../tools/stock-watchlist');
          const wr = addWatchlist({ code: items[0].code, name: items[0].name });
          if (wr && wr.error) console.warn('[stock-panel] 自动收藏失败:', wr.error);
        } catch (e) {
          console.warn('[stock-panel] 自动收藏异常(不阻塞):', e.message || e);
        }
        // 2026-08-16: LLM 解读（政策/市场/技术/综合建议）——复用 adapter-registry,
        // 失败由 stock-interpret 内部兜底为规则摘要(source='fallback'), 面板层不抛
        try {
          const { generateStockInterpret } = require('./stock-interpret');
          items[0].interpret = await generateStockInterpret(analysis);
        } catch (e) {
          console.error('[stock-panel] 解读生成异常(走兜底):', e.message || e);
          items[0].interpret = null;
        }
        // 解读与 analysis 同缓存条目——命中时一并取出, 避免重复调 LLM（简报 Step 5 裁定）
        const _entry = _analysisCache.get(aKey);
        if (_entry) _entry.interpret = items[0].interpret;
      } catch (e) {
        console.error('[stock-panel] 深度分析失败(面板降级为纯行情):', e.message || e);
        items[0].analysis = null;
      }
    }
  }

  // 2026-08-21: 卡片搜索增强——单股查询附加资讯/事件/基本面摘要
  // 取数与 analysis 解耦（分析失败时资讯仍可用）；多股查询不取（与 analysis 同条件）
  let news = null;
  let events = null;
  let fundamentalsSummary = null;
  if (queries.length === 1 && items.length === 1) {
    const fCode = items[0].code;
    const newsKey = fCode + '|news';
    const eventsKey = fCode + '|events';
    const fetchExtras = async () => {
      // 与 analysis 块并行语义一致：缓存命中直接取，miss 打源（失败不写缓存）
      const newsCached = _extrasCache.get(newsKey);
      news = newsCached && now - newsCached.at < EXTRAS_CACHE_TTL_MS && !opts.force
        ? newsCached.data : null;
      const eventsCached = _extrasCache.get(eventsKey);
      events = eventsCached && now - eventsCached.at < EXTRAS_CACHE_TTL_MS && !opts.force
        ? eventsCached.data : null;
      const [nRes, eRes] = await Promise.allSettled([
        news !== null ? Promise.resolve(news) : fetchStockNews(fCode),
        events !== null ? Promise.resolve(events) : fetchStockEvents(fCode),
      ]);
      if (nRes.status === 'fulfilled') {
        news = nRes.value;
        if (news !== null && !_extrasCache.has(newsKey)) _extrasCache.set(newsKey, { at: Date.now(), data: news });
      }
      if (eRes.status === 'fulfilled') {
        events = eRes.value;
        if (events !== null && !_extrasCache.has(eventsKey)) _extrasCache.set(eventsKey, { at: Date.now(), data: events });
      }
      fundamentalsSummary = buildFundamentalsSummary(items[0].analysis);
    };
    try {
      await fetchExtras();
    } catch (e) {
      // extras 失败静默：news/events/fundamentalsSummary 保持 null，前端整块隐藏
      console.warn('[stock-panel] 资讯/事件获取失败(不阻塞行情):', e.message || e);
    }
  }

  // 上证指数行情（附在面板底部做大盘参考；失败静默）
  let index = null;
  try {
    const indices = await fetchMarketIndex();
    const sh = indices && indices['000001'];
    if (sh) index = { name: sh.name || '上证指数', price: Number(sh.price) || null, changePct: sh.changePct != null ? Number(sh.changePct) : null };
  } catch (e) {
    console.warn('[stock-panel] 大盘指数获取失败:', e.message || e);
  }

  // 2026-08-15 P2: 持仓联动——合并 holdings.json, 行情条目标注持仓与盈亏
  let holdings = [];
  try {
    const { listHoldings } = require('../../tools/stock-holdings-tools');
    const raw = await listHoldings();
    holdings = Array.isArray(raw) ? raw.map(h => ({
      code: String(h.code || ''),
      name: h.name || '',
      shares: Number(h.shares) || 0,
      cost: Number(h.cost) || 0,
    })) : [];
  } catch (e) {
    console.warn('[stock-panel] 持仓读取失败(不阻塞行情):', e.message || e);
  }
  for (const it of items) {
    const h = holdings.find(x => x.code === it.code);
    if (h) {
      it.holding = { shares: h.shares, cost: h.cost };
      if (Number.isFinite(it.price) && it.price > 0) {
        const pnl = (it.price - h.cost) * h.shares;
        it.holdingPnl = Math.round(pnl);
        it.holdingPnlPct = h.cost > 0 ? +(((it.price - h.cost) / h.cost) * 100).toFixed(1) : null;
      }
    }
  }
  const holdingSummary = holdings.length > 0
    ? {
        count: holdings.length,
        marketValue: holdings.reduce((s, h) => {
          const it = items.find(x => x.code === h.code)
          return s + h.shares * (it && Number.isFinite(it.price) ? it.price : h.cost)
        }, 0),
        costValue: holdings.reduce((s, h) => s + h.shares * h.cost, 0),
      }
    : null;

  const data = {
    items,
    kline,
    index,
    holdings: holdings.length > 0 ? holdings : undefined,
    holdingSummary,
    updatedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
    failed,
    cacheKey,
    // 2026-08-21: 卡片搜索增强——两路径 data 形状一致（缺省 null，前端整块隐藏）
    news,
    events,
    fundamentalsSummary,
  };
  _cache = { at: now, data };
  return data;
}

/** 2026-08-15 P2: 日线 → 周线聚合(open=首开, close=末收, high=max, low=min)。
 *  新浪源无周线端点, 前端标注"周线(日线聚合)"口径, 不伪装原生周线。 */
function aggregateWeeklyKline(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return null;
  const weeks = new Map();
  for (const d of daily) {
    const date = new Date(String(d.date));
    if (Number.isNaN(date.getTime())) continue;
    // 周一为一周起点(UTC 周对齐近似, 误差可忽略——仅分组用)
    const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    const monday = new Date(date.getTime() - (day - 1) * 86400000)
    const key = monday.toISOString().slice(0, 10)
    const bar = weeks.get(key)
    const o = Number(d.open), h = Number(d.high), l = Number(d.low), c = Number(d.close)
    if (![o, h, l, c].every(Number.isFinite)) continue
    if (!bar) {
      weeks.set(key, { date: key, open: o, high: h, low: l, close: c })
    } else {
      bar.high = Math.max(bar.high, h)
      bar.low = Math.min(bar.low, l)
      bar.close = c
    }
  }
  const out = Array.from(weeks.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
  return out.length > 0 ? out : null;
}

/** 终端渲染（ShowStock 工具文本输出） */
function render(d) {
  const lines = d.items.map(it => {
    const sign = it.changePct == null ? '' : it.changePct >= 0 ? '+' : '';
    const pct = it.changePct == null ? '' : `（${sign}${it.changePct.toFixed(2)}%）`;
    return `  ${it.name}（${it.code}）${it.price}${pct}`;
  });
  const head = [`📈 股票行情（${d.items.length} 只${d.failed.length ? `，${d.failed.length} 只失败: ${d.failed.join('、')}` : ''}）`];
  if (d.index) head.push(`  上证指数 ${d.index.price}${d.index.changePct != null ? `（${d.index.changePct >= 0 ? '+' : ''}${d.index.changePct.toFixed(2)}%）` : ''}`);
  return [...head, ...lines, DISCLAIMER].join('\n');
}

class StockPanel {
  getStockPanelData(opts) { return getStockPanelData(opts) }
  render(d) { return render(d) }
}

const globalStockPanel = new StockPanel()

module.exports = { globalStockPanel, getStockPanelData, render }
