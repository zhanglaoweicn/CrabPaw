/**
 * CrabPaw Core - 核心模块统一入口（懒加载版）
 *
 * 2026-08-18 精简：删除 39 个全仓零消费 getter（retry/title/middleware/mcp/run/stream/
 * tools/slashAccess/sessionRecap/streamDiag/goalManager/skillV2/personalization/memoryV2/
 * kanbanV2/codeExecution/batch/search/schedulerV2/memoryV3/learning/agentV2/skillV3/
 * contextV2/channelsV2/observability/securityV2/memoryTree/commitment/agentTiers/experience/
 * contextEngine/curatorV2/nativeRequest/commitmentTracker/agentHarness/execApproval/
 * channelDirectory/subagent —— 均经 grep 验证零消费方）。caching 由启动期 eager
 * require 改为懒加载。保留：pricing/credentials/auth/hooks/skin/memory/flowSystem/
 * toolPolicyManager/channelRegistry/routeResolver/configManager/SetupWizard/insights
 * （flowSystem/toolPolicyManager/channelRegistry/routeResolver 由 init.js 消费，
 * 其余由 cli 命令消费）。
 *
 * 使用方式不变：const { caching, memory } = require('./index')
 * 但模块只在首次访问时才加载。
 */

// ── 懒加载注册表 ──
const _lazyModules = {};

function lazyRequire(name, loader) {
  Object.defineProperty(_lazyModules, name, {
    configurable: true,
    enumerable: true,
    get() {
      const mod = loader();
      Object.defineProperty(_lazyModules, name, { value: mod, enumerable: true });
      return mod;
    },
  });
}

// ── 注册所有模块的懒加载器 ──
lazyRequire('caching', () => require('./caching/prompt-cache'));
lazyRequire('pricing', () => require('./pricing/database'));
lazyRequire('credentials', () => require('./credentials/pool'));
lazyRequire('auth', () => require('./auth/pairing'));
lazyRequire('hooks', () => require('./hooks/manager'));
lazyRequire('skin', () => require('./skin/engine'));
lazyRequire('memory', () => require('./memory'));
lazyRequire('flowSystem', () => require('./flows'));
lazyRequire('toolPolicyManager', () => require('./tool-profiles'));
// 2026-08-18: channel-registry 导出的是 { ChannelRegistry, ..., channelRegistry(实例) }，
// 旧写法返回模块对象 → channel.js 的 channelRegistry.list() 恒 TypeError。改导出实例。
lazyRequire('channelRegistry', () => require('./channel-registry').channelRegistry);
lazyRequire('routeResolver', () => require('./routing'));
lazyRequire('configManager', () => require('./config'));
lazyRequire('SetupWizard', () => require('./wizard').SetupWizard);
// 2026-08-18 残留修复：history/scheduler/subagent 四命令此前解构出 undefined
// （getter 从未存在 → cli 命令调用即 TypeError 纸面命令）。现接真实后端：
// history → SessionPersistence（会话历史存储）；scheduler → Scheduler 单例；
// subagent 四函数 → src/core/subagent.js（commands-index/middleware 同款事实标准）。
lazyRequire('history', () => {
  const { getSharedSessionPersistence } = require('./memory/session-persistence');
  const sp = getSharedSessionPersistence();
  return {
    async list(options = {}) {
      const sessions = await sp.getUserSessions('default', { limit: options.limit });
      return sessions.map(s => ({
        id: s.id, title: s.title || s.summary || '无标题',
        createdAt: s.createdAt, messageCount: s.messageCount || s.messages?.length || 0,
      }));
    },
    async search(query) {
      const found = await sp.findSessionByKeyword(String(query), 'default');
      return found.map(s => ({
        id: s.id, title: s.title || s.summary || '无标题',
        match: (s.matchedContent || (s.snippet || '')).slice(0, 120),
      }));
    },
    async clear() { return sp.clearUserSessions('default'); },
    async export(outputPath) {
      const sessions = await sp.getUserSessions('default');
      const fs = require('fs');
      fs.writeFileSync(outputPath, JSON.stringify(sessions, null, 2), 'utf8');
      return sessions.length;
    },
  };
});
lazyRequire('scheduler', () => {
  const { getScheduler } = require('./scheduler');
  const { getGlobalScheduler } = require('./scheduler-bridge');
  const pick = () => getGlobalScheduler() || getScheduler();
  const sched = getScheduler();
  return {
    list() {
      return (pick().tasks || []).map(t => ({
        id: t.id, name: t.name, cron: t.cron, action: t.action,
        enabled: t.enabled !== false,
        nextRun: t._nextRun ? t._nextRun.toLocaleString('zh-CN') : '未知',
      }));
    },
    add: (task) => pick().addTask(task),
    remove: (id) => pick().removeTask(id),
    runNow: (id) => pick().runTask(id),
  };
});
lazyRequire('subagentApi', () => require('./subagent'));

let _InsightsEngine = null;
function getInsightsEngine() {
  if (!_InsightsEngine) {
    try {
      // 2026-08-18: engine.js 是 module.exports = InsightsEngine（直接导出类），
      // 原写法 .InsightsEngine 恒 undefined → cli/core.js 的 new core.insights.InsightsEngine() 必抛 TypeError
      _InsightsEngine = require('./insights/engine');
    } catch (e) {
      console.log('⚠️ InsightsEngine 未加载 (sqlite3 不可用):', e.message);
      _InsightsEngine = class InsightsEngineFallback {
        async initialize() { throw new Error('sqlite3 不可用'); }
        async generateReport() { throw new Error('sqlite3 不可用'); }
      };
    }
  }
  return _InsightsEngine;
}

module.exports = {
  insights: {
    get InsightsEngine() { return getInsightsEngine(); }
  },

  get caching() { return _lazyModules.caching; },
  get pricing() { return _lazyModules.pricing; },
  get credentials() { return _lazyModules.credentials; },
  get auth() { return _lazyModules.auth; },
  get hooks() { return _lazyModules.hooks; },
  get skin() { return _lazyModules.skin; },
  get memory() { return _lazyModules.memory; },
  get flowSystem() { return _lazyModules.flowSystem; },
  get toolPolicyManager() { return _lazyModules.toolPolicyManager; },
  get channelRegistry() { return _lazyModules.channelRegistry; },
  get routeResolver() { return _lazyModules.routeResolver; },
  get configManager() { return _lazyModules.configManager; },
  get SetupWizard() { return _lazyModules.SetupWizard; },
  get history() { return _lazyModules.history; },
  get scheduler() { return _lazyModules.scheduler; },
  get createSubAgent() { return _lazyModules.subagentApi.createSubAgent; },
  get listSubAgents() { return _lazyModules.subagentApi.listSubAgents; },
  get getSubAgentStats() { return _lazyModules.subagentApi.getSubAgentStats; },
  get cleanupCompletedSubAgents() { return _lazyModules.subagentApi.cleanupCompletedSubAgents; },
};
