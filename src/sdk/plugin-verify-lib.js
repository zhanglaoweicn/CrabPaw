/**
 * plugin-verify-lib.js — 插件集市校验库（2026-08-27 CLI 轮）。
 * verifyPluginsInDir / verifyPluginsByProfile —— npm run plugin:verify 与 crabpaw plugin verify 共享，
 * 行为与 scripts/verify-plugins.js 保持一致（无 manifest 目录跳过/任一 invalid → failed 计数）。
 */
const fs = require('fs');
const path = require('path');
const { verifyPlugin } = require('./plugin-sdk');

/**
 * 扫描目录逐包校验（与 verify-plugins.js 旧的 scan() 语义一致）。递归仅一层。
 * @param {string} rootDir
 * @returns {{total: number, failed: number, results: Array<{dir, name, valid, errors, warnings, trustLevel}>}}
 */
function verifyPluginsInDir(rootDir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (e) {
    // 目录不存在/不可读 → 静默空结果（脚本侧保留 B6 的扫描失败 warn 语义, 此处 debug 日志兜底）
    console.debug('[plugin-verify-lib] 扫描目录失败:', e && e.message);
    return { total: 0, failed: 0, results: [] };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(rootDir, e.name);
    const hasManifest = fs.existsSync(path.join(dir, 'manifest.yaml'))
      || fs.existsSync(path.join(dir, 'manifest.json'));
    if (!hasManifest) continue;  // 遗留 dashboard 类目录跳过——旧体系
    const r = verifyPlugin(dir);
    results.push({ dir, name: e.name, valid: r.valid, errors: r.errors, warnings: r.warnings, trustLevel: r.trustLevel });
  }
  return { total: results.length, failed: results.filter(r => !r.valid).length, results };
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
      const r = verifyPlugin(dir);
      results.push({ dir, name: `${layer}/${name}`, valid: r.valid, errors: r.errors, warnings: r.warnings, trustLevel: r.trustLevel });
    }
  }
  return { total: results.length, failed: results.filter(r => !r.valid).length, results, missingRefs };
}

module.exports = { verifyPluginsInDir, verifyPluginsByProfile };
