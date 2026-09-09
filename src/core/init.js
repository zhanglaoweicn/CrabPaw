const fs = require('fs');
const path = require('path');
const { profileCheckpoint } = require('./startupProfiler');
const state = require('./state');
const config = require('./config');
const { dataHub } = require('./data-hub');
// 2026-08-27 C2: 试点消费者——经 harness 树取服务引用(与树同对象); 树未建时回退直取。
const { getHarnessContext } = require('./cordis/context');
const serviceRegistry = getHarnessContext()?.ctx?.serviceRegistry ?? require('../services/registry').serviceRegistry;
const { analyticsService } = require('../services/analytics');
const { toolSummaryService } = require('../services/toolSummary');
const { policyLimitsService } = require('../services/policyLimits');
const { getPluginManager } = require('./plugin-system');
const { agentSummaryService } = require('../services/agentSummary');
const { memoryExtractionService } = require('../services/memoryExtraction');

const {
  flowSystem,
  toolPolicyManager,
  // eslint-disable-next-line no-unused-vars
  channelRegistry,
  routeResolver,
} = require('./index');

const { configManager } = require('./config');
const { getChannelEventBus } = require('./channels/channel-event-bus');
const { getProactiveMessenger } = require('./channels/channel-event-bus');
const { getLogger, getMetricsCollector, getHealthChecker } = require('./observability');
const { getSandboxManager } = require('./security/sandbox');
const { getUnifiedContextManager } = require('./context/unified-context-manager');
const { getAgentRegistry, getTriagePipeline } = require('./agent/agent-registry');
const lifecycleManager = require('./lifecycle-manager');

let initialized = false;
let initPromise = null;

const CLEANUP_HANDLERS = [];

function registerCleanup(handler) {
  CLEANUP_HANDLERS.push(handler);
}

async function runCleanup() {
  console.log('\n🧹 Running cleanup handlers...');
  
  for (const handler of CLEANUP_HANDLERS) {
    try {
      await handler();
    } catch (e) {
      console.error('Cleanup handler error:', e.message);
    }
  }
  
  try {
    await serviceRegistry.shutdownAll();
    console.log('✅ 所有服务已关闭');
  } catch (e) {
    console.error('服务关闭错误:', e.message);
  }
}

function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal} 信号，正在关闭...`);
    await runCleanup();
    return;
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 注册生命周期管理器清理（定时器 + 受管Map/Set）
  registerCleanup(() => {
    const status = lifecycleManager.getStatus();
    console.log(`[Lifecycle] 清理: ${status.timers} 个定时器, ${status.maps} 个Map`);
    lifecycleManager.shutdown();
  });

  process.on('uncaughtException', (error) => {
    if (error && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')) {
      return;
    }
    console.error('未捕获的异常:', error);
    if (state.getState) {
      state.logError(error, { type: 'uncaught_exception' });
    }
  });
  
  process.on('unhandledRejection', (reason, _promise) => {
    console.error('未处理的 Promise 拒绝:', reason);
    if (state.getState) {
      state.logError(new Error(String(reason)), { type: 'unhandled_rejection' });
    }
  });
}

async function init(appConfig) {
  if (initialized) {
    return appConfig;
  }
  
  if (initPromise) {
    return initPromise;
  }
  
  initPromise = (async () => {
    const initStartTime = Date.now();
    profileCheckpoint('init_start');
    
    try {
      profileCheckpoint('init_state');
      state.initState(appConfig);
      
      profileCheckpoint('init_graceful_shutdown');
      setupGracefulShutdown();
      
      profileCheckpoint('init_workspace');
      ensureWorkspaceDir();
      
      profileCheckpoint('init_data_dir');
      ensureDataDir();
      
      profileCheckpoint('init_data_hub');
      dataHub.initialize();
      registerCleanup(() => dataHub.close());
      
      // 语音进化系统定时进化（每30分钟自动运行一次）
      try {
        const voiceEvolution = require('./voice-evolution');
        const VOICE_EVOLUTION_INTERVAL = 30 * 60 * 1000; // 30分钟
        const voiceEvolutionTimer = setInterval(() => {
          try {
            voiceEvolution.runAutoEvolution();
          } catch (err) {
            console.warn('[Init] 语音进化定时任务失败:', err.message);
          }
        }, VOICE_EVOLUTION_INTERVAL);
        registerCleanup(() => clearInterval(voiceEvolutionTimer));
        // 2026-08-07: 全局标记——voice-evolution 插件据此跳过重复调度
        global.__voiceEvolutionTimerRegistered = true;
        console.log('[Init] 语音进化定时任务已注册 (间隔: 30分钟)');
      } catch (err) {
        console.warn('[Init] 语音进化系统初始化失败:', err.message);
      }
      
      profileCheckpoint('init_services');
      await initializeServices(appConfig);
      
      profileCheckpoint('init_core_systems');
      await initializeCoreSystems(appConfig);

      // ── Harness: Dashboard ↔ Metrics 绑定 ──
      try {
        // eslint-disable-next-line no-unused-vars
        const { globalDashboard, bindDashboardToMetrics } = require('./dashboard');
        const { globalMetricsPipeline } = require('./metrics-pipeline');
        bindDashboardToMetrics(globalMetricsPipeline);
        registerCleanup(() => { /* Dashboard has no shutdown, metrics-pipeline snapshot timer auto-clears */ });
        console.log('[Init] Dashboard bound to global MetricsPipeline');
      } catch (e) {
        console.warn('[Init] Dashboard binding skipped:', e.message);
      }

      const duration = Date.now() - initStartTime;
      state.recordEvent('init_completed', { duration });

      profileCheckpoint('init_complete');
      initialized = true;

      console.log(`✅ 初始化完成 (${duration}ms)`);

      // ── 觉醒阶段（后台异步，不阻塞启动） ──
      try {
        const { getAwakening } = require('./awakening');
        setImmediate(() => {
          getAwakening().run({ skipSceneCard: true, timeoutMs: 5000 })
            .then((s) => {
              if (s.status === 'done') {
                console.log(`🌅 觉醒完成 (${s.durationMs}ms) — ${s.userName || '匿名'}, ${s.environment?.tools ? Object.keys(s.environment.tools).length : 0} 工具`);
              } else if (s.status === 'failed') {
                console.warn(`[init] 觉醒失败: ${s.error}`);
              }
            })
            .catch((e) => console.warn('[init] 觉醒异常:', e.message));
        });
      } catch (e) {
        console.warn('[Init] 觉醒模块加载失败:', e.message);
      }

      return appConfig;
      
    } catch (error) {
      state.logError(error, { phase: 'init_failed' });
      // 2026-08-18: 失败后重置 initPromise，允许第二次 init() 重新执行
      initPromise = null;
      throw error;
    }
  })();
  
  return initPromise;
}

function ensureWorkspaceDir() {
  const workspaceDir = config.WORKSPACE_DIR;
  
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
    console.log(`📁 创建工作空间目录: ${workspaceDir}`);
  }
  
  const defaultFiles = {
    'IDENTITY.md': `# CrabPaw 身份

我是一个智能助手，专注于帮助用户完成各种任务。

## 核心能力
- 信息搜索与整合
- 任务规划与执行
- 多渠道消息推送
- 定时任务调度
`,
    'USER.md': `# 用户档案

## 基本信息
- 称呼: 用户
- 偏好: 简洁明了的回复
- 语言: 中文

## 工作习惯
- 常用的项目路径会在这里记录
- 特殊的工具偏好会在这里更新

> 你可以编辑这个文件来告诉我你的偏好和习惯，我会在对话中参考这些信息。
> 路径: crabpaw-data/USER.md
`
  };
  
  for (const [filename, content] of Object.entries(defaultFiles)) {
    const filePath = path.join(workspaceDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
}

function getDataBaseDir() {
  if (process.env.CRABPAW_DATA_DIR) {
    return process.env.CRABPAW_DATA_DIR;
  }
  return path.join(__dirname, '..', '..', 'data', '.crabpaw');
}

function ensureDataDir() {
  const dataDir = getDataBaseDir();
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`📁 创建数据目录: ${dataDir}`);
  }
}

async function initializeServices(appConfig) {
  console.log('🔧 初始化服务层...');
  
  const dataDir = getDataBaseDir();
  const logDir = path.join(dataDir, 'logs');
  // S4: 目录归一——旧实现另建 data/<dataDir>/memories 空目录,实际记忆主目录是
  // data/.crabpaw/memory(AutoMemory/MemoryManager/EnhancedMemorySystem 共用)。
  // memoryExtractionService 的 _memoryDir 字段从不被使用,故删除空目录创建。
  const pluginDir = path.join(dataDir, 'plugins');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }
  
  serviceRegistry.register('analytics', analyticsService);
  serviceRegistry.register('toolSummary', toolSummaryService);
  serviceRegistry.register('policyLimits', policyLimitsService);
  serviceRegistry.register('pluginManager', {
    getManager: () => getPluginManager(),
    initialize: async (opts) => {
      const manager = await getPluginManager();
      if (opts?.pluginDir) {
        await manager._loadFromDir(opts.pluginDir, 'user');
      }
    },
  });
  serviceRegistry.register('agentSummary', agentSummaryService);
  serviceRegistry.register('memoryExtraction', memoryExtractionService);

  // 2026-08-18: serviceRegistry.initializeAll 此前全仓零调用 → entry.initialized 恒
  // false → runCleanup 里 shutdownAll 从不执行任何 shutdown。先以默认参数跑一遍
  // registry 生命周期（打 initialized 标记），随后下方以真实配置重新初始化各服务。
  try {
    await serviceRegistry.initializeAll();
  } catch (e) {
    console.warn('[init] serviceRegistry.initializeAll 失败（继续手动初始化）:', e.message);
  }

  // 2026-08-25 S1: hooks 管理器接线（此前该模块仅被 src/core/index.js lazyRequire
  // 导出、无任何启动消费——用户 ~/.crabpaw/hooks/*.json 从不加载，形同孤儿）。
  // 单例构造即解析用户钩子目录；标准钩子（logger/session-tracker/error-handler）
  // 随单例经 createStandardHooks 注册，后续 emit 点即有消费者。
  try {
    const { getHookManager } = require('./hooks/manager');
    const hookManager = getHookManager();
    console.log(`🔌 Hooks 管理器已接线 (用户钩子目录: ${hookManager.hooksPath})`);
  } catch (e) {
    console.warn('[init] hooks 管理器接线失败:', e.message);
  }

  await analyticsService.initialize({
    logDir,
    sessionId: appConfig.sessionId || Date.now().toString(),
  });
  
  await toolSummaryService.initialize();
  
  await policyLimitsService.initialize({
    configDir: dataDir,
  });
  
  const pm = serviceRegistry.get('pluginManager');
  await pm.initialize({
    pluginDir,
  });

  await agentSummaryService.initialize();

  // S4: memoryDir 已删除(空目录停建);memoryExtractionService 的 _memoryDir 字段
  // 从不被使用,无需传参
  await memoryExtractionService.initialize();

  // 2026-08-01: MCP 管理器启动初始化（此前整个启动序列零调用，
  // MCP 服务器从不自动连接，工具从未进入 LLM 链路）
  try {
    const { getMCPManager } = require('./mcp/mcp-manager');
    await getMCPManager().initialize();
    console.log('✅ MCP 管理器初始化完成');
  } catch (e) {
    console.warn('⚠️ MCP 管理器初始化失败:', e.message);
  }

  console.log('✅ 服务层初始化完成');
}

async function initializeCoreSystems(appConfig) {
  console.log('🔧 初始化核心系统...');

  let logger = null;
  try {
    const configPath = path.join(process.cwd(), 'crabpaw.config.json');
    configManager.load(configPath);
    console.log('  ✅ 配置管理器已初始化');
    
    const { registerBuiltinChannels } = require('./channel-registry');
    registerBuiltinChannels();
    console.log('  ✅ 频道注册表已初始化');
    
    if (appConfig.bindings && Array.isArray(appConfig.bindings)) {
      for (const binding of appConfig.bindings) {
        routeResolver.addBinding(binding);
      }
      console.log(`  ✅ 已加载 ${appConfig.bindings.length} 个路由绑定`);
    }
    
    if (appConfig.flows && Array.isArray(appConfig.flows)) {
      for (const flow of appConfig.flows) {
        flowSystem.registerContribution(flow);
      }
      console.log(`  ✅ 已注册 ${appConfig.flows.length} 个 Flow 贡献`);
    }
    
    if (appConfig.toolProfiles) {
      for (const [name, profile] of Object.entries(appConfig.toolProfiles)) {
        toolPolicyManager.registerCustomProfile(name, profile);
      }
      console.log(`  ✅ 已注册 ${Object.keys(appConfig.toolProfiles).length} 个自定义工具配置`);
    }
    
    logger = getLogger({ level: 2, consoleEnabled: true, fileEnabled: true });
    // --- Logger initialized: all logging below should use logger instead of console ---
    logger.info('CrabPaw 初始化开始', { phase: 'core_systems' });
    logger.info('  ✅ 结构化日志已初始化');
    
    const metrics = getMetricsCollector();
    const initTimer = metrics.startTimer('init_duration');
    logger.info('  ✅ 指标收集器已初始化');
    
    const healthChecker = getHealthChecker();
    healthChecker.registerCheck('memory', async () => {
      const mem = process.memoryUsage();
      return { status: 'healthy', detail: `RSS: ${Math.round(mem.rss / 1024 / 1024)}MB` };
    });
    healthChecker.registerCheck('eventbus', async () => {
      const bus = getChannelEventBus();
      return { status: 'healthy', channels: bus.listChannels().length };
    });
    logger.info('  ✅ 健康检查器已初始化');
    
    const sandboxManager = getSandboxManager({ defaultProfile: 'standard' });
    sandboxManager.createSandbox('workspace', 'standard', {
      workspaceRoot: config.WORKSPACE_DIR,
    });
    sandboxManager.createSandbox('skill', 'restricted');
    logger.info('  ✅ 安全沙箱已初始化');
    
    const eventBus = getChannelEventBus();
    logger.info('  ✅ 通道事件总线已初始化');
    
    const proactiveMessenger = getProactiveMessenger({ eventBus });
    proactiveMessenger.start();
    logger.info('  ✅ 主动消息系统已初始化');
    // 经营风险告警 + 场景提醒（原播报桥一并启动；桥移除后直连，保持行为不回归）
    let riskAlertService = null;
    try {
      const { globalRiskAlertService } = require('./proactive/risk-alert-service');
      riskAlertService = globalRiskAlertService;
      globalRiskAlertService.start();
    } catch (e) {
      console.error('初始化风险告警失败:', e.message || e);
    }
    let scenarioReminderEngine = null;
    try {
      const { globalScenarioReminderEngine } = require('./proactive/scenario-reminder-engine');
      scenarioReminderEngine = globalScenarioReminderEngine;
      const { listHoldings } = require('../tools/stock-holdings-tools');
      const { buildPreopenBriefing } = require('./stock-helper');
      globalScenarioReminderEngine.start({
        getContext: () => ({
          city: '深圳', // v1 固定城市；后续读老板画像偏好
          schedules: [], // v1 空；后续接 calendar-tool 事件
          holdings: listHoldings(),
          stockBriefText: buildPreopenBriefing({ sh: null, holdings: listHoldings() }).text,
        }),
      });
    } catch (e) {
      console.error('初始化场景化提醒失败:', e.message || e);
    }
    // 2026-08-18: 两个主动服务此前启动后未注册 stop → 优雅关闭不停止其定时器
    registerCleanup(() => {
      try { if (riskAlertService) riskAlertService.stop(); } catch (e) { console.warn('[init] 风险告警服务停止失败:', e.message); }
      try { if (scenarioReminderEngine) scenarioReminderEngine.stop(); } catch (e) { console.warn('[init] 场景提醒引擎停止失败:', e.message); }
    });

    // eslint-disable-next-line no-unused-vars
    const contextManager = getUnifiedContextManager({
      contextWindow: appConfig.contextWindow || 128000,
    });
    logger.info('  ✅ 统一上下文管理器已初始化');
    
    // eslint-disable-next-line no-unused-vars
    const agentRegistry = getAgentRegistry();
    // eslint-disable-next-line no-unused-vars
    const triagePipeline = getTriagePipeline();
    logger.info('  ✅ Agent注册表与Triage管道已初始化');
    
    const { getMemoryTreeOrchestrator } = require('./memory/memory-tree-v2');
    const memoryTreeOrchestrator = getMemoryTreeOrchestrator();
    logger.info('  ✅ 记忆树编排器已初始化');
    
    const { getCommitmentTracker } = require('./commitment/commitment-tracker');
    const commitmentTracker = getCommitmentTracker();
    await commitmentTracker.initialize();
    logger.info('  ✅ 承诺追踪系统已初始化');
    
    const { getTieredSubAgentRunner } = require('./agent/tiered-subagent-runner');
    // eslint-disable-next-line no-unused-vars
    const tieredRunner = getTieredSubAgentRunner();
    logger.info('  ✅ 分层子智能体系统已初始化');
    
    const { getContextEngineRegistry } = require('./context/context-engine-plugin');
    const contextEngineRegistry = getContextEngineRegistry();
    contextEngineRegistry.setActive('hybrid');
    logger.info('  ✅ 上下文引擎插件系统已初始化 (hybrid)');
    
    // 经验回放(ExperienceStore + ExperienceReplay)在 src/cli/server.js 装配
    // (initExperienceReplay(store).start())——此处此前为假接线(实例创建后零消费,
    // 2026-08-28 移除), 日志曾谎报"已初始化"。
    
    const { getSkillCuratorV2 } = require('./skill/skill-curator-v2');
    const skillCuratorV2 = getSkillCuratorV2({
      stateFile: path.join(getDataBaseDir(), 'curator', 'curator-state.json'),
    });
   await skillCuratorV2.initialize();
   logger.info('  ✅ 技能Curator V2已初始化');
   
   // P1: Wire SelfPlayTester — 自我对弈测试器（2小时周期）
   const { getSelfPlayTester } = require('./skill/self-play-tester');
   try {
     const selfPlayTester = getSelfPlayTester({ skillCuratorV2 });
     selfPlayTester.start();
     logger.info('  ✅ 技能自我对弈测试器已启动');
     registerCleanup(() => selfPlayTester.shutdown());
   } catch (e) { logger.warn('SelfPlayTester 启动失败:', e.message); }

   // P1: Wire RegressionGuard — 技能进化后回归检测
   const { getRegressionGuard } = require('./skill/regression-guard');
   try {
     const regressionGuard = getRegressionGuard({ skillCuratorV2 });
     regressionGuard.start();
     logger.info('  ✅ 回归守护已启动');
     registerCleanup(() => regressionGuard.shutdown());
   } catch (e) { logger.warn('RegressionGuard 启动失败:', e.message); }

   // P1: Wire SkillHealthChecker — 技能健康检查（每日周期）
   // BUG FIX: 此前解构 skills.js 不存在的 skillSystem 导出（恒 undefined），
   // 且 SkillHealthChecker 没有 start() 方法——健康检查从未执行，日志却谎报已启动。
   const { getSkillHealthChecker } = require('./skill/skill-health-checker');
   try {
     const skillHealthChecker = getSkillHealthChecker();
     const { loadSkills } = require('./skills');
     const runHealthCheck = () => {
       try {
         const skills = loadSkills();
         const report = skillHealthChecker.check(skills, []);
         if (report.issues > 0) {
           logger.warn(`技能健康检查: ${report.issues} 个问题（critical ${report.bySeverity.critical}）`);
         } else {
           logger.info(`技能健康检查: ${report.totalSkills} 个技能全部健康`);
         }
       } catch (e) { logger.warn('技能健康检查执行失败:', e.message); }
     };
     runHealthCheck();
     const healthTimer = setInterval(runHealthCheck, 24 * 60 * 60 * 1000);
     if (healthTimer.unref) healthTimer.unref();
     registerCleanup(() => clearInterval(healthTimer));
     logger.info('  ✅ 技能健康检查器已启动（每日周期）');
   } catch (e) { logger.warn('SkillHealthChecker 启动失败:', e.message); }

   initTimer();
    
    registerCleanup(async () => {
      logger.info('CrabPaw 关闭清理开始');
      // 关闭 fs.watch 监听器
      try { const { contextCache } = require('./context-cache'); contextCache.destroy(); } catch (e) { logger.warn('contextCache 清理失败:', e.message); }
      try { const { getThreatPatternLoader } = require('./security/threat-pattern-loader'); getThreatPatternLoader().destroy(); } catch (e) { logger.warn('threat-pattern-loader 清理失败:', e.message); }
      commitmentTracker.shutdown();
      skillCuratorV2.shutdown();
      memoryTreeOrchestrator.shutdown();
      proactiveMessenger.stop();
      healthChecker.stop();
      logger.close();
    });
    
    // 初始化 MediaNotifier，用于 SSE 广播文件生成事件
    const { getMediaNotifier } = require('./file-notifier');
    const { broadcastEvent: sseBroadcastEvent } = require('./sse-broadcast');
    const mediaNotifier = getMediaNotifier();
    mediaNotifier.init(null, sseBroadcastEvent);
    logger.info('  ✅ MediaNotifier 已初始化 (SSE 广播)');

    // ── ACI 预判注入系统（含定时预热） ──
    try {
      const { initializeACI } = require('./aci/index');
      // 注入 memoryManager + toolExecutor，让 Phase 1（语义记忆）和 Phase 3（工具链预执行）真正生效
      let aciMemoryManager = null;
      let aciToolExecutor = null;
      try { aciMemoryManager = require('./unified-memory').memoryManager || null; } catch (e) {
        /* ignore */
        console.warn('[init.js] 空 catch 补日志:', e && e.message);
      }

      try {
        // toolExecutor 接受 (toolName, args, ctx) → 调起对应工具（用于预取已学习的工具链）
        const { registry } = require('../tools');
        aciToolExecutor = async (toolName, args) => {
          try {
            const tool = registry.get ? registry.get(toolName) : null;
            if (!tool || typeof tool.execute !== 'function') return null;
            return await tool.execute(args || {}, { userId: null, isPrefetch: true });
          } catch (e) { return null; }
        };
      } catch (e) {
        /* ignore */
        console.warn('[init.js] 空 catch 补日志:', e && e.message);
      }


      initializeACI({
        // 2026-09-08 便携化: 不再传 dataDir=__dirname(会把 prefetch-cache/pattern-learner
        // 写进程序树 src/core/, 打包后污染 resources、只读介质上失效)——由 aci/index.js
        // 默认解析到 config.DATA_DIR/aci, 随数据目录走
        memoryManager: aciMemoryManager,
        toolExecutor: aciToolExecutor,
      });
      logger.info('  ✅ ACI 预判注入系统已初始化（语义记忆+工具链预判）');
    } catch (e) {
      logger.warn('ACI 初始化跳过:', e.message);
    }

    // ── Phase 1: 活动状态机 + 活动流 ──
    try {
      // eslint-disable-next-line no-unused-vars
      const { globalActivityState } = require('./activity-state');
      const { globalActivityStream } = require('./activity-stream');
      // ActivityState 和 ActivityStream 是单例模块，require 即初始化
      // 将活动流绑定到全局，供 tool-orchestrator 和 handlers 使用
      globalActivityStream.terminalEnabled = true;
      globalActivityStream.sseEnabled = true;
      // 注册 Cleanup
      registerCleanup(() => {
        globalActivityStream.clear();
      });
      logger.info('  ✅ 活动流系统已初始化');
    } catch (e) {
      logger.warn('活动流初始化失败:', e.message);
    }

    // ── Phase 1: 信息面板系统 ──
    try {
      const { initializePanels, memoryGraph, hotspot } = require('./panels');
      await initializePanels();
      if (memoryGraph && memoryGraph.clearCache) {
        memoryGraph.clearCache();
        logger.info('Memory graph cache cleared');
      }
      // 2026-08-16 修复: 启动后 3s 后台预热热点缓存——面板首次打开不再等
      // 20s 全量抓取(重启后缓存空), 预热完成前打开则走实时抓取, 成功后 30min 内秒开。
      if (hotspot && typeof hotspot.getAllHotspots === 'function') {
        setTimeout(() => {
          hotspot.getAllHotspots().then(() => {
            logger.info('热点缓存预热完成');
          }).catch(e => logger.warn('热点缓存预热失败:', e.message));
        }, 3000);
      }
    } catch (e) {
      logger.warn('信息面板初始化失败:', e.message);
    }

    logger.info('✅ 核心系统初始化完成');
  } catch (error) {
    if (logger) logger.error('核心系统初始化失败:', error.message);
    else console.error('核心系统初始化失败:', error.message);
    throw error;
  }
}

// 后台任务快照恢复 + 周期快照（I-3：终态还原/中断标记，不重跑副作用任务）
try {
  const { getBackgroundTaskManager } = require('./background-task-manager');
  const btm = getBackgroundTaskManager();
  btm.restoreTasks();
  if (typeof btm.startSnapshotting === 'function') btm.startSnapshotting();
  global.__backgroundTaskManager = btm;
} catch (e) {
  console.warn('[init] 后台任务快照初始化失败:', e.message || e);
}

module.exports = {
  init,
  registerCleanup,
  runCleanup,
  setupGracefulShutdown,
  initializeCoreSystems,
};
