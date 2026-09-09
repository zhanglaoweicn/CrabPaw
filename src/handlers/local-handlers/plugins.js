// plugins.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { sendJson } = require('../http-utils');

// ============================================================================
// 仪表盘插件 API
// ============================================================================

const dashboardPluginScanner = require('../../core/dashboard-plugin-scanner');
const { getPluginManager } = require('../../core/plugin-system');
// 2026-08-24: handlePluginUiContributions 已删除——前端 PluginBridge 无消费者
// (ui-contributions 死链); 插件 dashboard 管理 API 保留(管理舱「插件」tab 活)

async function handleDashboardPlugins(req, res, _ctx) {
  try {
    const plugins = await dashboardPluginScanner.discoverDashboardPlugins();
    sendJson(res, 200, { success: true, plugins });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleDashboardPluginsRescan(req, res, _ctx) {
  try {
    const plugins = await dashboardPluginScanner.discoverDashboardPlugins(true);
    sendJson(res, 200, { success: true, plugins, message: 'rescanned' });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleDashboardPluginStatic(req, res, ctx) {
  try {
    // URL 格式: /dashboard-plugins/<pluginName>/<filePath>
    const urlPath = ctx.pathname;
    const parts = urlPath.replace('/dashboard-plugins/', '').split('/');
    const pluginName = parts[0];
    const filePath = parts.slice(1).join('/');

    if (!pluginName || !filePath) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const absolutePath = dashboardPluginScanner.getPluginStaticPath(pluginName, filePath);
    if (!absolutePath) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    // 安全检查：确保路径在插件目录内
    const resolved = path.resolve(absolutePath);
    if (!resolved.startsWith(path.resolve(dashboardPluginScanner.USER_PLUGINS_DIR)) &&
        !resolved.startsWith(path.resolve(dashboardPluginScanner.BUILTIN_PLUGINS_DIR))) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // 根据扩展名设置 Content-Type
    const ext = path.extname(absolutePath).toLowerCase();
    const contentTypes = {
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.html': 'text/html',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };

    const contentType = contentTypes[ext] || 'application/octet-stream';
    const content = fs.readFileSync(absolutePath);

    res.writeHead(200, {
      'Content-Type': contentType + (ext === '.js' || ext === '.css' ? '; charset=utf-8' : ''),
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end('Internal server error');
  }
}

// 插件 API 路由缓存
const pluginApiCache = new Map();

async function handlePluginApi(req, res, ctx) {
  try {
    // URL 格式: /api/plugins/<pluginName>/<route>
    const urlPath = ctx.pathname;
    const parts = urlPath.replace('/api/plugins/', '').split('/');
    const pluginName = parts[0];
    const routePath = '/' + parts.slice(1).join('/');

    if (!pluginName) {
      sendJson(res, 400, { success: false, message: '缺少插件名称' });
      return;
    }

    // 查找插件 API 路由文件
    const apiPath = await dashboardPluginScanner.getPluginApiPath(pluginName);
    if (!apiPath) {
      sendJson(res, 404, { success: false, message: 'Resource not found' });
      return;
    }

    // 安全检查
    const resolved = path.resolve(apiPath);
    if (!resolved.startsWith(path.resolve(dashboardPluginScanner.USER_PLUGINS_DIR)) &&
        !resolved.startsWith(path.resolve(dashboardPluginScanner.BUILTIN_PLUGINS_DIR))) {
      sendJson(res, 403, { success: false, message: 'Forbidden' });
      return;
    }

    // 加载或获取缓存的 API 模块
    let apiModule = pluginApiCache.get(apiPath);
    if (!apiModule) {
      // 清除 require 缓存以支持热更新
      delete require.cache[resolved];
      apiModule = require(resolved);
      pluginApiCache.set(apiPath, apiModule);
    }

    // API 模块应导出 routes 对象: { 'GET /data': async (req, ctx) => ({...}), ... }
    if (!apiModule.routes || typeof apiModule.routes !== 'object') {
      sendJson(res, 500, { success: false, message: 'Resource not found' });
      return;
    }

    // 查找匹配的路由
    const method = req.method || 'GET';
    const routeKey = `${method.toUpperCase()} ${routePath}`;
    const wildcardKey = `${method.toUpperCase()} /*`;

    let handler = apiModule.routes[routeKey] || apiModule.routes[wildcardKey];

    if (!handler) {
      // 尝试前缀匹配
      for (const [key, fn] of Object.entries(apiModule.routes)) {
        const [routeMethod, routePattern] = key.split(' ');
        if (routeMethod !== method.toUpperCase()) continue;
        if (routePattern.endsWith('/*')) {
          const basePattern = routePattern.slice(0, -2);
          const requestPath = req.url.split('?')[0].replace(/^\/api\/plugin\/[^/]+/, '');
          if (requestPath.startsWith(basePattern)) {
            handler = fn;
            break;
          }
        }
      }
      if (!handler) {
        sendJson(res, 404, { success: false, message: `No matching route: ${routeKey}` });
        return;
      }
    }

    // 解析请求体（如果有）
    let body = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await new Promise((resolve, reject) => {
          let data = '';
          req.on('data', chunk => { data += chunk; });
          req.on('end', () => {
            try { resolve(data ? JSON.parse(data) : {}); }
            catch (e) { console.debug('[request-handler] JSON parse error:', e.message); resolve({}); }
          });
          req.on('error', reject);
        });
      } catch (e) {
        console.debug('[request-handler] body parse error:', e.message); }
    }

    // 调用插件路由处理函数
    const pluginReq = {
      method,
      path: routePath,
      query: Object.fromEntries(ctx.url.searchParams),
      body,
      headers: req.headers,
    };

    const result = await handler(pluginReq, ctx);
    sendJson(res, 200, { success: true, data: result });
  } catch (e) {
    console.error('插件 API 路由错误:', e);
    sendJson(res, 500, { success: false, message: e.message });
  }
}

/* ─── 专家面板 API ─── */
/* ─── 插件管理 API ─── */
async function handleAssemblyView(req, res, _ctx) {
  try {
    const { buildAssemblyView } = require('../../core/plugin/assembly-view');
    sendJson(res, 200, { success: true, ...(await buildAssemblyView()) });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handlePluginManagerList(req, res, _ctx) {
  try {
    const pm = await getPluginManager();
    const list = pm.listAll();
    sendJson(res, 200, { success: true, data: { plugins: list } });
  } catch (e) {
    sendJson(res, 200, { success: true, data: { plugins: [] } });
  }
}

async function handlePluginManagerAction(req, res, ctx) {
  try {
    const match = ctx.url.pathname.match(/^\/api\/plugin-manager\/([^/]+)\/(enable|disable)$/);
    const name = match?.[1];
    const action = match?.[2];
    if (!name || !action) return sendJson(res, 400, { success: false, message: 'Missing plugin name or action' });
    const pm = await getPluginManager();
    await pm[action](name);
    sendJson(res, 200, { success: true });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handlePluginManagerEnable(req, res, _ctx) {
  try {
    const match = req.url.match(/^\/api\/plugin-manager\/([^/]+)\/enable$/);
    const name = match ? match[1] : null;
    if (!name) return sendJson(res, 400, { success: false, message: '缺少插件名称' });
    const pm = await getPluginManager();
    await pm.enable(name);
    sendJson(res, 200, { success: true });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handlePluginManagerDisable(req, res, _ctx) {
  try {
    const match = req.url.match(/^\/api\/plugin-manager\/([^/]+)\/disable$/);
    const name = match ? match[1] : null;
    if (!name) return sendJson(res, 400, { success: false, message: '缺少插件名称' });
    const pm = await getPluginManager();
    await pm.disable(name);
    sendJson(res, 200, { success: true });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

module.exports = {
  handleDashboardPlugins,
  handleDashboardPluginsRescan,
  handleDashboardPluginStatic,
  handlePluginApi,
  handleAssemblyView,
  handlePluginManagerList,
  handlePluginManagerAction,
  handlePluginManagerEnable,
  handlePluginManagerDisable,
};
