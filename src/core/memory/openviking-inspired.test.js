/**
 * OpenViking 工程逻辑思想移植单测（2026-10-15）
 * 覆盖：time-decay-ranking / recall-exclusion / layered-summary
 * 及 hybrid-retrieval._postProcess 的接线行为（默认旁路零回归）。
 */
const {
  eventTimeDecayScore,
  applyEventTimeDecay,
} = require('./time-decay-ranking');
const {
  uriMatchesPattern,
  normalizeUri,
  SessionRecallLedger,
  applyRecallExclusion,
  filterExcludedUris,
} = require('./recall-exclusion');
const {
  splitSentences,
  buildAbstract,
  buildOverview,
  pickLayer,
  applyLayeredSummary,
} = require('./layered-summary');
const { HybridRetrievalEngine } = require('./hybrid-retrieval');

const NOW = 1760500000000; // 固定时钟，保证断言确定性
const DAY = 86400000;

describe('time-decay-ranking（检索侧事件时间衰减）', () => {
  test('新事件≈1，老事件趋近 floor，无时间戳=中性', () => {
    const fresh = eventTimeDecayScore(NOW - 0.5 * DAY, { now: NOW, halfLifeDays: 14, floor: 0.05 });
    const twoWeeks = eventTimeDecayScore(NOW - 14 * DAY, { now: NOW, halfLifeDays: 14, floor: 0.05 });
    const ancient = eventTimeDecayScore(NOW - 365 * DAY, { now: NOW, halfLifeDays: 14, floor: 0.05 });
    const unknown = eventTimeDecayScore(0, { now: NOW });

    expect(fresh).toBeGreaterThan(0.97);
    expect(twoWeeks).toBeCloseTo(0.525, 1); // 半衰期处 ≈ floor + (1-floor)*0.5
    expect(ancient).toBeLessThan(0.06);
    expect(unknown).toBe(1); // 未知 ≠ 陈旧，中性不打折
  });

  test('weight=0 完全旁路（eval 零回归保障）', () => {
    const items = [
      { id: 'a', combinedScore: 0.5, updatedAt: NOW - 100 * DAY, scores: {} },
      { id: 'b', combinedScore: 0.5, updatedAt: NOW, scores: {} },
    ];
    const out = applyEventTimeDecay(items, { weight: 0, now: NOW });
    expect(out[0].combinedScore).toBe(0.5);
    expect(out[1].combinedScore).toBe(0.5);
    expect(out[0].scores.eventDecay).toBeUndefined();
  });

  test('weight>0 时老事件被压低、相对顺序翻转生效', () => {
    const items = [
      { id: 'old', combinedScore: 1.0, updatedAt: NOW - 60 * DAY, scores: {} },
      { id: 'new', combinedScore: 0.9, updatedAt: NOW, scores: {} },
    ];
    applyEventTimeDecay(items, { weight: 1, halfLifeDays: 14, floor: 0.05, now: NOW });
    expect(items[0].scores.eventDecay).toBeLessThan(0.2);
    expect(items[1].scores.eventDecay).toBeGreaterThan(0.99);
    expect(items[0].combinedScore).toBeLessThan(items[1].combinedScore); // 排序翻转
  });
});

describe('recall-exclusion（目录级排除 + 会话冷却）', () => {
  test('子树匹配：排除目录连带子树，兄弟目录不受影响', () => {
    expect(uriMatchesPattern('kb/finance', 'kb/finance')).toBe(true);
    expect(uriMatchesPattern('kb/finance/2026/q3', 'kb/finance')).toBe(true);
    expect(uriMatchesPattern('kb/finances', 'kb/finance')).toBe(false); // 前缀≠子树
    expect(uriMatchesPattern('kb/hr/staff', 'kb/finance')).toBe(false);
    expect(uriMatchesPattern('kb/finance/2026/q3', 'kb/finance/2026*')).toBe(true); // 通配尾部
    expect(normalizeUri('kb/finance/')).toBe('kb/finance');
  });

  test('filterExcludedUris 返回 kept/excluded 及排除原因', () => {
    const results = [
      { id: 1, uri: 'kb/finance/a' },
      { id: 2, uri: 'kb/hr/b' },
      { id: 3, path: 'kb/finance/c' }, // path 字段兼容
    ];
    const { kept, excluded } = filterExcludedUris(results, ['kb/finance']);
    expect(kept.map((r) => r.id)).toEqual([2]);
    expect(excluded).toHaveLength(2);
    expect(excluded[0].reason).toBe('exclude_uris:kb/finance');
  });

  test('SessionRecallLedger：冷却期内不再召回，过期自动放行', () => {
    const ledger = new SessionRecallLedger({ cooldownMs: 1000 });
    ledger.markServed('kb/a', NOW);
    expect(ledger.isCooled('kb/a', NOW + 500)).toBe(true);
    expect(ledger.isCooled('kb/a', NOW + 1500)).toBe(false);
    expect(ledger.isCooled('kb/b', NOW)).toBe(false);
  });

  test('applyRecallExclusion 一站式：子树排除 + 冷却双闸', () => {
    const ledger = new SessionRecallLedger({ cooldownMs: 60_000 });
    ledger.markServed('kb/served', NOW);
    const results = [
      { id: 1, uri: 'kb/served' },
      { id: 2, uri: 'kb/excluded-dir/x' },
      { id: 3, uri: 'kb/fresh' },
    ];
    const { kept, excluded } = applyRecallExclusion(results, {
      excludeUris: ['kb/excluded-dir'],
      ledger,
      now: NOW,
    });
    expect(kept.map((r) => r.id)).toEqual([3]);
    expect(excluded.map((e) => e.reason[0])).toEqual(['e', 's']); // exclude_uris 与 session_cool 各一条
  });

  test('markServed 刷新 LRU 顺序 + 容量上限淘汰', () => {
    const ledger = new SessionRecallLedger({ maxEntries: 2 });
    ledger.markServed('a'); ledger.markServed('b'); ledger.markServed('a'); // a 刷新
    ledger.markServed('c'); // 淘汰最旧的 b
    expect(ledger.size).toBe(2);
    expect(ledger.toJSON().served.map(([u]) => u)).toEqual(['a', 'c']);
  });
});

describe('layered-summary（分层摘要 abstract/overview）', () => {
  const longText =
    '这是一个很长的中文句子，讲述第一件事。这是第二个句子，讲述第二件事！第三个句子讲述第三件事？第四句继续补充细节，内容较长需要压缩。' +
    '第五句用于凑长度，让总长超过两百字的摘要预算上限，从而触发按句累加的抽取式摘要路径并验证省略号截断行为是否正确，这一点很重要。';

  test('splitSentences 中英文终止符均可切分', () => {
    const parts = splitSentences('第一句。第二句！Third. 第四句？');
    expect(parts).toEqual(['第一句。', '第二句！', 'Third.', '第四句？']);
  });

  test('buildAbstract：预算内逐句抽取，不超预算；短文原样返回', () => {
    const abs = buildAbstract(longText, { maxChars: 60 });
    expect(abs.length).toBeLessThanOrEqual(60);
    expect(abs.startsWith('这是一个很长的中文句子')).toBe(true);
    expect(buildAbstract('短文', { maxChars: 60 })).toBe('短文');
  });

  test('buildOverview：子项聚合去重 + 预算；空子项回退 abstract', () => {
    const ov = buildOverview('母级内容', ['子摘要甲，关于A。', '子摘要乙，关于B。', '子摘要甲，关于A。'], { maxChars: 100 });
    expect(ov).toContain('子摘要甲');
    expect(ov).toContain('子摘要乙');
    expect(ov.match(/子摘要甲/g)).toHaveLength(1); // 去重生效
    expect(buildOverview('回退内容', [], { maxChars: 50 })).toBe('回退内容');
  });

  test('pickLayer 按预算选层：全文→overview→abstract 逐级降层', () => {
    const item = { content: 'x'.repeat(300), overview: 'o'.repeat(80), abstract: 'a'.repeat(30) };
    expect(pickLayer(item, { budgetChars: 1000 }).layer).toBe('full');
    expect(pickLayer(item, { budgetChars: 100 }).layer).toBe('overview');
    expect(pickLayer(item, { budgetChars: 50 }).layer).toBe('abstract');
  });

  test('applyLayeredSummary：写入 injectedText 且不改写 content（原文保留可下钻）', () => {
    const items = [{ id: 1, content: longText }];
    applyLayeredSummary(items, { depth: 'abstract', abstractChars: 50 });
    expect(items[0].summaryLayer).toBe('abstract');
    expect(items[0].injectedText.length).toBeLessThanOrEqual(50);
    expect(items[0].content).toBe(longText); // 原文未动
    // full 深度完全旁路：新条目不产生注入层字段
    const untouched = [{ id: 2, content: longText }];
    applyLayeredSummary(untouched, { depth: 'full' });
    expect(untouched[0].summaryLayer).toBeUndefined();
    expect(untouched[0].injectedText).toBeUndefined();
  });
});

describe('hybrid-retrieval._postProcess 接线（默认旁路零回归）', () => {
  function makeEngine(config = {}) {
    return new HybridRetrievalEngine(config);
  }

  test('无任何新配置时行为与旧版完全一致', () => {
    const engine = makeEngine();
    const items = [{ id: 1, combinedScore: 0.5, scores: {}, content: 'c' }];
    const out = engine._postProcess(items, {}, 'default');
    expect(out).toEqual(items);
    expect(out[0].injectedText).toBeUndefined();
  });

  test('eventDecay 配置启用后老事件降分、新事件保持', () => {
    const engine = makeEngine({ eventDecay: { weight: 1, halfLifeDays: 14, floor: 0.05 } });
    const DAY = 86400000;
    const items = [
      { id: 'old', combinedScore: 1.0, updatedAt: Date.now() - 60 * DAY, scores: {} },
      { id: 'new', combinedScore: 0.9, updatedAt: Date.now(), scores: {} },
    ];
    engine._postProcess(items, {});
    expect(items[0].combinedScore).toBeLessThan(items[1].combinedScore);
  });

  test('sessionLedger 冷却 + 服务回写闭环', () => {
    const engine = makeEngine();
    const ledger = new SessionRecallLedger({ cooldownMs: 60_000 });
    const items = [
      { id: 1, uri: 'kb/first', combinedScore: 0.9, scores: {} },
      { id: 2, uri: 'kb/second', combinedScore: 0.8, scores: {} },
    ];
    const out1 = engine._postProcess(items, { sessionLedger: ledger });
    expect(out1).toHaveLength(2);
    expect(ledger.size).toBe(2); // 服务后回写账本
    // 同会话第二次检索：全部冷却，被剔除
    const out2 = engine._postProcess(
      [{ id: 1, uri: 'kb/first', combinedScore: 0.9, scores: {} }],
      { sessionLedger: ledger }
    );
    expect(out2).toHaveLength(0);
  });

  test('summaryDepth=abstract 时注入层与原文并存', () => {
    const engine = makeEngine();
    const items = [{ id: 1, content: '句子一。句子二。'.repeat(20), combinedScore: 0.9, scores: {} }];
    const out = engine._postProcess(items, { summaryDepth: 'abstract', summaryBudgetChars: 40 });
    expect(out[0].summaryLayer).toBe('abstract');
    expect(out[0].injectedText.length).toBeLessThanOrEqual(40);
    expect(out[0].content.length).toBe(160); // 原文保留
  });
});
