/**
 * PlanStore 单元测试——Plan 实体（Plan/Artifact 深化轮）
 * 覆盖: 创建/修订(revision+同文本状态保留)/步骤状态推进/渲染文本/落盘恢复。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { PlanStore, STEP_STATUSES } = require('./plan-store');
const { CheckpointStore } = require('./checkpoint-store');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-store-test-'));
}

describe('PlanStore', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new PlanStore({ store: new CheckpointStore({ dir }) });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('setPlan 创建: revision=1, 全部步骤 pending, 落盘可恢复', () => {
    const r = store.setPlan('run_p1', { title: '招标分析', steps: ['读文件', '提取条件', '写策略'] });
    expect(r.ok).toBe(true);
    expect(r.revised).toBe(false);
    expect(r.plan.revision).toBe(1);
    expect(r.plan.steps.map(s => s.status)).toEqual(['pending', 'pending', 'pending']);

    // 新实例从磁盘恢复（崩溃后计划仍在）
    const store2 = new PlanStore({ store: new CheckpointStore({ dir }) });
    const loaded = store2.getPlan('run_p1');
    expect(loaded.title).toBe('招标分析');
    expect(loaded.steps.length).toBe(3);
  });

  test('updateStep 推进状态 + 非法输入被拒', () => {
    store.setPlan('run_p2', { title: 't', steps: ['a', 'b'] });
    const r = store.updateStep('run_p2', 1, 'done', '已完成');
    expect(r.ok).toBe(true);
    expect(r.plan.steps[0].status).toBe('done');
    expect(r.plan.steps[0].note).toBe('已完成');
    expect(store.updateStep('run_p2', 9, 'done').ok).toBe(false);
    expect(store.updateStep('run_p2', 1, 'bogus').ok).toBe(false);
    expect(store.updateStep('run_none', 1, 'done').ok).toBe(false);
  });

  test('修订: 同文本步骤状态保留, 新步骤重置 pending, revision+1', () => {
    store.setPlan('run_p3', { title: 't', steps: ['读文件', '提取条件', '写策略'] });
    store.updateStep('run_p3', 1, 'done');
    const r = store.setPlan('run_p3', { title: 't', steps: ['读文件', '风险分析', '写策略'] });
    expect(r.revised).toBe(true);
    expect(r.plan.revision).toBe(2);
    const byText = Object.fromEntries(r.plan.steps.map(s => [s.text, s.status]));
    expect(byText['读文件']).toBe('done');       // 状态保留
    expect(byText['风险分析']).toBe('pending');  // 新步骤重置
    expect(byText['写策略']).toBe('pending');    // 原本 pending
  });

  test('renderPlanText: 图标+进度可读文本', () => {
    store.setPlan('run_p4', { title: '投标分析', steps: ['读文件', '写策略'] });
    store.updateStep('run_p4', 1, 'done');
    const text = store.renderPlanText(store.getPlan('run_p4'));
    expect(text).toContain('[计划] 投标分析（v1，1/2 完成）');
    expect(text).toContain('✓ 1. 读文件');
    expect(text).toContain('○ 2. 写策略');
  });

  test('输入守卫: 空 steps/超长截断/非法 runId', () => {
    expect(store.setPlan('run_x', { steps: [] }).ok).toBe(false);
    expect(store.setPlan(null, { steps: ['a'] }).ok).toBe(false);
    const r = store.setPlan('run_p5', { steps: Array.from({ length: 30 }, (_, i) => `s${i}`) });
    expect(r.plan.steps.length).toBe(20); // MAX_STEPS 截断
  });

  test('STEP_STATUSES 契约完整', () => {
    expect([...STEP_STATUSES].sort()).toEqual(['done', 'failed', 'pending', 'running']);
  });
});
