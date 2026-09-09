/**
 * Harness Lifecycle — wires SelfHealing, Recovery, Feedback, and Metrics
 * into the main execution loop (ai.js).
 *
 * Previously these components existed as standalone files with zero
 * integration into the main loop. This module bridges that gap:
 *   - SelfHealingEngine  → triggered on consecutive tool/LLM failures
 *   - RecoveryChain      → executed when retries are exhausted
 *   - FeedbackLoop       → records session-end metrics for evolution
 *   - MetricsCollector   → increment on tool calls, LLM calls, errors
 *   - TrajectoryRecorder → real-time streaming writes (not tail-save)
 */

const { EventEmitter } = require('events');
const { getEventBus } = require('./events');

let _selfHealing = null;
let _recoveryChain = null;
// 仅供测试/诊断注入：非 null 时 _lazyRecoveryChain 直接返回注入对象，跳过惰性真实单例。
// 生产路径从不调用 injectRecoveryOrchestrator，行为与注入前完全一致。
let _recoveryChainOverride = null;
let _feedbackLoop = null;
let _metrics = null;
let _initialized = false;

function _lazySelfHealing() {
  if (!_selfHealing) {
    try {
      const { initSelfHealing } = require('./self-healing-engine');
      _selfHealing = initSelfHealing();
    } catch (e) {
      console.warn('[harness-lifecycle] SelfHealingEngine unavailable:', e.message);
      _selfHealing = { ingestSignal: () => {}, getStatus: () => ({}) };
    }
  }
  return _selfHealing;
}

function _lazyRecoveryChain() {
  if (_recoveryChainOverride) return _recoveryChainOverride;
  if (!_recoveryChain) {
    try {
      // 对齐 recovery-chain.js 的真实导出：RecoveryChainOrchestrator（此前
      // require 不存在的 RecoveryChainExecutor → 永远落到 stub，恢复链从未执行）。
      const { RecoveryChainOrchestrator } = require('./recovery-chain');
      _recoveryChain = new RecoveryChainOrchestrator();
    } catch (e) {
      console.warn('[harness-lifecycle] RecoveryChain unavailable:', e.message);
      _recoveryChain = { executeRecoveryChain: () => ({ success: false, finalStatus: 'unavailable', steps: [] }) };
    }
  }
  return _recoveryChain;
}

/**
 * 注入恢复编排器（仅供测试/诊断）。
 * - 传入对象：后续 onLlmCallFailure 的恢复链走该对象。
 * - 传入 null：复位为惰性真实单例（RecoveryChainOrchestrator）。
 * - 返回句柄 { restore() }：恢复注入前的 override 与真实单例缓存（支持嵌套注入）。
 * 生产代码不调用此 API，无注入时行为不变。
 */
function injectRecoveryOrchestrator(orchestrator) {
  const prevOverride = _recoveryChainOverride;
  const prevReal = _recoveryChain;
  _recoveryChainOverride = orchestrator;
  return {
    restore() {
      _recoveryChainOverride = prevOverride;
      _recoveryChain = prevReal;
    },
  };
}

function _lazyFeedbackLoop() {
  if (!_feedbackLoop) {
    try {
      const { FeedbackLoop } = require('./evolution-feedback-loop');
      _feedbackLoop = new FeedbackLoop();
    } catch (e) {
      console.warn('[harness-lifecycle] FeedbackLoop unavailable:', e.message);
      _feedbackLoop = {
        setMetricsPipeline: () => {},
        startPeriodicCollection: () => {},
        stopPeriodicCollection: () => {},
        collectUserFeedback: () => {},
      };
    }
  }
  return _feedbackLoop;
}

function _lazyMetrics() {
  if (!_metrics) {
    try {
      const { getMetricsCollector } = require('./observability');
      _metrics = getMetricsCollector();
    } catch (e) {
      console.warn('[harness-lifecycle] MetricsCollector unavailable:', e.message);
      _metrics = {
        increment: () => {},
        gauge: () => {},
        histogram: () => {},
        startTimer: () => () => 0,
        getAllMetrics: () => ({}),
      };
    }
  }
  return _metrics;
}

class HarnessLifecycleManager extends EventEmitter {
  constructor() {
    super();
    this._consecutiveToolFailures = 0;
    this._consecutiveLlmFailures = 0;
    this._maxConsecutiveFailures = 5;
    this._sessionStartTime = Date.now();
    this._totalToolCalls = 0;
    this._totalLlmCalls = 0;
    this._totalErrors = 0;
    this._contextCompactionCount = 0;
    this._contextEngine = null;
    this._trajectoryRecorder = null;
  }

  /**
   * Initialize all harness subsystems. Call once at startup.
   */
  initialize(options = {}) {
    if (_initialized) return;

    this._maxConsecutiveFailures = options.maxConsecutiveFailures || 5;

    const feedback = _lazyFeedbackLoop();
    const metrics = _lazyMetrics();
    feedback.setMetricsPipeline({
      getOverview: () => {
        const raw = metrics.getAllMetrics();
        const overview = {};
        for (const [name, val] of Object.entries(raw.counters || {})) {
          overview[name] = { lastValue: val };
        }
        return overview;
      },
      getMetricNames: () => Object.keys(metrics.getAllMetrics().counters || {}),
    });

    feedback.startPeriodicCollection(3600000);

    this._sessionStartTime = Date.now();

    // ── 自注册 crabpaw runtime 到 AgentHarness Registry ──
    try {
      const { getHarnessRegistry } = require('./agent-harness');
      const registry = getHarnessRegistry();
      const pkg = (() => { try { return require('../../package.json'); } catch { return { version: '0.0.0' }; } })();
      registry.register({
        id: 'crabpaw',
        label: 'CrabPaw AI',
        version: pkg.version,
        priority: 100,
        // attempt 函数：将 ai.js 的 chat() 适配为 AgentHarness 的 attempt 接口
        attempt: async (params) => {
          try {
            const { chat: chatFn } = require('./ai');
            const content = await chatFn(
              params.config || {},
              [],
              params.sessionId || 'default',
              params.messages?.[params.messages.length - 1]?.content || ''
            );
            return { success: true, content };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },
        compact: async (params) => {
          this.onContextCompaction(params?.prevTokens || 0, params?.newTokens || 0);
          return { success: true };
        },
        reset: async (_params) => {
          this._consecutiveToolFailures = 0;
          this._consecutiveLlmFailures = 0;
          this._totalToolCalls = 0;
          this._totalLlmCalls = 0;
          this._totalErrors = 0;
          this._contextCompactionCount = 0;
          this._sessionStartTime = Date.now();
          return { success: true };
        },
        classify: (result) => {
          if (!result) return { classification: 'error' };
          if (result.success === false) return { classification: 'error', reason: result.error };
          if (result.timedOut) return { classification: 'timed_out' };
          return { classification: 'ok' };
        },
      });
      console.log('[harness-lifecycle] Registered crabpaw runtime in AgentHarness Registry');
    } catch (e) {
      console.warn('[harness-lifecycle] Failed to register crabpaw runtime:', e.message);
    }

    _initialized = true;
    console.log('[harness-lifecycle] Initialized: SelfHealing + RecoveryChain + FeedbackLoop + Metrics');
  }

  setContextEngine(contextEngine) {
    this._contextEngine = contextEngine;
  }

  setTrajectoryRecorder(recorder) {
    this._trajectoryRecorder = recorder;
  }

  onLlmCallStart(modelName) {
    const metrics = _lazyMetrics();
    const startTime = Date.now();
    metrics.increment('llm.calls.total');
    if (modelName) metrics.increment(`llm.calls.by_model.${modelName}`);
    this._totalLlmCalls++;
    getEventBus().publish('llm', 'call_start', { model: modelName || 'unknown', startTime });
    return metrics.startTimer('llm.latency', { model: modelName || 'unknown' });
  }

  onLlmCallSuccess(modelName, usage = {}) {
    this._consecutiveLlmFailures = 0;
    const metrics = _lazyMetrics();
    metrics.gauge('llm.last_success', Date.now());
    if (usage.prompt_tokens) metrics.histogram('llm.prompt_tokens', usage.prompt_tokens);
    if (usage.completion_tokens) metrics.histogram('llm.completion_tokens', usage.completion_tokens);
    if (usage.total_tokens) metrics.histogram('llm.total_tokens', usage.total_tokens);
    getEventBus().publish('llm', 'call_success', { model: modelName, usage, startTime: Date.now() });
  }

  onLlmCallFailure(error, context = {}) {
    this._consecutiveLlmFailures++;
    const metrics = _lazyMetrics();
    metrics.increment('llm.errors.total');
    const errorType = context.errorType || 'unknown';
    metrics.increment(`llm.errors.${errorType}`);

    if (this._consecutiveLlmFailures >= this._maxConsecutiveFailures) {
      const healing = _lazySelfHealing();
      // 对齐 SelfHealingEngine 真实入口 ingestSignal（原 handleTrigger 不存在）
      try {
        healing.ingestSignal({
          type: 'llm_consecutive_failures',
          source: 'harness_lifecycle',
          detail: `连续 ${this._consecutiveLlmFailures} 次 LLM 失败: ${error?.message || ''}`,
        });
      } catch (e) {
        console.warn('[harness-lifecycle] SelfHealing ingest failed:', e?.message || e);
      }

      const recovery = _lazyRecoveryChain();
      // 对齐真类方法名 executeRecoveryChain；完整上下文由 Task 1（ai.js 侧）
      // 传入，缺失时各步骤 handler 自行降级（success:false）。
      try {
        recovery.executeRecoveryChain(error || context.failoverReason || 'timeout', {
          messages: context.messages,
          compressFn: context.compressFn,
          fallbackProviderFn: context.fallbackProviderFn,
          fallbackModelFn: context.fallbackModelFn,
          shrinkImagesFn: context.shrinkImagesFn,
          contextEngine: this._contextEngine,
        }).then(result => {
          if (result && result.finalStatus) {
            console.log(`[harness-lifecycle] Recovery chain ${result.executionId}: ${result.finalStatus}`);
          }
        }).catch(e => console.warn('[harness-lifecycle] Recovery failed:', e?.message || e));
      } catch (e) {
        console.warn('[harness-lifecycle] Recovery invocation failed:', e?.message || e);
      }
    }

    this.emit('llm:failures:threshold', {
      count: this._consecutiveLlmFailures,
      error: error?.message,
    });
    getEventBus().publish('llm', 'call_failure', {
      error: error?.message,
      errorType: context.errorType,
      consecutiveFailures: this._consecutiveLlmFailures,
      startTime: Date.now(),
    });
  }

  onToolCallStart(toolName) {
    const metrics = _lazyMetrics();
    const startTime = Date.now();
    metrics.increment('tool.calls.total');
    metrics.increment(`tool.calls.${toolName}`);
    this._totalToolCalls++;
    getEventBus().publish('tool', 'call_start', { tool: toolName, startTime });
    return metrics.startTimer('tool.latency', { tool: toolName });
  }

  onToolCallSuccess(toolName) {
    this._consecutiveToolFailures = 0;
    const metrics = _lazyMetrics();
    metrics.increment(`tool.success.${toolName}`);
    getEventBus().publish('tool', 'call_success', { tool: toolName, startTime: Date.now() });
  }

  onToolCallFailure(toolName, error) {
    this._consecutiveToolFailures++;
    this._totalErrors++;
    const metrics = _lazyMetrics();
    metrics.increment('tool.errors.total');
    metrics.increment(`tool.errors.${toolName || 'unknown'}`);

    if (this._consecutiveToolFailures >= this._maxConsecutiveFailures) {
      const healing = _lazySelfHealing();
      // 对齐 SelfHealingEngine 真实入口 ingestSignal（原 handleTrigger 不存在）
      try {
        healing.ingestSignal({
          type: 'tool_consecutive_failures',
          source: 'harness_lifecycle',
          detail: `连续 ${this._consecutiveToolFailures} 次工具 ${toolName} 失败: ${error?.message || ''}`,
        });
      } catch (e) {
        console.warn('[harness-lifecycle] SelfHealing ingest failed:', e?.message || e);
      }
    }

    this.emit('tool:failures:threshold', {
      count: this._consecutiveToolFailures,
      tool: toolName,
      error: error?.message,
    });
    getEventBus().publish('tool', 'call_failure', {
      tool: toolName,
      error: error?.message,
      consecutiveFailures: this._consecutiveToolFailures,
    });
  }

  onContextCompaction(prevTokens, newTokens) {
    this._contextCompactionCount++;
    const metrics = _lazyMetrics();
    metrics.increment('context.compaction.count');
    metrics.histogram('context.compaction.saved_tokens', prevTokens - newTokens);

    // PreCompact 钩子：压缩前抢救关键记忆
    try {
      const { memoryManager } = require('./memory-system');
      const bus = getEventBus();
      if (memoryManager && bus) {
        // 2026-08-15 T7(累积B): 修正三参签名 publish(category, type, payload)——
        // 旧两参写法 type 位置传入对象,route 变成 memory:pre_compact:[object Object],
        // 订阅方(unified-memory 'memory:pre_compact')永不匹配。
        bus.publish('memory', 'pre_compact', {
          sessionId: this._currentSessionId,
          savedTokens: prevTokens - newTokens,
        });
      }
    } catch (e) {
      /* graceful degradation */
      console.warn('[harness-lifecycle.js] 空 catch 补日志:', e && e.message);
    }

  }

  onSessionEnd(sessionStats = {}) {
    const metrics = _lazyMetrics();
    const duration = Date.now() - this._sessionStartTime;

    metrics.gauge('session.duration_ms', duration);
    metrics.gauge('session.total_tool_calls', this._totalToolCalls);
    metrics.gauge('session.total_llm_calls', this._totalLlmCalls);
    metrics.gauge('session.total_errors', this._totalErrors);
    metrics.gauge('session.context_compactions', this._contextCompactionCount);
    metrics.increment('session.completed');

    const feedback = _lazyFeedbackLoop();
    feedback.collectUserFeedback({
      type: 'session_end',
      source: 'harness_lifecycle',
      data: {
        duration,
        toolCalls: this._totalToolCalls,
        llmCalls: this._totalLlmCalls,
        errors: this._totalErrors,
        compactions: this._contextCompactionCount,
        ...sessionStats,
      },
    });

    if (this._trajectoryRecorder && sessionStats.trajectory) {
      this._trajectoryRecorder.recordEvent({
        type: 'session_complete',
        timestamp: Date.now(),
        stats: {
          toolCalls: this._totalToolCalls,
          llmCalls: this._totalLlmCalls,
          errors: this._totalErrors,
          duration,
        },
      });
    }

    this.emit('session:end', {
      duration,
      toolCalls: this._totalToolCalls,
      llmCalls: this._totalLlmCalls,
      errors: this._totalErrors,
    });
    getEventBus().publish('session', 'end', {
      duration,
      toolCalls: this._totalToolCalls,
      llmCalls: this._totalLlmCalls,
      errors: this._totalErrors,
      compactions: this._contextCompactionCount,
    });
  }

  onSystemAnomaly(anomalyType, data = {}) {
    const healing = _lazySelfHealing();
    let handled = false;
    try {
      healing.ingestSignal({
        type: anomalyType,
        source: data.source || 'harness_lifecycle',
        detail: data.detail || data.message || JSON.stringify(data).slice(0, 200),
      });
      const status = healing.getStatus?.();
      handled = !!(status && status.activeHealing);
    } catch (e) {
      console.warn('[harness-lifecycle] SelfHealing ingest failed:', e?.message || e);
    }
    this.emit('system:anomaly', { type: anomalyType, data, handled });
    getEventBus().publish('system', 'anomaly', { anomalyType, data, handled });
  }

  getStats() {
    return {
      initialized: _initialized,
      sessionDuration: Date.now() - this._sessionStartTime,
      toolCalls: this._totalToolCalls,
      llmCalls: this._totalLlmCalls,
      errors: this._totalErrors,
      compactions: this._contextCompactionCount,
      consecutiveToolFailures: this._consecutiveToolFailures,
      consecutiveLlmFailures: this._consecutiveLlmFailures,
      healingStatus: _lazySelfHealing().getStatus?.() || {},
      metrics: _lazyMetrics().getAllMetrics?.() || {},
    };
  }

  shutdown() {
    const feedback = _lazyFeedbackLoop();
    feedback.stopPeriodicCollection();
    this.emit('shutdown');
    getEventBus().publish('system', 'shutdown', { timestamp: Date.now() });
    _initialized = false;
  }
}

const globalHarnessLifecycle = new HarnessLifecycleManager();

module.exports = {
  HarnessLifecycleManager,
  globalHarnessLifecycle,
  injectRecoveryOrchestrator,
};
