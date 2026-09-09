/**
 * 股票卡片发射形状回归测试（2026-08-17）
 *
 * 实机 bug 链："还是没有画出股票卡片" + "对话窗口中间的小股票卡片"。
 * 根因：StockQuery 成功后 _publishStockCard 发射 'stocks-card'（kind 'stocks'），
 * 前端 StockPanel 常驻订阅的是 'stock-panel'——id 不匹配卡片永不弹出；
 * 且 stocks-card/stocks-kline 漏进对话窗口卡片墙被 kinds/stocks.tsx 渲染成小卡。
 *
 * 修复：统一发射到 'stock-panel'（kind 'stock-panel'，data 形状对齐前端
 * StockPanelData），单股 K线并入 data.kline；stocks-kline 不再独立发射。
 */

const { getSceneStore } = require('../core/scene/scene-store');
const { getEffectiveState, setPanelState } = require('../core/panel-state');
const { _publishStockCard, _publishStockEmptyCard } = require('../tools/stock-tools');

describe('_publishStockCard 发射形状', () => {
  let store;

  beforeEach(() => {
    store = new (require('../core/scene/scene-store').SceneStore)();
    // 使用独立 store 实例避免全局单例污染
    jest.spyOn(require('../core/scene/scene-store'), 'getSceneStore').mockReturnValue(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // panel-state 为模块级单例，复位避免污染其他用例/测试文件
    setPanelState('stock', 'closed');
  });

  test('发射到 stock-panel（前端订阅 id），kind 与 data 形状对齐前端', () => {
    _publishStockCard([{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1, signal: 'MACD 金叉', score: 72 }]);
    const s = store.getSurface('stock-panel');
    expect(s).toBeTruthy();
    expect(s.kind).toBe('stock-panel');
    expect(s.intent).toBe('inform');
    expect(Array.isArray(s.data.items)).toBe(true);
    expect(s.data.items[0]).toMatchObject({ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 });
    // 前端 StockPanelData 必需字段
    expect(s.data).toMatchObject({ kline: null, index: null, holdingSummary: null, failed: [] });
    expect(typeof s.data.updatedAt).toBe('string');
    expect(typeof s.data.disclaimer).toBe('string');
    expect(s._ttlMs).toBe(10 * 60 * 1000); // 10 分钟 TTL 防残留
  });

  test('单股 K线并入 data.kline（不再独立发 stocks-kline）', () => {
    const kline = [
      { date: '2026-08-10', open: 1430, close: 1450, high: 1460, low: 1425, volume: 100, amount: 0 },
      { date: '2026-08-11', open: 1450, close: 1470, high: 1475, low: 1435, volume: 90, amount: 0 },
    ];
    _publishStockCard(
      [{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }],
      { code: '600519', name: '贵州茅台', kline },
    );
    const s = store.getSurface('stock-panel');
    expect(s.data.kline).toBeTruthy();
    expect(s.data.kline.period).toBe('day');
    expect(s.data.kline.labels.join(',')).toBe('2026-08-10,2026-08-11');
    expect(s.data.kline.ohlc[1].c).toBe(1470);
    // 不再有 stocks-kline 独立 surface（前端无订阅者，只进卡片墙）
    expect(store.getSurface('stocks-kline')).toBeUndefined();
  });

  test('非法 K线 → kline: null，不影响卡片发射', () => {
    _publishStockCard(
      [{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }],
      { code: '600519', name: '贵州茅台', kline: null },
    );
    const s = store.getSurface('stock-panel');
    expect(s).toBeTruthy();
    expect(s.data.kline).toBeNull();
  });

  test('空 items → 不发射（无卡不打扰）', () => {
    _publishStockCard([]);
    expect(store.getSurface('stock-panel')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('发射成功后同步 panel-state open（回归："关闭"指令不关股票卡）', () => {
    // 实机根因：StockQuery 发卡片但从不写 panel-state open → 上下文注入恒显
    // closed → 用户说"关闭"时 AI 误判无面板可关，只调 VoiceRetire 关语音球。
    // 修复：_publishStockCard 与 ShowStock 对称写 open，注入指引
    // "关闭面板: ShowStock(action='hide')" 才生效。
    setPanelState('stock', 'closed');
    _publishStockCard([{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }]);
    expect(getEffectiveState('stock')).toBe('open');
  });

  test('空 items 不发射时保持原状态（不误写 open）', () => {
    setPanelState('stock', 'closed');
    _publishStockCard([]);
    expect(getEffectiveState('stock')).toBe('closed');
  });
});

describe('_publishStockEmptyCard 空态卡发射（2026-08-21）', () => {
  let store;

  beforeEach(() => {
    store = new (require('../core/scene/scene-store').SceneStore)();
    jest.spyOn(require('../core/scene/scene-store'), 'getSceneStore').mockReturnValue(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setPanelState('stock', 'closed');
  });

  test('搜索兜底解不出代码 → 空态卡照常弹出（产品要求：卡片一定弹出）', () => {
    // 实机根因（10:49）：688836/宇树科技 不在 POPULAR_STOCKS，WebSearch 兜底
    // 只回文本 → _stockCardItems 空 → 旧逻辑静默无卡。现在改发空态卡。
    _publishStockEmptyCard('宇树科技', '未识别到股票代码或未取到实时行情');
    const s = store.getSurface('stock-panel');
    expect(s).toBeTruthy();
    expect(s.kind).toBe('stock-panel');
    expect(s.data.items).toEqual([]);
    // 查询文本进入 failed 数组，前端空态渲染"未取到行情：宇树科技"
    expect(s.data.failed).toContain('宇树科技');
    expect(s.data.error).toContain('未识别到股票代码');
    expect(s.data).toMatchObject({ kline: null, index: null, holdingSummary: null });
    expect(s._ttlMs).toBe(10 * 60 * 1000);
  });

  test('多股/逗号分隔查询 → failed 数组拆分', () => {
    _publishStockEmptyCard('688836,宇树科技', null);
    const s = store.getSurface('stock-panel');
    expect(s.data.failed).toEqual(['688836', '宇树科技']);
    expect(s.data.error).toContain('请确认股票名称/代码后重试');
  });

  test('空态卡同步 panel-state open（"关闭"指令可命中）', () => {
    setPanelState('stock', 'closed');
    _publishStockEmptyCard('宇树科技', null);
    expect(getEffectiveState('stock')).toBe('open');
  });
});

describe('_publishStockCard extras 三参（2026-08-21 P3：搜索增强）', () => {
  let store;

  beforeEach(() => {
    store = new (require('../core/scene/scene-store').SceneStore)();
    jest.spyOn(require('../core/scene/scene-store'), 'getSceneStore').mockReturnValue(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setPanelState('stock', 'closed');
  });

  test('第三参 extrasOverride → data 顶层三字段注入', () => {
    const extras = {
      code: '600519',
      news: [{ title: '茅台业绩超预期', url: 'http://a', source: '新闻', time: '2026-08-20', sentiment: 'pos' }],
      events: [{ type: '财报披露', date: '2026-06-30', detail: 'EPS 35.57', direction: 'neu', url: null }],
      fundamentalsSummary: {
        company: { businessModel: '高附加值型', overallScore: 0.8 },
        industry: { name: '白酒', prosperity: '景气' },
        metrics: [{ name: 'PE估值', value: '28.50', status: '合理' }],
        score: 0.6, summary: '综合',
      },
    };
    _publishStockCard([{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }], null, extras);
    const s = store.getSurface('stock-panel');
    expect(s.data.news).toHaveLength(1);
    expect(s.data.news[0]).toMatchObject({ title: '茅台业绩超预期', sentiment: 'pos' });
    expect(s.data.events[0]).toMatchObject({ type: '财报披露', direction: 'neu' });
    expect(s.data.fundamentalsSummary).toMatchObject({ score: 0.6, summary: '综合' });
    // 不污染 items 主体
    expect(s.data.items[0].code).toBe('600519');
  });

  test('无 extras → 三字段 null（前端整块隐藏）', () => {
    _publishStockCard([{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }]);
    const s = store.getSurface('stock-panel');
    expect(s.data.news).toBeNull();
    expect(s.data.events).toBeNull();
    expect(s.data.fundamentalsSummary).toBeNull();
  });

  test('extras.code 与卡内代码不符 → 丢弃（防串数据）', () => {
    const extras = { code: '000858', news: [{ title: '五粮液新闻', url: null, source: '新闻', time: null, sentiment: null }], events: null, fundamentalsSummary: null };
    _publishStockCard([{ code: '600519', name: '贵州茅台', price: 1450.5, changePct: 2.1 }], null, extras);
    const s = store.getSurface('stock-panel');
    expect(s.data.news).toBeNull();
    expect(s.data.events).toBeNull();
  });

  test('空态卡含三字段 null（形状与成功卡统一）', () => {
    _publishStockEmptyCard('宇树科技', '未识别到股票代码');
    const s = store.getSurface('stock-panel');
    expect(s.data.news).toBeNull();
    expect(s.data.events).toBeNull();
    expect(s.data.fundamentalsSummary).toBeNull();
  });
});
