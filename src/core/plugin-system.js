/**
 * 插件系统 v2 → v3 桥接模块
 *
 * 保持向后兼容的导出接口。
 * 所有新代码应直接使用 src/core/plugin/ 下的模块。
 */

const { getLogger } = require('../core/logger');
const log = getLogger('core-plugin-system');

const { PluginManager: PluginManagerV3, getPluginManager: getPluginManagerV3 } = require('./plugin/plugin-manager');
const { readManifest, validateManifest, PLUGIN_KINDS } = require('./plugin/manifest');

// ─── 保留的旧接口基类（供现有 plugins/model-providers/ 使用） ───

class PluginInterface {
  constructor(manifest) { this.manifest = manifest; this.enabled = false; this.initialized = false; this.kind = manifest.kind || 'general'; }
  async init() { this.initialized = true; }
  async start() { this.enabled = true; }
  async stop() { this.enabled = false; }
  async unload() { this.initialized = false; this.enabled = false; }
}

class ModelProviderPlugin extends PluginInterface {
  constructor(manifest) { super(manifest); this.kind = 'model-provider'; this.adapter = null; }
  async init() { await super.init(); }
  getAdapter() { return this.adapter; }
}

class PlatformPlugin extends PluginInterface {
  constructor(manifest) { super(manifest); this.kind = 'platform'; this.client = null; }
  async start() { await super.start(); }
  async stop() { await super.stop(); }
  getClient() { return this.client; }
}

class MemoryPlugin extends PluginInterface {
  constructor(manifest) { super(manifest); this.kind = 'memory'; this.provider = null; }
  async init() { await super.init(); }
  getProvider() { return this.provider; }
}

function checkEnvRequirements(manifest) {
  const missing = []; const warnings = [];
  if (manifest.requires_env) {
    for (const env of manifest.requires_env) {
      const envName = typeof env === 'string' ? env : env.name;
      if (!process.env[envName]) missing.push({ name: envName, description: typeof env === 'string' ? '' : env.description, prompt: typeof env === 'string' ? '' : env.prompt });
    }
  }
  if (manifest.optional_env) {
    for (const env of manifest.optional_env) {
      const envName = typeof env === 'string' ? env : env.name;
      if (!process.env[envName]) warnings.push({ name: envName, description: typeof env === 'string' ? '' : env.description });
    }
  }
  return { missing, warnings, satisfied: missing.length === 0 };
}

const BUILTIN_PLUGINS_DIR = PluginManagerV3.BUILTIN_PLUGINS_DIR;
const USER_PLUGINS_DIR = PluginManagerV3.USER_PLUGINS_DIR;

module.exports = {
  getPluginManager: getPluginManagerV3,
  PluginInterface, ModelProviderPlugin, PlatformPlugin, MemoryPlugin,
  PluginManager: PluginManagerV3,
  PLUGIN_KINDS, BUILTIN_PLUGINS_DIR, USER_PLUGINS_DIR,
  validateManifest, checkEnvRequirements, readManifest,
};

log.info('🔌 插件系统 v3 桥接就绪 (v2 接口保持兼容)');
