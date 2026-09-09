// Avoid starting heartbeat patrol during eval (ai.js:184 checks NODE_ENV).
// Without this, the patrol's immediate runPatrol() triggers checkSchedulerHealth()
// which requires server.js -> the require cascade causes a silent process kill
// (exit code 0, no Node.js events) on Windows under heavy module loading.
process.env.NODE_ENV = 'test';

// 2026-08-31 Eval 隔离轮 Task 2：eval 数据目录隔离到 mkdtemp 临时根。
// 必须在任何套件/src 模块 require 之前（config 单例 require 期固化 DATA_DIR）。
const { installIsolatedDataDir } = require('./isolated-data-dir');
installIsolatedDataDir({ reason: 'eval' });

const { EvalRunner, FAST_EXCLUDE_SUITES } = require('./eval-runner');
const { suites } = require('./suite-registry');

/** 解析 CLI 参数（2026-08-31 Task 3: 快速档/套件排除透传） */
function parseArgs(argv) {
  const out = { excludeSuites: null, fast: false };
  for (const arg of argv) {
    if (arg.startsWith('--exclude-suites=')) {
      out.excludeSuites = arg.slice('--exclude-suites='.length)
        .split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--fast') {
      out.fast = true;
    }
  }
  return out;
}

async function main() {
  console.log('=== CrabPaw Harness Eval Runner v2.3.0 ===');
  const args = parseArgs(process.argv.slice(2));
  // --exclude-suites 显式优先; --fast 用 eval-runner 的 FAST_EXCLUDE_SUITES 名单。
  // 不传任何参数 = 全量（CI/`npm run eval` 口径, 保持不变）。
  const excludeSuites = (args.excludeSuites && args.excludeSuites.length > 0)
    ? args.excludeSuites
    : (args.fast ? FAST_EXCLUDE_SUITES : null);
  const runner = new EvalRunner({ excludeSuites });
  for (const suite of suites) runner.registerSuite(suite);
  const report = await runner.runAll({ parallel: true, concurrency: 6 });
  const exitCode = report.summary.passed === report.summary.total ? 0 : 1;
  process.exit(exitCode);
}

main();
