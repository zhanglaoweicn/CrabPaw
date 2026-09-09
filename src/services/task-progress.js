/**
 * Task Progress Tracker Service
 * 
 * 结构化任务进度追踪
 * 提供里程碑检测、ETA估算、检查点管理
 */

const EventEmitter = require('events');

class TaskProgressTracker extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      maxTasks: config.maxTasks || 100,
      milestoneThresholds: config.milestoneThresholds || [25, 50, 75, 90, 100],
      checkpointInterval: config.checkpointInterval || 10,
      ...config,
    };

    this.tasks = new Map();
    this.milestones = [];
    this.completedTasks = [];
  }

  createTask(taskId, metadata = {}) {
    if (this.tasks.size >= this.config.maxTasks) {
      this._evictOldestTask();
    }

    const task = {
      id: taskId,
      status: 'pending',
      progress: 0,
      milestones: [],
      startTime: Date.now(),
      endTime: null,
      metadata,
      checkpoints: [],
      errors: [],
      warnings: [],
    };

    this.tasks.set(taskId, task);
    this.emit('task:created', { taskId, metadata });

    return task;
  }

  startTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = 'running';
    task.startTime = Date.now();
    
    this.emit('task:started', { taskId });
    return task;
  }

  updateProgress(taskId, progress, checkpoint = null) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const previousProgress = task.progress;
    task.progress = Math.min(100, Math.max(0, progress));

    if (checkpoint) {
      task.checkpoints.push({
        progress: task.progress,
        checkpoint,
        timestamp: Date.now(),
      });
    }

    const milestone = this._detectMilestone(task, previousProgress);
    if (milestone) {
      task.milestones.push(milestone);
      this.milestones.push({
        taskId,
        milestone,
        timestamp: Date.now(),
      });
      this.emit('task:milestone', { taskId, milestone, progress: task.progress });
    }

    this.emit('task:progress', { taskId, progress: task.progress, previousProgress });

    return task;
  }

  _detectMilestone(task, previousProgress) {
    for (const threshold of this.config.milestoneThresholds) {
      if (task.progress >= threshold && previousProgress < threshold) {
        return threshold;
      }
    }
    return null;
  }

  completeTask(taskId, result = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = 'completed';
    task.progress = 100;
    task.endTime = Date.now();
    task.result = result;

    this.completedTasks.push({
      id: taskId,
      duration: task.endTime - task.startTime,
      checkpoints: task.checkpoints.length,
      milestones: task.milestones.length,
    });

    if (this.completedTasks.length > 50) {
      this.completedTasks = this.completedTasks.slice(-30);
    }

    this.emit('task:completed', { taskId, duration: task.endTime - task.startTime, result });

    return task;
  }

  failTask(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    task.status = 'failed';
    task.endTime = Date.now();
    task.errors.push({
      message: error?.message || String(error),
      timestamp: Date.now(),
    });

    this.emit('task:failed', { taskId, error });

    return task;
  }

  addWarning(taskId, warning) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.warnings.push({
      message: warning,
      timestamp: Date.now(),
    });

    this.emit('task:warning', { taskId, warning });
  }

  getProgressReport(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const now = Date.now();
    const elapsed = now - task.startTime;

    return {
      id: task.id,
      status: task.status,
      progress: task.progress,
      startTime: task.startTime,
      elapsed,
      duration: task.endTime ? task.endTime - task.startTime : elapsed,
      checkpoints: task.checkpoints.length,
      milestones: task.milestones,
      errors: task.errors.length,
      warnings: task.warnings.length,
      eta: this._estimateCompletion(task),
      metadata: task.metadata,
    };
  }

  _estimateCompletion(task) {
    if (task.progress === 0 || task.progress === 100) {
      return null;
    }

    const elapsed = Date.now() - task.startTime;
    const estimatedTotal = elapsed / (task.progress / 100);
    const remaining = estimatedTotal - elapsed;

    return Math.max(0, Math.round(remaining));
  }

  getActiveTasks() {
    const active = [];
    
    for (const [id, task] of this.tasks) {
      if (task.status === 'running' || task.status === 'pending') {
        active.push(this.getProgressReport(id));
      }
    }

    return active.sort((a, b) => b.startTime - a.startTime);
  }

  getRecentMilestones(count = 10) {
    return this.milestones.slice(-count);
  }

  getStats() {
    const tasks = Array.from(this.tasks.values());
    
    return {
      totalTasks: this.tasks.size,
      activeTasks: tasks.filter(t => t.status === 'running').length,
      pendingTasks: tasks.filter(t => t.status === 'pending').length,
      completedTasks: this.completedTasks.length,
      failedTasks: tasks.filter(t => t.status === 'failed').length,
      totalMilestones: this.milestones.length,
      avgProgress: tasks.length > 0
        ? tasks.reduce((sum, t) => sum + t.progress, 0) / tasks.length
        : 0,
    };
  }

  _evictOldestTask() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed') {
        if (task.endTime < oldestTime) {
          oldestTime = task.endTime;
          oldest = id;
        }
      }
    }

    if (oldest) {
      this.tasks.delete(oldest);
    }
  }

  clear() {
    this.tasks.clear();
    this.milestones = [];
    this.completedTasks = [];
    this.emit('cleared');
  }

  export() {
    return {
      tasks: Array.from(this.tasks.entries()),
      milestones: this.milestones,
      completedTasks: this.completedTasks,
    };
  }

  import(data) {
    if (data?.tasks) {
      this.tasks = new Map(data.tasks);
    }
    if (data?.milestones) {
      this.milestones = data.milestones;
    }
    if (data?.completedTasks) {
      this.completedTasks = data.completedTasks;
    }
  }
}

const taskProgressTracker = new TaskProgressTracker();

module.exports = {
  TaskProgressTracker,
  taskProgressTracker,
};
