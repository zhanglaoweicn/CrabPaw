/**
 * verify-plugins.js — 插件集市门禁（Phase 4c）：全量 verify 仓库 plugins/ 与内置
 * 用法: node scripts/verify-plugins.js                  （npm run plugin:verify, 全量）
 *       node scripts/verify-plugins.js --profile <name> （仅验证 config.yaml plugins.profiles.<name> 清单）
 * 输出: 每个包 valid/invalid + 审计汇总；任一 invalid → exit 1（CI 门禁口径）。
 * 2026-08-27 D9 C1: 校验逻辑抽取至 src/sdk/plugin-verify-lib.js——行为不变
 * （缺失引用 → missingRefs 对账 fail；空清单 → 门禁拒绝空通过 exit 1 均保留）。
 */
const fs = require('fs');
const path = require('path');
const { verifyPluginsInDir, verifyPluginsByProfile } = require('../src/sdk/plugin-verify-lib');

const ROOT = path.resolve(__dirname, '..');

// 2026-08-27 D4: --profile <name>——从 config.yaml 读 plugins.profiles.<name>
// 合并 builtin/bundled/user 三层名字, 仅验证这些目录; 缺省行为不变=全量。
const profileIdx = process.argv.indexOf('--profile');
const profileArg = profileIdx >= 0 ? process.argv[profileIdx + 1] : null;

let fail = 0;
let total = 0;
let signed = 0;
let profileApplied = false; // --profile 且清单成功解析并应用时为 true(汇总行标注)

// 单条结果输出——逐字节保持 B6 的 check() 格式
function printResult(it) {
  const mark = it.valid ? '✓' : '✗';
  if (it.trustLevel === 'signed') signed++;
  if (!it.valid) { fail++; console.log(`${mark} ${it.name}: ${it.errors.join('; ')}`); }
  else console.log(`${mark} ${it.name} [${it.trustLevel}]${it.warnings.length ? ' ⚠ ' + it.warnings[0] : ''}`);
  total++;
}

function scan(root) {
  try {
    fs.readdirSync(root, { withFileTypes: true }); // 目录探测——ENOENT warn 语义与 B6 一致
  } catch (e) {
    console.warn('[verify-plugins] 扫描目录失败:', e && e.message);
    return;
  }
  const r = verifyPluginsInDir(root);
  for (const it of r.results) printResult(it);
}

if (profileArg) {
  // 三层目录映射与 plugin-manager.js 常量一致: builtin=plugins/, bundled=plugins/bundled/, user=<dataDir>/plugins/
  const DATA_DIR = process.env.CRABPAW_DATA_DIR || path.join(ROOT, 'data', '.crabpaw');
  const layerDirs = {
    builtin: path.join(ROOT, 'plugins'),
    bundled: path.join(ROOT, 'plugins', 'bundled'),
    user: path.join(DATA_DIR, 'plugins'),
  };
  let missingProfile = false;
  try {
    const cfg = require('yaml').parse(fs.readFileSync(path.join(ROOT, 'config.yaml'), 'utf-8'));
    const profile = cfg?.plugins?.profiles?.[profileArg];
    if (!profile || typeof profile !== 'object') {
      console.warn(`⚠️ config.yaml 未配置 plugins.profiles.${profileArg} → 回退全量`);
      missingProfile = true;
    } else {
      profileApplied = true;
      const r = verifyPluginsByProfile(profile, profileArg, layerDirs);
      for (const it of r.results) printResult(it);
      // B6 语义保留: profile 引用缺失目录 → 门禁 fail（lib 计入 missingRefs, 此处对账）
      for (const mref of r.missingRefs) {
        console.error(`✗ profile ${profileArg} 引用插件目录不存在: ${mref}`);
        fail++; total++;
      }
      if (r.results.length === 0 && r.missingRefs.length === 0) {
        console.error('⚠️ profile ' + profileArg + ' 清单为空或无可用目录——门禁拒绝空通过');
        process.exit(1);
      }
    }
  } catch (e) {
    console.warn(`⚠️ 读取 config.yaml plugins.profiles 失败(${e.message}) → 回退全量`);
    missingProfile = true;
  }
  if (missingProfile) { scan(path.resolve(ROOT, 'plugins')); scan(path.resolve(ROOT, 'plugins', 'bundled')); }
} else {
  scan(path.resolve(ROOT, 'plugins')); scan(path.resolve(ROOT, 'plugins', 'bundled'));
}

console.log(`\n📦 插件门禁${profileApplied ? `(profile=${profileArg})` : ''}: ${total} 个插件（签名 ${signed}）→ ${fail === 0 ? '全部通过 ✓' : fail + ' 个失败 ✗'}`);
process.exit(fail === 0 ? 0 : 1);
