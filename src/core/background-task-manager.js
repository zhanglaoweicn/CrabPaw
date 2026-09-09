const EventEmitter = require('events');

const TASK_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

class BackgroundTaskManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._maxConcurrent = options.maxConcurrent || 5;
    this._tasks = new Map();
    this._running = 0;
    this._taskCounter = 0;
    this._checkpointStore = null;
    this._snapshotTimer = null;
  }

  submit(name, fn, options = {}) {
    const id = `bg_${++this._taskCounter}_${Date.now()}`;
    const task = {
      id,
      name,
      state: TASK_STATES.PENDING,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      timeout: options.timeout || null,
      // 2026-08-13 P1-9: 直驱投影字段——sceneId 存在时把任务状态投影为
      // progress 场景卡(ambient),label 兜底卡片标题,onProgress 供任务回调
      sceneId: options.sceneId || null,
      label: options.label || name,
      onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
      progress: 0,
      progressText: '',
      // 节流: 上次投影的百分比(≥5% 才再投)
      _lastProjectedPct: -1,
    };
    this._tasks.set(id, task);
    this._schedule(task, fn);
    return id;
  }

  _schedule(task, fn) {
    if (this._running >= this._maxConcurrent) {
      return;
    }
    this._running++;
    task.state = TASK_STATES.RUNNING;
    task.startedAt = Date.now();
    this.emit('task:start', { id: task.id, name: task.name });
    // 2026-08-13 P1-9: 任务启动即投影 0% 进度卡
    this._projectProgress(task, 0);

    let timer = null;
    // 2026-08-13 P1-9: fn 接收 progress 回调——任务内部无需持有 task id,
    // 直接 report(pct, text) 驱动投影(避免 TDZ/闭包顺序问题)
    const reportProgress = (pct, text) => this.updateProgress(task.id, pct, text);
    const promise = (async () => {
      try {
        const result = task.timeout
          ? await this._withTimeout(fn(reportProgress), task.timeout)
          : await fn(reportProgress);
        task.state = TASK_STATES.COMPLETED;
        task.result = result;
        task.completedAt = Date.now();
        this.emit('task:complete', { id: task.id, name: task.name, result });
        this._removeSurface(task);
        this._broadcastUpdate(task, TASK_STATES.COMPLETED);
        this._saveTaskSnapshot();
        return result;
      } catch (err) {
        task.state = TASK_STATES.FAILED;
        task.error = err.message || String(err);
        task.completedAt = Date.now();
        this.emit('task:error', { id: task.id, name: task.name, error: task.error });
        this._removeSurface(task);
        this._broadcastUpdate(task, TASK_STATES.FAILED);
        this._saveTaskSnapshot();
        if (err.message !== 'TaskCancelled') {
          console.warn(`[bg-task] ${task.name} (${task.id}) failed:`, err.message);
        }
      } finally {
        this._running--;
        if (timer) clearTimeout(timer);
        this._scheduleNext();
      }
    })();
    task._promise = promise;
  }

  /**
   * 2026-08-13 P1-9: 更新任务进度并投影到场景卡(参考实现 core 直驱投影借鉴)
   * @param {string} id 任务 id(submit 返回值)
   * @param {number} pct 进度 0-100
   * @param {string} [text] 进度描述(可选)
   */
  updateProgress(id, pct, text = '') {
    const task = this._tasks.get(id);
    if (!task || task.state !== TASK_STATES.RUNNING) return false;
    const clamped = Math.min(100, Math.max(0, Math.round(pct)));
    task.progress = clamped;
    if (text) task.progressText = text;
    if (task.onProgress) {
      try { task.onProgress(clamped, text) } catch (e) { console.warn('[bg-task] onProgress 回调异常:', e?.message || e) }
    }
    this._projectProgress(task, clamped);
    return true;
  }

  /** 2026-08-13 P1-9: 投影 progress 场景卡——≥5% 节流(0/100 不跳过) */
  _projectProgress(task, pct) {
    if (!task.sceneId) return;
    if (pct !== 0 && pct !== 100 && Math.abs(pct - task._lastProjectedPct) < 5) return;
    task._lastProjectedPct = pct;
    try {
      const { getSceneStore } = require('./scene/scene-store');
      getSceneStore().upsertSurface(task.sceneId, {
        kind: 'progress',
        data: { label: task.label, progress: pct, text: task.progressText || '' },
        intent: 'ambient',
      });
    } catch (e) {
      // scene-store 不可用 → 降级为纯 EventEmitter 行为(不抛错)
      console.debug('[bg-task] 场景卡投影失败(降级):', e?.message || e);
    }
    this._broadcastUpdate(task, TASK_STATES.RUNNING);
  }

  /** 终态移除场景卡 */
  _removeSurface(task) {
    if (!task.sceneId) return;
    try {
      const { getSceneStore } = require('./scene/scene-store');
      getSceneStore().removeSurface(task.sceneId);
    } catch (e) {
      console.debug('[bg-task] 场景卡移除失败(降级):', e?.message || e);
    }
  }

  /** 广播 bg_task:update 事件(供前端任务卡/场景卡消费) */
  _broadcastUpdate(task, state) {
    try {
      const { broadcastEvent } = require('./sse-broadcast');
      broadcastEvent('bg_task:update', {
        id: task.id,
        name: task.name,
        state,
        progress: task.progress,
        sceneId: task.sceneId,
        ts: Date.now(),
      });
    } catch (e) {
      console.debug('[bg-task] 广播失败(降级):', e?.message || e);
    }
  }

  _scheduleNext() {
    for (const task of this._tasks.values()) {
      if (task.state === TASK_STATES.PENDING) {
        return;
      }
    }
  }

  async _withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(id) {
    const task = this._tasks.get(id);
    if (!task) return false;
    if (task.state === TASK_STATES.PENDING || task.state === TASK_STATES.RUNNING) {
      task.state = TASK_STATES.CANCELLED;
      task.completedAt = Date.now();
      this.emit('task:cancel', { id, name: task.name });
      this._removeSurface(task);
      this._broadcastUpdate(task, TASK_STATES.CANCELLED);
      this._saveTaskSnapshot();
      return true;
    }
    return false;
  }

  getTask(id) {
    return this._tasks.get(id) || null;
  }

  listTasks(filter = {}) {
    let tasks = Array.from(this._tasks.values());
    if (filter.state) {
      tasks = tasks.filter(t => t.state === filter.state);
    }
    if (filter.name) {
      tasks = tasks.filter(t => t.name.includes(filter.name));
    }
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  getStats() {
    const all = Array.from(this._tasks.values());
    return {
      total: all.length,
      pending: all.filter(t => t.state === TASK_STATES.PENDING).length,
      running: all.filter(t => t.state === TASK_STATES.RUNNING).length,
      completed: all.filter(t => t.state === TASK_STATES.COMPLETED).length,
      failed: all.filter(t => t.state === TASK_STATES.FAILED).length,
      cancelled: all.filter(t => t.state === TASK_STATES.CANCELLED).length,
      maxConcurrent: this._maxConcurrent,
    };
  }

  // —— I-3 T3: checkpoint snapshot methods ——

  _getCheckpointStore() {
    if (!this._checkpointStore) {
      const path = require('path');
      const { DATA_DIR } = require('./config');
      const { CheckpointStore } = require('./checkpoint-store');
      this._checkpointStore = new CheckpointStore({ dir: path.join(DATA_DIR, 'checkpoints') });
    }
    return this._checkpointStore;
  }

  _saveTaskSnapshot() {
    try {
      const tasks = Array.from(this._tasks.values()).map(t => ({
        id: t.id,
        name: t.name,
        state: t.state,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        result: t.result,
        error: t.error,
        timeout: t.timeout,
      }));
      this._getCheckpointStore().saveCheckpoint('bg_tasks_snapshot', {
        tasks,
        savedAt: Date.now(),
      });
    } catch (e) {
      console.error('[background-task] 快照保存失败:', e.message || e);
    }
  }

  restoreTasks() {
    try {
      const snapshot = this._getCheckpointStore().loadCheckpoint('bg_tasks_snapshot');
      if (!snapshot || !Array.isArray(snapshot.tasks)) return;
      let restored = 0;
      for (const t of snapshot.tasks) {
        if (this._tasks.has(t.id)) continue;
        if (t.state === TASK_STATES.COMPLETED || t.state === TASK_STATES.FAILED || t.state === TASK_STATES.CANCELLED) {
          // 终态任务：还原元数据供展示/清理
          this._tasks.set(t.id, { ...t, recovered: true });
          restored++;
        } else {
          // pending/running 任务：标记为 cancelled + recovered，不自动重跑
          this._tasks.set(t.id, {
            ...t,
            state: TASK_STATES.CANCELLED,
            completedAt: Date.now(),
            recovered: true,
          });
          restored++;
        }
      }
      if (restored > 0) {
        console.log('[bg-task] 从快照恢复 ' + restored + ' 个任务元数据（未重跑）');
      }
      // 恢复后立即保存清理后的快照
      this._saveTaskSnapshot();
    } catch (e) {
      console.warn('[bg-task] 快照恢复失败:', e.message || e);
    }
  }

  clearCompleted() {
    for (const [id, task] of this._tasks) {
      if (task.state === TASK_STATES.COMPLETED || task.state === TASK_STATES.FAILED || task.state === TASK_STATES.CANCELLED) {
        this._tasks.delete(id);
      }
    }
    this._saveTaskSnapshot();
  }

  // I-3 T3: 每 30s 周期快照 + 幂等启动
  startSnapshotting() {
    if (this._snapshotTimer) return;
    this._snapshotTimer = setInterval(() => {
      try { this._saveTaskSnapshot(); } catch (e) { console.error('[background-task] 周期快照失败:', e.message || e); }
    }, 30 * 1000);
    this._snapshotTimer.unref();
  }
}

let _instance = null;

function getBackgroundTaskManager(options) {
  if (!_instance) {
    _instance = new BackgroundTaskManager(options);
  }
  return _instance;
}

module.exports = {
  BackgroundTaskManager,
  getBackgroundTaskManager,
  TASK_STATES,
};
