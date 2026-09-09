/**
 * CrabPaw CLI - 模块化入口
 */

require('events').EventEmitter.defaultMaxListeners = 50;

require('../core/safe-stdio').installSafeStdio();
require('../core/console-bridge').install({ prefix: 'CLI' });
const { init } = require('../core/init');
const config = require('../core/config');
const handlers = require('../handlers');
handlers.initFlowHandler();

const { safeError } = require('./validation');

const serverCmd = require('./commands/server');
const skillCmd = require('./commands/skill');
const configCmd = require('./commands/config');
const scheduleCmd = require('./commands/schedule');
const historyCmd = require('./commands/history');
const subagentCmd = require('./commands/subagent');
const channelCmd = require('./commands/channel');
const flowCmd = require('./commands/flow');
const wizardCmd = require('./commands/wizard');
const mcpCmd = require('./commands/mcp');
const statusCmd = require('./commands/status');
const routingCmd = require('./commands/routing');
const taskflowCmd = require('./taskflow-commands');
const doctorCmd = require('./commands/doctor');
const dumpCmd = require('./commands/dump');
const completionCmd = require('./commands/completion');
const profileCmd = require('./commands/profile');
const pluginCmd = require('./commands/plugin');

const args = process.argv.slice(2);

// 解析全局选项
const globalOptions = {
  yolo: args.includes('--yolo'),
  profile: null,
};
// --full 逃生阀: 强制全量 harness boot（同时从 filteredArgs 剔除, 不泄漏给子命令）
const forceFull = args.includes('--full');
const filteredArgs = args.filter(a => {
  if (a.startsWith('--profile=')) { globalOptions.profile = a.split('=')[1]; return false; }
  if (a === '--yolo') return false;
  if (a === '--full') return false;
  return true;
});

async function main() {
  // 2026-08-27 CLI 快路径: plugin/help/version 跳过全量 harness boot(--full/--yolo 强制全量,
  // 空命令=默认 start 语义必须全量)。fast 不调 init(appConfig)——plugin.js 自行
  // getPluginManager().initialize()(M1 证实独立进程可行); loadConfig 保留(依赖链底层)。
  const command = filteredArgs[0];
  const FAST_COMMANDS = new Set(['plugin', 'help', '--help', '-h', 'version', '--version', '-v']);
  const fast = !forceFull && !globalOptions.yolo && FAST_COMMANDS.has(command);
  const infoCmd = FAST_COMMANDS.has(command) && command !== 'plugin';
  if (fast && command) {
    if (!infoCmd) console.log('⚡ 快路径模式（--full 强制全量）');
    const appConfig = config.loadConfig();
    return runCommand(command, filteredArgs.slice(1), appConfig);
  }

  const appConfig = config.loadConfig();
  await init(appConfig);
  
  // 初始化进化系统
  try {
    const { initEvolutionSystem } = require('../core/evolution-system');
    const evolutionConfig = appConfig.evolution || {};
    
    if (evolutionConfig.enabled !== false) {
      console.log('🧬 Starting evolution system...');
      await initEvolutionSystem();
      // 2026-08-27 P1-3: 技能自进化激活——initialize() 有 _initialized 守卫（先到先得），
      // server.js 再跑 initialize(adapter) 会被静默吞掉；改用无守卫的 setLLMClient
      // 延迟绑定绕开竞态，统一注入预算包装客户端（evolution 分类 dailyLimit 20）。
      try {
        const { getEvolutionSystem } = require('../core/evolution');
        const { createBudgetedEvolutionClient } = require('../core/evolution/budgeted-evolution-client');
        getEvolutionSystem().setLLMClient(createBudgetedEvolutionClient());
        console.log('🧬 Evolution LLM client injected (budgeted)');
      } catch (injectErr) {
        console.warn('⚠️ 进化 LLM 注入失败(不阻塞):', injectErr.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Evolution system init failed:', err.message);
  }
  
  // 初始化插件系统
  try {
    const { getPluginManager } = require('../core/plugin-system');
    const pluginConfig = appConfig.plugins || {};
    
    if (pluginConfig.enabled !== false && pluginConfig.autoLoad !== false) {
      console.log('🔌 Starting plugin system...');
      const pluginManager = await getPluginManager();
      // 2026-08-01: 接线注册表（此前 bindRegistries 从未被调用，
      // 插件的 tools/events/services 贡献全部静默失效，仅 UI 贡献生效）
      try {
        const { registry } = require('../tools/registry');
        const { getEventBus } = require('../core/events');
        const { serviceRegistry } = require('../services/registry');
        const { getDataSourcesRegistry } = require('../core/data-sources/registry');
        pluginManager.bindRegistries({
          toolRegistry: registry,
          eventBus: getEventBus(),
          serviceRegistry,
          // 2026-08-26 数据源托管: 插件 enable/disable 对数据源真实生效
          dataSourcesRegistry: getDataSourcesRegistry(),
        });
        console.log('🔗 Plugin registries bound (tools/events/services/dataSources)');
      } catch (bindErr) {
        console.warn('⚠️ Plugin registries binding failed:', bindErr.message);
      }
      // 2026-08-27 B3-1: D8 权限执行域强制——exec/network 工具执行前按插件 permissions
      // 裁决（unsigned 外部插件默认拒，builtin/bundled 豁免）。
      try {
        const { registry: hookRegistry } = require('../tools/registry');
        const { buildPluginPermissionHook } = require('../core/plugin/permission-enforce');
        hookRegistry.addPreExecuteHook(buildPluginPermissionHook(pluginManager));
        console.log('🔐 插件权限执行钩子已挂载（D8）');
      } catch (permErr) {
        console.warn('⚠️ 插件权限钩子挂载失败:', permErr.message);
      }
      // 2026-08-25 Phase2 装配清单：loadFromConfig 接管（清单=config plugins.{bundled,user}），
      // 禁用项(plugin-states/config enabled:false)真不初始化——启动减重；
      // 无 config 时由 defaultManifestFromDirs 生成全启用清单(行为=旧全量,无突变)。
      const pluginCfg = appConfig.plugins || {};
      const { BUILTIN_PLUGINS_DIR, USER_PLUGINS_DIR, resolveActiveProfile, profileManifest } = require('../core/plugin/plugin-manager');
      // 2026-08-27 D4: profile 三层装配——显式 > env CRABPAW_PROFILE > 'server'(默认全量=现状);
      // profileManifest 只缩编不增编: profiles.<name> 未键控层保持全量/显式, 键控层仅列清单内插件。
      const profile = resolveActiveProfile({ profile: process.env.CRABPAW_PROFILE });
      const defaultManifest = await pluginManager.defaultManifestFromDirs();
      const manifest = profileManifest(pluginCfg, profile, defaultManifest);
      const builtinLoaded = await pluginManager.loadFromConfig(manifest.builtin, 'builtin', BUILTIN_PLUGINS_DIR);
      await pluginManager.loadFromConfig(manifest.bundled, 'bundled');
      await pluginManager.loadFromConfig(manifest.user, 'user', USER_PLUGINS_DIR);
      console.log('📦 插件装配(profile=' + profile + '): builtin ' + builtinLoaded.length + '/' + Object.keys(manifest.builtin).length + ' 清单(禁用跳过)');

      // 将插件中的模型提供商注册到适配器注册中心
      try {
        const { getAdapterRegistry } = require('../core/llm');
        const registry = getAdapterRegistry();
        // 2026-08-17: 先注册 config 内提供商（此前 registerFromConfig 从未被调用，
        // 注册表恒空——stock-interpret 的 LLM 解读链永远兜底；主对话走 ModelRouter
        // 自带 config 路径所以未受影响）。无 apiKey 的提供商自动跳过。
        registry.registerFromConfig(appConfig.models?.providers || {});
        await registry.registerFromPlugins(pluginManager);
        console.log(`🔗 Plugin model providers connected to adapter registry (${registry.listProviders().length}  providers)`);

        // 将适配器注册中心绑定到 model-router，统一路由
        try {
          const { getModelRouter } = require('../core/model-router');
          const router = getModelRouter();
          if (router) {
            router.setAdapterRegistry(registry);
            console.log('🔗 Adapter registry bound to model router');
          }
        } catch (routerErr) {
          console.warn('⚠️ Model router binding failed:', routerErr.message);
        }
      } catch (regErr) {
        console.warn('⚠️ Plugin adapter registration failed:', regErr.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Plugin system init failed:', err.message);
  }
  
  // 初始化进化感知记忆
  try {
    const { getEvolutionAwareMemory } = require('../core/enhanced-memory');
    console.log('🧠 Starting evolution-aware memory...');
    await getEvolutionAwareMemory();
  } catch (err) {
    console.warn('⚠️ Evolution-aware memory init failed:', err.message);
  }
  
  // 2026-08-18 P0 修复: 删除工具编排引擎空初始化——getToolOrchestrator(null) 以
  // null registry 初始化单例, executeTool 必抛"工具注册表未初始化"(L607)。唯一
  // 消费方为 commands-index.js 的 /tools 命令(惰性 getToolOrchestrator() 自建,
  // 仅调 listTools 不触 execute), 此处的预初始化无收益且埋雷。模块文件保留,
  // 未来接入真实 registry 时在此(或 orchestrator 侧)重新接线。

  // 初始化技能推荐系统
  try {
    const { getSkillRecommender } = require('../core/skill-recommender');
    console.log('🎯 Starting skill recommendation system...');
    await getSkillRecommender();
  } catch (err) {
    console.warn('⚠️ Skill recommendation system init failed:', err.message);
  }
  
  // 初始化进化系统 API
  try {
    const { getEvolutionHandler } = require('../handlers/evolution-handler');
    console.log('📡 Starting evolution system API...');
    await getEvolutionHandler();
  } catch (err) {
    console.warn('⚠️ Evolution system API init failed:', err.message);
  }
  
  // 应用全局选项
  if (globalOptions.yolo) {
    try {
      require('../core/commands-index');
      // YOLO 模式: 切换审批系统为 off
      console.log('🔓 YOLO mode enabled via --yolo flag');
    } catch {
      console.warn('[index.js] failed to load commands-index in yolo mode');
    }
  }

  await runCommand(command, filteredArgs.slice(1), appConfig);
}

/**
 * 命令分发——原 main() 内 switch 整体抽出(快路径与全量共用, 行为等价迁移)。
 * 各 case 用 restArgs(=filteredArgs.slice(1)); _appConfig 备用(当前分发面
 * 沿用模块级 config 引用, 与重构前一致)。
 */
async function runCommand(command, restArgs, _appConfig) {
  switch (command) {
    case 'skill':
      await skillCmd.handleSkillCommand(restArgs);
      break;
    case 'start':
      await serverCmd.handleStartCommand(restArgs, { config });
      break;
    case 'stop':
      await serverCmd.handleStopCommand(restArgs, { config });
      break;
    case 'config':
      await configCmd.handleConfigCommand(restArgs);
      break;
    case 'schedule':
      await scheduleCmd.handleScheduleCommand(restArgs);
      break;
    case 'history':
      await historyCmd.handleHistoryCommand(restArgs);
      break;
    case 'subagent':
      await subagentCmd.handleSubAgentCommand(restArgs);
      break;
    case 'channel':
      await channelCmd.handleChannelCommand(restArgs);
      break;
    case 'flow':
      await flowCmd.handleFlowCommand(restArgs);
      break;
    case 'wizard':
      await wizardCmd.handleWizardCommand(restArgs);
      break;
    case 'mcp':
      await mcpCmd.handleMCPCommand(restArgs);
      break;
    case 'status':
      await statusCmd.handleStatusCommand(restArgs);
      break;
    case 'routing':
      await routingCmd.handleRoutingCommand(restArgs);
      break;
    case 'taskflow':
      // 原传 filteredArgs(含命令名); restArgs=filteredArgs.slice(1), 故等价
      await taskflowCmd.handleTaskFlowCommand([command, ...restArgs]);
      break;
    case 'doctor':
      await doctorCmd.handleDoctorCommand(restArgs);
      break;
    case 'dump':
      await dumpCmd.handleDumpCommand(restArgs);
      break;
    case 'completion':
      await completionCmd.handleCompletionCommand(restArgs);
      break;
    case 'profile':
      await profileCmd.handleProfileCommand(restArgs);
      break;
    case 'plugin':
      await pluginCmd.handlePluginCommand(restArgs);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      // 2026-08-27 快路径轮: 原实现 help/version 打印后进程不退出(loadConfig 的
      // config watcher 等句柄保持事件循环——冒烟实测原 HEAD --help 40s 超时挂起),
      // 显式退出(与 plugin.js 同模式; 全量路径同样受益)。
      return process.exit(0);
    case 'version':
    case '--version':
    case '-v':
      console.log('CrabPaw v1.0.0');
      return process.exit(0);
    default:
      if (!command) {
        await serverCmd.handleStartCommand([], { config });
      } else {
        console.log(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
      }
  }
}

function printHelp() {
  console.log(`
CrabPaw - AI Agent Platform

用法:
  crabpaw [global-options] <command> [subcommand/options]

全局选项:
  --yolo             跳过危险命令的审批提示
  --full             强制全量启动 (快路径逃生阀)
  --profile=<name>   选择配置文件

命令:
  start              启动服务器 (默认)
  stop               停止服务器
  config             配置管理
  schedule           定时任务管理
  history            历史记录管理
  subagent           SubAgent 管理
  channel            通道管理
  flow               工作流管理
  taskflow           TaskFlow 管理
  skill             技能管理 (import/list/info/search)
  wizard             设置向导
  mcp                MCP 服务器
  status             查看服务状态
  routing            路由管理
  doctor             诊断配置和依赖项问题
  dump               输出可分享的配置摘要
  completion         输出 Shell 补全脚本 (bash/zsh/powershell)
  profile            多配置文件管理
  plugin [verify [dir|name] | list]     插件校验与清单

选项:
  -h, --help         显示帮助
  -v, --version      显示版本

示例:
  crabpaw start                    启动服务器
  crabpaw start --yolo             跳过审批启动
  crabpaw config list              列出所有配置
  crabpaw schedule list            列出定时任务
  crabpaw doctor --fix             诊断并自动修复
  crabpaw dump --show-keys         导出配置摘要
  crabpaw completion bash          生成 bash 补全脚本
  crabpaw status                   查看服务状态
`);
}

main().catch(err => {
  safeError('启动失败:', err.message);
  console.error('Full error stack:', err.stack);
  process.exit(1);
});
