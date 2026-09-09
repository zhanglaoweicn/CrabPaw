const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars
const { getTaskNotificationService, TASK_STATUS } = require('./task-notification-service');

class TaskCancellationManager extends EventEmitter {
  constructor() {
    super();
    
    this.cancellationTokens = new Map();
    this.cancellationReasons = new Map();
    this.cancellationHistory = [];
    this.maxHistorySize = 100;
  }
  
  createCancellationToken(taskId) {
    const token = {
      taskId,
      cancelled: false,
      reason: null,
      cancelledAt: null,
      cancelledBy: null
    };
    
    this.cancellationTokens.set(taskId, token);
    
    return {
      isCancelled: () => token.cancelled,
      getReason: () => token.reason,
      throwIfCancelled: () => {
        if (token.cancelled) {
          const error = new Error(`任务已取消: ${token.reason || '用户取消'}`);
          error.code = 'TASK_CANCELLED';
          error.taskId = taskId;
          throw error;
        }
      }
    };
  }
  
  async cancelTask(taskId, options = {}) {
    // eslint-disable-next-line no-unused-vars
    const { reason = '用户取消', userId = 'system', force = false } = options;
    
    const token = this.cancellationTokens.get(taskId);
    
    if (!token) {
      return {
        success: false,
        error: '任务未在运行中'
      };
    }
    
    if (token.cancelled) {
      return {
        success: false,
        error: '任务已被取消'
      };
    }
    
    token.cancelled = true;
    token.reason = reason;
    token.cancelledAt = Date.now();
    token.cancelledBy = userId;
    
    this.cancellationReasons.set(taskId, {
      reason,
      cancelledAt: token.cancelledAt,
      cancelledBy: userId
    });
    
    this.recordCancellation(taskId, reason, userId);
    
    this.emit('task_cancelled', {
      taskId,
      reason,
      cancelledAt: token.cancelledAt,
      cancelledBy: userId
    });
    
    const notificationService = getTaskNotificationService();
    await notificationService.notifyTaskCancelled(
      { id: taskId, name: `任务 ${taskId}` },
      reason,
      { userId }
    );
    
    console.log(`⏹️ 任务已取消: ${taskId} - ${reason}`);
    
    return {
      success: true,
      message: '任务取消请求已发送',
      cancelledAt: token.cancelledAt
    };
  }
  
  async cancelMultipleTasks(taskIds, options = {}) {
    const results = [];
    
    for (const taskId of taskIds) {
      const result = await this.cancelTask(taskId, options);
      results.push({
        taskId,
        ...result
      });
    }
    
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    return {
      success: failed === 0,
      total: taskIds.length,
      succeeded,
      failed,
      results
    };
  }
  
  isCancelled(taskId) {
    const token = this.cancellationTokens.get(taskId);
    return token ? token.cancelled : false;
  }
  
  getCancellationReason(taskId) {
    return this.cancellationReasons.get(taskId);
  }
  
  removeCancellationToken(taskId) {
    this.cancellationTokens.delete(taskId);
    this.cancellationReasons.delete(taskId);
  }
  
  recordCancellation(taskId, reason, userId) {
    this.cancellationHistory.push({
      taskId,
      reason,
      userId,
      cancelledAt: Date.now()
    });
    
    if (this.cancellationHistory.length > this.maxHistorySize) {
      this.cancellationHistory = this.cancellationHistory.slice(-this.maxHistorySize);
    }
  }
  
  getCancellationHistory(limit = 50) {
    return this.cancellationHistory.slice(-limit);
  }
  
  getActiveCancellationTokens() {
    const active = [];
    
    for (const [taskId, token] of this.cancellationTokens) {
      if (!token.cancelled) {
        active.push({
          taskId,
          createdAt: token.createdAt
        });
      }
    }
    
    return active;
  }
  
  getCancelledTasks() {
    const cancelled = [];
    
    for (const [taskId, token] of this.cancellationTokens) {
      if (token.cancelled) {
        cancelled.push({
          taskId,
          reason: token.reason,
          cancelledAt: token.cancelledAt,
          cancelledBy: token.cancelledBy
        });
      }
    }
    
    return cancelled;
  }
  
  clearHistory() {
    this.cancellationHistory = [];
  }
  
  getStatistics() {
    const total = this.cancellationHistory.length;
    const byReason = {};
    const byUser = {};
    
    for (const record of this.cancellationHistory) {
      byReason[record.reason] = (byReason[record.reason] || 0) + 1;
      byUser[record.userId] = (byUser[record.userId] || 0) + 1;
    }
    
    return {
      total,
      byReason,
      byUser,
      activeTokens: this.cancellationTokens.size
    };
  }
}

class TaskAbortController {
  constructor(taskId, cancellationManager) {
    this.taskId = taskId;
    this.cancellationManager = cancellationManager;
    this.token = cancellationManager.createCancellationToken(taskId);
    this.abortHandler = null;
    this.timeoutId = null;
  }
  
  get signal() {
    return {
      aborted: this.token.isCancelled(),
      reason: this.token.getReason(),
      onabort: null,
      addEventListener: (type, handler) => {
        if (type === 'abort') {
          this.abortHandler = handler;
        }
      },
      removeEventListener: (type, _handler) => {
        if (type === 'abort') {
          this.abortHandler = null;
        }
      }
    };
  }
  
  abort(reason) {
    this.cancellationManager.cancelTask(this.taskId, { reason });
    
    if (this.abortHandler) {
      this.abortHandler({ type: 'abort', target: this.signal });
    }
    
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
  
  setTimeout(ms, callback) {
    this.timeoutId = setTimeout(() => {
      this.abort('执行超时');
      if (callback) callback();
    }, ms);
  }
  
  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
  
  throwIfAborted() {
    this.token.throwIfCancelled();
  }
  
  cleanup() {
    this.clearTimeout();
    this.cancellationManager.removeCancellationToken(this.taskId);
  }
}

let instance = null;

function getTaskCancellationManager() {
  if (!instance) {
    instance = new TaskCancellationManager();
  }
  return instance;
}

function createAbortController(taskId) {
  const manager = getTaskCancellationManager();
  return new TaskAbortController(taskId, manager);
}

module.exports = {
  TaskCancellationManager,
  TaskAbortController,
  getTaskCancellationManager,
  createAbortController
};
