/**
 * Plugin System — 插件系统入口（barrel）
 *
 * 统一导出所有插件子系统：
 *   manifest  — 插件 Manifest 解析器
 *   UIRegistry — 前端贡献注册中心
 *   PluginManager — 插件生命周期管理器（贡献转接器模式）
 *
 * 2026-08-01 修复：此前导入不存在的 loadManifest/validatePluginDir/findManifest
 * （实际导出为 readManifest/validateManifest/hasManifestSync）与不存在的
 * resetPluginManager，解构结果全部为 undefined。
 */
const { getPluginManager, PluginManager } = require('./plugin-manager');
const { getUIRegistry, UIRegistry, resetUIRegistry } = require('./ui-registry');
const {
  readManifest,
  validateManifest,
  hasManifest,
  hasManifestSync,
  MANIFEST_FILES,
  PLUGIN_KINDS,
  VALID_CONTRIBUTION_KEYS,
} = require('./manifest');

module.exports = {
  getPluginManager,
  PluginManager,
  getUIRegistry,
  UIRegistry,
  resetUIRegistry,
  readManifest,
  validateManifest,
  hasManifest,
  hasManifestSync,
  MANIFEST_FILES,
  PLUGIN_KINDS,
  VALID_CONTRIBUTION_KEYS,
};
