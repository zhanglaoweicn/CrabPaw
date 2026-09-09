const {
  getTaskTemplateManager,
  getFriendlyErrorHandler,
  getTaskVersionManager,
  getTaskCancellationManager,
  getTaskNotificationService,
  parseError
} = require('./task-system-integration');

async function handleTemplates(req, res, ctx) {
  const templateManager = getTaskTemplateManager();
  
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${ctx.PORT}`);
      const category = url.searchParams.get('category');
      const search = url.searchParams.get('search');
      const tags = url.searchParams.get('tags')?.split(',').filter(Boolean);
      
      const templates = templateManager.listTemplates({ category, search, tags });
      const categories = templateManager.listCategories();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        templates,
        categories
      }));
    } catch (e) {
      const friendlyError = parseError(e);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: friendlyError }));
    }
    return;
  }
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        
        if (data.action === 'create_from_template') {
          const result = templateManager.createTaskFromTemplate(
            data.templateId, 
            data.customizations || {}
          );
          
          if (result.success) {
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify(result));
          }
          return;
        }
        
        if (data.action === 'create_custom_template') {
          const result = templateManager.createCustomTemplate(data.template);
          
          if (result.success) {
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(400);
            res.end(JSON.stringify(result));
          }
          return;
        }
        
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '未知的操作' }));
      } catch (e) {
        const friendlyError = parseError(e);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: friendlyError }));
      }
    });
    return;
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleTaskVersions(req, res, ctx) {
  const versionManager = getTaskVersionManager();
  const errorHandler = getFriendlyErrorHandler();
  
  const url = new URL(req.url, `http://localhost:${ctx.PORT}`);
  const taskId = url.pathname.split('/')[3];
  
  if (req.method === 'GET') {
    try {
      if (url.pathname.includes('/compare')) {
        const versionId1 = url.searchParams.get('v1');
        const versionId2 = url.searchParams.get('v2');
        
        const comparison = versionManager.compareVersions(taskId, versionId1, versionId2);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(comparison));
        return;
      }
      
      const versions = versionManager.listVersions(taskId);
      const stats = versionManager.getVersionStatistics(taskId);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        versions,
        stats
      }));
    } catch (e) {
      const friendlyError = errorHandler.parseError(e);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: friendlyError }));
    }
    return;
  }
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        
        if (data.action === 'restore') {
          const result = versionManager.restoreVersion(taskId, data.versionId);
          
          if (result.success) {
            const taskIndex = ctx.schedules.cron.findIndex(t => t.id === taskId);
            if (taskIndex !== -1) {
              ctx.schedules.cron[taskIndex] = {
                ...ctx.schedules.cron[taskIndex],
                ...result.config
              };
              ctx.config.saveSchedules(ctx.schedules);
              ctx.cron.load(ctx.schedules);
            }
          }
          
          res.writeHead(200);
          res.end(JSON.stringify(result));
          return;
        }
        
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '未知的操作' }));
      } catch (e) {
        const friendlyError = errorHandler.parseError(e);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: friendlyError }));
      }
    });
    return;
  }
  
  if (req.method === 'DELETE') {
    try {
      const versionId = url.searchParams.get('versionId');
      
      if (versionId) {
        const deleted = versionManager.deleteVersion(taskId, versionId);
        res.writeHead(200);
        res.end(JSON.stringify({ success: deleted }));
      } else {
        const count = versionManager.deleteAllVersions(taskId);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, deletedCount: count }));
      }
    } catch (e) {
      const friendlyError = errorHandler.parseError(e);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: friendlyError }));
    }
    return;
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleTaskCancel(req, res, ctx) {
  const cancellationManager = getTaskCancellationManager();
  const errorHandler = getFriendlyErrorHandler();
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { taskId, reason, userId, force } = data;
        
        if (!taskId) {
          res.writeHead(400);
          res.end(JSON.stringify({ 
            success: false, 
            error: errorHandler.parseError('缺少 taskId')
          }));
          return;
        }
        
        const result = await cancellationManager.cancelTask(taskId, {
          reason: reason || '用户取消',
          userId: userId || 'user',
          force: force || false
        });
        
        if (result.success) {
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } else {
          res.writeHead(400);
          res.end(JSON.stringify(result));
        }
      } catch (e) {
        const friendlyError = errorHandler.parseError(e);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: friendlyError }));
      }
    });
    return;
  }
  
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${ctx.PORT}`);
      const taskId = url.searchParams.get('taskId');
      
      if (taskId) {
        const cancelled = cancellationManager.isCancelled(taskId);
        const reason = cancellationManager.getCancellationReason(taskId);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          cancelled,
          reason
        }));
      } else {
        const history = cancellationManager.getCancellationHistory();
        const stats = cancellationManager.getStatistics();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          history,
          stats
        }));
      }
    } catch (e) {
      const friendlyError = errorHandler.parseError(e);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: friendlyError }));
    }
    return;
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleTaskNotifications(req, res, ctx) {
  const notificationService = getTaskNotificationService();
  const errorHandler = getFriendlyErrorHandler();
  
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, `http://localhost:${ctx.PORT}`);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      
      const history = notificationService.getHistory(limit);
      const stats = notificationService.getChannelStats();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        history,
        stats
      }));
    } catch (e) {
      const friendlyError = errorHandler.parseError(e);
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: friendlyError }));
    }
    return;
  }
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { action, channel } = data;
        
        if (action === 'enable' && channel) {
          notificationService.enableChannel(channel);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: `渠道 ${channel} 已启用` }));
          return;
        }
        
        if (action === 'disable' && channel) {
          notificationService.disableChannel(channel);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: `渠道 ${channel} 已禁用` }));
          return;
        }
        
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: '未知的操作' }));
      } catch (e) {
        const friendlyError = errorHandler.parseError(e);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: friendlyError }));
      }
    });
    return;
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleEnhancedSchedules(req, res, ctx) {
  const errorHandler = getFriendlyErrorHandler();
  const versionManager = getTaskVersionManager();
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        if (!data.cron || !Array.isArray(data.cron)) {
          res.writeHead(400);
          res.end(JSON.stringify({ 
            success: false, 
            error: errorHandler.parseError('cron 必须是数组')
          }));
          return;
        }
        
        for (const task of data.cron) {
          if (!task.name || !task.cron || !task.action) {
            res.writeHead(400);
            res.end(JSON.stringify({ 
              success: false, 
              error: errorHandler.parseError('任务必须包含 name, cron, action')
            }));
            return;
          }
        }
        
        const oldTasks = ctx.schedules.cron || [];
        
        ctx.schedules.cron = data.cron;
        ctx.config.saveSchedules(ctx.schedules);
        ctx.cron.load(ctx.schedules);
        
        for (const task of data.cron) {
          const oldTask = oldTasks.find(t => t.id === task.id);
          
          if (oldTask) {
            const hasChanges = JSON.stringify(oldTask) !== JSON.stringify(task);
            if (hasChanges) {
              versionManager.createVersion(task, {
                userId: 'user',
                reason: '任务配置更新',
                changes: Object.keys(task).filter(key => 
                  JSON.stringify(oldTask[key]) !== JSON.stringify(task[key])
                )
              });
            }
          } else {
            versionManager.createVersion(task, {
              userId: 'user',
              reason: '新建任务'
            });
          }
        }
        
        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true, 
          message: '定时任务已保存',
          taskCount: data.cron.length
        }));
      } catch (e) {
        const friendlyError = errorHandler.parseError(e);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: friendlyError }));
      }
    });
    return;
  }
  
  if (req.method === 'PATCH') {
    const url = new URL(req.url, `http://localhost:${ctx.PORT}`);
    const taskId = url.pathname.split('/').pop();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const tasks = ctx.schedules.cron || [];
        const taskIndex = tasks.findIndex(t => t.id === taskId);
        
        if (taskIndex === -1) {
          res.writeHead(404);
          res.end(JSON.stringify({ 
            success: false, 
            error: errorHandler.parseError('任务不存在')
          }));
          return;
        }
        

        tasks[taskIndex] = { ...tasks[taskIndex], ...data };
        
        versionManager.createVersion(tasks[taskIndex], {
          userId: 'user',
          reason: '任务配置更新',
          changes: Object.keys(data)
        });
        
        ctx.config.saveSchedules(ctx.schedules);
        ctx.cron.load(ctx.schedules);
        
        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true, 
          message: '任务已更新',
          task: tasks[taskIndex]
        }));
      } catch (e) {
        const friendlyError = errorHandler.parseError(e);
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: friendlyError }));
      }
    });
    return;
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

module.exports = {
  handleTemplates,
  handleTaskVersions,
  handleTaskCancel,
  handleTaskNotifications,
  handleEnhancedSchedules
};
