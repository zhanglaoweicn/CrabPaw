/**
 * CLI 命令 - 插件管理（2026-08-27 D9 CLI 轮）
 *
 * 子命令:
 *   plugin verify [dir|name]  校验插件（无参=全量扫 plugins/ 与 npm run plugin:verify 同口径）
 *   plugin list               插件概览（名称/版本/层/启用/状态/信任）
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..', '..');

async function handlePluginCommand(args) {
  const sub = args[0] || 'help';
  if (sub === 'verify') return cmdVerify(args.slice(1));
  if (sub === 'list') return cmdList();
  if (sub === 'help' || sub === '-h' || sub === '--help') { console.log('用法: crabpaw plugin verify [dir|name] | plugin list'); process.exit(0); }
  console.log(`Unknown plugin subcommand: ${sub}`);
  process.exit(1);
}

async function cmdVerify(rest) {
  const { verifyPlugin } = require('../../sdk/plugin-sdk');
  const { verifyPluginsInDir } = require('../../sdk/plugin-verify-lib');
  const target = (rest[0] || '').toString();
  if (!target) {
    // 无参 = 全量（与 npm run plugin:verify 同口径: plugins/ + plugins/bundled 若存在）
    const results = [];
    for (const scanDir of [path.join(ROOT, 'plugins'), path.join(ROOT, 'plugins', 'bundled')]) {
      if (!fs.existsSync(scanDir)) continue;
      results.push(...verifyPluginsInDir(scanDir).results);
    }
    for (const it of results) {
      if (!it.valid) console.log(`✗ ${it.name}: ${it.errors.join('; ')}`);
      else console.log(`✓ ${it.name} [${it.trustLevel}]${it.warnings.length ? ' ⚠ ' + it.warnings[0] : ''}`);
    }
    const failed = results.filter(x => !x.valid).length;
    console.log(`\n📦 插件校验: ${results.length - failed}/${results.length} 通过`);
    process.exit(failed === 0 ? 0 : 1);
  }
  // 单包: 绝对路径/相对路径/plugins/ 下的目录名
  const dir = fs.existsSync(target) ? path.resolve(target)
    : fs.existsSync(path.join(ROOT, 'plugins', target)) ? path.join(ROOT, 'plugins', target)
      : null;
  if (!dir) {
    console.log(`插件未找到: ${target}（可用: 绝对路径/相对路径/plugins/ 下的名称）`);
    process.exit(1);
  }
  const r = verifyPlugin(dir);
  if (r.valid) { console.log(`✓ ${target} [${r.trustLevel}]`); process.exit(0); }
  console.log(`✗ ${target}: ${r.errors.join('; ')}`);
  process.exit(1);
}

async function cmdList() {
  // 轻量：不启动服务器、不 load 插件——只读 states + 扫描清单（复用 plugin-manager 的查询面）
  const { getPluginManager } = require('../../core/plugin/index');
  const pm = await getPluginManager();
  await pm.initialize();
  // M1(C1 审查): 干净 CLI 进程 initialize() 后 _knownPlugins 为空(仅 load()/loadFromConfig 写入),
  // listAll 会落 _lazyDiscoverPluginsSync(无 manifest/layer、不读 _states)→层/状态/信任列全空。
  // 这里用 _discoverPlugins 填充 known 面(B1-6 后条目带 manifest+layer), 目录不存在时静默返回, 已登记名跳过。
  const { BUILTIN_PLUGINS_DIR, BUNDLED_PLUGINS_DIR, USER_PLUGINS_DIR, resolveActiveProfile } = require('../../core/plugin/plugin-manager');
  await pm._discoverPlugins(BUILTIN_PLUGINS_DIR, 'builtin');
  await pm._discoverPlugins(BUNDLED_PLUGINS_DIR, 'bundled'); // M1-审查 L-d: bundled 子目录独立标注——否则经「无 manifest 父目录递归」被误标 builtin
  await pm._discoverPlugins(USER_PLUGINS_DIR, 'user');
  const { checkPluginTrust } = require('../../core/plugin/trust-check');
  const profile = resolveActiveProfile({});
  console.log(`插件清单（profile=${profile}）`);
  console.log(`${'名称'.padEnd(24)} 版本 | 层 | 启用 | 状态 | 信任`);
  const rows = await pm.listAll();
  for (const p of rows) {
    const known = pm._knownPlugins.get(p.name);
    const manifest = known?.manifest;
    let trust = '?';
    try {
      if (manifest) trust = checkPluginTrust(manifest).trustLevel;
    } catch (e) {
      console.debug('[plugin list] trust 裁定失败:', e && e.message); // 无 manifest 条目 → 保持 '?'
    }
    // B3-1: known.layer 为装配来源(builtin/bundled/user); 兜底 p.source 形如 'plugin:<source>'
    const layer = (known?.layer || p.source || '').replace('plugin:', '') || '?';
    const enabled = pm.loaded.has(p.name) ? '✓' : (p.manuallyDisabled ? '✗' : '·');
    const entryState = pm.loaded.has(p.name)
      ? (pm.loaded.get(p.name).state || 'active')
      : (p.manuallyDisabled ? 'disposed' : 'pending');
    console.log(`${(p.name || '').padEnd(24)} ${p.version} | ${layer.padEnd(6)} | ${enabled} | ${entryState} | ${trust}`);
  }
  process.exit(0);
}

module.exports = { handlePluginCommand };
