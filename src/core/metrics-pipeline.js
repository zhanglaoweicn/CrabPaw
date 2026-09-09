/**
 * MetricsPipeline — 统一指标收集管道
 *
 * 整合 diagnostic-custodian + usage-stats + cost-tracker + health-monitor，
 * 提供延迟直方图、token 趋势、工具成功率时序，导出 OpenTelemetry 兼容格式。
 *
 * 接入点：ai.js 执行循环中每个 LLM 调用 + 工具调用后
 */
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("./config");

const METRICS_DIR = path.join(DATA_DIR, ".crabpaw", "metrics");
const SNAPSHOT_INTERVAL_MS = 30000;

class MetricsPipeline extends EventEmitter {
  constructor(config = {}) {
    super();
    this._enabled = config.enabled !== false;
    this._snapshotInterval = config.snapshotIntervalMs || SNAPSHOT_INTERVAL_MS;
    this._metricsDir = config.metricsDir || METRICS_DIR;
    this._startTime = Date.now();

    // Latency histograms (ms buckets)
    this._llmLatencyBuckets = [0, 500, 1000, 2000, 5000, 10000, 30000, 60000, Infinity];
    this._toolLatencyBuckets = [0, 50, 200, 500, 1000, 5000, 15000, 60000, Infinity];
    this._llmLatency = this._llmLatencyBuckets.map(() => 0);
    this._toolLatency = this._toolLatencyBuckets.map(() => 0);

    // Counters
    this._llmCalls = { total: 0, success: 0, failure: 0 };
    this._toolCalls = { total: 0, success: 0, failure: 0 };
    this._toolCallByTool = {};
    this._errorsByCategory = {};

    // Token tracking
    this._tokens = { prompt: 0, completion: 0, total: 0, byModel: {} };

    // Session tracking
    this._sessions = { total: 0, active: 0, completed: 0, failed: 0 };
    this._llmLatencyValues = [];
    this._toolLatencyValues = [];
    this._tokenSnapshots = [];

    this._snapshotTimer = null;

    if (this._enabled) {
      this._ensureMetricsDir();
      this._snapshotTimer = setInterval(() => this._takeSnapshot(), this._snapshotInterval);
      if (this._snapshotTimer.unref) this._snapshotTimer.unref();
    }

    // ── EventBus 订阅（使用 startTime 配对计算延迟）─────────
    try {
      const { getEventBus } = require('./events');
      const bus = getEventBus();
      this._llmStartTimes = new Map();
      this._toolStartTimes = new Map();
      let llmCallId = 0;
      // eslint-disable-next-line no-unused-vars
      let toolCallId = 0;

      bus.subscribe('llm:*', (event) => {
        try {
          if (event.type === 'call_start') {
            const id = ++llmCallId;
            this._llmStartTimes.set(id, event.payload?.startTime || Date.now());
            this.recordLlmCallStart();
          } else if (event.type === 'call_success') {
            const startTime = event.payload?.startTime;
            if (startTime) {
              this.recordLlmCallSuccess(startTime, event.payload?.model, event.payload?.usage);
            } else {
              // 无 startTime 时只计数
              this._llmCalls.success++;
            }
          } else if (event.type === 'call_failure') {
            const startTime = event.payload?.startTime;
            // eslint-disable-next-line no-unused-vars
            const duration = startTime ? Date.now() - startTime : 0;
            this._llmCalls.failure++;
            const category = this._classifyError({ message: event.payload?.error || 'unknown' });
            this._errorsByCategory[category] = (this._errorsByCategory[category] || 0) + 1;
          }
        } catch (e) { console.warn('[metrics-pipeline] llm event handler:', e.message); }
      });

      bus.subscribe('tool:*', (event) => {
        try {
          if (event.type === 'call_start') {
            this.recordToolCallStart(event.payload?.tool);
          } else if (event.type === 'call_success') {
            const startTime = event.payload?.startTime;
            if (startTime) {
              this.recordToolCallSuccess(startTime, event.payload?.tool);
            } else {
              this._toolCalls.success++;
            }
          } else if (event.type === 'call_failure') {
            const startTime = event.payload?.startTime;
            if (startTime) {
              this.recordToolCallFailure(startTime, event.payload?.tool, event.payload?.error);
            } else {
              this._toolCalls.failure++;
            }
          }
        } catch (e) { console.warn('[metrics-pipeline] tool event handler:', e.message); }
      });
    } catch (e) {
      console.warn('[metrics-pipeline] EventBus subscriptions failed (degraded mode):', e.message);
    }
  }

  _ensureMetricsDir() {
    try { fs.mkdirSync(this._metricsDir, { recursive: true }); } catch (_) { console.warn('[metrics-pipeline] Failed to create metrics directory'); }
  }

  _getBucket(values, buckets, value) {
    for (let i = 0; i < buckets.length; i++) {
      if (value <= buckets[i]) return i;
    }
    return buckets.length - 1;
  }

  // ─── LLM Call Recording ───
  recordLlmCallStart() {
    this._llmCalls.total++;
    return Date.now();
  }

  recordLlmCallSuccess(startTime, model, usage) {
    const duration = Date.now() - startTime;
    this._llmCalls.success++;
    this._llmLatency[this._getBucket(this._llmLatencyValues, this._llmLatencyBuckets, duration)]++;
    this._llmLatencyValues.push(duration);
    if (this._llmLatencyValues.length > 1000) this._llmLatencyValues.shift();

    if (usage) {
      this._tokens.prompt += usage.prompt_tokens || 0;
      this._tokens.completion += usage.completion_tokens || 0;
      this._tokens.total += usage.total_tokens || 0;
      if (model) {
        if (!this._tokens.byModel[model]) this._tokens.byModel[model] = { prompt: 0, completion: 0, total: 0 };
        this._tokens.byModel[model].prompt += usage.prompt_tokens || 0;
        this._tokens.byModel[model].completion += usage.completion_tokens || 0;
        this._tokens.byModel[model].total += usage.total_tokens || 0;
      }
    }
    this.emit("llmCall", { type: "success", duration, model, usage });
  }

  recordLlmCallFailure(startTime, error, model) {
    const duration = Date.now() - startTime;
    this._llmCalls.failure++;
    const category = this._classifyError(error);
    this._errorsByCategory[category] = (this._errorsByCategory[category] || 0) + 1;
    this.emit("llmCall", { type: "failure", duration, error: error.message, category, model });
  }

  // ─── Tool Call Recording ───
  recordToolCallStart(toolName) {
    this._toolCalls.total++;
    if (!this._toolCallByTool[toolName]) {
      this._toolCallByTool[toolName] = { total: 0, success: 0, failure: 0 };
    }
    this._toolCallByTool[toolName].total++;
    return Date.now();
  }

  recordToolCallSuccess(startTime, toolName) {
    const duration = Date.now() - startTime;
    this._toolCalls.success++;
    this._toolCallByTool[toolName].success++;
    this._toolLatency[this._getBucket(this._toolLatencyValues, this._toolLatencyBuckets, duration)]++;
    this._toolLatencyValues.push(duration);
    if (this._toolLatencyValues.length > 1000) this._toolLatencyValues.shift();
    this.emit("toolCall", { type: "success", tool: toolName, duration });
  }

  recordToolCallFailure(startTime, toolName, error) {
    const duration = Date.now() - startTime;
    this._toolCalls.failure++;
    this._toolCallByTool[toolName].failure++;
    const category = this._classifyError(error);
    this._errorsByCategory[category] = (this._errorsByCategory[category] || 0) + 1;
    this.emit("toolCall", { type: "failure", tool: toolName, duration, error: error.message, category });
  }

  // ─── Session Tracking ───
  recordSessionStart(userId) {
    this._sessions.total++;
    this._sessions.active++;
    this.emit("session", { type: "start", userId });
  }

  recordSessionEnd(userId, success) {
    this._sessions.active = Math.max(0, this._sessions.active - 1);
    if (success) this._sessions.completed++;
    else this._sessions.failed++;
    this.emit("session", { type: "end", userId, success });
  }

  // ─── Error Classification ───
  _classifyError(error) {
    if (!error) return "unknown";
    const msg = (error.message || error.toString()).toLowerCase();
    if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
    if (msg.includes("rate") || msg.includes("429") || msg.includes("limited")) return "rate_limit";
    if (msg.includes("token") || msg.includes("budget")) return "token_budget";
    if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) return "auth";
    if (msg.includes("connection") || msg.includes("econnrefused")) return "network";
    if (msg.includes("parse") || msg.includes("syntax") || msg.includes("json")) return "parse";
    if (msg.includes("permission") || msg.includes("access")) return "permission";
    return "other";
  }

  // ─── Percentiles ───
  _calculatePercentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
  }

  // ─── Snapshot & Export ───
  getSnapshot() {
    const llmLatVals = this._llmLatencyValues;
    const toolLatVals = this._toolLatencyValues;
    return {
      timestamp: Date.now(),
      uptime: Date.now() - this._startTime,
      llm: {
        calls: { ...this._llmCalls },
        latency: {
          p50: this._calculatePercentile(llmLatVals, 50),
          p95: this._calculatePercentile(llmLatVals, 95),
          p99: this._calculatePercentile(llmLatVals, 99),
          buckets: this._llmLatency,
        },
      },
      tools: {
        calls: { ...this._toolCalls },
        byTool: { ...this._toolCallByTool },
        latency: {
          p50: this._calculatePercentile(toolLatVals, 50),
          p95: this._calculatePercentile(toolLatVals, 95),
          p99: this._calculatePercentile(toolLatVals, 99),
          buckets: this._toolLatency,
        },
      },
      tokens: {
        total: this._tokens.total,
        prompt: this._tokens.prompt,
        completion: this._tokens.completion,
        byModel: { ...this._tokens.byModel },
      },
      sessions: { ...this._sessions },
      errors: { ...this._errorsByCategory },
    };
  }

  async _takeSnapshot() {
    try {
      const snapshot = this.getSnapshot();
      const file = path.join(this._metricsDir, `snapshot_${Date.now()}.json`);
      await fs.promises.writeFile(file, JSON.stringify(snapshot, null, 2));
    } catch (_) { console.warn('[metrics-pipeline] Failed to take snapshot'); }
  }

  // OpenTelemetry 兼容格式导出
  exportOpenTelemetry() {
    const snap = this.getSnapshot();
    return {
      resource: { "service.name": "crabpaw-harness" },
      metrics: [
        { name: "llm.calls.total", value: snap.llm.calls.total },
        { name: "llm.calls.success", value: snap.llm.calls.success },
        { name: "llm.calls.failure", value: snap.llm.calls.failure },
        { name: "llm.latency.p50", value: snap.llm.latency.p50 },
        { name: "llm.latency.p95", value: snap.llm.latency.p95 },
        { name: "llm.latency.p99", value: snap.llm.latency.p99 },
        { name: "tool.calls.total", value: snap.tools.calls.total },
        { name: "tool.calls.success", value: snap.tools.calls.success },
        { name: "tool.calls.failure", value: snap.tools.calls.failure },
        { name: "tool.latency.p50", value: snap.tools.latency.p50 },
        { name: "token.total", value: snap.tokens.total },
        { name: "sessions.active", value: snap.sessions.active },
        { name: "sessions.completed", value: snap.sessions.completed },
        { name: "errors.total", value: Object.values(this._errorsByCategory).reduce((a, b) => a + b, 0) },
      ],
      timestamp: snap.timestamp,
    };
  }

  reset() {
    this._llmLatency.fill(0);
    this._toolLatency.fill(0);
    this._llmCalls = { total: 0, success: 0, failure: 0 };
    this._toolCalls = { total: 0, success: 0, failure: 0 };
    this._toolCallByTool = {};
    this._errorsByCategory = {};
    this._tokens = { prompt: 0, completion: 0, total: 0, byModel: {} };
    this._sessions = { total: 0, active: 0, completed: 0, failed: 0 };
    this._llmLatencyValues = [];
    this._toolLatencyValues = [];
  }

  shutdown() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    this._takeSnapshot();
  }
}

const globalMetricsPipeline = new MetricsPipeline();

module.exports = { MetricsPipeline, globalMetricsPipeline };