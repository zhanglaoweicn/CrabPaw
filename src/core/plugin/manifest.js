/**
 * Plugin Manifest 解析器
 *
 * 负责读取、解析、校验插件清单文件（manifest.yaml / plugin.yaml / plugin.json）。
 * 支持新 v2 格式（contributions 段）和旧格式（v1 兼容）。
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const MANIFEST_FILES = ['manifest.yaml', 'manifest.yml', 'plugin.yaml', 'plugin.yml', 'plugin.json'];
const PLUGIN_KINDS = ['plugin', 'skill', 'combined'];
// 2026-08-01: skills/middleware 移出支持列表（明确废弃）——
// 技能体系以 skills.js（SKILL.md 提示词）为主入口，插件代码技能与其架构不兼容；
// 中间件贡献需要 harnessHooks 注册接口（不存在）。声明即校验告警。
const VALID_CONTRIBUTION_KEYS = ['tools', 'events', 'services', 'routes', 'settings', 'permissions', 'skills', 'middleware'];
const UNSUPPORTED_CONTRIBUTION_KEYS = ['skills', 'middleware'];

/**
 * 读取并解析插件清单
 */
async function readManifest(pluginDir) {
  for (const filename of MANIFEST_FILES) {
    const filePath = path.join(pluginDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      let manifest;
      if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
        manifest = yaml.load(content);
      } else {
        manifest = JSON.parse(content);
      }
      if (manifest && manifest.name) {
        manifest._dir = pluginDir;
        manifest._manifestFile = filename;
        return manifest;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      if (e instanceof yaml.YAMLException || e instanceof SyntaxError) {
        console.warn(`[Manifest] 解析 ${filename} 失败: ${e.message}`);
        continue;
      }
      continue;
    }
  }
  return null;
}

/**
 * 校验插件清单
 */
function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest) {
    errors.push('Manifest 为空');
    return { valid: false, errors, warnings };
  }

  if (!manifest.name) {
    errors.push('缺少必需字段: name');
  } else if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(manifest.name)) {
    errors.push(`name "${manifest.name}" 格式无效`);
  }

  // 2026-08-27 B3-1: reserved 前缀禁名（纵深防御）——防「builtin-evil」伪名绕过
  // 层信任判定（permission-enforce.resolveLayer 的 entry.layer 权威标记）失效时兜底
  if (manifest.name && /^(builtin|bundled|plugin)([-_]|$)/i.test(manifest.name)) {
    errors.push('name 不得以 reserved 前缀(builtin/bundled/plugin)开头');
  }

  if (!manifest.version) {
    warnings.push('缺少建议字段: version，默认使用 0.0.1');
    manifest.version = '0.0.1';
  }

  if (manifest.kind && !PLUGIN_KINDS.includes(manifest.kind)) {
    warnings.push(`kind "${manifest.kind}" 非标准值，可选: ${PLUGIN_KINDS.join(', ')}`);
  }

  // 2026-08-27 B2-2: 依赖声明契约——inject/provides 必须为字符串数组。
  // 非数组/含非字符串 → error（与 SDK assertPluginContract 口径一致: 契约违反是错误而非告警）
  for (const key of ['inject', 'provides']) {
    if (manifest[key] === undefined || manifest[key] === null) continue;
    if (!Array.isArray(manifest[key])) {
      errors.push(`${key} 必须是字符串数组`);
    } else if (manifest[key].some((v) => typeof v !== 'string')) {
      errors.push(`${key} 必须只包含字符串`);
    }
  }

  // 2026-08-27 B3 files 接线: contributes.tools[].fileParams 注解（非数组/含非字符串 → error）
  // 注解工具哪些参数是文件路径参数，供 permission-enforce files 分支按 permissions.files 校验。
  if (manifest.contributes?.tools && Array.isArray(manifest.contributes.tools)) {
    for (const t of manifest.contributes.tools) {
      if (t && t.fileParams !== undefined && (!Array.isArray(t.fileParams) || t.fileParams.some((f) => typeof f !== 'string'))) {
        errors.push(`工具 ${t.name || '?'} 的 fileParams 必须为字符串数组`);
      }
    }
  }

  if (manifest.contributions) {
    for (const key of Object.keys(manifest.contributions)) {
      if (UNSUPPORTED_CONTRIBUTION_KEYS.includes(key)) {
        warnings.push(`contributions.${key} 贡献类型已废弃（2026-08-01）：技能体系以 skills.js 为主入口，中间件需 harnessHooks 接口，该贡献将被忽略`);
        continue;
      }
      if (!VALID_CONTRIBUTION_KEYS.includes(key)) {
        warnings.push(`contributions 中的 "${key}" 不是标准贡献点，将被忽略`);
        continue;
      }
      if (!Array.isArray(manifest.contributions[key])) {
        errors.push(`contributions.${key} 必须是数组`);
      }
    }
    if (manifest.contributions.tools) {
      for (const [i, t] of manifest.contributions.tools.entries()) {
        if (!t.name) errors.push(`contributions.tools[${i}] 缺少 name`);
        if (!t.handler) errors.push(`contributions.tools[${i}] 缺少 handler`);
      }
    }
    if (manifest.contributions.events) {
      for (const [i, e] of manifest.contributions.events.entries()) {
        if (!e.on) errors.push(`contributions.events[${i}] 缺少 on`);
        if (!e.handler) errors.push(`contributions.events[${i}] 缺少 handler`);
      }
    }
    if (manifest.contributions.routes) {
      for (const [i, r] of manifest.contributions.routes.entries()) {
        if (!r.path) errors.push(`contributions.routes[${i}] 缺少 path`);
        if (!r.component) errors.push(`contributions.routes[${i}] 缺少 component`);
      }
    }
    if (manifest.contributions.settings) {
      for (const [i, s] of manifest.contributions.settings.entries()) {
        if (!s.id) errors.push(`contributions.settings[${i}] 缺少 id`);
        if (!s.component) errors.push(`contributions.settings[${i}] 缺少 component`);
      }
    }
  }

  if (manifest.lifecycle && manifest.kind === 'skill' && manifest.lifecycle.onLoad) {
    warnings.push('kind 为 "skill" 的插件通常不需要 lifecycle.onLoad');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 检查目录是否包含插件清单
 */
async function hasManifest(dir) {
  for (const filename of MANIFEST_FILES) {
    try {
      await fs.access(path.join(dir, filename));
      return true;
    } catch (e) { continue; }
  }
  return false;
}

function hasManifestSync(dir) {
  for (const filename of MANIFEST_FILES) {
    if (fsSync.existsSync(path.join(dir, filename))) return true;
  }
  return false;
}

module.exports = {
  readManifest,
  validateManifest,
  hasManifest,
  hasManifestSync,
  MANIFEST_FILES,
  PLUGIN_KINDS,
  VALID_CONTRIBUTION_KEYS,
};
