/**
 * plugin-sdk.js — @crabpaw/plugin-sdk 骨架（Phase 0, 2026-08-25）
 *
 * 目标：第三方插件（商业生态）的统一开发面——自描述清单 + 生命周期 + 贡献点。
 * 本文件为骨架（蓝图/校验/工具），运行时接线在 Phase 1-2（Cordis 树承载）。
 *
 * 设计对齐（V2 主纲 D9）：
 * - createPlugin({name, version, inject, provides, contributes}) → 插件清单对象
 * - 贡献点（contributes）与 manifest 字段一一对应：tools/panels/providers/events/exports/skills/dataSources
 * - 生命周期约定：onLoad/onStart/onStop/onUnload（函数体），全部可逆（disposer）
 * - 校验器：assertPluginContract(plugin) —— fail-loud 前置门（对齐 verify-cordis-config 姿态）
 */

const ALLOWED_CONTRIBUTE_KEYS = new Set(['tools', 'panels', 'providers', 'events', 'exports', 'skills', 'dataSources']);
const REQUIRED_PLUGIN_FIELDS = ['name', 'version'];

/** 校验插件契约（清单+实现一致性），返回 {valid, errors} */
function assertPluginContract(plugin) {
  const errors = [];
  if (!plugin || typeof plugin !== 'object') {
    return { valid: false, errors: ['plugin 必须为对象'] };
  }
  for (const field of REQUIRED_PLUGIN_FIELDS) {
    if (typeof plugin[field] !== 'string' || !plugin[field].trim()) {
      errors.push(`缺少必需字段: ${field}`);
    }
  }
  if (!/^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(plugin.name || '')) {
    errors.push('name 仅允许 [a-z0-9_-] 且首尾为字母数字');
  }
  for (const key of Object.keys(plugin.contributes || {})) {
    if (!ALLOWED_CONTRIBUTE_KEYS.has(key)) {
      errors.push(`contributes.${key} 不是标准贡献点（可选: ${[...ALLOWED_CONTRIBUTE_KEYS].join('/')}）`);
    }
  }
  for (const phase of ['onLoad', 'onStart', 'onStop', 'onUnload']) {
    if (plugin.lifecycle && phase in plugin.lifecycle && typeof plugin.lifecycle[phase] !== 'function') {
      errors.push(`lifecycle.${phase} 必须为函数`);
    }
  }
  if (plugin.inject && !Array.isArray(plugin.inject)) {
    errors.push('inject 必须为字符串数组（声明所需服务名）');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * 创建插件清单（约定优于配置）。
 * @param {{name: string, version: string, description?: string, inject?: string[],
 *          provides?: string[], contributes?: object, lifecycle?: object}} spec
 */
function createPlugin(spec) {
  const plugin = { ...spec };
  const check = assertPluginContract(plugin);
  if (!check.valid) {
    throw new Error(`[plugin-sdk] 插件契约不合规: ${check.errors.join('; ')}`);
  }
  return plugin;
}

/**
 * verifyPlugin — 插件包信任/契约一次性校验（Phase 4b：`crabpaw plugin verify` 内核）。
 * 读插件目录 manifest.yaml/json → 契约校验 + 信任门禁（requiresHarness/signature/permissions）。
 * @param {string} pluginDir 插件包目录
 * @returns {{valid: boolean, errors: string[], warnings: string[], trustLevel: string}}
 */
function verifyPlugin(pluginDir) {
  const fs = require('fs');
  const path = require('path');
  const yaml = require('js-yaml');
  const { checkPluginTrust } = require('../core/plugin/trust-check');

  let manifest = null;
  for (const fn of ['manifest.yaml', 'manifest.yml', 'manifest.json']) {
    const fp = path.join(pluginDir, fn);
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8');
      manifest = fn.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
      break;
    }
  }
  const errors = [];
  if (!manifest) errors.push('未找到 manifest.yaml/json');
  const contract = assertPluginContract(manifest || {});
  errors.push(...contract.errors);
  const trust = manifest ? checkPluginTrust(manifest) : { ok: false, errors: [], warnings: [], trustLevel: 'unknown' };
  errors.push(...(trust.ok ? [] : [trust.errors.join('; ')]));
  return { valid: errors.length === 0, errors, warnings: trust.warnings || [], trustLevel: trust.trustLevel };
}

module.exports = { createPlugin, assertPluginContract, verifyPlugin, ALLOWED_CONTRIBUTE_KEYS };
