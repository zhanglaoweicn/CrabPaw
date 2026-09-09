/**
 * pilot-harness-boot.js — Phase 1 P1-b 冒烟：建树 → 服务/制度插件齐 → dispose
 * 用法: node scripts/pilot-harness-boot.js
 */
const { createHarnessTree } = require('../src/core/cordis/boot');

async function main() {
  const ok = [];
  const assert = (cond, name) => {
    if (!cond) throw new Error(`PILOT FAIL: ${name}`);
    ok.push(name);
  };

  const tree = await createHarnessTree();

  // 服务面（应有 8+：tools/eventBus/serviceRegistry/config/mcp/scheduler/pluginManager/logger）
  const SERVICE_MIN = ['tools', 'eventBus', 'serviceRegistry', 'config', 'mcp', 'scheduler', 'pluginManager', 'logger'];
  for (const s of SERVICE_MIN) {
    assert(tree.inventory.services.includes(s), `服务已挂载: ${s}`);
    assert(tree.ctx[s] !== undefined, `ctx.${s} 可解析`);
  }
  // 事件桥已装(inventory.bridge)
  assert(tree.inventory.bridge === true, '事件同步镜像桥已安装');
  // 制度插件 6 个且 protected
  assert(tree.inventory.guardPlugins.length === 6, '6 个制度插件登记');
  assert(tree.inventory.guardPlugins.every(g => g.protected), '全部 protected');
  // 服务引用=现有单例（引用即真理）验证: tools 与工具注册表同一对象
  const { registry } = require('../src/tools/registry');
  assert(tree.ctx.tools === registry, 'tools 服务 === 现有注册表单例');

  // 释放（await 保证 disposer 逆序完成）
  tree.fiber.dispose();

  console.log(`✅ PILOT PASS: ${ok.length} 项（${ok.join(' / ')}）`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
