/**
 * Workflow Handler v2.0
 * 
 * 统一工作流 API 路由
 * 集成 WorkflowEngine + Scheduler + SkillFlow
 */

const { WorkflowEngine } = require('../core/workflow-engine');
const { SkillFlow } = require('../core/skill-flow');
const { Scheduler } = require('../core/scheduler');
const path = require('path');
const { CRABPAW_HOME } = require('../core/path-utils');
const { DEFAULT_PORT } = require('../core/config');

let API_PORT = DEFAULT_PORT;
let workflowEngine = null;
let skillFlow = null;
let scheduler = null;

function initWorkflowHandler(config = {}) {
  if (workflowEngine) {
    console.warn('[workflow-handler] 已初始化，重复调用忽略');
    return;
  }
  API_PORT = config.port || config.apiPort || DEFAULT_PORT;
  workflowEngine = new WorkflowEngine(config);
  skillFlow = new SkillFlow();
  scheduler = new Scheduler();

  workflowEngine.initialize().then(() => {
    console.log('🔄 Workflow Engine 已初始化');
  });

  skillFlow.initialize().then(() => {
    console.log('🔗 SkillFlow 已初始化');
  });

  scheduler.start();
  console.log('⏰ Scheduler 已启动');

  scheduler.register('workflow', async (task) => {
    const workflowId = task.workflowId;
    if (!workflowId) {
      console.warn('⚠️ 调度任务缺少 workflowId');
      return;
    }

    console.log(`⏰ 定时触发工作流: ${workflowId}`);
    await workflowEngine.execute(workflowId, task.input || {}, {
      skillExecutor: task.skillExecutor,
      toolExecutor: task.toolExecutor
    });
  });

  scheduler.register('skill', async (task) => {
    const skillName = task.skill;
    if (!skillName) {
      console.warn('⚠️ 调度任务缺少 skill 名称');
      return { success: false, error: '缺少技能名称' };
    }

    console.log(`⏰ 定时触发技能: ${skillName}`);
    
    return {
      success: true,
      message: `技能 ${skillName} 已触发`,
      taskId: task.id,
      taskName: task.name
    };
  });

  scheduler.register('search', async (task) => {
    const keyword = task.params?.keyword || task.params?.query;
    if (!keyword) {
      console.warn('⚠️ 调度任务缺少搜索关键词');
      return { success: false, error: '缺少搜索关键词' };
    }

    console.log(`⏰ 定时触发搜索: ${keyword}`);
    
    return {
      success: true,
      message: `搜索任务已触发`,
      keyword: keyword,
      taskId: task.id,
      taskName: task.name
    };
  });

  console.log('✅ Workflow Handler v2.0 初始化完成');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('无效的 JSON 数据'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: message }));
}

function getWorkflowId(req) {
  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  
  if (parts.length >= 3) {
    const lastPart = parts[parts.length - 1];
    if (['execute', 'schedule', 'roi', 'stats'].includes(lastPart)) {
      return parts[parts.length - 2];
    }
    return lastPart;
  }
  
  return url.searchParams.get('id');
}

async function handleWorkflows(req, res) {
  try {
    // engine 未初始化（initWorkflowHandler 未调用/初始化失败）时兜底空态，不抛 500
    if (!workflowEngine) {
      console.warn('[workflow-handler] handleWorkflows 调用时引擎未初始化，返回空态');
      return sendJson(res, 200, { success: true, workflows: [], legacyFlows: [], stats: { total: 0 } });
    }
    const workflows = workflowEngine.listWorkflows();
    const legacyFlows = await skillFlow.listFlows();

    sendJson(res, 200, {
      success: true,
      workflows,
      legacyFlows,
      stats: workflowEngine.getStats()
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleWorkflowGet(req, res) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    const workflow = workflowEngine.getWorkflow(workflowId);
    if (!workflow) {
      const legacyFlow = await skillFlow.loadFlow(workflowId);
      if (!legacyFlow) {
        return sendError(res, 404, '工作流不存在');
      }
      return sendJson(res, 200, { success: true, workflow: legacyFlow, legacy: true });
    }

    sendJson(res, 200, { success: true, workflow });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleWorkflowCreate(req, res) {
  try {
    const data = await parseBody(req);

    if (!data.name || !data.name.trim()) {
      return sendError(res, 400, '名称不能为空');
    }

    const workflow = workflowEngine.createWorkflow({
      name: data.name.trim(),
      description: data.description || '',
      trigger: data.trigger || { type: 'manual' },
      conditions: data.conditions || [],
      actions: data.actions || data.steps || [],
      errorHandling: data.errorHandling || {},
      tags: data.tags || []
    });

    await workflowEngine.saveWorkflow(workflow);

    console.log(`✅ 创建工作流: ${workflow.name} (${workflow.id})`);
    sendJson(res, 200, { success: true, workflow });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}

async function handleWorkflowUpdate(req, res) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    const data = await parseBody(req);
    const workflow = workflowEngine.getWorkflow(workflowId);

    if (!workflow) {
      return sendError(res, 404, '工作流不存在');
    }

    if (data.name !== undefined) workflow.name = data.name.trim().slice(0, 100);
    if (data.description !== undefined) workflow.description = data.description.slice(0, 500);
    if (data.trigger !== undefined) workflow.trigger = data.trigger;
    if (data.conditions !== undefined) workflow.conditions = data.conditions;
    if (data.actions !== undefined) workflow.actions = data.actions;
    if (data.steps !== undefined) workflow.actions = data.steps;
    if (data.errorHandling !== undefined) workflow.errorHandling = data.errorHandling;
    if (data.tags !== undefined) workflow.tags = data.tags;
    
    workflow.metadata.updatedAt = new Date().toISOString();

    const saved = await workflowEngine.saveWorkflow(workflow);

    console.log(`💾 保存工作流: ${saved.name}`);
    sendJson(res, 200, { success: true, workflow: saved });
  } catch (e) {
    sendError(res, 400, e.message);
  }
}

async function handleWorkflowDelete(req, res) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    await workflowEngine.deleteWorkflow(workflowId);

    console.log(`🗑️ 删除工作流: ${workflowId}`);
    sendJson(res, 200, { success: true, deleted: true });
  } catch (e) {
    console.error(`❌ 删除失败: ${e.message}`);
    sendError(res, 500, e.message);
  }
}

async function handleWorkflowExecute(req, res, ctx) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    const data = await parseBody(req);
    const workflow = workflowEngine.getWorkflow(workflowId);

    if (!workflow) {
      const legacyFlow = await skillFlow.loadFlow(workflowId);
      if (!legacyFlow) {
        return sendError(res, 404, '工作流不存在');
      }

      return await executeLegacyFlow(legacyFlow, data, ctx, res);
    }

    console.log(`▶️ 执行工作流: ${workflow.name}`);

    const execution = await workflowEngine.execute(workflowId, data.input || data, {
      skillExecutor: async (skillName, params) => {
        if (ctx.skills && ctx.skillsRegistry) {
          try {
            return await ctx.skills.execute(skillName, params, ctx.skillsRegistry);
          } catch (e) {
            console.error(`❌ 技能执行失败 ${skillName}:`, e.message);
            return `技能 ${skillName} 执行失败: ${e.message}`;
          }
        }
        return `技能 ${skillName} 执行完成`;
      },
      toolExecutor: async (toolName, params) => {
        if (ctx.toolSystem) {
          const tool = ctx.toolSystem.get(toolName);
          if (tool) {
            return await tool.handler(params, { projectRoot: process.cwd() });
          }
        }
        return `工具 ${toolName} 执行完成`;
      }
    });

    console.log(`✅ 工作流执行完成: ${execution.status}`);
    sendJson(res, 200, { success: execution.status === 'completed', execution });
  } catch (e) {
    console.error(`❌ 工作流执行错误:`, e.message);
    sendError(res, 500, e.message);
  }
}

async function executeLegacyFlow(flow, data, ctx, res) {
  const steps = data.steps || flow.steps;

  if (!steps || steps.length === 0) {
    return sendError(res, 400, '工作流步骤为空');
  }

  console.log(`▶️ 执行旧版工作流: ${flow.name} (${steps.length} 步骤)`);

  const flowWithSteps = { ...flow, steps };
  
  const result = await skillFlow.executeWithEngine(
    flowWithSteps,
    {},
    workflowEngine,
    {
      skillExecutor: async (skillName, params) => {
        if (ctx.skills && ctx.skillsRegistry) {
          try {
            return await ctx.skills.execute(skillName, params, ctx.skillsRegistry);
          } catch (e) {
            console.error(`❌ 技能执行失败 ${skillName}:`, e.message);
            return `技能 ${skillName} 执行失败: ${e.message}`;
          }
        }
        return `技能 ${skillName} 执行完成`;
      },
      toolExecutor: async (toolName, params) => {
        if (ctx.toolSystem) {
          const tool = ctx.toolSystem.get(toolName);
          if (tool) {
            return await tool.handler(params, { projectRoot: process.cwd() });
          }
        }
        return `工具 ${toolName} 执行完成`;
      }
    }
  );

  console.log(`✅ 旧版工作流执行完成: ${result.success ? '成功' : '部分失败'}`);
  sendJson(res, 200, result);
}

async function handleWorkflowSchedule(req, res, ctx) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    const data = await parseBody(req);
    const workflow = workflowEngine.getWorkflow(workflowId);

    if (!workflow) {
      return sendError(res, 404, '工作流不存在');
    }

    if (!data.cron) {
      return sendError(res, 400, '缺少 cron 表达式');
    }

    const scheduleTask = {
      id: `schedule_${workflowId}`,
      name: `定时执行: ${workflow.name}`,
      cron: data.cron,
      action: 'workflow',
      workflowId,
      input: data.input || {},
      enabled: data.enabled !== false,
      skillExecutor: async (skillName, params) => {
        if (ctx.skills && ctx.skillsRegistry) {
          return await ctx.skills.execute(skillName, params, ctx.skillsRegistry);
        }
      }
    };

    const schedulesPath = path.join(CRABPAW_HOME, 'schedules.json');

    let schedules = { cron: [] };
    if (require('fs').existsSync(schedulesPath)) {
      schedules = JSON.parse(require('fs').readFileSync(schedulesPath, 'utf-8'));
    }

    const existingIndex = schedules.cron.findIndex(s => s.id === scheduleTask.id);
    if (existingIndex >= 0) {
      schedules.cron[existingIndex] = scheduleTask;
    } else {
      schedules.cron.push(scheduleTask);
    }

    require('fs').writeFileSync(schedulesPath, JSON.stringify(schedules, null, 2));

    scheduler.load(schedules);

    console.log(`⏰ 已调度工作流: ${workflow.name} (${data.cron})`);
    sendJson(res, 200, { success: true, schedule: scheduleTask });
  } catch (e) {
    console.error(`❌ 调度失败:`, e.message);
    sendError(res, 500, e.message);
  }
}

async function handleWorkflowROI(req, res) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    const roi = workflowEngine.calculateROI(workflowId);
    if (!roi) {
      return sendError(res, 404, '工作流不存在');
    }

    sendJson(res, 200, { success: true, roi });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleWorkflowStats(req, res) {
  try {
    const stats = workflowEngine.getStats();
    const schedulerStats = scheduler.getStats();

    sendJson(res, 200, {
      success: true,
      workflowEngine: stats,
      scheduler: schedulerStats
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

function getRoutes() {
  return [
    { method: 'GET', path: '/api/workflows', handler: handleWorkflows },
    { method: 'GET', path: '/api/workflows/:id', handler: handleWorkflowGet },
    { method: 'POST', path: '/api/workflows', handler: handleWorkflowCreate },
    { method: 'PUT', path: '/api/workflows/:id', handler: handleWorkflowUpdate },
    { method: 'DELETE', path: '/api/workflows/:id', handler: handleWorkflowDelete },
    { method: 'POST', path: '/api/workflows/:id/execute', handler: handleWorkflowExecute },
    { method: 'POST', path: '/api/workflows/:id/schedule', handler: handleWorkflowSchedule },
    { method: 'GET', path: '/api/workflows/:id/roi', handler: handleWorkflowROI },
    { method: 'GET', path: '/api/workflows/:id/history', handler: handleWorkflowHistory },
    { method: 'GET', path: '/api/workflows/history', handler: handleAllHistory },
    { method: 'GET', path: '/api/workflows/stats', handler: handleWorkflowStats }
  ];
}

async function handleWorkflowHistory(req, res) {
  try {
    const workflowId = getWorkflowId(req);
    if (!workflowId) {
      return sendError(res, 400, '缺少 workflowId');
    }

    const url = new URL(req.url, `http://localhost:${API_PORT}`);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const history = workflowEngine.getWorkflowHistory(workflowId, limit);
    sendJson(res, 200, { success: true, history });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleAllHistory(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${API_PORT}`);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const status = url.searchParams.get('status');

    const history = workflowEngine.getExecutionHistory({ limit, days, status });
    sendJson(res, 200, { success: true, history, total: history.length });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

module.exports = {
  initWorkflowHandler,
  handleWorkflows,
  handleWorkflowGet,
  handleWorkflowCreate,
  handleWorkflowUpdate,
  handleWorkflowDelete,
  handleWorkflowExecute,
  handleWorkflowSchedule,
  handleWorkflowROI,
  handleWorkflowStats,
  handleWorkflowHistory,
  handleAllHistory,
  getRoutes,
  workflowEngine: () => workflowEngine,
  skillFlow: () => skillFlow,
  scheduler: () => scheduler
};
