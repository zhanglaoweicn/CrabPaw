/**
 * filename-utils.test.js — 产物文件名统一清洗（2026-08-22）
 * 锁定：V8 字符类 `_-一` 相邻解析陷阱（中文全变下划线）不再复现，
 * 命名保留中文可读、压缩分隔符、非法字符安全。
 */
const { sanitizeFilename } = require('../core/filename-utils');

describe('sanitizeFilename', () => {
  test('中文 + 空格 + 括号 → 可读文件名（回归：全下划线灾难）', () => {
    const out = sanitizeFilename('智能体的 Harness 插件（给 AI 套上缰绳）');
    // 中文全保留，空格→_，括号删，无连串下划线
    expect(out).toBe('智能体的_Harness_插件_给_AI_套上缰绳');
    expect(out).not.toContain('__');
  });

  test('旧规则对比：中文不再被吞成下划线', () => {
    // 旧规则 [^a-zA-Z0-9_-一-鿿] 输出: _____Harness______AI______
    expect(sanitizeFilename('智能体 Harness AI')).toBe('智能体_Harness_AI');
    expect(sanitizeFilename('智能体 Harness AI')).not.toBe('______Harness___AI');
  });

  test('非法字符删除 / 符号安全', () => {
    // <>:"/\|?* 是路径/Windows 非法字符 → 直接删除（不留分隔符）
    expect(sanitizeFilename('a<b>:c"d/e\\f|g?h*i')).toBe('abcdefghi');
    expect(sanitizeFilename('a <b> c')).toBe('a_b_c');
  });

  test('空白压缩 + 去两端分隔符', () => {
    expect(sanitizeFilename('  多  个  空  白  ')).toBe('多_个_空_白');
    expect(sanitizeFilename('__前导__')).toBe('前导');
  });

  test('截断 60 字符且不截断中间产生残字符', () => {
    const long = '标题'.repeat(40);
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(60);
  });

  test('空/缺省 → fallback', () => {
    expect(sanitizeFilename('')).toBe('document');
    expect(sanitizeFilename(undefined)).toBe('document');
    expect(sanitizeFilename('   ')).toBe('document');
    expect(sanitizeFilename(null, 'page')).toBe('page');
  });

  test('全角/半角数字字母保留', () => {
    expect(sanitizeFilename('报告 V2.0 终版')).toBe('报告_V2.0_终版');
  });
});
