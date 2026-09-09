const crypto = require('crypto');
/**
 * Regression Guard — 回归守护
 *
 * 在技能进化后自动运行回归测试，确保不退化。
 *
 * 核心机制：
 *   1. 基线快照：每次技能进化前，保存当前质量的基线快照
 *   2. 回归检测：进化后运行历史失败案例 + 对抗测试，对比基线
 *   3. 自动回滚：如果回归检测失败率超过阈值，自动触发回滚
 *   4. 冷却期：回滚后进入冷却期，暂停该技能的进化
 *
 * 与现有系统的集成：
 *   - feedback-loop-engine: 进化后触发回归检测
 *   - skill-version-store: 回滚时使用版本快照
 *   - rollback-manager: 协调回滚策略
 *   - adversarial-test-generator: 提供回归测试用例
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');

const GUARD_DIR = path.join(DATA_DIR, 'regression-guard');

const REGRESSION_THRESHOLD = 0.3;   // 失败率超过 30% 视为回归
const MIN_TESTS_FOR_REGRESSION = 3;  // 至少 3 个测试才能判定回归
const COOLDOWN_DURATION = 24 * 3600 * 1000; // 冷却期 24 小时
const MAX_BASELINES_PER_SKILL = 10;  // 每个技能最多保存 10 个基线

class RegressionGuard extends EventEmitter {
  constructor(config = {}) {
    super();
    this._guardDir = config.guardDir || GUARD_DIR;
    this._baselines = new Map();    // skillName → [baseline]
    this._history = [];             // 回归检测历史
    this._cooldowns = new Map();    // skillName → cooldownExpiry
    this._versionStore = null;
    this._testGenerator = null;
    this._initialized = false;
    this._config = {
      regressionThreshold: config.regressionThreshold || REGRESSION_THRESHOLD,
      minTestsForRegression: config.minTestsForRegression || MIN_TESTS_FOR_REGRESSION,
      cooldownDuration: config.cooldownDuration || COOLDOWN_DURATION,
      ...config,
    };
  }

  initialize({ versionStore, testGenerator } = {}) {
    if (this._initialized) return;

    this._versionStore = versionStore;
    this._testGenerator = testGenerator;

    if (!fs.existsSync(this._guardDir)) {
      fs.mkdirSync(this._guardDir, { recursive: true });
    }

    this._load();
    this._initialized = true;

    console.log('[RegressionGuard] 回归守护初始化完成', {
      baselines: this._baselines.size,
      cooldowns: this._cooldowns.size,
    });
  }

  /**
   * 保存基线快照（在技能进化前调用）
   * @param {string} skillName - 技能名
   * @param {object} metrics - 当前质量指标
   */
  saveBaseline(skillName, metrics) {
    if (!this._initialized) return;

    const baseline = {
      id: `bl-${Date.now()}-${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      skillName,
      metrics: {
        successRate: metrics.successRate || 0,
        avgDuration: metrics.avgDuration || 0,
        qualityScore: metrics.qualityScore || 0,
        totalCalls: metrics.totalCalls || 0,
        ...metrics,
      },
      timestamp: new Date().toISOString(),
      versionHash: metrics.versionHash || null,
    };

    if (!this._baselines.has(skillName)) {
      this._baselines.set(skillName, []);
    }

    const baselines = this._baselines.get(skillName);
    baselines.push(baseline);

    // 保留最近 N 个基线
    if (baselines.length > MAX_BASELINES_PER_SKILL) {
      baselines.splice(0, baselines.length - MAX_BASELINES_PER_SKILL);
    }

    this._save();
    this.emit('baseline:saved', { skillName, baselineId: baseline.id });
    console.log(`[RegressionGuard] 基线已保存: ${skillName}`, baseline.metrics);
  }

  /**
   * 运行回归检测（在技能进化后调用）
   * @param {string} skillName - 技能名
   * @param {object} newMetrics - 进化后的质量指标
   * @param {object} options - 选项
   * @returns {RegressionResult}
   */
  async checkRegression(skillName, newMetrics, options = {}) {
    if (!this._initialized) return { regressed: false, reason: '未初始化' };

    // 检查冷却期
    if (this.isInCooldown(skillName)) {
      return {
        regressed: false,
        skipped: true,
        reason: `技能 ${skillName} 在冷却期内`,
        cooldownExpiry: this._cooldowns.get(skillName),
      };
    }

    const baselines = this._baselines.get(skillName);
    if (!baselines || baselines.length === 0) {
      // 无基线，无法判定回归
      return { regressed: false, reason: '无基线数据' };
    }

    const latestBaseline = baselines[baselines.length - 1];
    const result = this._compareWithBaseline(skillName, newMetrics, latestBaseline);

    // 记录检测历史
    this._history.push({
      skillName,
      baselineId: latestBaseline.id,
      newMetrics,
      baselineMetrics: latestBaseline.metrics,
      result,
      timestamp: new Date().toISOString(),
    });

    // 保留最近 200 条历史
    if (this._history.length > 200) {
      this._history = this._history.slice(-200);
    }

    // 如果检测到回归
    if (result.regressed) {
      console.warn(`[RegressionGuard] 检测到回归: ${skillName}`, result);
      this.emit('regression:detected', { skillName, result });

      // 自动回滚
      if (options.autoRollback !== false && this._versionStore) {
        await this._autoRollback(skillName, result);
      }

      // 进入冷却期
      this._enterCooldown(skillName);
    }

    this._save();
    return result;
  }

  /**
   * 比较新指标与基线
   */
  _compareWithBaseline(skillName, newMetrics, baseline) {
    const regressions = [];
    const improvements = [];

    // 成功率对比
    const baselineRate = baseline.metrics.successRate || 0;
    const newRate = newMetrics.successRate || 0;
    const rateDelta = newRate - baselineRate;
    if (rateDelta < -0.1) { // 成功率下降超过 10%
      regressions.push({
        metric: 'successRate',
        baseline: baselineRate,
        current: newRate,
        delta: rateDelta,
        severity: Math.abs(rateDelta) > 0.3 ? 'high' : 'medium',
      });
    } else if (rateDelta > 0.05) {
      improvements.push({ metric: 'successRate', delta: rateDelta });
    }

    // 质量分数对比
    const baselineQuality = baseline.metrics.qualityScore || 0;
    const newQuality = newMetrics.qualityScore || 0;
    const qualityDelta = newQuality - baselineQuality;
    if (qualityDelta < -0.15) {
      regressions.push({
        metric: 'qualityScore',
        baseline: baselineQuality,
        current: newQuality,
        delta: qualityDelta,
        severity: Math.abs(qualityDelta) > 0.3 ? 'high' : 'medium',
      });
    } else if (qualityDelta > 0.1) {
      improvements.push({ metric: 'qualityScore', delta: qualityDelta });
    }

    // 执行时间对比（退化 = 变慢超过 50%）
    const baselineDuration = baseline.metrics.avgDuration || 0;
    const newDuration = newMetrics.avgDuration || 0;
    if (baselineDuration > 0 && newDuration > baselineDuration * 1.5) {
      regressions.push({
        metric: 'avgDuration',
        baseline: baselineDuration,
        current: newDuration,
        delta: newDuration - baselineDuration,
        severity: newDuration > baselineDuration * 2 ? 'high' : 'low',
      });
    }

    const regressed = regressions.length > 0;
    const highSeverityCount = regressions.filter(r => r.severity === 'high').length;

    return {
      regressed,
      regressions,
      improvements,
      severity: highSeverityCount > 0 ? 'high' : regressed ? 'medium' : 'none',
      summary: regressed
        ? `${regressions.length} 个指标退化: ${regressions.map(r => `${r.metric}(${r.delta.toFixed(2)})`).join(', ')}`
        : improvements.length > 0
          ? `${improvements.length} 个指标改善`
          : '无显著变化',
    };
  }

  /**
   * 自动回滚
   */
  async _autoRollback(skillName, regressionResult) {
    if (regressionResult.severity !== 'high') {
      console.log(`[RegressionGuard] 退化严重度非 high，跳过自动回滚: ${skillName}`);
      return;
    }

    try {
      if (this._versionStore && typeof this._versionStore.rollback === 'function') {
        const rolledBack = await this._versionStore.rollback(skillName);
        if (rolledBack) {
          this.emit('regression:rolled_back', { skillName, reason: regressionResult.summary });
          console.log(`[RegressionGuard] 已自动回滚: ${skillName}`);
        }
      }
    } catch (err) {
      console.error(`[RegressionGuard] 自动回滚失败: ${skillName}`, err.message);
    }
  }

  /**
   * 进入冷却期
   */
  _enterCooldown(skillName) {
    const expiry = Date.now() + this._config.cooldownDuration;
    this._cooldowns.set(skillName, expiry);
    this.emit('cooldown:entered', { skillName, expiry });
    console.log(`[RegressionGuard] 进入冷却期: ${skillName}, ${this._config.cooldownDuration / 3600000}h`);
  }

  /**
   * 检查是否在冷却期
   */
  isInCooldown(skillName) {
    const expiry = this._cooldowns.get(skillName);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this._cooldowns.delete(skillName);
      return false;
    }
    return true;
  }

  /**
   * 获取技能的基线历史
   */
  getBaselines(skillName) {
    return this._baselines.get(skillName) || [];
  }

  /**
   * 获取回归检测历史
   */
  getHistory(skillName, limit = 20) {
    const filtered = skillName
      ? this._history.filter(h => h.skillName === skillName)
      : this._history;
    return filtered.slice(-limit);
  }

  /**
   * 获取守护统计
   */
  getStats() {
    return {
      skillsWithBaselines: this._baselines.size,
      totalBaselines: [...this._baselines.values()].reduce((sum, arr) => sum + arr.length, 0),
      totalChecks: this._history.length,
      regressionsDetected: this._history.filter(h => h.result?.regressed).length,
      activeCooldowns: [...this._cooldowns.entries()].filter(([_, exp]) => Date.now() < exp).length,
    };
  }

  _load() {
    try {
      const baselinesFile = path.join(this._guardDir, 'baselines.json');
      if (fs.existsSync(baselinesFile)) {
        const data = JSON.parse(fs.readFileSync(baselinesFile, 'utf-8'));
        for (const [k, v] of Object.entries(data.baselines || {})) {
          this._baselines.set(k, v);
        }
      }

      const historyFile = path.join(this._guardDir, 'history.json');
      if (fs.existsSync(historyFile)) {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        this._history = data.history || [];
      }
    } catch (e) { console.warn('[regression-guard] no history data (first run):', e.message); }
  }

  _save() {
    try {
      if (!fs.existsSync(this._guardDir)) {
        fs.mkdirSync(this._guardDir, { recursive: true });
      }

      const baselinesData = {
        version: 1,
        updatedAt: new Date().toISOString(),
        baselines: Object.fromEntries(this._baselines),
      };
      const tmpBl = path.join(this._guardDir, 'baselines.json.tmp');
      fs.writeFileSync(tmpBl, JSON.stringify(baselinesData, null, 2), 'utf-8');
      fs.renameSync(tmpBl, path.join(this._guardDir, 'baselines.json'));

      const historyData = {
        version: 1,
        updatedAt: new Date().toISOString(),
        history: this._history.slice(-200),
      };
      const tmpHist = path.join(this._guardDir, 'history.json.tmp');
      fs.writeFileSync(tmpHist, JSON.stringify(historyData, null, 2), 'utf-8');
      fs.renameSync(tmpHist, path.join(this._guardDir, 'history.json'));
    } catch (err) {
      console.error('[RegressionGuard] 保存失败:', err.message);
    }
  }

 shutdown() {
     this._save();
   }
  
    start() { return this; }
 }
 
 // 单例
let _instance = null;

function getRegressionGuard(config) {
  if (!_instance) {
    _instance = new RegressionGuard(config);
  }
  return _instance;
}

module.exports = { RegressionGuard, getRegressionGuard, REGRESSION_THRESHOLD };
