// T7 工具：按名运行 eval 套件（node scripts/t7-run-suite.cjs suite1 suite2 ...）
process.env.NODE_ENV = 'test';
const { EvalRunner } = require('../evals/eval-runner');
const names = process.argv.slice(2);
const runner = new EvalRunner();
const missing = [];
for (const n of names) {
  try {
    runner.registerSuite(require('../evals/test-cases/' + n));
  } catch (e) {
    missing.push(n + ': ' + e.message);
  }
}
if (missing.length) { console.error('MISSING SUITES:', missing); process.exit(2); }
runner.runAll().then((rep) => {
  console.log('SUMMARY', JSON.stringify(rep.summary));
  if (rep.failed) for (const f of rep.failed) console.log('FAIL', f.id, f.error);
  process.exit(rep.summary.passed === rep.summary.total ? 0 : 1);
});
