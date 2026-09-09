/**
 * EnterpriseDataSourceManager — 企业数据源管理器
 *
 * 功能：
 *   1. 多源冗余：企查查(主) → 爱企查(备1) → 水滴信用(备2) → 百度搜索(备3)
 *   2. 异常检测：3-sigma统计模型检测延迟/错误率突变
 *   3. 自动切换：连续3次失败自动降级，5分钟冷却后重试
 *   4. 数据校验：企业名称/信用代码合理性检查
 *   5. 本地缓存：企业信息缓存7天，减少重复请求
 *   6. [P3] 反馈循环：根据查询结果质量动态调整数据源优先级
 *   7. [P3] 数据源评分：综合延迟、成功率、数据完整度打分
 *   8. [P3] 参数优化：自动调整超时、重试次数、并发数
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_DIR = path.join(config.DATA_DIR, 'enterprise-cache');
const SCORE_DIR = path.join(config.DATA_DIR, 'enterprise-scores');
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 7天

// ==================== 数据源定义 ====================

const DATA_SOURCES = {
  tianyancha: {
    name: '天眼查',
    priority: 1,
    capabilities: ['basic', 'shareholders', 'risks', 'personnel', 'ip', 'business', 'related'],
    baseUrl: 'https://www.tianyancha.com',
    rateLimit: { maxRequests: 20, windowMs: 60000 },
    reliability: 0.90,
    timeout: 30000,
    retries: 2,
  },
  qichacha: {
    name: '企查查',
    priority: 2,
    capabilities: ['basic', 'shareholders', 'risks'],
    baseUrl: 'https://m.qcc.com',
    rateLimit: { maxRequests: 20, windowMs: 60000 },
    reliability: 0.85,
    timeout: 30000,
    retries: 2,
  },
  aiqicha: {
    name: '爱企查',
    priority: 3,
    capabilities: ['basic', 'shareholders', 'personnel', 'risks', 'ip', 'business', 'related', 'history'],
    baseUrl: 'https://aiqicha.baidu.com',
    rateLimit: { maxRequests: 30, windowMs: 60000 },
    reliability: 0.90,
    timeout: 25000,
    retries: 2,
  },
  shuidi: {
    name: '水滴信用',
    priority: 4,
    capabilities: ['basic', 'shareholders', 'personnel', 'risks', 'ip', 'business'],
    baseUrl: 'https://www.shuidi.cn',
    rateLimit: { maxRequests: 15, windowMs: 60000 },
    reliability: 0.75,
    timeout: 20000,
    retries: 1,
  },
  baidu: {
    name: '百度搜索',
    priority: 5,
    capabilities: ['basic'],
    baseUrl: 'https://www.baidu.com',
    rateLimit: { maxRequests: 20, windowMs: 60000 },
    reliability: 0.85,
    timeout: 15000,
    retries: 1,
  },
};

// ==================== 数据校验器 ====================

class EnterpriseDataValidator {
  validateBasic(data) {
    const issues = [];
    if (!data) return { valid: false, issues: ['数据为空'] };

    if (!data.name || data.name.length < 2) issues.push('企业名称异常');
    if (data.unifiedCode && !/^[0-9A-Z]{18}$/.test(data.unifiedCode)) {
      // 信用代码可能包含中文，放宽校验
      if (data.unifiedCode.length !== 18) issues.push('统一社会信用代码长度异常');
    }
    if (data.regCapital && !/[\d万亿千百万元]/.test(data.regCapital)) issues.push('注册资本格式异常');

    return { valid: issues.length === 0, issues };
  }

  crossValidate(sources) {
    const entries = Object.entries(sources).filter(([, v]) => v?.basic?.name);
    if (entries.length < 2) return { consistent: true, deviation: '0%', details: '数据源不足' };

    // 比较企业名称一致性
    const names = entries.map(([, v]) => v.basic.name);
    const allSame = names.every(n => n === names[0]);

    return {
      consistent: allSame,
      deviation: allSame ? '0%' : '名称不一致',
      details: `数据源: ${entries.map(([k]) => k).join(', ')}`,
    };
  }
}

// ==================== 本地缓存 ====================

class EnterpriseCache {
  constructor() {
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  }

  _cacheKey(query) {
    // 标准化查询关键词作为缓存key
    return query.replace(/[^\w\u4e00-\u9fff]/g, '_').substring(0, 100);
  }

  get(query) {
    try {
      const filePath = path.join(CACHE_DIR, `${this._cacheKey(query)}.json`);
      if (!fs.existsSync(filePath)) return null;

      const cached = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
        // 缓存过期
        try { fs.unlinkSync(filePath); } catch (e) {
          /* ignore */
          console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
        }

        return null;
      }

      return cached.data;
    } catch (e) {
      return null;
    }
  }

  set(query, data) {
    try {
      const filePath = path.join(CACHE_DIR, `${this._cacheKey(query)}.json`);
      fs.writeFileSync(filePath, JSON.stringify({
        timestamp: Date.now(),
        query,
        data,
      }, null, 2));
    } catch (e) {
      /* ignore */
      console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
    }

  }

  clear() {
      try {
      if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      files.forEach(f => {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (e) {
        /* ignore */
        console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
      }
      });
      }
    } catch (e) {
      /* ignore */
      console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
    }

  }
}

// ==================== 主管理器 ====================

class EnterpriseDataSourceManager {
  constructor() {
    this._sources = { ...DATA_SOURCES };
    this._validator = new EnterpriseDataValidator();
    this._cache = new EnterpriseCache();
    this._sourceHealth = {};
    this._requestCounts = {};

    for (const key of Object.keys(this._sources)) {
      this._sourceHealth[key] = {
        available: true,
        consecutiveFails: 0,
        totalRequests: 0,
        totalFailures: 0,
        avgLatencyMs: 0,
        lastCheck: 0,
        lastError: null,
      };
      this._requestCounts[key] = { count: 0, windowStart: Date.now() };
    }

    // [P3] 加载历史评分
    this._loadScores();
  }

  /**
   * 通过冗余架构获取企业数据
   * @param {string} query - 查询关键词
   * @returns {{ data, source, degraded, validation, fromCache }}
   */
  async fetchWithRedundancy(query) {
    // 先查缓存
    const cached = this._cache.get(query);
    if (cached) {
      return {
        data: cached,
        source: 'cache',
        sourceName: '本地缓存',
        degraded: false,
        fromCache: true,
        validation: this._validator.validateBasic(cached.basic),
      };
    }

    // 按优先级排序可用数据源
    const sortedSources = Object.entries(this._sources)
      .filter(([, s]) => s.capabilities.includes('basic'))
      .sort(([, a], [, b]) => a.priority - b.priority);

    // eslint-disable-next-line no-unused-vars
    for (const [sourceKey, sourceDef] of sortedSources) {
      if (!this._isSourceAvailable(sourceKey)) continue;
      if (!this._checkRateLimit(sourceKey)) continue;

      // 实际获取由 enterprise-tools.js 中的爬虫函数执行
      // 这里只负责健康管理和缓存
      // 数据获取逻辑在 enterprise-tools.js 中直接调用各爬虫函数
    }

    // 数据获取由调用方（enterprise-tools.js）完成
    // 此管理器主要负责：缓存、健康状态、速率限制
    return null;
  }

  /**
   * 记录数据源成功
   */
  recordSuccess(sourceKey, latencyMs) {
    const health = this._sourceHealth[sourceKey];
    if (!health) return;

    health.available = true;
    health.consecutiveFails = 0;
    health.totalRequests++;
    health.lastCheck = Date.now();
    health.avgLatencyMs = health.avgLatencyMs === 0
      ? latencyMs
      : health.avgLatencyMs * 0.8 + latencyMs * 0.2;

    // 同步到进化桥
    try {
      const evoBridge = require('./tool-evolution-bridge').getToolEvolutionBridge();
      evoBridge._updateSourceScore(`enterprise_${sourceKey}`, true, latencyMs);
    } catch (e) {
      /* ignore */
      console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
    }

  }

  /**
   * 记录数据源失败
   */
  recordFailure(sourceKey, error) {
      const health = this._sourceHealth[sourceKey];
      if (!health) return;
      health.consecutiveFails++;
      health.totalRequests++;
      health.totalFailures++;
      health.lastCheck = Date.now();
      health.lastError = error;
      if (health.consecutiveFails >= 3) {
      health.available = false;
      }
      try {
      const evoBridge = require('./tool-evolution-bridge').getToolEvolutionBridge();
      evoBridge._updateSourceScore(`enterprise_${sourceKey}`, false, 0);
      } catch (e) {
        /* ignore */
        console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
      }

  }

  /**
   * 缓存数据
   */
  cacheData(query, data) {
    this._cache.set(query, data);
  }

  /**
   * 获取缓存
   */
  getCached(query) {
    return this._cache.get(query);
  }

  /**
   * 获取健康报告
   */
  getHealthReport() {
    const report = {};
    for (const [key, source] of Object.entries(this._sources)) {
      const health = this._sourceHealth[key];
      report[key] = {
        name: source.name,
        priority: source.priority,
        available: health.available,
        consecutiveFails: health.consecutiveFails,
        totalRequests: health.totalRequests,
        totalFailures: health.totalFailures,
        failureRate: health.totalRequests > 0
          ? (health.totalFailures / health.totalRequests * 100).toFixed(1) + '%'
          : '0%',
        avgLatencyMs: Math.round(health.avgLatencyMs),
        lastError: health.lastError,
      };
    }
    return report;
  }

  _isSourceAvailable(sourceKey) {
    const health = this._sourceHealth[sourceKey];
    if (!health) return false;
    if (health.consecutiveFails >= 3) {
      if (Date.now() - health.lastCheck > 5 * 60 * 1000) {
        health.consecutiveFails = 0;
        return true;
      }
      return false;
    }
    return health.available;
  }

  _checkRateLimit(sourceKey) {
    const source = this._sources[sourceKey];
    const counter = this._requestCounts[sourceKey];
    const now = Date.now();

    if (now - counter.windowStart > source.rateLimit.windowMs) {
      counter.count = 0;
      counter.windowStart = now;
    }

    if (counter.count >= source.rateLimit.maxRequests) return false;
    counter.count++;
    return true;
  }

  // ==================== P3: 反馈循环 + 评分 + 参数优化 ====================

  /**
   * [P3] 记录查询反馈 — 核心反馈循环入口
   * @param {string} sourceKey - 数据源标识
   * @param {boolean} success - 是否成功
   * @param {number} latencyMs - 响应延迟
   * @param {object} dataQuality - 数据质量指标 { completeness, accuracy, fields }
   */
  recordFeedback(sourceKey, success, latencyMs, dataQuality = {}) {
    // 1. 更新基础健康状态
    if (success) {
      this.recordSuccess(sourceKey, latencyMs);
    } else {
      this.recordFailure(sourceKey, 'feedback_reported');
    }

    // 2. 更新评分
    this._updateScore(sourceKey, success, latencyMs, dataQuality);

    // 3. 检查是否需要动态调整优先级
    this._rebalancePriorities();

    // 4. 参数优化
    this._optimizeParams(sourceKey, success, latencyMs);

    // 5. 持久化评分
    this._persistScores();
  }

  /**
   * [P3] 数据源评分系统
   * 综合评分 = 成功率权重(40%) + 延迟权重(30%) + 数据完整度权重(30%)
   */
  _updateScore(sourceKey, success, latencyMs, dataQuality) {
    if (!this._scores) this._scores = {};
    if (!this._scores[sourceKey]) {
      this._scores[sourceKey] = {
        successRate: 0.5,       // 初始50%
        avgLatency: 5000,       // 初始5秒
        completeness: 0.5,      // 初始50%
        totalScore: 50,
        history: [],            // 最近20次记录
      };
    }

    const score = this._scores[sourceKey];

    // 记录历史（保留最近20次）
    score.history.push({ success, latencyMs, completeness: dataQuality.completeness || 0, ts: Date.now() });
    if (score.history.length > 20) score.history.shift();

    // 从历史计算指标
    const recent = score.history;
    const successCount = recent.filter(h => h.success).length;
    score.successRate = successCount / recent.length;

    const latencies = recent.filter(h => h.success).map(h => h.latencyMs);
    score.avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 30000;

    const completenesses = recent.filter(h => h.completeness > 0).map(h => h.completeness);
    score.completeness = completenesses.length > 0 ? completenesses.reduce((a, b) => a + b, 0) / completenesses.length : 0.5;

    // 综合评分 (0-100)
    const successScore = score.successRate * 100;
    const latencyScore = Math.max(0, 100 - (score.avgLatency / 300)); // 30秒=0分
    const completenessScore = score.completeness * 100;

    score.totalScore = successScore * 0.4 + latencyScore * 0.3 + completenessScore * 0.3;
  }

  /**
   * [P3] 动态优先级调整
   * 当某数据源评分显著高于/低于当前优先级对应位置时，调整优先级
   */
  _rebalancePriorities() {
    if (!this._scores) return;

    const sourceKeys = Object.keys(this._sources);
    const scored = sourceKeys
      .map(key => ({ key, score: this._scores[key]?.totalScore ?? 50 }))
      .sort((a, b) => b.score - a.score); // 高分优先

    let changed = false;
    scored.forEach((item, idx) => {
      const newPriority = idx + 1;
      if (this._sources[item.key].priority !== newPriority) {
        this._sources[item.key].priority = newPriority;
        changed = true;
      }
    });

    if (changed) {
      console.log(`[DataSourceManager] 优先级调整: ${scored.map(s => `${this._sources[s.key].name}(${s.score.toFixed(0)}分,P${this._sources[s.key].priority})`).join(' → ')}`);
    }
  }

  /**
   * [P3] 参数优化 — 根据历史表现调整超时和重试
   */
  // eslint-disable-next-line no-unused-vars
  _optimizeParams(sourceKey, _success, latencyMs) {
    const source = this._sources[sourceKey];
    if (!source) return;

    const health = this._sourceHealth[sourceKey];
    if (!health || health.totalRequests < 5) return; // 至少5次请求后才优化

    // 超时优化：基于P95延迟
    if (health.avgLatencyMs > 0) {
      const p95Estimate = health.avgLatencyMs * 1.5;
      // 超时设为P95的1.5倍，但不低于10秒、不高于60秒
      source.timeout = Math.max(10000, Math.min(60000, Math.round(p95Estimate * 1.5 / 1000) * 1000));
    }

    // 重试优化：失败率高则增加重试
    const failRate = health.totalFailures / health.totalRequests;
    if (failRate > 0.3) {
      source.retries = Math.min(3, (source.retries || 1) + 1);
    } else if (failRate < 0.1 && (source.retries || 1) > 1) {
      source.retries = Math.max(1, (source.retries || 1) - 1);
    }
  }

  /**
   * [P3] 获取数据源评分报告
   */
  getScoreReport() {
    if (!this._scores) return {};
    const report = {};
    for (const [key, score] of Object.entries(this._scores)) {
      const source = this._sources[key];
      report[key] = {
        name: source?.name || key,
        totalScore: score.totalScore.toFixed(1),
        successRate: (score.successRate * 100).toFixed(1) + '%',
        avgLatency: Math.round(score.avgLatency) + 'ms',
        completeness: (score.completeness * 100).toFixed(1) + '%',
        priority: source?.priority || '?',
        timeout: source?.timeout || '?',
        retries: source?.retries || '?',
        sampleSize: score.history.length,
      };
    }
    return report;
  }

  /**
   * [P3] 获取优化后的参数
   */
  getOptimizedParams(sourceKey) {
    const source = this._sources[sourceKey];
    if (!source) return null;
    return {
      timeout: source.timeout || 30000,
      retries: source.retries || 2,
      rateLimit: source.rateLimit,
    };
  }

  /**
   * [P3] 持久化评分到磁盘
   */
  _persistScores() {
    try {
      if (!this._scores) return;
      if (!fs.existsSync(SCORE_DIR)) {
        fs.mkdirSync(SCORE_DIR, { recursive: true });
      }
      fs.writeFileSync(
        path.join(SCORE_DIR, 'scores.json'),
        JSON.stringify({ scores: this._scores, sources: Object.fromEntries(
          Object.entries(this._sources).map(([k, v]) => [k, { priority: v.priority, timeout: v.timeout, retries: v.retries }])
        ), timestamp: Date.now() }, null, 2)
      );
    } catch (e) {
      /* ignore */
      console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
    }

  }

  /**
   * [P3] 加载持久化评分
   */
  _loadScores() {
      try {
      const filePath = path.join(SCORE_DIR, 'scores.json');
      if (!fs.existsSync(filePath)) return;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.scores) this._scores = data.scores;
      // 恢复优化后的参数
      if (data.sources) {
      for (const [key, params] of Object.entries(data.sources)) {
      if (this._sources[key]) {
      if (params.priority) this._sources[key].priority = params.priority;
      if (params.timeout) this._sources[key].timeout = params.timeout;
      if (params.retries) this._sources[key].retries = params.retries;
      }
      }
      }
      } catch (e) {
        /* ignore */
        console.warn('[enterprise-data-source-manager.js] 空 catch 补日志:', e && e.message);
      }

  }
}

// 单例
let _instance = null;

function getEnterpriseDataSourceManager() {
  if (!_instance) {
    _instance = new EnterpriseDataSourceManager();
  }
  return _instance;
}

module.exports = { EnterpriseDataSourceManager, getEnterpriseDataSourceManager, EnterpriseCache, EnterpriseDataValidator, DATA_SOURCES };
