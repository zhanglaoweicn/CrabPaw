/**
 * boot.js — Cordis 树基座（Phase 1 核心交付, 2026-08-25）
 *
 * 定位（V2 主纲 §5 Phase 1 细分——"铺轨不换轨"）：
 *  - 现有启动路径/行为零改动；树 = 服务引用面 + 制度插件登记面 + 审计面；
 *  - 核心服务全部"引用现有单例"（引用即真理, 无副本, 无双真理源）；
 *  - 六个受保护制度插件为薄壳（登记 + 诊断），行为仍由现有模块执行；
 *    标记 protected 供 Phase 2 fail-loud 审计（制度不可摘除）。
 *
 * 用法：createHarnessTree() → { ctx, fiber, inventory }
 *       getHarnessTree() → 全局惰性单例（未创建时 null）
 */
const { Context } = require('../../../vendor/cordis/dist/cordis.cjs');
const { installHarnessEventBridge } = require('./event-bridge');
const { setHarnessContext } = require('./context');

/** 核心服务表：现有单例 → 树服务（懒加载引用, 避免启动期重活） */
const CORE_SERVICES = {
  tools: () => require('../../tools/registry').registry,
  eventBus: () => require('../events').getEventBus(),
  serviceRegistry: () => require('../../services/registry').serviceRegistry,
  config: () => require('../config'),
  mcp: () => require('../mcp/mcp-manager').getMCPManager(),
  scheduler: () => require('../scheduler').getScheduler(),
  pluginManager: () => require('../plugin/index').getPluginManager(),
  logger: () => ({
    log: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
  }),
};

/** 受保护制度插件集（Harness 8 维 → 薄壳; 行为由现有模块执行） */
const GUARD_PLUGINS = [
  { id: 'harness-contracts', name: '工具契约', inject: ['tools'] },
  { id: 'harness-budget', name: '预算执行', inject: [] },
  { id: 'harness-loop', name: '循环防护', inject: [] },
  { id: 'harness-subagent', name: '子代理契约', inject: [] },
  { id: 'harness-observability', name: '可观测性(audit/metrics/trajectory)', inject: ['eventBus'] },
  { id: 'harness-governance', name: '治理(harness-hooks)', inject: ['tools'] },
];

let _tree = null;

// P2-③(2026-09-03, dsh 对标: 内置=默认装配): 装配 profile——"内置是装配决定, 不是代码位置"。
// boss(默认)=当前完整行为, 老板用户无感; minimal=精简树(无核心服务/制度壳/内置安装, 仅桥),
// 供测试与嵌入式场景。能力开关的产品面(哪些工具/技能对用户可用)仍归 plugin-manager/config,
// 本 profile 只管树自身的装配面——不另立第二套开关真理源。
const PROFILES = Object.freeze({
  boss: Object.freeze({ coreServices: true, guards: GUARD_PLUGINS, installs: true, bridge: true }),
  minimal: Object.freeze({ coreServices: false, guards: [], installs: false, bridge: true }),
});

/**
 * 创建 Cordis 单树。
 * @param {{ profile?: 'boss'|'minimal', services?: Record<string, () => any>, guardPlugins?: Array<{id, name, inject}> }} [options]
 * @returns {{ ctx: object, fiber: object, inventory: object }}
 */
async function createHarnessTree(options = {}) {
  const profileName = options.profile || 'boss';
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`[cordis] 未知装配 profile: ${profileName}(允许: ${Object.keys(PROFILES).join('/')})`);
  }
  const ctx = new Context();
  // plugins = 业务插件面（B1-4: audit 空壳真点名的数据源）。当前树无业务插件（业务插件走
  // plugin-manager 不经过树）→ 面为空数组是诚实起点; 将来经树 ctx.plugin() 注册的非 guard
  // 业务插件在此登记 { id, contributes }。制度薄壳(guardPlugins)是制度登记面, 不 push 进此面。
  const inventory = { createdAt: Date.now(), profile: profileName, services: [], guardPlugins: [], plugins: [] };

  // 1) 核心服务注册（引用现有单例; minimal profile 跳过——测试/嵌入式不拉起重服务）
  const services = {
    ...(profile.coreServices ? CORE_SERVICES : {}),
    ...(options.services || {}),
  };
  for (const [name, factory] of Object.entries(services)) {
    try {
      ctx.provide(name, factory());
      inventory.services.push(name);
    } catch (e) {
      console.warn(`[cordis] 服务 ${name} 注册失败(不阻塞):`, e.message);
    }
  }

  // 1.4) 内置数据源安装（Phase 3b：卡片 dataSource 声明 → 源注册表；委托现有实现, 失败不阻塞）
  if (profile.installs) {
    try {
      const { installBuiltinSources } = require('../data-sources/registry');
      installBuiltinSources();
    } catch (e) {
      console.warn('[cordis] 数据源注册表安装失败(不阻塞):', e.message);
    }

    // 1.4b) Provider 元数据安装（Phase 3d：LLM/TTS/文档引擎能力清单；引用单一事实源, 失败不阻塞）
    try {
      const { installBuiltinProviderMeta } = require('../providers/meta-registry');
      installBuiltinProviderMeta();
    } catch (e) {
      console.warn('[cordis] Provider 元数据安装失败(不阻塞):', e.message);
    }
  }

  // 1.5) 事件同步镜像桥（P1-c，受保护：树内插件以 ctx.on 观察 harness 事件；卸载随树）
  if (profile.bridge) {
    try {
      const unsub = installHarnessEventBridge(ctx);
      ctx.effect(() => unsub, 'cordis:event-bridge');
      inventory.bridge = true;
    } catch (e) {
      console.warn('[cordis] 事件桥安装失败(不阻塞):', e.message);
    }
  }

  // 2) 受保护制度插件（薄壳登记；同 id 幂等）
  // B1-4: 制度薄壳只登记进 guardPlugins(制度面), 不登记进 inventory.plugins(业务插件面)——
  // audit 的空壳点名只针对业务插件, 制度登记面 0 贡献不构成空壳、不得被点名。
  const seen = new Set();
  for (const p of (options.guardPlugins || profile.guards)) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    try {
      const fiber = await ctx.plugin({
        name: p.id,
        inject: p.inject || [],
        apply: (c) => {
          inventory.guardPlugins.push({ id: p.id, name: p.name, protected: true });
          c.effect(() => () => { /* 薄壳: 无独立资源 */ }, `${p.id}:shell`);
        },
      });
      void fiber;
    } catch (e) {
      console.warn(`[cordis] 制度插件 ${p.id} 挂载失败(不阻塞):`, e.message);
    }
  }

  return { ctx, fiber: ctx.fiber, inventory };
}

/** 全局惰性单例（树未创建时 null——消费方必须 null-safe） */
function getHarnessTree() {
  return _tree;
}

/** 服务化入口：树建立后发布到全局（init/server 侧调用） */
function installHarnessTree(tree) {
  setHarnessContext(tree);
  _tree = tree;
  return tree;
}

// P2-②(2026-09-03, dsh 对标机制①"注册即可逆"): 统一卸载原语——树级 dispose 走 cordis
// fiber.dispose()(effect 反向执行: 事件桥 unsub 等随树清理), 单例与全局上下文面同时清空。
// 此前摘功能靠删 require、无运行时可逆性; 服务级细粒度 disposer 待 Phase 2 行为面化推进。
async function disposeHarnessTree() {
  const tree = _tree;
  if (!tree) return null;
  _tree = null;
  setHarnessContext(null);
  try {
    if (tree.fiber && typeof tree.fiber.dispose === 'function') {
      await tree.fiber.dispose();
    }
  } catch (e) {
    console.warn('[cordis] 树 dispose 失败(单例已清空, 不阻塞):', e.message);
  }
  return { profile: tree.inventory?.profile || 'boss', services: tree.inventory?.services?.length || 0 };
}

module.exports = {
  createHarnessTree,
  getHarnessTree,
  installHarnessTree,
  disposeHarnessTree,
  PROFILES,
  CORE_SERVICES,
  GUARD_PLUGINS,
};
