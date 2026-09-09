/**
 * pilot-cordis.js — Cordis 落地冒烟（Phase 0 pilot seam）— 2026-08-25
 *
 * 验证链（已全部实测）：
 * 1. vendor/cordis(CJS) 可加载；new Context() 建树；
 * 2. provide('tools') 服务挂树，插件 apply 内注册工具（现有 ToolRegistry 零改动进树）；
 * 3. await ctx.plugin() 激活；ctx.on 订阅事件；ctx.effect 声明可逆清理；
 * 4. await fiber.dispose()：事件订阅自动移除 + disposer 逆序执行；
 *    工具注册物按既有契约由 unregisterBySource 显式回收（S1 语义，非树自动）。
 *
 * 用法: node scripts/pilot-cordis.js（先跑 scripts/build-vendor-cordis.js）
 */
const { Context } = require('../vendor/cordis/dist/cordis.cjs');

async function main() {
  const ok = [];
  const assert = (cond, name) => {
    if (!cond) throw new Error(`PILOT FAIL: ${name}`);
    ok.push(name);
  };

  const ctx = new Context();
  assert(typeof ctx.plugin === 'function', 'context.plugin 可用');

  const { registry } = require('../src/tools/registry');
  ctx.provide('tools', registry);
  assert(ctx.tools === registry, 'tools 服务解析到现有注册表单例');

  const events = [];
  const plugin = (c) => {
    c.tools.register({
      name: 'PilotTool', handler: () => 'pong',
      description: 'pilot 冒烟工具', isReadOnly: true,
      source: 'pilot', // S1 契约：所有注册带来源，可反注册
    });
    c.effect(() => () => events.push('disposed'), 'demo-disposer');
    c.on('pilot:test', (payload) => events.push(payload));
  };
  const fiber = await ctx.plugin(plugin);
  assert(registry.has('PilotTool'), '插件注册的工具已激活');

  ctx.events.emit('pilot:test', 'hello');
  assert(events.includes('hello'), '事件订阅生效（ctx.on）');

  await fiber.dispose();
  assert(events.includes('disposed'), 'disposer 逆序执行');
  ctx.events.emit('pilot:test', 'again');
  assert(!events.includes('again'), 'dispose 后事件订阅已移除');

  registry.unregisterBySource('pilot');
  assert(!registry.has('PilotTool'), '工具注册物按契约显式回收');

  console.log(`✅ PILOT PASS: ${ok.length} 项（${ok.join(' / ')}）`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
