// eslint-disable-next-line no-unused-vars -- require 解构保留
const { EnhancedScheduler, TASK_STATUS } = require('./enhanced-scheduler');
// eslint-disable-next-line no-unused-vars -- require 解构保留
const { taskStore, taskFlowStore } = require('./task-store');
const { DEFAULT_PORT } = require('../../core/config');
const {
  taskExecutionHistory,
  // eslint-disable-next-line no-unused-vars -- require 解构保留
  taskNotificationManager,
  taskDependencyManager,
  // eslint-disable-next-line no-unused-vars -- require 解构保留
  taskConditionManager
} = require('./task-execution-history');
// eslint-disable-next-line no-unused-vars -- require 解构保留
const { sanitizeTaskError, sanitizeTaskList } = require('./task-sanitizer');

const REGISTERED_ACTIONS = ['skill', 'search', 'send_message', 'run_skill', 'ai_task'];

function validateTask(task) {
  const errors = [];
  
  if (!task.name || task.name.trim() === '') {
    errors.push('任务名称不能为空');
  }
  
  if (!task.cron || task.cron.trim() === '') {
    errors.push('Cron 表达式不能为空');
  }
  
  if (!task.action || task.action.trim() === '') {
    errors.push('任务动作不能为空');
  }
  
  if (task.action && !REGISTERED_ACTIONS.includes(task.action)) {
    errors.push(`未注册的任务类型: ${task.action}`);
  }
  
  return errors;
}

async function handleSchedulesEnhanced(req, res, ctx) {
  const PORT = process.env.PORT || DEFAULT_PORT;
  
  if (req.method === 'GET') {
    try {
      const tasks = ctx.cron.listTasks();
      const history = ctx.cron.getAllExecutionHistory(50);
      const stats = ctx.cron.getStats();
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        data: { 
          cron: sanitizeTaskList(tasks),
          history,
          stats
        } 
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        
        if (data.cron && !Array.isArray(data.cron)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'cron 必须是数组' }));
          return;
        }
        
        if (data.cron) {
          for (const task of data.cron) {
            const errors = validateTask(task);
            if (errors.length > 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ success: false, error: errors.join(', ') }));
              return;
            }
          }
          
          await ctx.cron.load({ cron: data.cron });
          
          ctx.schedules.cron = data.cron;
          ctx.config.saveSchedules(ctx.schedules);
        }
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: '定时任务已保存' }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'PATCH') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const taskId = url.pathname.split('/').pop();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);

        // Check if task exists; if not in scheduler but present in schedules, create it
        const existingInScheduler = ctx.cron.listTasks().find(t => t.id === taskId);
        const existingInSchedules = ctx.schedules.cron?.find(t => t.id === taskId);

        if (!existingInScheduler && existingInSchedules) {
          // Task exists in schedules but not in scheduler — add it then update
          const merged = { ...existingInSchedules, ...data };
          ctx.cron.addTask(merged);
          const idx = ctx.schedules.cron.findIndex(t => t.id === taskId);
          if (idx !== -1) ctx.schedules.cron[idx] = merged;
          ctx.config.saveSchedules(ctx.schedules);
          // Reload scheduler to ensure sync
          await ctx.cron.load(ctx.schedules);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, message: '任务已创建并更新', task: merged }));
          return;
        }

        const updated = ctx.cron.updateTask(taskId, data);
        if (!updated && !existingInSchedules) {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: '任务不存在' }));
          return;
        }

        const taskIndex = ctx.schedules.cron?.findIndex(t => t.id === taskId) ?? -1;
        if (taskIndex !== -1) {
          ctx.schedules.cron[taskIndex] = { ...ctx.schedules.cron[taskIndex], ...data };
          ctx.config.saveSchedules(ctx.schedules);
        }

        // Ensure scheduler stays in sync after mutation
        await ctx.cron.load(ctx.schedules);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: '任务已更新', task: updated }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const taskId = url.pathname.split('/').pop();

    const removed = ctx.cron.removeTask(taskId);
    if (!removed) {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '任务不存在' }));
      return;
    }

    ctx.schedules.cron = (ctx.schedules.cron || []).filter(t => t.id !== taskId);
    ctx.config.saveSchedules(ctx.schedules);

    // Reload scheduler to ensure sync after deletion
    await ctx.cron.load(ctx.schedules);

    res.writeHead(200);
    res.end(JSON.stringify({ success: true, message: '任务已删除' }));
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleTaskHistory(req, res, ctx) {
  const PORT = process.env.PORT || DEFAULT_PORT;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  const taskId = url.searchParams.get('taskId');
  const limit = parseInt(url.searchParams.get('limit') || '20', 10);
  
  try {
    let history;
    if (taskId) {
      history = await ctx.cron.getExecutionHistory(taskId, limit);
    } else {
      history = await ctx.cron.getExecutionHistory(null, limit);
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, history }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
}

async function handleTaskStats(req, res, ctx) {
  try {
    const stats = ctx.cron.getStats();
    const taskStats = await taskExecutionHistory.getStats();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true, 
      stats: {
        ...stats,
        execution: taskStats
      }
    }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
}

async function handleTaskTrigger(req, res, ctx) {
  const PORT = process.env.PORT || DEFAULT_PORT;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  const taskId = url.searchParams.get('id');
  if (!taskId) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '缺少任务ID' }));
    return;
  }
  
  const task = ctx.cron.getTaskInfo(taskId);
  if (!task) {
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: '任务不存在' }));
    return;
  }
  
  console.log(`🧪 手动触发任务: ${task.name}`);
  
  try {
    const result = await ctx.cron.execute(task);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, message: `任务 ${task.name} 已执行`, result }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
}

async function handleTaskDependency(req, res, _ctx) {
  const PORT = process.env.PORT || DEFAULT_PORT;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (req.method === 'GET') {
    const taskId = url.searchParams.get('taskId');
    if (!taskId) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '缺少任务ID' }));
      return;
    }
    
    const dependencies = taskDependencyManager.getDependencies(taskId);
    const dependents = taskDependencyManager.getDependents(taskId);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, dependencies, dependents }));
    return;
  }
  
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { taskId, dependsOnTaskId } = JSON.parse(body);
        
        if (!taskId || !dependsOnTaskId) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: '缺少 taskId 或 dependsOnTaskId' }));
          return;
        }
        
        taskDependencyManager.addDependency(taskId, dependsOnTaskId);
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: '依赖关系已添加' }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  if (req.method === 'DELETE') {
    const taskId = url.searchParams.get('taskId');
    const dependsOnTaskId = url.searchParams.get('dependsOnTaskId');
    
    if (!taskId || !dependsOnTaskId) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '缺少 taskId 或 dependsOnTaskId' }));
      return;
    }
    
    taskDependencyManager.removeDependency(taskId, dependsOnTaskId);
    
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, message: '依赖关系已移除' }));
    return;
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

module.exports = {
  handleSchedulesEnhanced,
  handleTaskHistory,
  handleTaskStats,
  handleTaskTrigger,
  handleTaskDependency,
  validateTask,
  REGISTERED_ACTIONS
};
