// tools.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');

// 通用工具执行端点 — 用于前端直接调用 TextToSpeech 等已注册工具
async function handleToolExecute(req, res, ctx) {
  try {
    const match = ctx.url.pathname.match(/^\/api\/tools\/([^/]+)$/);
    const toolName = match ? match[1] : null;
    if (!toolName) return sendJson(res, 400, { success: false, error: '缺少工具名' });

    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { success: false, error: '请求体为空' });

    const { registry } = require('../../tools/registry');
    const tool = registry.get(toolName);
    if (!tool || typeof tool.handler !== 'function') {
      return sendJson(res, 404, { success: false, error: `工具不存在: ${toolName}` });
    }
    // 2026-08-15 P1-2 修复: 此前直调 tool.handler(body, {}) 绕过契约校验/权限/
    // 审批/熔断/超时/缓存/审计——HTTP 入口可无门槛执行任意高危工具。
    // 改为走 registry.execute 主执行路径(checkFn → 契约校验 → 权限策略 →
    // 审批(审批系统不可用时 registry 内置 fail-closed 拦截) → 超时 → 缓存)。
    const execContext = {
      projectRoot: ctx.projectRoot || process.cwd(),
      workspaceDir: ctx.workspaceDir || process.cwd(),
      channel: ctx.channel || 'http',
      userId: ctx.userId || req.headers['x-user-id'] || 'http-client',
      sessionId: ctx.sessionId || null,
    };
    const result = await registry.execute(toolName, body, execContext);
    return sendJson(res, 200, result);
  } catch (e) {
    console.error('[request-handler] /api/tools 工具执行失败:', e.message);
    return sendJson(res, 500, { success: false, error: e.message });
  }
}

// MCP OAuth 启动授权 — POST /api/mcp/oauth/start（P1-6）
// body: { name|serverId, url, redirectUri?, scope?, clientId?, oauthMetadata? }
async function handleMCPOAuthStart(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    if (!body) return sendJson(res, 400, { success: false, error: '请求体为空' });
    const serverId = body.serverId || body.name;
    if (!serverId) return sendJson(res, 400, { success: false, error: '缺少 serverId/name' });
    if (!body.url) return sendJson(res, 400, { success: false, error: '缺少服务器 url' });

    const { getOAuthClient } = require('../../core/mcp/oauth-client');
    const result = await getOAuthClient().startAuth(serverId, body.url, {
      redirectUri: body.redirectUri,
      scope: body.scope,
      clientId: body.clientId,
      oauthMetadata: body.oauthMetadata,
    });
    return sendJson(res, 200, { success: true, data: result });
  } catch (e) {
    console.error('[request-handler] MCP OAuth start 失败:', e.message);
    return sendJson(res, 500, { success: false, error: e.message });
  }
}

// MCP OAuth 回调 — GET /api/mcp/oauth/callback?state=&code=（P1-6）
// token 由 oauth-client 持久化到 data/.crabpaw/oauth-tokens/<serverId>.json
async function handleMCPOAuthCallback(req, res, ctx) {
  try {
    const { state, code } = ctx.query || {};
    if (!state || !code) return sendJson(res, 400, { success: false, error: '缺少 state/code 参数' });

    const { getOAuthClient } = require('../../core/mcp/oauth-client');
    const result = await getOAuthClient().handleCallback(String(state), String(code));
    return sendJson(res, 200, { success: true, data: result });
  } catch (e) {
    console.error('[request-handler] MCP OAuth callback 失败:', e.message);
    return sendJson(res, 400, { success: false, error: e.message });
  }
}

async function handleToolsGroups(req, res, _ctx) {
  try {
    const { registry } = require('../../tools/registry');
    return sendJson(res, 200, {
      success: true,
      data: {
        toolsets: registry.getToolsets() || [],
        categories: registry.getCategories() || [],
        names: registry.getNames() || [],
        stats: registry.getStats() || {},
      },
    });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { toolsets: [], categories: [], names: [], stats: {} } });
  }
}

async function handleToolsToggle(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const name = body && body.name;
    const enabled = !!(body && body.enabled);
    return sendJson(res, 200, {
      success: true,
      supported: false,
      name,
      enabled,
      reason: 'tool_toggle_not_supported_by_registry',
    });
  } catch (e) {
    return sendJson(res, 400, { success: false, error: 'Invalid request body' });
  }
}

function handleToolCall(req, res, ctx) {
  return handleToolExecute(req, res, ctx);
}

module.exports = {
  handleToolExecute,
  handleMCPOAuthStart,
  handleMCPOAuthCallback,
  handleToolCall,
  handleToolsGroups,
  handleToolsToggle,
};
