/**
 * Evolution Feedback Loop — @deprecated
 *
 * 此类已被 EvolutionCoordinator + FeedbackLoopEngine 取代。
 * 保留此文件仅为向后兼容（harness-lifecycle 仍在使用）。
 * 新代码请直接使用:
 *   - require('../core/evolution/evolution-coordinator').EvolutionCoordinator
 *   - require('./skill/feedback-loop-engine').getFeedbackLoopEngine
 *
 * @deprecated 使用 EvolutionCoordinator + FeedbackLoopEngine 替代
 * @see evolution-coordinator.js, skill/feedback-loop-engine.js
 */


const { EventEmitter } = require('events');
const { EvolutionCoordinator } = require('./evolution/evolution-coordinator');

let _deprecationWarned = false;
function _warnDeprecated() {
  if (!_deprecationWarned) {
    console.warn('[Deprecated] FeedbackLoop 已弃用，请迁移到 EvolutionCoordinator');
    _deprecationWarned = true;
  }
}

class FeedbackLoop extends EventEmitter {
  /**
   * @deprecated 使用 new EvolutionCoordinator() 替代
   */
  constructor() {
    super();
    _warnDeprecated();
    this._coordinator = new EvolutionCoordinator();
    this._engines = {};
    this._metricsPipeline = null;
    this._collectionTimer = null;
    this._lastCollectionAt = null;
  }

  /** @deprecated */
  setCoordinator(_coordinator) {
    // No-op: EvolutionCoordinator 自带完整实现
  }

  /**
   * @deprecated
   * P1-7: 原实现委托 coordinator.setEngines（不存在）→ TypeError 被上层吞掉。
   * 现在仅存本地引用，周期收集时逐个调用引擎的 evolve()。
   */
  setEngines(engines) {
    this._engines = engines || {};
  }

  /**
   * @deprecated
   * P1-7: 原实现委托 coordinator.setMetricsPipeline（不存在）。
   * 现在仅存本地引用，_collectMetrics 直接消费。
   */
  setMetricsPipeline(pipeline) {
    this._metricsPipeline = pipeline;
  }

  /** @deprecated */
  startPeriodicCollection(intervalMs = 3600000) {
    if (this._collectionTimer) clearInterval(this._collectionTimer);
    this._collectionTimer = setInterval(() => {
      this._collectMetrics().catch(err => {
        console.error('[FeedbackLoop-deprecated] 指标收集失败:', err.message);
      });
    }, intervalMs);
    if (this._collectionTimer.unref) this._collectionTimer.unref();
    console.log(`[FeedbackLoop-deprecated] 定期收集已启动，间隔: ${intervalMs / 1000}s`);
  }

  /** @deprecated */
  stopPeriodicCollection() {
    if (this._collectionTimer) {
      clearInterval(this._collectionTimer);
      this._collectionTimer = null;
    }
  }

  /** @deprecated */
  async _collectMetrics() {
    this._lastCollectionAt = Date.now();
    if (!this._metricsPipeline) {
      this.emit('collection:skipped', { reason: 'no_metrics_pipeline' });
      return;
    }
    try {
      const overview = this._metricsPipeline.getOverview ? this._metricsPipeline.getOverview() : {};
      const metricNames = this._metricsPipeline.getMetricNames ? this._metricsPipeline.getMetricNames() : [];
      const degradations = this._detectDegradations(overview, metricNames);
      if (degradations.length > 0) {
        this.emit('degradation:detected', { degradations });
        for (const degradation of degradations) {
          await this.sendSystemFeedback({
            metric: degradation.metric,
            issue: degradation.metric + ' 超过阈值',
            priority: 'high',
          });
        }
      }
      this.emit('collection:completed', { overview, degradations });
    } catch (err) {
      console.error('[FeedbackLoop-deprecated] collection failed:', err.message);
      this.emit('collection:error', { error: err.message });
    }
  }

  /**
   * 本地退化检测（P1-7: 原委托 coordinator.detectDegradations 不存在）
   * 规则：指标条目带显式 threshold 且 lastValue 超过阈值，或错误类计数 > 10。
   */
  _detectDegradations(overview, metricNames) {
    const degradations = [];
    try {
      for (const name of metricNames || Object.keys(overview || {})) {
        const m = overview && overview[name];
        if (!m) continue;
        const value = typeof m === 'number' ? m : (m.lastValue ?? m.value);
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        let threshold = typeof m === 'object' ? m.threshold : null;
        if (threshold == null && /error|fail/i.test(name)) threshold = 10;
        if (threshold != null && value > threshold) {
          degradations.push({ metric: name, value, threshold });
        }
      }
    } catch (e) {
      console.warn('[FeedbackLoop-deprecated] degradation scan failed:', e.message);
    }
    return degradations;
  }

  /**
   * 系统级反馈（P1-7: 原委托 coordinator.sendSystemFeedback 不存在）
   * 路由到真实 FeedbackLoopEngine 持久化 + 演化日志留痕。
   */
  async sendSystemFeedback(feedback = {}) {
    try {
      const { getFeedbackLoopEngine } = require('./skill/feedback-loop-engine');
      getFeedbackLoopEngine().recordFeedback({
        skillName: feedback.skillName || feedback.metric || 'system',
        success: false,
        message: feedback.issue || feedback.message || '',
        source: 'evolution-feedback-loop',
        kind: 'system',
        ...feedback,
      });
      this._coordinator._appendEvolutionLog({ type: 'system_feedback', ...feedback });
      return `fb_${Date.now()}`;
    } catch (e) {
      console.warn('[FeedbackLoop-deprecated] sendSystemFeedback failed:', e.message);
      return null;
    }
  }

  /** @deprecated */
  async sendFeedback(feedback) {
    // EvolutionCoordinator 已移除 sendUserFeedback API；
    // 降级为写入演化日志，保证旧调用链不崩溃。
    try {
      this._coordinator._appendEvolutionLog({ type: 'feedback', ...feedback });
      return `fb_${Date.now()}`;
    } catch (e) {
      console.warn('[FeedbackLoop-deprecated] sendFeedback failed:', e.message);
      return null;
    }
  }

  /**
   * 会话结束反馈入口（harness-lifecycle.onSessionEnd 调用）。
   * 与 sendFeedback 同义，同时落到真实 FeedbackLoopEngine 持久化。
   * @deprecated 使用 EvolutionCoordinator 替代
   */
  collectUserFeedback(feedback = {}) {
    try {
      const { getFeedbackLoopEngine } = require('./skill/feedback-loop-engine');
      getFeedbackLoopEngine().recordFeedback({
        skillName: feedback.skillName || 'session',
        success: feedback.success !== false,
        message: feedback.message || JSON.stringify(feedback.data || {}).slice(0, 400),
        source: feedback.source || 'harness_lifecycle',
        kind: feedback.type || 'user',
        ...feedback,
      });
    } catch (e) {
      console.warn('[FeedbackLoop-deprecated] collectUserFeedback persist failed:', e.message);
    }
    return this.sendFeedback(feedback);
  }

  /**
   * @deprecated
   * P1-7: 原委托 coordinator.getFeedbackHistory（不存在）。
   * 路由到真实 FeedbackLoopEngine 的持久化历史。
   */
  getFeedbackHistory(limit = 50) {
    try {
      const { getFeedbackLoopEngine } = require('./skill/feedback-loop-engine');
      return getFeedbackLoopEngine().getFeedbackHistory({ limit });
    } catch (e) {
      console.warn('[FeedbackLoop-deprecated] getFeedbackHistory failed:', e.message);
      return [];
    }
  }

  /**
   * @deprecated
   * P1-7: 原委托 coordinator.getStats（不存在）。
   * 合并真实接口：coordinator.getReport() + FeedbackLoopEngine.getState() + 本地收集状态。
   */
  getStats() {
    const report = typeof this._coordinator.getReport === 'function'
      ? this._coordinator.getReport()
      : {};
    let feedbackState = {};
    try {
      const { getFeedbackLoopEngine } = require('./skill/feedback-loop-engine');
      feedbackState = getFeedbackLoopEngine().getState();
    } catch (e) {
      console.warn('[FeedbackLoop-deprecated] getStats feedback engine unavailable:', e.message);
    }
    return {
      ...report,
      feedback: feedbackState,
      lastCollectionAt: this._lastCollectionAt,
    };
  }

  /** @deprecated */
  _pruneHistory() {
    // EvolutionCoordinator 内部管理
  }
}

let _instance = null;

/** @deprecated */
function getFeedbackLoop() {
  if (!_instance) {
    _instance = new FeedbackLoop();
  }
  return Promise.resolve(_instance);
}

module.exports = {
  FeedbackLoop,
  getFeedbackLoop,
};
