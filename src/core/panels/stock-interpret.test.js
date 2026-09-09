/**
 * stock-interpret.test.js — LLM 解读层（2026-08-16）
 * fake chat 注入；验证 LLM 路径 / JSON 解析 / 兜底路径 / rating 归一。
 */
const { generateStockInterpret, fallbackInterpret, parseInterpretJson } = require('./stock-interpret');

// 2026-08-31: finalScore 量纲对齐真实管线 [-1,1]（calculateOverallScore 输出），
// 此前用百分制假数据(62/90/70…)测阈值 → 掩盖了「兜底恒判回避」bug。
const ANALYSIS = {
  quote: { code: '600519', name: '贵州茅台', price: 1500 },
  supportResistance: { support: ['1450', '1400'], resistance: ['1600', '1680'], currentPrice: '1500' },
  overallScore: { finalScore: '0.40' },
  risks: { risks: [{ level: 'HIGH', type: '超买风险', message: 'RSI 超买' }], warnings: [] },
  momentum: { trendStatus: '多头排列' },
};

describe('fallbackInterpret — 规则兜底（LLM 不可用时）', () => {
  test('评分 0.40 → 关注；买卖点取支撑/压力首位', () => {
    const r = fallbackInterpret(ANALYSIS);
    expect(r.source).toBe('fallback');
    expect(r.verdict.rating).toBe('关注');
    expect(r.verdict.buyPoint).toBe(1450);
    expect(r.verdict.sellPoint).toBe(1600);
    expect(r.verdict.position).toBe('20');   // 风险 HIGH → 20%（高风险降仓位）
    expect(r.disclaimer).toContain('AI 解读暂不可用');
  });

  test('无支撑压力 → 买卖点 null（诚实空）', () => {
    const r = fallbackInterpret({ overallScore: { finalScore: '0.90' } });
    expect(r.verdict.buyPoint).toBeNull();
    expect(r.verdict.sellPoint).toBeNull();
    expect(r.verdict.rating).toBe('强烈关注');
  });

  test('支撑/压力首位为空串 → 买卖点 null（Number(\'\')===0 不编造 0）', () => {
    const r = fallbackInterpret({ supportResistance: { support: [''], resistance: [''] } });
    expect(r.verdict.buyPoint).toBeNull();
    expect(r.verdict.sellPoint).toBeNull();
  });

  test('支撑/压力首位为空白串 → 买卖点 null（Number(\'  \')===0 不编造 0）', () => {
    const r = fallbackInterpret({ supportResistance: { support: ['  '], resistance: ['   '] } });
    expect(r.verdict.buyPoint).toBeNull();
    expect(r.verdict.sellPoint).toBeNull();
  });

  test.each([
    ['0.50', '强烈关注'],
    ['0.30', '关注'],
    ['0.29', '中性'],
    ['-0.31', '回避'],   // score < -0.3（严格小于）
    ['-0.15', '中性'],   // 实机回归：负分但 > -0.3 → 中性（旧阈值恒判回避）
  ])('边界 finalScore %s → %s（risks 空 → position 50）', (finalScore, rating) => {
    const r = fallbackInterpret({ overallScore: { finalScore }, risks: { risks: [] } });
    expect(r.verdict.rating).toBe(rating);
    expect(r.verdict.position).toBe('50');
  });

  test('无评分 → 中性', () => {
    expect(fallbackInterpret({}).verdict.rating).toBe('中性');
  });
});

describe('parseInterpretJson — 围栏剥除与非法处理', () => {
  test('纯 JSON', () => {
    expect(parseInterpretJson('{"policy":"p","verdict":{"rating":"关注"}}').verdict.rating).toBe('关注');
  });
  test('```json 围栏', () => {
    expect(parseInterpretJson('```json\n{"policy":"p"}\n```').policy).toBe('p');
  });
  test('非法 → null', () => {
    expect(parseInterpretJson('not json')).toBeNull();
    expect(parseInterpretJson('')).toBeNull();
  });
});

describe('generateStockInterpret — LLM 路径与兜底', () => {
  const fakeChatOk = jest.fn().mockResolvedValue({
    content: JSON.stringify({
      policy: '政策面文本', market: '市场面文本', technical: '技术面文本',
      verdict: { rating: '关注', buyPoint: 1450, sellPoint: 1600, position: '30', riskNote: '注意回调', summary: '综合摘要' },
    }),
  });

  test('LLM 成功 → source=llm + 字段透传 + generatedAt', async () => {
    const r = await generateStockInterpret(ANALYSIS, { chat: fakeChatOk });
    expect(r.source).toBe('llm');
    expect(r.policy).toBe('政策面文本');
    expect(r.verdict.buyPoint).toBe(1450);
    expect(r.verdict.rating).toBe('关注');
    expect(r.generatedAt).toBeTruthy();
    expect(r.disclaimer).toContain('不构成投资建议');
  });

  test('chat 抛错 → 规则兜底 source=fallback', async () => {
    const r = await generateStockInterpret(ANALYSIS, {
      chat: jest.fn().mockRejectedValue(new Error('provider 未配置')),
    });
    expect(r.source).toBe('fallback');
    expect(r.verdict.rating).toBe('关注');   // 兜底映射
  });

  test('LLM 返回非 JSON → 兜底', async () => {
    const r = await generateStockInterpret(ANALYSIS, { chat: jest.fn().mockResolvedValue({ content: '随便说说' }) });
    expect(r.source).toBe('fallback');
  });

  test('LLM 给非法 rating → 归一为兜底映射', async () => {
    const r = await generateStockInterpret(ANALYSIS, {
      chat: jest.fn().mockResolvedValue({ content: JSON.stringify({ policy: '', verdict: { rating: '暴跌警告' } }) }),
    });
    expect(['强烈关注', '关注', '中性', '回避']).toContain(r.verdict.rating);
    expect(r.verdict.rating).toBe('关注');   // 评分 0.40 映射
  });

  test('LLM 显式 buyPoint/sellPoint null → 保留 null（不编造 0、不覆盖兜底值）', async () => {
    const r = await generateStockInterpret(ANALYSIS, {
      chat: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          policy: '', market: '', technical: '',
          verdict: { rating: '中性', buyPoint: null, sellPoint: null, position: '50' },
        }),
      }),
    });
    expect(r.verdict.buyPoint).toBeNull();
    expect(r.verdict.buyPoint).not.toBe(0);
    expect(r.verdict.sellPoint).toBeNull();
  });

  test('超时 → 兜底', async () => {
    const r = await generateStockInterpret(ANALYSIS, {
      chat: () => new Promise(() => {}),  // 永不 resolve
      timeoutMs: 50,
    });
    expect(r.source).toBe('fallback');
  }, 5000);

  test('LLM verdict buyPoint 空白串 → 不 Number 化不编造 0（无兜底值 → null）', async () => {
    const r = await generateStockInterpret({ overallScore: { finalScore: '0.40' } }, {
      chat: jest.fn().mockResolvedValue({
        content: JSON.stringify({
          policy: '', market: '', technical: '',
          verdict: { rating: '中性', buyPoint: '  ', sellPoint: '   ', position: '50' },
        }),
      }),
    });
    expect(r.verdict.buyPoint).toBeNull();
    expect(r.verdict.buyPoint).not.toBe(0);
    expect(r.verdict.sellPoint).toBeNull();
  });
});
