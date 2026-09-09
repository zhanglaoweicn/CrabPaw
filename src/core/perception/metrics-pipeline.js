/**
 * Metrics Pipeline — 统一指标采集管线
 *
 * 为 CrabPaw 进化体系提供中心化指标采集、聚合和查询能力：
 *   - 统一 MetricEvent 格式：{name, value, tags, timestamp}
 *   - 所有模块通过 SignalBus 发出 metric 信号，Pipeline 聚合写入时序存储
 *   - 数据清洗：异常值检测、冷启动标记、采样偏差校正
 *   - 查询接口：按名称/标签/时间范围查询聚合指标
 *
 * 进化关键指标：
 *   - skill.success_rate     技能成功率
 *   - skill.latency_p50/p95  技能耗时分布
 *   - skill.error_rate       技能错误率
 *   - memory.recall_rate     记忆召回命中率
 *   - memory.store_count     记忆写入次数
 *   - llm.token_usage        Token 消耗
 *   - llm.latency            模型调用延迟
 *   - llm.cost               模型调用成本
 *   - evolution.success_rate 进化成功率
 *   - evolution.rollback_rate 进化回滚率
 *   - system.memory_usage    系统内存占用
 *   - system.cpu_usage       CPU 占用
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const METRICS_DIR = path.join(DATA_DIR, 'metrics');
const METRICS_DB_FILE = path.join(METRICS_DIR, 'metrics.jsonl');

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_FLUSH_INTERVAL_MS = 30000; // 30秒刷盘
const DEFAULT_MAX_BUFFER_SIZE = 500;

/**
 * 降采样配置
 * 超过 downsamplingAgeMs 的数据自动聚合为分钟级桶，防止内存无限增长
 */
const DOWNSAMPLING_CONFIG = {
  // 超过此时间的数据点降采样为分钟级聚合桶
  downsamplingAgeMs: 24 * 60 * 60 * 1000, // 1天
  // 聚合桶大小（毫秒）
  bucketSizeMs: 60 * 1000, // 1分钟
  // 每个指标名保留的最近原始数据点上限（超出触发降采样）
  maxRawPointsPerSeries: 1440, // 约1天的1分钟粒度数据
};

/**
 * 数据清洗规则
 */
const CLEANING_RULES = {
  // Z-score 异常值检测阈值
  ZSCORE_THRESHOLD: 3.0,
  // 冷启动标记：前 N 次执行标记为 warmup
  WARMUP_COUNT: 5,
  // 最小样本量：少于此数量不做异常值检测
  MIN_SAMPLE_SIZE: 10,
};

class MetricEvent {
  constructor(name, value, tags = {}) {
    this.name = name;           // 指标名（如 skill.success_rate）
    this.value = value;         // 数值
    this.tags = tags;           // 标签（如 {skill: 'web_search', provider: 'ollama'}）
    this.timestamp = Date.now();
    this._warmup = false;       // 冷启动标记
  }

  toJSON() {
    return {
      name: this.name,
      value: this.value,
      tags: this.tags,
      timestamp: this.timestamp,
      warmup: this._warmup,
    };
  }
}

class MetricsPipeline extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      retentionDays: config.retentionDays || DEFAULT_RETENTION_DAYS,
      flushIntervalMs: config.flushIntervalMs || DEFAULT_FLUSH_INTERVAL_MS,
      maxBufferSize: config.maxBufferSize || DEFAULT_MAX_BUFFER_SIZE,
      ...config,
    };

    // 写入缓冲
    this._buffer = [];

    // 时序数据存储（内存缓存，按指标名分组）
    this._series = new Map(); // metricName → [{value, tags, timestamp, warmup}]

    // 降采样后的聚合桶（metricName → bucketKey → {avg, min, max, count, timestamp}）
    this._downsampledBuckets = new Map();

    // 冷启动计数器：metricName+tagKey → count
    this._callCounts = new Map();

    // 定时刷盘
    this._flushTimer = null;

    this._initialized = false;
  }

  /**
   * 初始化
   */
  initialize() {
    if (this._initialized) return;

    if (!fs.existsSync(METRICS_DIR)) {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
    }

    this._loadFromDisk();
    this._startFlushTimer();
    this._initialized = true;

    console.log('[MetricsPipeline] 初始化完成, 已加载 ' + this._series.size + ' 个指标序列');
  }

  /**
   * 关闭
   */
  shutdown() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush();
  }

  // ========== 核心接口 ==========

  /**
   * 记录指标（核心入口）
   *
   * @param {string} name - 指标名
   * @param {number} value - 数值
   * @param {object} tags - 标签
   */
  record(name, value, tags = {}) {
    if (!this._initialized) this.initialize();

    const event = new MetricEvent(name, value, tags);

    // 冷启动标记
    const countKey = this._getCountKey(name, tags);
    const callCount = this._callCounts.get(countKey) || 0;
    if (callCount < CLEANING_RULES.WARMUP_COUNT) {
      event._warmup = true;
    }
    this._callCounts.set(countKey, callCount + 1);

    // 数据清洗：异常值检测
    if (this._isOutlier(name, value, tags)) {
      this.emit('metric:outlier', { name, value, tags });
      // 异常值仍记录，但标记
      event.tags._outlier = true;
    }

    // 加入缓冲
    this._buffer.push(event.toJSON());

    // 加入内存序列
    if (!this._series.has(name)) {
      this._series.set(name, []);
    }
    this._series.get(name).push(event.toJSON());

    // 缓冲满时刷盘
    if (this._buffer.length >= this.config.maxBufferSize) {
      this._flush();
    }

    this.emit('metric:recorded', { name, value });
  }

  /**
   * 批量记录
   */
  recordBatch(events) {
    for (const { name, value, tags } of events) {
      this.record(name, value, tags || {});
    }
  }

  // ========== 查询接口 ==========

  /**
   * 查询指标聚合值
   *
   * @param {string} name - 指标名
   * @param {object} options - {tags, since, until, aggregation, excludeWarmup}
   * @returns {object} 聚合结果
   */
  query(name, options = {}) {
    const {
      tags = {},
      since = 0,
      until = Date.now(),
      aggregation = 'avg',
      excludeWarmup = true,
    } = options;

    let series = this._series.get(name) || [];

    // 时间范围过滤
    series = series.filter(p => p.timestamp >= since && p.timestamp <= until);

    // 标签过滤
    if (Object.keys(tags).length > 0) {
      series = series.filter(p => {
        for (const [k, v] of Object.entries(tags)) {
          if (p.tags[k] !== v) return false;
        }
        return true;
      });
    }

    // 排除冷启动数据
    if (excludeWarmup) {
      series = series.filter(p => !p.warmup);
    }

    // 排除异常值
    series = series.filter(p => !p.tags._outlier);

    // 合并降采样桶数据（如果查询范围覆盖了降采样区间）
    const bucketValues = this._getBucketValues(name, { tags, since, until });
    const values = [...bucketValues, ...series.map(p => p.value)];

    if (values.length === 0) {
      return { name, count: 0, value: null, aggregation };
    }

    switch (aggregation) {
      case 'avg':
        return { name, count: values.length, value: values.reduce((a, b) => a + b, 0) / values.length, aggregation };
      case 'sum':
        return { name, count: values.length, value: values.reduce((a, b) => a + b, 0), aggregation };
      case 'min':
        return { name, count: values.length, value: Math.min(...values), aggregation };
      case 'max':
        return { name, count: values.length, value: Math.max(...values), aggregation };
      case 'p50':
        return { name, count: values.length, value: this._percentile(values, 50), aggregation };
      case 'p95':
        return { name, count: values.length, value: this._percentile(values, 95), aggregation };
      case 'p99':
        return { name, count: values.length, value: this._percentile(values, 99), aggregation };
      case 'rate':
        // 成功率：value=1 表示成功，value=0 表示失败
        return { name, count: values.length, value: values.reduce((a, b) => a + b, 0) / values.length, aggregation };
      default:
        return { name, count: values.length, value: values[values.length - 1], aggregation };
    }
  }

  /**
   * 获取降采样桶中的值列表
   */
  _getBucketValues(name, { tags = {}, since = 0, until = Date.now() } = {}) {
    const buckets = this._downsampledBuckets.get(name);
    if (!buckets) return [];

    const values = [];
    for (const bucket of buckets.values()) {
      if (bucket.timestamp < since || bucket.timestamp > until) continue;

      // 标签过滤
      if (Object.keys(tags).length > 0) {
        let match = true;
        for (const [k, v] of Object.entries(tags)) {
          if (bucket.tags[k] !== v) { match = false; break; }
        }
        if (!match) continue;
      }

      // 用桶的 count 和 avg 还原加权值列表（近似）
      values.push(bucket.avg);
    }
    return values;
  }

  /**
   * 查询时序数据点
   */
  querySeries(name, options = {}) {
    const {
      tags = {},
      since = 0,
      until = Date.now(),
      intervalMs = 60000, // 1分钟聚合
      excludeWarmup = true,
    } = options;

    let series = this._series.get(name) || [];

    series = series.filter(p => p.timestamp >= since && p.timestamp <= until);

    if (Object.keys(tags).length > 0) {
      series = series.filter(p => {
        for (const [k, v] of Object.entries(tags)) {
          if (p.tags[k] !== v) return false;
        }
        return true;
      });
    }

    if (excludeWarmup) {
      series = series.filter(p => !p.warmup);
    }

    // 按时间窗口聚合
    const buckets = new Map();
    for (const p of series) {
      const bucketKey = Math.floor(p.timestamp / intervalMs) * intervalMs;
      if (!buckets.has(bucketKey)) {
        buckets.set(bucketKey, []);
      }
      buckets.get(bucketKey).push(p.value);
    }

    const result = [];
    for (const [bucketKey, values] of buckets) {
      result.push({
        timestamp: bucketKey,
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
      });
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 获取所有指标名
   */
  getMetricNames() {
    return [...this._series.keys()];
  }

  /**
   * 获取指标统计概览
   */
  getOverview() {
    const overview = {};
    for (const name of this._series.keys()) {
      const series = this._series.get(name);
      const recent = series.filter(p => p.timestamp > Date.now() - 3600000); // 最近1小时
      overview[name] = {
        totalPoints: series.length,
        recentPoints: recent.length,
        lastValue: series.length > 0 ? series[series.length - 1].value : null,
        lastTimestamp: series.length > 0 ? series[series.length - 1].timestamp : null,
      };
    }
    return overview;
  }

  // ========== 内部方法 ==========

  /**
   * 异常值检测（Z-score）
   */
  _isOutlier(name, value, tags) {
    const series = this._series.get(name) || [];

    // 只对最近100个同标签数据点检测
    const recentValues = series
      .filter(p => {
        for (const [k, v] of Object.entries(tags)) {
          if (k === '_outlier') continue;
          if (p.tags[k] !== v) return false;
        }
        return true;
      })
      .slice(-100)
      .map(p => p.value);

    if (recentValues.length < CLEANING_RULES.MIN_SAMPLE_SIZE) {
      return false;
    }

    const mean = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const std = Math.sqrt(recentValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recentValues.length);

    if (std === 0) return false;

    const zScore = Math.abs(value - mean) / std;
    return zScore > CLEANING_RULES.ZSCORE_THRESHOLD;
  }

  /**
   * 百分位数计算
   */
  _percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  _getCountKey(name, tags) {
    const tagStr = Object.entries(tags)
      .filter(([k]) => k !== '_outlier')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}|${tagStr}`;
  }

  _startFlushTimer() {
    this._flushTimer = setInterval(() => {
      this._flush();
      this._trimSeries();
    }, this.config.flushIntervalMs);
  }

  _flush() {
    if (this._buffer.length === 0) return;

    try {
      const lines = this._buffer.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(METRICS_DB_FILE, lines, 'utf-8');
      this._buffer = [];
    } catch (e) { console.warn('[metrics-pipeline] flush failed, continuing:', e.message); }
  }

  _trimSeries() {
    const cutoff = Date.now() - this.config.retentionDays * 86400000;

    for (const [name, series] of this._series) {
      // 1. 删除过期数据
      const trimmed = series.filter(p => p.timestamp >= cutoff);
      if (trimmed.length < series.length) {
        this._series.set(name, trimmed);
      }
    }

    // 2. 降采样：超过 maxRawPointsPerSeries 的序列，将旧数据聚合为分钟级桶
    this._downsampleOldSeries();
  }

  /**
   * 降采样旧数据：将超过 downsamplingAgeMs 的原始数据点聚合为分钟级桶
   * 聚合桶保留 {avg, min, max, count}，查询时自动合并桶数据
   */
  _downsampleOldSeries() {
    const now = Date.now();
    const downsampleCutoff = now - DOWNSAMPLING_CONFIG.downsamplingAgeMs;

    for (const [name, series] of this._series) {
      if (series.length <= DOWNSAMPLING_CONFIG.maxRawPointsPerSeries) {
        continue; // 数据量未超限，无需降采样
      }

      // 分离：旧数据（需降采样）vs 近期数据（保留原始）
      const oldPoints = series.filter(p => p.timestamp < downsampleCutoff);
      const recentPoints = series.filter(p => p.timestamp >= downsampleCutoff);

      if (oldPoints.length === 0) continue;

      // 按 bucket 聚合旧数据
      if (!this._downsampledBuckets.has(name)) {
        this._downsampledBuckets.set(name, new Map());
      }
      const buckets = this._downsampledBuckets.get(name);

      for (const p of oldPoints) {
        const bucketKey = Math.floor(p.timestamp / DOWNSAMPLING_CONFIG.bucketSizeMs) * DOWNSAMPLING_CONFIG.bucketSizeMs;
        const tagKey = this._getBucketTagKey(p.tags);

        const compositeKey = `${bucketKey}|${tagKey}`;
        if (!buckets.has(compositeKey)) {
          buckets.set(compositeKey, {
            timestamp: bucketKey,
            avg: 0,
            min: Infinity,
            max: -Infinity,
            count: 0,
            sum: 0,
            tags: p.tags,
          });
        }
        const bucket = buckets.get(compositeKey);
        bucket.sum += p.value;
        bucket.min = Math.min(bucket.min, p.value);
        bucket.max = Math.max(bucket.max, p.value);
        bucket.count++;
      }

      // 完成聚合计算
      for (const bucket of buckets.values()) {
        if (bucket.count > 0) {
          bucket.avg = bucket.sum / bucket.count;
        }
      }

      // 用近期数据替换原始序列（旧数据已聚合到桶中）
      this._series.set(name, recentPoints);

      // 清理过期桶
      for (const [compositeKey, bucket] of buckets) {
        if (bucket.timestamp < now - this.config.retentionDays * 86400000) {
          buckets.delete(compositeKey);
        }
      }
    }
  }

  /**
   * 生成桶的标签键（用于区分不同标签组合的桶）
   */
  _getBucketTagKey(tags) {
    if (!tags || Object.keys(tags).length === 0) return '_none';
    return Object.entries(tags)
      .filter(([k]) => k !== '_outlier' && k !== 'warmup')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(METRICS_DB_FILE)) return;

      const content = fs.readFileSync(METRICS_DB_FILE, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      const cutoff = Date.now() - this.config.retentionDays * 86400000;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.timestamp < cutoff) continue;

          if (!this._series.has(event.name)) {
            this._series.set(event.name, []);
          }
          this._series.get(event.name).push(event);
        } catch (e) { console.warn('[metrics-pipeline] failed to handle event:', e.message); }
      }
    } catch (e) { console.warn('[metrics-pipeline] failed to load historical events, starting empty:', e.message); }
  }
}

// 单例
let _instance = null;

function getMetricsPipeline(config = {}) {
  if (!_instance) {
    _instance = new MetricsPipeline(config);
  }
  return _instance;
}

module.exports = {
  MetricsPipeline,
  getMetricsPipeline,
  MetricEvent,
  DOWNSAMPLING_CONFIG,
};
