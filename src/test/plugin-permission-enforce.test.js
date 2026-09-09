'use strict';

/**
 * plugin-permission-enforce.test.js — B3-1 D8 权限执行域强制（2026-08-27）。
 * 覆盖: classifyTool 分类 / resolveLayer·isTrustedLayer 层语义(含目录 path.sep 边界)
 *      / isSigned / buildPluginPermissionHook 真值表(官方层豁免·签名放行·
 *      unsigned 高权默认拒 HARD·builtin-evil 伪名真锁) / registry 集成
 *      / manifest reserved 前缀禁名(1c 纵深防御)。
 */
const {
  classifyTool, resolveLayer, isTrustedLayer, isSigned, buildPluginPermissionHook,
} = require('../core/plugin/permission-enforce');
const { validateManifest } = require('../core/plugin/manifest');

describe('classifyTool', () => {
  test('Bash/ShellExec/Cmd/PowerShell → exec', () => {
    expect(classifyTool('Bash')).toBe('exec');
    expect(classifyTool('ShellExec')).toBe('exec');
    expect(classifyTool('Cmd')).toBe('exec');
    expect(classifyTool('PowerShell')).toBe('exec');
  });
  test('WebFetch/WebSearch/HttpRequest/FetchUrl → network', () => {
    expect(classifyTool('WebFetch')).toBe('network');
    expect(classifyTool('WebSearch')).toBe('network');
    expect(classifyTool('HttpRequest')).toBe('network');
    expect(classifyTool('FetchUrl')).toBe('network');
  });
  test('其余工具 → none', () => {
    expect(classifyTool('Read')).toBe('none');
    expect(classifyTool('Write')).toBe('none');
    expect(classifyTool('')).toBe('none');
  });
});

describe('isTrustedLayer / resolveLayer', () => {
  test('builtin/bundled 层豁免; user 不豁免', () => {
    expect(isTrustedLayer('builtin')).toBe(true);
    expect(isTrustedLayer('bundled')).toBe(true);
    expect(isTrustedLayer('user')).toBe(false);
    expect(isTrustedLayer('')).toBe(false);
    expect(isTrustedLayer(undefined)).toBe(false);
  });

  test('entry.layer 权威: layer="user" 即使名字像 builtin-evil 也按层判定', () => {
    const entry = { layer: 'user', manifest: { name: 'builtin-evil' }, dir: '/tmp/x' };
    expect(resolveLayer({}, 'builtin-evil', entry)).toBe('user');
  });

  test('无 layer → 目录推断: builtin 树 → builtin', () => {
    const path = require('path');
    const { BUILTIN_PLUGINS_DIR } = require('../core/plugin/plugin-manager');
    const entry = { dir: path.join(BUILTIN_PLUGINS_DIR, 'some-builtin') };
    expect(resolveLayer({}, 'some-builtin', entry)).toBe('builtin');
  });

  test('目录边界(path.sep): plugins-evil 前缀目录不算 builtin 树', () => {
    const path = require('path');
    const { BUILTIN_PLUGINS_DIR } = require('../core/plugin/plugin-manager');
    const evilDir = BUILTIN_PLUGINS_DIR.replace(/plugins$/, 'plugins-evil') + path.sep + 'x';
    expect(resolveLayer({}, 'x', { dir: evilDir })).toBe('user');
  });

  test('user 目录 → user; 无 layer 无 dir → user', () => {
    const path = require('path');
    const { USER_PLUGINS_DIR } = require('../core/plugin/plugin-manager');
    expect(resolveLayer({}, 'p', { dir: path.join(USER_PLUGINS_DIR, 'p') })).toBe('user');
    expect(resolveLayer({}, 'p', {})).toBe('user');
  });
});

describe('isSigned', () => {
  test('signature/signatureX509 → true; 无 → false', () => {
    expect(isSigned({ manifest: { signature: 'abc' } })).toBe(true);
    expect(isSigned({ manifest: { signatureX509: 'x' } })).toBe(true);
    expect(isSigned({ manifest: { name: 'p' } })).toBe(false);
    expect(isSigned(null)).toBe(false);
  });
});

describe('buildPluginPermissionHook', () => {
  const mkPm = (name, entry) => ({ loaded: new Map([[name, entry]]) });
  const userEntry = (over = {}) => ({
    manifest: { name: 'x-plugin' },
    permissions: { files: [], network: false, exec: false },
    layer: 'user',
    ...over,
  });

  test('无 toolMeta（source 空）→ null', async () => {
    const hook = buildPluginPermissionHook(mkPm('x-plugin', userEntry()));
    expect(await hook('Bash', {}, {})).toBeNull();
  });

  test('cls=none 工具 → null', async () => {
    const hook = buildPluginPermissionHook(mkPm('x-plugin', userEntry()));
    expect(await hook('Read', {}, {}, { source: 'plugin:x-plugin' })).toBeNull();
  });

  test('工具来源不在 pm.loaded（核心工具/非插件注册）→ null', async () => {
    const hook = buildPluginPermissionHook(mkPm('x-plugin', userEntry()));
    expect(await hook('Bash', {}, {}, { source: 'plugin:unknown' })).toBeNull();
    expect(await hook('Bash', {}, {}, { source: 'builtin' })).toBeNull();
  });

  test('④ layer="builtin" 官方层 → 任何权限状态均放行', async () => {
    const pm = mkPm('some-builtin', {
      manifest: { name: 'some-builtin' },
      permissions: { files: [], network: false, exec: false }, // 未声明也豁免
      layer: 'builtin',
    });
    const hook = buildPluginPermissionHook(pm);
    expect(await hook('Bash', {}, {}, { source: 'plugin:some-builtin' })).toBeNull();
    expect(await hook('WebFetch', {}, {}, { source: 'plugin:some-builtin' })).toBeNull();
  });

  test('unsigned 外部插件 exec 工具未声明 → 拦截（reason 含插件名+权限名）', async () => {
    const hook = buildPluginPermissionHook(mkPm('x-plugin', userEntry()));
    const d = await hook('Bash', {}, {}, { source: 'plugin:x-plugin' });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('x-plugin');
    expect(d.reason).toContain('exec');
  });

  test('unsigned 外部插件 network 工具未声明 → 拦截', async () => {
    const hook = buildPluginPermissionHook(mkPm('x-plugin', userEntry()));
    const d = await hook('WebFetch', {}, {}, { source: 'plugin:x-plugin' });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('x-plugin');
    expect(d.reason).toContain('network');
  });

  test('① builtin-evil 伪名插件(layer="user")声明 exec:true → 仍拒绝（前缀绕过已封）', async () => {
    const pm = mkPm('builtin-evil', {
      manifest: { name: 'builtin-evil' },
      permissions: { files: [], network: false, exec: true },
      layer: 'user',
    });
    const hook = buildPluginPermissionHook(pm);
    const d = await hook('Bash', {}, {}, { source: 'plugin:builtin-evil' });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('builtin-evil');
    expect(d.reason).toContain('未验证署名');
  });

  test('② unsigned user 插件声明 exec:true → 拒绝（HARD 行3: 声明内未签名默认拒）', async () => {
    const pm = mkPm('u-plugin', {
      manifest: { name: 'u-plugin' },
      permissions: { files: [], network: false, exec: true },
      layer: 'user',
    });
    const hook = buildPluginPermissionHook(pm);
    const d = await hook('Bash', {}, {}, { source: 'plugin:u-plugin' });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('未验证署名');
  });

  test('③ signed user 插件(manifest.signature) + exec:true → 放行', async () => {
    const pm = mkPm('s-plugin', {
      manifest: { name: 's-plugin', signature: 'sig-b64' },
      permissions: { files: [], network: true, exec: true },
      layer: 'user',
    });
    const hook = buildPluginPermissionHook(pm);
    expect(await hook('Bash', {}, {}, { source: 'plugin:s-plugin' })).toBeNull();
    expect(await hook('WebSearch', {}, {}, { source: 'plugin:s-plugin' })).toBeNull();
  });

  test('signed user 插件未声明 exec → 仍拦截（签名只豁免声明内）', async () => {
    const pm = mkPm('s2-plugin', {
      manifest: { name: 's2-plugin', signatureX509: 'x509' },
      permissions: { files: [], network: false, exec: false },
      layer: 'user',
    });
    const hook = buildPluginPermissionHook(pm);
    const d = await hook('Bash', {}, {}, { source: 'plugin:s2-plugin' });
    expect(d.blocked).toBe(true);
    expect(d.reason).toContain('未声明 exec');
  });

  test('集成: 注册插件 Bash 工具且未声明 exec → execute 被拒', async () => {
    const { ToolRegistry } = require('../tools/registry');
    const pm = mkPm('x-plugin', userEntry());
    const reg = new ToolRegistry();
    reg.register({ name: 'Bash', handler: async () => ({ success: true }), source: 'plugin:x-plugin', category: 'shell' });
    reg.addPreExecuteHook(buildPluginPermissionHook(pm));
    const r = await reg.execute('Bash', { command: 'ls' }, {});
    expect(r.success).toBe(false);
    expect(r.blocked).toBe(true);
    expect(String(r.error)).toContain('x-plugin');
    expect(String(r.error)).toContain('exec');
  });

  test('集成: 内置来源 Bash 不受权限钩子影响 → 正常执行', async () => {
    const { ToolRegistry } = require('../tools/registry');
    const pm = mkPm('x-plugin', userEntry());
    const reg = new ToolRegistry();
    reg.register({ name: 'Bash', handler: async () => 'ok-out', source: 'builtin', category: 'shell' });
    reg.addPreExecuteHook(buildPluginPermissionHook(pm));
    const r = await reg.execute('Bash', { command: 'ls' }, {});
    expect(r.success).toBe(true);
    expect(r.data).toBe('ok-out');
  });
});

describe('manifest reserved 前缀禁名（1c 纵深防御）', () => {
  test('builtin-/bundled-/plugin- 前缀 → invalid', () => {
    for (const n of ['builtin-evil', 'bundled-evil', 'plugin-evil', 'BUILTIN_evil']) {
      const r = validateManifest({ name: n, version: '1.0.0' });
      expect(r.valid).toBe(false);
      expect(r.errors.join('; ')).toContain('reserved 前缀');
    }
  });
  test('普通名不受影响', () => {
    expect(validateManifest({ name: 'weather-data-source', version: '1.0.0' }).valid).toBe(true);
  });
});

describe('checkPluginBasePath（B3-2 files 域 path-rules 交集）', () => {
  const path = require('path');
  const { checkPluginBasePath } = require('../core/permissions/path-rules');
  const REPO = path.resolve('/repo-b3-2');

  test('空清单 / 非数组 / null → 拒绝 + 固定 reason', () => {
    const want = { ok: false, reason: '插件未声明 files 权限路径' };
    expect(checkPluginBasePath([], 'a.txt')).toEqual(want);
    expect(checkPluginBasePath(undefined, 'a.txt')).toEqual(want);
    expect(checkPluginBasePath(null, 'a.txt')).toEqual(want);
    expect(checkPluginBasePath('not-array', 'a.txt')).toEqual(want);
  });

  test('精确命中 base → 放行', () => {
    expect(checkPluginBasePath([path.join(REPO, 'data')], path.join(REPO, 'data'))).toEqual({ ok: true });
  });

  test('base 目录下任意层级 → 放行', () => {
    const r = checkPluginBasePath([path.join(REPO, 'data')], path.join(REPO, 'data', 'a', 'b', 'f.txt'));
    expect(r).toEqual({ ok: true });
  });

  test('path.sep 边界: base 前缀同名兄弟目录/文件 → 拒绝（前缀攻击）', () => {
    for (const evil of ['dataX', 'data-x', 'database']) {
      expect(checkPluginBasePath([path.join(REPO, 'data')], path.join(REPO, evil, 'f.txt')).ok).toBe(false);
    }
    expect(checkPluginBasePath([path.join(REPO, 'data')], path.join(REPO, 'dataX')).ok).toBe(false);
  });

  test('大小写不敏感（Windows 安全）: 声明/目标混合大小写 → 放行', () => {
    const r = checkPluginBasePath([path.join(REPO, 'Data')], path.join(REPO, 'DATA', 'F.TXT'));
    expect(r).toEqual({ ok: true });
  });

  test('相对声明路径 → 相对 cwd 归一后放行', () => {
    expect(checkPluginBasePath(['data-b3-2'], path.join(process.cwd(), 'data-b3-2', 'f.txt')).ok).toBe(true);
  });

  test('目标含 .. 归一 → 归一后仍在声明根下 → 放行', () => {
    const t = path.join(REPO, 'data', 'sub', '..', 'f.txt'); // = data/f.txt
    expect(checkPluginBasePath([path.join(REPO, 'data')], t).ok).toBe(true);
  });

  test('.. 逃逸声明根 → 拒绝', () => {
    const t = path.join(REPO, 'data', 'sub', '..', '..', 'data', 'x.txt');
    expect(checkPluginBasePath([path.join(REPO, 'data', 'sub')], t).ok).toBe(false);
  });

  test('声明路径本身带 .. → 归一后生效', () => {
    expect(checkPluginBasePath([path.join(REPO, 'data', 'sub', '..')], path.join(REPO, 'data', 'f.txt')).ok).toBe(true);
  });

  test('多清单条目: 命中第二个 → 放行', () => {
    const r = checkPluginBasePath([path.join(REPO, 'a'), path.join(REPO, 'b')], path.join(REPO, 'b', 'x'));
    expect(r).toEqual({ ok: true });
  });

  test('未命中 → 拒绝 + reason 含原始 targetPath', () => {
    const t = path.join(REPO, 'other', 'f.txt');
    const r = checkPluginBasePath([path.join(REPO, 'data')], t);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('超出声明路径');
    expect(r.reason).toContain(t);
  });

  test('sep 结尾声明(驱动器/根目录): 其下任意 → 放行（endsWith(sep) 边界）', () => {
    const root = path.parse(REPO).root;
    expect(checkPluginBasePath([root], path.join(root, 'etc', 'x')).ok).toBe(true);
  });

  test('畸形清单条目(非字符串) → 跳过不抛, 其余条目正常判定', () => {
    expect(checkPluginBasePath([path.join(REPO, 'data'), 42, { p: 1 }], path.join(REPO, 'data', 'f.txt')).ok).toBe(true);
    expect(checkPluginBasePath([42], path.join(REPO, 'data', 'f.txt')).ok).toBe(false);
  });

  test('空串条目 [\'\'] → 拒绝（path.resolve(\'\')=cwd 会授整个 cwd 子树, fail-open 防渗）', () => {
    const cwdTarget = path.join(process.cwd(), 'data-b3-2-empty', 'f.txt');
    expect(checkPluginBasePath([''], cwdTarget).ok).toBe(false);
    expect(checkPluginBasePath(['  '], cwdTarget).ok).toBe(false);
  });
});

describe('files 权限域（B3 files 接线 F1）', () => {
  const path = require('path');
  const mkEntry = (dir, permissions = { files: [] }) => ({
    manifest: { name: 'files-plugin', version: '1.0.0' },
    permissions: { files: permissions.files || [], network: false, exec: false },
    layer: 'user', dir,
  });

  test('声明路径内放行（相对插件目录解析）', async () => {
    const os = require('os');
    const dir = path.join(os.tmpdir(), 'fp-test');
    const pm = { loaded: new Map([['files-plugin', mkEntry(dir, { files: ['data'] })]]) };
    const hook = buildPluginPermissionHook(pm);
    const decision = await hook('PluginReadFile', { filePath: path.join(dir, 'data', 'note.md') }, {}, { source: 'plugin:files-plugin', fileParams: ['filePath'] });
    expect(decision).toBeNull();
  });

  test('越界拦截 + reason 含插件名/参数名/目标', async () => {
    const os = require('os');
    const dir = path.join(os.tmpdir(), 'fp-test-2');
    const pm = { loaded: new Map([['files-plugin', mkEntry(dir, { files: ['data'] })]]) };
    const hook = buildPluginPermissionHook(pm);
    const target = path.join(dir, '..', 'outside.txt');
    const decision = await hook('PluginReadFile', { filePath: target }, {}, { source: 'plugin:files-plugin', fileParams: ['filePath'] });
    expect(decision).not.toBeNull();
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain('files-plugin');
    expect(decision.reason).toContain('filePath');
  });

  test('未声明 files → 默认拒（fail-closed）', async () => {
    const os = require('os');
    const pm = { loaded: new Map([['files-plugin', mkEntry(path.join(os.tmpdir(), 'fp-test-3'))]]) };
    const hook = buildPluginPermissionHook(pm);
    const decision = await hook('PluginReadFile', { filePath: '/tmp/ok' }, {}, { source: 'plugin:files-plugin', fileParams: ['filePath'] });
    expect(decision).not.toBeNull();
    expect(decision.reason).toContain('未声明');
  });

  test('builtin 层豁免', async () => {
    const os = require('os');
    const dir = path.join(os.tmpdir(), 'fp-test-4');
    const pm = { loaded: new Map([['files-plugin', { ...mkEntry(dir, { files: [] }), layer: 'builtin' }]]) };
    const hook = buildPluginPermissionHook(pm);
    const decision = await hook('PluginReadFile', { filePath: '/anywhere' }, {}, { source: 'plugin:files-plugin', fileParams: ['filePath'] });
    expect(decision).toBeNull();
  });

  test('manifest: fileParams 非数组 → invalid', () => {
    const m = { name: 'x', version: '1.0.0', contributes: { tools: [{ name: 't', handler: 'h.js', fileParams: 'filePath' }] } };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.join('; ')).toContain('fileParams');
  });
});

describe('S-1b files 域接线: 插件工具注册透传 fileParams', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const { PluginManager } = require('../core/plugin/plugin-manager');
  const { registry } = require('../tools/registry');

  test('manifest tools[].fileParams → registry 条目非空 → hook files 分支可触发', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-s1b-'));
    fs.writeFileSync(path.join(dir, 'tool.js'), 'module.exports = async (params) => ({ ok: true, params });', 'utf8');

    const pm = new PluginManager();
    pm.bindRegistries({ toolRegistry: registry });
    const manifest = {
      name: 'fp-reg-plugin', version: '1.0.0', kind: 'plugin',
      // 新格式: _resolveContribs 取 contributes.ui.tools（旧格式为 contributions.tools）
      contributes: { ui: { tools: [{ name: 'FpRegRead', handler: 'tool.js', category: 'files', riskLevel: 'low', fileParams: ['filePath'] }] } },
    };
    await pm._loadContributions(manifest, dir, 'plugin:fp-reg-plugin', {});

    // 断言 1: 注册链路透传——registry 条目 fileParams 非空（修复前恒为空数组, filesGate 永不触发）
    const tool = registry.get('FpRegRead');
    expect(tool).toBeTruthy();
    expect(tool.fileParams).toEqual(['filePath']);

    // 断言 2: registry execute 的 toolMeta 组装会带 fileParams（与 registry.js 403 行同构）
    const toolMeta = { source: tool.source || null, fileParams: Array.isArray(tool.fileParams) ? tool.fileParams : [] };
    expect(toolMeta.source).toBe('plugin:fp-reg-plugin');
    expect(toolMeta.fileParams).toEqual(['filePath']);

    // 断言 3: hook files 分支真实触发——permissions.files 未声明 → fail-closed 拦截
    pm.loaded.set('fp-reg-plugin', {
      manifest, dir, source: 'plugin:fp-reg-plugin', layer: 'user',
      permissions: { files: [], network: false, exec: false },
    });
    const hook = buildPluginPermissionHook(pm);
    const decision = await hook('FpRegRead', { filePath: '/anywhere.txt' }, {}, toolMeta);
    expect(decision).not.toBeNull();
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain('未声明');
  });
});
