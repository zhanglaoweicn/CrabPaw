/**
 * DryRunInspector — pre-flight system health check without executing model/tools
 *
 * Inspired by OpenHarness dry-run mode. Checks contracts, hooks, permissions,
 * CI/CD, and governance readiness. Returns a structured report.
 */

const fs = require('fs');
const path = require('path');

class DryRunInspector {
  inspect(opts = {}) {
    const findings = [];
    const warnings = [];
    const errors = [];
    const cwd = opts.cwd || process.cwd();

    // 1. Tool Contract coverage
    const contractCount = this._countContracts();
    findings.push({
      type: 'contracts',
      status: contractCount >= 8 ? 'ok' : 'warning',
      detail: contractCount + ' tool contracts registered',
    });
    if (contractCount < 5) warnings.push('Less than 5 tool contracts — low coverage on tool validation');

    // 2. Hooks registration
    const hookStatus = this._countHooks();
    findings.push({
      type: 'hooks',
      status: hookStatus.pre > 0 ? 'ok' : 'warning',
      detail: 'Hooks: ' + hookStatus.pre + ' pre, ' + hookStatus.post + ' post',
    });
    if (hookStatus.pre === 0) warnings.push('No PreToolUse hooks registered — safety hooks inactive');

    // 3. Path rules
    const hasPathRules = this._hasPathRules();
    findings.push({
      type: 'path_rules',
      status: hasPathRules ? 'ok' : 'warning',
      detail: hasPathRules ? 'Path rules initialized' : 'Path rules not initialized',
    });
    if (!hasPathRules) warnings.push('Path-based permission rules not active');

    // 4. CI/CD
    const hasCI = fs.existsSync(path.join(cwd, '.github', 'workflows', 'ci.yml'));
    findings.push({
      type: 'ci',
      status: hasCI ? 'ok' : 'warning',
      detail: hasCI ? 'CI pipeline found' : 'No CI pipeline',
    });
    if (!hasCI) warnings.push('No CI/CD pipeline configured');

    // 5. Governance docs
    const harnessExists = fs.existsSync(path.join(cwd, 'HARNESS.md'));
    findings.push({
      type: 'governance',
      status: harnessExists ? 'ok' : 'warning',
      detail: harnessExists ? 'HARNESS.md present' : 'HARNESS.md missing',
    });
    if (!harnessExists) warnings.push('No HARNESS.md governance document');

    // 6. Eval infrastructure
    const hasEval = fs.existsSync(path.join(cwd, 'evals', 'index.js'));
    findings.push({
      type: 'eval',
      status: hasEval ? 'ok' : 'warning',
      detail: hasEval ? 'Eval runner found' : 'No eval runner',
    });
    if (!hasEval) warnings.push('No eval infrastructure — quality is unmeasured');

    // 7. Overall readiness
    const readiness = errors.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'ready';
    const nextActions = [];
    if (errors.length > 0) nextActions.push(...errors);
    if (warnings.length > 0) nextActions.push(...warnings);
    if (nextActions.length === 0) nextActions.push('System ready — run agent directly');

    return { readiness, findings, warnings, errors, nextActions, checkedAt: new Date().toISOString() };
  }

  _countContracts() {
    // 2026-08-15 P1-3: '../tool-contract' 指向不存在的 src/tool-contract.js,恒返回 0 → 改 './tool-contract'
    try { return Object.keys(require('./tool-contract').getAllContracts()).length; } catch (e) { console.warn('[dry-run] tool-contract 加载失败:', e?.message || e); return 0; }
  }

  _countHooks() {
    // 2026-08-15 P1-3: '../harness-hooks' 拿到的是 40 行 no-op 存根 → 钩子数恒 {pre:0,post:0};
    // 改为 './harness-hooks'(真实 HookManager 实现)。
    try {
      const { globalHooks } = require('./harness-hooks');
      return {
        pre: globalHooks._preToolUseHooks ? globalHooks._preToolUseHooks.length : 0,
        post: globalHooks._postToolUseHooks ? globalHooks._postToolUseHooks.length : 0,
      };
    } catch (e) { console.warn('[dry-run] harness-hooks 加载失败:', e?.message || e); return { pre: 0, post: 0 }; }
  }

  _hasPathRules() {
    // 2026-08-15 P1-3: './path-rules' 是已删除的基础版(现统一为 permissions/path-rules.js)
    try { require('./permissions/path-rules'); return true; } catch (e) { console.warn('[dry-run] permissions/path-rules 加载失败:', e?.message || e); return false; }
  }
}

const dryRunInspector = new DryRunInspector();

module.exports = { DryRunInspector, dryRunInspector };
