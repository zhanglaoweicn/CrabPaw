/**
 * 仪表盘插件扫描器
 *
 * 扫描插件目录中的 dashboard/manifest.json，
 * 返回前端可用的插件元数据列表。
 *
 * 插件目录结构：
 *   ~/.crabpaw/plugins/<name>/dashboard/manifest.json
 *   ~/.crabpaw/plugins/<name>/dashboard/dist/index.js
 *   ~/.crabpaw/plugins/<name>/dashboard/dist/style.css  (可选)
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const config = require('./config');

const BUILTIN_PLUGINS_DIR = path.join(__dirname, '..', '..', 'plugins');
const USER_PLUGINS_DIR = path.join(config.DATA_DIR, 'plugins');

// 支持的 Lucide 图标白名单
const ALLOWED_ICONS = [
  'Activity', 'BarChart3', 'Clock', 'Code', 'Database', 'Eye',
  'FileText', 'Globe', 'Heart', 'KeyRound', 'MessageSquare',
  'Package', 'Puzzle', 'Settings', 'Shield', 'Sparkles', 'Star',
  'Terminal', 'Wrench', 'Zap',
];

// 缓存
let cachedPlugins = null;
let cacheTime = 0;
const CACHE_TTL = 30000; // 30秒缓存

/**
 * 验证 manifest.json 格式
 */
function validateManifest(manifest, _pluginName) {
  const errors = [];

  if (!manifest.name || typeof manifest.name !== 'string') {
    errors.push('缺少 name 字段');
  }
  if (!manifest.label || typeof manifest.label !== 'string') {
    errors.push('缺少 label 字段');
  }
  if (!manifest.tab || !manifest.tab.path || typeof manifest.tab.path !== 'string') {
    errors.push('缺少 tab.path 字段');
  }
  if (!manifest.entry || typeof manifest.entry !== 'string') {
    errors.push('缺少 entry 字段');
  }
  // tab.path 必须以 / 开头
  if (manifest.tab && manifest.tab.path && !manifest.tab.path.startsWith('/')) {
    errors.push('tab.path 必须以 / 开头');
  }

  return errors;
}

/**
 * 扫描单个插件目录
 */
async function scanPluginDir(pluginDir, source) {
  const dashboardDir = path.join(pluginDir, 'dashboard');
  const manifestPath = path.join(dashboardDir, 'manifest.json');

  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content);

    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      console.warn(`⚠️ 插件 ${manifest.name || pluginDir} manifest 验证失败:`, errors.join(', '));
      return null;
    }

    // 验证入口文件存在
    const entryPath = path.join(dashboardDir, manifest.entry);
    if (!fsSync.existsSync(entryPath)) {
      console.warn(`⚠️ 插件 ${manifest.name} 入口文件不存在: ${manifest.entry}`);
      return null;
    }

    // 验证 CSS 文件存在（如果声明了）
    let cssExists = false;
    if (manifest.css) {
      const cssPath = path.join(dashboardDir, manifest.css);
      cssExists = fsSync.existsSync(cssPath);
    }

    // 规范化图标
    const icon = ALLOWED_ICONS.includes(manifest.icon) ? manifest.icon : 'Puzzle';

    return {
      name: manifest.name,
      label: manifest.label,
      description: manifest.description || '',
      icon,
      version: manifest.version || '1.0.0',
      tab: {
        path: manifest.tab.path,
        position: manifest.tab.position || 'end',
      },
      entry: manifest.entry,
      css: manifest.css || null,
      cssExists,
      api: manifest.api || null,
      source,
      basePath: dashboardDir,
    };
  } catch (e) {
    // manifest.json 不存在或解析失败，跳过
    return null;
  }
}

/**
 * 扫描目录下所有插件
 */
async function scanDir(dir, source) {
  const results = [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return results; // 目录不存在
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const plugin = await scanPluginDir(pluginDir, source);
    if (plugin) {
      results.push(plugin);
    }
  }

  return results;
}

/**
 * 发现所有仪表盘插件
 * @param {boolean} forceRefresh - 强制刷新缓存
 * @returns {Promise<Array>} 插件列表
 */
async function discoverDashboardPlugins(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedPlugins && (now - cacheTime) < CACHE_TTL) {
    return cachedPlugins;
  }

  // 扫描内置插件和用户插件
  const [builtinPlugins, userPlugins] = await Promise.all([
    scanDir(BUILTIN_PLUGINS_DIR, 'builtin'),
    scanDir(USER_PLUGINS_DIR, 'user'),
  ]);

  // 用户插件优先（同名覆盖内置）
  const pluginMap = new Map();
  for (const p of builtinPlugins) {
    pluginMap.set(p.name, p);
  }
  for (const p of userPlugins) {
    pluginMap.set(p.name, p); // 覆盖内置
  }

  cachedPlugins = [...pluginMap.values()];
  cacheTime = now;

  console.log(`🔌 发现 ${cachedPlugins.length} 个仪表盘插件`);
  return cachedPlugins;
}

/**
 * 获取插件静态文件路径
 * @param {string} pluginName - 插件名称
 * @param {string} filePath - 相对文件路径
 * @returns {string|null} 绝对路径
 */
function getPluginStaticPath(pluginName, filePath) {
  // 先查用户目录，再查内置目录
  const userPath = path.join(USER_PLUGINS_DIR, pluginName, 'dashboard', filePath);
  if (fsSync.existsSync(userPath)) {
    return userPath;
  }

  const builtinPath = path.join(BUILTIN_PLUGINS_DIR, pluginName, 'dashboard', filePath);
  if (fsSync.existsSync(builtinPath)) {
    return builtinPath;
  }

  return null;
}

/**
 * 获取插件 API 路由文件路径
 * @param {string} pluginName - 插件名称
 * @returns {string|null} API 路由文件绝对路径
 */
async function getPluginApiPath(pluginName) {
  // 先从已发现的插件中查找
  const plugins = await discoverDashboardPlugins();
  const plugin = plugins.find(p => p.name === pluginName);
  if (!plugin || !plugin.api) {
    return null;
  }

  const apiPath = path.join(plugin.basePath, plugin.api);
  if (fsSync.existsSync(apiPath)) {
    return apiPath;
  }

  return null;
}

module.exports = {
  discoverDashboardPlugins,
  getPluginStaticPath,
  getPluginApiPath,
  BUILTIN_PLUGINS_DIR,
  USER_PLUGINS_DIR,
  ALLOWED_ICONS,
};
