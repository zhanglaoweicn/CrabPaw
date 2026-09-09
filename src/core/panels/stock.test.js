/**
 * stock.test.js — 面板分析接线与缓存分层（2026-08-16）
 * mock 数据源 fetch 与 analyzeStockFull；验证单股附加/多股不附/缓存/失败语义。
 * 注：getStockPanelData 模块级持有 30s 行情缓存 _cache 与 10min 分析缓存
 * _analysisCache，故 beforeEach 用 jest.resetModules() 重载模块，避免测试间
 * 同查询串互相命中缓存导致顺序依赖（断言与简报一致）。
 */
jest.mock('../../tools/stock/stock-fundamental', () => {
  const actual = jest.requireActual('../../tools/stock/stock-fundamental');
  return {
    ...actual,
    fetchEastMoneyQuote: jest.fn(),
    fetchMarketIndex: jest.fn(),
    // 2026-08-21 P2: 卡片搜索增强取数层——不 mock 会真打网（每测试 2-3 次网络请求）
    fetchStockNews: jest.fn(),
    fetchStockEvents: jest.fn(),
  };
});
jest.mock('../../tools/stock/stock-utils', () => {
  const actual = jest.requireActual('../../tools/stock/stock-utils');
  return {
    ...actual,
    searchStockByName: jest.fn(),
    fetchKLineData: jest.fn(),
  };
});
jest.mock('../../tools/stock-tools', () => ({
  ...jest.requireActual('../../tools/stock-tools'),
  analyzeStockFull: jest.fn(),
}));
// 2026-08-16 修复: 自动收藏钩子 mock——stock.js 分析块惰性 require 本模块并以默认
// 路径写真实 data/.crabpaw/stock/watchlist.json, 不 mock 会每次跑测试污染真实收藏
// 数据（审查 I-1）。mock 返回 success 保证钩子调用路径仍被覆盖, 不落盘。
jest.mock('../../tools/stock-watchlist', () => {
  const actual = jest.requireActual('../../tools/stock-watchlist');
  return {
    ...actual,
    addWatchlist: jest.fn(({ code, name }) => ({ success: true, entry: { code, name, addedAt: Date.now() } })),
  };
});

const FAKE_QUOTE = { code: '600519', name: '贵州茅台', price: 1500, change: 10, changePct: 0.67 };
// 2026-08-21 P2: FAKE_ANALYSIS 补基本面三源字段——buildFundamentalsSummary 投影依赖
const FAKE_ANALYSIS = {
  code: '600519', name: '贵州茅台', dataSource: 'eastmoney_quote', momentum: { trendStatus: '多头排列' },
  companyQualitative: {
    businessModel: { type: '高附加值型', pricing: '强定价权', score: 0.4, details: [] },
    moat: { type: '品牌护城河', strength: '强', score: 0.4, details: [] },
    management: { quality: '优秀', score: 0.3, details: [] },
    overallScore: 0.8, summary: '品牌壁垒深厚，定价权强',
  },
  industryProspects: {
    industry: '白酒', prosperity: { level: '景气', score: 0.2, details: [] },
    supplyDemand: { signal: '供不应求', details: [] }, lifecycle: '成熟期',
    summary: '白酒行业景气度景气，供需供不应求，生命周期成熟期',
  },
  fundamentals: { score: 0.6, metrics: [{ name: 'PE估值', value: '28.50', status: '合理', score: 0.1 }] },
  overallScore: { finalScore: '0.72', recommendation: 'BUY', confidence: '0.72' },
};
const FAKE_NEWS = [
  { title: '茅台业绩超预期', content: '增长', url: 'http://a', source: '新闻', time: '2026-08-20 10:00:00', sentiment: 'pos' },
  { title: '茅台召开股东大会', content: '', url: null, source: '公告', time: '2026-08-19 10:00:00', sentiment: 'neu' },
];
const FAKE_EVENTS = [
  { type: '财报披露', date: '2026-06-30', detail: 'EPS: 35.57', direction: 'neu', url: null },
];

let fetchEastMoneyQuote, fetchMarketIndex, searchStockByName, fetchKLineData, analyzeStockFull, getStockPanelData;
let fetchStockNews, fetchStockEvents;

beforeEach(() => {
  jest.resetModules(); // 清空 panels/stock.js 模块级缓存（_cache/_analysisCache/_extrasCache）
  ({ fetchEastMoneyQuote, fetchMarketIndex, fetchStockNews, fetchStockEvents } = require('../../tools/stock/stock-fundamental'));
  ({ searchStockByName, fetchKLineData } = require('../../tools/stock/stock-utils'));
  ({ analyzeStockFull } = require('../../tools/stock-tools'));
  ({ getStockPanelData } = require('./stock'));
  jest.clearAllMocks();
  fetchEastMoneyQuote.mockResolvedValue({ ...FAKE_QUOTE });
  fetchMarketIndex.mockResolvedValue({ '000001': { name: '上证指数', price: 3200, changePct: 0.5 } });
  searchStockByName.mockResolvedValue({ code: '600519', name: '贵州茅台' });
  fetchKLineData.mockResolvedValue([]);
  analyzeStockFull.mockResolvedValue({ ...FAKE_ANALYSIS });
  // extras 默认失败降级（news/events → null 不阻塞行情）
  fetchStockNews.mockResolvedValue(null);
  fetchStockEvents.mockResolvedValue(null);
});

describe('getStockPanelData — 分析接线', () => {
  test('单股查询 → items[0].analysis 附加 + analyzeStockFull(core)', async () => {
    const d = await getStockPanelData({ queries: '600519' });
    expect(d.items[0].code).toBe('600519');
    expect(d.items[0].analysis.momentum.trendStatus).toBe('多头排列');
    expect(analyzeStockFull).toHaveBeenCalledWith('600519', { depth: 'core' });
    // 自动收藏钩子（mock 后）仍被调用且参数含 code/name——不落盘但验证接线
    // （resetModules 后 stock.js 惰性 require 与测试内 require 同实例）
    const { addWatchlist } = require('../../tools/stock-watchlist');
    expect(addWatchlist).toHaveBeenCalledWith(expect.objectContaining({ code: '600519', name: '贵州茅台' }));
  });

  test('多股查询 → 不加 analysis（轻量路径）', async () => {
    const d = await getStockPanelData({ queries: '600519,000858' });
    expect(d.items.length).toBeGreaterThan(0);
    expect(d.items[0].analysis).toBeUndefined();
    expect(analyzeStockFull).not.toHaveBeenCalled();
  });

  test('opts.analysis === false → 不分析（兼容旧调用）', async () => {
    const d = await getStockPanelData({ queries: '600519', analysis: false });
    expect(d.items[0].analysis).toBeUndefined();
  });

  test('分析失败 → analysis=null 不炸，行情保留', async () => {
    analyzeStockFull.mockRejectedValue(new Error('boom'));
    const d = await getStockPanelData({ queries: '600519' });
    expect(d.items[0].price).toBe(1500);
    expect(d.items[0].analysis).toBeNull();
  });
});

describe('getStockPanelData — 分析缓存（10min）', () => {
  test('第二次同股请求命中缓存不再调 analyzeStockFull', async () => {
    await getStockPanelData({ queries: '600519' });
    await getStockPanelData({ queries: '600519' });
    expect(analyzeStockFull).toHaveBeenCalledTimes(1);
  });

  // 不同查询串 → 30s 行情缓存 key 不同（不短路）→ 真走 analysis 块 → 分析缓存
  // key='600519|core' 相同 → 命中 _analysisCache 分支（覆盖 10min 分析缓存本身）
  test('不同查询串解析同代码 → 分析缓存命中（走 _analysisCache 分支）', async () => {
    searchStockByName.mockImplementation((q) =>
      Promise.resolve(q === '贵州茅台' ? { code: '600519', name: '贵州茅台' } : { code: '600519', name: '贵州茅台' })
    );
    await getStockPanelData({ queries: '600519' });
    await getStockPanelData({ queries: '贵州茅台' }); // 行情缓存 key 不同, 走 analysis 块 → 分析缓存命中
    expect(analyzeStockFull).toHaveBeenCalledTimes(1);
  });

  test('force=true 绕过分析缓存', async () => {
    await getStockPanelData({ queries: '600519' });
    await getStockPanelData({ queries: '600519', force: true });
    expect(analyzeStockFull).toHaveBeenCalledTimes(2);
  });

  test('不同代码 → 分析缓存 miss → 重新计算', async () => {
    searchStockByName.mockImplementation((q) =>
      Promise.resolve(q === '贵州茅台' ? { code: '600519', name: '贵州茅台' } : { code: '000858', name: '五粮液' })
    );
    // 行情 mock 需回显请求代码——分析缓存 key 取 items[0].code（= quote.code || code），
    // 否则 FAKE_QUOTE 恒 600519 会使两次调用 aKey 相同而误命中
    fetchEastMoneyQuote.mockImplementation((code) =>
      Promise.resolve({ ...FAKE_QUOTE, code, name: code === '000858' ? '五粮液' : '贵州茅台' })
    );
    await getStockPanelData({ queries: '600519' });
    await getStockPanelData({ queries: '000858' });
    expect(analyzeStockFull).toHaveBeenCalledTimes(2);
  });

  // 2026-08-16: 解读与 analysis 同缓存条目。第二次查询串改 '贵州茅台'（解析同代码
  // 600519）——若仍用 '600519' 会被 30s 行情缓存短路, 根本走不到 analysis 缓存分支。
  // resetModules 后 require('./stock-interpret') 为全新实例, spyOn 须在测试内设置。
  test('analysis 缓存命中时 interpret 一并缓存', async () => {
    const mod = require('./stock-interpret');
    const spy = jest.spyOn(mod, 'generateStockInterpret').mockResolvedValue({ source: 'fallback', verdict: {} });
    const d1 = await getStockPanelData({ queries: '600519' });
    const d2 = await getStockPanelData({ queries: '贵州茅台' });
    expect(d1.items[0].interpret.source).toBe('fallback');
    expect(spy).toHaveBeenCalledTimes(1);  // 第二次命中缓存
    expect(d2.items[0].interpret).toEqual(d1.items[0].interpret);
  });
});

describe('getStockPanelData — 卡片搜索增强 extras（2026-08-21 P2）', () => {
  test('单股查询 → data 顶层三字段（news/events/fundamentalsSummary）形状完整', async () => {
    fetchStockNews.mockResolvedValue([...FAKE_NEWS]);
    fetchStockEvents.mockResolvedValue([...FAKE_EVENTS]);
    const d = await getStockPanelData({ queries: '600519' });
    expect(fetchStockNews).toHaveBeenCalledWith('600519');
    expect(fetchStockEvents).toHaveBeenCalledWith('600519');
    expect(d.news).toHaveLength(2);
    expect(d.news[0]).toMatchObject({ title: '茅台业绩超预期', url: 'http://a', source: '新闻', sentiment: 'pos' });
    expect(d.news[1].url).toBeNull(); // 无 url 行保留（可点性由前端降级）
    expect(d.events).toMatchObject([{ type: '财报披露', direction: 'neu' }]);
    expect(d.fundamentalsSummary).toMatchObject({
      company: { businessModel: '高附加值型', pricing: '强定价权', overallScore: 0.8 },
      industry: { name: '白酒', prosperity: '景气' },
      metrics: [{ name: 'PE估值', value: '28.50', status: '合理' }],
      score: 0.6,
    });
  });

  test('analysis:false 仍取 news/events（extras 与分析解耦）', async () => {
    fetchStockNews.mockResolvedValue([...FAKE_NEWS]);
    fetchStockEvents.mockResolvedValue([...FAKE_EVENTS]);
    const d = await getStockPanelData({ queries: '600519', analysis: false });
    expect(analyzeStockFull).not.toHaveBeenCalled();
    expect(d.items[0].analysis).toBeUndefined();
    expect(d.news).toHaveLength(2);
    expect(d.events).toHaveLength(1);
    // analysis 缺席 → fundamentalsSummary null（投影无源）
    expect(d.fundamentalsSummary).toBeNull();
  });

  test('fetchStockNews reject → news:null 不炸行情', async () => {
    fetchStockNews.mockRejectedValue(new Error('network down'));
    fetchStockEvents.mockResolvedValue([...FAKE_EVENTS]);
    const d = await getStockPanelData({ queries: '600519' });
    expect(d.items[0].price).toBe(1500); // 行情主体完整
    expect(d.news).toBeNull();
    expect(d.events).toHaveLength(1);    // 部分成功仍合并
  });

  test('两源全失败 → 三字段 null（前端整块隐藏）', async () => {
    fetchStockNews.mockRejectedValue(new Error('x'));
    fetchStockEvents.mockRejectedValue(new Error('y'));
    const d = await getStockPanelData({ queries: '600519' });
    expect(d.news).toBeNull();
    expect(d.events).toBeNull();
    expect(d.fundamentalsSummary).not.toBeNull(); // 投影依赖 analysis 非网络
  });

  test('extras 10min 缓存：二次查询不重复打源', async () => {
    fetchStockNews.mockResolvedValue([...FAKE_NEWS]);
    fetchStockEvents.mockResolvedValue([...FAKE_EVENTS]);
    await getStockPanelData({ queries: '600519' });
    // 第二次换查询串绕过 30s 行情缓存（同代码 600519 命中 analysis 缓存，但 extras 走独立缓存）
    await getStockPanelData({ queries: '贵州茅台' });
    expect(fetchStockNews).toHaveBeenCalledTimes(1);
    expect(fetchStockEvents).toHaveBeenCalledTimes(1);
  });

  test('force 绕过 extras 缓存重新打源', async () => {
    fetchStockNews.mockResolvedValue([...FAKE_NEWS]);
    fetchStockEvents.mockResolvedValue([...FAKE_EVENTS]);
    await getStockPanelData({ queries: '600519' });
    await getStockPanelData({ queries: '贵州茅台', force: true });
    expect(fetchStockNews).toHaveBeenCalledTimes(2);
  });

  test('多股查询 → 不取 extras（三字段 null）', async () => {
    fetchEastMoneyQuote.mockImplementation((code) =>
      Promise.resolve({ ...FAKE_QUOTE, code, name: '五粮液' })
    );
    searchStockByName.mockResolvedValue({ code: '000858', name: '五粮液' });
    const d = await getStockPanelData({ queries: '600519,000858' });
    expect(fetchStockNews).not.toHaveBeenCalled();
    expect(d.news).toBeNull();
    expect(d.events).toBeNull();
  });
});
