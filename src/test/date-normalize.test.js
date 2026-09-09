/**
 * date-normalize 单元测试 — 业务表日期单元格规范化
 */
const { normalizeDateValue, detectDateColumn } = require('../core/business/date-normalize');

describe('normalizeDateValue', () => {
  test.each([
    ['2024-01-15', '2024-01-15'],
    ['2024/1/5', '2024-01-05'],
    ['2024.01.15', '2024-01-15'],
    ['2024年1月15日', '2024-01-15'],
    ['20240115', '2024-01-15'],
    ['2024-01-15 08:30', '2024-01-15 08:30:00'],
    ['2024/1/5 9:05:21', '2024-01-05 09:05:21'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeDateValue(raw)).toBe(expected);
  });

  test('缺年格式用 defaultYear 补齐', () => {
    expect(normalizeDateValue('1月15日', { defaultYear: 2024 })).toBe('2024-01-15');
    expect(normalizeDateValue('12月3号', { defaultYear: 2025 })).toBe('2025-12-03');
  });

  test('非法输入返回 null 不抛错', () => {
    expect(normalizeDateValue(null)).toBeNull();
    expect(normalizeDateValue('')).toBeNull();
    expect(normalizeDateValue('  ')).toBeNull();
    expect(normalizeDateValue('N/A')).toBeNull();
    expect(normalizeDateValue('2024年13月40日')).toBeNull();
    expect(normalizeDateValue('2024-01-15 25:00')).toBeNull();
    expect(normalizeDateValue('螺丝')).toBeNull();
  });
});

describe('detectDateColumn', () => {
  test('斜杠格式列判定为日期列并给默认年', () => {
    const r = detectDateColumn(['2024/01/15', '2024/02/20', '2024/03/08']);
    expect(r.isDateColumn).toBe(true);
    expect(r.defaultYear).toBe(2024);
    expect(r.parseFailed).toBe(0);
  });

  test('中文年月日列可判定', () => {
    const r = detectDateColumn(['2024年1月15日', '2024年2月20日', '2024年3月8日']);
    expect(r.isDateColumn).toBe(true);
    expect(r.defaultYear).toBe(2024);
  });

  test('缺年列用众数年份（混入行带年份时）', () => {
    const r = detectDateColumn(['1月15日', '2023/06/01', '2月20日']);
    expect(r.isDateColumn).toBe(true);
    expect(r.defaultYear).toBe(2023);
  });

  test('纯缺年列回退当前年份', () => {
    const r = detectDateColumn(['1月15日', '2月20日']);
    expect(r.isDateColumn).toBe(true);
    expect(r.defaultYear).toBe(new Date().getFullYear());
  });

  test('普通文本列不误判', () => {
    const r = detectDateColumn(['杭州标准件厂', '宁波铝业', '螺丝']);
    expect(r.isDateColumn).toBe(false);
  });

  test('低于阈值不判定', () => {
    const r = detectDateColumn(['2024/01/15', '螺丝', '铝板', '铁钉', '螺母']);
    expect(r.isDateColumn).toBe(false);
  });

  test('空列不判定', () => {
    const r = detectDateColumn([]);
    expect(r.isDateColumn).toBe(false);
  });
});
