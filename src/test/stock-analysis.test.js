/**
 * stock-analysis.test.js — analyzeStockFull 编排与深度过滤（2026-08-16）
 * mock 全部数据源 fetch；深度分析函数内部网络失败由各自 catch 降级为 null，
 * 只断言字段存在性（key in r），不断言深度值非空。
 */
jest.mock('../tools/stock/stock-fundamental', () => {
  const actual = jest.requireActual('../tools/stock/stock-fundamental');
  return {
    ...actual,
    fetchEastMoneyQuote: jest.fn(),
    fetchNorthFlow: jest.fn(),
    fetchMarginData: jest.fn(),
    fetchMarketIndex: jest.fn(),
    fetchIndustryPeers: jest.fn(),
    fetchFundFlowTrend: jest.fn(),
    // 2026-08-21 P1: 卡片搜索增强取数层——必须 mock 成 jest.fn()，否则 jest.requireActual
    // 展开会真打网（不稳定，且 P0 已锁定解析纯函数单测）
    fetchStockNews: jest.fn(),
    fetchStockEvents: jest.fn(),
  };
});
jest.mock('../tools/stock/stock-utils', () => {
  const actual = jest.requireActual('../tools/stock/stock-utils');
  return { ...actual, fetchKLineData: jest.fn() };
});

const {
  fetchEastMoneyQuote, fetchNorthFlow, fetchMarginData, fetchMarketIndex,
  fetchIndustryPeers, fetchFundFlowTrend, fetchStockNews, fetchStockEvents,
} = require('../tools/stock/stock-fundamental');
// 注意：fetchKLineData 由 stock-utils 导出（stock-fundamental 不导出它），
// 测试文件须从被 mock 的 stock-utils 上取，才能与实现侧共享同一 jest.fn
const { fetchKLineData } = require('../tools/stock/stock-utils');
const { analyzeStockFull } = require('../tools/stock-tools');

const FAKE_QUOTE = {
  code: '600519', name: '贵州茅台', price: 1500, change: 10, changePct: 0.67,
  open: 1490, high: 1510, low: 1485, prevClose: 1490, volume: 30000, amount: 4.5e9,
  marketCap: 1.8e12, pe: 25, pb: 8, roe: 30, grossMargin: 90, netMargin: 50, industry: '白酒',
};
const FAKE_KLINE = Array.from({ length: 30 }, (_, i) => ({
  date: `2026-07-${String(i + 1).padStart(2, '0')}`,
  open: 100 + i, high: 103 + i, low: 99 + i, close: 101 + i, volume: 100000 + i * 1000,
}));

beforeEach(() => {
  jest.clearAllMocks();
  fetchEastMoneyQuote.mockResolvedValue({ ...FAKE_QUOTE });
  fetchKLineData.mockResolvedValue([...FAKE_KLINE]);
  // 其余 5 路 fetch 一律 resolve null（模拟获取失败降级），避免裸 jest.fn() 返回
  // undefined 导致实现里 `.catch(...)` 链抛 TypeError（见 task-1-report 偏差节）
  fetchNorthFlow.mockResolvedValue(null);
  fetchMarginData.mockResolvedValue(null);
  fetchMarketIndex.mockResolvedValue(null);
  fetchIndustryPeers.mockResolvedValue(null);
  fetchFundFlowTrend.mockResolvedValue(null);
  // extras 取数（P1）——默认失败降级，full 深度专项用例再 mock 成功
  fetchStockNews.mockResolvedValue(null);
  fetchStockEvents.mockResolvedValue(null);
});

describe('analyzeStockFull — core 深度（面板默认）', () => {
  test('核心字段齐备 + quote 值透传', async () => {
    const r = await analyzeStockFull('600519');
    expect(r.code).toBe('600519');
    expect(r.name).toBe('贵州茅台');
    expect(r.dataSource).toBe('eastmoney_quote');
    expect(r.quote.price).toBe(1500);
    expect(r.momentum).toBeTruthy();
    expect(r.momentum.trendStatus).toBe('多头排列'); // 30 根递增 K 线 → MA5>MA10>MA20
    expect(Array.isArray(r.supportResistance.support)).toBe(true);
    expect(Array.isArray(r.risks.risks)).toBe(true);
    expect(r.overallScore).toBeTruthy();
    expect(r.multiFactor).toBeTruthy();
    expect(r.macroEnv).toBeTruthy();
    expect(r.generatedAt).toBeTruthy();
  });

  test('core 不含深度字段（mlPrediction 等缺席）', async () => {
    const r = await analyzeStockFull('600519');
    expect('mlPrediction' in r).toBe(false);
    expect('marketSentiment' in r).toBe(false);
    expect('alternativeData' in r).toBe(false);
  });
});

describe('analyzeStockFull — full 深度（工具原行为）', () => {
  test('full 含全部深度字段（值可为 null，键必须存在）', async () => {
    const r = await analyzeStockFull('600519', { depth: 'full' });
    expect('mlPrediction' in r).toBe(true);
    expect('marketSentiment' in r).toBe(true);
    expect('alternativeData' in r).toBe(true);
    expect('statArbitrage' in r).toBe(true);
    expect('microstructure' in r).toBe(true);
  });

  // ---- 2026-08-21 P1: 取数单源化接线 ----
  test('eventDriven 复用 fetchStockEvents（fetch 仅经取数层一次）', async () => {
    const fakeEvents = [{ type: '财报披露', date: '2026-06-30', detail: 'EPS: 35.57', direction: 'neu', url: null }];
    fetchStockEvents.mockResolvedValue(fakeEvents);
    const r = await analyzeStockFull('600519', { depth: 'full' });
    expect(fetchStockEvents).toHaveBeenCalledTimes(1);
    expect(fetchStockEvents).toHaveBeenCalledWith('600519');
    expect(r.eventDriven.events).toEqual(fakeEvents);
    expect(r.eventDriven.summary).toContain('1个事件');
  });

  test('marketSentiment 复用 fetchStockNews + newsItems 透传（含 sentiment/direction）', async () => {
    const fakeNews = [
      { title: '茅台业绩超预期', content: '增长', url: 'http://a', source: '新闻', time: '2026-08-20 10:00:00', sentiment: 'pos' },
      { title: '茅台遭减持', content: '', url: null, source: '公告', time: '2026-08-19 10:00:00', sentiment: 'neg' },
      { title: '股东大会召开', content: '', url: null, source: '新闻', time: null, sentiment: 'neu' },
    ];
    fetchStockNews.mockResolvedValue(fakeNews);
    const r = await analyzeStockFull('600519', { depth: 'full' });
    expect(fetchStockNews).toHaveBeenCalledTimes(1);
    expect(fetchStockNews).toHaveBeenCalledWith('600519');
    // newsItems 透传 + 情感统计基于 sentiment 字段
    expect(r.marketSentiment.newsItems).toEqual(fakeNews);
    expect(r.marketSentiment.newsSentiment.positive).toBe(1);
    expect(r.marketSentiment.newsSentiment.negative).toBe(1);
    expect(r.marketSentiment.newsSentiment.neutral).toBe(1);
    expect(r.marketSentiment.newsSentiment.score).toBeCloseTo(0.5); // (1-1)/3 → 0-1 标准化
  });

  test('fetchStockNews 失败（null）→ marketSentiment 无 newsItems 不炸', async () => {
    fetchStockNews.mockResolvedValue(null);
    const r = await analyzeStockFull('600519', { depth: 'full' });
    expect(r.marketSentiment.newsSentiment.positive).toBe(0);
    expect(r.marketSentiment.newsItems).toBeUndefined();
  });
});

describe('analyzeStockFull — 失败降级', () => {
  test('行情失败 → quote 缺席不炸，dataSource=unknown', async () => {
    fetchEastMoneyQuote.mockResolvedValue(null);
    const r = await analyzeStockFull('600519');
    expect(r.quote).toBeUndefined();
    expect(r.name).toBe('');
    expect(r.dataSource).toBe('unknown');
    expect(r.generatedAt).toBeTruthy();
  });

  test('K线失败 → 技术字段缺席但行情保留', async () => {
    fetchKLineData.mockResolvedValue(null);
    const r = await analyzeStockFull('600519');
    expect(r.quote.price).toBe(1500);
    expect(r.momentum).toBeNull();      // analyzeMomentum(null) → null
    expect(r.supportResistance).toBeNull();
  });
});

describe('formatAnalysisReport / generateSmartAlert — 支撑阻力新结构（2026-08-17 回归）', () => {
  // 回归锁定：v2.2.0 起 detectSupportResistance 返回 {support:[],resistance:[],currentPrice}
  // （字符串数组），而 formatAnalysisReport 曾读旧结构 sr.supports.length 无守卫 →
  // 所有股票抛 TypeError → StockQuery 工具恒降级网络搜索（"查 大华股份" 只回百科）。
  const { formatAnalysisReport, generateSmartAlert } = require('../tools/stock-tools');

  const NEW_SR = {
    support: ['15.92', '16.46', '16.00'],
    resistance: ['17.50', '18.20'],
    currentPrice: '16.47',
  };

  test('formatAnalysisReport 新结构不抛 + 输出支撑/阻力/现价', () => {
    const report = formatAnalysisReport(
      { code: '002236', name: '大华股份', price: 16.47, changePct: 1.5 },
      null, null, null, null, null, null, null,
      { supportResistance: NEW_SR }
    );
    expect(report).toContain('【支撑阻力位】');
    expect(report).toContain('支撑位: 15.92 → 16.46 → 16.00');
    expect(report).toContain('阻力位: 17.50 → 18.20');
    expect(report).toContain('现价: 16.47');
  });

  test('formatAnalysisReport 空数组不崩（无支撑/阻力数据）', () => {
    const report = formatAnalysisReport(
      { code: '002236', name: '大华股份', price: 16.47, changePct: 1.5 },
      null, null, null, null, null, null, null,
      { supportResistance: { support: [], resistance: [], currentPrice: '16.47' } }
    );
    expect(report).toContain('【支撑阻力位】');
  });

  test('generateSmartAlert 现价贴近支撑位 → HIGH 预警', () => {
    const sr = {
      support: ['16.30', '16.00'],
      resistance: ['17.50'],
      currentPrice: '16.47',
    };
    const alerts = generateSmartAlert(null, null, null, null, sr, null);
    const nearSupport = alerts.alerts.find(a => a.type === '接近支撑位');
    expect(nearSupport).toBeTruthy();
    expect(nearSupport.level).toBe('HIGH');
    expect(nearSupport.message).toContain('16.30');
  });

  test('generateSmartAlert 无支撑/阻力数组不崩', () => {
    const alerts = generateSmartAlert(null, null, null, null,
      { support: [], resistance: [], currentPrice: '16.47' }, null);
    expect(alerts).toBeNull();
  });
});

describe('formatAnalysisReport / generateSmartAlert — 其余 v2.2.0 结构漂移（2026-08-17 回归）', () => {
  // 回归锁定：v2.2.0 起 analyzeMultiTimeframe/analyzeVolatility/identifyTechnicalPattern
  // 返回新结构，formatAnalysisReport 曾读旧字段：mtf.daily.trend 直接抛 TypeError
  // （第二次崩溃现场），volatility atr/boll*、pattern signal/confidence 渲染 undefined；
  // generateSmartAlert 的 pattern/volatility 段因此静默失效。
  const { formatAnalysisReport, generateSmartAlert } = require('../tools/stock-tools');

  const NEW_MTF = {
    shortTerm: { trend: '偏空', ma: '16.61' },
    midTerm: { trend: '偏空', ma: '16.65' },
    longTerm: { trend: '偏空', ma: '16.66' },
    alignment: '空头共振',
  };
  const NEW_VOL = {
    dailyVolatility: '1.76%', annualVolatility: '28.00%',
    recentVolatility: '9.70%', level: '正常', avgDailyRange: '2.36%',
  };
  const NEW_PATTERN = {
    patterns: [
      { name: '头肩顶雏形', reliability: '中', implication: '看跌' },
      { name: '双底雏形', reliability: '中', implication: '看涨' },
    ],
    currentPrice: '16.47',
  };
  const NEW_MACRO = {
    economy: { status: '中性', score: 0.1, details: ['上证涨 0.01%，市场平稳'] },
    liquidity: { status: '中性', score: -0.1, details: ['北向资金净流出'] },
    policy: { status: '偏暖', score: 0.2, details: ['热门板块: 稀土'] },
    overallScore: 0.0666,
    summary: '宏观环境中性',
  };

  test('multiTimeframe 新结构不抛 + 输出三周期与共振', () => {
    const report = formatAnalysisReport(
      { code: '002236', name: '大华股份', price: 16.47, changePct: 1.5 },
      null, null, null, null, null, null, null,
      { multiTimeframe: NEW_MTF }
    );
    expect(report).toContain('日线: 偏空  周线: 偏空  月线: 偏空');
    expect(report).toContain('空头共振');
    expect(report).not.toContain('undefined');
  });

  test('volatility 新结构渲染真实值（无 undefined）', () => {
    const report = formatAnalysisReport(
      { code: '002236', name: '大华股份', price: 16.47, changePct: 1.5 },
      null, null, null, null, null, null, null,
      { volatility: NEW_VOL }
    );
    expect(report).toContain('日波动率: 1.76%');
    expect(report).toContain('年化波动率: 28.00%');
    expect(report).toContain('水平: 正常');
    expect(report).not.toContain('undefined');
  });

  test('pattern 新结构渲染形态名/可靠性（无 undefined）', () => {
    const report = formatAnalysisReport(
      { code: '002236', name: '大华股份', price: 16.47, changePct: 1.5 },
      null, null, null, null, null, null, null,
      { pattern: NEW_PATTERN }
    );
    expect(report).toContain('头肩顶雏形');
    expect(report).toContain('可靠性中');
    expect(report).not.toContain('undefined');
  });

  test('macroEnv 新结构不抛 + 输出宏观评分', () => {
    const report = formatAnalysisReport(
      { code: '002236', name: '大华股份', price: 16.47, changePct: 1.5 },
      null, null, null, null, null, null, null,
      { macroEnv: NEW_MACRO }
    );
    expect(report).toContain('经济环境: 中性');
    expect(report).toContain('宏观综合评分: 0.07');
    expect(report).not.toContain('undefined');
  });

  test('generateSmartAlert 形态看跌 → 产出预警', () => {
    const alerts = generateSmartAlert(null, null, NEW_PATTERN, null, null, null);
    const bear = alerts.alerts.find(a => a.type === '头肩顶雏形');
    expect(bear).toBeTruthy();
    expect(bear.level).toBe('LOW'); // 可靠性'中' → LOW（'高'才 MEDIUM）
    expect(bear.message).toContain('技术面偏空');
  });

  test('generateSmartAlert 波动率极高 → HIGH 预警', () => {
    const alerts = generateSmartAlert(null, null, null, null, null,
      { ...NEW_VOL, level: '极高' });
    const volAlert = alerts.alerts.find(a => a.type === '波动率极高');
    expect(volAlert).toBeTruthy();
    expect(volAlert.level).toBe('HIGH');
    expect(volAlert.message).toContain('28.00%');
  });

  test('generateSmartAlert 波动率正常 → 不产波动预警（不崩）', () => {
    const alerts = generateSmartAlert(null, null, null, null, null, NEW_VOL);
    expect(alerts).toBeNull();
  });
});
