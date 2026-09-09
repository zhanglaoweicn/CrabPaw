const { CronExpressionParser } = require('cron-parser');

const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  LOST: 'lost'
};

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 5000;

function validateCron(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string' || cronExpr.trim() === '') return false;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch (e) {
    return false;
  }
}

function getNextRunTime(cronExpr) {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(),
      tz: 'Asia/Shanghai'
    });
    return interval.next().toDate();
  } catch (e) {
    return null;
  }
}

function shouldRun(cronExpr, now) {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(now.getTime() + 1000),
      tz: 'Asia/Shanghai'
    });
    const prev = interval.prev();
    if (!prev) return false;
    return Math.abs(now.getTime() - prev.getTime()) < 60000;
  } catch (e) { return false; }
}

class EnhancedScheduler {
  constructor() {
    this.tasks = new Map();
    this.actions = new Map();
    this.running = false;
    this._ticking = false;
    this.timer = null;
  }

  register(action, handler) {
    this.actions.set(action, handler);
  }

  async load(config) {
    const tasks = config && config.cron ? config.cron : [];
    for (const task of tasks) {
      if (task.enabled === false) continue;
      if (task.cron && validateCron(task.cron)) {
        this.tasks.set(task.id, { ...task, enabled: task.enabled !== false });
      }
    }
  }

  listTasks() {
    return Array.from(this.tasks.values());
  }

  async addTask(task) {
    if (!task.id) throw new Error('Task must have an id');
    if (!task.cron || !validateCron(task.cron)) throw new Error('Invalid cron expression: ' + (task.cron || 'empty'));
    this.tasks.set(task.id, { ...task, enabled: task.enabled !== false });
  }

  async updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task not found: ' + taskId);
    if (updates.cron && !validateCron(updates.cron)) throw new Error('Invalid cron expression');
    Object.assign(task, updates);
    this.tasks.set(taskId, task);
  }

  async removeTask(taskId) {
    this.tasks.delete(taskId);
  }

  getTaskInfo(taskId) {
    const task = this.tasks.get(taskId);
    return task || null;
  }

  getStats() {
    const tasks = this.listTasks();
    return {
      total: tasks.length,
      totalTasks: tasks.length,
      enabled: tasks.filter(t => t.enabled !== false).length,
      disabled: tasks.filter(t => t.enabled === false).length,
      isRunning: this.running,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
    this.timer = setInterval(() => { if (!this._ticking) this._tick(); }, 30000);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.tasks.clear();
    this.actions.clear();
  }

  async _tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const now = new Date();
      for (const [id, task] of this.tasks) {
        if (task.enabled === false) continue;
        if (!shouldRun(task.cron, now)) continue;
        const action = this.actions.get(task.action);
        if (action) {
          try {
            await action(task.params);
          } catch (e) {
            console.error(`[EnhancedScheduler] Task "${task.name || id}" execution failed:`, e.message);
            this.lastError = { taskId: id, taskName: task.name, error: e.message, timestamp: Date.now() };
            this.errors = this.errors || [];
            this.errors.push(this.lastError);
            if (this.errors.length > 100) this.errors.shift();
            // Notify listeners
            this.emit?.('task_error', { taskId: id, taskName: task.name, error: e.message });
          }
        }
      }
    } finally { this._ticking = false; }
  }

  getLastErrors(limit = 10) {
    return (this.errors || []).slice(-limit);
  }
}

const enhancedScheduler = new EnhancedScheduler();

module.exports = {
  EnhancedScheduler,
  enhancedScheduler,
  TASK_STATUS,
  validateCron,
  getNextRunTime,
  shouldRun,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY
};