const { registry } = require('./registry');
const { handleTaskFlowToolAction, FLOW_TOOL_ACTIONS } = require('../core/taskflow-tool-bridge');

registry.register({
  name: 'taskflow',
  toolset: 'workflow',
  category: 'workflow',
  description: 'TaskFlow 工作流管理工具。当用户需求需要多步骤协调、多技能组合、或匹配工作流模板时使用。支持创建/执行/查询/取消工作流，审批恢复，LLM状态查询，错误分类，分析意图，浏览模板和专家库。',
  schema: {
    type: 'object',
    description: 'TaskFlow 工作流管理工具',
    parameters: {
      type: 'object',
      properties: {
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
        syncMode: {
          type: 'string',
          enum: ['managed', 'task_mirrored'],
          description: '同步模式（可选，默认managed）'
        },
        notifyPolicy: {
          type: 'string',
          enum: ['always', 'on_failure', 'never'],
          description: '通知策略（可选，默认on_failure）'
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
    }
  },
  handler: async (params, context) => {
    const { action, ...rest } = params;
    if (!action) {
      return { success: false, error: 'action is required' };
    }
    return await handleTaskFlowToolAction(action, rest, context);
  },
  checkFn: (params) => {
    return !!params.action;
  },
  timeout: 120000,
  isReadOnly: false,
  isDangerous: false
});
