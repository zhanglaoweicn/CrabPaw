const { DryRunInspector } = require("../../src/core/dry-run-inspector");

module.exports = {
  name: "Dry Run Inspector",
  cases: [
    {
      id: "dri_001",
      name: "inspector.inspect returns structured report",
      category: "dry_run_inspector",
      run: () => {
        const ins = new DryRunInspector();
        const report = ins.inspect({ cwd: process.cwd() });
        return report !== null
          && typeof report.readiness === 'string'
          && Array.isArray(report.findings)
          && Array.isArray(report.warnings)
          && Array.isArray(report.errors)
          && Array.isArray(report.nextActions);
      },
    },
    {
      id: "dri_002",
      name: "inspect reports contract count",
      category: "dry_run_inspector",
      run: () => {
        const ins = new DryRunInspector();
        const report = ins.inspect({ cwd: process.cwd() });
        const contractFinding = report.findings.find(f => f.type === 'contracts');
        return contractFinding !== null
          && (contractFinding.status === 'ok' || contractFinding.status === 'warning')
          && contractFinding.detail.includes('tool contracts');
      },
    },
    {
      id: "dri_003",
      name: "inspect checks CI pipeline existence",
      category: "dry_run_inspector",
      run: () => {
        const ins = new DryRunInspector();
        const report = ins.inspect({ cwd: process.cwd() });
        const ciFinding = report.findings.find(f => f.type === 'ci');
        return ciFinding !== null
          && ciFinding.detail.includes('CI');
      },
    },
    {
      id: "dri_004",
      name: "inspect checks governance doc",
      category: "dry_run_inspector",
      run: () => {
        const ins = new DryRunInspector();
        const report = ins.inspect({ cwd: process.cwd() });
        const govFinding = report.findings.find(f => f.type === 'governance');
        return govFinding !== null && govFinding.status === 'ok';
      },
    },
    {
      id: "dri_005",
      name: "inspect checks eval infrastructure",
      category: "dry_run_inspector",
      run: () => {
        const ins = new DryRunInspector();
        const report = ins.inspect({ cwd: process.cwd() });
        const evalFinding = report.findings.find(f => f.type === 'eval');
        return evalFinding !== null && evalFinding.status === 'ok';
      },
    },
    {
      id: "dri_006",
      name: "inspect reports real hook/contract/path-rule counts (post P1-3 wiring)",
      category: "dry_run_inspector",
      run: () => {
        // 2026-08-15 P1-3: 此前 require 路径指向存根/不存在的模块 → 钩子恒 0、
        // 契约恒 0。接线后应计数 > 0。
        const { globalHooks } = require('../../src/core/harness-hooks');
        globalHooks.registerPreToolUse(async () => ({ allowed: true }));
        const ins = new DryRunInspector();
        const report = ins.inspect({ cwd: process.cwd() });
        const hookFinding = report.findings.find(f => f.type === 'hooks');
        const contractFinding = report.findings.find(f => f.type === 'contracts');
        const pathFinding = report.findings.find(f => f.type === 'path_rules');
        const contractCount = parseInt(String(contractFinding?.detail).match(/\d+/)?.[0] || '0', 10);
        return hookFinding !== null && hookFinding.status === 'ok'
          && hookFinding.detail.includes('pre')
          && contractCount > 0
          && pathFinding !== null && pathFinding.status === 'ok';
      },
    },
  ],
};
