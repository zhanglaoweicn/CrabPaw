/**
 * boot 单元测试——P2-② disposer + P2-③ 装配 profile（2026-09-03）
 * minimal profile 不拉起核心服务（轻量树），测试聚焦装配面与可逆性。
 */
const {
  createHarnessTree,
  installHarnessTree,
  getHarnessTree,
  disposeHarnessTree,
  PROFILES,
} = require('./boot');
const { getHarnessContext } = require('./context');
const { auditHarnessTree } = require('./audit');

describe('harness tree: profile / 装配 / 可逆', () => {
  it('PROFILES 定义: boss 全量(6 制度壳), minimal 精简(0 服务 0 壳, 桥保留)', () => {
    expect(PROFILES.boss.coreServices).toBe(true);
    expect(PROFILES.boss.guards).toHaveLength(6);
    expect(PROFILES.boss.installs).toBe(true);
    expect(PROFILES.minimal.coreServices).toBe(false);
    expect(PROFILES.minimal.guards).toHaveLength(0);
    expect(PROFILES.minimal.installs).toBe(false);
    expect(PROFILES.minimal.bridge).toBe(true);
  });

  it('未知 profile 构造期即抛错', async () => {
    await expect(createHarnessTree({ profile: 'nope' })).rejects.toThrow(/未知装配 profile/);
  });

  it('minimal 树: 无服务无制度壳、桥已装、audit 按 profile 期望绿', async () => {
    const tree = await createHarnessTree({ profile: 'minimal' });
    expect(tree.inventory.profile).toBe('minimal');
    expect(tree.inventory.services).toEqual([]);
    expect(tree.inventory.guardPlugins).toEqual([]);
    expect(tree.inventory.bridge).toBe(true);
    const audit = auditHarnessTree(tree);
    expect(audit.ok).toBe(true);
    expect(audit.profile).toBe('minimal');
  });

  it('dispose 往返: 单例与上下文面清空, 事件桥随树卸载, 可重建(注册即可逆)', async () => {
    const tree = installHarnessTree(await createHarnessTree({ profile: 'minimal' }));
    expect(getHarnessTree()).toBe(tree);
    expect(getHarnessContext()).toBe(tree);

    const result = await disposeHarnessTree();
    expect(result).toMatchObject({ profile: 'minimal' });
    expect(getHarnessTree()).toBeNull();
    expect(getHarnessContext()).toBeNull();

    // 重建后功能等价（第二次装配仍是合法 minimal 树）
    const again = installHarnessTree(await createHarnessTree({ profile: 'minimal' }));
    expect(getHarnessTree()).toBe(again);
    expect(again.inventory.bridge).toBe(true);
    expect(auditHarnessTree(again).ok).toBe(true);

    await disposeHarnessTree();
    expect(getHarnessTree()).toBeNull();
  });
});
