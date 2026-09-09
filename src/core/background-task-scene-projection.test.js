/**
 * 后台任务直驱投影测试(P1-9, 参考实现 core 直驱投影借鉴)
 *
 * 背景(2026-08-13): 后台任务提交时带 sceneId → 任务状态由系统直接投影为
 * progress 场景卡(不依赖 agent 心跳);≥5% 节流(0/100 不跳过);
 * 终态自动移除卡片;每状态点广播 bg_task:update。
 */

// mock scene-store 与 sse-broadcast,避免真实依赖
jest.mock('./scene/scene-store', () => {
  const upsertCalls = [];
  const removeCalls = [];
  return {
    getSceneStore: () => ({
      upsertSurface: (id, surface) => upsertCalls.push({ id, surface }),
      removeSurface: (id) => removeCalls.push(id),
    }),
    __upsertCalls: upsertCalls,
    __removeCalls: removeCalls,
  };
});

const broadcastCalls = [];
jest.mock('./sse-broadcast', () => ({
  broadcastEvent: (name, data) => broadcastCalls.push({ name, data }),
}));

const { BackgroundTaskManager } = require('./background-task-manager');

function getUpserts() {
  return jest.requireMock('./scene/scene-store').__upsertCalls;
}
function getRemoves() {
  return jest.requireMock('./scene/scene-store').__removeCalls;
}

describe('BackgroundTaskManager 直驱投影', () => {
  beforeEach(() => {
    getUpserts().length = 0;
    getRemoves().length = 0;
    broadcastCalls.length = 0;
  });

  test('任务启动投影 0% progress 卡(ambient)', async () => {
    const mgr = new BackgroundTaskManager();
    mgr.submit('demo', async () => {}, { sceneId: 'bg.demo', label: '演示任务' });
    await new Promise((r) => setTimeout(r, 20));
    const upserts = getUpserts();
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const first = upserts[0];
    expect(first.id).toBe('bg.demo');
    expect(first.surface.kind).toBe('progress');
    expect(first.surface.data.label).toBe('演示任务');
    expect(first.surface.data.progress).toBe(0);
    expect(first.surface.intent).toBe('ambient');
  });

  test('≥5% 节流:1%→3% 不重投,5% 投一次', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('throttle', async (report) => {
      await new Promise((r) => setTimeout(r, 10));
      report(1);
      report(3);
      report(5);
      await new Promise((r) => setTimeout(r, 5));
    }, { sceneId: 'bg.throttle' });
    await mgr.getTask(id)?._promise;
    const progresses = getUpserts().map((u) => u.surface.data.progress);
    expect(progresses).toContain(0);
    expect(progresses).toContain(5);
    expect(progresses).not.toContain(1);
    expect(progresses).not.toContain(3);
  });

  test('完成后自动移除场景卡', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('finish', async () => 'done', { sceneId: 'bg.finish' });
    await mgr.getTask(id)?._promise;
    await new Promise((r) => setTimeout(r, 10));
    expect(getRemoves()).toContain('bg.finish');
  });

  test('失败自动移除场景卡', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('fail', async () => { throw new Error('boom') }, { sceneId: 'bg.fail' });
    await mgr.getTask(id)?._promise;
    await new Promise((r) => setTimeout(r, 10));
    expect(getRemoves()).toContain('bg.fail');
  });

  test('取消自动移除场景卡', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('cancel-me', () => new Promise(() => {}), { sceneId: 'bg.cancel' });
    mgr.cancel(id);
    expect(getRemoves()).toContain('bg.cancel');
  });

  test('每状态点广播 bg_task:update', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('broadcast', async (report) => {
      report(50);
      return 'ok';
    }, { sceneId: 'bg.bc' });
    await mgr.getTask(id)?._promise;
    await new Promise((r) => setTimeout(r, 10));
    const names = broadcastCalls.map((c) => c.name);
    const states = broadcastCalls.map((c) => c.data.state);
    expect(names.every((n) => n === 'bg_task:update')).toBe(true);
    expect(states).toContain('running');
    expect(states).toContain('completed');
  });

  test('无 sceneId 时不投影(纯 EventEmitter 行为)', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('plain', async () => 'ok');
    await mgr.getTask(id)?._promise;
    expect(getUpserts().length).toBe(0);
    expect(getRemoves().length).toBe(0);
  });

  test('updateProgress 对非 running 任务无效', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('plain', async () => 'ok');
    await mgr.getTask(id)?._promise;
    expect(mgr.updateProgress(id, 80)).toBe(false);
  });

  test('getTask 附带 progress 字段', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.submit('prog', async (report) => {
      report(42, '处理中');
      return 'ok';
    }, { sceneId: 'bg.prog' });
    await mgr.getTask(id)?._promise;
    expect(mgr.getTask(id)?.progress).toBe(42);
  });
});
