/**
 * Eval Runner — automated evaluation framework for CrabPaw Harness
 *
 * Based on OpenHarness Feature Matrix: tool contracts, hooks, task mode, loop detection.
 * Enhanced with tag system: P0/P1/P2/P3 priority + capability/scope/severity tags
 * + weighted scoring + tag-based filtering.
 */

const { TAGS, withDefaultTags, summaryByTags, weightedScore } = require('./tag-system');

class EvalRunner {
  constructor(options = {}) {
    this.suites = [];
    this.results = [];
    this.tagFilter = options.tagFilter || null;   // ['P0'] etc.
    // 2026-08-31 Eval 隔离轮 Task 3: 套件级排除（precommit 快速档用）。
    this.excludeSuites = new Set(options.excludeSuites || []);
  }

  registerSuite(suite) { this.suites.push(suite); }

  setTagFilter(tags) { this.tagFilter = tags || null; }

  setExcludeSuites(names) { this.excludeSuites = new Set(names || []); }

  /** 应用套件排除后的待执行套件清单（排除时打印名单，静默排除禁止） */
  _activeSuites() {
    if (this.excludeSuites.size === 0) return this.suites;
    const active = this.suites.filter(s => !this.excludeSuites.has(s.name));
    const skipped = this.suites.filter(s => this.excludeSuites.has(s.name));
    if (skipped.length > 0) {
      console.log('--- 排除套件(' + skipped.length + '): ' + skipped.map(s => s.name).join(', ') + ' ---');
    }
    return active;
  }

  async runAll(options = {}) {
    const { parallel = false, concurrency = 4 } = options;
    if (!parallel) return this._runSequential();
    return this._runParallel(concurrency);
  }

  /** 串行执行（默认） */
  async _runSequential() {
    const totalStart = Date.now();
    for (const suite of this._activeSuites()) {
      console.log('\n=== Suite: ' + suite.name + ' ===');
      const cases = this._filterCases(suite.cases);
      for (const tc of cases) {
        const result = await this._runCase(suite.name, tc);
        this.results.push(result);
      }
    }
    return this._generateReport(Date.now() - totalStart);
  }

  /** 可选并行执行 */
  async _runParallel(concurrency) {
    const totalStart = Date.now();
    const allCases = [];
    for (const suite of this._activeSuites()) {
      const cases = this._filterCases(suite.cases);
      for (const tc of cases) {
        allCases.push({ suiteName: suite.name, tc });
      }
    }

    // 按并发度分块执行
    for (let i = 0; i < allCases.length; i += concurrency) {
      const chunk = allCases.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(({ suiteName, tc }) => this._runCase(suiteName, tc))
      );
      this.results.push(...results);
    }
    return this._generateReport(Date.now() - totalStart);
  }

  _filterCases(cases) {
    if (!this.tagFilter || this.tagFilter.length === 0) return cases;
    const { matchesTags } = require('./tag-system');
    return cases.filter(tc => matchesTags(tc, this.tagFilter));
  }

  async _runCase(suiteName, tc) {
    const start = Date.now();
    const tagStr = (tc.tags && tc.tags.length > 0) ? ` {${tc.tags.join(',')}}` : '';
    const label = '  [' + tc.id + '] ' + tc.name + tagStr;
    // 自动补充默认 tag
    withDefaultTags(tc);
    try {
      const passed = await tc.run();
      const dur = Date.now() - start;
      console.log(label + (passed ? ' PASS' : ' FAIL') + ' (' + dur + 'ms)');
      return { suite: suiteName, id: tc.id, name: tc.name, category: tc.category, tags: tc.tags || [], passed, duration: dur };
    } catch (error) {
      const dur = Date.now() - start;
      console.log(label + ' ERROR: ' + error.message + ' (' + dur + 'ms)');
      return { suite: suiteName, id: tc.id, name: tc.name, category: tc.category, tags: tc.tags || [], passed: false, error: error.message, duration: dur };
    }
  }

  _generateReport(totalDuration) {
    const passed = this.results.filter(r => r.passed).length;
    const total = this.results.length;
    const rate = total > 0 ? (passed / total * 100).toFixed(1) : '0.0';
    const weighted = weightedScore(this.results);

    const byCategory = {};
    for (const r of this.results) {
      if (!byCategory[r.category]) byCategory[r.category] = { passed: 0, total: 0 };
      byCategory[r.category].total++;
      if (r.passed) byCategory[r.category].passed++;
    }

    const tagSummary = summaryByTags(this.results);

    const failed = this.results.filter(r => !r.passed);
    const summary = { passed, total, passRate: rate + '%', weightedScore: weighted + '%', totalDuration };

    console.log('\n=== Eval Report: ' + rate + '% (' + passed + '/' + total + ') weighted=' + weighted + '% in ' + totalDuration + 'ms ===');
    for (const [cat, stats] of Object.entries(byCategory)) {
      console.log('  ' + cat + ': ' + stats.passed + '/' + stats.total);
    }

    // Tag 汇总（按优先级排序）
    const tagOrder = ['P0', 'P1', 'P2', 'P3'];
    console.log('\n--- By Tag ---');
    for (const t of tagOrder) {
      if (tagSummary[t]) {
        const s = tagSummary[t];
        console.log('  ' + t + ': ' + s.passed + '/' + s.total + ' (' + s.passRate + '%)');
      }
    }

    if (failed.length > 0) {
      console.log('\n  FAILURES:');
      for (const f of failed) console.log('    [' + f.id + '] ' + f.name + ': ' + (f.error || 'assertion failed'));
    }

    return { summary, byCategory, tagSummary, weightedScore: weighted, failed: failed.length > 0 ? failed : undefined, results: this.results, timestamp: new Date().toISOString() };
  }
}

// 2026-08-31 Eval 隔离轮 Task 3: precommit 快速档排除名单（口径=实测裁定, 非拍脑袋）。
// EI2 数据目录隔离后全量 eval 仅 ~6.4s（52 套件/419 例）: 无套件 >10s、无真实网络 IO
// （budget-enforcer/entertainment/hooks/stock-voice/typhoon 中的 http 引用全为 mock/fixture）。
// 故名单只保留 Expert Collaboration——最慢（1.29s, 全场第一）且唯一含 elapsed 断言 +
// 250ms 级 sleep 的时序敏感套件（collab_008/009 历史上多次负载态 flaky 拦提交）。
// 其余原候选（memory-system/voice-session/embedding-pipeline）隔离后 12~309ms 且
// 零 sleep——排除它们是纯覆盖损失, 不入名单。CI 与 `npm run eval` 仍全量。
const FAST_EXCLUDE_SUITES = ['Expert Collaboration'];

module.exports = { EvalRunner, FAST_EXCLUDE_SUITES };
