const crypto = require('crypto');
/**
 * Evolution Validator — 进化验证器
 *
 * 为 CrabPaw 进化体系提供自动化验证：
 * - 进化前捕获基线指标
 * - 进化后运行测试用例
 * - 对比指标评估改进
 * - 不达标自动触发回滚
 *
 * 验证流程：
 *   1. captureBaseline() → 记录进化前指标
 *   2. evolve() → 执行进化
 *   3. validate() → 验证进化效果
 *   4. 不达标 → 触发回滚
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');
const { getRollbackManager } = require('./rollback-manager');

const VALIDATION_DIR = path.join(DATA_DIR, 'validation');
const BASELINE_FILE = path.join(VALIDATION_DIR, 'baselines.json');
const TEST_CASES_FILE = path.join(VALIDATION_DIR, 'test-cases.json');
const VALIDATION_HISTORY_FILE = path.join(VALIDATION_DIR, 'history.json');

const DEFAULT_CONFIG = {
  validationThreshold: 0.8,      // 测试通过率阈值
  maxDegradation: 0.1,           // 允许的最大退化（10%）
  minObservations: 5,            // 最小观测次数
  metricsWindow: 100,            // 指标窗口大小
  autoRollback: true,            // 自动回滚
};

/**
 * 验证结果
 */
class ValidationResult {
  constructor(data = {}) {
    this.valid = data.valid ?? false;
    this.skillName = data.skillName || '';
    this.evolutionId = data.evolutionId || '';
    this.testPassRate = data.testPassRate ?? 0;
    this.comparison = data.comparison || {};
    this.action = data.action || 'none'; // accept / rollback / pending
    this.reason = data.reason || '';
    this.timestamp = Date.now();
    this.details = data.details || {};
  }

  toJSON() {
    return {
      valid: this.valid,
      skillName: this.skillName,
      evolutionId: this.evolutionId,
      testPassRate: this.testPassRate,
      comparison: this.comparison,
      action: this.action,
      reason: this.reason,
      timestamp: this.timestamp,
      details: this.details,
    };
  }
}

/**
 * 测试用例
 */
class TestCase {
  constructor(data = {}) {
    this.id = data.id || `tc_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.skillName = data.skillName || '';
    this.name = data.name || '';
    this.input = data.input || {};
    this.expected = data.expected || {};
    this.validateFn = data.validateFn || null; // 自定义验证函数
    this.priority = data.priority || 'medium'; // critical/high/medium/low
    this.enabled = data.enabled ?? true;
    this.tags = data.tags || [];
  }
}

/**
 * 进化验证器
 */
class EvolutionValidator extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    // 存储
    this._baselines = new Map(); // skillName → BaselineMetrics
    this._testCases = new Map(); // skillName → TestCase[]
    this._history = [];          // ValidationResult[]

    // 依赖
    this._qualityTracker = config.qualityTracker || null;
    this._versionStore = config.versionStore || null;
    this._skillExecutor = config.skillExecutor || null;
    this._rollbackManager = config.rollbackManager || null;

    this._initialized = false;
  }

  /**
   * 初始化
   */
  initialize() {
    if (this._initialized) return;

    // 确保目录存在
    if (!fs.existsSync(VALIDATION_DIR)) {
      fs.mkdirSync(VALIDATION_DIR, { recursive: true });
    }

    // 加载数据
    this._loadBaselines();
    this._loadTestCases();
    this._loadHistory();

    this._initialized = true;
    this.emit('initialized');

    console.log(`[EvolutionValidator] 初始化完成, ${this._baselines.size} 个基线, ${this._testCases.size} 个技能测试用例`);
  }

  /**
   * 注入依赖
   */
  setQualityTracker(tracker) {
    this._qualityTracker = tracker;
  }

  setVersionStore(store) {
    this._versionStore = store;
  }

  setSkillExecutor(executor) {
    this._skillExecutor = executor;
  }

  setRollbackManager(manager) {
    this._rollbackManager = manager;
  }

  // ========== 基线管理 ==========

  /**
   * 捕获进化前基线指标
   */
  async captureBaseline(skillName, context = {}) {
    const metrics = await this._collectMetrics(skillName, context);

    const baseline = {
      skillName,
      metrics,
      capturedAt: Date.now(),
      context: {
        evolutionType: context.evolutionType || 'unknown',
        triggerSource: context.triggerSource || 'manual',
      },
    };

    this._baselines.set(skillName, baseline);
    this._saveBaselines();

    this.emit('baseline:captured', { skillName, metrics });

    console.log(`[EvolutionValidator] 捕获基线: ${skillName}, 成功率=${(metrics.successRate * 100).toFixed(1)}%`);

    return baseline;
  }

  /**
   * 获取基线
   */
  getBaseline(skillName) {
    return this._baselines.get(skillName);
  }

  /**
   * 收集当前指标
   */
  async _collectMetrics(skillName, context = {}) {
    // 从质量追踪器获取
    if (this._qualityTracker) {
      const stats = this._qualityTracker.getSkillStats(skillName);
      if (stats && stats.totalCalls > 0) {
        return {
          successRate: stats.successCount / stats.totalCalls,
          errorRate: (stats.totalCalls - stats.successCount) / stats.totalCalls,
          avgLatency: stats.totalExecutionTimeMs / stats.totalCalls,
          totalCalls: stats.totalCalls,
          recentExecutions: stats.recentExecutions || [],
          collectedAt: Date.now(),
        };
      }
    }

    // 降级：从上下文获取
    return {
      successRate: context.successRate ?? 0.5,
      errorRate: context.errorRate ?? 0.5,
      avgLatency: context.avgLatency ?? 1000,
      totalCalls: context.totalCalls ?? 0,
      recentExecutions: [],
      collectedAt: Date.now(),
    };
  }

  // ========== 测试用例管理 ==========

  /**
   * 添加测试用例
   */
  addTestCase(testCase) {
    const tc = testCase instanceof TestCase ? testCase : new TestCase(testCase);
    const skillName = tc.skillName;

    if (!this._testCases.has(skillName)) {
      this._testCases.set(skillName, []);
    }

    this._testCases.get(skillName).push(tc);
    this._saveTestCases();

    this.emit('testcase:added', { skillName, testCase: tc });

    return tc;
  }

  /**
   * 获取测试用例
   */
  getTestCases(skillName) {
    return this._testCases.get(skillName) || [];
  }

  /**
   * 移除测试用例
   */
  removeTestCase(skillName, testCaseId) {
    const cases = this._testCases.get(skillName);
    if (cases) {
      const index = cases.findIndex(tc => tc.id === testCaseId);
      if (index >= 0) {
        cases.splice(index, 1);
        this._saveTestCases();
        return true;
      }
    }
    return false;
  }

  // ========== 验证流程 ==========

  /**
   * 验证进化效果（核心入口）
   */
  // eslint-disable-next-line no-unused-vars
  async validate(skillName, evolutionRecord, options = {}) {
    if (!this._initialized) {
      this.initialize();
    }

    const baseline = this._baselines.get(skillName);

    // 无基线时跳过验证
    if (!baseline) {
      console.log(`[EvolutionValidator] ${skillName} 无基线，跳过验证`);
      return new ValidationResult({
        valid: true,
        skillName,
        evolutionId: evolutionRecord.id,
        action: 'accept',
        reason: 'no_baseline',
      });
    }

    console.log(`[EvolutionValidator] 开始验证: ${skillName}`);

    // 1. 运行测试用例
    const testResults = await this._runTestCases(skillName);
    const testPassRate = testResults.length > 0
      ? testResults.filter(r => r.passed).length / testResults.length
      : 1; // 无测试用例时默认通过

    // 2. 收集新指标
    const newMetrics = await this._collectMetrics(skillName);

    // 3. 对比评估
    const comparison = this._compareMetrics(baseline.metrics, newMetrics);

    // 4. 判断是否有效
    const isValid = this._evaluateValidation(testPassRate, comparison);

    // 5. 构建结果
    const result = new ValidationResult({
      valid: isValid,
      skillName,
      evolutionId: evolutionRecord.id,
      testPassRate,
      comparison,
      action: isValid ? 'accept' : 'rollback',
      reason: isValid ? 'validation_passed' : this._getFailureReason(testPassRate, comparison),
      details: {
        baselineMetrics: baseline.metrics,
        newMetrics,
        testResults: testResults.map(r => ({
          testCaseId: r.testCaseId,
          passed: r.passed,
          error: r.error,
        })),
      },
    });

    // 6. 记录历史
    this._history.push(result.toJSON());
    this._trimHistory();
    this._saveHistory();

    // 7. 自动回滚
    if (!isValid && this.config.autoRollback) {
      console.log(`[EvolutionValidator] ${skillName} 验证失败，触发回滚`);

      // 使用 RollbackManager 执行回滚（优先），降级到 rollbackManager 接口
      const rollbackMgr = this._rollbackManager || getRollbackManager();
      if (rollbackMgr && typeof rollbackMgr.rollback === 'function') {
        try {
          await rollbackMgr.rollback(skillName, evolutionRecord, result);
        } catch (e) {
          console.error(`[EvolutionValidator] RollbackManager 回滚失败:`, e.message);
        }
      }

      this.emit('validation:rollback', { skillName, evolutionRecord, result });
    }

    this.emit('validation:complete', { skillName, result });

    console.log(
      `[EvolutionValidator] 验证完成: ${skillName}, ` +
      `valid=${isValid}, testPassRate=${(testPassRate * 100).toFixed(1)}%, ` +
      `successRateChange=${(comparison.successRateChange * 100).toFixed(1)}%`
    );

    return result;
  }

  /**
   * 运行测试用例
   */
  async _runTestCases(skillName) {
    const testCases = this.getTestCases(skillName).filter(tc => tc.enabled);
    const results = [];

    for (const tc of testCases) {
      try {
        // 执行技能
        const output = await this._executeSkill(skillName, tc.input);

        // 验证输出
        let passed;
        if (tc.validateFn && typeof tc.validateFn === 'function') {
          passed = tc.validateFn(output, tc.expected);
        } else {
          passed = this._defaultValidate(output, tc.expected);
        }

        results.push({
          testCaseId: tc.id,
          passed,
          output,
        });
      } catch (e) {
        results.push({
          testCaseId: tc.id,
          passed: false,
          error: e.message,
        });
      }
    }

    return results;
  }

  /**
   * 执行技能
   */
  async _executeSkill(skillName, input) {
    if (this._skillExecutor) {
      return await this._skillExecutor.execute(skillName, input);
    }

    // 降级：返回模拟结果
    console.warn(`[EvolutionValidator] 无 skillExecutor，返回模拟结果`);
    return { success: true, output: 'mock' };
  }

  /**
   * 默认验证逻辑
   */
  _defaultValidate(output, expected) {
    // 简单的深度比较
    if (expected.success !== undefined && output.success !== expected.success) {
      return false;
    }

    if (expected.contains && typeof output === 'string') {
      return output.includes(expected.contains);
    }

    if (expected.matches && typeof output === 'string') {
      return new RegExp(expected.matches).test(output);
    }

    return true;
  }

  /**
   * 对比指标
   */
  _compareMetrics(baseline, current) {
    const successRateChange = current.successRate - baseline.successRate;
    const latencyChange = baseline.avgLatency > 0
      ? (current.avgLatency - baseline.avgLatency) / baseline.avgLatency
      : 0;
    const errorRateChange = current.errorRate - baseline.errorRate;

    // 综合评分（加权）
    const overallChange = (
      0.5 * successRateChange +
      0.2 * (-latencyChange) + // 延迟降低是正向
      0.3 * (-errorRateChange) // 错误率降低是正向
    );

    return {
      successRateChange,
      latencyChange,
      errorRateChange,
      overallChange,
      baselineSuccessRate: baseline.successRate,
      currentSuccessRate: current.successRate,
      baselineLatency: baseline.avgLatency,
      currentLatency: current.avgLatency,
    };
  }

  /**
   * 评估验证结果
   */
  _evaluateValidation(testPassRate, comparison) {
    // 测试通过率不达标
    if (testPassRate < this.config.validationThreshold) {
      return false;
    }

    // 退化超过阈值
    if (comparison.overallChange < -this.config.maxDegradation) {
      return false;
    }

    // 成功率严重下降
    if (comparison.successRateChange < -0.2) {
      return false;
    }

    return true;
  }

  /**
   * 获取失败原因
   */
  _getFailureReason(testPassRate, comparison) {
    if (testPassRate < this.config.validationThreshold) {
      return `test_pass_rate_too_low: ${(testPassRate * 100).toFixed(1)}%`;
    }

    if (comparison.overallChange < -this.config.maxDegradation) {
      return `overall_degradation: ${(comparison.overallChange * 100).toFixed(1)}%`;
    }

    if (comparison.successRateChange < -0.2) {
      return `success_rate_dropped: ${(comparison.successRateChange * 100).toFixed(1)}%`;
    }

    return 'unknown';
  }

  // ========== 报告生成 ==========

  /**
   * 生成验证报告
   */
  generateReport(options = {}) {
    const filtered = this._history.filter(h => {
      if (options.since && h.timestamp < options.since) return false;
      if (options.skillName && h.skillName !== options.skillName) return false;
      return true;
    });

    const total = filtered.length;
    const passed = filtered.filter(h => h.valid).length;
    const rolledBack = filtered.filter(h => h.action === 'rollback').length;

    return {
      summary: {
        total,
        passed,
        failed: total - passed,
        rolledBack,
        passRate: total > 0 ? passed / total : 0,
      },
      bySkill: this._groupBySkill(filtered),
      recentValidations: filtered.slice(-20),
      worstRegressions: filtered
        .filter(h => h.comparison?.overallChange < 0)
        .sort((a, b) => a.comparison.overallChange - b.comparison.overallChange)
        .slice(0, 10),
    };
  }

  _groupBySkill(history) {
    const grouped = {};
    for (const h of history) {
      if (!grouped[h.skillName]) {
        grouped[h.skillName] = { total: 0, passed: 0, rolledBack: 0 };
      }
      grouped[h.skillName].total++;
      if (h.valid) grouped[h.skillName].passed++;
      if (h.action === 'rollback') grouped[h.skillName].rolledBack++;
    }
    return grouped;
  }

  // ========== 持久化 ==========

  _loadBaselines() {
    if (fs.existsSync(BASELINE_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this._baselines.set(k, v);
        }
      } catch (e) {
        console.error('[EvolutionValidator] 加载基线失败:', e.message);
      }
    }
  }

  _saveBaselines() {
    const data = Object.fromEntries(this._baselines);
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
  }

  _loadTestCases() {
    if (fs.existsSync(TEST_CASES_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(TEST_CASES_FILE, 'utf-8'));
        for (const [skillName, cases] of Object.entries(data)) {
          this._testCases.set(skillName, cases.map(c => new TestCase(c)));
        }
      } catch (e) {
        console.error('[EvolutionValidator] 加载测试用例失败:', e.message);
      }
    }
  }

  _saveTestCases() {
    const data = {};
    for (const [skillName, cases] of this._testCases) {
      data[skillName] = cases.map(c => ({
        id: c.id,
        skillName: c.skillName,
        name: c.name,
        input: c.input,
        expected: c.expected,
        priority: c.priority,
        enabled: c.enabled,
        tags: c.tags,
      }));
    }
    fs.writeFileSync(TEST_CASES_FILE, JSON.stringify(data, null, 2));
  }

  _loadHistory() {
    if (fs.existsSync(VALIDATION_HISTORY_FILE)) {
      try {
        this._history = JSON.parse(fs.readFileSync(VALIDATION_HISTORY_FILE, 'utf-8'));
      } catch (e) {
        console.error('[EvolutionValidator] 加载历史失败:', e.message);
      }
    }
  }

  _saveHistory() {
    fs.writeFileSync(VALIDATION_HISTORY_FILE, JSON.stringify(this._history.slice(-500), null, 2));
  }

  _trimHistory() {
    if (this._history.length > 500) {
      this._history = this._history.slice(-500);
    }
  }
}

// ========== 单例 ==========

let _instance = null;

function getEvolutionValidator(config = {}) {
  if (!_instance) {
    _instance = new EvolutionValidator(config);
  }
  return _instance;
}

module.exports = {
  EvolutionValidator,
  ValidationResult,
  TestCase,
  getEvolutionValidator,
  VALIDATION_DIR,
};
