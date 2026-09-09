const { getTaskStatusWebSocket } = require('./task-status-websocket');

const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out'
};

class TaskNotificationService {
  constructor() {
    this.notificationChannels = new Map();
    this.notificationHistory = [];
    this.maxHistorySize = 1000;
  }
  
  registerChannel(name, handler) {
    this.notificationChannels.set(name, {
      name,
      handler,
      enabled: true,
      stats: {
        sent: 0,
        failed: 0
      }
    });
    
    console.log(`📢 通知渠道已注册: ${name}`);
  }
  
  unregisterChannel(name) {
    this.notificationChannels.delete(name);
    console.log(`📢 通知渠道已注销: ${name}`);
  }
  
  enableChannel(name) {
    const channel = this.notificationChannels.get(name);
    if (channel) {
      channel.enabled = true;
      console.log(`📢 通知渠道已启用: ${name}`);
    }
  }
  
  disableChannel(name) {
    const channel = this.notificationChannels.get(name);
    if (channel) {
      channel.enabled = false;
      console.log(`📢 通知渠道已禁用: ${name}`);
    }
  }
  
  async notifyTaskStarted(task, context = {}) {
    const notification = {
      type: 'task_started',
      taskId: task.id,
      taskName: task.name,
      targetUserId: task.targetUserId || null,
      targetChatId: task.targetChatId || null,
      timestamp: Date.now(),
      message: `任务 "${task.name}" 开始执行`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastToWebSocket(task.id, TASK_STATUS.RUNNING, {
      taskName: task.name,
      message: '任务开始执行'
    });
  }
  
  async notifyTaskProgress(task, progress, context = {}) {
    const notification = {
      type: 'task_progress',
      taskId: task.id,
      taskName: task.name,
      targetUserId: task.targetUserId || null,
      targetChatId: task.targetChatId || null,
      progress,
      timestamp: Date.now(),
      message: `任务 "${task.name}" 进度: ${progress}%`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastProgress(task.id, progress, {
      taskName: task.name,
      message: notification.message
    });
  }
  
  async notifyTaskSucceeded(task, result, context = {}) {
    const notification = {
      type: 'task_succeeded',
      taskId: task.id,
      taskName: task.name,
      targetUserId: task.targetUserId || null,
      targetChatId: task.targetChatId || null,
      result: this.sanitizeResult(result),
      timestamp: Date.now(),
      message: `✅ 任务 "${task.name}" 执行成功`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastToWebSocket(task.id, TASK_STATUS.SUCCEEDED, {
      taskName: task.name,
      result: notification.result,
      message: notification.message
    });
  }
  
  async notifyTaskFailed(task, error, context = {}) {
    const notification = {
      type: 'task_failed',
      taskId: task.id,
      taskName: task.name,
      targetUserId: task.targetUserId || null,
      targetChatId: task.targetChatId || null,
      error: this.sanitizeError(error),
      timestamp: Date.now(),
      message: `❌ 任务 "${task.name}" 执行失败: ${error.message || error}`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastError(task.id, error, {
      taskName: task.name,
      message: notification.message
    });
  }
  
  async notifyTaskCancelled(task, reason, context = {}) {
    const notification = {
      type: 'task_cancelled',
      taskId: task.id,
      taskName: task.name,
      targetUserId: task.targetUserId || null,
      targetChatId: task.targetChatId || null,
      reason,
      timestamp: Date.now(),
      message: `⏹️ 任务 "${task.name}" 已取消: ${reason}`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastToWebSocket(task.id, TASK_STATUS.CANCELLED, {
      taskName: task.name,
      reason,
      message: notification.message
    });
  }
  
  async notifyTaskTimeout(task, context = {}) {
    const notification = {
      type: 'task_timeout',
      taskId: task.id,
      taskName: task.name,
      targetUserId: task.targetUserId || null,
      targetChatId: task.targetChatId || null,
      timestamp: Date.now(),
      message: `⏱️ 任务 "${task.name}" 执行超时`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastToWebSocket(task.id, TASK_STATUS.TIMED_OUT, {
      taskName: task.name,
      message: notification.message
    });
  }
  
  async notifyTaskRetry(task, attempt, maxRetries, error, context = {}) {
    const notification = {
      type: 'task_retry',
      taskId: task.id,
      taskName: task.name,
      attempt,
      maxRetries,
      error: this.sanitizeError(error),
      timestamp: Date.now(),
      message: `🔄 任务 "${task.name}" 第 ${attempt}/${maxRetries} 次重试`,
      context
    };
    
    await this.sendNotification(notification);
    this.broadcastToWebSocket(task.id, TASK_STATUS.RUNNING, {
      taskName: task.name,
      attempt,
      maxRetries,
      message: notification.message
    });
  }
  
  async sendNotification(notification) {
    this.addToHistory(notification);
    
    const promises = [];
    
    for (const [name, channel] of this.notificationChannels) {
      if (!channel.enabled) continue;
      
      promises.push(
        this.sendToChannel(channel, notification)
          .catch(e => {
            console.error(`发送通知到渠道 ${name} 失败:`, e.message);
            channel.stats.failed++;
          })
      );
    }
    
    await Promise.allSettled(promises);
  }
  
  async sendToChannel(channel, notification) {
    try {
      await channel.handler(notification);
      channel.stats.sent++;
    } catch (e) {
      channel.stats.failed++;
      throw e;
    }
  }
  
  broadcastToWebSocket(taskId, status, data) {
    const ws = getTaskStatusWebSocket();
    if (ws) {
      ws.broadcastTaskStatus(taskId, status, data);
    }
  }
  
  broadcastProgress(taskId, progress, data) {
    const ws = getTaskStatusWebSocket();
    if (ws) {
      ws.broadcastTaskProgress(taskId, progress, data);
    }
  }
  
  broadcastError(taskId, error, data) {
    const ws = getTaskStatusWebSocket();
    if (ws) {
      ws.broadcastTaskError(taskId, error, data);
    }
  }
  
  addToHistory(notification) {
    this.notificationHistory.push(notification);
    
    if (this.notificationHistory.length > this.maxHistorySize) {
      this.notificationHistory = this.notificationHistory.slice(-this.maxHistorySize);
    }
  }
  
  getHistory(limit = 100) {
    return this.notificationHistory.slice(-limit);
  }
  
  getChannelStats() {
    const stats = {};
    
    for (const [name, channel] of this.notificationChannels) {
      stats[name] = {
        enabled: channel.enabled,
        sent: channel.stats.sent,
        failed: channel.stats.failed
      };
    }
    
    return stats;
  }
  
  sanitizeError(error) {
    if (!error) return { message: '未知错误' };
    
    if (typeof error === 'string') {
      return { message: error };
    }
    
    if (error instanceof Error) {
      return {
        message: error.message,
        code: error.code || 'ERROR'
      };
    }
    
    return { message: String(error) };
  }
  
  sanitizeResult(result) {
    if (!result) return null;
    
    if (typeof result === 'string') {
      return { message: result };
    }
    
    if (typeof result === 'object') {
      const sanitized = { ...result };
      
      const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'apiSecret', 'credential'];
      for (const key of Object.keys(sanitized)) {
        if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
          sanitized[key] = '***REDACTED***';
        }
      }
      
      return sanitized;
    }
    
    return result;
  }
}

let instance = null;

function getTaskNotificationService() {
  if (!instance) {
    instance = new TaskNotificationService();
  }
  return instance;
}

module.exports = {
  TaskNotificationService,
  getTaskNotificationService,
  TASK_STATUS
};
