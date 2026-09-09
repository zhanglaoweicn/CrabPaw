/**
 * EvolutionScore - 进化决策公式化
 *
 * 为进化决策提供统一的量化评分体系，替代主观判断：
 *
 * 核心公式：
 *   Score = W_success * Δsuccess + W_latency * Δlatency + W_error * Δerror
 *          + W_rollback * rollbackPenalty + W_risk * riskPenalty
 *
 * 其中：
 *   Δsuccess = successRate_after - successRate_before  （成功率提升）
 *   Δlatency = (latency_before - latency_after) / latency_before  （延迟降低比例）
 *   Δerror = errorRate_before - errorRate_after  （错误率降低）
 *   rollbackPenalty = -0.3 * rollbackCount  （回滚惩罚）
 *   riskPenalty = -0.2 * riskLevel  （风险惩罚 0-3）
 *
 * 决策规则：
 *   Score >= 0.1  → 采纳（优胜留存）
 *   -0.1 < Score < 0.1  → 继续观察
 *   Score <= -0.1  → 回滚（失败回滚）
 */

const { getMetricsPipeline } = require('../perception/metrics-pipeline');

// 默认权重配置
const DEFAULT_WEIGHTS = {
  successRate: 0.35,     // 成功率提升权重
  latency: 0.20,         // 延迟改善权重
  errorRate: 0.25,       // 错误率降低权重
  rollbackPenalty: 0.12, // 回滚惩罚权重
  riskPenalty: 0.08,     // 风险惩罚权重
};

// 决策阈值
const DECISION_THRESHOLDS = {
  adopt: 0.1,      // 采纳阈值
  rollback: -0.1,  // 回滚阈值
};

const DECISION = {
  ADOPT: 'adopt',           // 采纳
  OBSERVE: 'observe',       // 继续观察
  ROLLBACK: 'rollback',     // 回滚
};

class EvolutionScore {
  constructor(config = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...config.weights };
    this.thresholds = { ...DECISION_THRESHOLDS, ...config.thresholds };
  }

  /**
   * 计算进化评分
   * @param {object} before - 进化前指标快照
   * @param {object} after - 进化后指标快照
   * @param {object} context - 上下文信息
   * @returns {object} { score, breakdown, decision }
   */
  evaluate(before, after, context = {}) {
    const breakdown = {};

    // 成功率变化
    const successBefore = before.successRate ?? 0;
    const successAfter = after.successRate ?? 0;
    breakdown.successDelta = successAfter - successBefore;
    breakdown.successWeighted = breakdown.successDelta * this.weights.successRate;

    // 延迟变化（降低为正）
    const latencyBefore = before.avgLatency ?? 0;
    const latencyAfter = after.avgLatency ?? 0;
    breakdown.latencyDelta = latencyBefore > 0
      ? (latencyBefore - latencyAfter) / latencyBefore
      : 0;
    breakdown.latencyWeighted = breakdown.latencyDelta * this.weights.latency;

    // 错误率变化
    const errorBefore = before.errorRate ?? 0;
    const errorAfter = after.errorRate ?? 0;
    breakdown.errorDelta = errorBefore - errorAfter;
    breakdown.errorWeighted = breakdown.errorDelta * this.weights.errorRate;

    // 回滚惩罚
    const rollbackCount = context.rollbackCount ?? 0;
    breakdown.rollbackPenalty = -0.3 * rollbackCount;
    breakdown.rollbackWeighted = breakdown.rollbackPenalty * this.weights.rollbackPenalty;

    // 风险惩罚
    const riskLevel = context.riskLevel ?? 0; // 0-3
    breakdown.riskPenalty = -0.2 * riskLevel;
    breakdown.riskWeighted = breakdown.riskPenalty * this.weights.riskPenalty;

    // 总分
    const score =
      breakdown.successWeighted +
      breakdown.latencyWeighted +
      breakdown.errorWeighted +
      breakdown.rollbackWeighted +
      breakdown.riskWeighted;

    // 决策
    let decision;
    if (score >= this.thresholds.adopt) {
      decision = DECISION.ADOPT;
    } else if (score <= this.thresholds.rollback) {
      decision = DECISION.ROLLBACK;
    } else {
      decision = DECISION.OBSERVE;
    }

    return {
      score: Math.round(score * 1000) / 1000,
      breakdown,
      decision,
      before,
      after,
      context,
    };
  }

  /**
   * 从 MetricsPipeline 采集指标快照
   * @param {string} targetName - 目标名称（如技能名）
   * @param {object} options - 查询选项
   * @returns {object} 指标快照
   */
  async captureSnapshot(targetName, options = {}) {
    try {
      const pipeline = getMetricsPipeline();
      const since = options.since || Date.now() - 3600000; // 默认最近1小时

      const [success, latency, error] = await Promise.all([
        pipeline.query(`${targetName}.success_rate`, { since, aggregation: 'avg' }),
        pipeline.query(`${targetName}.latency`, { since, aggregation: 'avg' }),
        pipeline.query(`${targetName}.error_rate`, { since, aggregation: 'avg' }),
      ]);

      return {
        successRate: success.value ?? 0,
        avgLatency: latency.value ?? 0,
        errorRate: error.value ?? 0,
        timestamp: Date.now(),
      };
    } catch {
      return {
        successRate: 0,
        avgLatency: 0,
        errorRate: 0,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * 评估进化结果并给出决策
   * @param {string} targetName - 目标名称
   * @param {object} baseline - 进化前基线
   * @param {object} context - 上下文
   */
  async evaluateEvolution(targetName, baseline, context = {}) {
    const after = await this.captureSnapshot(targetName);
    return this.evaluate(baseline, after, context);
  }
}

// 单例
let _instance = null;

function getEvolutionScore(config) {
  if (!_instance) {
    _instance = new EvolutionScore(config);
  }
  return _instance;
}

module.exports = {
  EvolutionScore,
  getEvolutionScore,
  DEFAULT_WEIGHTS,
  DECISION_THRESHOLDS,
  DECISION,
};
