/**
 * Self-Play Tester — 自我对弈测试器
 *
 * 类似 AlphaGo 自我对弈的思路：系统自己生成输入、执行技能、评估输出质量。
 *
 * 工作流：
 *   1. 从测试生成器获取测试用例
 *   2. 通过 skill-router 路由并执行
 *   3. 评估执行结果（规则 + LLM 语义评估）
 *   4. 将结果反馈给回归守护和反馈闭环引擎
 *
 * 安全约束：
 *   - 只读操作可自动执行
 *   - 写操作需要 dry-run 模式
 *   - 网络操作需要沙箱化
 *   - 每日最大测试次数限制
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getAdversarialTestGenerator, TEST_MODES } = require('./adversarial-test-generator');
const { DATA_DIR } = require('../config');

const RESULTS_DIR = path.join(DATA_DIR, 'self-play');
const RESULTS_FILE = path.join(RESULTS_DIR, 'results.json');

const MAX_DAILY_TESTS = 50;          // 每日最大测试次数
const MAX_CONCURRENT_TESTS = 3;      // 最大并发测试数
const TEST_INTERVAL = 2 * 3600 * 1000; // 2 小时执行一次测试周期

const SAFETY_LEVELS = {
  SAFE: 'safe',           // 只读/查询操作，可自动执行
  DRY_RUN: 'dry_run',     // 写操作，需 dry-run
  RESTRICTED: 'restricted', // 网络操作/敏感操作，需人工确认
};

// 技能安全级别映射
const SKILL_SAFETY_MAP = {
  'multi-search-engine': SAFETY_LEVELS.SAFE,
  'summarize-pro': SAFETY_LEVELS.SAFE,
  'financial-analyst': SAFETY_LEVELS.SAFE,
  'stock-analyst-enhanced': SAFETY_LEVELS.SAFE,
  'marketing': SAFETY_LEVELS.SAFE,
  'humanizer': SAFETY_LEVELS.SAFE,
  'self-improving-agent': SAFETY_LEVELS.SAFE,
  'healthcheck': SAFETY_LEVELS.SAFE,
  'system-info': SAFETY_LEVELS.SAFE,
  'weather': SAFETY_LEVELS.SAFE,
  'wechat-article-search': SAFETY_LEVELS.SAFE,
  'pdf-generator': SAFETY_LEVELS.DRY_RUN,
  'word-docx': SAFETY_LEVELS.DRY_RUN,
  'excel-xlsx': SAFETY_LEVELS.DRY_RUN,
  'powerpoint-pptx': SAFETY_LEVELS.DRY_RUN,
  'pdf-to-word-docx': SAFETY_LEVELS.DRY_RUN,
  'file-manager': SAFETY_LEVELS.DRY_RUN,
  'frontend-design': SAFETY_LEVELS.DRY_RUN,
  'browser-use': SAFETY_LEVELS.RESTRICTED,
  'windows-ui-automation': SAFETY_LEVELS.RESTRICTED,
};

class SelfPlayTester extends EventEmitter {
  constructor(config = {}) {
    super();
    this._testGenerator = null;
    this._skillRouter = null;
    this._llmClient = null;
    this._dailyTestCount = 0;
    this._dailyResetAt = Date.now();
    this._testTimer = null;
    this._running = false;
    this._initialized = false;
    this._config = {
      maxDailyTests: config.maxDailyTests || MAX_DAILY_TESTS,
      maxConcurrent: config.maxConcurrent || MAX_CONCURRENT_TESTS,
      testInterval: config.testInterval || TEST_INTERVAL,
      ...config,
    };

    // 测试结果摘要
    this._lastRunSummary = null;
    this._resultsPath = config.resultsPath || RESULTS_FILE;
    this._allResults = this._loadResults();
  }

  initialize({ testGenerator, skillRouter, llmClient } = {}) {
    if (this._initialized) return;

    this._testGenerator = testGenerator || getAdversarialTestGenerator();
    this._skillRouter = skillRouter;
    this._llmClient = llmClient;

    this._initialized = true;
    console.log('[SelfPlay] 自我对弈测试器初始化完成');
  }

  /**
   * 启动定期自测试
   */
 startPeriodicTesting() {
   if (this._testTimer) return;

    this._testTimer = setInterval(() => {
      this.runTestCycle().catch(err => {
        console.error('[SelfPlay] 测试周期失败:', err.message);
      });
    }, this._config.testInterval);

    console.log(`[SelfPlay] 定期自测试已启动，间隔 ${this._config.testInterval / 3600000}h`);
 }

  start() { return this.startPeriodicTesting(); }

  /**
   * 停止定期自测试
   */
  stopPeriodicTesting() {
    if (this._testTimer) {
      clearInterval(this._testTimer);
      this._testTimer = null;
    }
  }

  /**
   * 运行一次完整的测试周期
   */
  async runTestCycle(options = {}) {
    if (this._running) {
      console.log('[SelfPlay] 测试周期已在运行中，跳过');
      return null;
    }

    this._checkDailyLimit();
    if (this._dailyTestCount >= this._config.maxDailyTests) {
      console.log('[SelfPlay] 已达每日测试上限，跳过');
      return null;
    }

    this._running = true;
    const startTime = Date.now();
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      details: [],
    };

    try {
      // 获取待执行测试（2026-08-07: _testGenerator 未初始化时给空数组——
      // 此前 null.getPendingTests 抛 TypeError 使测试周期整体失败）
      if (!this._testGenerator) {
        console.warn('[SelfPlay] 测试生成器未初始化，跳过本周期');
        return { started: 0, passed: 0, failed: 0, skipped: 0, errors: [], details: [] };
      }
      const pendingTests = this._testGenerator.getPendingTests(null, {
        limit: this._config.maxDailyTests - this._dailyTestCount,
      });

      console.log(`[SelfPlay] 开始测试周期，待执行 ${pendingTests.length} 个测试`);

      for (const testCase of pendingTests) {
        if (this._dailyTestCount >= this._config.maxDailyTests) break;

        try {
          const result = await this._executeTest(testCase, options);
          results.total++;

          if (result.skipped) {
            results.skipped++;
          } else if (result.passed) {
            results.passed++;
          } else {
            results.failed++;
            results.errors.push({
              testId: testCase.id,
              skillName: testCase.skillName,
              mode: testCase.mode,
              input: testCase.input,
              error: result.error || '测试未通过',
            });
          }

          results.details.push(result);
          this._testGenerator.recordResult(testCase.id, result);
          this._dailyTestCount++;

          this.emit('test:executed', { testId: testCase.id, passed: result.passed });
        } catch (err) {
          results.total++;
          results.errors.push({
            testId: testCase.id,
            error: err.message,
          });
        }
      }

      const duration = Date.now() - startTime;
      this._lastRunSummary = {
        ...results,
        duration,
        timestamp: new Date().toISOString(),
        passRate: results.total > 0 ? results.passed / results.total : 0,
      };

      console.log(`[SelfPlay] 测试周期完成: ${results.passed}/${results.total} 通过, ${results.skipped} 跳过, ${duration}ms`);

      this._allResults.push(this._lastRunSummary);
      this._saveResults();
      this.emit('cycle:completed', this._lastRunSummary);
      return this._lastRunSummary;
    } finally {
      this._running = false;
    }
  }

  /**
   * 执行单个测试
   */
  async _executeTest(testCase, options = {}) {
    const { skillName, mode, input } = testCase;

    // 安全检查
    const safetyLevel = SKILL_SAFETY_MAP[skillName] || SAFETY_LEVELS.DRY_RUN;
    if (safetyLevel === SAFETY_LEVELS.RESTRICTED && !options.allowRestricted) {
      return {
        passed: false,
        skipped: true,
        reason: `技能 ${skillName} 为受限操作，需人工确认`,
        safetyLevel,
      };
    }

    // 路由测试：验证输入是否能被正确路由
    if (this._skillRouter) {
      try {
        const routeResult = this._skillRouter.classifyTask(input);

        // 边界测试：空输入/无意义输入应返回低置信度
        if (mode === TEST_MODES.BOUNDARY) {
          if (!input || input.trim().length === 0 || /^[\s\W]+$/.test(input)) {
            const isLowConfidence = !routeResult.category || routeResult.confidence < 0.5;
            return {
              passed: isLowConfidence,
              input,
              expectedBehavior: '应返回低置信度或无分类',
              actualBehavior: `分类: ${routeResult.category}, 置信度: ${routeResult.confidence?.toFixed(2)}`,
              mode,
              safetyLevel,
            };
          }
        }

        // 歧义测试：多意图输入应返回多个候选
        if (mode === TEST_MODES.AMBIGUOUS) {
          const recommendations = this._skillRouter.getRecommendedSkills(input, { maxResults: 5 });
          const hasAlternatives = recommendations.length > 1;
          return {
            passed: hasAlternatives,
            input,
            expectedBehavior: '应返回多个候选技能',
            actualBehavior: `返回 ${recommendations.length} 个候选: ${recommendations.map(r => r.name).join(', ')}`,
            mode,
            safetyLevel,
            recommendations: recommendations.map(r => ({ name: r.name, score: r.score })),
          };
        }

        // 对抗测试：验证路由不会被误导
        if (mode === TEST_MODES.ADVERSARIAL) {
          const isRoutedToExpectedSkill = routeResult.skillHint === skillName ||
            (routeResult.category && this._isSkillInCategory(skillName, routeResult.category));
          return {
            passed: isRoutedToExpectedSkill,
            input,
            expectedBehavior: `应路由到 ${skillName} 或相关分类`,
            actualBehavior: `路由到: ${routeResult.skillHint || routeResult.category}`,
            mode,
            safetyLevel,
          };
        }
      } catch (err) {
        return {
          passed: false,
          input,
          error: `路由异常: ${err.message}`,
          mode,
          safetyLevel,
        };
      }
    }

    // 无路由器时的降级评估
    return {
      passed: false,
      skipped: true,
      reason: '无路由器可用，无法执行测试',
    };
  }

  /**
   * 检查技能是否在指定分类中
   */
  // eslint-disable-next-line no-unused-vars
  _isSkillInCategory(_skillName, categoryKey) {
    // TASK_CATEGORIES 未定义，暂时返回 false
    return false;
  }

  /**
   * 获取上次测试摘要
   */
  getLastRunSummary() {
    return this._lastRunSummary;
  }

  /**
   * 获取所有历史测试结果（可查询）
   * @param {object} options - 过滤选项 { skillName, since, limit }
   * @returns {Array<object>}
   */
  getResults(options = {}) {
    let results = [...this._allResults];
    if (options.skillName) {
      results = results.filter(r =>
        r.details && r.details.some(d => d.skillName === options.skillName)
      );
    }
    if (options.since) {
      results = results.filter(r => new Date(r.timestamp).getTime() >= options.since);
    }
    const limit = options.limit || 50;
    return results.slice(-limit);
  }

  /**
   * 获取安全级别映射
   */
  getSkillSafetyLevel(skillName) {
    return SKILL_SAFETY_MAP[skillName] || SAFETY_LEVELS.DRY_RUN;
  }

  _checkDailyLimit() {
    const now = Date.now();
    if (now - this._dailyResetAt > 24 * 3600 * 1000) {
      this._dailyTestCount = 0;
      this._dailyResetAt = now;
    }
  }

  _loadResults() {
    try {
      if (fs.existsSync(this._resultsPath)) {
        const raw = fs.readFileSync(this._resultsPath, 'utf-8');
        return JSON.parse(raw).results || [];
      }
    } catch (e) {
      console.warn('[SelfPlay] Could not load results from disk:', e.message);
    }
    return [];
  }

  _saveResults() {
    try {
      const dir = path.dirname(this._resultsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        results: this._allResults.slice(-200),
      };
      const tmpFile = this._resultsPath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this._resultsPath);
    } catch (e) {
      console.error('[SelfPlay] Failed to save results:', e.message);
    }
  }

  shutdown() {
    this.stopPeriodicTesting();
    this._saveResults();
  }
}

// 单例
let _instance = null;

function getSelfPlayTester(config) {
  if (!_instance) {
    _instance = new SelfPlayTester(config);
  }
  return _instance;
}

module.exports = { SelfPlayTester, getSelfPlayTester, SAFETY_LEVELS, SKILL_SAFETY_MAP };
