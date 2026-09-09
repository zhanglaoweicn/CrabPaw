// system.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');
const { handleSSE } = require('../../core/sse-broadcast');
const { verifyApiToken } = require('../../core/http-middleware');
const { getApiKey, isLocalSocket, isLocalBrowserContext, _readJsonBodyOptional, _safeCallMethod } = require('./_shared');

async function handleStats(req, res, _ctx) {
  try {
    const { getSessionStats } = require('../../core/state');
    const stats = getSessionStats();
    return sendJson(res, 200, { success: true, data: stats || {} });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { sessions: 0, messages: 0, errors: 0 } });
  }
}

async function handleErrors(req, res, _ctx) {
  try {
    const { getRecentErrors } = require('../../core/state');
    const errors = getRecentErrors(100) || [];
    return sendJson(res, 200, { success: true, errors });
  } catch (e) {
    return sendJson(res, 200, { success: true, errors: [] });
  }
}

async function handleCommands(req, res, _ctx) {
  try {
    const { listCommands, getCommandNames } = require('../../core/commands');
    return sendJson(res, 200, {
      success: true,
      commands: listCommands() || [],
      names: getCommandNames() || [],
    });
  } catch (e) {
    return sendJson(res, 200, { success: true, commands: [], names: [] });
  }
}

async function handleTestMessage(req, res, ctx) {
  try {
    let message = ctx.url.searchParams.get('message') || 'test';
    if (req.method === 'POST') {
      const body = await _readJsonBodyOptional(req);
      message = body.message || message;
    }
    const result = typeof ctx.handleMessage === 'function'
      ? await ctx.handleMessage('test_user', message, ctx)
      : null;
    return sendJson(res, 200, { success: true, message: 'ok', result });
  } catch (e) {
    return sendJson(res, 200, { success: true, message: 'ok', result: null });
  }
}

async function handleHealthStatus(req, res, _ctx) {
  try {
    const { getGlobalHealthMonitor } = require('../../core/health-monitor');
    const monitor = getGlobalHealthMonitor();
    return sendJson(res, 200, {
      success: true,
      status: monitor.getStatus() || [],
      history: monitor.getHistory(1),
    });
  } catch (e) {
    return sendJson(res, 200, { success: true, status: [], history: [] });
  }
}

async function handleHealthHistory(req, res, ctx) {
  try {
    const { getGlobalHealthMonitor } = require('../../core/health-monitor');
    const limit = parseInt(ctx.url.searchParams.get('limit') || '100', 10) || 100;
    const monitor = getGlobalHealthMonitor();
    return sendJson(res, 200, { success: true, history: monitor.getHistory(limit) || [] });
  } catch (e) {
    return sendJson(res, 200, { success: true, history: [] });
  }
}

async function handlePerfStats(req, res, _ctx) {
  try {
    const { getMetricsPipeline } = require('../../core/perception/metrics-pipeline');
    const pipeline = getMetricsPipeline();
    return sendJson(res, 200, {
      success: true,
      data: {
        overview: _safeCallMethod(pipeline, 'getOverview') || {},
        metricNames: _safeCallMethod(pipeline, 'getMetricNames') || [],
      },
    });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { overview: {}, metricNames: [] } });
  }
}

async function handleDiagReport(req, res, _ctx) {
  try {
    const { globalDiagnosticCustodian } = require('../../core/diagnostic-custodian');
    return sendJson(res, 200, {
      success: true,
      data: {
        report: globalDiagnosticCustodian.generateReport(),
        diagnostics: globalDiagnosticCustodian.getDiagnosticHistory(50),
        fixes: globalDiagnosticCustodian.getFixHistory(50),
      },
    });
  } catch (e) {
    return sendJson(res, 200, {
      success: true,
      data: { report: { generatedAt: new Date().toISOString() }, diagnostics: [], fixes: [] },
    });
  }
}

async function handleSessionArchive(req, res, _ctx) {
  try {
    const body = await _readJsonBodyOptional(req);
    return sendJson(res, 200, {
      success: true,
      data: { archived: [], total: 0, requestedSessionId: body.sessionId || null },
    });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { archived: [], total: 0 } });
  }
}

async function handleSessionDetailById(req, res, ctx) {
  try {
    const pathname = ctx.url.pathname;
    const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', ''));
    if (!sessionId) {
      return sendJson(res, 400, { success: false, error: '缺少 sessionId' });
    }
    const sessionPersistence = ctx.sessionManager?.persistence;
    if (!sessionPersistence) {
      return sendJson(res, 404, { success: false, error: '会话持久化未初始化' });
    }
    const sessionData = await sessionPersistence.loadSession(sessionId);
    if (!sessionData) {
      return sendJson(res, 404, { success: false, error: '会话不存在' });
    }
    return sendJson(res, 200, { success: true, messages: sessionData.messages || [] });
  } catch (err) {
    console.error('[Sessions] detailById failed:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}

async function handleSkillBundle(req, res, _ctx) {
  try {
    const { getSkillBundleManager } = require('../../core/skill/skill-bundle-v2');
    const manager = getSkillBundleManager();
    await manager.initialize();
    if (req.method === 'GET') {
      return sendJson(res, 200, { success: true, bundles: manager.listBundles() || [] });
    }
    const body = await readJsonBody(req);
    if (!body || !body.name) {
      return sendJson(res, 400, { success: false, error: 'Missing required parameter: name' });
    }
    const bundle = await manager.createBundle(body.name, body.options || body);
    return sendJson(res, 200, { success: true, bundle: bundle.toJSON() });
  } catch (e) {
    return sendJson(res, 200, { success: true, bundles: [], bundle: null });
  }
}

async function handleLarkUserAvatar(req, res, _ctx) {
  return sendJson(res, 200, { success: true, avatar: null });
}

async function handleFlowPage(req, res, _ctx) {
  if (!res.headersSent && !res.writableEnded) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Flow</title></head><body><h1>Flow</h1><p>Flow page is not available yet.</p></body></html>');
  }
}

async function handleSSEEndpoint(req, res, _ctx) {
  // 2026-08-07 (M5 安全): /events SSE 此前公开无鉴权——流内广播 thinking/tool_call/
  // file_generated 等敏感内容，任何可触达端口者可订阅窃听。
  // 放行条件（二者其一）：
  // 1) 携带合法 API token（Electron 主进程 api:sse 代连带 X-Api-Key；WS/音频同款
  //    ?token= 查询参数同样支持——浏览器 EventSource 无法自定义 header）；
  // 2) 本机回环来源 + 本地客户端上下文（X-Electron 头 / localhost Origin|Referer），
  //    覆盖浏览器模式（Vite dev 5173 / 后端同源页面）直连场景。
  if (!verifyApiToken(req, getApiKey()) && !(isLocalSocket(req) && isLocalBrowserContext(req))) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return;
  }
  handleSSE(req, res);
}

module.exports = {
  handleStats,
  handleErrors,
  handleCommands,
  handleTestMessage,
  handleHealthStatus,
  handleHealthHistory,
  handlePerfStats,
  handleDiagReport,
  handleSessionArchive,
  handleSessionDetailById,
  handleSkillBundle,
  handleLarkUserAvatar,
  handleFlowPage,
  handleSSEEndpoint,
};
