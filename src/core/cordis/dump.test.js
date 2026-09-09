/**
 * dump 单元测试——装配可寻址（P0-②）
 * 合成树喂入，不触发任何真实服务单例。
 */
const { formatHarnessDump } = require('./dump');

describe('formatHarnessDump 装配面寻址', () => {
  const FIXED_NOW = new Date('2026-09-03T00:00:00Z');

  it('完整树: services/guardPlugins/businessPlugins 计数与内容一致, profile 缺省 boss', () => {
    const tree = {
      inventory: {
        services: ['tools', 'config'],
        guardPlugins: [{ id: 'harness-budget', name: '预算执行', protected: true }],
        plugins: [{ id: 'biz-1', contributes: 3 }],
        bridge: true,
      },
    };
    const dump = formatHarnessDump(tree, FIXED_NOW);
    expect(dump.counts).toEqual({ services: 2, guardPlugins: 1, businessPlugins: 1 });
    expect(dump.services).toEqual(['tools', 'config']);
    expect(dump.guardPlugins[0].protected).toBe(true);
    expect(dump.businessPlugins[0].id).toBe('biz-1');
    expect(dump.eventBridge).toBe('bidirectional-mirror');
    expect(dump.profile).toBe('boss');
    expect(dump.generatedAt).toBe(FIXED_NOW.toISOString());
  });

  it('profile 透传: inventory.profile 原样进入装配面', () => {
    const dump = formatHarnessDump({ inventory: { profile: 'minimal', services: [], guardPlugins: [], plugins: [] } }, FIXED_NOW);
    expect(dump.profile).toBe('minimal');
    expect(dump.counts.services).toBe(0);
  });

  it.each([null, undefined, {}, { inventory: {} }])('空树(%p): 零计数且桥未安装, 不抛异常', (tree) => {
    const dump = formatHarnessDump(tree, FIXED_NOW);
    expect(dump.counts).toEqual({ services: 0, guardPlugins: 0, businessPlugins: 0 });
    expect(dump.services).toEqual([]);
    expect(dump.eventBridge).toBe('not-installed');
  });
});
