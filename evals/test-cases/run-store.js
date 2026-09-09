const os = require('os');
const path = require('path');
const fs = require('fs');
const { RunStore, RUN_STATUSES } = require('../../src/core/run-store');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-eval-'));
  return { dir, store: new RunStore({ dir }) };
}

module.exports = {
  name: 'Run Store',
  cases: [
    {
      id: 'run_001',
      name: 'save/load 闭环',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        store.save('voice_shell_user', {
          roundId: 'round-1', status: 'finished', ts: 123,
          digest: '执行: WebSearch | 工具完成: WebSearch',
          lastContent: '好的',
        });
        const loaded = store.load('voice_shell_user');
        return loaded
          && loaded.roundId === 'round-1'
          && loaded.status === 'finished'
          && loaded.digest.includes('WebSearch');
      },
    },
    {
      id: 'run_002',
      name: '非法 status 拒绝写入',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        const ok = store.save('u', { roundId: 'r1', status: 'weird' });
        return ok === false && store.load('u') === null;
      },
    },
    {
      id: 'run_003',
      name: 'digest/lastContent 截断上限',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        store.save('u', {
          roundId: 'r2', status: 'error', ts: 1,
          digest: 'x'.repeat(2000),
          lastContent: 'y'.repeat(800),
        });
        const loaded = store.load('u');
        return loaded.digest.length <= 1000 && loaded.lastContent.length <= 500;
      },
    },
    {
      id: 'run_004',
      name: 'clear 后 load 为 null',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        store.save('u', { roundId: 'r3', status: 'finished', ts: 1 });
        store.clear('u');
        return store.load('u') === null;
      },
    },
    {
      id: 'run_005',
      name: '损坏数据降级 null 不抛错',
      category: 'run_store',
      run: () => {
        const { dir, store } = fresh();
        fs.writeFileSync(path.join(dir, 'run_u.json'), '{broken json');
        const loaded = store.load('u');
        return loaded === null;
      },
    },
    {
      id: 'run_006',
      name: 'RUN_STATUSES 定义完整',
      category: 'run_store',
      run: () => {
        return RUN_STATUSES.has('finished')
          && RUN_STATUSES.has('error')
          && RUN_STATUSES.has('interrupted')
          && RUN_STATUSES.has('cancelled') // B2: 显式取消终态
          && RUN_STATUSES.size === 4;
      },
    },
    {
      id: 'run_007',
      name: 'runId 级生命周期: running → waiting_approval → cancelled',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        store.startRun({ runId: 'run_l1', userId: 'u', conversationId: 'sess_1' });
        store.markRunStatus('run_l1', 'waiting_approval', { approval: { tool: 'Email' } });
        store.requestCancel('run_l1');
        const done = store.finishRunRecord('run_l1', 'cancelled', { usage: { llmCalls: 2 } });
        return done.status === 'cancelled'
          && done.cancelRequested === true
          && done.finishedAt > 0
          && done.usage.llmCalls === 2
          && store.getActiveRunByUser('u') === null;
      },
    },
    {
      id: 'run_008',
      name: '断连解耦: detached 标记不改变 running 状态',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        store.startRun({ runId: 'run_d1', userId: 'u' });
        const rec = store.markRunDetached('run_d1');
        return rec.detached === true && rec.status === 'running'
          && store.getActiveRunByUser('u').runId === 'run_d1';
      },
    },
    {
      id: 'run_009',
      name: '崩溃恢复: 重启后活跃 run 判 interrupted 并刷新横幅',
      category: 'run_store',
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-eval-'));
        try {
          const store1 = new RunStore({ dir });
          store1.startRun({ runId: 'run_c1', userId: 'u', conversationId: 'sess_c' });
          store1.startRun({ runId: 'run_c2', userId: 'u' });
          store1.finishRunRecord('run_c2', 'finished', {});
          // 模拟重启: 全新实例 + 崩溃恢复扫描
          const store2 = new RunStore({ dir });
          const recovered = store2.recoverInterruptedOnBoot();
          const banner = store2.load('u');
          return recovered.length === 1
            && recovered[0].runId === 'run_c1'
            && recovered[0].status === 'interrupted'
            && banner && banner.status === 'interrupted';
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'run_010',
      name: '非法 run 记录状态迁移被拒绝',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        return store.markRunStatus('run_x', 'bogus') === null
          && store.finishRunRecord('run_x', 'running') === null;
      },
    },
    {
      id: 'run_011',
      name: 'per-run 用量随终态落盘',
      category: 'run_store',
      run: () => {
        const { store } = fresh();
        store.startRun({ runId: 'run_u1', userId: 'u' });
        const done = store.finishRunRecord('run_u1', 'finished', {
          usage: { llmCalls: 3, promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.02, toolCalls: 1 },
        });
        return done.usage && done.usage.llmCalls === 3 && done.usage.totalTokens === 150;
      },
    },
  ],
};
