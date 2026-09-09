/**
 * Eval Regression Checker — 回归检测工具
 *
 * 保存每次 eval 的快照，对比当前与上次结果检测回归。
 * 集成到 CI 中，回归失败阻塞合并。
 *
 * 用法:
 *   node evals/regression-check.js              # 对比当前与上次
 *   node evals/regression-check.js --save       # 保存当前快照
 *   node evals/regression-check.js --baseline v0 # 与指定基线对比
 */

// 2026-08-26: 不再在模块顶层篡改 NODE_ENV——本模块会被 regression-guard 插件
// require（主机进程 = 服务端），顶层赋值曾导致 dev 环境被置成 'test'
// （health.environment=test；ai.js NODE_ENV!=='test' 守卫(HarnessLifecycle/心跳巡检)被跳过）。
// 改为在真正执行 eval 的入口处临时设置并恢复（见 runRegression/main）。
// 备注: ai.js:184 相关守卫读取的是 NODE_ENV，eval-cli 单独运行不受影响。

const fs = require('fs');
const path = require('path');
const { EvalRunner } = require('./eval-runner');
const { installIsolatedDataDir } = require('./isolated-data-dir');

const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const LATEST_SNAPSHOT = path.join(SNAPSHOTS_DIR, 'latest.json');
const BASELINE_PREFIX = 'baseline-';

// 2026-08-31 Eval 隔离轮 Task 2：套件清单改为惰性 require——suite-registry 会
// 级联加载 src/core 模块（config 单例 require 期固化 DATA_DIR），必须在
// installIsolatedDataDir() 设 env 之后才能首次 require（CLI 模式下顶层 require
// 会使隔离失效）。宿主进程（regression-guard 插件）内 config 已加载，安装函数
// 自检后跳过并告警，行为与隔离前一致。
let _suites = null;
function getSuites() {
  if (!_suites) {
    // 加载所有测试套件（单一事实源: suite-registry，修复引用已删除 autopilot 的 crash）
    _suites = require('./suite-registry').suites;
  }
  return _suites;
}

function ensureDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

/**
 * 运行全部 eval 并生成报告
 * @param {{excludeSuites?: string[]}} [options] - 2026-08-31 Task 3: 套件排除透传
 *   （`--exclude-suites` CLI 用; CI 命令 `npm run eval:regression -- --baseline v3`
 *   不传该参数 = 全量, 口径不变）
 */
async function runEval(options = {}) {
  // 数据目录隔离必须先于套件模块首次 require（见 getSuites 注释）
  installIsolatedDataDir({ reason: 'regression' });
  const runner = new EvalRunner({ excludeSuites: options.excludeSuites || null });
  for (const suite of getSuites()) {
    runner.registerSuite(suite);
  }
  return await runner.runAll();
}

/**
 * 保存快照
 * @param {Object} report - Eval 报告
 * @param {string} [label] - 快照标签
 */
function saveSnapshot(report, label = null) {
  ensureDir();
  const snapshot = {
    savedAt: new Date().toISOString(),
    label: label || 'auto',
    summary: report.summary,
    byCategory: report.byCategory,
    results: report.results.map(r => ({
      id: r.id,
      suite: r.suite,
      name: r.name,
      category: r.category,
      passed: r.passed,
      error: r.error || null,
    })),
  };

  // 保存为 latest
  fs.writeFileSync(LATEST_SNAPSHOT, JSON.stringify(snapshot, null, 2));

  // 如果指定了 label，保存为基线
  if (label) {
    const baselineFile = path.join(SNAPSHOTS_DIR, `${BASELINE_PREFIX}${label}.json`);
    fs.writeFileSync(baselineFile, JSON.stringify(snapshot, null, 2));
    console.log(`Baseline '${label}' saved to ${baselineFile}`);
  }

  console.log(`Snapshot saved to ${LATEST_SNAPSHOT} (${snapshot.summary.passed}/${snapshot.summary.total} passed)`);
  return snapshot;
}

/**
 * 加载快照
 * @param {string} [label] - 基线标签，默认 'latest'
 */
function loadSnapshot(label = null) {
  const file = label
    ? path.join(SNAPSHOTS_DIR, `${BASELINE_PREFIX}${label}.json`)
    : LATEST_SNAPSHOT;

  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/**
 * 对比当前报告与快照，检测回归
 * @param {Object} currentReport - 当前 eval 报告
 * @param {Object} [baselineSnapshot] - 基线快照，默认加载 latest
 * @returns {Object} { regressed: boolean, changes: [], summary: string }
 */
function checkRegression(currentReport, baselineSnapshot = null) {
  const baseline = baselineSnapshot || loadSnapshot();
  if (!baseline) {
    return { regressed: false, changes: [], summary: 'No baseline snapshot found. Run with --save to create one.' };
  }

  const changes = [];
  const previousResults = new Map();
  for (const r of baseline.results) {
    previousResults.set(r.id, r);
  }

  for (const current of currentReport.results) {
    const previous = previousResults.get(current.id);
    if (!previous) {
      // 新增测试用例
      changes.push({
        type: 'added',
        id: current.id,
        name: current.name,
        suite: current.suite,
        passed: current.passed,
      });
      continue;
    }

    if (previous.passed && !current.passed) {
      // 回归：之前通过，现在失败
      changes.push({
        type: 'regression',
        id: current.id,
        name: current.name,
        suite: current.suite,
        previous: 'PASS',
        current: 'FAIL',
        error: current.error,
      });
    } else if (!previous.passed && current.passed) {
      // 修复：之前失败，现在通过
      changes.push({
        type: 'fixed',
        id: current.id,
        name: current.name,
        suite: current.suite,
        previous: 'FAIL',
        current: 'PASS',
      });
    }
  }

  // 检测被删除的测试用例
  const currentIds = new Set(currentReport.results.map(r => r.id));
  for (const prev of baseline.results) {
    if (!currentIds.has(prev.id)) {
      changes.push({
        type: 'removed',
        id: prev.id,
        name: prev.name,
        suite: prev.suite,
        previous: prev.passed ? 'PASS' : 'FAIL',
        current: 'REMOVED',
      });
    }
  }

  const regressions = changes.filter(c => c.type === 'regression');
  const fixes = changes.filter(c => c.type === 'fixed');
  const regressed = regressions.length > 0;

  const summaryParts = [];
  if (regressed) summaryParts.push(`${regressions.length} REGRESSION(S)`);
  if (fixes.length > 0) summaryParts.push(`${fixes.length} fixed`);
  if (changes.filter(c => c.type === 'added').length > 0) summaryParts.push(`${changes.filter(c => c.type === 'added').length} added`);
  if (changes.filter(c => c.type === 'removed').length > 0) summaryParts.push(`${changes.filter(c => c.type === 'removed').length} removed`);

  const passRateBefore = parseFloat(baseline.summary.passRate);
  const passRateAfter = parseFloat(currentReport.summary.passRate);

  return {
    regressed,
    changes,
    regressions,
    fixes,
    summary: summaryParts.join(', ') || 'No changes',
    passRateDelta: (passRateAfter - passRateBefore).toFixed(1) + '%',
    previousRate: baseline.summary.passRate,
    currentRate: currentReport.summary.passRate,
  };
}

/**
 * CLI 入口
 */
/**
 * 无 process.exit 的回归检查入口（2026-08-25 S1：regression-guard 插件调用；
 * 此前仅在 main() 内以 CLI 形式存在，进程外调用不可用）。
 * @param {{save?: boolean, baselineLabel?: string|null, excludeSuites?: string[]}} [options]
 * @returns {Promise<{regressed: boolean, report: object, changes: Array, exitCode: number}>}
 */
async function runRegression(options = {}) {
  const saveFlag = options.save || false;
  const baselineLabel = options.baselineLabel || null;

  // 2026-08-26: eval 期间临时抑制心跳巡检（原顶层赋值，被插件 require 时污染宿主进程）
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  // 2026-08-31: 数据目录隔离（Task 2）。与 NODE_ENV 不同，DATA_DIR 路径在 require 期
  // 固化且不回读 env——故安装后**不**在 finally 恢复 env（恢复无法解冻已加载模块，
  // 只会让后续惰性 require 回落真实库造成同进程双目录分裂）。CLI 进程随退出释放；
  // 宿主进程由安装函数自检跳过（config 已加载）。
  installIsolatedDataDir({ reason: 'regression' });
  try {
    // 运行当前 eval（excludeSuites 透传: CLI --exclude-suites 才有值, CI 全量不受影响）
    const report = await runEval({ excludeSuites: options.excludeSuites });

    if (saveFlag) {
      if (options.excludeSuites && options.excludeSuites.length > 0) {
        // 排除模式下快照缺用例——落盘会让下一次全量对比误报 N 个 "added", 拒绝
        console.warn('[regression-check] 排除模式(--exclude-suites)禁止 --save: 快照缺用例会污染基线对比');
      } else {
        saveSnapshot(report, baselineLabel);
      }
      return {
        regressed: false, report, changes: [],
        exitCode: report.summary.passed === report.summary.total ? 0 : 1,
      };
    }

    // 加载基线并对比
    const baseline = baselineLabel ? loadSnapshot(baselineLabel) : loadSnapshot();
    if (!baseline) {
      if (!options.excludeSuites || options.excludeSuites.length === 0) {
        saveSnapshot(report, 'initial');
      }
      return { regressed: false, report, changes: [], exitCode: 0 };
    }

    const result = checkRegression(report, baseline);

    // 自动保存（覆盖 latest）——排除模式快照缺用例, 同样禁写防污染
    if (!options.excludeSuites || options.excludeSuites.length === 0) {
      saveSnapshot(report);
    }

    const exitCode = result.regressed ? 1 : (report.summary.passed === report.summary.total ? 0 : 1);
    return { regressed: result.regressed, report, changes: result.changes, passRateDelta: result.passRateDelta, exitCode };
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const saveFlag = args.includes('--save');
  const baselineIdx = args.indexOf('--baseline');
  const baselineLabel = baselineIdx >= 0 ? args[baselineIdx + 1] : null;
  // 2026-08-31 Task 3: --exclude-suites=a,b 透传（诊断用; CI 命令不传 = 全量）
  const excludeArg = args.find(a => a.startsWith('--exclude-suites='));
  const excludeSuites = excludeArg
    ? excludeArg.slice('--exclude-suites='.length).split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const baseline = baselineLabel ? loadSnapshot(baselineLabel) : loadSnapshot();

  console.log('=== CrabPaw Eval Regression Checker ===\n');
  console.log('Running eval...');
  const { report, changes, passRateDelta, exitCode } = await runRegression({ save: saveFlag, baselineLabel, excludeSuites });

  if (saveFlag) {
    console.log('\nSnapshot saved. Run without --save to check for regressions.');
    process.exit(exitCode);
  }
  if (!baseline) {
    console.log('No baseline found. Creating initial snapshot...');
    process.exit(0);
  }

  console.log(`\nBaseline:  ${baseline.summary.passRate} (${baseline.summary.passed}/${baseline.summary.total}) — ${baseline.savedAt}`);
  console.log(`Current:   ${report.summary.passRate} (${report.summary.passed}/${report.summary.total})`);
  console.log(`Delta:     ${passRateDelta}`);

  if (changes.length > 0) {
    console.log(`\nChanges: ${changes.length}`);
    for (const change of changes) {
      const icon = change.type === 'regression' ? '❌' : change.type === 'fixed' ? '✅' : change.type === 'added' ? '➕' : '➖';
      console.log(`  ${icon} [${change.type.toUpperCase()}] ${change.id}: ${change.name} (${change.previous || 'NEW'} → ${change.current})`);
      if (change.error) {
        console.log(`      Error: ${change.error}`);
      }
    }
  } else {
    console.log('\n✅ No changes detected — identical to baseline.');
  }
  console.log('');

  process.exit(exitCode);
}

module.exports = {
  runEval,
  saveSnapshot,
  loadSnapshot,
  checkRegression,
  runRegression,
};

if (require.main === module) {
  main().catch(err => {
    console.error('Regression check failed:', err);
    process.exit(1);
  });
}
