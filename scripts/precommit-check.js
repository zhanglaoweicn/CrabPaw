/**
 * CrabPaw Pre-commit Check Script
 * Runs lint + eval before allowing commits
 * Called by: .husky/pre-commit hooks
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAIL = '\x1b[31m✗\x1b[0m';
const PASS = '\x1b[32m✓\x1b[0m';

function run(name, cmd, timeoutMs = 120000) {
  process.stdout.write(`  ${name}... `);
  try {
    // 2026-08-13: maxBuffer 1MB → 32MB——eval 工具注册日志输出 1.2MB+,
    // 默认 1MB 缓冲溢出(ENOBUFS)导致 eval 全过仍被误判失败
    execSync(cmd, { cwd: ROOT, stdio: 'pipe', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    console.log(PASS);
    return true;
  } catch (e) {
    console.log(FAIL);
    console.log(`    ${e.stderr ? e.stderr.toString().trim().split('\n').slice(-3).join('\n    ') : e.message}`);
    return false;
  }
}

const results = [];
// 2026-09-03 P0 治理编码化: 层契约闸门(冻结存量/禁止增量) + 结构性事实校验(文档数字=代码真值)。
// 均为秒级纯 Node 检查, 置于最前快速失败。
results.push(run('Layer Contract', 'node scripts/check-layer-contract.js', 60000));
results.push(run('Harness Facts', 'node scripts/harness-facts.js --check', 120000));
// T3 (2026-08-06): lint 门槛从 --max-warnings 0(任何 warning 即阻塞)改为 error 才阻塞。
// 根因: 存量 no-unused-vars(卫生建议, warn)627 条使 warning-zero 门槛永远无法通过,
// 阻塞所有提交且无增量价值。正确门槛: error(no-undef/语法/真 bug)阻塞, warning 不阻塞。
// 存量 warn 由 scripts/clean-unused-args.js 等增量清理,而非门槛强行清零。
results.push(run('Lint', 'npx eslint src/ --ext .js'));

// 2026-08-31 Eval 隔离轮 Task 3: husky 钩子改快速档（.husky/pre-commit 传 --fast）。
// --fast = eval 走 index.js --fast, 排除 FAST_EXCLUDE_SUITES 名单（口径见 eval-runner.js
// 尾部注释: 实测裁定, 仅时序敏感的 Expert Collaboration 入名单）。CI 全量口径不变
// （`npm run eval` / `npm run eval:regression -- --baseline v3`）。
// EI2 隔离后快速档实测 ~6s, 超时预算 300s→120s 收紧: 挂起时更快失败, 不再长时占住提交。
const FAST = process.argv.includes('--fast');
results.push(run(
  FAST ? 'Eval (fast)' : 'Eval',
  FAST ? 'node evals/index.js --fast' : 'node evals/index.js',
  FAST ? 120000 : 300000
));
results.push(run('Plugin Verify', 'node scripts/verify-plugins.js'));

const failed = results.filter(r => !r).length;
if (failed > 0) {
  console.log(`\n${FAIL} ${failed} check(s) failed. Commit aborted.`);
  process.exit(1);
}
console.log(`\n${PASS} All checks passed.`);
