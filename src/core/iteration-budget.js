/**
 * IterationBudget — 迭代预算管理
 *
 *   - 达到 70% 使用率（警告级别）：在工具结果中追加预算警告
 *   - 达到 90% 使用率（严重警告）：在工具结果中追加严重警告
 *   - 达到 100%：强制停止，返回已完成工作的摘要
 *
 * 设计要点：
 *   - 预算按会话隔离，不同用户/会话独立计数
 *   - 支持父子 Agent 共享预算（子 Agent 消耗父 Agent 的预算）
 *   - 警告注入在工具结果末尾追加，不影响工具返回格式
 */

class IterationBudget {
  /**
   * @param {object} options
   * @param {number} options.maxIterations - 最大迭代次数，默认 8
   * @param {number} options.maxTotalToolCalls - 最大总工具调用次数，默认 15
   * @param {number} options.warningThreshold - 警告阈值百分比，默认 0.7
   * @param {number} options.criticalThreshold - 严重警告阈值百分比，默认 0.9
   * @param {number} options.timeoutMs - 超时毫秒数，默认 120000
   */
  constructor(options = {}) {
    this.maxIterations = options.maxIterations || 8;
    this.maxTotalToolCalls = options.maxTotalToolCalls || 15;
    this.warningThreshold = options.warningThreshold || 0.7;
    this.criticalThreshold = options.criticalThreshold || 0.9;
    this.timeoutMs = options.timeoutMs || 120000;

    this._iteration = 0;
    this._totalToolCalls = 0;
    this._startTime = Date.now();
    this._forcedStop = false;
    this._parentBudget = null; // 父 Agent 预算引用
  }

  /**
   * 创建子预算（共享父预算的计数器）
   */
  createChildBudget() {
    const child = new IterationBudget({
      maxIterations: this.maxIterations,
      maxTotalToolCalls: this.maxTotalToolCalls,
      warningThreshold: this.warningThreshold,
      criticalThreshold: this.criticalThreshold,
      timeoutMs: this.timeoutMs,
    });
    child._parentBudget = this;
    return child;
  }

  /**
   * 递增迭代计数
   */
  incrementIteration() {
    this._iteration++;
    if (this._parentBudget) {
      this._parentBudget._iteration = Math.max(this._parentBudget._iteration, this._iteration);
    }
  }

  /**
   * 递增工具调用计数
   */
  incrementToolCalls(count = 1) {
    this._totalToolCalls += count;
    if (this._parentBudget) {
      this._parentBudget._totalToolCalls += count;
    }
  }

  /**
   * 获取当前迭代数
   */
  getIteration() {
    return this._iteration;
  }

  /**
   * 获取当前总工具调用数
   */
  getTotalToolCalls() {
    return this._totalToolCalls;
  }

  /**
   * 是否超时
   */
  isTimedOut() {
    return Date.now() - this._startTime > this.timeoutMs;
  }

  /**
   * 是否达到迭代上限
   */
  isIterationExceeded() {
    return this._iteration >= this.maxIterations;
  }

  /**
   * 是否达到总工具调用上限
   */
  isToolCallLimitExceeded() {
    return this._totalToolCalls >= this.maxTotalToolCalls;
  }

  /**
   * 是否应该强制停止
   */
  shouldForceStop() {
    return this._forcedStop || this.isIterationExceeded() || this.isToolCallLimitExceeded() || this.isTimedOut();
  }

  /**
   * 尝试弹性扩展预算（用于收尾阶段）
   * 当预算首次耗尽时，给予额外空间让模型完成收尾（解释现状、给出建议）
   * 只能扩展一次，扩展后不再允许工具调用，仅允许生成最终回复
   * @returns {boolean} 是否成功扩展（true=首次扩展，false=已扩展过或未耗尽）
   */
  tryElasticExtension() {
    if (this._extended) return false;
    if (!this.shouldForceStop()) return false;
    this._extended = true;
    this._extensionReason = this.isTimedOut() ? 'timeout'
      : this.isIterationExceeded() ? 'iteration_limit'
      : this.isToolCallLimitExceeded() ? 'tool_call_limit'
      : 'forced';
    // 给予额外空间用于收尾（不再允许工具调用，仅用于生成最终解释性回复）
    this.maxIterations += 4;
    this.maxTotalToolCalls += 8;
    this._forcedStop = false;
    console.log(`🔄 [弹性扩展] 预算已弹性扩展: 迭代 ${this.maxIterations}, 工具调用 ${this.maxTotalToolCalls}（原因: ${this._extensionReason}）`);
    return true;
  }

  /**
   * 是否已弹性扩展过
   */
  isExtended() {
    return !!this._extended;
  }

  /**
   * 获取扩展原因
   */
  getExtensionReason() {
    return this._extensionReason || null;
  }

  /**
   * 手动强制停止
   */
  forceStop() {
    this._forcedStop = true;
  }

  /**
   * 获取当前使用率（0-1）
   */
  getUsageRatio() {
    const iterRatio = this._iteration / this.maxIterations;
    const toolRatio = this._totalToolCalls / this.maxTotalToolCalls;
    return Math.max(iterRatio, toolRatio);
  }

  /**
   * 获取预算警告消息（注入到工具结果中）
   * @returns {string|null} 警告消息，或 null（无需警告）
   */
  getBudgetWarning() {
    const ratio = this.getUsageRatio();

    if (ratio >= this.criticalThreshold && ratio < 1.0) {
      return `[BUDGET WARNING: 迭代 ${this._iteration}/${this.maxIterations}，工具调用 ${this._totalToolCalls}/${this.maxTotalToolCalls}。仅剩少量迭代。请立即整合结果，给出最终响应。]`;
    }

    if (ratio >= this.warningThreshold) {
      return `[BUDGET: 迭代 ${this._iteration}/${this.maxIterations}，工具调用 ${this._totalToolCalls}/${this.maxTotalToolCalls}。剩余迭代有限，请开始整合工作。]`;
    }

    return null;
  }

  /**
   * 将预算警告注入到工具结果内容中
   * @param {string} content - 原始工具结果内容
   * @returns {string} 注入警告后的内容
   */
  injectBudgetWarning(content) {
    const warning = this.getBudgetWarning();
    if (!warning) return content;

    if (typeof content === 'string') {
      return content + '\n\n' + warning;
    }
    return content;
  }

  /**
   * 获取强制停止时的摘要消息
   */
  getStopSummary() {
    const reasons = [];
    if (this.isTimedOut()) reasons.push('超时');
    if (this.isIterationExceeded()) reasons.push(`迭代达到上限 (${this.maxIterations})`);
    if (this.isToolCallLimitExceeded()) reasons.push(`工具调用达到上限 (${this.maxTotalToolCalls})`);
    if (this._forcedStop) reasons.push('强制停止');

    return `Agent 迭代预算已耗尽（${reasons.join('、')}）。已完成 ${this._iteration} 次迭代、${this._totalToolCalls} 次工具调用。`;
  }

  /**
   * 重置预算
   */
  reset() {
    this._iteration = 0;
    this._totalToolCalls = 0;
    this._startTime = Date.now();
    this._forcedStop = false;
  }

  /**
   * 获取状态快照
   */
  getStats() {
    return {
      iteration: this._iteration,
      maxIterations: this.maxIterations,
      totalToolCalls: this._totalToolCalls,
      maxTotalToolCalls: this.maxTotalToolCalls,
      usageRatio: this.getUsageRatio(),
      timedOut: this.isTimedOut(),
      elapsed: Date.now() - this._startTime,
    };
  }
}

module.exports = { IterationBudget };
