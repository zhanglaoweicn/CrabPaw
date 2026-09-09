/**
 * CrabPaw Tool System - 统一入口
 * 
 * 中心化注册表 + 模块自注册
 */

const { ToolRegistry, registry } = require('./registry');
// eslint-disable-next-line no-unused-vars -- RISK_LEVELS 导入未使用
const { logToolExecution, logSecurityBlock, RISK_LEVELS } = require('../core/audit-log');

require('./file-tools');
require('./web-tools');
require('./bash-tools');
require('./lark-tools');
require('./skill-tools');
require('./skill-manage-tool');
require('./skill-generate-tool');
require('./image-tools');
require('./poster-tools');
require('./video-tools');
require('./weather-tools');
require('./stock-tools');
require('./stock-holdings-tools');
require('./stock-watchlist');
require('./typhoon-tools');
require('./train-tools');
require('./clarify-tool');
require('./plan-exit-tool');
require('./todo-tool');
require('./taskflow-tool');
require('./desktop-tools');
require('./browser-tools');
require('./reminder-tool');
require('./voice-tool');
require('./proactive-speak-tool');
require('./wecom-tools');
require('./enterprise-tools');
require('./panel-tools');
require('./business-tools');
require('./business-card-tools');
require('./commodity-tools');
require('./panels-v2-tool');
require('./ui-control-tools');
require('./email-tools');
require('./document-tools');
require('./document-analyze-tools');
require('./knowledge-tools');
require('./decision-tools');
require('./trending-tools');
require('./music-tools');
require('./media-stage-tools');
require('./remotion-tools');
require('./hyperframes-tools');
require('./platform-api-tools');
require('./calendar-tool');
require('./tool-evolution-tools');
require('./subagent-tools');
require('./agent-delegation-tools');
require('./persistent-shell-tool');
require('./install-software-tool');
require('./awakening-tool');
require('./system-environment-tool');
require('./self-awareness-tool');
require('./http-tools');
require('./clipboard-tools');
require('./database-tools');
require('./data-import-tools');
require('./archive-tools');
require('./session-search-tools');
require('./memory-tools');
require('./memory-audit-tool');
require('./plan-tools');
require('./directory-faq-tool');
require('./agent-tools');
require('./find-tool');
require('../core/scene/scene-tools');
require('./bilibili-tools');
require('./turn-trace-tool');
require('./capability-secret-tool');
require('./concept-time-tool');
require('./multimodal-tools');

// 2026-08-01: 接线权限策略系统（此前 PermissionSystem 从未接入 registry）
const { permissionSystem } = require('./permissions');
registry.setPolicyManager(permissionSystem);

registry.addPreExecuteHook((toolName, params, context) => {
  if (toolName === 'DesktopControl' && params?.action === 'execute_command') {
    logSecurityBlock(context?.userId || 'system', toolName, 'execute_command需要审批', { action: params.action });
    return { blocked: true, reason: 'execute_command操作需要显式审批，请使用Bash工具或获得授权' };
  }
  if (toolName === 'DesktopControl' && params?.action === 'open_application') {
    const app = (params.app || '').toLowerCase().trim();
    const dangerousApps = ['regedit', 'cmd', 'powershell', 'wt', 'taskmgr', 'mmc', 'certmgr', 'eventvwr', 'compmgmt', 'lusrmgr', 'secpol', 'gpedit', 'diskmgmt', 'wf'];
    if (dangerousApps.includes(app)) {
      logSecurityBlock(context?.userId || 'system', toolName, `危险应用被阻止: ${app}`, { action: params.action, app });
      return { blocked: true, reason: `不允许打开危险应用: ${app}，请使用Bash工具或获得授权` };
    }
  }
  if (toolName === 'BrowserControl' && params?.action === 'evaluate') {
    const expr = params.expression || '';
    const blockedPatterns = [/require\s*\(/, /child_process/, /process\./, /fs\./, /import\s+/, /\beval\s*\(/, /new\s+Function\s*\(/, /setTimeout\s*\(\s*["']/, /setInterval\s*\(\s*["']/, /WebAssembly/, /__proto__/, /constructor\s*\[/, /\.then\s*\(\s*["']/];
    for (const pattern of blockedPatterns) {
      if (pattern.test(expr)) {
        logSecurityBlock(context?.userId || 'system', toolName, `evaluate包含禁止模式: ${pattern.source}`, { action: params.action });
        return { blocked: true, reason: `JS表达式包含禁止的模式: ${pattern.source}，不允许执行` };
      }
    }
  }
  return { blocked: false };
});

// ===== PostExecute Hooks =====

// 1. 审计日志 hook — 记录工具执行结果
registry.addPostExecuteHook((toolName, params, result, context) => {
  logToolExecution(context?.userId || 'system', toolName, {
    success: result.success,
    elapsed: result.data?._elapsed,
    error: result.error,
  });
});

// 2. 技能遥测 hook — 追踪技能工具使用情况
registry.addPostExecuteHook((toolName, params, result, _context) => {
  try {
    const { getQualityTracker } = require('../core/skill/skill-quality-tracker');
    const tracker = getQualityTracker();
    if (tracker && tracker._initialized) {
      tracker.record(toolName, result.success, {
        executionTimeMs: result.data?._elapsed || 0,
        error: result.error,
      });
    }
  } catch { console.warn('[tools/index] skill telemetry failed (silent degrade)'); }
});

// 3. 工具使用遥测 hook — 持续学习，为技能进化提供数据
// eslint-disable-next-line no-unused-vars -- result/context 回调参数未使用
registry.addPostExecuteHook((toolName, _params, result, context) => {
  try {
    const telemetry = require('../core/skill/skill-usage-telemetry');
    if (telemetry && telemetry.bumpUse) {
      telemetry.bumpUse(toolName);
    }
  } catch { console.warn('[tools/index] skill telemetry failed (silent degrade)'); }
});

// 4. Instinct 学习 hook — 从工具执行结果中自动学习行为规则
registry.addPostExecuteHook((toolName, params, result, context) => {
  try {
    const { getInstinctSystem } = require('../core/instinct-system');
    const instinct = getInstinctSystem();
    instinct.learnFromToolExecution(toolName, result.success, {
      consecutiveFailures: context?.consecutiveFailures || 0,
      consecutiveSuccesses: context?.consecutiveSuccesses || 0,
      paramHint: context?.paramHint,
    });
  } catch { console.warn('[tools/index] Instinct learning from tool execution failed (silent degrade)'); }
});

function getToolSchemas(format = 'openai') {
  if (format === 'claude') {
    return registry.toClaudeFormat();
  }
  return registry.toOpenAIFormat();
}

function getTool(name) {
  return registry.get(name);
}

function getAllTools() {
  return registry.getAll();
}

function getToolsets() {
  return registry.getToolsets();
}

function getStats() {
  return registry.getStats();
}

async function executeTool(name, params, context = {}) {
  return registry.execute(name, params, context);
}

console.log('🔧 工具系统已初始化:', getStats());

module.exports = {
  ToolRegistry,
  registry,
  getToolSchemas,
  getTool,
  getAllTools,
  getToolsets,
  getStats,
  executeTool
};
