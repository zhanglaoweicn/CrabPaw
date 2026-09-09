/**
 * manifest-registry.js — 技能清单收编面（Phase 3d 剩余, 2026-08-25）
 *
 * 声明不新建加载路径（三加载器职责域不同——每轮注入/管理面板/编辑器市场，前轮裁定不合一）；
 * 本模块只是"清单面 + 一致性校验"：skills/manifest.json（bundles + noExecutor）与
 * 目录实况、技能扫描结果的交叉校验——发现"声明了但不存在/漏声明"的漂移, 提前告警。
 * 输出 clean 语义供技能面板/路由查询（listSkillsFlat 只读清单面）。
 */
const fs = require('fs');
const path = require('path');

const SKILLS_MANIFEST_PATH = path.resolve(__dirname, '..', '..', '..', 'skills', 'manifest.json');
const SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', 'skills');
const GLOBAL_SKILLS_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'skills');

/** 读清单（缺省返回 null——未声明时校验器视为"全部技能自由"模式） */
function loadSkillManifest(manifestPath = SKILLS_MANIFEST_PATH) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.warn('[skills-manifest] 清单读取失败(不阻塞):', e.message);
    return null;
  }
}

/** 目录内技能名集合（顶层目录 + frontmatter 名——以目录名近似, SKILL.md 存在校验） */
function listSkillDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name);
  } catch { return []; }
}

/**
 * 交叉校验：清单声明 ↔ 目录实况。
 * @returns {{valid: boolean, problems: string[], counts: {bundled: number, global: number, declared: number}}}
 */
function validateSkillManifest(manifest, opts = {}) {
  const problems = [];
  const bundled = listSkillDirs(opts.skillsDir || SKILLS_DIR);
  const global = listSkillDirs(opts.globalSkillsDir || GLOBAL_SKILLS_DIR);

  if (!manifest) {
    return { valid: false, problems: ['skills/manifest.json 不存在'], counts: { bundled: bundled.length, global: global.length, declared: 0 } };
  }

  const declared = new Set();
  for (const bundle of Object.values(manifest.bundles || {})) {
    for (const name of bundle.skills || []) declared.add(name);
  }
  for (const name of manifest.noExecutor || []) declared.add(name);

  for (const name of declared) {
    if (!bundled.includes(name) && !global.includes(name)) {
      problems.push(`清单声明但不存在: ${name}`);
    }
  }
  // 目录存在但未声明（仅告警清单面——自由技能可持续补充）
  const undeclared = bundled.filter((n) => !declared.has(n));
  if (undeclared.length > 0) {
    problems.push(`未声明技能 ${undeclared.length} 个: ${undeclared.slice(0, 5).join(',')}${undeclared.length > 5 ? '…' : ''}`);
  }

  return { valid: problems.length === 0, problems, counts: { bundled: bundled.length, global: global.length, declared: declared.size } };
}

/** 扁平清单面（bundle/noExecutor/目录三源合并——只读, 供路由/面板展示） */
function listSkillsFlat(manifest) {
  const out = [];
  for (const [bundleId, bundle] of Object.entries(manifest?.bundles || {})) {
    for (const name of bundle.skills || []) {
      out.push({ name, bundle: bundleId, noExecutor: false });
    }
  }
  for (const name of manifest?.noExecutor || []) {
    out.push({ name, bundle: 'noExecutor', noExecutor: true });
  }
  return out;
}

module.exports = { loadSkillManifest, validateSkillManifest, listSkillsFlat };
