/**
 * data-sources-registry.test.js — 数据源注册表（Phase 3b）
 */
const {
  registerSource, getSource, listSources, fetchFromSource, installBuiltinSources,
} = require('../core/data-sources/registry');

describe('data-sources registry（卡片数据解耦）', () => {
  test('注册/查表/取数委托', async () => {
    const r = registerSource({ name: 'test-x', fetch: async (p) => ({ got: p }) });
    expect(r.ok).toBe(true);
    expect(getSource('test-x')).not.toBeNull();
    expect(await fetchFromSource('test-x', { a: 1 })).toEqual({ got: { a: 1 } });
  });

  test('重名拒绝 / 缺字段拒绝', () => {
    expect(registerSource({ name: 'test-x', fetch: async () => null }).ok).toBe(false);
    expect(registerSource({ name: 'no-fn' }).ok).toBe(false);
    expect(registerSource({ fetch: async () => null }).ok).toBe(false);
  });

  test('未注册源 → 可读错误（调用方降级）', async () => {
    await expect(fetchFromSource('nope')).rejects.toThrow('数据源未注册');
  });

  test('内置源安装（委托现有实现, 零改写）', () => {
    const results = installBuiltinSources();
    const byName = Object.fromEntries(results.map((r) => [r.name, r.ok]));
    expect(byName).toMatchObject({ stock: true, typhoon: true, weather: true });
    // 2026-08-26: 内置源已扩至 5 个(business 经营数据/commodity 商品查询)——断言按真实源清单
    expect(listSources().map((s) => s.name).sort()).toEqual(
      ['business', 'commodity', 'stock', 'test-x', 'typhoon', 'weather']);
  });
});
