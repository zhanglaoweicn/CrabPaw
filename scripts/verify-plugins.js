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
let skipCount = 0; // 因缺 manifest 而计入失败的目录数（汇总行如实报告）
let profileApplied = false; // --profile 且清单成功解析并应用时为 true(汇总行标注)

// 单条结果输出——逐字节保持 B6 的 check() 格式
function printResult(it) {
  const mark = it.valid ? '✓' : '✗';
  if (it.trustLevel === 'signed') signed++;
  if (!it.valid) { fail++; console.log(`${mark} ${it.name}: ${it.errors.join('; ')}`); }
  else console.log(`${mark} ${it.name} [${it.trustLevel}]${it.warnings.length ? ' ⚠ ' + it.warnings[0] : ''}`);
  total++;
}

/**
 * 扫描一个插件目录。
 * 2026-09-30 深度检查修复（门禁空转）: 此前目录缺失只 warn 一句就继续，最终仍打印
 * 「全部通过 ✓」——实测 plugins/bundled 根本不存在，门禁却报绿灯；目录里没有 manifest
 * 的包也被静默跳过（README 称 14 个插件，门禁实际只覆盖 8 个）。
 * 现改为：必需目录缺失 = 失败；每个无 manifest 的目录登记为失败（要么补 manifest，要么
 * 移出 plugins/）；汇总行如实报告覆盖数与被跳过项。
 *
 * @param {string} root         待扫描目录
 * @param {{required?: boolean}} [opts] required=true 时目录缺失计入失败
 */
function scan(root, opts = {}) {
  const requireDir = opts.required !== false;
  const r = verifyPluginsInDir(root, { requireDir });
  if (r.missingDirs.length) {
    if (requireDir) {
      console.error(`✗ 插件目录不存在: ${root}（该目录为门禁必需：不存在即失败，不允许静默通过）`);
      fail++;
    } else {
      console.warn(`⚠️ 可选插件目录不存在，跳过: ${root}`);
    }
  }
  for (const it of r.results) printResult(it);
  for (const name of r.skipped) {
    console.error(`✗ ${path.join(root, name)}: 缺少 manifest.yaml/manifest.json（无法校验——请补 manifest 或移出 plugins/）`);
    skipCount++;
    fail++;
    total++;
  }
  return r;
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
      // 2026-09-30: profile 点名但缺 manifest 的目录同样可见并计失败
      for (const name of r.skipped || []) {
        console.error(`✗ profile ${profileArg} 引用的 ${name} 缺少 manifest.yaml/manifest.json（无法校验）`);
        skipCount++; fail++; total++;
      }
      if (r.results.length === 0 && r.missingRefs.length === 0 && (r.skipped || []).length === 0) {
        console.error('⚠️ profile ' + profileArg + ' 清单为空或无可用目录——门禁拒绝空通过');
        process.exit(1);
      }
    }
  } catch (e) {
    console.warn(`⚠️ 读取 config.yaml plugins.profiles 失败(${e.message}) → 回退全量`);
    missingProfile = true;
  }
  if (missingProfile) { scan(path.resolve(ROOT, 'plugins')); scan(path.resolve(ROOT, 'plugins', 'bundled'), { required: false }); }
} else {
  // plugins/ 为必需（仓库内置插件目录）；plugins/bundled/ 为可选层（此前缺失却照报通过）
  scan(path.resolve(ROOT, 'plugins'));
  scan(path.resolve(ROOT, 'plugins', 'bundled'), { required: false });
}

const skipNote = skipCount > 0 ? `，另有 ${skipCount} 个目录缺 manifest 计入失败` : '';
console.log(`\n📦 插件门禁${profileApplied ? `(profile=${profileArg})` : ''}: ${total} 个插件（签名 ${signed}）→ ${fail === 0 ? '全部通过 ✓' : fail + ' 个失败 ✗'}${skipNote}`);
process.exit(fail === 0 ? 0 : 1);
