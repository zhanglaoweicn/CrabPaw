'use strict';
/**
 * cordis-audit.test.js — B1-4 空壳真点名（2026-08-27）
 *
 * 语义约定:
 *  - 「空壳」点名只针对业务插件面（inventory.plugins / tree.plugins）: 每插件一条贡献记录,
 *    0 条贡献 = 空壳; 贡献条目数 = Object.values(contributes).filter(Boolean).length。
 *  - 制度薄壳（guardPlugins 6 个, 如 harness-contracts）是制度登记面, 不属于业务插件面,
 *    绝不因 0 贡献被点名成空壳。
 *  - 业务插件面为空数组（当前树的真实状态——业务插件走 plugin-manager 不经过树）时,
 *    空壳 0 成立且 ok=true: 诚实起点, 不再伪报。
 */
const { auditHarnessTree } = require('../core/cordis/audit');

const ALL_SERVICES = ['tools', 'eventBus', 'serviceRegistry', 'config', 'mcp', 'scheduler', 'pluginManager', 'logger'];

/** 模拟真实树: 8 服务面 + 6 制度薄壳(guardPlugins) + 业务插件面(inventory.plugins) */
function makeTree() {
  return {
    inventory: {
      services: [...ALL_SERVICES],
      guardPlugins: Array.from({ length: 6 }, (_, i) => ({ id: `guard-${i}`, name: `g${i}`, protected: true })),
      plugins: [],
    },
    ctx: {},
  };
}

/** 让 8 个服务全部可解析 */
function wireCtx(tree) {
  for (const name of tree.inventory.services) tree.ctx[name] = {};
}

describe('auditHarnessTree 空壳点名', () => {
  test('空壳插件被点名(不再伪报空壳0)', () => {
    const tree = makeTree();
    tree.inventory.plugins = [
      { id: 'empty-a' },
      { id: 'empty-b' },
      { id: 'real', contributes: { tools: [{ name: 't' }] } },
    ];
    wireCtx(tree);
    const r = auditHarnessTree(tree);
    expect(r.ok).toBe(false);
    expect(r.problems.join('; ')).toContain('空壳: empty-a,empty-b');
    expect(r.summary).not.toContain('空壳0 ✓');
  });

  test('无空壳时 ok(业务插件面为空数组 = 当前树真实状态)', () => {
    const tree = makeTree();
    wireCtx(tree);
    const r = auditHarnessTree(tree);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('空壳0 ✓');
  });

  test('制度薄壳(guardPlugins)不被当业务空壳点名', () => {
    const tree = makeTree();
    wireCtx(tree);
    const r = auditHarnessTree(tree);
    expect(r.problems.join('; ')).not.toContain('空壳');
  });

  test('贡献条目数为 0(contributes 全空值)仍判空壳', () => {
    const tree = makeTree();
    tree.inventory.plugins = [{ id: 'empty-c', contributes: { tools: null, mcp: undefined } }];
    wireCtx(tree);
    const r = auditHarnessTree(tree);
    expect(r.ok).toBe(false);
    expect(r.problems.join('; ')).toContain('空壳: empty-c');
  });

  test('旧树路径无 plugins 面(undefined)时不误报', () => {
    const tree = makeTree();
    delete tree.inventory.plugins;
    wireCtx(tree);
    const r = auditHarnessTree(tree);
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
  });
});
