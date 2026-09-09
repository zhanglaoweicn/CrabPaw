const { createTaskRunStore } = require('../../src/core/task-orchestration/task-run');

function makeStore() {
  const events = [];
  return { store: createTaskRunStore({ broadcast: (type, data) => events.push({ type, data }) }), events };
}

module.exports = {
  name: 'Task Orchestration',
  cases: [
    {
      id: 'to_001',
      name: '创建任务产生 task:update 事件且含标题',
      category: 'task_orchestration',
      run: () => {
        const { store, events } = makeStore();
        store.createTaskRun({ title: '做一份行业报告', source: 'skill', skill: 'deep-research' });
        const ev = events.find((e) => e.type === 'task:update');
        return !!ev && ev.data.title === '做一份行业报告' && ev.data.lanes.length === 1;
      },
    },
    {
      id: 'to_002',
      name: '更新 lane 状态与进度',
      category: 'task_orchestration',
      run: () => {
        const { store, events } = makeStore();
        const t = store.createTaskRun({ title: '并行调研', source: 'collab' });
        const laneId = t.lanes[0].id;
        store.updateLane(t.id, laneId, { status: 'running', progress: 60 });
        const latest = events.filter((e) => e.type === 'task:update').pop().data;
        const lane = latest.lanes.find((l) => l.id === laneId);
        return lane.status === 'running' && lane.progress === 60;
      },
    },
    {
      id: 'to_003',
      name: '并行分叉：addLane 创建多轨',
      category: 'task_orchestration',
      run: () => {
        const { store } = makeStore();
        const t = store.createTaskRun({ title: '多专家并行', source: 'collab' });
        store.addLane(t.id, { agent: '研究员A', stage: '资料搜集' });
        store.addLane(t.id, { agent: '分析师B', stage: '竞品分析' });
        const t2 = store.getTaskRun(t.id);
        return t2.lanes.length === 3 && t2.lanes[1].agent === '研究员A' && t2.lanes[2].agent === '分析师B';
      },
    },
    {
      id: 'to_004',
      name: '产出物 addArtifact 可点开',
      category: 'task_orchestration',
      run: () => {
        const { store, events } = makeStore();
        const t = store.createTaskRun({ title: '生成报告' });
        store.addArtifact(t.id, { name: '报告.docx', path: 'data/workspace/报告.docx' });
        store.completeTask(t.id, { message: '完成' });
        const latest = events.filter((e) => e.type === 'task:update').pop().data;
        return latest.status === 'done' && latest.artifacts.length === 1 && latest.artifacts[0].name === '报告.docx';
      },
    },
    {
      id: 'to_005',
      name: '失败任务 failTask 标记 error',
      category: 'task_orchestration',
      run: () => {
        const { store, events } = makeStore();
        const t = store.createTaskRun({ title: '会失败的任务' });
        store.failTask(t.id, '执行超时');
        const latest = events.filter((e) => e.type === 'task:update').pop().data;
        return latest.status === 'failed' && latest.error === '执行超时';
      },
    },
    {
      id: 'to_006',
      name: 'skill 徽标随任务创建写入',
      category: 'task_orchestration',
      run: () => {
        const { store } = makeStore();
        const t = store.createTaskRun({ title: '生成 PDF', source: 'skill', skill: 'pdf-generator', capability: 'document' });
        return t.skill === 'pdf-generator' && t.capability === 'document';
      },
    },
  ],
};
