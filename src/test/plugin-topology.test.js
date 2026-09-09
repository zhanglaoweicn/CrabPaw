/**
 * plugin-topology.test.js — B2-2 拓扑装配 + 三态机测试
 *
 * 覆盖:
 * 1. topoSortPlugins: 链式依赖排序 / inject 引用 provides 名(≠插件名) / 稳定序 /
 *    外部服务注入不算图内边 / 环 fail-loud 点名完整回路
 * 2. 三态机: load → active; disable → disposing → disposed; listAll 输出 state
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { PluginManager, topoSortPlugins } = require('../core/plugin/plugin-manager');

describe('topoSortPlugins', () => {
  const mk = (name, inject = [], provides = []) => ({ name, inject, provides });

  test('按依赖排序: a 依赖 b, b 依赖 c → c,b,a', () => {
    const order = topoSortPlugins([mk('a', ['b'], []), mk('b', ['c'], []), mk('c', [], ['c'])]);
    expect(order).toEqual(['c', 'b', 'a']);
  });

  test('inject 引用 provides 名(≠插件名) → 按提供者排序', () => {
    const order = topoSortPlugins([mk('a', ['db'], []), mk('b', [], ['db'])]);
    expect(order).toEqual(['b', 'a']);
  });

  test('无依赖插件保持原列表序(稳定序)', () => {
    expect(topoSortPlugins([mk('x'), mk('y'), mk('z')])).toEqual(['x', 'y', 'z']);
  });

  test('注入列表外服务不算图内边', () => {
    expect(topoSortPlugins([mk('a', ['external-svc']), mk('b')])).toEqual(['a', 'b']);
  });

  test('环 → fail-loud 点名完整回路', () => {
    expect(() => topoSortPlugins([mk('a', ['b']), mk('b', ['a'])])).toThrow(/插件依赖环: a → b → a/);
  });
});

describe('三态机 (runtime.state)', () => {
  function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-topo-'));
  }
  function writePlugin(dir, manifest) {
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), yaml.dump(manifest), 'utf8');
  }
  function mkManager() {
    const pm = new PluginManager();
    pm._saveStates = async () => {};
    pm._loadStates = async () => {};
    return pm;
  }

  test('load 成功 → runtime.state pending→active', async () => {
    const pm = mkManager();
    const dir = mkTmpDir();
    writePlugin(dir, { name: 'topo-fixture', version: '1.0.0', kind: 'plugin' });
    await pm.load(dir, { source: 'user' });
    expect(pm.loaded.get('topo-fixture').state).toBe('active');
  });

  test('disable 流程 → disposing → disposed', async () => {
    const pm = mkManager();
    const dir = mkTmpDir();
    writePlugin(dir, { name: 'topo-fixture', version: '1.0.0', kind: 'plugin' });
    await pm.load(dir, { source: 'user' });
    const runtime = pm.loaded.get('topo-fixture');

    // stop 阶段拦截: 卸载进行中应观察到 disposing
    let release;
    const gate = new Promise((r) => { release = r; });
    let observedDuringStop = null;
    const origExecute = pm._executeLifecycle.bind(pm);
    pm._executeLifecycle = async (m, d, phase, cfg, rt) => {
      if (phase === 'stop') { observedDuringStop = rt.state; await gate; }
      return origExecute(m, d, phase, cfg, rt);
    };

    const disabling = pm.disable('topo-fixture');
    await new Promise((r) => setTimeout(r, 20));
    expect(observedDuringStop).toBe('disposing');
    release();
    await disabling;

    expect(runtime.state).toBe('disposed');
    expect(pm.loaded.has('topo-fixture')).toBe(false);
    const item = pm.listAll().find((x) => x.name === 'topo-fixture');
    expect(item.state).toBe('disposed');
  });

  test('listAll 输出 state: active/disposed/pending', async () => {
    const pm = mkManager();
    const dir = mkTmpDir();
    writePlugin(dir, { name: 'topo-fixture', version: '1.0.0', kind: 'plugin' });
    await pm.load(dir, { source: 'user' });

    pm._knownPlugins.set('known-idle', { dir: path.join(dir, 'known-idle'), source: 'plugin:user', manifest: { name: 'known-idle', version: '1.0.0' }, config: {} });
    pm._knownPlugins.set('disabled-one', { dir: path.join(dir, 'disabled-one'), source: 'plugin:user', manifest: { name: 'disabled-one', version: '1.0.0' }, config: {} });
    pm._states['disabled-one'] = { enabled: false, disabledAt: new Date().toISOString() };

    const byName = Object.fromEntries(pm.listAll().map((x) => [x.name, x]));
    expect(byName['topo-fixture'].state).toBe('active');
    expect(byName['disabled-one'].state).toBe('disposed');
    expect(byName['known-idle'].state).toBe('pending');
  });
});

describe('loadFromConfig 拓扑装配', () => {
  function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-topo-'));
  }
  function writePlugin(dir, manifest) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), yaml.dump(manifest), 'utf8');
  }
  function mkManager() {
    const pm = new PluginManager();
    pm._saveStates = async () => {};
    pm._loadStates = async () => {};
    return pm;
  }

  test('按拓扑序加载且 config 透传不丢', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    writePlugin(path.join(base, 'topo-a'), { name: 'topo-a', version: '1.0.0', kind: 'plugin', inject: ['topo-b'] });
    writePlugin(path.join(base, 'topo-b'), { name: 'topo-b', version: '1.0.0', kind: 'plugin' });

    const order = [];
    const origLoad = pm.load.bind(pm);
    pm.load = async (dir, opts) => {
      const m = await origLoad(dir, opts);
      order.push(m.name);
      return m;
    };

    const cfgB = { hello: 'world' };
    await pm.loadFromConfig({ 'topo-a': { tag: 'a' }, 'topo-b': cfgB }, 'test', base);
    expect(order).toEqual(['topo-b', 'topo-a']);
    expect(pm.loaded.get('topo-b').pluginConfig).toEqual(cfgB);
    expect(pm.loaded.get('topo-a').pluginConfig).toEqual({ tag: 'a' });
  });

  test('环 → loadFromConfig 抛错点名回路', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    writePlugin(path.join(base, 'topo-x'), { name: 'topo-x', version: '1.0.0', kind: 'plugin', inject: ['topo-y'] });
    writePlugin(path.join(base, 'topo-y'), { name: 'topo-y', version: '1.0.0', kind: 'plugin', inject: ['topo-x'] });
    await expect(pm.loadFromConfig({ 'topo-x': {}, 'topo-y': {} }, 'test', base)).rejects.toThrow(/插件依赖环/);
  });
});

describe('C3 依赖禁用跳过（禁用=warn+跳过, 环才抛错）', () => {
  function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-c3-'));
  }
  function writePlugin(dir, manifest) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), yaml.dump(manifest), 'utf8');
  }
  function mkManager() {
    const pm = new PluginManager();
    pm._saveStates = async () => {};
    pm._loadStates = async () => {};
    return pm;
  }
  function warnSpy() {
    return jest.spyOn(console, 'warn').mockImplementation(() => {});
  }

  test('B 被禁用 → 依赖者 A 跳过加载（loaded 无 A + warn 点名 A/B）', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    // inject 引用 provides 名(bsvc)≠插件名 —— 与 topo 反查语义一致
    writePlugin(path.join(base, 'c3-a'), { name: 'c3-a', version: '1.0.0', kind: 'plugin', inject: ['bsvc'] });
    writePlugin(path.join(base, 'c3-b'), { name: 'c3-b', version: '1.0.0', kind: 'plugin', provides: ['bsvc'] });
    pm._states['c3-b'] = { enabled: false, disabledAt: new Date().toISOString() };

    const spy = warnSpy();
    const loaded = await pm.loadFromConfig({ 'c3-a': {}, 'c3-b': {} }, 'test', base);

    expect(pm.loaded.has('c3-a')).toBe(false);
    expect(pm.loaded.has('c3-b')).toBe(false);
    expect(loaded).toEqual([]);
    // warn 日志点名依赖者 A 与被禁用的提供者 B
    expect(spy.mock.calls.some(([m]) => String(m).includes('c3-a') && String(m).includes('c3-b'))).toBe(true);
    spy.mockRestore();
  });

  test('传递: C 依赖 A, A 依赖被禁用的 B → A、C 都跳过', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    writePlugin(path.join(base, 'c3-c'), { name: 'c3-c', version: '1.0.0', kind: 'plugin', inject: ['asvc'] });
    writePlugin(path.join(base, 'c3-a'), { name: 'c3-a', version: '1.0.0', kind: 'plugin', provides: ['asvc'], inject: ['bsvc'] });
    writePlugin(path.join(base, 'c3-b'), { name: 'c3-b', version: '1.0.0', kind: 'plugin', provides: ['bsvc'] });

    const spy = warnSpy();
    // B 走 cfg.enabled===false 判定分支（state 分支已由上一用例覆盖）
    await pm.loadFromConfig({ 'c3-a': {}, 'c3-b': { enabled: false }, 'c3-c': {} }, 'test', base);

    expect(pm.loaded.has('c3-a')).toBe(false);
    expect(pm.loaded.has('c3-b')).toBe(false);
    expect(pm.loaded.has('c3-c')).toBe(false);
    // C 的 warn 点名 C 与 A（传递跳过）
    expect(spy.mock.calls.some(([m]) => String(m).includes('c3-c') && String(m).includes('c3-a'))).toBe(true);
    spy.mockRestore();
  });

  test('无 inject 插件不受其他插件禁用影响（回归）', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    writePlugin(path.join(base, 'c3-x'), { name: 'c3-x', version: '1.0.0', kind: 'plugin' });
    writePlugin(path.join(base, 'c3-b'), { name: 'c3-b', version: '1.0.0', kind: 'plugin' });
    pm._states['c3-b'] = { enabled: false, disabledAt: new Date().toISOString() };

    await pm.loadFromConfig({ 'c3-b': {}, 'c3-x': {} }, 'test', base);
    expect(pm.loaded.has('c3-x')).toBe(true);
    expect(pm.loaded.has('c3-b')).toBe(false);
  });

  test('inject 外部服务名(不在清单) → 不参与禁用判定, 正常加载（回归）', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    writePlugin(path.join(base, 'c3-a'), { name: 'c3-a', version: '1.0.0', kind: 'plugin', inject: ['external-svc'] });
    writePlugin(path.join(base, 'c3-b'), { name: 'c3-b', version: '1.0.0', kind: 'plugin' });
    pm._states['c3-b'] = { enabled: false, disabledAt: new Date().toISOString() };

    await pm.loadFromConfig({ 'c3-a': {}, 'c3-b': {} }, 'test', base);
    expect(pm.loaded.has('c3-a')).toBe(true);
  });
});

describe('S-1a 目录穿越: loadFromConfig 键名越界', () => {
  function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-s1a-'));
  }
  function writePlugin(dir, manifest) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), yaml.dump(manifest), 'utf8');
  }
  function mkManager() {
    const pm = new PluginManager();
    pm._saveStates = async () => {};
    pm._loadStates = async () => {};
    return pm;
  }
  function warnSpy() {
    return jest.spyOn(console, 'warn').mockImplementation(() => {});
  }

  test("config 键含 ../ → warn+跳过: 不入 known、不加载（baseDir 外插件不得冒充 builtin 层）", async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    // 真实插件在 baseDir 的兄弟目录——键名 '../evil-user' 穿越指向它
    const evilDir = path.join(path.dirname(base), 'evil-user');
    writePlugin(evilDir, { name: 'evil-user', version: '1.0.0', kind: 'plugin' });

    const spy = warnSpy();
    const loaded = await pm.loadFromConfig({ '../evil-user': {} }, 'builtin', base);

    expect(loaded).toEqual([]);
    expect(pm.loaded.size).toBe(0);
    expect(pm._knownPlugins.has('evil-user')).toBe(false);
    // warn 点名越界键
    expect(spy.mock.calls.some(([m]) => String(m).includes('越界') && String(m).includes('../evil-user'))).toBe(true);
    spy.mockRestore();
  });

  test('键名合法（baseDir 内）→ 正常加载（回归，不误拦）', async () => {
    const pm = mkManager();
    const base = mkTmpDir();
    writePlugin(path.join(base, 'good-name'), { name: 'good-name', version: '1.0.0', kind: 'plugin' });

    await pm.loadFromConfig({ 'good-name': {} }, 'test', base);
    expect(pm.loaded.has('good-name')).toBe(true);
  });
});

describe('S-1d 口径统一: 顶层 contributes.tools 权威（与 dataSources 同款）', () => {
  function mkTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-s1d-'));
  }
  function mkManager() {
    const pm = new PluginManager();
    pm._saveStates = async () => {};
    pm._loadStates = async () => {};
    return pm;
  }

  test('顶层 contributes.tools → load 端到端注册 registry + fileParams 透传', async () => {
    const { registry } = require('../tools/registry');
    const pm = mkManager();
    pm.bindRegistries({ toolRegistry: registry });

    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, 'h.js'), 'module.exports = async (params) => ({ ok: true, params });', 'utf8');
    fs.writeFileSync(path.join(dir, 'ds.js'), 'module.exports = async () => ({ rows: [] });', 'utf8');
    // 权威新格式: 顶层 contributes.{tools,dataSources}——validateManifest 只校验该层的
    // fileParams, SDK ALLOWED_CONTRIBUTE_KEYS 也已含 tools; 修复前 _resolveContribs
    // 不读此层 → 顶层声明的工具永不注册（本测试修复前红）
    const manifest = {
      name: 's1d-top-tools', version: '1.0.0', kind: 'plugin',
      contributes: {
        tools: [{ name: 'S1dTopRead', handler: 'h.js', category: 'files', riskLevel: 'low', fileParams: ['filePath'] }],
        dataSources: [{ name: 's1d-ds', handler: 'ds.js' }],
      },
    };
    fs.writeFileSync(path.join(dir, 'manifest.yaml'), yaml.dump(manifest), 'utf8');

    await pm.load(dir, { source: 'user' });

    const tool = registry.get('S1dTopRead');
    expect(tool).toBeTruthy();
    expect(tool.fileParams).toEqual(['filePath']);
    expect(tool.source).toBe('plugin:s1d-top-tools');
  });
});
