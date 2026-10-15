/**
 * plugin-verify-lib.js — 插件集市校验库（2026-08-27 CLI 轮）。
 * verifyPluginsInDir / verifyPluginsByProfile —— npm run plugin:verify 与 crabpaw plugin verify 共享，
 * 行为与 scripts/verify-plugins.js 保持一致（无 manifest 目录跳过/任一 invalid → failed 计数）。
 */
const fs = require('fs');
const path = require('path');
const { verifyPlugin } = require('./plugin-sdk');

/**
 * 插件清单探测——跟随运行时两套发现规则，避免门禁误报：
 *  1. 插件运行时（plugin/manifest.js:13 MANIFEST_FILES）：目录根下 manifest.yaml/.yml 或 plugin.yaml/.yml/.json
 *  2. dashboard 插件（core/dashboard-plugin-scanner.js:65）：`<dir>/dashboard/manifest.json`
 * 两者任一命中即视为"可校验目录"。注意运行时**不读**根目录的 manifest.json，
 * 所以 example-dashboard 这种「根无清单 + dashboard/manifest.json」是 dashboard 形态而非遗留物。
 */
const RUNTIME_MANIFESTS = ['manifest.yaml', 'manifest.yml', 'plugin.yaml', 'plugin.yml', 'plugin.json'];

function resolveVerifiableDir(dir) {
  for (const f of RUNTIME_MANIFESTS) {
    if (fs.existsSync(path.join(dir, f))) return { dir, kind: 'plugin' };
  }
  const dash = path.join(dir, 'dashboard');
  if (fs.existsSync(path.join(dash, 'manifest.json'))) return { dir: dash, kind: 'dashboard' };
  return null;
}

/**
 * 扫描目录逐包校验（与 verify-plugins.js 旧的 scan() 语义一致）。递归仅一层。
 *
 * 2026-09-30 深度检查修复（门禁空转）: 此前两种"静默通过"使门禁形同虚设——
 *   1. 目录不存在 → 返回 total 0 而脚本照打「全部通过 ✓」（plugins/bundled 实际缺失）；
 *   2. 目录内无 manifest 的包直接 continue（plugins/example-dashboard 等被无声跳过）。
 * 现改为显式对账：`missingDirs`（目录整体缺失，由调用方按必需性决定是否 fail）与
 * `skipped`（无 manifest 而跳过的目录名，调用方计入 fail），让"覆盖了多少"可见。
 *
 * @param {string} rootDir
 * @param {{requireDir?: boolean}} [opts] requireDir=true 时目录缺失视为失败项
 * @returns {{total: number, failed: number, results: Array, missingDirs: string[], skipped: string[]}}
 */
function verifyPluginsInDir(rootDir, opts = {}) {
  const results = [];
  const skipped = [];
  const missingDirs = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (e) {
    // 目录不存在/不可读 → 返回 missingDirs 由调用方按必需性裁决（不再静默通过）。
    // 此处不打日志：调用方会给出面向人的结论，避免同一事实被打印两次（曾污染 stderr）。
    missingDirs.push(rootDir);
    return { total: 0, failed: opts.requireDir ? 1 : 0, results, missingDirs, skipped };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(rootDir, e.name);
    const target = resolveVerifiableDir(dir);
    if (!target) {
      // 无任何可校验清单：登记并由调用方计入失败（要求补清单或移出 plugins/）
      skipped.push(e.name);
      continue;
    }
    const r = verifyPlugin(target.dir);
    results.push({ dir: target.dir, name: e.name, valid: r.valid, errors: r.errors, warnings: r.warnings, trustLevel: r.trustLevel, kind: target.kind });
  }
  // 无 manifest 目录计入 failed：门禁必须能回答"仓库里的插件目录是否都被校验过"
  return { total: results.length, failed: results.filter(r => !r.valid).length + skipped.length, results, missingDirs, skipped };
}

/**
 * 按 profile 清单校验（profile 未配置 → 回退全量 plugins/ 根）——verify-plugins.js --profile 语义移入。
 * 缺失引用目录不 fail 于 lib 内，而是计入 missingRefs（`${layer}/${name}`）——B6 门禁
 * 「profile 引用缺失目录 → fail」语义由脚本侧对账保留（failed += missingRefs.length）。
 * 空清单返回 total 0（「门禁拒绝空通过」的 exit 1 语义由脚本侧保留，不在 lib 内回退全量）。
 * @param {object|null} profileConfig config.yaml plugins.profiles.<name> 已解析对象
 * @param {string} profileArg 仅供语义注释（错误文案由脚本侧拼接）
 * @param {{builtin: string, bundled: string, user: string}} layerDirs
 * @returns {{total, failed, results, missingRefs: string[]}}
 */
function verifyPluginsByProfile(profileConfig, profileArg, layerDirs) {
  if (!profileConfig || typeof profileConfig !== 'object') return verifyPluginsInDir(layerDirs.builtin);
  const seen = new Set();
  const results = [];
  const missingRefs = [];
  const skipped = [];
  for (const layer of ['builtin', 'bundled', 'user']) {
    const names = profileConfig[layer];
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      const dir = path.join(layerDirs[layer], name);
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        missingRefs.push(`${layer}/${name}`);  // 引用缺失 → 计入 missingRefs（脚本侧对账 fail）
        continue;
      }
      const hasManifest = resolveVerifiableDir(dir);
      if (!hasManifest) {
        // 2026-09-30: profile 显式点名但无任何可校验清单的目录也要可见（此前会静默通过）
        skipped.push(`${layer}/${name}`);
        continue;
      }
      const r = verifyPlugin(hasManifest.dir);
      results.push({ dir, name: `${layer}/${name}`, valid: r.valid, errors: r.errors, warnings: r.warnings, trustLevel: r.trustLevel });
    }
  }
  return { total: results.length, failed: results.filter(r => !r.valid).length + skipped.length, results, missingRefs, skipped };
}

module.exports = { verifyPluginsInDir, verifyPluginsByProfile };
