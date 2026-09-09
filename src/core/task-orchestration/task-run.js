/**
 * TaskRun — 统一任务编排执行模型
 *
 * 技能执行 / 工作流 / 专家协作 / 文档生成 全部发同一套 SSE 事件:
 *   event: task:update → { taskId, title, source, skill, lanes[], status, artifacts[], error?, ts }
 * 前端 TaskOrbit 消费该事件渲染编排轨道。
 */

const crypto = require('crypto');
const { broadcastEvent } = require('../sse-broadcast');

const TASK_STATUS = { RUNNING: 'running', DONE: 'done', FAILED: 'failed' };

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function createTaskRunStore({ broadcast = broadcastEvent } = {}) {
  const tasks = new Map(); // taskId → taskRun

  function publish(task) {
    try {
      broadcast('task:update', { ...task, ts: Date.now() });
    } catch (e) {
      console.warn('[task-run] SSE 广播失败:', e.message || e);
    }
  }

  function snapshot(task) {
    return {
      id: task.taskId,
      taskId: task.taskId,
      title: task.title,
      source: task.source,
      skill: task.skill || null,
      capability: task.capability || null,
      lanes: task.lanes,
      status: task.status,
      artifacts: task.artifacts,
      error: task.error || null,
    };
  }

  return {
    createTaskRun({ title, source = 'generic', skill = null, capability = null, agent = null }) {
      const taskId = createId('tr');
      const task = {
        taskId,
        title: String(title || '任务'),
        source,
        skill,
        capability,
        agent,
        lanes: [{ id: createId('lane'), agent: agent || '主代理', stage: '准备中', status: 'waiting', progress: 0 }],
        status: TASK_STATUS.RUNNING,
        artifacts: [],
        error: null,
        createdAt: Date.now(),
      };
      tasks.set(taskId, task);
      // 有界保留：超过 200 条时驱逐最旧的终态任务，无法驱逐时驱逐最旧 running
      if (tasks.size > 200) {
        const entries = [...tasks.entries()];
        const terminal = entries.filter(([, t]) => t.status === TASK_STATUS.DONE || t.status === TASK_STATUS.FAILED);
        if (terminal.length > 0) {
          terminal.sort((a, b) => a[1].createdAt - b[1].createdAt);
          tasks.delete(terminal[0][0]);
        } else {
          const running = entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
          console.warn('[task-run] 所有 200 个任务均为运行中,驱逐最旧任务:', running[0][0]);
          tasks.delete(running[0][0]);
        }
      }
      publish(snapshot(task));
      return snapshot(task);
    },

    updateLane(taskId, laneId, patch) {
      const task = tasks.get(taskId);
      if (!task) return null;
      const lane = task.lanes.find((l) => l.id === laneId);
      if (!lane) return null;
      Object.assign(lane, patch);
      publish(snapshot(task));
      return snapshot(task);
    },

    addLane(taskId, { agent, stage, status = 'running', progress = 0 }) {
      const task = tasks.get(taskId);
      if (!task) return null;
      task.lanes.push({ id: createId('lane'), agent: agent || '代理', stage: stage || '执行中', status, progress });
      publish(snapshot(task));
      return snapshot(task);
    },

    addArtifact(taskId, artifact) {
      const task = tasks.get(taskId);
      if (!task) return null;
      task.artifacts.push({ id: createId('art'), name: artifact.name, path: artifact.path, ...artifact });
      publish(snapshot(task));
      return snapshot(task);
    },

    completeTask(taskId, result = {}) {
      const task = tasks.get(taskId);
      if (!task) return null;
      task.status = TASK_STATUS.DONE;
      task.lanes.forEach((l) => { l.status = 'done'; l.progress = 100; });
      if (result.artifacts && Array.isArray(result.artifacts)) {
        for (const a of result.artifacts) task.artifacts.push({ id: createId('art'), ...a });
      }
      task.message = result.message || null;
      publish(snapshot(task));
      return snapshot(task);
    },

    failTask(taskId, error) {
      const task = tasks.get(taskId);
      if (!task) return null;
      task.status = TASK_STATUS.FAILED;
      task.error = String(error || '执行失败');
      task.lanes.forEach((l) => { l.status = 'failed'; });
      publish(snapshot(task));
      return snapshot(task);
    },

    getTaskRun(taskId) { return taskId ? snapshot(tasks.get(taskId)) : null; },
    getActiveTasks() { return [...tasks.values()].filter((t) => t.status === TASK_STATUS.RUNNING).map(snapshot); },
  };
}

const globalTaskRunStore = createTaskRunStore();

module.exports = {
  TaskRunStore: createTaskRunStore,
  createTaskRunStore,
  globalTaskRunStore,
  TASK_STATUS,
};
