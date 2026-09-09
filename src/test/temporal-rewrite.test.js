/**
 * temporal-rewrite.test.js — 时间意图抽取与查询改写（semantica TemporalQueryRewriter 范式）
 * 测试用固定 now 消除相对时间漂移。
 */
const { rewriteTemporal, resolveTemporalPhrase } = require('../core/memory/temporal-rewrite');

const NOW = new Date(2026, 7, 25, 12, 0, 0); // 2026-08-25 12:00（本地）
const ms = (y, mo, d, h = 0) => new Date(y, mo, d, h).getTime();

describe('resolveTemporalPhrase 确定性解析', () => {
  test('年/年月/季度', () => {
    expect(resolveTemporalPhrase('2022').start.getTime()).toBe(ms(2022, 0, 1));
    expect(resolveTemporalPhrase('2022年').end.getTime()).toBe(ms(2023, 0, 1));
    expect(resolveTemporalPhrase('2022-06').start.getTime()).toBe(ms(2022, 5, 1));
    const q1 = resolveTemporalPhrase('Q2 2022');
    expect(q1.start.getTime()).toBe(ms(2022, 3, 1));
    expect(q1.end.getTime()).toBe(ms(2022, 6, 1));
    expect(resolveTemporalPhrase('2022 年第 3 季度').start.getTime()).toBe(ms(2022, 6, 1));
    expect(resolveTemporalPhrase('2022年第二季度').end.getTime()).toBe(ms(2022, 6, 1)); // Q2 止于 7-01
  });

  test('中文相对词与 time-parser 兜底', () => {
    // 2026-08-27: 全部相对词调用显式传 NOW——此前漏传, resolveTemporalPhrase 落真实系统时钟,
    // 日锚点("上个月")随系统日期漂移恒红(非 25 号运行日)。修正后确定性回归设计意图。
    expect(resolveTemporalPhrase('今年', NOW).start.getTime()).toBe(ms(2026, 0, 1));
    expect(resolveTemporalPhrase('本季度', NOW).start.getTime()).toBe(ms(2026, 6, 1)); // Q3
    // 上个月经 time-parser 为日锚点（2026-08-25 − 1 月 = 2026-07-25，确定性，同 semantica 参考日期语义）
    expect(resolveTemporalPhrase('上个月', NOW).start.getTime()).toBe(ms(2026, 6, 25));
  });

  test('英文月+年', () => {
    expect(resolveTemporalPhrase('June 2020').start.getTime()).toBe(ms(2020, 5, 1));
    expect(resolveTemporalPhrase('June 2020').end.getTime()).toBe(ms(2020, 6, 1));
  });

  test('无法解析/歧义 → null（不猜）', () => {
    expect(resolveTemporalPhrase('会议')).toBeNull();
    expect(resolveTemporalPhrase('')).toBeNull();
  });
});

describe('rewriteTemporal 意图抽取与改写', () => {
  test('截至/截止到 + 日期 → before + atTime=区间起点（带尾随文本 → 置信 0.75）', () => {
    const r = rewriteTemporal('截至 2023-06-01 的台风路径', { now: NOW });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('before');
    expect(r.atTime).toBe(ms(2023, 5, 1));
    expect(r.confidence).toBe(0.75);
    expect(r.rewrittenQuery).toBe('的台风路径');
    expect(r.phrase).toBe('2023-06-01');
  });

  test('粘连文本（截至2023-06-01的台风）→ 由右端截断解析，置信 0.75', () => {
    const r = rewriteTemporal('截至2023-06-01的台风', { now: NOW });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('before');
    expect(r.atTime).toBe(ms(2023, 5, 1));
    expect(r.confidence).toBe(0.75);
    expect(r.rewrittenQuery).toBe('的台风');
  });

  test('2022 年 Q2 期间 → during + 双端', () => {
    const r = rewriteTemporal('在 2022 年 Q2 期间开的会', { now: NOW });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('during');
    expect(r.startTime).toBe(ms(2022, 3, 1));
    expect(r.endTime).toBe(ms(2022, 6, 1));
    expect(r.confidence).toBe(0.85);
    expect(r.rewrittenQuery).toBe('开的会');
  });

  test('X 之后 → after', () => {
    const r = rewriteTemporal('2021-07-15 之后发生了什么', { now: NOW });
    expect(r.intent).toBe('after');
    expect(r.atTime).toBe(ms(2021, 6, 15));
    expect(r.rewrittenQuery).toBe('发生了什么');
  });

  test('X 和 Y 之间 → between 双端', () => {
    const r = rewriteTemporal('2020年5月和2020年6月之间有多少会议', { now: NOW });
    expect(r.intent).toBe('between');
    expect(r.startTime).toBe(ms(2020, 4, 1));
    expect(r.endTime).toBe(ms(2020, 5, 1));
    expect(r.rewrittenQuery).toBe('有多少会议');
  });

  test('bare 季度锚（Q2 2022 的会议）→ 无意图词命中为 during', () => {
    const r = rewriteTemporal('Q2 2022 的会议', { now: NOW });
    expect(r.matched).toBe(true);
    expect(r.intent).toBe('during');
    expect(r.startTime).toBe(ms(2022, 3, 1));
    expect(r.endTime).toBe(ms(2022, 6, 1));
    expect(r.confidence).toBe(0.7);
    expect(r.rewrittenQuery).toBe('的会议');
  });

  test('去年/明年类相对词经 time-parser 解析', () => {
    const r = rewriteTemporal('去年发生了什么', { now: NOW });
    expect(r.matched).toBe(true);
    expect(r.rewrittenQuery).toBe('发生了什么');
    expect(r.atTime).toBe(ms(2025, 0, 1));
  });

  test('英文 before/after', () => {
    const r = rewriteTemporal('before 2021-05-01 meetings', { now: NOW });
    expect(r.intent).toBe('before');
    expect(r.atTime).toBe(ms(2021, 4, 1));
  });

  test('无时间意图 → matched:false，不改写', () => {
    const r = rewriteTemporal('台风路径', { now: NOW });
    expect(r.matched).toBe(false);
    expect(r.rewrittenQuery).toBe('台风路径');
    expect(r.intent).toBeNull();
    expect(r.atTime).toBeNull();
    expect(r.confidence).toBe(0);
  });

  test('解析不了的短语（会议之前）→ 不猜，matched:false', () => {
    const r = rewriteTemporal('会议之前', { now: NOW });
    expect(r.matched).toBe(false);
  });

  test('空查询 → matched:false', () => {
    expect(rewriteTemporal('', { now: NOW }).matched).toBe(false);
    expect(rewriteTemporal(null, { now: NOW }).matched).toBe(false);
  });
});
