const { getTaskStatusWebSocket, createTaskStatusWebSocket } = require('./task-status-websocket');
const { getTaskNotificationService, TASK_STATUS } = require('./task-notification-service');
const { getTaskTemplateManager } = require('./task-template-manager');
const { getFriendlyErrorHandler, parseError, formatErrorForDisplay } = require('./friendly-error-handler');
const { getTaskVersionManager } = require('./task-version-manager');
const { getTaskCancellationManager, createAbortController } = require('./task-cancellation-manager');

class TaskSystemIntegration {
  constructor() {
    this.initialized = false;
    this.server = null;
    this.cron = null;
    this.ctx = null;
  }
  
  init(server, cron, ctx) {
    if (this.initialized) return;
    
    this.server = server;
    this.cron = cron;
    this.ctx = ctx;
    
    createTaskStatusWebSocket(server, { apiKey: ctx && ctx.apiKey });
    
    const versionManager = getTaskVersionManager();
    versionManager.init();
    
    this.setupNotificationChannels();
    this.integrateWithScheduler();
    
    this.initialized = true;
    console.log('✅ 任务系统集成完成');
  }
  
  setupNotificationChannels() {
    const notificationService = getTaskNotificationService();

    if (this.ctx && this.ctx.lark && this.ctx.lark.isConfigured()) {
      notificationService.registerChannel('lark', async (notification) => {
        const message = this.formatNotificationForLark(notification);
        // 优先使用任务级的 targetUserId；群聊场景可使用 targetChatId；都没有则回退全局配置
        const target = notification.targetChatId
          || notification.targetUserId
          || this.ctx.appConfig.user?.larkUserId
          || 'default';
        await this.ctx.lark.send(target, message);
      });
    }

    if (this.ctx && this.ctx.wecom && this.ctx.wecom.isConfigured()) {
      notificationService.registerChannel('wecom', async (notification) => {
        const message = this.formatNotificationForWecom(notification);
        const target = notification.targetChatId
          || notification.targetUserId
          || this.ctx.appConfig.user?.wecomUserId
          || 'default';
        await this.ctx.wecom.send(target, message);
      });
    }

    notificationService.registerChannel('console', async (notification) => {
      const target = notification.targetUserId || notification.targetChatId || '-';
      console.log(`[${notification.type}] ${notification.message} -> ${target}`);
    });
  }
  
  formatNotificationForLark(notification) {
    const emoji = this.getNotificationEmoji(notification.type);
    const time = new Date(notification.timestamp).toLocaleString('zh-CN');
    
    return `${emoji} **${notification.taskName}**\n\n` +
           `${notification.message}\n\n` +
           `⏰ ${time}`;
  }
  
  formatNotificationForWecom(notification) {
    const emoji = this.getNotificationEmoji(notification.type);
    const time = new Date(notification.timestamp).toLocaleString('zh-CN');
    
    return `${emoji} ${notification.taskName}\n\n` +
           `${notification.message}\n\n` +
           `时间: ${time}`;
  }
  
  getNotificationEmoji(type) {
    const emojis = {
      'task_started': '⏰',
      'task_progress': '📊',
      'task_succeeded': '✅',
      'task_failed': '❌',
      'task_cancelled': '⏹️',
      'task_timeout': '⏱️',
      'task_retry': '🔄'
    };
    
    return emojis[type] || '📢';
  }
  
  integrateWithScheduler() {
    if (!this.cron) return;
    
    const originalExecute = this.cron.executeWithRetry.bind(this.cron);
    
    this.cron.executeWithRetry = async function(task) {
      const notificationService = getTaskNotificationService();
      const versionManager = getTaskVersionManager();
      // eslint-disable-next-line no-unused-vars
      const cancellationManager = getTaskCancellationManager();
      
      const abortController = createAbortController(task.id);
      
      try {
        await notificationService.notifyTaskStarted(task);
        
        versionManager.createVersion(task, {
          userId: 'scheduler',
          reason: '任务执行前自动备份'
        });
        
        const result = await originalExecute({
          ...task,
          signal: abortController.signal,
          onProgress: (progress) => {
            notificationService.notifyTaskProgress(task, progress);
          }
        });
        
        if (abortController.signal.aborted) {
          await notificationService.notifyTaskCancelled(task, abortController.signal.reason);
          return;
        }
        
        await notificationService.notifyTaskSucceeded(task, result);
        
        return result;
        
      } catch (error) {
        if (error.code === 'TASK_CANCELLED') {
          await notificationService.notifyTaskCancelled(task, error.message);
          return;
        }
        
        await notificationService.notifyTaskFailed(task, error);
        throw error;
        
      } finally {
        abortController.cleanup();
      }
    };
  }
  
  getWebSocket() {
    return getTaskStatusWebSocket();
  }
  
  getNotificationService() {
    return getTaskNotificationService();
  }
  
  getTemplateManager() {
    return getTaskTemplateManager();
  }
  
  getErrorHandler() {
    return getFriendlyErrorHandler();
  }
  
  getVersionManager() {
    return getTaskVersionManager();
  }
  
  getCancellationManager() {
    return getTaskCancellationManager();
  }
}

let instance = null;

function getTaskSystemIntegration() {
  if (!instance) {
    instance = new TaskSystemIntegration();
  }
  return instance;
}

function initTaskSystem(server, cron, ctx) {
  const integration = getTaskSystemIntegration();
  integration.init(server, cron, ctx);
  return integration;
}

module.exports = {
  TaskSystemIntegration,
  getTaskSystemIntegration,
  initTaskSystem,
  getTaskStatusWebSocket,
  getTaskNotificationService,
  getTaskTemplateManager,
  getFriendlyErrorHandler,
  getTaskVersionManager,
  getTaskCancellationManager,
  createAbortController,
  parseError,
  formatErrorForDisplay,
  TASK_STATUS
};
