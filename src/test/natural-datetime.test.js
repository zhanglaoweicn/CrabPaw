/**
 * natural-datetime 统一解析器测试（R3）
 * 用例来源：三套旧解析器的既有能力并集 + 歧义诚实化。
 */
const { parseNaturalDateTime, parseNaturalEvent } = require('../schedule/utils/natural-datetime');

// 固定 now（周四 2026-09-03 10:00 本地）保证断言稳定
const NOW = new Date(2026, 8, 3, 10, 0, 0);

describe('parseNaturalDateTime（纯日期时刻）', () => {
  test('今天/明天/后天/大后天 + 时刻', () => {
    expect(parseNaturalDateTime('今天15:30', NOW)).toEqual({ date: '2026-09-03', time: '15:30', ambiguous: false });
    expect(parseNaturalDateTime('明天上午10点', NOW)).toEqual({ date: '2026-09-04', time: '10:00', ambiguous: false });
    expect(parseNaturalDateTime('大后天晚上八点半', NOW)).toEqual({ date: '2026-09-06', time: '20:30', ambiguous: false });
  });

  test('下周X / 周X', () => {
    const r = parseNaturalDateTime('下周三下午两点', NOW);
    expect(r.ambiguous).toBe(false);
    expect(r.time).toBe('14:00');
    expect(r.date).toBe('2026-09-09'); // 2026-09-03 是周四 → 下周三 = 09-09
  });

  test('裸 HH:mm（今天或明天）与 ISO', () => {
    expect(parseNaturalDateTime('23:30', NOW)).toEqual({ date: '2026-09-03', time: '23:30', ambiguous: false });
    expect(parseNaturalDateTime('2026-10-01T09:00', NOW)).toEqual({ date: '2026-10-01', time: '09:00', ambiguous: false });
  });

  test('无法解析 → ambiguous + 原因（不再半猜）', () => {
    const r = parseNaturalDateTime('改天再说', NOW);
    expect(r.ambiguous).toBe(true);
    expect(r.reason).toBeTruthy();
  });
});

describe('parseNaturalEvent（事件形态，含 title/duration）', () => {
  test('完整句解析保留 title/duration 并带 ambiguous 标记', () => {
    const r = parseNaturalEvent('明天下午3点开周会一小时', NOW);
    expect(r.ambiguous).toBe(false);
    expect(r.time).toBe('15:00');
    expect(r.date).toBe('2026-09-04');
    expect(String(r.title || '')).toContain('周会');
  });

  test('解析不出日期 → ambiguous=true', () => {
    expect(parseNaturalEvent('随便开个会', NOW).ambiguous).toBe(true);
  });

  test('ISO 片段（空格/T 分隔）→ 显式日期不误判歧义', () => {
    expect(parseNaturalEvent('2026-08-20 10:30', NOW)).toMatchObject({ date: '2026-08-20', time: '10:30', ambiguous: false });
    expect(parseNaturalEvent('2026-10-01T09:00', NOW)).toMatchObject({ date: '2026-10-01', time: '09:00', ambiguous: false });
  });

  test('裸时刻（无日期）→ ambiguous（缺关键信息走预填）', () => {
    expect(parseNaturalEvent('15:30', NOW).ambiguous).toBe(true);
  });
});
