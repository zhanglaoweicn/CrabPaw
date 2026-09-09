/**
 * Plan 实体 + Artifact 深化 eval（Plan/Artifact 深化轮）
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { PlanStore } = require('../../src/core/plan-store');

function freshPlanStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-eval-'));
  const store = new PlanStore({ store: new (require('../../src/core/checkpoint-store').CheckpointStore)({ dir }) });
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = {
  name: 'Plan & Artifact',
  cases: [
    {
      id: 'plan_001',
      name: '计划创建/推进/渲染全链路',
      category: 'plan_artifact',
      run: () => {
        const { store, cleanup } = freshPlanStore();
        try {
          store.setPlan('run_e1', { title: '招标分析', steps: ['读文件', '提取条件', '写策略'] });
          store.updateStep('run_e1', 1, 'done');
          const plan = store.getPlan('run_e1');
          const text = store.renderPlanText(plan);
          return plan.steps[0].status === 'done'
            && plan.steps[1].status === 'pending'
            && text.includes('1/3 完成')
            && text.includes('✓ 1. 读文件');
        } finally { cleanup(); }
      },
    },
    {
      id: 'plan_002',
      name: '计划修订: 同文本状态保留 + revision 递增',
      category: 'plan_artifact',
      run: () => {
        const { store, cleanup } = freshPlanStore();
        try {
          store.setPlan('run_e2', { title: 't', steps: ['a', 'b'] });
          store.updateStep('run_e2', 1, 'done');
          const r = store.setPlan('run_e2', { title: 't', steps: ['a', 'c'] });
          const byText = Object.fromEntries(r.plan.steps.map(s => [s.text, s.status]));
          return r.revised === true && r.plan.revision === 2 && byText['a'] === 'done' && byText['c'] === 'pending';
        } finally { cleanup(); }
      },
    },
    {
      id: 'plan_003',
      name: '计划崩溃恢复: 新实例从磁盘读回',
      category: 'plan_artifact',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-eval-'));
        try {
          const CheckpointStore = require('../../src/core/checkpoint-store').CheckpointStore;
          const s1 = new PlanStore({ store: new CheckpointStore({ dir }) });
          s1.setPlan('run_e3', { title: 't', steps: ['x', 'y'] });
          s1.updateStep('run_e3', 1, 'running');
          const s2 = new PlanStore({ store: new CheckpointStore({ dir }) });
          const plan = s2.getPlan('run_e3');
          return !!plan && plan.steps[0].status === 'running';
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      },
    },
    {
      id: 'plan_004',
      name: 'artifact 版本化: 再生成 version+1 + 旧版本入档',
      category: 'plan_artifact',
      run: () => {
        const da = require('../../src/core/doc-artifacts/registry');
        da.resetForTest?.();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-eval-'));
        try {
          const f1 = path.join(tmp, '报告.docx');
          fs.writeFileSync(f1, 'v1');
          const f2 = path.join(tmp, '报告v2.docx');
          fs.writeFileSync(f2, 'v2-longer');
          da.registerArtifact({ path: f1, name: '报告.docx', size: 2, format: 'docx', url: '', taskId: 't' });
          da.registerArtifact({ path: f2, name: '报告.docx', size: 9, format: 'docx', url: '', taskId: 't' });
          // 注: registerArtifact 为 async 但无内部 await,副作用同步完成;
          // 同步 run() 里不读 Promise 返回值,断言走注册表 entry
          const entry = da.listArtifacts(10).find(x => x.name === '报告.docx');
          return entry.version === 2 && entry.versions.length === 1 && entry.status === 'completed';
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      },
    },
    {
      id: 'plan_005',
      name: 'artifact 防虚增: 同路径同大小重复登记不升版本',
      category: 'plan_artifact',
      run: () => {
        const da = require('../../src/core/doc-artifacts/registry');
        da.resetForTest?.();
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-eval-'));
        try {
          const f = path.join(tmp, 'same.md');
          da.registerArtifact({ path: f, name: 'same.md', size: 3, format: 'md', url: '', taskId: 't' });
          da.registerArtifact({ path: f, name: 'same.md', size: 3, format: 'md', url: '', taskId: 't' });
          const entry = da.listArtifacts(10).find(x => x.name === 'same.md');
          return entry.version === 1 && entry.versions.length === 0;
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      },
    },
  ],
};
