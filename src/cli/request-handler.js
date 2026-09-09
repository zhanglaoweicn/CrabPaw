const fs = require('fs');
const path = require('path');

const { formatWithCrab } = require('../core/crabMood');

const {
  compose,
  corsMiddleware,
  securityHeadersMiddleware,
  securityMiddleware,
  rateLimitMiddleware,
  authMiddleware,
  requestLoggerMiddleware,
  errorHandlerMiddleware,
  timeoutMiddleware,
  requestSizeLimitMiddleware,
  performanceMonitorMiddleware
} = require('../core/http-middleware');

const handlers = require('../handlers');
const { sendJson } = require('../handlers/http-utils');
const { broadcastEvent } = require('../core/sse-broadcast');

// 子模块处理器（渐进式拆分）
const { createMCPHandlers } = require('./handlers/mcp-handlers');
const { getApiKey } = require('../handlers/local-handlers/_shared');
const _localExperts = require('../handlers/local-handlers/experts');
const _localDashboard = require('../handlers/local-handlers/dashboard');
const _localRequests = require('../handlers/local-handlers/requests');
const _localProfiles = require('../handlers/local-handlers/profiles');
const _localSecurity = require('../handlers/local-handlers/security');
const _localModels = require('../handlers/local-handlers/models');
const _localPlugins = require('../handlers/local-handlers/plugins');
const _localCore = require('../handlers/local-handlers/core');
const _localFiles = require('../handlers/local-handlers/files');
const _localDirectives = require('../handlers/local-handlers/directives');
const _localWebhooks = require('../handlers/local-handlers/webhooks');
const _localFeedbackLoop = require('../handlers/local-handlers/feedback-loop');
const _localTaskflow = require('../handlers/local-handlers/taskflow');
const _localWecom = require('../handlers/local-handlers/wecom');
const _localAuth = require('../handlers/local-handlers/auth');
const _localConfigVersions = require('../handlers/local-handlers/config-versions');
const _localCache = require('../handlers/local-handlers/cache');
const _localSandbox = require('../handlers/local-handlers/sandbox');
const _localPerception = require('../handlers/local-handlers/perception');
const _localHealing = require('../handlers/local-handlers/healing');
const _localEvolution = require('../handlers/local-handlers/evolution');
const _localSystem = require('../handlers/local-handlers/system');
const _localMemoryGraph = require('../handlers/local-handlers/memory-graph');
const _localTools = require('../handlers/local-handlers/tools');
const _localVoice = require('../handlers/local-handlers/voice');
const _localVoiceTts = require('../handlers/local-handlers/voice-tts');
const _localMedia = require('../handlers/local-handlers/media');
const _localDocArtifacts = require('../handlers/local-handlers/doc-artifacts');
const _localPanelRoutes = require('../handlers/local-handlers/panel-routes');
const _localPanels = require('../handlers/local-handlers/panels');
const _localMeetings = require('../handlers/local-handlers/meetings');
const _localKnowledge = require('../handlers/local-handlers/knowledge-handler');
const _localVision = require('../handlers/local-handlers/vision');
const _localTasks = require('../handlers/local-handlers/tasks');
const _localCockpit = require('../handlers/local-handlers/cockpit');
const { createSessionHandlers } = require('./handlers/session-handlers');
const { createProjectHandlers } = require('./handlers/project-handlers');
const PUBLIC_ROUTES_BY_METHOD = {
  GET: new Set([
    '/', '/health', '/status', '/stats', '/errors', '/commands',
    '/events',
    '/lark/user/avatar',
    '/files/',
    // 2026-08-05 fix: 浏览器模式 bootstrap 取 token（handler 内再限 localhost 来源；
    // 路径不带 /api/ 前缀——frontend-routes.contract 断言 public GET 路由不得以 /api/ 开头）
    '/auth/bootstrap',
  ]),
  POST: new Set([
    '/webhook',
    '/webhook/wecom',
  ]),
};

const PUBLIC_ROUTES_SET = new Set([
  ...PUBLIC_ROUTES_BY_METHOD.GET,
  ...PUBLIC_ROUTES_BY_METHOD.POST,
]);

let lastLarkSenderId = null;

function getLastLarkSenderId() {
  return lastLarkSenderId;
}

function createRequestHandler(serverCtx) {
  const { PORT } = serverCtx;

  const perfMonitor = performanceMonitorMiddleware();

  const middlewareChain = compose([
    errorHandlerMiddleware(),
    corsMiddleware({ allowedOrigin: process.env.ALLOWED_ORIGIN || '' }),
    securityHeadersMiddleware(),
    securityMiddleware(),
    rateLimitMiddleware({ windowMs: 60000, maxRequests: 120 }),
    authMiddleware({
      apiKey: getApiKey(),
      publicRoutes: PUBLIC_ROUTES_SET,
      publicRoutesByMethod: PUBLIC_ROUTES_BY_METHOD,
      requireApiKey: true
    }),
    timeoutMiddleware({ timeout: 120000 }),
    requestSizeLimitMiddleware({ maxSize: 10 * 1024 * 1024 }),
    perfMonitor,
    requestLoggerMiddleware()
  ]);

  // handleMessage — 处理 Lark/Wecom 渠道消息（由 chat-handler 调用）
  // 这里使用 function 声明而非箭头函数，确保 hoisting 到 module.exports 可用
  function handleMessage(senderId, content, _ctx) {
    const ai = serverCtx.ai;
    if (!ai || typeof ai.chat !== 'function') {
      return Promise.resolve({ reply: 'AI 模块未就绪' });
    }
    const userId = senderId || 'lark_user';
    // 2026-09-06 修复: 此前误把包装对象当 config 传入（3 参对 4 参签名），
    // message 实参落空 → chat 内 message.substring 抛 TypeError，飞书回复全灭。
    // 对齐 ai.chat(config, skills, userId, message) 签名与企微路径（chat-handler）。
    return ai.chat(serverCtx.appConfig, serverCtx.skills, userId, content);
  }

  return async function handleRequest(req, res) {
    const ctx = {
      ...serverCtx,
      fs,
      path,
      formatWithCrab,
      url: new URL(req.url, `http://localhost:${PORT}`),
      // 2026-08-13 审计 G1: 从 url 纯推导,不耗 body stream;handler 可安全使用
      get query() { return Object.fromEntries(this.url.searchParams.entries()); },
      get pathname() { return this.url.pathname; },
      lastLarkSenderId,
      setLastLarkSenderId: (id) => { lastLarkSenderId = id; },
      // 请求级别 sender 存储，避免并发请求覆盖全局变量
      _requestSenderId: null,
      handleMessage: (senderId, content) => handleMessage(senderId, content, ctx)
    };

    await middlewareChain(req, res, ctx, async () => {
      const pathname = ctx.url.pathname;
      const method = req.method;

      const handler = resolveRoute(method, pathname);
      if (handler) {
        await handler(req, res, ctx);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Not Found' }));
      }
    });
  };
}

const ROUTE_TABLE = [
  { method: 'GET', pattern: /^\/$/, handler: 'handleRoot' },
  { method: 'GET', pattern: /^\/health$/, handler: 'handleHealth' },
  { method: 'GET', pattern: /^\/auth\/bootstrap$/, handler: 'handleAuthBootstrap' },
  { method: 'POST', pattern: /^\/shutdown$/, handler: 'handleShutdown' },
  { method: 'POST', pattern: /^\/chat$/, handler: 'handleChat' },
  { method: 'GET', pattern: /^\/status$/, handler: 'handleStatus' },
  { method: 'GET', pattern: /^\/api\/diagnose$/, handler: 'handleDiagnose' },
  { method: 'POST', pattern: /^\/api\/services\/([^/]+)\/start$/, handler: 'handleServiceStart' },
  { method: 'POST', pattern: /^\/api\/services\/([^/]+)\/stop$/, handler: 'handleServiceStop' },
  { method: 'POST', pattern: /^\/api\/gateway\/start$/, handler: 'handleGatewayStart' },
  { method: 'POST', pattern: /^\/api\/gateway\/stop$/, handler: 'handleGatewayStop' },
  { method: 'GET', pattern: /^\/stats$/, handler: 'handleStats' },
  { method: 'GET', pattern: /^\/errors$/, handler: 'handleErrors' },
  { method: 'GET', pattern: /^\/commands$/, handler: 'handleCommands' },
  { method: 'GET', pattern: /^\/config$/, handler: 'handleConfig' },
  { method: 'POST', pattern: /^\/config$/, handler: 'handleConfig' },
  { method: 'POST', pattern: /^\/config\/reload$/, handler: 'handleConfig' },
  { method: 'POST', pattern: /^\/api\/model\/test$/, handler: 'handleModelTest' },
  { method: 'GET', pattern: /^\/api\/profiles$/, handler: 'handleProfiles' },
  { method: 'POST', pattern: /^\/api\/profiles$/, handler: 'handleProfiles' },
  { method: 'POST', pattern: /^\/api\/profiles\/switch$/, handler: 'handleProfileSwitch' },
  { method: 'POST', pattern: /^\/api\/profiles\/import$/, handler: 'handleProfileImport' },
  { method: 'GET', pattern: /^\/api\/profiles\/([^/]+)\/export$/, handler: 'handleProfileExport' },
  { method: 'GET', pattern: /^\/api\/profiles\/([^/]+)\/diff$/, handler: 'handleProfileDiff' },
  { method: 'POST', pattern: /^\/api\/profiles\/([^/]+)\/clone$/, handler: 'handleProfileClone' },
  { method: 'PATCH', pattern: /^\/api\/profiles\/([^/]+)$/, handler: 'handleProfileUpdate' },
  { method: 'DELETE', pattern: /^\/api\/profiles\/([^/]+)$/, handler: 'handleProfileDelete' },
  { method: 'GET', pattern: /^\/config\/user$/, handler: 'handleUserConfig' },
  { method: 'POST', pattern: /^\/config\/user$/, handler: 'handleUserConfig' },
  { method: 'GET', pattern: /^\/config\/assistant$/, handler: 'handleAssistantConfig' },
  { method: 'POST', pattern: /^\/config\/assistant$/, handler: 'handleAssistantConfig' },
  { method: 'GET', pattern: /^\/api\/health\/status$/, handler: 'handleHealthStatus' },
  { method: 'GET', pattern: /^\/api\/health\/history$/, handler: 'handleHealthHistory' },
  { method: 'GET', pattern: /^\/api\/perf$/, handler: 'handlePerfStats' },
  { method: 'GET', pattern: /^\/api\/model-ecosystem$/, handler: 'handleModelEcosystem' },
  { method: 'POST', pattern: /^\/api\/model-ecosystem$/, handler: 'handleModelEcosystem' },
  { method: 'POST', pattern: /^\/api\/session-archive$/, handler: 'handleSessionArchive' },
  { method: 'GET', pattern: /^\/api\/skill-bundle$/, handler: 'handleSkillBundle' },
  { method: 'POST', pattern: /^\/api\/skill-bundle$/, handler: 'handleSkillBundle' },
  { method: 'GET', pattern: /^\/api\/diag-report$/, handler: 'handleDiagReport' },
  { method: 'GET', pattern: /^\/api\/community$/, handler: 'handleCommunity' },
  { method: 'GET', pattern: /^\/api\/models\/detect$/, handler: 'handleModelDetect' },
  { method: 'GET', pattern: /^\/api\/mcp\/servers$/, handler: 'handleMCPServers' },
  { method: 'POST', pattern: /^\/api\/mcp\/servers\/add$/, handler: 'handleMCPServerAdd' },
  { method: 'POST', pattern: /^\/api\/mcp\/servers\/update$/, handler: 'handleMCPServerUpdate' },
  { method: 'POST', pattern: /^\/api\/mcp\/servers\/delete$/, handler: 'handleMCPServerDelete' },
  { method: 'POST', pattern: /^\/api\/mcp\/servers\/connect$/, handler: 'handleMCPServerConnect' },
  { method: 'POST', pattern: /^\/api\/mcp\/servers\/disconnect$/, handler: 'handleMCPServerDisconnect' },
  { method: 'GET', pattern: /^\/api\/mcp\/servers\/([^/]+)\/tools$/, handler: 'handleMCPServerTools' },
  { method: 'GET', pattern: /^\/api\/mcp\/servers\/([^/]+)\/resources$/, handler: 'handleMCPServerResources' },
  { method: 'GET', pattern: /^\/api\/mcp\/servers\/([^/]+)\/prompts$/, handler: 'handleMCPServerPrompts' },
  { method: 'POST', pattern: /^\/api\/mcp\/reload$/, handler: 'handleMCPReload' },
  { method: 'POST', pattern: /^\/api\/mcp\/tools\/call$/, handler: 'handleMCPToolCall' },
  { method: 'GET', pattern: /^\/api\/mcp\/tools\/definitions$/, handler: 'handleMCPToolDefinitions' },
  { method: 'POST', pattern: /^\/api\/mcp\/sampling$/, handler: 'handleMCPSampling' },
  // ── 2026-08-15 P1-6: MCP OAuth 链路（oauth-client startAuth/handleCallback 此前无任何入口）──
  { method: 'POST', pattern: /^\/api\/mcp\/oauth\/start$/, handler: 'handleMCPOAuthStart' },
  { method: 'GET', pattern: /^\/api\/mcp\/oauth\/callback$/, handler: 'handleMCPOAuthCallback' },
  { method: 'GET', pattern: /^\/mcp$/, handler: 'handleMCPServerModeEndpoint' },
  { method: 'POST', pattern: /^\/mcp$/, handler: 'handleMCPServerModeEndpoint' },
  { method: 'GET', pattern: /^\/api\/api-server\/status$/, handler: 'handleApiServerStatus' },
  { method: 'POST', pattern: /^\/api\/api-server\/config$/, handler: 'handleApiServerConfig' },
  { method: 'GET', pattern: /^\/api\/fallback\/status$/, handler: 'handleFallbackStatus' },
  { method: 'POST', pattern: /^\/api\/fallback\/config$/, handler: 'handleFallbackConfig' },
  { method: 'POST', pattern: /^\/api\/request\/cancel$/, handler: 'handleRequestCancel' },
  { method: 'GET', pattern: /^\/api\/request\/status$/, handler: 'handleRequestStatus' },
  { method: 'POST', pattern: /^\/webhook$/, handler: 'handleWebhook' },
  { method: 'POST', pattern: /^\/webhook\/wecom$/, handler: 'handleWecomWebhook' },
  { method: 'GET', pattern: /^\/webhook\/wecom$/, handler: 'handleWecomCallbackHint' },
  { method: 'POST', pattern: /^\/wecom\/send-file$/, handler: 'handleWecomSendFileProxy' },
  { method: 'GET', pattern: /^\/events$/, handler: 'handleSSEEndpoint' },
  { method: 'GET', pattern: /^\/test-message$/, handler: 'handleTestMessage' },
  { method: 'POST', pattern: /^\/test-message$/, handler: 'handleTestMessage' },
  { method: 'GET', pattern: /^\/dev\/token$/, handler: 'handleDevToken' },
  { method: 'GET', pattern: /^\/schedules$/, handler: 'handleSchedules' },
  { method: 'POST', pattern: /^\/schedules$/, handler: 'handleSchedules' },
  { method: 'PATCH', pattern: /^\/schedules\/[^/]+$/, handler: 'handleSchedules' },
  { method: 'DELETE', pattern: /^\/schedules\/[^/]+$/, handler: 'handleSchedules' },
  { method: 'POST', pattern: /^\/schedules\/trigger$/, handler: 'handleScheduleTrigger' },
  { method: 'GET', pattern: /^\/tasks\/history$/, handler: 'handleTaskHistory' },
  { method: 'GET', pattern: /^\/tasks\/stats$/, handler: 'handleTaskStats' },
  { method: 'POST', pattern: /^\/api\/tasks\/parse-nl$/, handler: 'handleTaskParseNL' },
  { method: 'POST', pattern: /^\/api\/tasks\/from-nl$/, handler: 'handleTaskFromNL' },
  { method: 'PATCH', pattern: /^\/schedules\/[^/]+\/edit-nl$/, handler: 'handleTaskEditNL' },
  // /api/schedules 别名 —— 前端 Automation 页面统一使用 /api/ 前缀
  { method: 'GET', pattern: /^\/api\/schedules$/, handler: 'handleSchedules' },
  { method: 'POST', pattern: /^\/api\/schedules$/, handler: 'handleSchedules' },
  { method: 'PATCH', pattern: /^\/api\/schedules\/[^/]+$/, handler: 'handleSchedules' },
  { method: 'DELETE', pattern: /^\/api\/schedules\/[^/]+$/, handler: 'handleSchedules' },
  // /api/tasks/* 增强端点 —— 接线此前未连接的处理器
  { method: 'GET', pattern: /^\/api\/tasks\/templates$/, handler: 'handleApiTaskTemplates' },
  { method: 'GET', pattern: /^\/api\/tasks\/history$/, handler: 'handleTaskHistory' },
  { method: 'GET', pattern: /^\/api\/tasks\/workflows$/, handler: 'handleApiTaskWorkflows' },
  { method: 'GET', pattern: /^\/api\/tasks\/versions\/[^/]+$/, handler: 'handleApiTaskVersions' },
  { method: 'POST', pattern: /^\/api\/tasks\/cancel$/, handler: 'handleApiTaskCancel' },
  { method: 'GET', pattern: /^\/workspace$/, handler: 'handleWorkspace' },
  { method: 'GET', pattern: /^\/history$/, handler: 'handleHistory' },
  { method: 'GET', pattern: /^\/history\/search$/, handler: 'handleHistorySearch' },
  { method: 'POST', pattern: /^\/history\/clear$/, handler: 'handleHistoryClear' },
  { method: 'GET', pattern: /^\/api\/sessions$/, handler: 'handleSessions' },
  { method: 'POST', pattern: /^\/api\/sessions$/, handler: 'handleSessionCreate' },
  { method: 'GET', pattern: /^\/api\/sessions\/detail$/, handler: 'handleSessionDetail' },
  { method: 'GET', pattern: /^\/api\/sessions\/search$/, handler: 'handleSessionSearch' },
  { method: 'GET', pattern: /^\/api\/sessions\/list$/, handler: 'handleSessions' },
  { method: 'GET', pattern: /^\/api\/sessions\/[^/]+$/, handler: 'handleSessionDetailById' },
  { method: 'PUT', pattern: /^\/api\/sessions\/[^/]+$/, handler: 'handleSessionUpdate' },
  { method: 'DELETE', pattern: /^\/api\/sessions\/[^/]+$/, handler: 'handleSessionDelete' },
  { method: 'GET', pattern: /^\/api\/projects$/, handler: 'handleProjectsList' },
  { method: 'POST', pattern: /^\/api\/projects$/, handler: 'handleProjectCreate' },
  { method: 'PUT', pattern: /^\/api\/projects\/proj_[^/]+$/, handler: 'handleProjectUpdate' },
  { method: 'DELETE', pattern: /^\/api\/projects\/proj_[^/]+$/, handler: 'handleProjectDelete' },
  { method: 'POST', pattern: /^\/api\/projects\/proj_[^/]+\/move$/, handler: 'handleProjectMove' },
  { method: 'GET', pattern: /^\/api\/projects\/proj_[^/]+\/export$/, handler: 'handleProjectExport' },
  { method: 'GET', pattern: /^\/api\/projects\/proj_[^/]+\/sessions$/, handler: 'handleProjectSessions' },
  { method: 'GET', pattern: /^\/api\/projects\/proj_[^/]+\/files$/, handler: 'handleProjectFiles' },
  { method: 'GET', pattern: /^\/api\/files\/list$/, handler: 'handleFileList' },
  { method: 'GET', pattern: /^\/api\/files\/read$/, handler: 'handleFileRead' },
  { method: 'DELETE', pattern: /^\/api\/files\/delete$/, handler: 'handleFileDelete' },
  { method: 'GET', pattern: /^\/api\/logs$/, handler: 'handleLogs' },
  { method: 'GET', pattern: /^\/api\/logs\/files$/, handler: 'handleLogFiles' },
  { method: 'GET', pattern: /^\/api\/dashboard\/plugins$/, handler: 'handleDashboardPlugins' },
  { method: 'GET', pattern: /^\/api\/dashboard\/plugins\/rescan$/, handler: 'handleDashboardPluginsRescan' },
  { method: 'GET', pattern: /^\/dashboard-plugins\/[^/]+\/.+$/, handler: 'handleDashboardPluginStatic' },
  { method: 'POST', pattern: /^\/api\/commodity\/search$/, handler: 'handleCommoditySearch' },
  { method: 'POST', pattern: /^\/api\/commodity\/login$/, handler: 'handleCommodityLogin' },
  { method: 'GET', pattern: /^\/api\/commodity\/history$/, handler: 'handleCommodityHistory' },
  { method: 'ALL', pattern: /^\/api\/plugins\/[^/]+\/.+$/, handler: 'handlePluginApi' },
  { method: 'GET', pattern: /^\/api\/plugins\/assembly$/, handler: 'handleAssemblyView' },
  { method: 'GET', pattern: /^\/api\/plugin-manager\/list$/, handler: 'handlePluginManagerList' },
  { method: 'POST', pattern: /^\/api\/plugin-manager\/([^/]+)\/(enable|disable)$/, handler: 'handlePluginManagerAction' },
  { method: 'POST', pattern: /^\/confirm$/, handler: 'handleConfirm' },
  { method: 'POST', pattern: /^\/upload$/, handler: 'handleFileUpload' },
  { method: 'POST', pattern: /^\/upload\/base64$/, handler: 'handleUploadBase64' },
  { method: 'GET', pattern: /^\/skills$/, handler: 'handleSkills' },
  { method: 'POST', pattern: /^\/skills\/install\/zip$/, handler: 'handleSkillsInstallZip' },
  { method: 'GET', pattern: /^\/skills\/evolution$/, handler: 'handleSkillEvolution' },
  { method: 'POST', pattern: /^\/api\/skills\/run$/, handler: 'handleSkillExecute' },
  { method: 'DELETE', pattern: /^\/skills\/[^/]+$/, handler: 'handleSkillDelete' },
  { method: 'POST', pattern: /^\/skills\/install-deps$/, handler: 'handleSkillInstallDeps' },
  { method: 'GET', pattern: /^\/skills\/dep-status$/, handler: 'handleSkillDepStatus' },
  { method: 'GET', pattern: /^\/skills\/market\/search$/, handler: 'handleSkillMarketSearch' },
  { method: 'GET', pattern: /^\/skills\/market\/status$/, handler: 'handleSkillMarketStatus' },
  { method: 'POST', pattern: /^\/skills\/market\/install$/, handler: 'handleSkillMarketInstall' },
  { method: 'POST', pattern: /^\/skills\/learning\/review$/, handler: 'handleSkillReview' },
  { method: 'GET', pattern: /^\/skills\/market\/installed$/, handler: 'handleSkillMarketList' },
  { method: 'POST', pattern: /^\/skills\/create$/, handler: 'handleSkillCreate' },
  { method: 'POST', pattern: /^\/skills\/edit$/, handler: 'handleSkillEdit' },
  { method: 'GET', pattern: /^\/skills\/evolution\/status$/, handler: 'handleSkillEvolutionStatus' },
  { method: 'POST', pattern: /^\/skills\/evolution\/trigger$/, handler: 'handleSkillEvolutionTrigger' },
  { method: 'POST', pattern: /^\/skills\/evolution\/rollback\/[^/]+$/, handler: 'handleSkillEvolutionRollback' },
  { method: 'GET', pattern: /^\/skills\/evolution\/history$/, handler: 'handleSkillEvolutionHistory' },
  { method: 'GET', pattern: /^\/skills\/evolution\/graph$/, handler: 'handleSkillEvolutionGraph' },
  { method: 'PATCH', pattern: /^\/skills\/[^/]+$/, handler: 'handleSkillToggle' },
  { method: 'POST', pattern: /^\/skills\/[^/]+$/, handler: 'handleSkillToggle' },
  { method: 'GET', pattern: /^\/lark\/user\/avatar$/, handler: 'handleLarkUserAvatar' },
  { method: 'GET', pattern: /^\/evolution\/status$/, handler: 'handleEvolutionStatus' },
  { method: 'POST', pattern: /^\/evolution\/record$/, handler: 'handleEvolutionRecord' },
  { method: 'GET', pattern: /^\/evolution\/history$/, handler: 'handleEvolutionHistory' },
  { method: 'GET', pattern: /^\/evolution\/log$/, handler: 'handleEvolutionLog' },
  { method: 'GET', pattern: /^\/memory\/tags$/, handler: 'handleMemoryTags' },
  { method: 'GET', pattern: /^\/memory\/entries$/, handler: 'handleMemoryEntries' },
  { method: 'GET', pattern: /^\/memory\/important$/, handler: 'handleMemoryImportant' },
  { method: 'GET', pattern: /^\/api\/memory\/stats$/, handler: 'handleMemoryStats' },
  { method: 'GET', pattern: /^\/api\/memory\/notes$/, handler: 'handleMemoryNotes' },
  { method: 'POST', pattern: /^\/api\/memory\/notes$/, handler: 'handleMemoryNotes' },
  { method: 'PUT', pattern: /^\/api\/memory\/notes\/[^/]+$/, handler: 'handleMemoryNotes' },
  { method: 'DELETE', pattern: /^\/api\/memory\/notes\/[^/]+$/, handler: 'handleMemoryNotes' },
  { method: 'POST', pattern: /^\/api\/memory\/dream$/, handler: 'handleMemoryDream' },
  { method: 'GET', pattern: /^\/api\/memory\/search$/, handler: 'handleMemorySearch' },
  { method: 'GET', pattern: /^\/api\/memory\/search-sessions$/, handler: 'handleMemorySearchSessions' },
  { method: 'GET', pattern: /^\/api\/memory\/entities$/, handler: 'handleMemoryEntities' },
  { method: 'GET', pattern: /^\/api\/memory\/entities\/.+$/, handler: 'handleMemoryEntityProbe' },
  { method: 'GET', pattern: /^\/api\/memory\/graph$/, handler: 'handleMemoryGraph' },
  { method: 'GET', pattern: /^\/api\/memory\/timeline$/, handler: 'handleMemoryTimeline' },
  { method: 'GET', pattern: /^\/api\/memory\/evolution\/status$/, handler: 'handleMemoryEvolutionStatus' },
  { method: 'POST', pattern: /^\/api\/memory\/evolution\/trigger$/, handler: 'handleMemoryEvolutionTrigger' },
  { method: 'GET', pattern: /^\/api\/memory\/evolution\/profile$/, handler: 'handleMemoryEvolutionProfile' },
  { method: 'GET', pattern: /^\/api\/memory\/snapshot$/, handler: 'handleMemorySnapshot' },
  { method: 'POST', pattern: /^\/api\/memory\/snapshot\/add$/, handler: 'handleMemorySnapshotAdd' },
  { method: 'POST', pattern: /^\/api\/memory\/snapshot\/replace$/, handler: 'handleMemorySnapshotReplace' },
  { method: 'POST', pattern: /^\/api\/memory\/snapshot\/remove$/, handler: 'handleMemorySnapshotRemove' },
  { method: 'POST', pattern: /^\/api\/memory\/snapshot\/merge$/, handler: 'handleMemorySnapshotMerge' },
  { method: 'GET', pattern: /^\/api\/identity$/, handler: 'handleIdentity' },
  { method: 'POST', pattern: /^\/api\/identity$/, handler: 'handleIdentity' },
  { method: 'GET', pattern: /^\/api\/tools\/groups$/, handler: 'handleToolsGroups' },
  { method: 'POST', pattern: /^\/api\/tools\/toggle$/, handler: 'handleToolsToggle' },
  { method: 'GET', pattern: /^\/api\/tasks\/evolution\/status$/, handler: 'handleTaskEvolutionStatus' },
  { method: 'POST', pattern: /^\/api\/tasks\/evolution\/trigger$/, handler: 'handleTaskEvolutionTrigger' },
  { method: 'GET', pattern: /^\/api\/tasks\/evolution\/metrics$/, handler: 'handleTaskEvolutionMetrics' },
  { method: 'GET', pattern: /^\/api\/tasks\/evolution\/recommendations$/, handler: 'handleTaskEvolutionRecommendations' },
  { method: 'POST', pattern: /^\/api\/tools\/[^/]+$/, handler: 'handleToolCall' },
  { method: 'POST', pattern: /^\/api\/backup\/create$/, handler: 'handleBackupCreate' },
  { method: 'GET', pattern: /^\/api\/backup\/list$/, handler: 'handleBackupList' },
  { method: 'GET', pattern: /^\/api\/backup\/download$/, handler: 'handleBackupDownload' },
  { method: 'POST', pattern: /^\/api\/backup\/restore$/, handler: 'handleBackupRestore' },
  { method: 'POST', pattern: /^\/api\/backup\/delete$/, handler: 'handleBackupDelete' },
  // 2026-08-01: 配置版本管理（Status 页功能，此前前端调用 404——后端从未实现）
  { method: 'GET', pattern: /^\/api\/config-versions$/, handler: 'handleConfigVersions' },
  { method: 'POST', pattern: /^\/api\/config-versions$/, handler: 'handleConfigVersions' },
  { method: 'GET', pattern: /^\/api\/security\/status$/, handler: 'handleSecurityStatus' },
  { method: 'GET', pattern: /^\/api\/security\/config$/, handler: 'handleSecurityConfig' },
  { method: 'POST', pattern: /^\/api\/security\/config$/, handler: 'handleSecurityConfig' },
  { method: 'GET', pattern: /^\/api\/security\/approval$/, handler: 'handleSecurityApproval' },
  { method: 'POST', pattern: /^\/api\/security\/approval$/, handler: 'handleSecurityApproval' },
  { method: 'GET', pattern: /^\/api\/security\/whitelist$/, handler: 'handleSecurityWhitelist' },
  { method: 'POST', pattern: /^\/api\/security\/whitelist$/, handler: 'handleSecurityWhitelist' },
  { method: 'GET', pattern: /^\/flows$/, handler: 'handleFlows' },
  { method: 'GET', pattern: /^\/api\/flows$/, handler: 'handleFlows' },
  { method: 'POST', pattern: /^\/api\/flows$/, handler: 'handleFlowCreate' },
  { method: 'GET', pattern: /^\/api\/flows\/[^/]+$/, handler: 'handleFlowGet' },
  { method: 'PUT', pattern: /^\/api\/flows\/[^/]+$/, handler: 'handleFlowUpdate' },
  { method: 'DELETE', pattern: /^\/api\/flows\/[^/]+$/, handler: 'handleFlowDelete' },
  { method: 'POST', pattern: /^\/api\/flows\/[^/]+\/execute$/, handler: 'handleFlowExecute' },
  { method: 'GET', pattern: /^\/api\/flows\/[^/]+\/diagram$/, handler: 'handleFlowDiagram' },
  { method: 'POST', pattern: /^\/api\/flows\/validate$/, handler: 'handleFlowValidate' },
  { method: 'POST', pattern: /^\/api\/flows\/generate$/, handler: 'handleFlowGenerate' },
  { method: 'GET', pattern: /^\/api\/flows\/templates$/, handler: 'handleFlowTemplates' },
  { method: 'POST', pattern: /^\/api\/flows\/templates\/apply$/, handler: 'handleFlowTemplateApply' },
  { method: 'POST', pattern: /^\/api\/skills\/generate$/, handler: 'handleSkillGenerate' },
  { method: 'GET', pattern: /^\/flow$/, handler: 'handleFlowPage' },
  { method: 'GET', pattern: /^\/api\/usage$/, handler: 'handleUsageStats' },
  // 2026-08-27 面板禁用开关：状态读取/写入 API（管理舱插件页面板清单用）
  { method: 'GET', pattern: /^\/api\/panels\/state$/, handler: 'handlePanelStateGet' },
  { method: 'POST', pattern: /^\/api\/panels\/state$/, handler: 'handlePanelStateSet' },
  { method: 'GET', pattern: /^\/api\/cockpit\/overview$/, handler: 'handleCockpitOverview' },
  { method: 'DELETE', pattern: /^\/api\/usage$/, handler: 'handleUsageReset' },
  { method: 'GET', pattern: /^\/api\/audit$/, handler: 'handleAuditLogs' },
  { method: 'GET', pattern: /^\/api\/audit\/stats$/, handler: 'handleAuditStats' },
  { method: 'GET', pattern: /^\/api\/runs\/active$/, handler: 'handleRunsActive' },
  // 2026-08-13: 消息级点赞/点踩(P0-3, ag-ui MetaEvent 借鉴)
  { method: 'POST', pattern: /^\/api\/chat\/message-feedback$/, handler: 'handleMessageFeedback' },
  { method: 'DELETE', pattern: /^\/api\/audit$/, handler: 'handleAuditClear' },
  { method: 'GET', pattern: /^\/api\/calendar$/, handler: 'handleCalendarList' },
  { method: 'POST', pattern: /^\/api\/calendar$/, handler: 'handleCalendarCreate' },
  { method: 'PUT', pattern: /^\/api\/calendar$/, handler: 'handleCalendarUpdate' },
  { method: 'DELETE', pattern: /^\/api\/calendar$/, handler: 'handleCalendarDelete' },
  { method: 'GET', pattern: /^\/api\/calendar\/status$/, handler: 'handleCalendarStatus' },
  { method: 'POST', pattern: /^\/api\/calendar\/parse$/, handler: 'handleCalendarParse' },
  
  { method: 'GET', pattern: /^\/api\/calendar\/search$/, handler: 'handleCalendarSearch' },
  { method: 'GET', pattern: /^\/api\/calendar\/stats$/, handler: 'handleCalendarStats' },
  { method: 'GET', pattern: /^\/api\/calendar\/export$/, handler: 'handleCalendarExport' },
  { method: 'GET', pattern: /^\/api\/taskflows$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/stats$/, handler: 'handleTaskFlowStats' },
  { method: 'GET', pattern: /^\/api\/taskflows\/metrics$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/templates$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/experts$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/analyze$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/recover$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/conversation\/active$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/llm\/providers$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/approval\/resolve$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/classify-error$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/[^/]+$/, handler: 'handleTaskFlows' },
  { method: 'DELETE', pattern: /^\/api\/taskflows\/[^/]+$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/[^/]+\/execute$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/[^/]+\/cancel$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/[^/]+\/status$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/[^/]+\/history$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/[^/]+\/retry$/, handler: 'handleTaskFlows' },
  { method: 'POST', pattern: /^\/api\/taskflows\/[^/]+\/recover$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/[^/]+\/steps$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/api\/taskflows\/[^/]+\/resume$/, handler: 'handleTaskFlows' },
  { method: 'GET', pattern: /^\/files\/.+$/, handler: 'handleStaticFile' },
  { method: 'GET', pattern: /^\/api\/preview\/markdown$/, handler: 'handleMarkdownPreview' },

  { method: 'GET', pattern: /^\/api\/perception\/status$/, handler: 'handlePerceptionStatus' },
  { method: 'GET', pattern: /^\/api\/perception\/signals$/, handler: 'handlePerceptionSignals' },
  { method: 'GET', pattern: /^\/api\/perception\/cost$/, handler: 'handlePerceptionCost' },
  { method: 'GET', pattern: /^\/api\/perception\/domains$/, handler: 'handlePerceptionDomains' },
  { method: 'GET', pattern: /^\/api\/perception\/user\/[^/]+$/, handler: 'handlePerceptionUser' },
  { method: 'GET', pattern: /^\/api\/healing\/status$/, handler: 'handleHealingStatus' },
  { method: 'GET', pattern: /^\/api\/healing\/history$/, handler: 'handleHealingHistory' },
  { method: 'GET', pattern: /^\/api\/healing\/rules$/, handler: 'handleHealingRules' },
  { method: 'GET', pattern: /^\/api\/proactive\/predict$/, handler: 'handleProactivePredict' },
  { method: 'GET', pattern: /^\/api\/proactive\/actions$/, handler: 'handleProactiveActions' },
  { method: 'GET', pattern: /^\/api\/proactive\/rules$/, handler: 'handleProactiveRules' },
  { method: 'POST', pattern: /^\/api\/proactive\/action\/[^/]+\/execute$/, handler: 'handleProactiveActionExecute' },
  { method: 'POST', pattern: /^\/api\/proactive\/action\/[^/]+\/dismiss$/, handler: 'handleProactiveActionDismiss' },
  { method: 'GET', pattern: /^\/api\/preloader\/status$/, handler: 'handlePreloaderStatus' },
  { method: 'GET', pattern: /^\/api\/preloader\/registry$/, handler: 'handlePreloaderRegistry' },
  { method: 'GET', pattern: /^\/api\/meta\/strategies$/, handler: 'handleMetaStrategies' },
  { method: 'GET', pattern: /^\/api\/meta\/optimizations$/, handler: 'handleMetaOptimizations' },
  { method: 'POST', pattern: /^\/api\/meta\/replay$/, handler: 'handleMetaReplay' },
  { method: 'GET', pattern: /^\/api\/meta\/patterns$/, handler: 'handleMetaPatterns' },
  { method: 'GET', pattern: /^\/api\/meta\/params$/, handler: 'handleMetaParams' },
  { method: 'PUT', pattern: /^\/api\/meta\/params\/[^/]+$/, handler: 'handleMetaParamUpdate' },
  { method: 'POST', pattern: /^\/api\/meta\/params\/reset$/, handler: 'handleMetaParamsReset' },
  { method: 'GET', pattern: /^\/api\/kg\/status$/, handler: 'handleKGStatus' },
  { method: 'GET', pattern: /^\/api\/kg\/evolutions$/, handler: 'handleKGEvolutions' },
  { method: 'GET', pattern: /^\/api\/kg\/discoveries$/, handler: 'handleKGDiscoveries' },
  { method: 'GET', pattern: /^\/api\/kg\/merges$/, handler: 'handleKGMerges' },
  { method: 'POST', pattern: /^\/api\/kg\/evolve$/, handler: 'handleKGEvolve' },
  { method: 'GET', pattern: /^\/api\/sandbox\/status$/, handler: 'handleSandboxStatus' },
  { method: 'GET', pattern: /^\/api\/sandbox\/experiments$/, handler: 'handleSandboxExperiments' },
  { method: 'GET', pattern: /^\/api\/sandbox\/completed$/, handler: 'handleSandboxCompleted' },
  { method: 'POST', pattern: /^\/api\/sandbox\/create$/, handler: 'handleSandboxCreate' },
  { method: 'POST', pattern: /^\/api\/sandbox\/[^/]+\/start$/, handler: 'handleSandboxStart' },
  { method: 'POST', pattern: /^\/api\/sandbox\/[^/]+\/record$/, handler: 'handleSandboxRecord' },
  { method: 'POST', pattern: /^\/api\/sandbox\/[^/]+\/analyze$/, handler: 'handleSandboxAnalyze' },
  { method: 'POST', pattern: /^\/api\/sandbox\/[^/]+\/complete$/, handler: 'handleSandboxComplete' },
  { method: 'POST', pattern: /^\/api\/sandbox\/[^/]+\/cancel$/, handler: 'handleSandboxCancel' },

  { method: 'GET', pattern: /^\/api\/feedback-loop\/status$/, handler: 'handleFeedbackLoopStatus' },
  { method: 'GET', pattern: /^\/api\/feedback-loop\/quality$/, handler: 'handleFeedbackLoopQuality' },
  { method: 'GET', pattern: /^\/api\/feedback-loop\/evolution-history$/, handler: 'handleFeedbackLoopEvolutionHistory' },
  { method: 'POST', pattern: /^\/api\/feedback-loop\/evolve$/, handler: 'handleFeedbackLoopEvolve' },
  { method: 'POST', pattern: /^\/api\/feedback-loop\/rollback$/, handler: 'handleFeedbackLoopRollback' },
  { method: 'GET', pattern: /^\/api\/feedback-loop\/versions\/[^/]+$/, handler: 'handleFeedbackLoopVersions' },
  { method: 'GET', pattern: /^\/api\/feedback-loop\/lineage\/[^/]+$/, handler: 'handleFeedbackLoopLineage' },

  { method: 'GET', pattern: /^\/api\/webhooks$/, handler: 'handleWebhooksList' },
  { method: 'POST', pattern: /^\/api\/webhooks\/register$/, handler: 'handleWebhooksRegister' },
  { method: 'POST', pattern: /^\/api\/webhooks\/unregister$/, handler: 'handleWebhooksUnregister' },
  { method: 'GET', pattern: /^\/api\/webhooks\/delivery-log$/, handler: 'handleWebhooksDeliveryLog' },
  { method: 'GET', pattern: /^\/api\/webhooks\/stats$/, handler: 'handleWebhooksStats' },

  { method: 'GET', pattern: /^\/api\/directives$/, handler: 'handleDirectivesList' },
  { method: 'POST', pattern: /^\/api\/directives\/add$/, handler: 'handleDirectivesAdd' },
  { method: 'POST', pattern: /^\/api\/directives\/update$/, handler: 'handleDirectivesUpdate' },
  { method: 'POST', pattern: /^\/api\/directives\/remove$/, handler: 'handleDirectivesRemove' },
  { method: 'GET', pattern: /^\/api\/directives\/stats$/, handler: 'handleDirectivesStats' },

  { method: 'GET', pattern: /^\/api\/voice-evolution\/stats$/, handler: 'handleGetVoiceEvolutionStats' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/refine$/, handler: 'handleRefineVoice' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/excellent$/, handler: 'handleAddExcellentExample' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/failed$/, handler: 'handleAddFailedExample' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/preferences$/, handler: 'handleUpdateUserPreferences' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/strategy$/, handler: 'handleGetDynamicRefinementStrategy' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/cache\/clean$/, handler: 'handleCleanVoiceCache' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/cache\/get$/, handler: 'handleGetCachedRefinement' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/cache\/save$/, handler: 'handleSaveCachedRefinement' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/auto-evaluate$/, handler: 'handleAutoEvaluate' },
  { method: 'POST', pattern: /^\/api\/voice-evolution\/evolve$/, handler: 'handleRunAutoEvolution' },

  // RSS 资讯

  // Panel & Scene API (delegates to panel-handler.js)
  // 2026-08-17 fix(Task 6 Red-1): 此前仅 GET /panels——前端 apiPost/apiDelete
  // /panels/stock/watchlist 路由解析 null（frontend-routes.contract root test 69/70 红）。
  // handlePanelApi 内部按 req.method 分发，此处补方法级条目即可。
  { method: 'GET', pattern: /^\/panels(\/.*)?$/, handler: 'handlePanelRoute' },
  { method: 'POST', pattern: /^\/panels(\/.*)?$/, handler: 'handlePanelRoute' },
  { method: 'DELETE', pattern: /^\/panels(\/.*)?$/, handler: 'handlePanelRoute' },
  // 2026-08-17 fix(Task 5): /api/filegen/status（FileGenPanel 快照恢复）注册到
  // ROUTE_TABLE——此前 handlePanelApi 按 pathname 直接处理,frontend-routes.contract
  // 解析 null 红（root test 全量回归红）。handlePanelApi 内部按 pathname 分发。
  // 2026-09-06: 补 POST——/api/filegen/cancel（任务取消，状态机 v2）
  { method: 'GET', pattern: /^\/api\/filegen(\/.*)?$/, handler: 'handlePanelRoute' },
  { method: 'POST', pattern: /^\/api\/filegen(\/.*)?$/, handler: 'handlePanelRoute' },
  // 2026-09-06: 主动提醒用户确认——前端通知卡"今日不再提醒"回传（risk-alert ack，
  // 治"巡检间隔=去重窗口 → 同内容全天重复播报"）
  { method: 'POST', pattern: /^\/api\/proactive\/ack$/, handler: 'handlePanelRoute' },
  { method: 'GET', pattern: /^\/api\/scene(\/.*)?$/, handler: 'handleSceneRoute' },
  { method: 'POST', pattern: /^\/api\/scene(\/.*)?$/, handler: 'handleSceneRoute' },
  // 2026-08-18: 会议记录 API（MeetingPanel 卡片）——新建/列表/全量/追加/总结/删除
  { method: 'GET', pattern: /^\/api\/meetings(\/.*)?$/, handler: 'handleMeetingsRoute' },
  { method: 'POST', pattern: /^\/api\/meetings(\/.*)?$/, handler: 'handleMeetingsRoute' },
  { method: 'DELETE', pattern: /^\/api\/meetings(\/.*)?$/, handler: 'handleMeetingsRoute' },
  // 2026-08-20: 知识库 API（DeepTutor 精华落地——读取链路闭环）
  // search/list/stats/due/delete + review（SRS 复习）——与 KbSearch/KbList 工具同源
  { method: 'GET', pattern: /^\/api\/kb(\/.*)?$/, handler: 'handleKnowledgeRoute' },
  { method: 'POST', pattern: /^\/api\/kb(\/.*)?$/, handler: 'handleKnowledgeRoute' },
  { method: 'DELETE', pattern: /^\/api\/kb(\/.*)?$/, handler: 'handleKnowledgeRoute' },

  { method: 'GET', pattern: /^\/api\/cache\/stats$/, handler: 'handleCacheStats' },
  { method: 'POST', pattern: /^\/api\/cache\/reset$/, handler: 'handleCacheReset' },
  { method: 'POST', pattern: /^\/api\/voice\/asr$/, handler: 'handleVoiceASR' },
  { method: 'GET', pattern: /^\/api\/person-card$/, handler: 'handlePersonCard' },
  { method: 'GET', pattern: /^\/api\/docs$/, handler: 'handleDocs' },
  // SP-4 SA-1: 文档产物注册表查询（FileGenPanel 历史产物区, SA-2 前端消费）
  { method: 'GET', pattern: /^\/api\/doc-artifacts$/, handler: 'handleDocArtifactsList' },
  { method: 'POST', pattern: /^\/api\/document\/convert$/, handler: 'handleDocumentConvert' },
  { method: 'GET', pattern: /^\/api\/search\/music$/, handler: 'handleMusicSearch' },
  { method: 'POST', pattern: /^\/api\/tools\/([^/]+)$/, handler: 'handleToolExecute' },
  { method: 'GET', pattern: /^\/api\/proxy-audio$/, handler: 'handleProxyAudio' },
  { method: 'POST', pattern: /^\/api\/search\/music\/lyrics$/, handler: 'handleMusicLyrics' },
  { method: 'POST', pattern: /^\/api\/voice\/tts$/, handler: 'handleVoiceTTS' },
  { method: 'POST', pattern: /^\/api\/voice\/tts\/stream$/, handler: 'handleVoiceTTSStream' },
  { method: 'GET', pattern: /^\/api\/voice\/tts\/stream$/, handler: 'handleVoiceTTSStreamGet' },
  { method: 'HEAD', pattern: /^\/api\/voice\/tts\/stream$/, handler: 'handleVoiceTTSStreamHead' },
  { method: 'GET', pattern: /^\/api\/metrics$/, handler: 'handleMetrics' },
  { method: 'POST', pattern: /^\/api\/voice\/tts\/interrupted$/, handler: 'handleTTSInterrupted' },
  { method: 'GET', pattern: /^\/api\/voice\/audio\//, handler: 'handleVoiceAudio' },
  { method: 'POST', pattern: /^\/api\/voice\/diagnose$/, handler: 'handleVoiceDiagnose' },
  { method: 'GET', pattern: /^\/api\/voice\/diagnose$/, handler: 'handleVoiceDiagnose' },

  // ── 专家协作 API（必须在通用 /api/experts 路由之前）──
  { method: 'POST', pattern: /^\/api\/experts\/collab\/start$/, handler: 'handleCollabStart' },
  { method: 'POST', pattern: /^\/api\/experts\/collab\/department$/, handler: 'handleCollabDepartment' },
  // 2026-09-08 P1: 海报/品牌包（设置页品牌包 UI 数据通道）
  { method: 'GET', pattern: /^\/api\/poster\/brand-kit$/, handler: 'handlePosterBrandKitApi' },
  { method: 'POST', pattern: /^\/api\/poster\/brand-kit$/, handler: 'handlePosterBrandKitApi' },
  { method: 'GET', pattern: /^\/api\/poster\/templates$/, handler: 'handlePosterTemplatesApi' },
  { method: 'GET', pattern: /^\/api\/experts\/collab\/status$/, handler: 'handleCollabStatus' },
  { method: 'GET', pattern: /^\/api\/experts\/collab\/list$/, handler: 'handleCollabList' },
  { method: 'GET', pattern: /^\/api\/experts\/activity$/, handler: 'handleExpertActivityGet' },
  { method: 'POST', pattern: /^\/api\/experts\/activity$/, handler: 'handleExpertActivityPost' },

  // ── 专家面板 API ──
  { method: 'GET', pattern: /^\/api\/experts($|\/)/, handler: 'handleExpertsAPI' },
  { method: 'POST', pattern: /^\/api\/experts($|\/)/, handler: 'handleExpertsAPI' },
  { method: 'POST', pattern: /^\/api\/vision\/verify$/, handler: 'handleVisualVerify' },
  { method: 'PUT', pattern: /^\/api\/experts($|\/)/, handler: 'handleExpertsAPI' },
  { method: 'DELETE', pattern: /^\/api\/experts($|\/)/, handler: 'handleExpertsAPI' },
];

const LOCAL_HANDLERS = {};

// 路由表引用 src/handlers 暴露的处理器；此前仅被 import 但从未注入，
// 导致 /api/memory、/api/calendar、/skills、/upload 等前端端点注册即 404。
Object.assign(LOCAL_HANDLERS, handlers);

// 注入子模块处理器
const _mcpHandlers = createMCPHandlers(sendJson);
const _sessionHandlers = createSessionHandlers(sendJson);
const _projectHandlers = createProjectHandlers(sendJson);
Object.assign(LOCAL_HANDLERS, _mcpHandlers, _sessionHandlers, _projectHandlers);
Object.assign(LOCAL_HANDLERS, _localExperts);
Object.assign(LOCAL_HANDLERS, _localDashboard);
Object.assign(LOCAL_HANDLERS, _localRequests);
Object.assign(LOCAL_HANDLERS, _localProfiles);
Object.assign(LOCAL_HANDLERS, _localSecurity);
Object.assign(LOCAL_HANDLERS, _localModels);
Object.assign(LOCAL_HANDLERS, _localPlugins);
Object.assign(LOCAL_HANDLERS, _localCore);
Object.assign(LOCAL_HANDLERS, _localFiles);
Object.assign(LOCAL_HANDLERS, _localDirectives);
Object.assign(LOCAL_HANDLERS, _localWebhooks);
Object.assign(LOCAL_HANDLERS, _localFeedbackLoop);
Object.assign(LOCAL_HANDLERS, _localTaskflow);
Object.assign(LOCAL_HANDLERS, _localWecom);
Object.assign(LOCAL_HANDLERS, _localAuth);
Object.assign(LOCAL_HANDLERS, _localConfigVersions);
Object.assign(LOCAL_HANDLERS, _localCache);
Object.assign(LOCAL_HANDLERS, _localSandbox);
Object.assign(LOCAL_HANDLERS, _localPerception);
Object.assign(LOCAL_HANDLERS, _localHealing);
Object.assign(LOCAL_HANDLERS, _localEvolution);
Object.assign(LOCAL_HANDLERS, _localSystem);
Object.assign(LOCAL_HANDLERS, _localMemoryGraph);
Object.assign(LOCAL_HANDLERS, _localTools);
Object.assign(LOCAL_HANDLERS, _localVoice);
Object.assign(LOCAL_HANDLERS, _localVoiceTts);
Object.assign(LOCAL_HANDLERS, _localMedia);
Object.assign(LOCAL_HANDLERS, _localDocArtifacts);
Object.assign(LOCAL_HANDLERS, _localPanelRoutes);
Object.assign(LOCAL_HANDLERS, _localPanels);
Object.assign(LOCAL_HANDLERS, _localMeetings);
Object.assign(LOCAL_HANDLERS, _localTasks);
Object.assign(LOCAL_HANDLERS, _localKnowledge);
// 2026-08-27 契约审计: vision/verify 此前 handler(handleVisualVerify)存在但未 injected——
// SceneShell 界面自检 POST /api/vision/verify 恒 404。补注入。
Object.assign(LOCAL_HANDLERS, _localVision);
Object.assign(LOCAL_HANDLERS, _localCockpit);
function resolveRoute(method, pathname) {
  const methodRoutes = ROUTE_TABLE_BY_METHOD[method];
  if (!methodRoutes) return null;

  for (const route of methodRoutes) {
    if (route.pattern.test(pathname)) {
      if (LOCAL_HANDLERS[route.handler]) {
        return LOCAL_HANDLERS[route.handler];
      }
      if (handlers[route.handler]) {
        return handlers[route.handler];
      }
      return null;
    }
  }
  return null;
}

// 预构建按 HTTP 方法分组的路由索引，避免每次请求线性扫描全部路由
const ROUTE_TABLE_BY_METHOD = {};
for (const route of ROUTE_TABLE) {
  const key = route.method;
  if (!ROUTE_TABLE_BY_METHOD[key]) ROUTE_TABLE_BY_METHOD[key] = [];
  ROUTE_TABLE_BY_METHOD[key].push(route);
}
// 导出前确保 handleMessage 已定义（如果还未定义，可能是模块级的引用问题）
// 真正的实现位于 createRequestHandler 闭包内；此处补一个安全垫避免启动崩溃，
// 实际调用路径走 ctx.handleMessage 闭包版本。
// eslint-disable-next-line no-unused-vars
let handleMessage = function(_senderId, content) {
  // 安全垫：如果闭包版本未就绪，返回通用回复
  return Promise.resolve({ reply: '消息处理模块尚未初始化' });
};
module.exports = {
  createRequestHandler,
  handleMessage,
  getLastLarkSenderId,
  broadcastEvent,
  PUBLIC_ROUTES_SET,
  PUBLIC_ROUTES_BY_METHOD,
  ROUTE_TABLE,
  LOCAL_HANDLERS,
  // 暴露路由解析供测试验证（防止回归：前端 Automation 页面依赖的 /api/* 路由必须可解析）
  resolveRoute,
};
