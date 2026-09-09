/**
 * plugin-manifest-inject.test.js — B2-2 manifest inject/provides 契约校验
 *
 * 契约口径: inject/provides 必须为字符串数组; 非数组/含非字符串 → validation error
 * （与 SDK assertPluginContract 对齐——契约违反是错误而非告警）
 */

const { validateManifest } = require('../core/plugin/manifest');

describe('manifest inject/provides 校验', () => {
  const base = () => ({ name: 'demo-plugin', version: '1.0.0' });

  test('合法字符串数组 → valid', () => {
    expect(validateManifest({ ...base(), inject: ['db'], provides: ['svc'] }).valid).toBe(true);
  });

  test('缺省/空数组 → valid', () => {
    expect(validateManifest(base()).valid).toBe(true);
    expect(validateManifest({ ...base(), inject: [], provides: [] }).valid).toBe(true);
  });

  test('inject 非数组 → error(非 warning)', () => {
    const r = validateManifest({ ...base(), inject: 'db' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('inject'))).toBe(true);
  });

  test('provides 数组含非字符串 → error', () => {
    const r = validateManifest({ ...base(), provides: [42] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('provides'))).toBe(true);
  });
});
