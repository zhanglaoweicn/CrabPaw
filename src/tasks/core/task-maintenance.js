const { taskStore, taskFlowStore } = require('./task-store');
const { TERMINAL_STATUSES } = require('./task-executor');

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

class TaskMaintenance {
  constructor(config = {}) {
    this.config = {
      retentionMs: config.retentionMs || DEFAULT_RETENTION_MS,
      cleanupInterval: config.cleanupInterval || CLEANUP_INTERVAL_MS,
      maxTasks: config.maxTasks || 10000,
      maxEventsPerTask: config.maxEventsPerTask || 100
    };
    
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    
    this.running = true;
    this.timer = setInterval(() => this.runCleanup(), this.config.cleanupInterval);
    
    console.log(`🔄 任务清理服务已启动 (间隔: ${this.config.cleanupInterval / 60000} 分钟)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('⏹️ 任务清理服务已停止');
  }

  async runCleanup() {
    try {
      console.log('🧹 开始任务清理...');
      
      const results = {
        expiredTasks: 0,
        oldTerminalTasks: 0,
        orphanedFlows: 0,
        excessiveEvents: 0
      };
      
      results.expiredTasks = await this.cleanupExpiredTasks();
      
      results.oldTerminalTasks = await this.cleanupOldTerminalTasks();
      
      results.orphanedFlows = await this.cleanupOrphanedFlows();
      
      results.excessiveEvents = await this.cleanupExcessiveEvents();
      
      console.log(`✅ 任务清理完成:`, results);
      
      return results;
    } catch (error) {
      console.error('❌ 任务清理失败:', error);
      return { error: error.message };
    }
  }

  async cleanupExpiredTasks() {
    const now = Date.now();
    const tasks = await taskStore.listTasks({});
    
    let count = 0;
    for (const task of tasks) {
      if (task.cleanupAfter && task.cleanupAfter <= now) {
        await taskStore.deleteTask(task.taskId);
        count++;
      }
    }
    
    return count;
  }

  async cleanupOldTerminalTasks() {
    const cutoff = Date.now() - this.config.retentionMs;
    const tasks = await taskStore.listTasks({});
    
    let count = 0;
    for (const task of tasks) {
      if (TERMINAL_STATUSES.includes(task.status)) {
        const referenceTime = task.endedAt || task.lastEventAt || task.createdAt;
        if (referenceTime && referenceTime < cutoff) {
          await taskStore.deleteTask(task.taskId);
          count++;
        }
      }
    }
    
    return count;
  }

  async cleanupOrphanedFlows() {
    const flows = await taskFlowStore.listFlows({});
    let count = 0;
    
    for (const flow of flows) {
      const tasks = await taskStore.listTasks({ parentFlowId: flow.flowId });
      
      if (tasks.length === 0) {
        const flowAge = Date.now() - flow.createdAt;
        if (flowAge > 24 * 60 * 60 * 1000) {
          await taskFlowStore.deleteFlow(flow.flowId);
          count++;
        }
      }
    }
    
    return count;
  }

  async cleanupExcessiveEvents() {
    return 0;
  }

  async setTaskCleanup(taskId, cleanupAfter) {
    return taskStore.updateTask(taskId, { cleanupAfter });
  }

  async getMaintenanceStats() {
    const stats = await taskStore.getStats();
    const flows = await taskFlowStore.listFlows({});
    
    return {
      tasks: stats,
      flows: {
        total: flows.length,
        active: flows.filter(f => f.status === 'running' || f.status === 'pending').length,
        terminal: flows.filter(f => ['succeeded', 'failed', 'cancelled'].includes(f.status)).length
      },
      config: this.config,
      running: this.running
    };
  }

  async pruneToLimit(maxTasks = this.config.maxTasks) {
    const tasks = await taskStore.listTasks({});
    
    if (tasks.length <= maxTasks) {
      return { pruned: 0, remaining: tasks.length };
    }
    
    const terminalTasks = tasks.filter(t => TERMINAL_STATUSES.includes(t.status));
    // eslint-disable-next-line no-unused-vars -- filter() 结果未使用
    const activeTasks = tasks.filter(t => !TERMINAL_STATUSES.includes(t.status));
    
    terminalTasks.sort((a, b) => {
      const aTime = a.endedAt || a.lastEventAt || a.createdAt;
      const bTime = b.endedAt || b.lastEventAt || b.createdAt;
      return aTime - bTime;
    });
    
    const toPrune = tasks.length - maxTasks;
    let pruned = 0;
    
    for (let i = 0; i < Math.min(toPrune, terminalTasks.length); i++) {
      await taskStore.deleteTask(terminalTasks[i].taskId);
      pruned++;
    }
    
    return { pruned, remaining: tasks.length - pruned };
  }
}

const taskMaintenance = new TaskMaintenance();

module.exports = {
  TaskMaintenance,
  taskMaintenance,
  DEFAULT_RETENTION_MS,
  CLEANUP_INTERVAL_MS
};
