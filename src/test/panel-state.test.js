/**
 * panel-state 统一 builder + TTL 语义测试 — 2026-08-15
 * 重构后 buildPanelStateContext 替代三个分散 builder（零消费者），
 * 相关度注入：effectiveState 为 null 时返回 null（零注入）。
 */
const {
  setPanelState, getEffectiveState, getPanelState,
  buildPanelStateContext, PANEL_CLOSED_TTL_MS, PANEL_OPEN_TTL_MS,
} = require('../core/panel-state');

describe('TTL 语义（重构保留不变）', () => {
  test('open 60min 内有效，超时归 null', () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      setPanelState('weather', 'open');
      expect(PANEL_OPEN_TTL_MS).toBe(60 * 60 * 1000);
      Date.now.mockReturnValue(now + 60 * 60 * 1000 - 1);
      expect(getEffectiveState('weather')).toBe('open');
      Date.now.mockReturnValue(now + 60 * 60 * 1000 + 1);
      expect(getEffectiveState('weather')).toBe(null);
    } finally { spy.mockRestore(); }
  });

  test('closed 120s 内有效，超时归 null', () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      setPanelState('stock', 'closed');
      expect(PANEL_CLOSED_TTL_MS).toBe(120000);
      Date.now.mockReturnValue(now + 120000 - 1);
      expect(getEffectiveState('stock')).toBe('closed');
      Date.now.mockReturnValue(now + 120000 + 1);
      expect(getEffectiveState('stock')).toBe(null);
    } finally { spy.mockRestore(); }
  });

  test('getPanelState 返回五 key 的有效状态', () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      setPanelState('music', 'open');
      setPanelState('hotspot', 'closed');
      // 隔离修正（2026-08-15）：前置测试曾在真实时刻将 weather 置 open（60min TTL 未过，
      // 本测试的 now 仍在其有效期内），这里把 weather 的 updatedAt 拨出 closed TTL，
      // 令其归 null——符合"从未交互的面板为 null"的测试意图
      Date.now.mockReturnValue(now - PANEL_CLOSED_TTL_MS - 1);
      setPanelState('weather', 'closed');
      Date.now.mockReturnValue(now);
      const states = getPanelState();
      // 2026-08-17: filegen 面板注册后共五 key（未交互的 filegen 归 null）
      // 2026-08-18: meeting 面板注册后共六 key（未交互的 meeting 归 null）
      // 2026-08-19: schedule 面板注册后共七 key（未交互的 schedule 归 null）
      // 2026-08-20: knowledge 面板注册后共八 key（未交互的 knowledge 归 null）
      // 2026-08-25: commodity/businessReport 产品卡注册后共十 key（模块级注册，未交互归 null）
      // 2026-09-05: receivable/contractExpiry/businessBriefing 业务卡 P0 注册后共十四 key（未交互归 null）
      expect(Object.keys(states).sort()).toEqual(['approvals', 'businessBriefing', 'businessReport', 'commodity', 'contractExpiry', 'customerView', 'filegen', 'hotspot', 'knowledge', 'meeting', 'music', 'receivable', 'schedule', 'stock', 'stockAlert', 'supplierProfile', 'typhoon', 'weather']);
      expect(states.music).toBe('open');
      expect(states.hotspot).toBe('closed');
      expect(states.weather).toBe(null);
    } finally { spy.mockRestore(); }
  });
});

describe('buildPanelStateContext（统一入口）', () => {
  test('null 状态返回 null（零注入）', () => {
    expect(buildPanelStateContext('weather', null, null)).toBe(null);
    expect(buildPanelStateContext('music', null, {})).toBe(null);
    expect(buildPanelStateContext('stock', null, { items: [] })).toBe(null);
  });

  test('weather open + 快照 → 状态行内联摘要 + 指引，无防幻觉行', () => {
    const block = buildPanelStateContext('weather', 'open',
      { city: '北京', temp: '28', condition: '晴', humidity: '60%', wind: '6km/h' });
    expect(block).toContain('## 天气面板状态');
    expect(block).toContain('当前: ✅ 已打开（北京 28° 晴 · 湿度 60%）');
    expect(block).toContain('ShowWeather(city="城市名")');
    expect(block).toContain('ShowWeather(action="hide")');
    expect(block).not.toContain('⚠️');
  });

  test('weather open 无 surfaceData → 只有状态行 + 指引，无摘要', () => {
    const block = buildPanelStateContext('weather', 'open', null);
    expect(block).toContain('当前: ✅ 已打开');
    expect(block).not.toContain('（');
    expect(block).toContain('操作指引:');
  });

  test('weather closed → 已关闭 + 防幻觉行，无摘要', () => {
    const block = buildPanelStateContext('weather', 'closed', { city: '北京', temp: '28' });
    expect(block).toContain('当前: ⛔ 已关闭（用户手动关闭）');
    expect(block).toContain('⚠️ 如果当前状态为未打开，你绝对不可以说"面板已打开"。必须先调用工具。');
    expect(block).toContain('ShowWeather(city="城市名")');
    expect(block).not.toContain('（北京');
  });

  test('stock open + items → 首只股票摘要 + 指引', () => {
    const block = buildPanelStateContext('stock', 'open',
      { items: [{ name: '贵州茅台', price: 1450.5, changePct: 0.85 }], index: { name: '上证指数', price: 3245.62, changePct: 0.4 } });
    expect(block).toContain('## 股票面板状态');
    expect(block).toContain('当前: ✅ 已打开（贵州茅台 1450.5 +0.85%）');
    expect(block).toContain('ShowStock(queries="股票名")');
    expect(block).toContain('ShowStock(action="hide")');
  });

  test('stock open 负涨跌幅 → 无 + 号前缀', () => {
    const block = buildPanelStateContext('stock', 'open',
      { items: [{ name: '某股', price: 10, changePct: -1.2 }] });
    expect(block).toContain('当前: ✅ 已打开（某股 10 -1.2%）');
  });

  test('stock open 无 items → 无摘要行', () => {
    const block = buildPanelStateContext('stock', 'open', { items: [] });
    expect(block).toContain('当前: ✅ 已打开');
    expect(block).not.toContain('（');
  });

  test('stock closed → 打开指引 + 防幻觉行', () => {
    const block = buildPanelStateContext('stock', 'closed', null);
    expect(block).toContain('ShowStock(queries="贵州茅台"（留空默认上证指数）)');
    expect(block).toContain('⚠️');
  });

  test('hotspot open（surface data 仅为 action 标志）→ 无摘要，指引含 ShowHotspot/hotspot_mode', () => {
    const block = buildPanelStateContext('hotspot', 'open', { action: 'show', active: true });
    expect(block).toContain('## 热点面板状态');
    expect(block).toContain('当前: ✅ 已打开');
    expect(block).not.toContain('（');
    expect(block).toContain('ShowHotspot(platform="weibo")');
    expect(block).toContain('ShowHotspot(action="hide")');
  });

  test('hotspot closed → 打开指引 ShowHotspot(format="scene") + 防幻觉行', () => {
    const block = buildPanelStateContext('hotspot', 'closed', null);
    expect(block).toContain('ShowHotspot(action="show", format="scene")');
    expect(block).toContain('⚠️');
  });

  test('music open/closed → Music 指引', () => {
    const open = buildPanelStateContext('music', 'open', null);
    expect(open).toContain('## 音乐面板状态');
    expect(open).toContain('当前: ✅ 已打开');
    expect(open).toContain('Music(action="pause"|"next"|"prev")');
    expect(open).toContain('Music(action="stop")');
    expect(open).not.toContain('⚠️');
    const closed = buildPanelStateContext('music', 'closed', null);
    expect(closed).toContain('Music(action="search", query="歌曲名")');
    expect(closed).toContain('⚠️');
  });
});
