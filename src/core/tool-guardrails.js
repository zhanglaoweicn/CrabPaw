const crypto = require('crypto');

const IDEMPOTENT_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch',
  'SkillView', 'ListSkills', 'GetWeather', 'GetForecast',
  'TodoRead',
]);

const MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'Bash', 'DeleteFile', 'CreateDirectory',
  'SkillGenerate', 'SkillManage', 'TodoWrite', 'DesktopControl',
]);

const DESKTOP_CONTROL_TOOLS = new Set([
  'DesktopControl',
]);

const DESKTOP_CONTROL_CONFIG = {
  exactFailureBlockAfter: 3,
  sameToolFailureHaltAfter: 5,
  noProgressBlockAfter: 3,
};

const DEFAULT_CONFIG = {
  warningsEnabled: true,
  hardStopEnabled: true,
  exactFailureWarnAfter: 2,
  exactFailureBlockAfter: 5,
  sameToolFailureWarnAfter: 3,
  sameToolFailureHaltAfter: 8,
  noProgressWarnAfter: 2,
  noProgressBlockAfter: 5,
};

function canonicalToolArgs(args) {
  if (!args || typeof args !== 'object') return '{}';
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return JSON.stringify(parsed, Object.keys(parsed).sort(), 0);
  } catch {
    return String(args);
  }
}

function computeArgsHash(args) {
  const canonical = canonicalToolArgs(args);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

class ToolCallSignature {
  constructor(toolName, argsHash) {
    this.toolName = toolName;
    this.argsHash = argsHash;
  }

  static fromCall(toolName, args) {
    return new ToolCallSignature(toolName, computeArgsHash(args));
  }

  key() {
    return `${this.toolName}:${this.argsHash}`;
  }

  toMetadata() {
    return { tool_name: this.toolName, args_hash: this.argsHash };
  }
}

// P1-①(2026-09-03, dsh 对标机制④): 守卫决策单调性编码进类型——
// 严重度 allow(0) < warn(1) < block(2) < halt(3), 只升不降; 决策对象冻结。
// 此前四动作共享可变枚举且 allowsExecution 含 warn, 单调性只能靠调用顺序自律,
// 类型上允许"放行值"参与阻断判断。
const DECISION_SEVERITY = Object.freeze({ allow: 0, warn: 1, block: 2, halt: 3 });

class ToolGuardrailDecision {
  constructor({ action = 'allow', code = 'allow', message = '', toolName = '', count = 0, signature = null } = {}) {
    if (!(action in DECISION_SEVERITY)) {
      throw new Error(`[tool-guardrails] 非法守卫动作: ${action}(允许: allow/warn/block/halt)`);
    }
    this.action = action;
    this.code = code;
    this.message = message;
    this.toolName = toolName;
    this.count = count;
    this.signature = signature;
    Object.freeze(this);
  }

  get severity() {
    return DECISION_SEVERITY[this.action];
  }

  get allowsExecution() {
    return this.severity <= DECISION_SEVERITY.warn;
  }

  get shouldHalt() {
    return this.severity >= DECISION_SEVERITY.block;
  }

  /** 单调升级: 目标动作不比当前严时拒绝降级返回原决策; 升级时返回携带 patch 的新决策 */
  escalateTo(action, patch = {}) {
    if (!(action in DECISION_SEVERITY) || DECISION_SEVERITY[action] <= this.severity) return this;
    return new ToolGuardrailDecision({
      code: this.code,
      message: this.message,
      toolName: this.toolName,
      count: this.count,
      signature: this.signature,
      ...patch,
      action,
    });
  }

  /** 单调合并: 取最严者(全空返回 null)——多守卫/重放场景的防降级合并 */
  static combine(...decisions) {
    const list = decisions.filter(Boolean);
    if (list.length === 0) return null;
    return list.reduce((a, b) => (b.severity > a.severity ? b : a));
  }

  toMetadata() {
    const data = {
      action: this.action,
      code: this.code,
      message: this.message,
      tool_name: this.toolName,
      count: this.count,
    };
    if (this.signature) data.signature = this.signature.toMetadata();
    return data;
  }
}

function buildSyntheticResult(decision) {
  return JSON.stringify({
    error: decision.message,
    guardrail: decision.toMetadata(),
  }, null, 2);
}

function appendGuardrailGuidance(result, decision) {
  if (!['warn', 'halt', 'block'].includes(decision.action) || !decision.message) {
    return result;
  }
  const label = decision.action === 'halt' || decision.action === 'block'
    ? '工具循环硬停止'
    : '工具循环警告';
  const suffix = `\n\n[${label}: ${decision.code}; 次数=${decision.count}; ${decision.message}]`;
  return (result || '') + suffix;
}

// P1-③(2026-09-03, dsh 对标机制②"可见即记录"): 守卫阻断的合成结果模型必然可见,
// 构造即落审计(TOOL_DENIED + 决策元数据; runId 由审计层从 AsyncLocalStorage 自动关联)。
// 此前 TOOL_EXECUTE/TOOL_DENIED 全仓零写入点——模型看得见的阻断在审计里不存在。
// auditFn 可注入(单测/eval 防落盘); 默认懒加载 audit-log-v2 真实写入。
function buildAuditedSyntheticResult(decision, { phase = 'unknown', auditFn } = {}) {
  const synthetic = buildSyntheticResult(decision);
  try {
    const write = auditFn || (() => {
      const audit = require('./audit-log-v2');
      return (entry) => audit.writeAuditEntry({ ...entry, event: audit.AUDIT_EVENTS.TOOL_DENIED });
    })();
    write({
      action: 'guardrail_block',
      result: 'blocked',
      reason: decision.message || decision.code,
      resource: decision.toolName || null,
      resourceType: 'tool',
      metadata: { guardrail: decision.toMetadata(), phase, syntheticVisible: true },
    });
  } catch (e) {
    console.warn('[tool-guardrails] 守卫阻断审计写入失败(best-effort, 不影响阻断):', e.message);
  }
  return synthetic;
}

class ToolCallGuardrail {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._exactFailureCounts = {};
    this._sameToolFailureCounts = {};
    this._noProgress = {};
    this._haltDecision = null;
    this._history = [];
    this._warnings = [];
    this._blocked = false;
    this._blockedReason = null;
  }

  beforeCall(toolName, args) {
    const signature = ToolCallSignature.fromCall(toolName, args);
    if (!this.config.hardStopEnabled) {
      return new ToolGuardrailDecision({ toolName, signature });
    }

    const isDesktopCtrl = DESKTOP_CONTROL_TOOLS.has(toolName);
    const effectiveBlockAfter = isDesktopCtrl
      ? DESKTOP_CONTROL_CONFIG.exactFailureBlockAfter
      : this.config.exactFailureBlockAfter;
    const exactCount = this._exactFailureCounts[signature.key()] || 0;
    if (exactCount >= effectiveBlockAfter) {
      const decision = new ToolGuardrailDecision({
        action: 'block',
        code: 'repeated_exact_failure_block',
        message: `已阻止 ${toolName}: 相同参数已失败 ${exactCount} 次。请更换策略或参数。`,
        toolName,
        count: exactCount,
        signature,
      });
      this._haltDecision = ToolGuardrailDecision.combine(this._haltDecision, decision);
      this._blocked = true;
      this._blockedReason = decision.message;
      return decision;
    }

    if (IDEMPOTENT_TOOLS.has(toolName)) {
      const record = this._noProgress[signature.key()];
      if (record) {
        // eslint-disable-next-line no-unused-vars -- resultHash 未使用，仅取 repeatCount
        const { resultHash, repeatCount } = record;
        if (repeatCount >= this.config.noProgressBlockAfter) {
          const decision = new ToolGuardrailDecision({
            action: 'block',
            code: 'idempotent_no_progress_block',
            message: `已阻止 ${toolName}: 此只读调用已返回相同结果 ${repeatCount} 次。请使用已有结果或更换查询。`,
            toolName,
            count: repeatCount,
            signature,
          });
          this._haltDecision = ToolGuardrailDecision.combine(this._haltDecision, decision);
          this._blocked = true;
          this._blockedReason = decision.message;
          return decision;
        }
      }
    }

    return new ToolGuardrailDecision({ toolName, signature });
  }

  afterCall(toolName, args, result, failed = null) {
    const signature = ToolCallSignature.fromCall(toolName, args);

    if (failed === null) {
      failed = result && (result.success === false || result.error);
    }

    this._history.push({
      toolName,
      args: typeof args === 'string' ? args : JSON.stringify(args),
      isSuccess: !failed,
      isError: !!failed,
      timestamp: Date.now(),
      signature: signature.key(),
    });

    if (failed) {
      const exactCount = (this._exactFailureCounts[signature.key()] || 0) + 1;
      this._exactFailureCounts[signature.key()] = exactCount;
      delete this._noProgress[signature.key()];

      const sameCount = (this._sameToolFailureCounts[toolName] || 0) + 1;
      this._sameToolFailureCounts[toolName] = sameCount;

      const isDesktopCtrl = DESKTOP_CONTROL_TOOLS.has(toolName);
      const effectiveHaltAfter = isDesktopCtrl
        ? DESKTOP_CONTROL_CONFIG.sameToolFailureHaltAfter
        : this.config.sameToolFailureHaltAfter;

      if (this.config.hardStopEnabled && sameCount >= effectiveHaltAfter) {
        const decision = new ToolGuardrailDecision({
          action: 'halt',
          code: 'same_tool_failure_halt',
          message: `已停止 ${toolName}: 本轮已失败 ${sameCount} 次。请更换方法。`,
          toolName,
          count: sameCount,
          signature,
        });
        this._haltDecision = ToolGuardrailDecision.combine(this._haltDecision, decision);
        this._blocked = true;
        this._blockedReason = decision.message;
        return decision;
      }

      if (this.config.warningsEnabled && exactCount >= this.config.exactFailureWarnAfter) {
        const decision = new ToolGuardrailDecision({
          action: 'warn',
          code: 'repeated_exact_failure_warning',
          message: `${toolName} 使用相同参数已失败 ${exactCount} 次，可能陷入循环。`,
          toolName,
          count: exactCount,
          signature,
        });
        this._warnings.push(decision);
        return decision;
      }

      if (this.config.warningsEnabled && sameCount >= this.config.sameToolFailureWarnAfter) {
        const decision = new ToolGuardrailDecision({
          action: 'warn',
          code: 'same_tool_failure_warning',
          message: `${toolName} 本轮已失败 ${sameCount} 次，请更换方法。`,
          toolName,
          count: sameCount,
          signature,
        });
        this._warnings.push(decision);
        return decision;
      }

      return new ToolGuardrailDecision({ toolName, count: exactCount, signature });
    }

    delete this._exactFailureCounts[signature.key()];
    delete this._sameToolFailureCounts[toolName];

    if (!IDEMPOTENT_TOOLS.has(toolName)) {
      delete this._noProgress[signature.key()];
      return new ToolGuardrailDecision({ toolName, signature });
    }

    const resultHash = computeArgsHash(typeof result === 'string' ? result : JSON.stringify(result));
    const previous = this._noProgress[signature.key()];
    let repeatCount = 1;
    if (previous && previous.resultHash === resultHash) {
      repeatCount = previous.repeatCount + 1;
    }
    this._noProgress[signature.key()] = { resultHash, repeatCount };

    if (this.config.warningsEnabled && repeatCount >= this.config.noProgressWarnAfter) {
      const decision = new ToolGuardrailDecision({
        action: 'warn',
        code: 'idempotent_no_progress_warning',
        message: `${toolName} 已返回相同结果 ${repeatCount} 次。请使用已有结果或更换查询。`,
        toolName,
        count: repeatCount,
        signature,
      });
      this._warnings.push(decision);
      return decision;
    }

    return new ToolGuardrailDecision({ toolName, count: repeatCount, signature });
  }

  check(toolCall, result) {
    const toolName = toolCall.function?.name || toolCall.name || 'unknown';
    const args = toolCall.function?.arguments || '';
    const failed = result && (result.success === false || result.error);
    return this.afterCall(toolName, args, result, !!failed);
  }

  isBlocked() {
    return this._blocked;
  }

  getBlockedReason() {
    return this._blockedReason;
  }

  getHaltDecision() {
    return this._haltDecision;
  }

  getWarnings() {
    return [...this._warnings];
  }

  reset() {
    this._exactFailureCounts = {};
    this._sameToolFailureCounts = {};
    this._noProgress = {};
    this._haltDecision = null;
    this._history = [];
    this._warnings = [];
    this._blocked = false;
    this._blockedReason = null;
  }

  resetForTurn() {
    this._exactFailureCounts = {};
    this._sameToolFailureCounts = {};
    this._noProgress = {};
    this._haltDecision = null;
    this._blocked = false;
    this._blockedReason = null;
  }

  getStats() {
    const byTool = {};
    for (const h of this._history) {
      if (!byTool[h.toolName]) {
        byTool[h.toolName] = { total: 0, errors: 0, successes: 0 };
      }
      byTool[h.toolName].total++;
      if (h.isError) byTool[h.toolName].errors++;
      if (h.isSuccess) byTool[h.toolName].successes++;
    }

    return {
      totalCalls: this._history.length,
      warnings: this._warnings.length,
      blocked: this._blocked,
      blockedReason: this._blockedReason,
      byTool
    };
  }

  getRecentHistory(count = 20) {
    return this._history.slice(-count);
  }

  getToolFailureRate(toolName) {
    const toolHistory = this._history.filter(h => h.toolName === toolName);
    if (toolHistory.length === 0) return 0;
    const failures = toolHistory.filter(h => h.isError).length;
    return failures / toolHistory.length;
  }

  isMutatingTool(toolName) {
    return MUTATING_TOOLS.has(toolName);
  }

  isIdempotentTool(toolName) {
    return IDEMPOTENT_TOOLS.has(toolName);
  }

  getMutatingCallCount() {
    return this._history.filter(h => MUTATING_TOOLS.has(h.toolName)).length;
  }

  estimateTokenUsage() {
    let totalChars = 0;
    for (const h of this._history) {
      totalChars += (h.args || '').length;
    }
    return Math.ceil(totalChars / 3.5);
  }
}

module.exports = {
  ToolCallGuardrail,
  ToolCallSignature,
  ToolGuardrailDecision,
  buildSyntheticResult,
  buildAuditedSyntheticResult,
  appendGuardrailGuidance,
  canonicalToolArgs,
  computeArgsHash,
  IDEMPOTENT_TOOLS,
  MUTATING_TOOLS,
  DEFAULT_CONFIG,
};
