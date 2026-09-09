const crypto = require('crypto');
/**
 * StockSkillEvolution — 股票技能自我进化引擎
 *
 * 核心模块：
 *   1. 数据反馈循环：记录每次分析的预测结果，与实际走势对比
 *   2. 模型自动优化：根据反馈调整因子权重、阈值、参数
 *   3. 用户行为学习：学习用户查询偏好、关注维度、反馈信号
 *   4. 技能迭代更新：触发条件→评估→实施→验证的完整闭环
 *
 * 进化触发条件：
 *   - 累计分析次数达到阈值（每50次触发一次评估）
 *   - 预测准确率低于目标值（连续10次预测偏差>5%）
 *   - 数据源质量变化（评分下降超过0.3）
 *   - 用户反馈信号（显式负面反馈≥3次）
 *
 * 评估标准：
 *   - 预测方向准确率 > 60%
 *   - 多因子排序与实际涨跌相关性 > 0.3
 *   - 用户满意度评分 > 0.7
 *   - 数据源可用率 > 95%
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const EVOLUTION_DIR = path.join(config.DATA_DIR, 'stock-evolution');
const FEEDBACK_FILE = path.join(EVOLUTION_DIR, 'feedback.json');
const MODEL_PARAMS_FILE = path.join(EVOLUTION_DIR, 'model-params.json');
const USER_BEHAVIOR_FILE = path.join(EVOLUTION_DIR, 'user-behavior.json');
const EVOLUTION_LOG_FILE = path.join(EVOLUTION_DIR, 'evolution-log.json');

// 默认模型参数（可被进化引擎调整）
const DEFAULT_MODEL_PARAMS = {
  // 多因子权重
  multiFactorWeights: {
    value: 0.25,
    growth: 0.25,
    quality: 0.30,
    momentum: 0.20,
  },
  // 情感分析权重
  sentimentWeights: {
    news: 0.40,
    guba: 0.25,
    announcement: 0.35,
  },
  // ML预测权重
  mlWeights: {
    knn: 0.35,
    regression: 0.30,
    ensemble: 0.35,
  },
  // 微观结构权重
  microstructureWeights: {
    priceImpact: 0.25,
    buyPressure: 0.30,
    volumeConcentration: 0.20,
    priceEfficiency: 0.25,
  },
  // 阈值参数
  thresholds: {
    overboughtRSI: 70,
    oversoldRSI: 30,
    highVolatilityATR: 0.05,
    strongTrendMA: 0.02,
    sentimentPositive: 0.65,
    sentimentNegative: 0.35,
  },
  // 综合评分维度权重
  dimensionWeights: {
    technical: 0.15,
    fundamental: 0.15,
    quantitative: 0.15,
    sentiment: 0.10,
    alternative: 0.10,
    ml: 0.10,
    microstructure: 0.10,
    capitalFlow: 0.15,
  },
  // 版本号
  version: 1,
  lastUpdated: Date.now(),
};

class StockSkillEvolution {
  constructor() {
    this._feedback = [];
    this._modelParams = null;
    this._userBehavior = null;
    this._evolutionLog = [];
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;

    if (!fs.existsSync(EVOLUTION_DIR)) {
      fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
    }

    this._loadFeedback();
    this._loadModelParams();
    this._loadUserBehavior();
    this._loadEvolutionLog();
    this._initialized = true;

    console.log('[StockSkillEvolution] 股票技能进化引擎已初始化');
  }

  // ==================== 1. 数据反馈循环 ====================

  /**
   * 记录分析结果（用于后续与实际走势对比）
   * @param {string} code - 股票代码
   * @param {object} prediction - 预测结果
   * @param {string} prediction.direction - 预测方向（看多/中性/看空）
   * @param {number} prediction.confidence - 预测置信度
   * @param {number} prediction.price - 预测时价格
   * @param {object} factors - 各因子得分快照
   */
  recordAnalysis(code, prediction, factors) {
    if (!this._initialized) return;

    const record = {
      id: `fb-${Date.now()}-${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      code,
      timestamp: Date.now(),
      date: new Date().toISOString().slice(0, 10),
      prediction: {
        direction: prediction.direction || '中性',
        confidence: prediction.confidence || 0,
        price: prediction.price || 0,
      },
      factors: {
        multiFactorScore: factors.multiFactorScore || 0,
        sentimentScore: factors.sentimentScore || 0,
        mlDirection: factors.mlDirection || '中性',
        capitalFlowScore: factors.capitalFlowScore || 0,
        microstructureScore: factors.microstructureScore || 0,
      },
      actual: null, // 待回填
      verified: false,
    };

    this._feedback.push(record);

    // 保留最近500条记录
    if (this._feedback.length > 500) {
      this._feedback = this._feedback.slice(-300);
    }

    this._saveFeedback();

    // 检查是否需要触发进化
    this._checkEvolutionTrigger();
  }

  /**
   * 回填实际走势数据（由定时任务或下次查询时触发）
   * @param {string} recordId - 反馈记录ID
   * @param {object} actual - 实际走势
   */
  backfillActual(recordId, actual) {
    const record = this._feedback.find(r => r.id === recordId);
    if (!record || record.verified) return;

    record.actual = {
      priceAfter1w: actual.priceAfter1w || null,
      priceAfter1m: actual.priceAfter1m || null,
      returnAfter1w: actual.returnAfter1w || null,
      returnAfter1m: actual.returnAfter1m || null,
      directionCorrect: null,
    };

    // 判断预测方向是否正确
    if (record.actual.returnAfter1w != null) {
      const actualDir = record.actual.returnAfter1w > 1 ? '看多' : record.actual.returnAfter1w < -1 ? '看空' : '中性';
      record.actual.directionCorrect = (
        (record.prediction.direction === '看多' && actualDir === '看多') ||
        (record.prediction.direction === '看空' && actualDir === '看空') ||
        (record.prediction.direction === '中性' && actualDir === '中性')
      );
    }

    record.verified = true;
    this._saveFeedback();
  }

  /**
   * 批量回填未验证的记录
   */
  async backfillUnverifiedRecords(fetchPriceFn) {
    const unverified = this._feedback.filter(r => !r.verified && Date.now() - r.timestamp > 7 * 24 * 3600 * 1000);

    for (const record of unverified.slice(0, 20)) {
      try {
        const currentPrice = await fetchPriceFn(record.code);
        if (currentPrice && record.prediction.price > 0) {
          const returnPct = (currentPrice - record.prediction.price) / record.prediction.price * 100;
          this.backfillActual(record.id, {
            priceAfter1w: currentPrice,
            returnAfter1w: returnPct,
          });
        }
      } catch (e) {

        // 价格获取失败，跳过

        console.warn('[stock-skill-evolution.js] 空 catch 补日志:', e && e.message);
      }

    }
  }

  // ==================== 2. 模型自动优化 ====================

  /**
   * 基于反馈数据优化模型参数
   */
  optimizeModelParams() {
    const verified = this._feedback.filter(r => r.verified && r.actual?.directionCorrect != null);
    if (verified.length < 20) {
      return { optimized: false, reason: '验证数据不足（需≥20条）' };
    }

    const params = { ...this._modelParams };
    const changes = [];

    // 2.1 优化多因子权重
    const directionCorrect = verified.filter(r => r.actual.directionCorrect);
    const accuracy = directionCorrect.length / verified.length;

    if (accuracy < 0.5) {
      // 准确率低，尝试调整权重
      // 分析哪些因子与正确预测相关性更高
      const factorCorrelations = this._calculateFactorCorrelations(verified);

      if (factorCorrelations.multiFactorScore > 0.2) {
        params.multiFactorWeights.value = Math.min(0.40, params.multiFactorWeights.value + 0.03);
        changes.push('增加价值因子权重');
      }
      if (factorCorrelations.sentimentScore > 0.2) {
        params.sentimentWeights.news = Math.min(0.50, params.sentimentWeights.news + 0.03);
        changes.push('增加新闻情感权重');
      }
      if (factorCorrelations.capitalFlowScore > 0.2) {
        params.dimensionWeights.capitalFlow = Math.min(0.25, params.dimensionWeights.capitalFlow + 0.02);
        changes.push('增加资金流维度权重');
      }

      // 归一化权重
      this._normalizeWeights(params.multiFactorWeights);
      this._normalizeWeights(params.sentimentWeights);
      this._normalizeWeights(params.mlWeights);
      this._normalizeWeights(params.microstructureWeights);
      this._normalizeWeights(params.dimensionWeights);
    }

    // 2.2 优化阈值
    if (accuracy < 0.55) {
      // RSI阈值调整
      const overboughtCorrect = verified.filter(r =>
        r.prediction.direction === '看空' && r.actual.directionCorrect
      ).length;
      const overboughtWrong = verified.filter(r =>
        r.prediction.direction === '看空' && !r.actual.directionCorrect
      ).length;

      if (overboughtWrong > overboughtCorrect) {
        params.thresholds.overboughtRSI = Math.min(80, params.thresholds.overboughtRSI + 2);
        changes.push(`RSI超买阈值调整至${params.thresholds.overboughtRSI}`);
      }

      // 情感阈值调整
      const sentimentPositiveCorrect = verified.filter(r =>
        r.factors.sentimentScore > 0.65 && r.actual.directionCorrect
      ).length;
      const sentimentPositiveWrong = verified.filter(r =>
        r.factors.sentimentScore > 0.65 && !r.actual.directionCorrect
      ).length;

      if (sentimentPositiveWrong > sentimentPositiveCorrect) {
        params.thresholds.sentimentPositive = Math.min(0.75, params.thresholds.sentimentPositive + 0.03);
        changes.push(`情感正面阈值调整至${params.thresholds.sentimentPositive.toFixed(2)}`);
      }
    }

    // 更新版本
    params.version++;
    params.lastUpdated = Date.now();

    // 记录进化日志
    const logEntry = {
      timestamp: Date.now(),
      type: 'model_optimization',
      accuracy: accuracy.toFixed(3),
      sampleSize: verified.length,
      changes,
      oldVersion: this._modelParams.version,
      newVersion: params.version,
    };

    this._evolutionLog.push(logEntry);
    if (this._evolutionLog.length > 100) this._evolutionLog = this._evolutionLog.slice(-50);
    this._saveEvolutionLog();

    // 应用新参数
    this._modelParams = params;
    this._saveModelParams();

    return { optimized: true, accuracy, changes, newVersion: params.version };
  }

  /**
   * 计算各因子与预测正确性的相关性
   */
  _calculateFactorCorrelations(verified) {
    const correlations = {};
    const factorKeys = ['multiFactorScore', 'sentimentScore', 'capitalFlowScore', 'microstructureScore'];

    for (const key of factorKeys) {
      const values = verified.map(r => r.factors[key] || 0);
      const corrects = verified.map(r => r.actual.directionCorrect ? 1 : 0);

      // 简化皮尔逊相关
      const n = values.length;
      const meanV = values.reduce((a, b) => a + b, 0) / n;
      const meanC = corrects.reduce((a, b) => a + b, 0) / n;

      let num = 0, denV = 0, denC = 0;
      for (let i = 0; i < n; i++) {
        num += (values[i] - meanV) * (corrects[i] - meanC);
        denV += Math.pow(values[i] - meanV, 2);
        denC += Math.pow(corrects[i] - meanC, 2);
      }

      correlations[key] = denV > 0 && denC > 0 ? num / Math.sqrt(denV * denC) : 0;
    }

    return correlations;
  }

  _normalizeWeights(weights) {
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const key of Object.keys(weights)) {
        weights[key] = weights[key] / sum;
      }
    }
  }

  // ==================== 3. 用户行为学习 ====================

  /**
   * 记录用户查询行为
   */
  recordUserBehavior(code, queryType, userFeedback) {
    if (!this._initialized) return;

    if (!this._userBehavior.queries) {
      this._userBehavior = {
        queries: [],
        preferences: {},
        feedbackScores: [],
        frequentStocks: {},
        frequentQueryTypes: {},
      };
    }

    // 记录查询
    this._userBehavior.queries.push({
      code,
      queryType,
      timestamp: Date.now(),
      feedback: userFeedback || null,
    });

    // 保留最近200条
    if (this._userBehavior.queries.length > 200) {
      this._userBehavior.queries = this._userBehavior.queries.slice(-100);
    }

    // 更新偏好统计
    this._userBehavior.frequentStocks[code] = (this._userBehavior.frequentStocks[code] || 0) + 1;
    this._userBehavior.frequentQueryTypes[queryType] = (this._userBehavior.frequentQueryTypes[queryType] || 0) + 1;

    // 记录用户反馈
    if (userFeedback) {
      this._userBehavior.feedbackScores.push({
        score: userFeedback.score || 0.5,
        timestamp: Date.now(),
        code,
      });
      if (this._userBehavior.feedbackScores.length > 100) {
        this._userBehavior.feedbackScores = this._userBehavior.feedbackScores.slice(-50);
      }
    }

    this._saveUserBehavior();
  }

  /**
   * 获取用户偏好（用于个性化分析输出）
   */
  getUserPreferences() {
    if (!this._userBehavior?.queries) return null;

    const recent = this._userBehavior.queries.slice(-50);

    // 偏好的股票
    const stockFreq = {};
    recent.forEach(q => { stockFreq[q.code] = (stockFreq[q.code] || 0) + 1; });
    const preferredStocks = Object.entries(stockFreq)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([code]) => code);

    // 偏好的查询类型
    const typeFreq = {};
    recent.forEach(q => { typeFreq[q.queryType] = (typeFreq[q.queryType] || 0) + 1; });
    const preferredTypes = Object.entries(typeFreq)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([type]) => type);

    // 平均满意度
    const feedbacks = this._userBehavior.feedbackScores || [];
    const avgSatisfaction = feedbacks.length > 0
      ? feedbacks.reduce((s, f) => s + f.score, 0) / feedbacks.length
      : 0.5;

    return {
      preferredStocks,
      preferredTypes,
      avgSatisfaction,
      totalQueries: this._userBehavior.queries.length,
    };
  }

  // ==================== 4. 技能迭代更新机制 ====================

  /**
   * 检查是否需要触发进化
   */
  _checkEvolutionTrigger() {
    const triggers = [];

    // 触发条件1: 累计分析次数
    const totalAnalyzed = this._feedback.length;
    if (totalAnalyzed > 0 && totalAnalyzed % 50 === 0) {
      triggers.push({ type: 'periodic', reason: `累计分析${totalAnalyzed}次，触发定期评估` });
    }

    // 触发条件2: 预测准确率低
    const verified = this._feedback.filter(r => r.verified && r.actual?.directionCorrect != null);
    if (verified.length >= 10) {
      const recent10 = verified.slice(-10);
      const correctCount = recent10.filter(r => r.actual.directionCorrect).length;
      if (correctCount < 4) { // <40%
        triggers.push({ type: 'accuracy_low', reason: `近10次预测仅${correctCount}次正确，准确率过低` });
      }
    }

    // 触发条件3: 用户负面反馈
    const recentFeedback = (this._userBehavior?.feedbackScores || []).slice(-10);
    const negativeCount = recentFeedback.filter(f => f.score < 0.3).length;
    if (negativeCount >= 3) {
      triggers.push({ type: 'user_negative', reason: `近期${negativeCount}次负面反馈` });
    }

    // 执行进化
    for (const trigger of triggers) {
      const result = this.optimizeModelParams();
      this._evolutionLog.push({
        timestamp: Date.now(),
        type: 'evolution_triggered',
        trigger: trigger.type,
        reason: trigger.reason,
        result,
      });
      this._saveEvolutionLog();
    }
  }

  /**
   * 获取进化状态报告
   */
  getEvolutionReport() {
    const verified = this._feedback.filter(r => r.verified && r.actual?.directionCorrect != null);
    const accuracy = verified.length > 0
      ? verified.filter(r => r.actual.directionCorrect).length / verified.length
      : null;

    return {
      totalAnalyses: this._feedback.length,
      verifiedAnalyses: verified.length,
      predictionAccuracy: accuracy !== null ? (accuracy * 100).toFixed(1) + '%' : '数据不足',
      modelVersion: this._modelParams.version,
      lastOptimization: new Date(this._modelParams.lastUpdated).toISOString(),
      evolutionEvents: this._evolutionLog.length,
      userPreferences: this.getUserPreferences(),
    };
  }

  /**
   * 获取当前模型参数（供分析函数使用）
   */
  getModelParams() {
    return this._modelParams;
  }

  // ==================== 持久化 ====================

  _loadFeedback() {
    try {
      if (fs.existsSync(FEEDBACK_FILE)) {
        this._feedback = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
      }
    } catch (e) { this._feedback = []; }
  }

  _saveFeedback() {
    try { fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(this._feedback, null, 2)); } catch (e) {
      /* ignore */
      console.warn('[stock-skill-evolution.js] 空 catch 补日志:', e && e.message);
    }

  }

  _loadModelParams() {
    try {
      if (fs.existsSync(MODEL_PARAMS_FILE)) {
        this._modelParams = JSON.parse(fs.readFileSync(MODEL_PARAMS_FILE, 'utf-8'));
      } else {
        this._modelParams = JSON.parse(JSON.stringify(DEFAULT_MODEL_PARAMS));
      }
    } catch (e) {
      this._modelParams = JSON.parse(JSON.stringify(DEFAULT_MODEL_PARAMS));
    }
  }

  _saveModelParams() {
    try { fs.writeFileSync(MODEL_PARAMS_FILE, JSON.stringify(this._modelParams, null, 2)); } catch (e) {
      /* ignore */
      console.warn('[stock-skill-evolution.js] 空 catch 补日志:', e && e.message);
    }

  }

  _loadUserBehavior() {
    try {
      if (fs.existsSync(USER_BEHAVIOR_FILE)) {
        this._userBehavior = JSON.parse(fs.readFileSync(USER_BEHAVIOR_FILE, 'utf-8'));
      } else {
        this._userBehavior = { queries: [], preferences: {}, feedbackScores: [], frequentStocks: {}, frequentQueryTypes: {} };
      }
    } catch (e) {
      this._userBehavior = { queries: [], preferences: {}, feedbackScores: [], frequentStocks: {}, frequentQueryTypes: {} };
    }
  }

  _saveUserBehavior() {
    try { fs.writeFileSync(USER_BEHAVIOR_FILE, JSON.stringify(this._userBehavior, null, 2)); } catch (e) {
      /* ignore */
      console.warn('[stock-skill-evolution.js] 空 catch 补日志:', e && e.message);
    }

  }

  _loadEvolutionLog() {
    try {
      if (fs.existsSync(EVOLUTION_LOG_FILE)) {
        this._evolutionLog = JSON.parse(fs.readFileSync(EVOLUTION_LOG_FILE, 'utf-8'));
      }
    } catch (e) { this._evolutionLog = []; }
  }

  _saveEvolutionLog() {
    try { fs.writeFileSync(EVOLUTION_LOG_FILE, JSON.stringify(this._evolutionLog, null, 2)); } catch (e) {
      /* ignore */
      console.warn('[stock-skill-evolution.js] 空 catch 补日志:', e && e.message);
    }

  }
}

// 单例
let _instance = null;

function getStockSkillEvolution() {
  if (!_instance) {
    _instance = new StockSkillEvolution();
    _instance.initialize();
  }
  return _instance;
}

module.exports = { StockSkillEvolution, getStockSkillEvolution, DEFAULT_MODEL_PARAMS };
