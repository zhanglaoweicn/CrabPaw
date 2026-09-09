/**
 * plugin-lifecycle.test.js — Cordis Stage1 反注册完备性反证测试
 *
 * 覆盖（对应 OPTIMIZATION_PLAN 插件体系 P2/P3/P6/P7 与 S1 清单）：
 * 1. 实例缓存：load/start/stop 共用同一实例，disable 调 stop（P2 定时器泄漏根因）
 * 2. 事件贡献带 source：disable 后 unsubscribeBySource 真正清掉订阅
 * 3. services 贡献反注册不再 TypeError（P3），且不误删无 source 的核心服务
 * 4. tools 反注册内置保护：只删同 source 条目（P6 连删他人工具）
 * 5. UI 贡献弃用：注册被跳过（PluginBridge 已删，禁止死链广播）
 * 6. hooks 管理器：单例 + 用户钩子 JSON 文件随构造加载（孤儿接线后的行为）
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { PluginManager } = require('../core/plugin/plugin-manager');
const { ServiceRegistry } = require('../services/registry');
const { ToolRegistry } = require('../tools/registry');
const { resetUIRegistry, getUIRegistry } = require('../core/plugin/ui-registry');
const { EventBus } = require('../core/events');
const { HookManager, getHookManager } = require('../core/hooks/manager');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-plugin-'));
}

function writePlugin(dir, manifest, files = {}) {
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), yaml.dump(manifest), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
}

/** 兔子工厂：无副作用 PluginManager（不碰真实 states 文件/真实数据目录） */
function mkManager() {
  resetUIRegistry();
  const pm = new PluginManager();
  pm._saveStates = async () => {};
  pm._loadStates = async () => {};
  return pm;
}

const LIFECYCLE_PLUGIN_JS = `class FixturePlugin {
  constructor(manifest) { this.manifest = manifest; this.calls = []; }
  async onLoad() { this.calls.push('load'); }
  async onStart() { this.calls.push('start'); }
  async onStop() { this.calls.push('stop'); }
}
module.exports = FixturePlugin;
`;

describe('S1-1 生命周期：实例缓存 + disable 调 stop', () => {
  test('load/start 共用实例，disable 逆序执行 stop 且卸载', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, { name: 'fixture', version: '1.0.0', kind: 'plugin', lifecycle: { init: 'onLoad', start: 'onStart', stop: 'onStop' } }, { 'plugin.js': LIFECYCLE_PLUGIN_JS });
    const pm = mkManager();
    await pm.load(dir, { source: 'user' });
    const runtime = pm.loaded.get('fixture');
    expect(runtime).toBeTruthy();
    const instance = runtime.instance;
    expect(instance).toBeTruthy();
    expect(instance.calls).toEqual(['load', 'start']);

    await pm.disable('fixture');
    expect(pm.loaded.has('fixture')).toBe(false);
    expect(instance.calls).toEqual(['load', 'start', 'stop']); // 同一实例被 stop
  });

  test('disable 不因旧式 onUnload=方法名 的文件路径化而 ENOENT（路径语义仅 .js/含/时回退）', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, { name: 'fixture2', version: '1.0.0', kind: 'plugin', lifecycle: { init: 'onLoad', stop: 'onStop', onUnload: 'onStop' } }, { 'plugin.js': LIFECYCLE_PLUGIN_JS });
    const pm = mkManager();
    await pm.load(dir);
    await expect(pm.disable('fixture2')).resolves.toBeUndefined();
    const instance = pm.loaded.get('fixture2')?.instance; // 已删，实例仍在内存中
    // 弱验证：disable 成功完成未抛 ENOENT
    expect(instance).toBeUndefined();
  });
});

describe('S1-2/3 贡献反注册完备性（P3：services 禁用不再 TypeError）', () => {
  test('events 贡献带 source：disable 后订阅被清掉', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, {
      name: 'fixture-events', version: '1.0.0',
      contributions: { events: [{ on: 'tool:call_start', handler: 'event-handler.js' }] },
    }, {
      'event-handler.js': `const log = (global.__fixtureEventLog || (global.__fixtureEventLog = []));
module.exports = () => { log.push('called'); };`,
    });
    global.__fixtureEventLog = [];
    const pm = mkManager();
    const bus = new EventBus();
    pm.bindRegistries({ eventBus: bus });
    await pm.load(dir);
    bus.publish('tool', 'call_start', {});
    expect(global.__fixtureEventLog.length).toBe(1);
    await pm.disable('fixture-events');
    bus.publish('tool', 'call_start', {});
    expect(global.__fixtureEventLog.length).toBe(1); // 不再触发
  });

  test('services 贡献：disable 反注册成功（不再 TypeError）+ 核心服务无 source 不受影响', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, {
      name: 'fixture-svc', version: '1.0.0',
      contributions: { services: [{ name: 'fixtureSvc', path: 'svc.js' }] },
    }, { 'svc.js': 'module.exports = { hello: () => 1 };' });
    const pm = mkManager();
    const sr = new ServiceRegistry();
    sr.register('coreService', { initialize: async () => {} }); // 核心服务（无 source）
    pm.bindRegistries({ serviceRegistry: sr });
    await pm.load(dir);
    expect(sr.get('fixtureSvc')).toBeTruthy();
    await expect(pm.disable('fixture-svc')).resolves.toBeUndefined();
    expect(sr.get('fixtureSvc')).toBeNull();
    expect(sr.get('coreService')).toBeTruthy(); // 无 source 服务不受影响
  });

  test('ServiceRegistry.unregisterBySource 只删对应 source', () => {
    const sr = new ServiceRegistry();
    sr.register('a', {}, { source: 'plugin:x' });
    sr.register('b', {});
    const count = sr.unregisterBySource('plugin:x');
    expect(count).toBe(1);
    expect(sr.get('a')).toBeNull();
    expect(sr.get('b')).toBeTruthy();
  });
});

describe('S1-4 tools 反注册内置保护（P6）', () => {
  test('同名工具被后续来源覆盖：反注册前者不清除后者', () => {
    const tr = new ToolRegistry();
    tr.register({ name: 'GuardTest', handler: () => 'a', source: 'plugin:a' });
    tr.register({ name: 'GuardTest', handler: () => 'b', source: 'builtin-core' });
    const count = tr.unregisterBySource('plugin:a');
    expect(count).toBe(0); // 当前条目属于其他来源 → 跳过（签名：跳过计数）
    const tool = tr.get('GuardTest');
    expect(tool).toBeTruthy();
    expect(tool.source).toBe('builtin-core');
  });

  test('标准反注册（条目属于本 source）正常删除', () => {
    const tr = new ToolRegistry();
    tr.register({ name: 'OwnTool', handler: () => 1, source: 'plugin:x' });
    tr.register({ name: 'CoreTool', handler: () => 2, source: 'core' });
    const count = tr.unregisterBySource('plugin:x');
    expect(count).toBe(1);
    expect(tr.get('OwnTool')).toBeUndefined();
    expect(tr.get('CoreTool')).toBeTruthy();
  });
});

describe('S1-5 UI 贡献弃用（PluginBridge 已删，禁止死链广播）', () => {
  test('routes/sidebar/settings 贡献注册被跳过，UIRegistry 快照保持空', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, {
      name: 'fixture-ui', version: '1.0.0', kind: 'plugin',
      contributes: {
        ui: {
          routes: [{ path: '/plugin/x', component: 'X' }],
          sidebar: [{ label: 'X', path: '/plugin/x' }],
          settings: [{ id: 'x', component: 'X' }],
        },
      },
    }, { 'plugin.js': 'module.exports = { async onLoad() {} };' });
    const pm = mkManager();
    await pm.load(dir);
    const ui = getUIRegistry();
    const snap = ui.getSnapshot();
    expect(snap.routes).toHaveLength(0);
    expect(snap.sidebars).toHaveLength(0);
    expect(snap.settings).toHaveLength(0);
  });
});

describe('S1-6 hooks 管理器（孤儿接线后的行为）', () => {
  test('getHookManager 单例 + 标准钩子随构造注册', () => {
    const hm = getHookManager();
    expect(getHookManager()).toBe(hm);
    // createStandardHooks: logger / session-tracker / error-handler
    expect(hm._loadedHooks.has('logger')).toBe(true);
    expect(hm._loadedHooks.has('error-handler')).toBe(true);
  });

  test('用户钩子 JSON 文件随构造加载（file handler 生效）', async () => {
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, 'user-handler.js'),
      'module.exports = (eventType, context) => { context.userHookHit = (context.userHookHit || 0) + 1; };', 'utf8');
    fs.writeFileSync(path.join(dir, 'user-hook.json'), JSON.stringify({
      name: 'user-hook', eventType: 'session:start', enabled: true, priority: 0,
      handlerType: 'file', handlerPath: 'user-handler.js',
    }), 'utf8');
    const hm = new HookManager({ hooksPath: dir });
    const context = {};
    const results = await hm.emit('session:start', context);
    expect(context.userHookHit).toBe(1);
    expect(Array.isArray(results)).toBe(true); // emit 正常返回，不抛
  });

  test('registerHook + emit 全链路', async () => {
    const dir = mkTmpDir();
    const hm = new HookManager({ hooksPath: dir });
    let received = null;
    hm.registerHook('test-tool-hook', 'tool:before', (type, ctx) => { received = { type, ctx }; });
    await hm.emit('tool:before', { name: 'Write' });
    expect(received.type).toBe('tool:before');
    expect(received.ctx.name).toBe('Write');
  });
});

describe('B1-6 enable/disable 往返 + known 面快照（审查 Low 项回归）', () => {
  test('enable→disable→enable 往返后 config 经 known 透传保留，数据源反注册 removed 兜底不抛', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, {
      name: 'fixture-roundtrip', version: '1.0.0', kind: 'plugin',
      lifecycle: { init: 'onLoad', start: 'onStart', stop: 'onStop' },
      contributes: { dataSources: [{ name: 'roundtripDs', handler: 'datasource.js' }] },
    }, {
      'plugin.js': LIFECYCLE_PLUGIN_JS,
      'datasource.js': 'module.exports = () => ({ ok: true, data: [] });',
    });
    const pm = mkManager();
    // 桩：registerSource 正常；unregisterBySource 故意返回 undefined——覆盖 Fix 2 兜底分支
    const dsRegistry = {
      registerSource: () => ({ ok: true }),
      unregisterBySource: () => undefined,
    };
    pm.bindRegistries({ dataSourcesRegistry: dsRegistry });

    await pm.load(dir, { source: 'user', config: { token: 'abc', depth: 3 } });
    expect(pm.loaded.get('fixture-roundtrip').pluginConfig).toEqual({ token: 'abc', depth: 3 });

    await pm.disable('fixture-roundtrip'); // 走 (r || {}).removed ?? 0 兜底日志分支，不得抛
    expect(pm.loaded.has('fixture-roundtrip')).toBe(false);

    await pm.enable('fixture-roundtrip'); // known 路径：config 从 _knownPlugins 透传给 load
    const again = pm.loaded.get('fixture-roundtrip');
    expect(again).toBeTruthy();
    expect(again.pluginConfig).toEqual({ token: 'abc', depth: 3 }); // 二次 enable 与初次一致
    await pm.disable('fixture-roundtrip');
  });

  test('enable 往返 layer 标记不腐坏: load(source:builtin)→disable→enable(known 路径) 后 loaded.layer 仍为 builtin', async () => {
    const dir = mkTmpDir();
    writePlugin(dir, { name: 'fixture-layer', version: '1.0.0', kind: 'plugin' });
    const pm = mkManager();
    await pm.load(dir, { source: 'builtin' });
    expect(pm.loaded.get('fixture-layer').layer).toBe('builtin');
    await pm.disable('fixture-layer');
    expect(pm.loaded.has('fixture-layer')).toBe(false);
    await pm.enable('fixture-layer'); // known 路径——修复前 layer 腐坏为插件名
    const again = pm.loaded.get('fixture-layer');
    expect(again).toBeTruthy();
    expect(again.layer).toBe('builtin');
    await pm.disable('fixture-layer');
  });

  test('discover 扫描 known 面：5 data-source + 3 旧插件 + 递归子目录无重复无漏、config 对称', async () => {
    const root = mkTmpDir();
    const dataSources = ['business-data-source', 'commodity-data-source', 'stock-data-source', 'typhoon-data-source', 'weather-data-source'];
    const legacy = ['memory-consistency', 'regression-guard', 'voice-evolution'];
    for (const name of [...dataSources, ...legacy]) {
      const pluginDir = path.join(root, name);
      fs.mkdirSync(pluginDir);
      writePlugin(pluginDir, { name, version: '1.0.0' });
    }
    // 递归分支（sub-plugins/ 嵌套结构）：顶层无 manifest，子目录带 plugin.json
    // （manifest.json 归 dashboard-plugin-scanner 管，readManifest 只认 plugin.json/yaml）
    const nested = path.join(root, 'example-dashboard', 'dashboard');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'plugin.json'), JSON.stringify({ name: 'dashboard', version: '1.0.0' }), 'utf8');

    const pm = mkManager();
    await pm._discoverPlugins(root, 'builtin');

    const expected = [...dataSources, ...legacy, 'dashboard'].sort();
    const keys = [...pm._knownPlugins.keys()].sort();
    expect(keys).toEqual(expected); // 无重复（Map 天然去重）无漏
    for (const name of keys) {
      const entry = pm._knownPlugins.get(name);
      expect(entry.source).toBe('plugin:builtin');
      expect(typeof entry.config).toBe('object'); // 递归子目录条目亦带 config——Fix 1 对称
    }
  });
});

describe('S-1a 目录穿越: enable 插件名白名单', () => {
  test("enable('../evil') → reject 插件名非法（../ 穿越拒绝）", async () => {
    const pm = mkManager();
    await expect(pm.enable('../evil')).rejects.toThrow(/插件名非法/);
  });

  test("enable('evil\name') → reject 插件名非法（Windows 反斜杠穿越拒绝）", async () => {
    const pm = mkManager();
    await expect(pm.enable('evil\name')).rejects.toThrow(/插件名非法/);
  });

  test('合法名不误拦: enable("valid-name_1") → 「未找到」而非「非法」（白名单不过紧）', async () => {
    const pm = mkManager();
    await expect(pm.enable('valid-name_1')).rejects.toThrow(/未找到/);
  });
});
