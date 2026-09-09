const collab = require('../../src/core/experts/collaboration');

// 假 runner：立即成功返回
async function fakeRunnerOk(tasks) {
  return tasks.map((t, i) => ({ id: `fake_${i}`, status: 'done', result: `产出#${i}: ${String(t.goal).slice(0, 20)}`, error: null }));
}

// 假 runner：一半失败
async function fakeRunnerMixed(tasks) {
  return tasks.map((t, i) => (i % 2 === 0
    ? { id: `fake_${i}`, status: 'done', result: 'ok', error: null }
    : { id: `fake_${i}`, status: 'failed', error: 'boom', result: null }));
}

module.exports = {
  name: 'Expert Collaboration',
  cases: [
    {
      id: 'collab_001',
      name: 'start requires goal and >=2 experts',
      category: 'collab',
      run: async () => {
        try { await collab.startCollaboration({ goal: '', tasks: [] }); return false; }
        catch (e) { return e.message.includes('goal'); }
      },
    },
    {
      id: 'collab_002',
      name: 'start rejects unknown expert',
      category: 'collab',
      run: async () => {
        try {
          await collab.startCollaboration({
            goal: 'g',
            tasks: [
              { expertId: 'finance_advisor', prompt: 'x' },
              { expertId: 'no-such-expert', prompt: 'y' },
            ],
          });
          return false;
        } catch (e) { return e.message.includes('专家不存在'); }
      },
    },
    {
      id: 'collab_003',
      name: 'startCollaboration runs fake runner and completes',
      category: 'collab',
      run: async () => {
        const { getAllExperts } = require('../../src/core/experts');
        const experts = getAllExperts().slice(0, 2);
        if (experts.length < 2) return false;
        const r = await collab.startCollaboration(
          { goal: '测试协作', tasks: experts.map(e => ({ expertId: e.id, prompt: '请分析' })) },
          { runner: fakeRunnerOk },
        );
        if (!r.collabId || r.tasks.length !== 2) return false;
        // 等待异步完成（setImmediate + delegateTasks 立即返回）
        await new Promise(res => setTimeout(res, 50));
        const st = collab.getCollabStatus(r.collabId);
        return st && st.status === 'done' && st.tasks.every(t => t.status === 'done');
      },
    },
    {
      id: 'collab_004',
      name: 'mixed failures produce error status per task',
      category: 'collab',
      run: async () => {
        const { getAllExperts } = require('../../src/core/experts');
        const experts = getAllExperts().slice(0, 2);
        if (experts.length < 2) return false;
        const r = await collab.startCollaboration(
          { goal: '混合成败', tasks: experts.map(e => ({ expertId: e.id, prompt: 'p' })) },
          { runner: fakeRunnerMixed },
        );
        await new Promise(res => setTimeout(res, 50));
        const st = collab.getCollabStatus(r.collabId);
        return st && st.tasks.some(t => t.status === 'error') && st.summary && st.summary.includes('⚠️');
      },
    },
    {
      id: 'collab_005',
      name: 'recordActivity and getActivities roundtrip',
      category: 'collab',
      run: () => {
        collab.recordActivity({ type: 'test', expertId: null, content: 'roundtrip-marker' });
        const list = collab.getActivities(10);
        return Array.isArray(list) && list.some(a => a.content === 'roundtrip-marker');
      },
    },
    {
      id: 'collab_006',
      name: 'runCollab broadcasts per-task collab:progress events (SSE realtime)',
      category: 'collab',
      run: async () => {
        const { getAllExperts } = require('../../src/core/experts');
        const sseBroadcast = require('../../src/core/sse-broadcast');
        const experts = getAllExperts().slice(0, 3);
        if (experts.length < 2) return false;
        // 尊重 onTaskStart/onTaskComplete 的假 runner（模拟 delegateTasks 每任务回调时序）
        const progressiveRunner = async (tasks, options = {}) => {
          const results = [];
          for (let i = 0; i < tasks.length; i++) {
            if (options.onTaskStart) options.onTaskStart(i);
            await new Promise((r) => setTimeout(r, 5));
            results.push({ id: `fake_${i}`, status: 'done', result: `产出#${i}`, error: null });
            if (options.onTaskComplete) options.onTaskComplete(i, results[i]);
          }
          return results;
        };
        const frames = [];
        const client = { write: (msg) => frames.push(msg) };
        sseBroadcast.addSSEClient(client);
        try {
          const r = await collab.startCollaboration(
            { goal: 'SSE 进度测试', tasks: experts.map(e => ({ expertId: e.id, prompt: 'p' })) },
            { runner: progressiveRunner },
          );
          // 并行 eval 下负载波动——轮询等待完成（最长 2s），不用固定短等待
          let st = collab.getCollabStatus(r.collabId);
          for (let i = 0; i < 40 && (!st || st.status !== 'done'); i++) {
            await new Promise((res) => setTimeout(res, 50));
            st = collab.getCollabStatus(r.collabId);
          }
          // 并行执行时同套件其他用例也在广播 collab 事件——按本 collabId 过滤帧
          const mine = frames.filter(f => f.includes('event: collab:') && f.includes(r.collabId));
          const progressFrames = mine.filter(f => f.includes('event: collab:progress'));
          const completedFrame = mine.findIndex(f => f.includes('event: collab:completed'));
          const lastProgress = mine.map((f, i) => ({ f, i })).filter(x => x.f.includes('event: collab:progress')).pop();
          // 每个任务各有独立 progress 事件、终态 completed 在全部 progress 之后、状态落盘 done
          return st && st.status === 'done' && st.tasks.every(t => t.status === 'done')
            && progressFrames.length >= experts.length
            && lastProgress && completedFrame > lastProgress.i;
        } finally {
          sseBroadcast.removeSSEClient(client);
        }
      },
    },
    {
      id: 'collab_007',
      name: 'duplicate expertId tasks aggregate by task id (no overwrite)',
      category: 'collab',
      run: async () => {
        // 同一专家两个任务：旧实现按 expertId find 会互相覆盖，新实现按任务下标聚合
        const distinctRunner = async (tasks) => tasks.map((t, i) => ({ id: `d_${i}`, status: 'done', result: `结果-${i}`, error: null }));
        const r = await collab.startCollaboration(
          { goal: '重复专家', tasks: [
            { expertId: 'finance_advisor', prompt: '任务A' },
            { expertId: 'finance_advisor', prompt: '任务B' },
          ] },
          { runner: distinctRunner },
        );
        await new Promise((res) => setTimeout(res, 60));
        const st = collab.getCollabStatus(r.collabId);
        if (!st || st.tasks.length !== 2) return false;
        const [ta, tb] = st.tasks;
        // 两个任务各自保留自己的结果（taskId 不同、结果不同、互不覆盖）
        return ta.taskId !== tb.taskId && ta.status === 'done' && tb.status === 'done'
          && ta.result === '结果-0' && tb.result === '结果-1';
      },
    },
    {
      id: 'collab_008',
      name: 'overall watchdog marks pending tasks as timeout and completes',
      category: 'collab',
      run: async () => {
        // 永不返回的 runner + 80ms 看门狗：不应挂死，任务标记 timeout，整体 error（全失败）
        // 2026-08-19: 固定等 200ms 改轮询终态（≤2s）——全量套件下前序用例的定时器
        // 堆积可致事件循环延迟（Windows 定时器合并），80ms 看门狗链 200ms 内未落定 →
        // 误判失败。轮询保留断言强度：看门狗必须快速触发并落定（elapsed<5s 仍远小于
        // 默认 600s 看门狗），任务全部 timeout + error，整体 error。
        const hangingRunner = async () => new Promise(() => {});
        const startedAt = Date.now();
        const r = await collab.startCollaboration(
          { goal: '看门狗测试', tasks: [
            { expertId: 'finance_advisor', prompt: 'a' },
            { expertId: 'sales_director', prompt: 'b' },
          ] },
          { runner: hangingRunner, deadlineMs: 80 },
        );
        let st = null;
        // 2026-08-29: 轮询 2s → 4.5s（仍 <5s 断言上限）——全量套件 6 并发下事件循环
        // 拥塞（memory 初始化同步加载数千条、better-sqlite3 同步写等）可把 80ms
        // 看门狗链推迟到 2s 之后落定，固定 2s 预算造成间歇性误判失败。
        for (let i = 0; i < 45; i++) {
          await new Promise((res) => setTimeout(res, 100));
          st = collab.getCollabStatus(r.collabId);
          if (st && st.status === 'error') break;
        }
        const elapsed = Date.now() - startedAt;
        // 看门狗 80ms → 2s 内必须落定；任务全部 timeout，整体 error
        return elapsed < 5000 && st && st.status === 'error'
          && st.tasks.every(t => t.status === 'timeout' && t.error);
      },
    },
    {
      id: 'collab_009',
      name: 'auto-trigger is idempotent per session and intent-gated',
      category: 'collab',
      run: async () => {
        const { maybeAutoStartCollab } = require('../../src/core/experts/auto-collab');
        const slowRunner = async (tasks) => {
          await new Promise((r) => setTimeout(r, 250));
          return tasks.map((t, i) => ({ id: `s_${i}`, status: 'done', result: 'ok', error: null }));
        };
        const msg = '让多个专家一起分析这个方案并汇总';
        const r1 = await maybeAutoStartCollab('auto-user-1', msg, null, { runner: slowRunner });
        // 同会话第二个触发：进行中协作存在 → 幂等跳过
        const r2 = await maybeAutoStartCollab('auto-user-1', msg, null, { runner: slowRunner });
        // 未命中多专家协作的消息：不触发
        const r3 = await maybeAutoStartCollab('auto-user-2', '今天天气怎么样', null, { runner: slowRunner });
        // 2026-08-29: 固定等 400ms 改轮询终态（≤4.5s）——250ms runner 在 6 并发
        // 全量套件下受事件循环拥塞影响可能延迟落定，固定预算造成间歇性误判失败
        // （与 collab_008 2026-08-19 同款问题、同款修法）。
        let st1 = null;
        for (let i = 0; i < 45; i++) {
          await new Promise((r) => setTimeout(r, 100));
          st1 = r1 ? collab.getCollabStatus(r1.collabId) : null;
          if (st1 && st1.status === 'done') break;
        }
        return !!r1 && r2 === null && r3 === null && st1 && st1.status === 'done';
      },
    },
  ],
};
