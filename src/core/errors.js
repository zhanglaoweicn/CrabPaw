/**
 * CrabPaw Harness Error Classification System
 *
 * 结构化错误体系，参考 Harness OSS (Gitness) 的 errors/ + usererror/ 模式。
 *
 * 所有 Harness 组件抛出的错误统一使用此类体系：
 * - 明确的 error code、severity、recoverable 标记
 * - 支持级联 cause
 * - 提供 toUserMessage() 方法供前端展示
 */

// ═══════════════════════════════════════════════════════════
// Error Codes
// ═══════════════════════════════════════════════════════════

const ERROR_CODES = {
  // Tool Contract
  TOOL_CONTRACT_VIOLATION: 'TOOL_CONTRACT_VIOLATION',
  TOOL_CONTRACT_NOT_FOUND: 'TOOL_CONTRACT_NOT_FOUND',
  TOOL_VALIDATION_FAILED:  'TOOL_VALIDATION_FAILED',

  // Budget
  BUDGET_EXCEEDED:         'BUDGET_EXCEEDED',
  BUDGET_CATEGORY_EXCEEDED:'BUDGET_CATEGORY_EXCEEDED',
  BUDGET_BLOCKED:          'BUDGET_BLOCKED',

  // Loop Detection
  LOOP_HARD_REJECT:        'LOOP_HARD_REJECT',
  LOOP_SIGNATURE_DETECTED: 'LOOP_SIGNATURE_DETECTED',
  LOOP_NO_PROGRESS:        'LOOP_NO_PROGRESS',

  // Agent Contract
  AGENT_CONTRACT_VIOLATION:'AGENT_CONTRACT_VIOLATION',
  AGENT_TYPE_NOT_FOUND:    'AGENT_TYPE_NOT_FOUND',

  // Hooks
  HOOK_BLOCKED:            'HOOK_BLOCKED',
  HOOK_SAFETY_INTERCEPT:   'HOOK_SAFETY_INTERCEPT',

  // Memory
  MEMORY_STORE_FAILURE:    'MEMORY_STORE_FAILURE',
  MEMORY_RETRIEVAL_FAILURE:'MEMORY_RETRIEVAL_FAILURE',

  // Evolution
  EVOLUTION_VALIDATION_FAILED: 'EVOLUTION_VALIDATION_FAILED',
  EVOLUTION_ROLLBACK_TRIGGERED:'EVOLUTION_ROLLBACK_TRIGGERED',

  // General
  INTERNAL_ERROR:          'INTERNAL_ERROR',
  CONFIGURATION_ERROR:     'CONFIGURATION_ERROR',
  NOT_IMPLEMENTED:         'NOT_IMPLEMENTED',
  EXTERNAL_SERVICE_FAILURE:'EXTERNAL_SERVICE_FAILURE',
};

const SEVERITY = {
  DEBUG:    'debug',
  INFO:     'info',
  WARNING:  'warning',
  ERROR:    'error',
  CRITICAL: 'critical',
};

// ═══════════════════════════════════════════════════════════
// HarnessError base class
// ═══════════════════════════════════════════════════════════

class HarnessError extends Error {
  /**
   * @param {string} code - ERROR_CODES 枚举值
   * @param {string} message - 技术错误描述
   * @param {object} [options]
   * @param {string} [options.severity] - SEVERITY 枚举值
   * @param {boolean} [options.recoverable] - 是否可重试恢复
   * @param {object} [options.context] - 额外上下文数据
   * @param {Error} [options.cause] - 原始错误
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code || ERROR_CODES.INTERNAL_ERROR;
    this.severity = options.severity || SEVERITY.ERROR;
    this.recoverable = options.recoverable !== false;
    this.context = options.context || {};
    this.cause = options.cause || null;
    this.timestamp = Date.now();
  }

  /** 返回用户友好的错误消息（供前端/日志展示） */
  toUserMessage() {
    const userMessages = {
      [ERROR_CODES.TOOL_CONTRACT_VIOLATION]:  '工具参数不符合规范，请检查输入',
      [ERROR_CODES.TOOL_CONTRACT_NOT_FOUND]:   '工具未注册或不存在',
      [ERROR_CODES.TOOL_VALIDATION_FAILED]:    '工具输入验证失败',
      [ERROR_CODES.BUDGET_EXCEEDED]:           '预算已耗尽，请稍后再试',
      [ERROR_CODES.BUDGET_CATEGORY_EXCEEDED]:  '该类别的调用次数已达上限',
      [ERROR_CODES.BUDGET_BLOCKED]:            '系统预算已耗尽，请求被阻止',
      [ERROR_CODES.LOOP_HARD_REJECT]:          '检测到重复的安全拒绝，已终止',
      [ERROR_CODES.LOOP_SIGNATURE_DETECTED]:   '检测到循环调用模式，已中断',
      [ERROR_CODES.LOOP_NO_PROGRESS]:          '多次尝试无进展，已终止',
      [ERROR_CODES.HOOK_BLOCKED]:              '操作被安全规则拦截',
      [ERROR_CODES.HOOK_SAFETY_INTERCEPT]:     '操作触发了安全拦截',
      [ERROR_CODES.MEMORY_STORE_FAILURE]:      '记忆存储失败',
      [ERROR_CODES.MEMORY_RETRIEVAL_FAILURE]:  '记忆检索失败',
      [ERROR_CODES.EXTERNAL_SERVICE_FAILURE]:  '外部服务调用失败',
    };
    return userMessages[this.code] || this.message;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      recoverable: this.recoverable,
      context: this.context,
      timestamp: this.timestamp,
    };
  }
}

// ═══════════════════════════════════════════════════════════
// Subclasses
// ═══════════════════════════════════════════════════════════

class ToolContractError extends HarnessError {
  constructor(message, options = {}) {
    super(ERROR_CODES.TOOL_CONTRACT_VIOLATION, message,
      { severity: SEVERITY.WARNING, recoverable: false, ...options });
    this.name = 'ToolContractError';
  }
}

class BudgetError extends HarnessError {
  constructor(message, options = {}) {
    super(ERROR_CODES.BUDGET_EXCEEDED, message,
      { severity: SEVERITY.WARNING, recoverable: true, ...options });
    this.name = 'BudgetError';
  }
}

class LoopDetectionError extends HarnessError {
  constructor(message, options = {}) {
    super(ERROR_CODES.LOOP_HARD_REJECT, message,
      { severity: SEVERITY.ERROR, recoverable: false, ...options });
    this.name = 'LoopDetectionError';
  }
}

class HookBlockedError extends HarnessError {
  constructor(message, options = {}) {
    super(ERROR_CODES.HOOK_BLOCKED, message,
      { severity: SEVERITY.WARNING, recoverable: false, ...options });
    this.name = 'HookBlockedError';
  }
}

// ═══════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════

function isHarnessError(err) {
  return err instanceof HarnessError || (err && err.name === 'HarnessError');
}

function toHarnessError(err, defaultCode = ERROR_CODES.INTERNAL_ERROR) {
  if (isHarnessError(err)) return err;
  return new HarnessError(defaultCode, err?.message || String(err), {
    severity: SEVERITY.ERROR,
    recoverable: false,
    cause: err,
  });
}

module.exports = {
  HarnessError,
  ToolContractError,
  BudgetError,
  LoopDetectionError,
  HookBlockedError,
  ERROR_CODES,
  SEVERITY,
  isHarnessError,
  toHarnessError,
};
