const taskflow = require('../taskflow');
// eslint-disable-next-line no-unused-vars -- INTENT_TYPES 从 require 解构但未使用
const { getIntentAnalyzer, INTENT_TYPES } = require('../taskflow/intent-analyzer');
const { getConversationIntegration } = require('../core/taskflow-conversation-integration');
const { getLlmProviderManager } = require('../taskflow/llm-provider-manager');
const { getApprovalGate } = require('../taskflow/approval-gate');
const { classifyError } = require('../taskflow/error-classifier');

let initialized = false;
let _runtime = null;

async function initTaskFlowHandler(config = {}) {
  if (initialized) return;

  await taskflow.initializeTaskFlow();

  _runtime = taskflow.getTaskFlowRuntime();

  if (config.skillExecutor) {
    taskflow.setSkillExecutor(config.skillExecutor);
  }

  if (config.taskExecutor) {
    taskflow.setTaskExecutor(config.taskExecutor);
  }

  if (config.broadcastFn) {
    taskflow.setBroadcastFn(config.broadcastFn);
  }

  if (config.skillRouter) {
    taskflow.setSkillRouter(config.skillRouter);
  }

  if (config.taskAdapter) {
    taskflow.setTaskAdapter(config.taskAdapter);
  }

  const integration = getConversationIntegration(_runtime);
  await integration.initialize();

  initialized = true;
  console.log('✅ TaskFlow Handler 初始化完成');
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

async function handleTaskFlowRequest(req, res, pathname) {
  await initTaskFlowHandler();

  try {
    const method = req.method;

    if (pathname === '/api/taskflows' && method === 'GET') {
      return await handleListFlows(req, res);
    }

    if (pathname === '/api/taskflows' && method === 'POST') {
      return await handleCreateFlow(req, res);
    }

    if (pathname === '/api/taskflows/stats' && method === 'GET') {
      return await handleGetStats(req, res);
    }

    if (pathname === '/api/taskflows/metrics' && method === 'GET') {
      return await handleGetMetrics(req, res);
    }

    if (pathname === '/api/taskflows/templates' && method === 'GET') {
      return await handleListTemplates(req, res);
    }

    if (pathname === '/api/taskflows/experts' && method === 'GET') {
      return await handleListExperts(req, res);
    }

    if (pathname === '/api/taskflows/analyze' && method === 'POST') {
      return await handleAnalyzeIntent(req, res);
    }

    if (pathname === '/api/taskflows/recover' && method === 'POST') {
      return await handleRecoverAllFlows(req, res);
    }

    if (pathname === '/api/taskflows/conversation/active' && method === 'GET') {
      return await handleGetActiveFlows(req, res);
    }

    if (pathname === '/api/taskflows/llm/providers' && method === 'GET') {
      return await handleGetLlmProviders(req, res);
    }

    if (pathname === '/api/taskflows/approval/resolve' && method === 'POST') {
      return await handleResolveApproval(req, res);
    }

    if (pathname === '/api/taskflows/classify-error' && method === 'POST') {
      return await handleClassifyError(req, res);
    }

    const flowMatch = pathname.match(/^\/api\/taskflows\/([^/]+)$/);
    if (flowMatch) {
      const flowId = flowMatch[1];

      if (method === 'GET') {
        return await handleGetFlow(req, res, flowId);
      }

      if (method === 'DELETE') {
        return await handleDeleteFlow(req, res, flowId);
      }
    }

    const executeMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/execute$/);
    if (executeMatch && method === 'POST') {
      const flowId = executeMatch[1];
      return await handleExecuteFlow(req, res, flowId);
    }

    const cancelMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const flowId = cancelMatch[1];
      return await handleCancelFlow(req, res, flowId);
    }

    const statusMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/status$/);
    if (statusMatch && method === 'GET') {
      const flowId = statusMatch[1];
      return await handleGetFlowStatus(req, res, flowId);
    }

    const historyMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/history$/);
    if (historyMatch && method === 'GET') {
      const flowId = historyMatch[1];
      return await handleGetFlowHistory(req, res, flowId);
    }

    const retryMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/retry$/);
    if (retryMatch && method === 'POST') {
      const flowId = retryMatch[1];
      return await handleRetryFlow(req, res, flowId);
    }

    const recoverMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/recover$/);
    if (recoverMatch && method === 'POST') {
      const flowId = recoverMatch[1];
      return await handleRecoverFlow(req, res, flowId);
    }

    const stepsMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/steps$/);
    if (stepsMatch && method === 'GET') {
      const flowId = stepsMatch[1];
      return await handleGetFlowSteps(req, res, flowId);
    }

    const resumeMatch = pathname.match(/^\/api\/taskflows\/([^/]+)\/resume$/);
    if (resumeMatch && method === 'POST') {
      const flowId = resumeMatch[1];
      return await handleResumeFlow(req, res, flowId);
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (error) {
    console.error('❌ TaskFlow API 错误:', error);
    sendJson(res, 500, { error: error.message });
  }
}

async function handleListFlows(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const status = url.searchParams.get('status');
  const ownerKey = url.searchParams.get('ownerKey');
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  const filter = {};
  if (status) filter.status = status;
  if (ownerKey) filter.ownerKey = ownerKey;
  if (limit) filter.limit = limit;

  const flows = await taskflow.listFlows(filter);

  sendJson(res, 200, {
    success: true,
    count: flows.length,
    flows
  });
}

async function handleCreateFlow(req, res) {
  const body = await parseBody(req);

  if (!body.goal) {
    return sendJson(res, 400, { error: 'Goal is required' });
  }

  const flow = await taskflow.createFlow({
    ownerKey: body.ownerKey || 'default',
    controllerId: body.controllerId,
    goal: body.goal,
    syncMode: body.syncMode || 'managed',
    notifyPolicy: body.notifyPolicy || 'on_failure',
    stateJson: body.stateJson,
    waitJson: body.waitJson
  });

  sendJson(res, 201, {
    success: true,
    flow
  });
}

async function handleGetFlow(req, res, flowId) {
  const flow = await taskflow.getFlow(flowId);

  if (!flow) {
    return sendJson(res, 404, { error: 'Flow not found' });
  }

  sendJson(res, 200, {
    success: true,
    flow
  });
}

async function handleDeleteFlow(req, res, flowId) {
  const result = await taskflow.deleteFlow(flowId);

  if (!result.success) {
    return sendJson(res, 404, { error: result.error });
  }

  sendJson(res, 200, {
    success: true,
    message: `Flow ${flowId} deleted`
  });
}

async function handleExecuteFlow(req, res, flowId) {
  const body = await parseBody(req);

  try {
    const result = await taskflow.executeFlow(flowId, body.context || {});

    sendJson(res, 200, {
      success: true,
      message: `Flow ${flowId} executed successfully`,
      result
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleCancelFlow(req, res, flowId) {
  try {
    await taskflow.cancelFlow(flowId);

    sendJson(res, 200, {
      success: true,
      message: `Flow ${flowId} cancelled`
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleGetFlowStatus(req, res, flowId) {
  const status = await taskflow.getFlowStatus(flowId);

  if (!status) {
    return sendJson(res, 404, { error: 'Flow not found' });
  }

  sendJson(res, 200, {
    success: true,
    ...status
  });
}

async function handleGetFlowHistory(req, res, flowId) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  const registry = taskflow.getTaskFlowRegistry();
  const history = await registry.getFlowHistory(flowId, limit);

  sendJson(res, 200, {
    success: true,
    count: history.length,
    history
  });
}

async function handleGetStats(req, res) {
  const stats = await taskflow.getStats();

  sendJson(res, 200, {
    success: true,
    stats
  });
}

async function handleGetMetrics(req, res) {
  const runtimeMetrics = taskflow.getMetrics();
  const intentMetrics = taskflow.getIntentMetrics();
  const llmStatuses = taskflow.getLlmProviderStatuses();

  sendJson(res, 200, {
    success: true,
    runtime: runtimeMetrics,
    intent: intentMetrics,
    llmProviders: llmStatuses
  });
}

async function handleListTemplates(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const category = url.searchParams.get('category');

  const analyzer = getIntentAnalyzer();
  const templates = analyzer.getAvailableTemplates(category);

  sendJson(res, 200, {
    success: true,
    count: templates.length,
    templates
  });
}

async function handleListExperts(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const category = url.searchParams.get('category');

  const analyzer = getIntentAnalyzer();
  const experts = analyzer.getAvailableExperts(category);

  sendJson(res, 200, {
    success: true,
    count: experts.length,
    experts
  });
}

async function handleAnalyzeIntent(req, res) {
  const body = await parseBody(req);

  if (!body.message) {
    return sendJson(res, 400, { error: 'Message is required' });
  }

  try {
    const analyzer = getIntentAnalyzer();
    const suggestion = analyzer.suggest(body.message, { userId: body.userId });

    sendJson(res, 200, {
      success: true,
      suggestion: {
        intentType: suggestion.intentType,
        confidence: suggestion.confidence,
        shouldCreateFlow: suggestion.shouldCreateFlow,
        skillHint: suggestion.skillHint,
        expertHint: suggestion.expertHint,
        templateHint: suggestion.templateHint,
        reasoning: suggestion.reasoning,
        flowParams: suggestion.flowParams ? {
          goal: suggestion.flowParams.goal,
          syncMode: suggestion.flowParams.syncMode,
          metadata: suggestion.flowParams.metadata
        } : null
      }
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleRetryFlow(req, res, flowId) {
  try {
    const flow = await taskflow.getFlow(flowId);

    if (!flow) {
      return sendJson(res, 404, { error: 'Flow not found' });
    }

    if (flow.status !== 'failed') {
      return sendJson(res, 400, { error: `Flow status is '${flow.status}', only failed flows can be retried` });
    }

    const result = await taskflow.executeFlow(flowId, {});

    sendJson(res, 200, {
      success: true,
      message: `Flow ${flowId} retry initiated`,
      result
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleRecoverFlow(req, res, flowId) {
  try {
    const flow = await taskflow.getFlow(flowId);

    if (!flow) {
      return sendJson(res, 404, { error: 'Flow not found' });
    }

    if (!['lost', 'failed'].includes(flow.status)) {
      return sendJson(res, 400, { error: `Flow status is '${flow.status}', only lost/failed flows can be recovered` });
    }

    const result = await taskflow.executeFlow(flowId, {});

    sendJson(res, 200, {
      success: true,
      message: `Flow ${flowId} recovery initiated`,
      result
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleRecoverAllFlows(req, res) {
  try {
    const recovered = await taskflow.recoverLostFlows();

    sendJson(res, 200, {
      success: true,
      message: `Recovered ${recovered.length} flows`,
      recoveredFlows: recovered
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleGetFlowSteps(req, res, flowId) {
  try {
    const flow = await taskflow.getFlow(flowId);

    if (!flow) {
      return sendJson(res, 404, { error: 'Flow not found' });
    }

    const store = taskflow.getTaskFlowStore();
    const tasks = await store.getTasksByFlow(flowId);

    const steps = (tasks || []).map(t => ({
      stepId: t.stepId,
      type: t.type,
      status: t.status,
      result: t.result,
      error: t.error,
      errorCategory: t.errorCategory || null,
      retryCount: t.retryCount || 0,
      createdAt: t.createdAt,
      completedAt: t.completedAt
    }));

    const stateJson = flow.stateJson || {};
    const definedSteps = stateJson.steps || [];

    sendJson(res, 200, {
      success: true,
      flowId,
      definedSteps,
      executedSteps: steps,
      totalDefined: definedSteps.length,
      totalExecuted: steps.length,
      progress: definedSteps.length > 0
        ? Math.round((steps.filter(s => s.status === 'completed').length / definedSteps.length) * 100)
        : 0
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleGetActiveFlows(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');

    const integration = getConversationIntegration(_runtime);
    const activeFlows = userId
      ? integration.getActiveFlowsForUser(userId)
      : [];

    sendJson(res, 200, {
      success: true,
      activeCount: integration.getActiveFlowCount(),
      activeFlows
    });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error.message });
  }
}

async function handleResumeFlow(req, res, flowId) {
  const body = await parseBody(req);

  if (!body.resumeToken) {
    return sendJson(res, 400, { error: 'resumeToken is required' });
  }

  try {
    const result = await taskflow.resumeFlow(body.resumeToken, {
      approved: body.approved !== false,
      comment: body.comment || ''
    });

    sendJson(res, 200, {
      success: true,
      message: `Flow ${flowId} resumed`,
      result
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleResolveApproval(req, res) {
  const body = await parseBody(req);

  if (!body.approvalId) {
    return sendJson(res, 400, { error: 'approvalId is required' });
  }

  try {
    const approvalGate = getApprovalGate();
    const result = await approvalGate.resolve(
      body.approvalId,
      body.approved !== false,
      body.result || null
    );

    sendJson(res, 200, {
      success: true,
      approval: result
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleGetLlmProviders(req, res) {
  try {
    const manager = getLlmProviderManager();
    const statuses = manager.getAllProviderStatuses();

    sendJson(res, 200, {
      success: true,
      providers: statuses,
      activeProvider: manager.getActiveProvider()
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

async function handleClassifyError(req, res) {
  const body = await parseBody(req);

  if (!body.error) {
    return sendJson(res, 400, { error: 'error is required' });
  }

  try {
    const error = new Error(body.error.message || body.error);
    if (body.error.code) error.code = body.error.code;
    if (body.error.statusCode) error.statusCode = body.error.statusCode;

    const classification = classifyError(error);

    sendJson(res, 200, {
      success: true,
      classification
    });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error.message
    });
  }
}

module.exports = {
  initTaskFlowHandler,
  handleTaskFlowRequest
};
