const path = require('path');
const { DEFAULT_PORT } = require('../core/config');

const REGISTERED_ACTIONS = ['skill', 'search', 'send_message', 'run_skill', 'ai_task', 'reminder'];

function validateSchedules(data) {
  const errors = [];
  if (data.cron && !Array.isArray(data.cron)) {
    errors.push('cron 必须是数组');
  }
  return errors;
}

function validateConfirm(data) {
  const errors = [];
  if (!data.taskId) errors.push('缺少 taskId');
  if (data.confirmed === undefined) errors.push('缺少 confirmed');
  if (!data.userId) errors.push('缺少 userId');
  return errors;
}

function validateHistoryClear(data) {
  const errors = [];
  if (!data.userId) errors.push('缺少 userId');
  return errors;
}

async function handleSchedules(req, res, ctx) {
  const PORT = process.env.PORT || DEFAULT_PORT;
  
  if (req.method === 'GET') {
    const tasks = (ctx.schedules.cron || []).map(t => ({
      ...t,
      type: t.type || "fixed",
      enabled: t.enabled !== false
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { cron: tasks, count: tasks.length } }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const errors = validateSchedules(data);
        if (errors.length > 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, message: errors.join(', ') }));
          return;
        }
        if (data.cron) {
          for (const task of data.cron) {
            if (task.action && !REGISTERED_ACTIONS.includes(task.action)) {
              res.writeHead(400);
              res.end(JSON.stringify({ success: false, message: `未注册的任务类型: ${task.action}` }));
              return;
            }
            // 兼容：没有 type 字段的旧任务默认为 fixed
            if (!task.type) {
              task.type = 'fixed';
            }
          }
          ctx.schedules.cron = (data.cron || []).map(t => ({ type: "fixed", enabled: true, ...t }));
        }
        ctx.config.saveSchedules(ctx.schedules);
        ctx.cron.load(ctx.schedules);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: '定时任务已保存' }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
    });
    return;
  }

  if (req.method === 'PATCH') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const taskId = url.pathname.split('/').pop();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const tasks = ctx.schedules.cron || [];
        const taskIndex = tasks.findIndex(t => t.id === taskId);
        
        if (taskIndex === -1) {
          // Upsert: 任务不存在则创建（支持前端添加单个任务）
          if (!data.action || !REGISTERED_ACTIONS.includes(data.action)) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: `未注册的任务类型: ${data.action}` }));
            return;
          }
          if (!data.type) data.type = "fixed";
          if (!data.id) data.id = "tsk_" + Date.now() + "_" + Math.random().toString(36).slice(2,8);
          if (data.enabled === undefined) data.enabled = true;
          if (!data.createdAt) data.createdAt = Date.now();
          tasks.push(data);
        } else {
          const newAction = data.action ?? tasks[taskIndex].action;
          if (!REGISTERED_ACTIONS.includes(newAction)) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: `未注册的任务类型: ${newAction}` }));
            return;
          }
          tasks[taskIndex] = { ...tasks[taskIndex], ...data };
        }
        ctx.config.saveSchedules(ctx.schedules);
        ctx.cron.load(ctx.schedules);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: taskIndex === -1 ? '任务已创建' : '任务已更新' }));
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
    const tasks = ctx.schedules.cron || [];
    const taskIndex = tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '任务不存在' }));
      return;
    }
    tasks.splice(taskIndex, 1);
    ctx.schedules.cron = tasks;
    ctx.config.saveSchedules(ctx.schedules);
    ctx.cron.load(ctx.schedules);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, message: '任务已删除' }));
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleConfirm(req, res, ctx) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const errors = validateConfirm(data);
      if (errors.length > 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, message: errors.join(', ') }));
        return;
      }
      const { taskId, confirmed, userId } = data;
      
      if (!confirmed) {
        const pending = ctx.state?.pendingConfirmations?.get(taskId);
        if (pending) {
          ctx.state.pendingConfirmations.delete(taskId);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: '任务已取消' }));
        return;
      }
      
      const result = ctx.lark.confirm(taskId, userId);
      if (!result.success) {
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }
      
      const task = result.task;
      
      try {
        await ctx.lark.send(userId, ctx.formatWithCrab(
          `**${task.name}**\n\n🔍 正在搜索: "${task.params.keyword}"\n\n请稍候...`,
          'task_start'
        ));
        
        const searchResult = await ctx.skills.execute('multi-search-engine', task.params, ctx.skillsRegistry, (keyword, results) => {
          return ctx.ai.summarize(ctx.appConfig, keyword, results);
        });
        
        await ctx.lark.send(userId, ctx.formatWithCrab(searchResult, 'task_complete'));
        console.log(`✅ 任务完成: ${task.name}`);
        
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: '任务已执行' }));
        
      } catch (e) {
        console.error(`任务执行失败: ${task.name}`, e.message);
        await ctx.lark.send(userId, ctx.formatWithCrab(
          `**${task.name}** 执行失败\n\n❌ 错误: ${e.message}`,
          'task_error'
        ));
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, message: e.message }));
      }
      
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
  });
}

async function handleHistory(req, res, ctx) {
  const userId = ctx.url.searchParams.get('userId');
  const limit = parseInt(ctx.url.searchParams.get('limit') || '20', 10);
  
  if (!userId) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, message: '缺少 userId' }));
    return;
  }
  
  try {
    const messages = await ctx.history.getRecentMessages(userId, limit);
    const stats = await ctx.history.getHistoryStats(userId);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, messages, stats }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, message: e.message }));
  }
}

async function handleHistorySearch(req, res, ctx) {
  const userId = ctx.url.searchParams.get('userId');
  const keyword = ctx.url.searchParams.get('keyword');
  const limit = parseInt(ctx.url.searchParams.get('limit') || '50', 10);
  
  if (!userId || !keyword) {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, message: '缺少 userId 或 keyword' }));
    return;
  }
  
  try {
    const messages = await ctx.history.searchMessages(userId, keyword, limit);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, messages, keyword }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, message: e.message }));
  }
}

async function handleHistoryClear(req, res, ctx) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const errors = validateHistoryClear(data);
      if (errors.length > 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, message: errors.join(', ') }));
        return;
      }
      const { userId } = data;
      
      await ctx.history.clearUserHistory(userId);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, message: '历史记录已清除' }));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
  });
}

async function handleWorkspace(req, res, ctx) {
  const workspaceFiles = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'HEARTBEAT.md', 'MEMORY.md'];
  const result = {};
  
  for (const file of workspaceFiles) {
    const filePath = path.join(ctx.config.WORKSPACE_DIR, file);
    if (ctx.fs.existsSync(filePath)) {
      result[file] = ctx.fs.readFileSync(filePath, 'utf-8');
    }
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

async function handleScheduleTrigger(req, res, ctx) {
  const PORT = process.env.PORT || DEFAULT_PORT;
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const taskId = url.searchParams.get('id');
  
  console.log('[handleScheduleTrigger] 收到请求，taskId:', taskId);
  
  if (!taskId) {
    console.log('[handleScheduleTrigger] 缺少任务ID');
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '缺少任务ID' }));
    return;
  }
  
  const tasks = ctx.schedules.cron || [];
  const task = tasks.find(t => t.id === taskId);
  
  console.log('[handleScheduleTrigger] 查找任务，找到:', !!task);
  
  if (!task) {
    console.log('[handleScheduleTrigger] 任务不存在，taskId:', taskId);
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: '任务不存在' }));
    return;
  }
  
  if (!task.enabled) {
    console.log('[handleScheduleTrigger] 任务已禁用，taskId:', taskId);
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: '任务已禁用，请先启用任务' }));
    return;
  }
  
  try {
    console.log(`🚀 手动触发任务: ${task.name} (${taskId})`);
    
    const result = await ctx.cron.executeWithRetry(task);
    
    console.log('[handleScheduleTrigger] 任务执行完成，结果:', result);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true, 
      message: '任务已触发执行',
      taskId: taskId,
      taskName: task.name,
      result: result
    }));
    
  } catch (error) {
    console.error(`❌ 任务触发失败: ${task.name}`, error.message);
    res.writeHead(500);
    res.end(JSON.stringify({ 
      success: false, 
      error: error.message || '任务执行失败'
    }));
  }
}

// ─── NL 任务解析 API ─────────────────────────────────────────

/**
 * POST /api/tasks/parse-nl
 * 解析自然语言 → 结构化任务配置（不保存）
 */
async function handleTaskParseNL(req, res, _ctx) {
  try {
    const data = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('无效的 JSON')); } });
      req.on('error', reject);
    });

    const text = data?.text || '';
    if (!text.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '缺少 text 字段' }));
      return;
    }

    const { parseNLToTask, getExpertList, SKILL_LIST, CHANNEL_LIST } = require('../tasks/core/nlp-task-parser');
    const result = await parseNLToTask(text);

    if (!result.success) {
      res.writeHead(422);
      res.end(JSON.stringify({ success: false, error: result.error }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      parsed: result.task,
      warnings: result.warnings || undefined,
      available: {
        experts: getExpertList(),
        skills: SKILL_LIST,
        channels: CHANNEL_LIST,
      },
    }));
  } catch (err) {
    console.error('❌ 解析任务 NL 失败:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * POST /api/tasks/from-nl
 * 解析自然语言 → 直接创建任务
 */
async function handleTaskFromNL(req, res, ctx) {
  try {
    const data = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('无效的 JSON')); } });
      req.on('error', reject);
    });

    const text = data?.text || '';
    if (!text.trim()) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '缺少 text 字段' }));
      return;
    }

    const { parseNLToTask } = require('../tasks/core/nlp-task-parser');
    const result = await parseNLToTask(text);

    if (!result.success) {
      res.writeHead(422);
      res.end(JSON.stringify({ success: false, error: result.error }));
      return;
    }

    const parsed = result.task;

    // 构建任务对象
    const task = {
      id: 'tsk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: parsed.name,
      cron: parsed.cron,
      action: 'skill',
      prompt: parsed.prompt,
      skills: parsed.skills || [],
      expert: parsed.expert || null,
      channel: parsed.channel || 'wecom',
      skipHoliday: parsed.skipHoliday || false,
      timezone: parsed.timezone || 'Asia/Shanghai',
      enabled: true,
      type: 'fixed',
      createdAt: Date.now(),
      _source: 'nl',
      _confidence: parsed.confidence || {},
    };

    // 保存到调度器
    const tasks = ctx.schedules.cron || [];
    tasks.push(task);
    ctx.schedules.cron = tasks;
    ctx.config.saveSchedules(ctx.schedules);
    ctx.cron.load(ctx.schedules);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '任务已创建',
      task,
      warnings: result.warnings || undefined,
    }));
  } catch (err) {
    console.error('❌ 从 NL 创建任务失败:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

/**
 * PATCH /schedules/:id/edit-nl
 * 用自然语言修改已有任务
 */
async function handleTaskEditNL(req, res, ctx) {
  try {
    const PORT = process.env.PORT || DEFAULT_PORT;
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const taskId = url.pathname.split('/')[2]; // /schedules/:id/edit-nl → id

    const data = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('无效的 JSON')); } });
      req.on('error', reject);
    });

    const text = data?.text || '';
    if (!text.trim() || !taskId) {
      res.writeHead(400);
      res.end(JSON.stringify({ success: false, error: '缺少 text 或 taskId' }));
      return;
    }

    const tasks = ctx.schedules.cron || [];
    const taskIndex = tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: '任务不存在' }));
      return;
    }

    const existingTask = tasks[taskIndex];
    const { editTaskByNL } = require('../tasks/core/nlp-task-parser');
    const editResult = await editTaskByNL(existingTask, text);

    if (!editResult.success) {
      res.writeHead(422);
      res.end(JSON.stringify({ success: false, error: editResult.error }));
      return;
    }

    // 应用修改
    Object.assign(existingTask, editResult.merged);
    ctx.config.saveSchedules(ctx.schedules);
    ctx.cron.load(ctx.schedules);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: '任务已更新',
      changes: editResult.changes,
      task: existingTask,
    }));
  } catch (err) {
    console.error('❌ NL 编辑任务失败:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ success: false, error: err.message }));
  }
}

module.exports = {
  handleSchedules,
  handleConfirm,
  handleHistory,
  handleHistorySearch,
  handleHistoryClear,
  handleWorkspace,
  handleScheduleTrigger,
  handleTaskParseNL,
  handleTaskFromNL,
  handleTaskEditNL,
  validateSchedules,
  validateConfirm,
  validateHistoryClear,
  REGISTERED_ACTIONS
};
