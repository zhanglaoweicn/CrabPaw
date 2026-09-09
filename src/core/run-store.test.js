/**
 * RunStore 单元测试——B1/B2(Runtime差距分析实施)
 * 覆盖: runId 级生命周期(waiting_approval/cancelled/detached)、
 *       崩溃恢复(重启后 running → interrupted + 横幅)、终态横幅向后兼容。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { RunStore, RUN_STATUSES, RUN_RECORD_STATUSES } = require('./run-store');
const { CheckpointStore } = require('./checkpoint-store');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runstore-test-'));
}

describe('RunStore runId 级生命周期', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RunStore({ store: new CheckpointStore({ dir }) });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('startRun → waiting_approval → requestCancel → cancelled 全链路', () => {
    const rec = store.startRun({ runId: 'run_1', userId: 'u1', conversationId: 'sess_x' });
    expect(rec).not.toBeNull();
    expect(rec.status).toBe('running');

    const waiting = store.markRunStatus('run_1', 'waiting_approval', { approval: { tool: 'Email' } });
    expect(waiting.status).toBe('waiting_approval');

    const cancelled = store.requestCancel('run_1');
    expect(cancelled.cancelRequested).toBe(true);

    const done = store.finishRunRecord('run_1', 'cancelled', { usage: { llmCalls: 2, totalTokens: 99 } });
    expect(done.status).toBe('cancelled');
    expect(done.finishedAt).toBeGreaterThan(0);
    expect(done.usage.totalTokens).toBe(99);
    // 终态后移出活跃索引
    expect(store.getActiveRunByUser('u1')).toBeNull();
  });

  test('断连解耦 markRunDetached 不改变状态', () => {
    store.startRun({ runId: 'run_2', userId: 'u1' });
    const rec = store.markRunDetached('run_2');
    expect(rec.detached).toBe(true);
    expect(rec.status).toBe('running');
    expect(store.getActiveRunByUser('u1').runId).toBe('run_2');
  });

  test('P0-3: listActiveRunsByUser 按启动时间升序返回全部活跃', () => {
    store.startRun({ runId: 'run_a', userId: 'u9' });
    store.startRun({ runId: 'run_b', userId: 'u9' });
    store.startRun({ runId: 'run_c', userId: 'other' });
    store.finishRunRecord('run_b', 'finished', {});
    const actives = store.listActiveRunsByUser('u9');
    expect(actives.map((r) => r.runId)).toEqual(['run_a']);
    expect(store.listActiveRunsByUser('other').map((r) => r.runId)).toEqual(['run_c']);
    expect(store.listActiveRunsByUser(null)).toEqual([]);
  });

  test('记录持久化落盘(可跨实例读取)', () => {
    store.startRun({ runId: 'run_3', userId: 'u2' });
    // 新实例(模拟另一读取方)从磁盘读到记录
    const store2 = new RunStore({ store: new CheckpointStore({ dir }) });
    const loaded = store2.getRunRecord('run_3');
    expect(loaded).not.toBeNull();
    expect(loaded.userId).toBe('u2');
    expect(loaded.status).toBe('running');
  });

  test('非法状态迁移被拒绝', () => {
    expect(store.markRunStatus('run_x', 'bogus_status')).toBeNull();
    expect(store.finishRunRecord('run_x', 'running')).toBeNull();
  });
});

describe('RunStore 崩溃恢复', () => {
  let dir;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('重启后 running/waiting_approval 记录判为 interrupted 并刷新恢复横幅', () => {
    const store1 = new RunStore({ store: new CheckpointStore({ dir }) });
    store1.startRun({ runId: 'crash_1', userId: 'u1', conversationId: 'sess_c' });
    store1.markRunStatus('crash_1', 'waiting_approval');
    store1.startRun({ runId: 'crash_2', userId: 'u1' });
    // 终态记录不应被恢复改写
    store1.startRun({ runId: 'done_1', userId: 'u2' });
    store1.finishRunRecord('done_1', 'finished', {});

    // 模拟进程重启: 全新实例扫描
    const store2 = new RunStore({ store: new CheckpointStore({ dir }) });
    const recovered = store2.recoverInterruptedOnBoot();
    const recoveredIds = recovered.map((r) => r.runId).sort();
    expect(recoveredIds).toEqual(['crash_1', 'crash_2']);
    expect(recovered[0].status).toBe('interrupted');

    // 恢复横幅(run_<userId> 键)被刷新为 interrupted
    const banner = store2.load('u1');
    expect(banner).not.toBeNull();
    expect(banner.status).toBe('interrupted');

    // 幂等: 二次扫描零新增
    expect(store2.recoverInterruptedOnBoot()).toEqual([]);
  });
});

describe('RunStore 终态横幅向后兼容', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = makeTmpDir();
    store = new RunStore({ store: new CheckpointStore({ dir }) });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('save 接受 cancelled 状态(新增),拒绝非法状态', () => {
    expect(store.save('u1', { roundId: 'r1', status: 'cancelled' })).toBe(true);
    expect(store.load('u1').status).toBe('cancelled');
    expect(store.save('u1', { roundId: 'r2', status: 'bogus' })).toBe(false);
    expect(store.save('u1', { status: 'finished' })).toBe(false); // 缺 roundId
  });

  test('RUN_STATUSES 含 cancelled; RUN_RECORD_STATUSES 含运行态', () => {
    expect(RUN_STATUSES.has('cancelled')).toBe(true);
    expect(RUN_RECORD_STATUSES.has('waiting_approval')).toBe(true);
    expect(RUN_RECORD_STATUSES.has('running')).toBe(true);
  });
});
