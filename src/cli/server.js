/**
 * CrabPaw Server - 服务器启动逻辑
 * 
 * 从 cli.js 拆分出来的核心服务器逻辑
 */

require('../core/safe-stdio').installSafeStdio();
require('../core/console-bridge').install({ prefix: 'Server' });
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { profileCheckpoint, printProfile } = require('../core/startupProfiler');
const { init } = require('../core/init');
const config = require('../core/config');
// eslint-disable-next-line no-unused-vars
const handlers = require('../handlers');
const { handleKnowledgeApi } = require('../handlers/knowledge-handler');
const { handlePanelApi, handleSceneApi } = require('../handlers/panel-handler');
const { EvolutionSystem } = require('../core/evolution');
const { MemoryTags, MemoryEntry } = require('../core/memory-tags');
const { SecuritySystem } = require('../core/security');

const {
  flowSystem, // eslint-disable-line no-unused-vars
  toolPolicyManager, // eslint-disable-line no-unused-vars
  channelRegistry, // eslint-disable-line no-unused-vars
  routeResolver, // eslint-disable-line no-unused-vars
  SetupWizard, // eslint-disable-line no-unused-vars
  createSubAgent, // eslint-disable-line no-unused-vars
  listSubAgents, // eslint-disable-line no-unused-vars
  getSubAgentStats, // eslint-disable-line no-unused-vars
  cleanupCompletedSubAgents, // eslint-disable-line no-unused-vars
  configManager, // eslint-disable-line no-unused-vars
  TOOL_PROFILES, // eslint-disable-line no-unused-vars
} = require('../core');

// eslint-disable-next-line no-unused-vars
const { safeLog, safeError } = require('./validation');
const { createRequestHandler, PUBLIC_ROUTES_SET, PUBLIC_ROUTES_BY_METHOD } = require('./request-handler');
const { authMiddleware, corsMiddleware } = require('../core/http-middleware');
const { createModelRouter } = require('../core/model-router');

const { PORT: DEFAULT_PORT } = require('../constants/product');

// eslint-disable-next-line no-unused-vars
async function startServer(options = {}) {
  let httpServer = null;
  let healthMonitor = null; // 全局 HealthMonitor（listening 后注入 targets 并启动）
  profileCheckpoint('start_server_begin');

  const ai = require('../core/ai');
  const scheduler = require('../core/scheduler');
  const skills = require('../core/skills');
  const history = require('../core/history-index');
  const state = require('../core/state');
  const commands = require('../core/commands-index');
  const { formatWithCrab } = require('../core/crabMood');
  const { createChannel } = require('../channels/lark');
  const { createChannel: createWecomChannel } = require('../channels/wecom');
  const { memoryManager } = require('../core/memory-system');
  const { SessionManager } = require('../core/session-manager');
  const taskflow = require('../taskflow');
  const { globalSkillRouter } = require('../core/skill-router');
  const { globalTaskAdapter } = require('../core/skill-task-adapter');
  const { broadcastEvent } = require('../core/sse-broadcast');
  // 2026-09-03 P3 接缝收敛: skill-executor.js 转发壳删除——executeSkill 即 skills.executeSkillAdvanced
  const { executeSkillAdvanced: executeSkill } = require('../core/skills');

  profileCheckpoint('start_server_modules_loaded');

  const CONFIG_DIR = process.env.CRABPAW_DATA_DIR 
    || path.join(__dirname, '..', '..', 'data', '.crabpaw');
  
  let PORT = process.env.API_PORT || process.env.PORT || DEFAULT_PORT;
  let ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
  
  const portFile = path.join(CONFIG_DIR, '.api_port');
  const tokenFile = path.join(CONFIG_DIR, '.api_token');
  
  if (fs.existsSync(portFile)) {
    try {
      PORT = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10);
      console.log('🔐 使用动态Port:', PORT);
    } catch (e) {
      console.warn('读取Port文件失败:', e.message);
    }
  }
  
  if (fs.existsSync(tokenFile)) {
    try {
      ADMIN_API_KEY = fs.readFileSync(tokenFile, 'utf-8').trim();
      process.env.ADMIN_API_KEY = ADMIN_API_KEY;
      console.log('🔐 使用动态 Token');
    } catch (e) {
      console.warn('读取 Token 文件失败:', e.message);
    }
  }

  if (!ADMIN_API_KEY) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      ADMIN_API_KEY = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(tokenFile, ADMIN_API_KEY, { encoding: 'utf8', mode: 0o600 });
      process.env.ADMIN_API_KEY = ADMIN_API_KEY;
      console.log('🔐 已生成 API Token（fail-closed 模式）');
    } catch (e) {
      console.warn('生成 API Token 失败，服务将以 requireApiKey 强制鉴权启动:', e.message);
    }
  }

  const PUBLIC_DIR = path.join(__dirname, '..', 'public');

  const appConfig = config.loadConfig();

  // Sync search API keys from config to env for SearchBackendManager
  if (appConfig.search?.tavilyApiKey) process.env.TAVILY_API_KEY = appConfig.search.tavilyApiKey;
  if (appConfig.search?.bingApiKey) process.env.BING_API_KEY = appConfig.search.bingApiKey;
  if (appConfig.search?.baiduApiKey) process.env.BAIDU_API_KEY = appConfig.search.baiduApiKey; // 2026-08-19 百度千帆 AI 搜索
  await init(appConfig);

  createModelRouter(appConfig);
  console.log('🎯 Model router initialized');

  // 初始化备用提供者管理器
  try {
    const { getFallbackProviderManager } = require('../core/fallback-provider');
    const fbManager = getFallbackProviderManager(appConfig);
    if (fbManager.getFallbackConfig()) {
      const fb = fbManager.getFallbackConfig();
      console.log(`🔄 Fallback provider configured: ${fb.provider}/${fb.model}`);
    }
  } catch (e) {
    console.warn('⚠️ Fallback provider module load failed:', e.message);
  }
  
  if (appConfig.models?.providers) {
    const configuredProviders = Object.entries(appConfig.models.providers)
      .filter(([_, p]) => p.apiKey && p.apiKey.trim() !== '')
      .map(([name, _]) => name);
    console.log('📋 Configured AI providers:', configuredProviders.join(', ') || '无');
  }

  await memoryManager.initialize();
  console.log('🧠 Three-tier memory system initialized');

  // 2026-08-20 DeepTutor 精华落地: 知识库记账订阅（item:failed/completed → kb_failures/kb_processed）
  try {
    require('../core/memory/kb-bookkeeping').init();
  } catch (e) {
    console.warn('⚠️ kb-bookkeeping init failed:', e.message);
  }

  const sessionManager = new SessionManager();
  await sessionManager.initialize();
  console.log('💬 Session manager initialized');

  const evolution = new EvolutionSystem({ dataDir: CONFIG_DIR });
  // Initialize evolution system with budgeted LLM client for real review execution.
  // 2026-08-27 P1-3: 换 BudgetedEvolutionClient（adapter + evolution 预算门）——若 index.js
  // 已先跑过 setLLMClient 注入（reviewFork/curator 单例共享），此处 initialize 被守卫吞掉
  // 也无害：两端注入同一包装，先到先得均受预算约束。
  try {
    const { createBudgetedEvolutionClient } = require('../core/evolution/budgeted-evolution-client');
    evolution.initialize(createBudgetedEvolutionClient());
    evolution.start();
    console.log('🦀 Evolution system initialized and started (with budgeted LLM client)');
  } catch (e) {
    console.warn('⚠️ Evolution system initialize/start failed (non-critical):', e.message);
  }
  const memoryTags = new MemoryTags(CONFIG_DIR);
  const memoryEntries = new MemoryEntry(CONFIG_DIR);
  console.log('🏷️ Memory tag system initialized');

  const securityConfig = appConfig.security || {};
  const security = new SecuritySystem(securityConfig);
  await security.initialize();

  // 注入 SSE 广播到审批系统，实现前端实时审批闭环
  if (security.approval && typeof security.approval.setSSEBroadcast === 'function') {
    security.approval.setSSEBroadcast(broadcastEvent);
    console.log('🔒 Security system initialized (approval SSE broadcast enabled)');
  } else {
    console.log('🔒 Security system initialized');
  }

  profileCheckpoint('start_server_init_done');

  const schedules = config.loadSchedules();
  const skillsRegistry = skills.load();

  // 2026-08-15 P0-2 修复: skillSystem.initialize() 此前全仓零调用——
  // initializeRouter/initializeAdapter/globalScoringSystem.updateAllScores/
  // 能力注册表 initialize/热重载启动/recommender.setSkillRegistry 从未执行,
  // ai.js 的防御只补了 router registry 一处。此处显式接线(与 ai.js 防御幂等兼容:
  // setSkillRegistry 重复调用是安全 setter)。失败不阻断启动。
  try {
    const skillSystem = require('../core/skill-system');
    skillSystem.initialize();
  } catch (e) {
    console.error('[server] skillSystem.initialize() 失败(非关键,继续启动):', e.message);
  }

  const lark = createChannel(appConfig);
  const wecom = createWecomChannel(appConfig);
  const cron = new scheduler.Scheduler();
  _globalCron = cron;

  // 2026-09-06: 异步任务完成 → 来源通道回推。通道消息处理时会登记
  // userId→会话（chat-handler recentChannelChats，2h TTL）；workflow 完成
  // 事件带 userId 命中即回推完成摘要（纯旁路，失败不阻塞）。
  try {
    const { getTaskFlowRuntime } = require('../taskflow/taskflow-runtime');
    const { handleWorkflowComplete } = require('../handlers/chat-handler');
    getTaskFlowRuntime().on('flow:completed', (data) => {
      try { handleWorkflowComplete(data, { lark, wecom, appConfig }); } catch (e) { console.warn('[channel-pushback] 失败:', e.message); }
    });
  } catch (e) {
    console.warn('[server] 通道任务回推初始化失败(不阻塞):', e.message);
  }

  cron.load(schedules);
  // 2026-09-02(R1): 注入式桥——reminder-tool/事件提醒桥写盘后经此热重载运行实例
  require('../core/scheduler-bridge').setGlobalScheduler(cron);
  // 2026-09-02(R2): 事件提醒桥——分钟级扫描日程 reminders 排一次性触发任务
  try {
    require('../schedule/event-reminder-bridge').startEventReminderBridge();
  } catch (e) {
    console.warn('[server] 事件提醒桥启动失败(不阻塞启动):', e.message);
  }
  setupCronHandlers(cron, { appConfig, skillsRegistry, lark, wecom, skills, ai, formatWithCrab });

  // 清理过期的临时任务
  try {
    const { cleanupExpiredTemporary } = require('../tools/reminder-tool');
    
    const cleaned = cleanupExpiredTemporary();
    if (cleaned > 0) {
      const cleanSchedules = config.loadSchedules();
      cron.load(cleanSchedules);
    }
  } catch (e) {
    console.warn('Failed to cleanup temporary tasks:', e.message);
  }

  try {
    await taskflow.initializeTaskFlow();

    taskflow.setSkillExecutor(async (skillName, params) => {
      console.log(`🔧 TaskFlow 技能执行器: ${skillName}`);
      try {
        const skill = Object.values(skillsRegistry).find(s => s.id === skillName || s.name === skillName);
        if (skill) {
          return await skills.execute(skill, params || {}, skillsRegistry);
        }
        return await executeSkill(skillName, params || {});
      } catch (e) {
        console.error(`❌ TaskFlow 技能执行失败 [${skillName}]:`, e.message);
        return { success: false, error: e.message };
      }
    });

    taskflow.setTaskExecutor(async (taskName, context) => {
      console.log(`📋 TaskFlow 任务执行器: ${taskName}`);
      try {
        const result = await ai.chat(context?.originalMessage || taskName, { userId: 'taskflow' });
        return { success: true, result };
      } catch (e) {
        console.error(`❌ TaskFlow 任务执行失败 [${taskName}]:`, e.message);
        return { success: false, error: e.message };
      }
    });

    const { conversationIntegration } = require('../core/taskflow-conversation-integration');
    conversationIntegration.initialize();

    taskflow.setBroadcastFn((eventType, data) => {
      broadcastEvent(eventType, data);
      conversationIntegration.handleRuntimeEvent(eventType, data);
    });

    taskflow.setSkillRouter(globalSkillRouter);
    taskflow.setTaskAdapter(globalTaskAdapter);

    const { getWorkflowTemplateEngine } = require('../taskflow/workflow-template-engine');
    const templateEngine = getWorkflowTemplateEngine();
    const registeredSkillNames = Object.values(skillsRegistry).map(s => s.id || s.name);
    const validation = templateEngine.validateTemplates(registeredSkillNames);
    if (!validation.valid) {
      const skillIssues = validation.issues.filter(i => i.issue === 'skill_not_registered');
      const expertIssues = validation.issues.filter(i => i.issue === 'expert_skill_not_registered');
      const templateIssues = validation.issues.filter(i => i.issue === 'expert_template_not_found');
      if (skillIssues.length > 0) {
        console.warn(`⚠️ 模板引用了 ${skillIssues.length} 个未注册技能:`, skillIssues.map(i => i.skill).filter((v, idx, a) => a.indexOf(v) === idx).join(', '));
      }
      if (expertIssues.length > 0) {
        console.warn(`⚠️ 专家引用了 ${expertIssues.length} 个未注册技能:`, expertIssues.map(i => i.skill).filter((v, idx, a) => a.indexOf(v) === idx).join(', '));
      }
      if (templateIssues.length > 0) {
        console.warn(`⚠️ 专家引用了 ${templateIssues.length} 个不存在的模板:`, templateIssues.map(i => i.templateId).join(', '));
      }
    } else {
      console.log(`✅ 模板校验通过: ${validation.totalTemplates} 模板, ${validation.totalExperts} 专家`);
    }

    console.log('✅ TaskFlow 系统已与技能系统、SSE广播深度集成');

    setTimeout(async () => {
      try {
        const runtime = taskflow.getTaskFlowRuntime();
        await runtime.recoverLostFlows();
        console.log('🔄 TaskFlow 启动恢复检查完成');
      } catch (e) {
        console.warn('⚠️ TaskFlow 启动恢复失败:', e.message);
      }
    }, 3000);
  } catch (tfErr) {
    console.warn('⚠️ TaskFlow init failed (non-critical):', tfErr.message);
  }

  const serverCtx = {
    appConfig,
    schedules,
    cron,
    lark,
    wecom,
    skillsRegistry,
    skills,
    ai,
    history,
    state,
    commands,
    config,
    PORT,
    apiKey: ADMIN_API_KEY,
    PUBLIC_DIR,
    memoryManager,
    sessionManager,
    evolution,
    memoryTags,
    memoryEntries,
    security,
    formatWithCrab,
    wecomBridge: null,
  };

  const { getMediaNotifier } = require('../core/file-notifier');
  const mediaNotifier = getMediaNotifier();
  mediaNotifier.init({ wecom, lark }, broadcastEvent);
  console.log('📄 Media notification system initialized (WeCom+Lark+SSE)');

  const { startPerceptionLayer, globalProactiveEngine, globalSignalBus, globalCostSensor, globalSystemHealthSensor, globalUserBehaviorSensor, globalBusinessContextSensor, globalIntentPredictor, globalProactivePlanner, globalContextPreloader, globalStrategyOptimizer, globalAdaptiveTuner, initExperienceReplay, initKnowledgeGraphEvolver, globalEvolutionSandbox } = require('../core/perception');

  // P0-3: 经验回放启动——原代码 require 不存在的 getExperienceStore（experience-store
  // 只导出 ExperienceStore 类）→ TypeError 被吞 → initExperienceReplay 从未执行。
  // 现在直接构造 ExperienceStore（统一数据目录）并启动回放引擎（start() 挂周期回放
  // + self-healing/evolution 事件监听）。
  try {
    const { ExperienceStore } = require('../core/memory/experience-store');
    const experienceStore = new ExperienceStore(path.join(CONFIG_DIR, 'experience-cards.json'));
    const replayEngine = initExperienceReplay(experienceStore);
    if (replayEngine && typeof replayEngine.start === 'function') {
      replayEngine.start();
      console.log('🧠 经验回放引擎已启动（周期模式提取 + self-healing/evolution 事件监听）');
    } else {
      console.warn('[server.js] 经验回放引擎创建失败（initExperienceReplay 返回空）');
    }
  } catch (e) {
    console.warn('[server.js] failed to start experience replay:', e.message);
  }

  // 2026-08-20 终审 I3: 决策旁路/图谱喂实此前与 evolver 共享一个 try，且决策旁路嵌套在
  // evolver if-block 内——evolver 工厂抛错或返回 null 时，决策旁路（本功能核心价值）与
  // 图谱喂实静默不装，catch 只打误导性 warn。现拆为三个独立接线块，互不牵连。
  try {
    const { getUnifiedStore } = require('../core/memory/unified-store');
    // 决策溯源旁路（run 级决策 + 哈希链）——无条件安装。旁路铁律：失败只记日志，
    // 绝不阻断启动流程。
    require('../core/memory/decision-feed').installDecisionFeed({ store: getUnifiedStore() });
  } catch (e) {
    console.error('[server.js] failed to install decision feed（决策溯源旁路不可用，主流程不受影响）:', e && e.message);
  }

  let entityGraph = null;
  try {
    const { EntityCoOccurrenceGraph } = require('../core/memory/entity-graph');
    entityGraph = new EntityCoOccurrenceGraph(null);
  } catch (e) {
    console.warn('[server.js] failed to create entity graph:', e && e.message);
  }

  if (entityGraph) {
    // 2026-08-20: 图谱实喂——会话/文档实体喂入图谱（best-effort，不依赖 evolver 成败）
    try {
      const { getUnifiedStore } = require('../core/memory/unified-store');
      const { setGraph: feedSetGraph, setStore: feedSetStore } = require('../core/memory/knowledge-feed');
      feedSetGraph(entityGraph);
      feedSetStore(getUnifiedStore());
    } catch (e) {
      console.warn('[server.js] failed to wire knowledge-feed:', e && e.message);
    }
    // 2026-08-20 终审 I1: hybrid-retrieval 图谱通道激活（spec §7.4）——setEntityGraph
    // 此前零调用方，_searchGraph 因 _entityGraph 恒为 null 直接 return []（死路）。
    try {
      require('../core/memory/hybrid-retrieval').getHybridRetrievalEngine().setEntityGraph(entityGraph);
    } catch (e) {
      console.warn('[server.js] failed to wire hybrid-retrieval entity graph:', e && e.message);
    }
  }

  try {
    // 2026-08-18: 记忆侧接线——进化器回源统一存储（setStore 由 knowledge-graph-evolver 提供）
    if (entityGraph) {
      const evolver = initKnowledgeGraphEvolver(entityGraph);
      if (evolver && typeof evolver.setStore === 'function') {
        evolver.setStore(require('../core/memory/unified-store').getUnifiedStore());
      }
    }
  } catch (e) {
    console.warn('[server.js] failed to init knowledge graph evolver:', e && e.message);
  }

  startPerceptionLayer();
  console.log('🌐 Environment awareness layer initialized');

  // P0-6: 原「桥接块」逐项调用 EvolutionSystem 不存在的 linkSystem()/syncFromLinkedSystems()
  // 并挂 5 分钟定时器——每项 TypeError 被吞、定时器静默失败。EvolutionSystem v4 自包含
  // （ReviewFork/Curator/Orchestrator），不消费这些链接；技能反馈闭环引擎在下方独立初始化，
  // 记忆统计经 memoryManager.getStats() 可查。整段删除，不保留假成功路径。
  console.log('🦀 进化系统 v4 独立运行（废弃 linkSystem 桥接块已移除）');

  // 初始化技能反馈闭环引擎
  try {
    // eslint-disable-next-line no-unused-vars
    const { getReviewFork } = require('../core/evolution/conversation-review-fork');
    const feedbackLoop = getFeedbackLoopEngine();
    feedbackLoop.initialize({
      llmClient: ai || null,
    });
    console.log('🔄 Skill feedback loop engine initialized');
  } catch (e) {
    console.warn('⚠️ 技能反馈闭环引擎init failed (non-critical):', e.message);
  }

  // 初始化进化协调器和验证器，接入技能进化系统（单例接线，P0-4/P0-5）
  try {
    const { getEvolutionCoordinator } = require('../core/evolution/evolution-coordinator');
    const { getEvolutionValidator } = require('../core/evolution/evolution-validator');
    const { getRollbackManager } = require('../core/evolution/rollback-manager');
    const { getSkillVersionStore } = require('../core/evolution/skill-version-store');
    const { getSkillEvolver } = require('../core/skill/skill-evolver');
    // 2026-08-27 P1-3: SkillEvolver 受控同预算包装（原注入 ai 模块无 chat(messages) 形
    // 系兼容降级恒 null；wrapper 提供真实 chat → _callLLM 走 choices[0].message.content）。
    const { createBudgetedEvolutionClient } = require('../core/evolution/budgeted-evolution-client');

    // P0-4: 单例协调器——此前 server.js 局部 new 实例并注册，而心跳每日
    // triggerEvolution 走 evolution-system.js 的单例 getEvolutionCoordinator()
    // → 空引擎表空转。改用单例，注册后每日进化有真实引擎。
    const coordinator = getEvolutionCoordinator();
    coordinator.initialize();

    const validator = getEvolutionValidator();
    validator.initialize();

    // P0-5: 回滚闭环依赖注入——此前 setVersionStore/setSkillEvolver 全仓零调用，
    // 自动/手动回滚恒失败。补 SkillVersionStore（快照存 data/.crabpaw/evolution/versions/）。
    const versionStore = getSkillVersionStore();
    const rollbackManager = getRollbackManager();
    rollbackManager.initialize();
    rollbackManager.setVersionStore(versionStore);
    validator.setRollbackManager(rollbackManager);
    validator.setVersionStore(versionStore);

    // P0-4: 真实 SkillEvolver 单例——此前 skill-metrics 的废弃 getSkillEvolution()
    // 返回的类无 evolver 属性 → 验证器注入与引擎注册全部跳过。
    // initialize() 对齐 skill-evolver.js 的注入点（_coordinator/_validator）。
    const skillEvolver = getSkillEvolver();
    rollbackManager.setSkillEvolver(skillEvolver);
    skillEvolver.initialize({
      llmClient: createBudgetedEvolutionClient(),
      versionStore,
      coordinator,
      validator,
      rollbackManager,
    });
    console.log('🔗 进化协调器/验证器/回滚管理器已接入技能进化系统（单例）');

    // 注册技能进化引擎到单例协调器。真实 SkillEvolver 的进化入口是
    // processSuggestion（无 evolve()）；协调器路径只做引擎状态汇报，
    // 避免 submit↔evolve 互相递归（processSuggestion 内部已本地执行进化）。
    coordinator.registerEngine('skill', {
      evolve: async () => {
        const stats = skillEvolver.getStats();
        return { improvement: 0, success: true, details: { engine: 'SkillEvolver', stats } };
      },
    });
  } catch (e) {
    console.warn('⚠️ 进化协调器/验证器init failed (non-critical):', e.message);
  }

  // 初始化用户硬规则管理器
  try {
    const { getDirectiveManager } = require('../core/directive-manager');
    const directiveManager = getDirectiveManager();
    directiveManager.initialize();
    console.log('🛡️ User hard-rule manager initialized');
  } catch (e) {
    console.warn('⚠️ 用户硬规则管理器init failed (non-critical):', e.message);
  }

  const { getGlobalKnowledgeGraphEvolver } = require('../core/perception');
  serverCtx.perception = { globalProactiveEngine, globalSignalBus, globalCostSensor, globalSystemHealthSensor, globalUserBehaviorSensor, globalBusinessContextSensor, globalIntentPredictor, globalProactivePlanner, globalContextPreloader, globalStrategyOptimizer, globalAdaptiveTuner, globalKnowledgeGraphEvolver: getGlobalKnowledgeGraphEvolver(), globalEvolutionSandbox };

  const requestHandler = createRequestHandler(serverCtx);

  const authGuard = authMiddleware({
    apiKey: ADMIN_API_KEY,
    publicRoutes: PUBLIC_ROUTES_SET,
    publicRoutesByMethod: PUBLIC_ROUTES_BY_METHOD,
    requireApiKey: true,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 2026-08-14 fix: 主服务此前从未挂载 CORS——渲染进程/浏览器跨源 fetch 无
    // ACAO 头被浏览器拦截(应用靠 IPC 代理才无感)。cors 须在 authGuard 之前,
    // 否则 401 提前返回不带 CORS 头(与 request-handler 中间件链同款配置)。
    corsMiddleware({ allowedOrigin: process.env.ALLOWED_ORIGIN || '' })(req, res, {}, () => {});
    await authGuard(req, res, { PORT }, async () => {
      let handled = await handleKnowledgeApi(req, res, url.pathname);
      if (!handled) handled = await handlePanelApi(req, res, url.pathname);
      if (!handled) handled = await handleSceneApi(req, res, url.pathname);
      if (!handled) {
        requestHandler(req, res);
      }
    });
  });
  httpServer = server;
  // 暴露给 /api/diagnose 用于"HTTP Server"层健康检查
  serverCtx.httpServer = server;

  // Task System WebSocket for Automation realtime push
  try {
    const { initTaskSystem } = require('../tasks/core/task-system-integration');
    initTaskSystem(server, cron, serverCtx);
  } catch (e) {
    console.warn('[init] Task System WebSocket start failed:', e.message);
  }

  // ── Scene WebSocket Server ──
  // 2026-08-16: 先加载 scene-kinds-tool 注册 18 个场景 kind 工具(SceneMedia 等)。
  // 此前仅 scene-tools 经 scene-tools.js 自注册 3 个(SceneSet/Get/Clear), kind 工具
  // 只被 core/scene/index.js require——启动链从不加载 → SceneMedia 纸面工具,
  // LLM 无工具可创建媒体卡/表单/图表 surface(播放视频开浏览器根因之一)。
  try {
    require('../core/scene/scene-kinds-tool');
    const { createSceneServer } = require('../core/scene/scene-server');
    createSceneServer(server, { path: '/scene', apiKey: ADMIN_API_KEY });
    console.log('  ✅ Scene WebSocket 服务器已启动 (/scene)');
  } catch (e) {
    console.warn('[init] Scene WebSocket 启动失败:', e.message);
  }

  // ── Scene Bridge（业务数据 → SceneStore 自动化投影）──
  try {
    const { getSceneBridge } = require('../core/scene/scene-bridge');
    getSceneBridge().mount();
    console.log('  ✅ Scene Bridge 已挂载（自动投影 memory/session/graph → scene）');
  } catch (e) {
    console.warn('[init] Scene Bridge 挂载失败:', e.message);
  }

  // ── Pulse Scheduler（Agent 脉动调度器）──
  try {
    const { getPulseScheduler } = require('../core/scene/pulse-scheduler');
    const pulseScheduler = getPulseScheduler();
    pulseScheduler.start();
    console.log('  ✅ Pulse Scheduler 已启动（自适应脉动调度）');
  } catch (e) {
    console.warn('[init] Pulse Scheduler 启动失败:', e.message);
  }

  // ── 轨迹保留调度（死代码收口轮 Task 1）──
  // trajectory.js cleanup(30) 此前全仓零调用——审计轨迹 JSONL 无限增长，"30 天保留"
  // 名存实亡。现挂 24h 周期清理（timer unref 不阻退出），句柄进 shutdown 优雅停止。
  let trajectoryCleanupHandle = null;
  try {
    const { scheduleTrajectoryCleanup } = require('../core/trajectory');
    trajectoryCleanupHandle = scheduleTrajectoryCleanup(); // 默认 24h / 30 天
    console.log('  ✅ 轨迹清理调度已启动（每日清理 30 天前的轨迹 JSONL）');
  } catch (e) {
    console.warn('[init] 轨迹清理调度启动失败:', e.message);
  }

  // ── Voice Cloud WebSocket Server（实时流式 ASR）──
  try {
    const { attachVoiceCloudWS } = require('../handlers/voice-cloud-ws');
    attachVoiceCloudWS(server, { apiKey: ADMIN_API_KEY });
  } catch (e) {
    console.warn('[init] Voice Cloud WebSocket 启动失败:', e.message);
  }

  function shutdown(signal) {
    console.log(`\n🛑 收到 ${signal} 信号，正在优雅关闭...`);
    
    const forceExitTimer = setTimeout(() => {
      console.warn('⚠️ Graceful shutdown timeout, force exit');
      process.exit(1);
    }, 10000);
    
    forceExitTimer.unref();
    
    try {
      if (cron && typeof cron.stop === 'function') {
        cron.stop();
        console.log('✅ 定时任务已停止');
      }
    } catch (e) {
      console.error('停止定时任务失败:', e.message);
    }

    // 停止工作流引擎调度器（initWorkflowHandler 内部创建的独立 Scheduler）
    try {
      const wfHandler = require('../handlers/workflow-handler');
      const wfScheduler = wfHandler.scheduler && wfHandler.scheduler();
      if (wfScheduler && typeof wfScheduler.stop === 'function') {
        wfScheduler.stop();
        console.log('✅ 工作流调度器已停止');
      }
    } catch (e) {
      console.warn('[shutdown] 工作流调度器停止失败:', e.message);
    }

    // 2026-08-25: RSS 资讯缓存链路已整体移除（自动刷新随链删除）

    // 停止全局健康监控
    try {
      if (healthMonitor) {
        healthMonitor.stop();
        console.log('✅ 全局健康监控已停止');
      }
    } catch (e) {
      console.warn('[shutdown] 全局健康监控停止失败:', e.message);
    }
    
    try {
      if (memoryManager && typeof memoryManager.close === 'function') {
        memoryManager.close();
        console.log('✅ 记忆系统已关闭');
      }
    } catch (e) {
      console.error('关闭记忆系统失败:', e.message);
    }

    // 清理 Scene WebSocket Server
    try {
      const { getSceneServer } = require('../core/scene/scene-server');
      const ss = getSceneServer();
      if (ss && typeof ss.destroy === 'function') {
        ss.destroy();
        console.log('✅ Scene WebSocket 已关闭');
      }
    } catch (e) {
      console.warn('[shutdown] Scene WebSocket 关闭失败:', e.message);
    }

    // 清理 Pulse Scheduler
    try {
      const { getPulseScheduler } = require('../core/scene/pulse-scheduler');
      const ps = getPulseScheduler();
      if (ps && typeof ps.destroy === 'function') {
        ps.destroy();
        console.log('✅ Pulse Scheduler 已关闭');
      }
    } catch (e) {
      console.warn('[shutdown] Pulse Scheduler 关闭失败:', e.message);
    }

    // 停止轨迹清理调度（Task 1 接线的周期句柄）
    try {
      if (trajectoryCleanupHandle && typeof trajectoryCleanupHandle.stop === 'function') {
        trajectoryCleanupHandle.stop();
        console.log('✅ 轨迹清理调度已停止');
      }
    } catch (e) {
      console.warn('[shutdown] 轨迹清理调度停止失败:', e.message);
    }

    // 清理 Voice Cloud WebSocket Server
    try {
      const { destroyVoiceCloudWS } = require('../handlers/voice-cloud-ws');
      destroyVoiceCloudWS();
      console.log('✅ Voice Cloud WebSocket 已关闭');
    } catch (e) {
      console.warn('[shutdown] Voice Cloud WebSocket 关闭失败:', e.message);
    }
    
    try {
      const { stopPerceptionLayer } = require('../core/perception');
      stopPerceptionLayer();
      console.log('✅ 环境感知层已停止');
    } catch (e) {
      console.error('停止环境感知层失败:', e.message);
    }
    
    try {
      // eslint-disable-next-line no-unused-vars
      const { getReviewFork } = require('../core/evolution/conversation-review-fork');
      const feedbackLoop = getFeedbackLoopEngine();
      feedbackLoop.shutdown();
      console.log('✅ 技能反馈闭环引擎已关闭');
    } catch (e) {

      // 降级处理

      console.warn('[server.js] 空 catch 补日志:', e && e.message);
    }

    
    try {
      const { getDirectiveManager } = require('../core/directive-manager');
      const directiveManager = getDirectiveManager();
      directiveManager.shutdown();
      console.log('✅ 用户硬规则管理器已关闭');
    } catch (e) {

      // 降级处理

      console.warn('[server.js] 空 catch 补日志:', e && e.message);
    }

    
    try {
      if (httpServer) {
        httpServer.close(() => {
          clearTimeout(forceExitTimer);
          console.log('✅ HTTP 服务器已关闭');
          process.exit(0);
        });
        
        setTimeout(() => {
          clearTimeout(forceExitTimer);
          console.warn('⚠️ HTTP server shutdown timeout, force exit');
          process.exit(1);
        }, 8000).unref();
      } else {
        clearTimeout(forceExitTimer);
        process.exit(0);
      }
    } catch (e) {
      clearTimeout(forceExitTimer);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
      return;
    }
    console.error('❌ 未捕获的异常:', err.message);
    console.error(err.stack);
    try {
      const logPath = path.join(CONFIG_DIR, 'crash.log');
      const ts = new Date().toISOString();
      fs.appendFileSync(logPath, `[${ts}] UNCAUGHT: ${err.message}\n${err.stack}\n\n`);
    } catch (e) { console.warn('[server] failed to write crash log:', e.message); }
    // EADDRINUSE 等致命错误直接退出，避免无限循环
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      process.exit(1);
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('❌ 未处理的 Promise 拒绝:', reason);
    try {
      const logPath = path.join(CONFIG_DIR, 'crash.log');
      const ts = new Date().toISOString();
      fs.appendFileSync(logPath, `[${ts}] UNHANDLED_REJECTION: ${reason}\n\n`);
    } catch (e) { console.warn('[server] failed to write unhandled rejection log:', e.message); }
  });

  // ── 单实例锁（S4：防止多实例数据分裂，不再无条件自动换端口） ──
  const lockFilePath = path.join(CONFIG_DIR, '.instance.lock');

  function cleanupLockFile() {
    try {
      if (fs.existsSync(lockFilePath)) {
        fs.unlinkSync(lockFilePath);
        console.log('🗑️  单实例锁已释放');
      }
    } catch (e) {
      console.warn('[server] 清理单实例锁文件失败:', e.message);
    }
  }

  // Windows 上 process.kill(pid, 0) 可探测进程存在性（EPERM = 存在但无权限）
  function isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  // 2026-09-09 (U盘实测): Windows 会复用 PID——锁文件里的旧 PID 在重启后可能被分配给
  // 任意进程, isPidAlive 误判"实例仍在"→ 拒绝启动 → 界面永久连接中断(实测踩坑)。
  // 校验映像名是否 node.exe(桌面/便携部署的后端均为捆绑 node.exe); 探测失败保守视为存活。
  function isCrabPawBackendPid(pid) {
    if (process.platform !== 'win32') return true;
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      return /^"node\.exe"/i.test((r.stdout || '').trim());
    } catch (e) {
      return true;
    }
  }

  function acquireInstanceLock() {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      if (fs.existsSync(lockFilePath)) {
        let alivePid = null;
        try {
          const lock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
          if (lock && lock.pid && isPidAlive(lock.pid) && isCrabPawBackendPid(lock.pid)) {
            alivePid = lock.pid;
          }
        } catch (e) {
          console.warn('[server] 单实例锁文件损坏，视为过期:', e.message);
        }
        if (alivePid) {
          console.error(`❌ 已有 CrabPaw 实例在运行 (PID ${alivePid})，请关闭后再启动`);
          console.error(`   锁文件: ${lockFilePath}`);
          process.exit(1);
        }
        // pid 已失效（异常退出残留）→ 覆盖获取锁
        console.warn('⚠️ 单实例锁文件存在但 PID 已失效，覆盖获取锁');
      }
      fs.writeFileSync(lockFilePath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      console.log(`🔒 单实例锁已获取 (PID ${process.pid})`);
    } catch (e) {
      // 锁不可用不阻断启动（如只读目录），但已尽力
      console.warn('[server] 获取单实例锁失败（继续启动）:', e.message);
    }
  }
  acquireInstanceLock();

  // 进程退出时清理锁文件（正常退出/SIGINT/SIGTERM/uncaughtException 兜底）
  process.on('exit', cleanupLockFile);

  // ── 端口冲突自动切换（S4：仅当锁文件不存在时保留自动换端口兼容） ──
  let actualPort = PORT;
  const MAX_RETRIES = 20;

  function attemptListen(port) {
    actualPort = port;
    // 2026-08-28 发行 M2: 默认绑定收紧为 127.0.0.1——单机桌面形态下面板/GUI 全走
    // 环回, 0.0.0.0 会把无鉴权面暴露给局域网(发布安全终审 M2 必修)。
    // webhook 用户(企微/飞书回调入站)需显式设 CRABPAW_HOST=0.0.0.0 恢复局域网可达。
    server.listen(port, process.env.CRABPAW_HOST || '127.0.0.1');
  }

  // 2026-09-01(R4): 会议录制态是进程内存语义——启动时把磁盘遗留的
  // recording/summarizing 标记 interrupted, 防僵尸「录制中」徽章永久滞留
  try {
    require('../core/meeting-store').gcStaleRecordings();
  } catch (e) {
    console.warn('[meeting-store] 启动 GC 失败(不阻塞启动):', e.message);
  }

  // 首次启动
  attemptListen(PORT);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // 锁文件存在 → 判定为已有实例冲突，明确报错退出（不再自动换端口）
      if (fs.existsSync(lockFilePath)) {
        console.error(`❌ 端口 ${actualPort} 被占用且存在单实例锁：已有 CrabPaw 实例在运行`);
        console.error('   请先关闭现有实例后再启动');
        process.exit(1);
      }
      // 无锁文件 → 端口被非 CrabPaw 进程占用（如用户手动占用），保留自动换端口兼容
      const nextPort = actualPort + 1;
      if (nextPort - PORT <= MAX_RETRIES) {
        console.warn(`⚠️  端口 ${actualPort} 已被其他进程占用，自动切换到 ${nextPort}…`);
        server.close();
        setTimeout(() => attemptListen(nextPort), 200);
      } else {
        console.error(`❌ 端口 ${PORT}-${nextPort - 1} 全部被占用，无法启动`);
        console.error('   请手动关闭一些程序后重试');
        process.exit(1);
      }
    } else {
      console.error('❌ 服务器错误:', err.message);
    }
  });

  server.on('listening', () => {
    PORT = actualPort;

    // ── 全局 HealthMonitor：7×24 探活 API 网关（HARNESS §9.2/9.3） ──
    try {
      const { getGlobalHealthMonitor } = require('../core/health-monitor');
      healthMonitor = getGlobalHealthMonitor();
      healthMonitor.targets = [
        { id: 'api-gateway', name: 'API Gateway', host: '127.0.0.1', port: PORT, path: '/health' },
        { id: 'http-api', name: 'HTTP API', host: '127.0.0.1', port: PORT, path: '/' },
      ];
      healthMonitor.start();
      console.log('🩺 全局健康监控已启动（' + healthMonitor.targets.length + ' 个目标, 间隔 ' + healthMonitor.intervalMs + 'ms）');
    } catch (e) {
      console.warn('⚠️ 全局健康监控启动失败:', e.message);
    }

    profileCheckpoint('start_server_listening');

    // 2026-08-25: RSS 资讯缓存自动刷新（随链移除）
    // ── 多通道统一适配器 (ECC 启发) ──────────────────────────
    try {
      const { getChannelAdapter } = require('../core/channel-adapter');
      const { registerAllAdapters } = require('../core/adapters');
      registerAllAdapters(getChannelAdapter());
      console.log('🔌 多通道统一适配器已就绪');
    } catch (e) {
      console.warn('⚠️ 通道适配器初始化失败:', e.message);
    }

    // ── 工作流引擎初始化（workflow-handler v2.0：WorkflowEngine + SkillFlow + Scheduler） ──
    try {
      const { initWorkflowHandler } = require('../handlers/workflow-handler');
      initWorkflowHandler({ port: PORT });
      console.log('⚙️ 工作流引擎已初始化（WorkflowEngine + SkillFlow + Scheduler）');
    } catch (e) {
      console.warn('⚠️ 工作流引擎初始化失败:', e.message);
    }

    // 启动进程 Watchdog 守护（Electron 模式下禁用，由 Electron 主进程管理）
    const isElectronMode = process.env.CRABPAW_ELECTRON || process.env.CRABPAW_DATA_DIR;
    if (!isElectronMode) {
      try {
        const { startWatchdog } = require('../core/process-watchdog');
        startWatchdog({ autoRestart: true });
      } catch (e) {

        // Watchdog 启动失败不影响主服务

        console.warn('[server.js] 空 catch 补日志:', e && e.message);
      }

    }

    if (process.argv.includes('--profile')) {
      printProfile();
    }

    // 2026-08-25 Phase1 P1-b/P1-d: Cordis 树基座(铺轨不换轨——服务引用/制度插件登记)
    // + fail-loud 审计。树创建失败仅告警不阻塞启动(现有路径零改动)。
    try {
      const { createHarnessTree, installHarnessTree } = require('../core/cordis/boot');
      const { assertHarnessTree } = require('../core/cordis/audit');
      (async () => {
        installHarnessTree(await createHarnessTree());
        assertHarnessTree(require('../core/cordis/boot').getHarnessTree());
        // 2026-09-03 P0-② 装配可寻址(dsh 对标机制⑥): --dump-harness 在真实树建成后
        // 打印装配面 JSON 并整体退出; 需真实树, 故挂载在启动路径此处而非独立入口。
        if (process.argv.includes('--dump-harness')) {
          const { formatHarnessDump } = require('../core/cordis/dump');
          console.log('[harness-dump] ' + JSON.stringify(formatHarnessDump(require('../core/cordis/boot').getHarnessTree())));
          process.exit(0);
        }
      })().catch((e) => console.warn('[cordis] 树审计异步失败:', e.message));
    } catch (e) {
      console.warn('[cordis] 树基座启动失败(不阻塞, 现有路径继续):', e.message);
    }

    console.log('═══════════════════════════════════════');
    console.log('    🦀 CrabPaw AI Agent Platform');
    console.log('═══════════════════════════════════════');
    console.log(`    服务器已启动: http://localhost:${PORT}`);
    console.log(`    Config page: http://localhost:${PORT}/`);
    console.log(`    健康检查: http://localhost:${PORT}/health`);
    console.log('═══════════════════════════════════════');
    console.log(`    Lark status: ${lark.isConfigured() ? '✅ configured' : '❌ not configured'}`);
    console.log(`    AI status: ${appConfig.models?.providers?.[appConfig.models?.currentProvider]?.apiKey ? '✅ configured' : '❌ not configured'}`);
    console.log('═══════════════════════════════════════');


    // 启动 OpenAI 兼容 API Server
    try {
      const { getOpenAICompatProxy, getApiServerConfig } = require('../core/openai-compat-proxy');
      const apiConfig = getApiServerConfig();

      if (apiConfig.enabled) {
        const proxy = getOpenAICompatProxy({ config: appConfig });

        // 设置 CrabPaw 聊天处理器
        proxy.setChatHandler(async (message, options) => {
          const userId = 'api_server';

          if (options.stream) {
            // 流式调用
            let fullContent = '';
            const onChunk = options.onChunk;

            const reply = await ai.chatStream(appConfig, skills, userId, message, (chunk) => {
              if (chunk.content) {
                fullContent += chunk.content;
                if (onChunk) onChunk({ content: chunk.content });
              }
              if (chunk.toolProgress && onChunk) {
                onChunk({ toolProgress: chunk.toolProgress });
              }
            });

            return { content: fullContent || reply, usage: {} };
          } else {
            // 非流式调用
            const reply = await ai.chat(appConfig, skills, userId, message);
            return { content: reply, usage: {} };
          }
        });

        proxy.start().catch(e => {
          console.error('❌ OpenAI compatible API server start failed:', e.message);
        });
      }
    } catch (e) {
      console.warn('⚠️ OpenAI compatible API server module load failed:', e.message);
    }
    console.log('    按 Ctrl+C 停止服务器');
    console.log('═══════════════════════════════════════');

    // 在 Electron 模式下跳过 event bridge 启动，由 Electron 主进程管理
    
    if (!isElectronMode) {
      const { spawn } = require('child_process');
      const eventBridgePath = path.join(__dirname, '..', 'channels', 'lark', 'event-bridge.js');
      let larkBridgeRestarts = 0;
      const MAX_BRIDGE_RESTARTS = 5;
      
      const startEventBridge = () => {
        const { getCredentialManager } = require('../core/credential-manager');
        const credMgr = getCredentialManager();
        const larkCreds = credMgr.getLarkCredentials();

        if (!larkCreds.appId || !larkCreds.appSecret) {
          console.log('⏭️ 飞书未配置 App ID 或 Secret，跳过事件桥接器启动');
          return null;
        }

        console.log('🔌 启动飞书事件桥接器...');
        const bridge = spawn('node', [eventBridgePath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            API_PORT: String(PORT),
            CRABPAW_DATA_DIR: process.env.CRABPAW_DATA_DIR || '',
            LARK_APP_ID: larkCreds.appId || '',
            LARK_APP_SECRET: larkCreds.appSecret || ''
          }
        });
        
        bridge.on('error', (err) => {
          console.error('❌ Lark event bridge start failed:', err.message);
        });
        
        bridge.on('exit', (code) => {
          console.log(`⚠️ 飞书事件桥接器退出，代码: ${code}`);
          if (code !== 0) {
            larkBridgeRestarts++;
            if (larkBridgeRestarts <= MAX_BRIDGE_RESTARTS) {
              const delay = Math.min(5000 * Math.pow(2, larkBridgeRestarts - 1), 60000);
              console.log(`🔄 将在 ${delay/1000} 秒后重启 (第 ${larkBridgeRestarts}/${MAX_BRIDGE_RESTARTS} 次)...`);
              setTimeout(startEventBridge, delay);
            } else {
              console.error(`❌ 飞书事件桥接器已达最大重启次数 (${MAX_BRIDGE_RESTARTS})，停止重启`);
            }
          }
        });
        
        return bridge;
      }
      
      startEventBridge();
      console.log('🚀 飞书事件桥接器已启动');

      const wecomBridgePath = path.join(__dirname, '..', 'channels', 'wecom', 'event-bridge.js');
      let wecomBridgeRestarts = 0;
      const MAX_WECOM_RESTARTS = 5;
      
      const startWecomBridge = function startWecomBridge() {
        const { getCredentialManager } = require('../core/credential-manager');
        const credMgr = getCredentialManager();
        const wecomCreds = credMgr.getWecomCredentials();
        
        if (!wecomCreds.botId || !wecomCreds.secret) {
          console.log('⏭️ 企业微信not configured或 Secret 无效，跳过事件桥接器启动');
          return null;
        }
        // corpId 占位符/缺失时同样不启动——桥接进程认证失败即退出，
        // 触发每 5 秒无限重启循环（crash-loop）
        if (!wecomCreds.corpId || wecomCreds.corpId === 'xxxxxxxx' || wecomCreds.corpId.length < 3) {
          console.log('⏭️ 企业微信 corpId 未配置或为占位符，跳过事件桥接器启动（请在配置中填写真实 corpId）');
          return null;
        }
        
        console.log('🔌 启动企业微信事件桥接器...');
        const bridge = spawn('node', [wecomBridgePath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            API_PORT: String(PORT),
            CRABPAW_DATA_DIR: process.env.CRABPAW_DATA_DIR || '',
            WECOM_SEND_PORT: '38769'
          }
        });
        
        bridge.on('error', (err) => {
          console.error('❌ WeCom event bridge start failed:', err.message);
        });
        
        bridge.on('exit', (code) => {
          console.log(`⚠️ 企业微信事件桥接器退出，代码: ${code}`);
          if (serverCtx.wecomBridge?._stopped) {
            console.log('⏹️ 企业微信事件桥接器已手动停止，跳过自动重启');
            serverCtx.wecomBridge._bridge = null;
            return;
          }
          if (code !== 0) {
            wecomBridgeRestarts++;
            if (wecomBridgeRestarts <= MAX_WECOM_RESTARTS) {
              const delay = Math.min(5000 * Math.pow(2, wecomBridgeRestarts - 1), 60000);
              console.log(`🔄 将在 ${delay/1000} 秒后重启 (第 ${wecomBridgeRestarts}/${MAX_WECOM_RESTARTS} 次)...`);
              setTimeout(startWecomBridge, delay);
            } else {
              console.error(`❌ 企业微信事件桥接器已达最大重启次数 (${MAX_WECOM_RESTARTS})，停止重启`);
            }
          }
        });
        
        return bridge;
      }

      // 暴露启停能力到 serverCtx，供 Gateway/Service handler 调用
      serverCtx.wecomBridge = {
        _bridge: null,
        _stopped: false,
        _startFn: startWecomBridge,
        start() {
          if (this._bridge && !this._bridge.killed) {
            console.log("⏭️ 企业微信事件桥接器已在运行中");
            return this._bridge;
          }
          this._stopped = false;
          this._bridge = this._startFn();
          return this._bridge;
        },
        stop() {
          this._stopped = true;
          if (this._bridge && !this._bridge.killed) {
            console.log("⏹️ 手动停止企业微信事件桥接器");
            this._bridge.kill("SIGTERM");
          }
        },
        isRunning() {
          return !this._stopped && !!(this._bridge && !this._bridge.killed);
        },
      };

      startWecomBridge();
      console.log('🚀 企业微信事件桥接器已启动');
    } else {
      console.log('🖥️ Electron 模式，跳过 event bridge 启动（由 Electron 主进程管理）');
    }
  });

  // ── Proactive 主动沟通决策层 v1 ─────────────────────────
  const proactive = require('../core/proactive')
  try {
    proactive.init({
      silentStart: 22,
      silentEnd: 8,
      dedupMs: 30 * 60 * 1000,
    })
    console.log('📢 Proactive 规则通道已初始化（静默 22:00-08:00，去重 30min）')
  } catch (err) {
    console.error('[server] proactive 初始化失败:', err?.message || err)
  }

  // P3: 补播队列日调度 — 静默时段(22-8)积压的通知在次日 08:01 统一冲刷
  function scheduleProactiveFlush() {
    const now = new Date()
    const next = new Date(now)
    next.setHours(proactive.getSilentEnd(), 1, 0, 0) // 静默结束小时，默认 8
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    setTimeout(() => {
      try {
        const n = proactive.flushAndBroadcast()
        if (n > 0) console.log(`[proactive] 补播 ${n} 条夜间积压通知`)
      } catch (err) {
        console.error('[proactive] 补播失败:', err?.message || err)
      }
      scheduleProactiveFlush()
    }, next.getTime() - now.getTime())
  }
  try {
    scheduleProactiveFlush()
  } catch (err) {
    console.error('[proactive] 补播调度初始化失败:', err?.message || err)
  }

  return server;
}

async function _pushTaskResult(task, result, channels) {
  const { wecom, lark, formatWithCrab } = channels;
  const channel = task.params?.channel || task.channel || 'wecom';
  const message = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  const formatted = formatWithCrab(message);
  // 优先使用任务自带的收件人：群 -> 人 -> 都没有则保持 null（由 channel 默认路由兜底）
  const wecomTarget = task.params?.targetChatId
    || task.targetChatId
    || task.params?.targetUserId
    || task.targetUserId
    || null;
  const larkTarget = wecomTarget; // lark/wecom 共享同一组 target 字段

  try {
    if (channel === 'wecom' || channel === 'both') {
      if (wecom) {
        // 优先使用 sendSmart 自动选择发送方式
        if (typeof wecom.sendSmart === 'function') {
          await wecom.sendSmart(wecomTarget, formatted, 'single', {});
          console.log(`📤 定时任务结果已推送到企微: ${task.name} -> ${wecomTarget || 'default'}`);
        } else if (typeof wecom.sendMarkdown === 'function') {
          await wecom.sendMarkdown(wecomTarget, formatted);
          console.log(`📤 定时任务结果已推送到企微(markdown): ${task.name} -> ${wecomTarget || 'default'}`);
        } else if (typeof wecom.send === 'function') {
          await wecom.send(wecomTarget, formatted);
          console.log(`📤 定时任务结果已推送到企微: ${task.name} -> ${wecomTarget || 'default'}`);
        }
      }
    }
    if (channel === 'lark' || channel === 'both') {
      if (lark) {
        if (typeof lark.send === 'function') {
          await lark.send(larkTarget, formatted);
          console.log(`📤 定时任务结果已推送到飞书: ${task.name} -> ${larkTarget || 'default'}`);
        } else if (typeof lark.sendMarkdown === 'function') {
          await lark.sendMarkdown(larkTarget, formatted);
          console.log(`📤 定时任务结果已推送到飞书(markdown): ${task.name} -> ${larkTarget || 'default'}`);
        }
      }
    }
  } catch (e) {
    console.error(`❌ 推送定时任务结果失败: ${e.message}`);
  }
}

function setupCronHandlers(cron, ctx) {
  const { appConfig, skillsRegistry, lark, wecom, skills, ai, formatWithCrab } = ctx;

  cron.register('send_message', async (task) => {
    const { target, message } = task.params || {};
    if (!target || !message) {
      console.error('❌ 定时任务缺少参数');
      return;
    }

    try {
      const formattedMessage = formatWithCrab(message);
      await lark.send(target, formattedMessage);
      console.log(`✅ 定时消息已发送到 ${target}`);
    } catch (e) {
      console.error(`❌ 发送定时消息失败:`, e.message);
    }
  });

  cron.register('run_skill', async (task) => {
    const { skillId, input } = task.params || {};
    if (!skillId) {
      console.error('❌ 定时任务缺少技能ID');
      return;
    }

    try {
      const skill = Object.values(skillsRegistry).find(s => s.id === skillId);
      if (!skill) {
        console.error(`❌ 未找到技能: ${skillId}`);
        return;
      }

      // eslint-disable-next-line no-unused-vars
      const result = await skills.execute(skillId, input || {}, skillsRegistry);
      console.log(`✅ 定时技能执行完成: ${skillId}`);
    } catch (e) {
      console.error(`❌ 执行定时技能失败:`, e.message);
    }
  });

  cron.register('ai_task', async (task) => {
    const { prompt } = task.params || {};
    if (!prompt) {
      console.error('❌ 定时任务缺少提示词');
      return;
    }

    try {
      // eslint-disable-next-line no-unused-vars
      const result = await ai.chat(prompt, { userId: 'scheduler' });
      console.log(`✅ 定时AI任务完成: ${prompt.substring(0, 30)}...`);
    } catch (e) {
      console.error(`❌ 执行定时AI任务失败:`, e.message);
    }
  });

  cron.register('skill', async (task) => {
    const skillName = task.skill;
    if (!skillName) {
      console.error('❌ 定时任务缺少技能名称');
      return { success: false, error: '缺少技能名称' };
    }

    try {
      console.log(`⏰ 定时触发技能: ${skillName}`);
      
      const skill = Object.values(skillsRegistry).find(s => s.id === skillName || s.name === skillName);
      if (!skill) {
        console.warn(`⚠️ 未找到技能: ${skillName}，回退到AI任务模式`);
        const instruction = task.params?.instruction || task.params?.prompt || `执行技能 ${skillName} 的任务`;
        const prompt = `[定时任务: ${task.name}]\n技能 ${skillName} 未注册，请直接执行以下指令:\n${instruction}`;
        const result = await ai.chat(prompt, { userId: 'scheduler' });
        console.log(`✅ AI回退执行完成: ${task.name}`);

        // 推送结果到配置的通道
        if (result) {
          await _pushTaskResult(task, result, { wecom, lark, formatWithCrab });
        }

        return {
          success: true,
          message: `技能 ${skillName} 通过AI回退执行完成`,
          taskId: task.id,
          taskName: task.name,
          fallback: true,
          result: result
        };
      }

      const result = await skills.execute(skillName, task.params || {}, skillsRegistry);
      console.log(`✅ 定时技能执行完成: ${skillName}`);

      // 推送结果到配置的通道
      if (result) {
        await _pushTaskResult(task, result, { wecom, lark, formatWithCrab });
      }

      return {
        success: true,
        message: `技能 ${skillName} 执行完成`,
        taskId: task.id,
        taskName: task.name,
        result: result
      };
    } catch (e) {
      console.error(`❌ 执行定时技能失败:`, e.message);
      return { success: false, error: e.message };
    }
  });

  cron.register('search', async (task) => {
    const keyword = task.params?.keyword || task.params?.query;
    if (!keyword) {
      console.error('❌ 定时任务缺少搜索关键词');
      return { success: false, error: '缺少搜索关键词' };
    }

    try {
      console.log(`⏰ 定时触发搜索: ${keyword}`);
      
      const result = await skills.execute('multi-search-engine', task.params || {}, skillsRegistry, (kw, results) => {
        return ai.summarize(appConfig, kw, results);
      });
      
      console.log(`✅ 定时搜索执行完成: ${keyword}`);
      
      return {
        success: true,
        message: `搜索任务执行完成`,
        keyword: keyword,
        taskId: task.id,
        taskName: task.name,
        result: result
      };
    } catch (e) {
      console.error(`❌ 执行定时搜索失败:`, e.message);
      return { success: false, error: e.message };
    }
  });

  cron.register('reminder', async (task) => {
    const { channel, message } = task;
    // 兼容多种字段命名：targetUserId / targetChatId 顶层或 params.*
    const target = task.targetChatId
      || task.targetUserId
      || task.params?.targetChatId
      || task.params?.targetUserId
      || task.targetId
      || null;
    console.log(`⏰ 提醒触发: [${channel}] -> ${target || 'default'} ${message}`);

    try {
      const proactive = require('../core/proactive')
      proactive.notify({
        trigger: 'reminder',
        text: `提醒：${message}`,
        intent: 'inform',
        surface: { id: `reminder-${Date.now()}`, kind: 'text', data: { title: '提醒', body: message } },
      })
    } catch (err) {
      console.error('[server] proactive 接入失败:', err?.message || err)
    }

    try {
      const formatted = formatWithCrab(`⏰ **提醒**\n\n${message}`);

      if (channel === 'wecom' && wecom) {
        if (typeof wecom.sendSmart === 'function') {
          await wecom.sendSmart(target, formatted, 'single', {});
        } else if (typeof wecom.sendMarkdown === 'function') {
          await wecom.sendMarkdown(target, formatted);
        } else if (typeof wecom.send === 'function') {
          await wecom.send(target, formatted);
        }
      } else if (channel === 'lark' && lark) {
        if (typeof lark.send === 'function') {
          await lark.send(target, formatted);
        } else if (typeof lark.sendMarkdown === 'function') {
          await lark.sendMarkdown(target, formatted);
        }
      } else if (channel === 'both') {
        if (wecom && typeof wecom.sendSmart === 'function') {
          await wecom.sendSmart(target, formatted, 'single', {});
        }
        if (lark && typeof lark.send === 'function') {
          await lark.send(target, formatted);
        }
      } else if (channel === 'none' || !channel) {
        // P2-4: 无外部通道 → 提醒已通过上方 proactive.notify 在本机播报（应用内播报+通知卡）
        console.log("✅ 提醒已在本机播报（无外部通道）: " + (task.name || task.id));
      }
      console.log(`✅ 提醒已发送: ${task.name} -> ${target || 'default'}`);

      // 一次性提醒：触发后即移除（cron 为每日模式，不移除会每日重复触发；此前缺 name/action 从不触发故未暴露）。
      // 内存 pause + 持久化删除双管齐下，只影响一次性提醒，不影响重复提醒与 wecom/lark 正常路径。
      if (!task.repeat && task.id) {
        try {
          const { removeReminderFromSchedules } = require('../tools/reminder-tool');
          if (removeReminderFromSchedules(task.id)) {
            cron.pauseTask(task.id);
            console.log(`✅ 一次性提醒已触发并移除: ${task.name || task.id}`);
          }
        } catch (e) {
          console.error('[server] 一次性提醒清理失败:', e && e.message ? e.message : e);
        }
      }
      return { success: true, channel, target };
    } catch (e) {
      console.error(`❌ 提醒发送失败:`, e.message);
      return { success: false, error: e.message };
    }
  });

}

// 全局调度器引用，供 reminder-tool 等模块访问
let _globalCron = null;

function getGlobalCron() {
  return _globalCron;
}

module.exports = {
  startServer,
  setupCronHandlers,
  getGlobalCron,
};

// Feedback loop engine for skill continuous improvement
const { getFeedbackLoopEngine } = require('../core/skill/feedback-loop-engine');
