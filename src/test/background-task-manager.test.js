const { BackgroundTaskManager, TASK_STATES } = require('../core/background-task-manager');

describe('BackgroundTaskManager', () => {
  let mgr;

  beforeEach(() => {
    mgr = new BackgroundTaskManager({ maxConcurrent: 3 });
  });

  describe('submit and lifecycle', () => {
    test('should submit a task and return an id', () => {
      const id = mgr.submit('test', () => Promise.resolve(42));
      expect(id).toMatch(/^bg_/);
    });

    test('should complete a task successfully', async () => {
      const id = mgr.submit('test', () => Promise.resolve(42));
      await mgr._tasks.get(id)._promise;
      await new Promise(r => setTimeout(r, 50));
      const task = mgr.getTask(id);
      expect(task.state).toBe(TASK_STATES.COMPLETED);
      expect(task.result).toBe(42);
    });
  });

  describe('getTask', () => {
    test('should return null for unknown id', () => {
      expect(mgr.getTask('nonexistent')).toBeNull();
    });

    test('should return task details', () => {
      const id = mgr.submit('test', () => Promise.resolve(1));
      const task = mgr.getTask(id);
      expect(task.id).toBe(id);
      expect(task.name).toBe('test');
    });
  });

  describe('listTasks', () => {
    test('should list all tasks', () => {
      mgr.submit('a', () => Promise.resolve(1));
      mgr.submit('b', () => Promise.resolve(2));
      expect(mgr.listTasks().length).toBe(2);
    });

    test('should filter by state', () => {
      mgr.submit('a', () => Promise.resolve(1));
      expect(mgr.listTasks({ state: TASK_STATES.RUNNING }).length).toBe(1);
    });
  });

  describe('cancel', () => {
    test('should cancel a pending task', () => {
      const id = mgr.submit('test', () => Promise.resolve(1));
      const ok = mgr.cancel(id);
      expect(ok).toBe(true);
      expect(mgr.getTask(id).state).toBe(TASK_STATES.CANCELLED);
    });

    test('should return false for unknown id', () => {
      expect(mgr.cancel('nonexistent')).toBe(false);
    });
  });

  describe('getStats', () => {
    test('should return correct stats', () => {
      mgr.submit('a', () => Promise.resolve(1));
      const stats = mgr.getStats();
      expect(stats.total).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.maxConcurrent).toBe(3);
    });
  });

  describe('clearCompleted', () => {
    test('should remove completed tasks', () => {
      mgr.submit('a', () => Promise.resolve(1));
      mgr.clearCompleted();
      expect(mgr.listTasks().length).toBe(1);
    });
  });

  describe('event emission', () => {
    test('should emit task:complete on success', async () => {
      const events = [];
      mgr.on('task:complete', e => events.push(e));
      // eslint-disable-next-line no-unused-vars
      const id = mgr.submit('test', () => Promise.resolve(99));
      await new Promise(r => setTimeout(r, 50));
      expect(events.length).toBe(1);
      expect(events[0].result).toBe(99);
    });
  });
});
