/**
 * StockDataSourceManager — 股票数据接口稳定性保障系统
 *
 * 核心功能：
 *   1. 接口监控：实时监控各数据源可用性、延迟、错误率
 *   2. 异常检测：基于统计模型检测数据异常（突变、缺失、延迟飙升）
 *   3. 多接口冗余：主备数据源架构，支持自动切换
 *   4. 数据校验：交叉验证多个数据源的一致性
 *
 * 支持的数据源：
 *   - 东方财富（主）: 行情/财务/资金流/融资融券
 *   - 新浪财经（备1）: 行情/历史K线
 *   - 腾讯财经（备2）: 行情/实时报价
 *   - 同花顺（备3）: 行情/板块/资金
 *
 * 架构设计：
 *   请求 → DataSourceManager → [主源] → 成功? → 返回
 *                                    ↓ 失败
 *                                  [备1] → 成功? → 返回
 *                                    ↓ 失败
 *                                  [备2] → 成功? → 返回
 *                                    ↓ 失败
 *                                  [备3] → 返回（含降级标记）
 */

const https = require('https');
const http = require('http');
const { getToolEvolutionBridge } = require('./tool-evolution-bridge');

// ==================== 数据源定义 ====================

const DATA_SOURCES = {
  // 主数据源：东方财富
  eastmoney: {
    name: '东方财富',
    priority: 1,
    capabilities: ['quote', 'kline', 'financial', 'fundFlow', 'margin', 'news', 'guba', 'industry'],
    baseUrl: 'https://push2.eastmoney.com',
    rateLimit: { maxRequests: 30, windowMs: 1000 },
    reliability: 0.95,
  },
  // 备用数据源1：新浪财经
  sina: {
    name: '新浪财经',
    priority: 2,
    capabilities: ['quote', 'kline'],
    baseUrl: 'https://hq.sinajs.cn',
    rateLimit: { maxRequests: 20, windowMs: 1000 },
    reliability: 0.90,
  },
  // 备用数据源2：腾讯财经
  tencent: {
    name: '腾讯财经',
    priority: 3,
    capabilities: ['quote', 'kline'],
    baseUrl: 'https://qt.gtimg.cn',
    rateLimit: { maxRequests: 20, windowMs: 1000 },
    reliability: 0.88,
  },
  // 备用数据源3：同花顺
  tonghuashun: {
    name: '同花顺',
    priority: 4,
    capabilities: ['quote', 'industry'],
    baseUrl: 'https://d.10jqka.com.cn',
    rateLimit: { maxRequests: 15, windowMs: 1000 },
    reliability: 0.85,
  },
};

// ==================== 异常检测器 ====================

class AnomalyDetector {
  constructor() {
    this._history = {}; // source -> metric -> [values]
    this._maxHistory = 100;
  }

  /**
   * 记录指标值
   */
  record(source, metric, value) {
    if (!this._history[source]) this._history[source] = {};
    if (!this._history[source][metric]) this._history[source][metric] = [];

    const arr = this._history[source][metric];
    arr.push({ value, timestamp: Date.now() });

    if (arr.length > this._maxHistory) {
      this._history[source][metric] = arr.slice(-50);
    }
  }

  /**
   * 检测异常 — 基于3-sigma规则
   * @returns {{ isAnomaly: boolean, zScore: number, description: string }}
   */
  detect(source, metric, value) {
    const arr = this._history[source]?.[metric];
    if (!arr || arr.length < 10) {
      return { isAnomaly: false, zScore: 0, description: '数据不足' };
    }

    const values = arr.map(a => a.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length);

    if (std === 0) {
      return { isAnomaly: value !== mean, zScore: 0, description: std === 0 ? '无波动' : '' };
    }

    const zScore = (value - mean) / std;
    const isAnomaly = Math.abs(zScore) > 3;

    return {
      isAnomaly,
      zScore: zScore.toFixed(2),
      description: isAnomaly
        ? `${metric}异常: z-score=${zScore.toFixed(2)}, 均值=${mean.toFixed(0)}, 当前=${value.toFixed(0)}`
        : '正常',
    };
  }

  /**
   * 获取源的统计摘要
   */
  getSummary(source) {
    const metrics = this._history[source] || {};
    const summary = {};

    for (const [metric, arr] of Object.entries(metrics)) {
      if (arr.length < 2) continue;
      const values = arr.map(a => a.value);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const std = Math.sqrt(values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length);
      summary[metric] = { mean: mean.toFixed(2), std: std.toFixed(2), count: arr.length };
    }

    return summary;
  }
}

// ==================== 数据校验器 ====================

class DataValidator {
  /**
   * 校验行情数据合理性
   */
  validateQuote(quote) {
    const issues = [];

    if (!quote) return { valid: false, issues: ['数据为空'] };

    // 价格合理性
    if (quote.price <= 0) issues.push('价格≤0');
    if (quote.price > 100000) issues.push('价格异常高');

    // 涨跌幅合理性
    if (quote.changePct != null) {
      if (Math.abs(quote.changePct) > 20) issues.push(`涨跌幅异常: ${quote.changePct}%`);
    }

    // 成交量合理性
    if (quote.volume != null && quote.volume < 0) issues.push('成交量为负');

    // PE/PB合理性
    if (quote.pe_ttm != null && quote.pe_ttm < -1000) issues.push('PE异常低');
    if (quote.pb != null && quote.pb < -100) issues.push('PB异常低');

    return { valid: issues.length === 0, issues };
  }

  /**
   * 交叉验证多个数据源的一致性
   */
  crossValidate(quotes) {
    const sources = Object.keys(quotes).filter(k => quotes[k] != null);
    if (sources.length < 2) {
      return { consistent: true, deviation: 0, details: '数据源不足，无法交叉验证' };
    }

    const prices = sources.map(s => quotes[s].price).filter(p => p > 0);
    if (prices.length < 2) {
      return { consistent: true, deviation: 0, details: '有效价格不足' };
    }

    const meanPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const maxDeviation = Math.max(...prices.map(p => Math.abs(p - meanPrice) / meanPrice));

    return {
      consistent: maxDeviation < 0.01, // 1%偏差内认为一致
      deviation: (maxDeviation * 100).toFixed(2) + '%',
      details: `价格范围: ${Math.min(...prices).toFixed(2)} ~ ${Math.max(...prices).toFixed(2)}`,
    };
  }
}

// ==================== 主管理器 ====================

class StockDataSourceManager {
  constructor() {
    this._sources = { ...DATA_SOURCES };
    this._anomalyDetector = new AnomalyDetector();
    this._validator = new DataValidator();
    this._sourceHealth = {}; // source -> { available, lastCheck, consecutiveFails, ... }
    this._requestCounts = {}; // source -> { count, windowStart }

    // 初始化健康状态
    for (const key of Object.keys(this._sources)) {
      this._sourceHealth[key] = {
        available: true,
        lastCheck: 0,
        consecutiveFails: 0,
        totalRequests: 0,
        totalFailures: 0,
        avgLatencyMs: 0,
        lastError: null,
      };
      this._requestCounts[key] = { count: 0, windowStart: Date.now() };
    }
  }

  /**
   * 通过冗余架构获取行情数据
   * @param {string} code - 股票代码
   * @param {string[]} capabilities - 需要的能力
   * @returns {{ data, source, degraded, validation }}
   */
  async fetchWithRedundancy(code, capabilities = ['quote']) {
    // 按优先级排序可用数据源
    const sortedSources = Object.entries(this._sources)
      .filter(([, s]) => capabilities.every(c => s.capabilities.includes(c)))
      .sort(([, a], [, b]) => a.priority - b.priority);

    let lastError = null;
    const allQuotes = {};

    for (const [sourceKey, sourceDef] of sortedSources) {
      // 检查源是否可用
      if (!this._isSourceAvailable(sourceKey)) {
        continue;
      }

      // 检查速率限制
      if (!this._checkRateLimit(sourceKey)) {
        continue;
      }

      const startTime = Date.now();

      try {
        const data = await this._fetchFromSource(sourceKey, sourceDef, code);
        const latency = Date.now() - startTime;

        // 记录成功
        this._recordSuccess(sourceKey, latency);
        this._anomalyDetector.record(sourceKey, 'latency', latency);

        // 数据校验
        const validation = this._validator.validateQuote(data);
        if (!validation.valid) {
          this._recordFailure(sourceKey, `数据校验失败: ${validation.issues.join(', ')}`);
          allQuotes[sourceKey] = null;
          continue;
        }

        allQuotes[sourceKey] = data;

        // 主源成功，直接返回
        if (sourceKey === sortedSources[0][0]) {
          return {
            data,
            source: sourceKey,
            sourceName: sourceDef.name,
            degraded: false,
            latency,
            validation,
          };
        }

        // 备用源成功
        return {
          data,
          source: sourceKey,
          sourceName: sourceDef.name,
          degraded: true,
          latency,
          validation,
        };
      } catch (err) {
        const latency = Date.now() - startTime;
        this._recordFailure(sourceKey, err.message);
        this._anomalyDetector.record(sourceKey, 'latency', latency);
        lastError = err;
      }
    }

    // 所有源都失败
    return {
      data: null,
      source: null,
      degraded: true,
      error: lastError?.message || '所有数据源不可用',
      validation: { valid: false, issues: ['所有数据源不可用'] },
    };
  }

  /**
   * 从指定源获取数据
   */
  async _fetchFromSource(sourceKey, sourceDef, code) {
    switch (sourceKey) {
      case 'eastmoney':
        return this._fetchEastMoney(code);
      case 'sina':
        return this._fetchSina(code);
      case 'tencent':
        return this._fetchTencent(code);
      default:
        throw new Error(`未知数据源: ${sourceKey}`);
    }
  }

  /**
   * 东方财富行情
   */
  async _fetchEastMoney(code) {
    const secid = code.startsWith('6') ? `1.${code}` : `0.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f55,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171,f292`;

    const data = await this._httpGet(url);
    if (!data?.data) throw new Error('东方财富返回空数据');

    const d = data.data;
    return {
      price: d.f43 / 100,
      open: d.f44 / 100,
      high: d.f45 / 100,
      low: d.f46 / 100,
      volume: d.f47,
      amount: d.f48,
      change: d.f169 / 100,
      changePct: d.f170 / 100,
      pe_ttm: d.f167,
      pb: d.f162,
      totalMv: d.f116,
      circMv: d.f117,
      name: d.f58,
      code: d.f57,
    };
  }

  /**
   * 新浪财经行情
   */
  async _fetchSina(code) {
    const sinaCode = code.startsWith('6') ? `sh${code}` : `sz${code}`;
    const url = `https://hq.sinajs.cn/list=${sinaCode}`;

    const text = await this._httpGetText(url);
    const match = text.match(/="([^"]+)"/);
    if (!match) throw new Error('新浪财经返回空数据');

    const fields = match[1].split(',');
    if (fields.length < 32) throw new Error('新浪财经数据格式异常');

    return {
      name: fields[0],
      open: parseFloat(fields[1]),
      high: parseFloat(fields[3]),
      low: parseFloat(fields[4]),
      price: parseFloat(fields[3]) || 0, // 当前价用收盘价
      volume: parseInt(fields[8]),
      amount: parseFloat(fields[9]),
      code,
    };
  }

  /**
   * 腾讯财经行情
   */
  async _fetchTencent(code) {
    const qqCode = code.startsWith('6') ? `sh${code}` : `sz${code}`;
    const url = `https://qt.gtimg.cn/q=${qqCode}`;

    const text = await this._httpGetText(url);
    const match = text.match(/="([^"]+)"/);
    if (!match) throw new Error('腾讯财经返回空数据');

    const fields = match[1].split('~');
    if (fields.length < 45) throw new Error('腾讯财经数据格式异常');

    return {
      name: fields[1],
      code: fields[2],
      price: parseFloat(fields[3]),
      high: parseFloat(fields[33]),
      low: parseFloat(fields[34]),
      open: parseFloat(fields[5]),
      volume: parseInt(fields[6]),
      amount: parseFloat(fields[37]),
      change: parseFloat(fields[31]),
      changePct: parseFloat(fields[32]),
      pe_ttm: parseFloat(fields[39]) || null,
      pb: parseFloat(fields[46]) || null,
      totalMv: parseFloat(fields[45]) || null,
    };
  }

  // ==================== 健康管理 ====================

  _isSourceAvailable(sourceKey) {
    const health = this._sourceHealth[sourceKey];
    if (!health) return false;

    // 连续失败3次以上，暂时不可用
    if (health.consecutiveFails >= 3) {
      // 检查是否超过冷却期（5分钟）
      if (Date.now() - health.lastCheck > 5 * 60 * 1000) {
        health.consecutiveFails = 0; // 重置，允许重试
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

    // 重置窗口
    if (now - counter.windowStart > source.rateLimit.windowMs) {
      counter.count = 0;
      counter.windowStart = now;
    }

    if (counter.count >= source.rateLimit.maxRequests) {
      return false;
    }

    counter.count++;
    return true;
  }

  _recordSuccess(sourceKey, latencyMs) {
    const health = this._sourceHealth[sourceKey];
    health.available = true;
    health.consecutiveFails = 0;
    health.totalRequests++;
    health.lastCheck = Date.now();
    health.avgLatencyMs = health.avgLatencyMs === 0
      ? latencyMs
      : health.avgLatencyMs * 0.8 + latencyMs * 0.2;

    // 同步到进化桥
    try {
      const evoBridge = getToolEvolutionBridge();
      evoBridge._updateSourceScore(`stock_${sourceKey}`, true, latencyMs);
    } catch (e) {
      /* ignore */
      console.warn('[stock-data-source-manager.js] 空 catch 补日志:', e && e.message);
    }

  }

  _recordFailure(sourceKey, error) {
      const health = this._sourceHealth[sourceKey];
      health.consecutiveFails++;
      health.totalRequests++;
      health.totalFailures++;
      health.lastCheck = Date.now();
      health.lastError = error;
      if (health.consecutiveFails >= 3) {
      health.available = false;
      }
      // 同步到进化桥
      try {
      const evoBridge = getToolEvolutionBridge();
      evoBridge._updateSourceScore(`stock_${sourceKey}`, false, 0);
      } catch (e) {
        /* ignore */
        console.warn('[stock-data-source-manager.js] 空 catch 补日志:', e && e.message);
      }

  }

  // ==================== 监控报告 ====================

  getHealthReport() {
    const report = {};

    for (const [key, source] of Object.entries(this._sources)) {
      const health = this._sourceHealth[key];
      const anomalySummary = this._anomalyDetector.getSummary(key);

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
        anomalySummary,
      };
    }

    return report;
  }

  /**
   * 获取当前最优数据源
   */
  getBestSource(capability = 'quote') {
    const candidates = Object.entries(this._sources)
      .filter(([, s]) => s.capabilities.includes(capability))
      .filter(([key]) => this._isSourceAvailable(key))
      .sort(([, a], [, b]) => {
        // 优先按可用性+优先级
        const healthA = this._sourceHealth[Object.keys(this._sources).find(k => this._sources[k] === a)];
        const healthB = this._sourceHealth[Object.keys(this._sources).find(k => this._sources[k] === b)];
        const scoreA = a.reliability - (healthA?.consecutiveFails || 0) * 0.1;
        const scoreB = b.reliability - (healthB?.consecutiveFails || 0) * 0.1;
        return scoreB - scoreA;
      });

    return candidates.length > 0 ? candidates[0] : null;
  }

  // ==================== HTTP 工具 ====================

  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON解析失败: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    });
  }

  _httpGetText(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, {
        timeout: 8000,
        headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      }, (res) => {
        // 2026-08-31 fix: 新浪 hq.sinajs.cn / 腾讯 qt.gtimg.cn 行情均为 GBK 编码，
        // 此前 res.setEncoding('utf-8') 按 UTF-8 解码 → 中文股票名乱码（如"贵州茅台"
        // 变 "锟斤拷"）。改为收集原始字节，用 Node 内置 TextDecoder('gbk') 解码；
        // 解码后若仍含替换符（说明该源实际非 GBK），回退 UTF-8 解码，避免误伤。
        const chunks = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let text;
          try {
            text = new TextDecoder('gbk').decode(buf);
          } catch (e) {
            // 运行时无 full-icu / 不支持 gbk → 回退 UTF-8
            text = buf.toString('utf-8');
          }
          if (text.includes('\uFFFD')) text = buf.toString('utf-8');
          resolve(text);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    });
  }
}

// 单例
let _instance = null;

function getStockDataSourceManager() {
  if (!_instance) {
    _instance = new StockDataSourceManager();
  }
  return _instance;
}

module.exports = { StockDataSourceManager, getStockDataSourceManager, DATA_SOURCES, AnomalyDetector, DataValidator };
