const taskflow = require('../taskflow');
const { getIntentAnalyzer } = require('../taskflow/intent-analyzer');
// eslint-disable-next-line no-unused-vars
const { getConversationIntegration } = require('./taskflow-conversation-integration');
const { broadcastEvent } = require('./sse-broadcast');

const FLOW_TOOL_ACTIONS = {
  CREATE: 'create',
  EXECUTE: 'execute',
  STATUS: 'status',
  LIST: 'list',
  CANCEL: 'cancel',
  RETRY: 'retry',
  RECOVER: 'recover',
  ANALYZE: 'analyze',
  TEMPLATES: 'templates',
  EXPERTS: 'experts',
  METRICS: 'metrics',
  APPROVE: 'approve',
  RESUME: 'resume',
  LLM_STATUS: 'llm_status',
  CLASSIFY_ERROR: 'classify_error'
};

function createTaskFlowToolContext(sessionKey, deliveryContext) {
  const ownerKey = sessionKey || 'agent:main:main';
  const origin = deliveryContext || {};

  return {
    sessionKey: ownerKey,
    requesterOrigin: origin,

    async createManaged(params) {
      const flow = await taskflow.createFlow({
        ownerKey,
        controllerId: params.controllerId || 'conversation-agent',
        goal: params.goal,
        syncMode: params.syncMode || 'managed',
        notifyPolicy: params.notifyPolicy || 'on_failure',
        stateJson: params.stateJson || null,
        waitJson: params.waitJson || null
      });

      broadcastEvent('taskflow_created', {
        flowId: flow.flowId,
        goal: params.goal,
        ownerKey,
        timestamp: Date.now()
      });

      return flow;
    },

    async runTask(params) {
      const flowId = params.flowId;
      if (!flowId) {
        throw new Error('flowId is required for runTask');
      }

      const result = await taskflow.executeFlow(flowId, {
        originalMessage: params.task,
        ...params.context
      });

      return result;
    },

    async getStatus(flowId) {
      return await taskflow.getFlowStatus(flowId);
    },

    async listFlows(filter) {
      return await taskflow.listFlows({ ownerKey, ...filter });
    },

    async cancelFlow(flowId) {
      return await taskflow.cancelFlow(flowId);
    },

    async retryFlow(flowId) {
      const flow = await taskflow.getFlowStatus(flowId);
      if (flow && flow.flow && flow.flow.status) {
        const registry = taskflow.getTaskFlowRegistry();
        await registry.updateFlow(flowId, { status: taskflow.TASKFLOW_STATUS.QUEUED });
      }
      return await taskflow.executeFlow(flowId, {});
    },

    async recoverFlow(flowId) {
      return await taskflow.executeFlow(flowId, {});
    },

    async recoverAllFlows() {
      return await taskflow.recoverLostFlows();
    },

    async resumeFlow(resumeToken, approvalResult) {
      return await taskflow.resumeFlow(resumeToken, approvalResult);
    },

    async resolveApproval(approvalId, approved, result) {
      const approvalGate = taskflow.getApprovalGate();
      return await approvalGate.resolve(approvalId, approved, result);
    },

    getLlmProviderStatuses() {
      return taskflow.getLlmProviderStatuses();
    },

    classifyError(error) {
      return taskflow.classifyWorkflowError(error);
    }
  };
}

async function handleTaskFlowToolAction(action, params, context) {
  const ctx = createTaskFlowToolContext(
    context?.sessionKey,
    context?.deliveryContext
  );

  switch (action) {
    case FLOW_TOOL_ACTIONS.CREATE: {
      if (!params.goal) {
        return { success: false, error: 'goal is required' };
      }

      const flow = await ctx.createManaged({
        goal: params.goal,
        controllerId: params.controllerId,
        syncMode: params.syncMode,
        notifyPolicy: params.notifyPolicy,
        stateJson: params.stateJson,
        waitJson: params.waitJson
      });

      if (params.autoExecute !== false) {
        ctx.runTask({
          flowId: flow.flowId,
          task: params.goal
        }).then(_result => {
          broadcastEvent('taskflow_completed', {
            flowId: flow.flowId,
            success: true,
            timestamp: Date.now()
          });
        }).catch(error => {
          broadcastEvent('taskflow_failed', {
            flowId: flow.flowId,
            error: error.message,
            timestamp: Date.now()
          });
        });
      }

      return {
        success: true,
        flowId: flow.flowId,
        goal: params.goal,
        status: flow.status,
        autoExecuted: params.autoExecute !== false
      };
    }

    case FLOW_TOOL_ACTIONS.EXECUTE: {
      if (!params.flowId) {
        return { success: false, error: 'flowId is required' };
      }
      const result = await ctx.runTask({
        flowId: params.flowId,
        task: params.task || params.goal
      });
      return { success: true, flowId: params.flowId, result };
    }

    case FLOW_TOOL_ACTIONS.STATUS: {
      if (!params.flowId) {
        return { success: false, error: 'flowId is required' };
      }
      const status = await ctx.getStatus(params.flowId);
      return { success: true, status };
    }

    case FLOW_TOOL_ACTIONS.LIST: {
      const flows = await ctx.listFlows(params.filter);
      return { success: true, flows };
    }

    case FLOW_TOOL_ACTIONS.CANCEL: {
      if (!params.flowId) {
        return { success: false, error: 'flowId is required' };
      }
      await ctx.cancelFlow(params.flowId);
      return { success: true, flowId: params.flowId, cancelled: true };
    }

    case FLOW_TOOL_ACTIONS.RETRY: {
      if (!params.flowId) {
        return { success: false, error: 'flowId is required' };
      }
      const result = await ctx.retryFlow(params.flowId);
      return { success: true, flowId: params.flowId, result };
    }

    case FLOW_TOOL_ACTIONS.RECOVER: {
      if (params.flowId) {
        const result = await ctx.recoverFlow(params.flowId);
        return { success: true, flowId: params.flowId, result };
      }
      const recovered = await ctx.recoverAllFlows();
      return { success: true, recovered };
    }

    case FLOW_TOOL_ACTIONS.ANALYZE: {
      if (!params.message) {
        return { success: false, error: 'message is required' };
      }
      const analyzer = getIntentAnalyzer();
      const suggestion = analyzer.suggest(params.message, { userId: context?.userId });

      return {
        success: true,
        suggestion: {
          intentType: suggestion.intentType,
          confidence: suggestion.confidence,
          shouldCreateFlow: suggestion.shouldCreateFlow,
          skillHint: suggestion.skillHint,
          expertHint: suggestion.expertHint,
          templateHint: suggestion.templateHint,
          reasoning: suggestion.reasoning
        }
      };
    }

    case FLOW_TOOL_ACTIONS.TEMPLATES: {
      const analyzer = getIntentAnalyzer();
      const templates = analyzer.getAvailableTemplates(params.category);
      return { success: true, templates };
    }

    case FLOW_TOOL_ACTIONS.EXPERTS: {
      const analyzer = getIntentAnalyzer();
      const experts = analyzer.getAvailableExperts(params.category);
      return { success: true, experts };
    }

    case FLOW_TOOL_ACTIONS.METRICS: {
      const runtimeMetrics = taskflow.getMetrics();
      const intentMetrics = taskflow.getIntentMetrics();
      const llmStatuses = ctx.getLlmProviderStatuses();
      return {
        success: true,
        runtime: runtimeMetrics,
        intent: intentMetrics,
        llmProviders: llmStatuses
      };
    }

    case FLOW_TOOL_ACTIONS.APPROVE: {
      if (!params.approvalId) {
        return { success: false, error: 'approvalId is required' };
      }
      const result = await ctx.resolveApproval(
        params.approvalId,
        params.approved !== false,
        params.result || null
      );
      return { success: true, approval: result };
    }

    case FLOW_TOOL_ACTIONS.RESUME: {
      if (!params.resumeToken) {
        return { success: false, error: 'resumeToken is required' };
      }
      const result = await ctx.resumeFlow(params.resumeToken, {
        approved: params.approved !== false,
        comment: params.comment || ''
      });
      return { success: true, resumed: result };
    }

    case FLOW_TOOL_ACTIONS.LLM_STATUS: {
      const statuses = ctx.getLlmProviderStatuses();
      return { success: true, providers: statuses };
    }

    case FLOW_TOOL_ACTIONS.CLASSIFY_ERROR: {
      if (!params.errorMessage) {
        return { success: false, error: 'errorMessage is required' };
      }
      const error = new Error(params.errorMessage);
      if (params.errorCode) error.code = params.errorCode;
      if (params.errorStatusCode) error.statusCode = params.errorStatusCode;

      const classification = ctx.classifyError(error);
      return { success: true, classification };
    }

    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
}

function getTaskFlowToolDefinition() {
  return {
    name: 'taskflow',
    description: 'TaskFlow 工作流管理工具。当用户的需求需要多个步骤协调完成、涉及多个技能组合、或匹配到已知工作流模板时使用。支持创建、执行、查询、取消工作流，审批恢复，LLM Provider 状态查询，错误分类，以及分析用户意图和浏览模板/专家库。',
    parameters: {
      action: {
        type: 'string',
        enum: Object.values(FLOW_TOOL_ACTIONS),
        description: '操作类型: create(创建工作流), execute(执行工作流), status(查询状态), list(列出工作流), cancel(取消), retry(重试), recover(恢复), analyze(分析意图), templates(列出模板), experts(列出专家), metrics(监控指标), approve(审批), resume(恢复审批), llm_status(LLM状态), classify_error(错误分类)'
      },
      goal: {
        type: 'string',
        description: '工作流目标描述（create时必填）'
      },
      flowId: {
        type: 'string',
        description: '工作流ID（execute/status/cancel/retry时必填）'
      },
      stateJson: {
        type: 'object',
        description: '结构化步骤定义（可选，包含steps数组）'
      },
      message: {
        type: 'string',
        description: '待分析的用户消息（analyze时必填）'
      },
      category: {
        type: 'string',
        description: '模板/专家分类筛选（templates/experts时可选）'
      },
      autoExecute: {
        type: 'boolean',
        description: '创建后是否自动执行（默认true）'
      },
      controllerId: {
        type: 'string',
        description: '控制器ID（可选）'
      },
      approvalId: {
        type: 'string',
        description: '审批ID（approve时必填）'
      },
      approved: {
        type: 'boolean',
        description: '是否批准（approve/resume时，默认true）'
      },
      resumeToken: {
        type: 'string',
        description: '恢复令牌（resume时必填）'
      },
      errorMessage: {
        type: 'string',
        description: '错误消息（classify_error时必填）'
      },
      errorCode: {
        type: 'string',
        description: '错误代码（classify_error时可选）'
      },
      errorStatusCode: {
        type: 'number',
        description: 'HTTP状态码（classify_error时可选）'
      }
    },
    required: ['action']
  };
}

module.exports = {
  createTaskFlowToolContext,
  handleTaskFlowToolAction,
  getTaskFlowToolDefinition,
  FLOW_TOOL_ACTIONS
};
