const { EventEmitter } = require('events');
const { broadcastEvent } = require('./sse-broadcast');

const FLOW_STATUS_LABELS = {
  queued: '排队中',
  running: '执行中',
  waiting: '等待中',
  blocked: '已阻塞',
  succeeded: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  lost: '已丢失'
};

class ConversationIntegration extends EventEmitter {
  constructor(runtime) {
    super();
    this._runtime = runtime;
    this._activeFlows = new Map();
    this._completionCallbacks = new Map();
    this._initialized = false;
    this._boundRuntime = null;
    this._runtimeListeners = [];
  }

  _unbindRuntimeEvents() {
    if (this._boundRuntime && this._runtimeListeners.length > 0) {
      for (const { event, listener } of this._runtimeListeners) {
        this._boundRuntime.off(event, listener);
      }
      this._runtimeListeners = [];
      this._boundRuntime = null;
    }
  }

  _bindRuntimeEvents(runtime) {
    this._unbindRuntimeEvents();
    this._boundRuntime = runtime;

    const events = [
      'taskflow_started',
      'taskflow_completed',
      'taskflow_failed',
      'taskflow_cancelled',
      'taskflow_step_started',
      'taskflow_step_completed',
      'taskflow_step_failed',
      'taskflow_approval_requested',
      'taskflow_approval_resolved',
      'taskflow_resumed',
      'taskflow_recovered',
      'taskflow_step_waiting_approval'
    ];

    for (const event of events) {
      const listener = (data) => this._onRuntimeEvent(event, data);
      runtime.on(event, listener);
      this._runtimeListeners.push({ event, listener });
    }
  }

  async initialize() {
    // If already bound to same runtime, skip re-init
    if (this._initialized && this._boundRuntime === this._runtime && this._runtime) return;

    // Lazy-load taskflow runtime singleton if not explicitly passed
    if (!this._runtime) {
      try {
        const { getTaskFlowRuntime } = require('../taskflow');
        const runtime = getTaskFlowRuntime();
        if (runtime) {
          this._runtime = runtime;
        }
      } catch (e) {
        console.warn('[ConversationIntegration] Could not lazy-load taskflow runtime:', e.message);
      }
    }

    if (this._runtime) {
      this._bindRuntimeEvents(this._runtime);
    }

    this._initialized = true;
    console.log('✅ ConversationIntegration 事件驱动模式初始化完成 (runtime bound)');
  }
  registerFlow(flowId, context = {}) {
    this._activeFlows.set(flowId, {
      flowId,
      userId: context.userId,
      conversationId: context.conversationId,
      goal: context.goal,
      createdAt: Date.now(),
      lastStatus: 'queued',
      lastUpdate: Date.now(),
      stepProgress: {}
    });

    if (context.onComplete) {
      this._completionCallbacks.set(flowId, context.onComplete);
    }

    this.emit('flow_registered', { flowId, context });
  }

  unregisterFlow(flowId) {
    this._activeFlows.delete(flowId);
    this._completionCallbacks.delete(flowId);
    this.emit('flow_unregistered', { flowId });
  }

  async getFlowStatusForConversation(flowId) {
    try {
      if (!this._runtime) return null;

      const status = await this._runtime.getFlowStatus(flowId);
      if (!status) return null;

      const flow = status.flow || {};

      return {
        flowId,
        status: flow.status,
        statusLabel: FLOW_STATUS_LABELS[flow.status] || flow.status,
        goal: flow.goal,
        progress: status.progress || 0,
        currentStep: flow.currentStep || null,
        completedSteps: status.completedStepCount || 0,
        totalSteps: status.stepCount || 0,
        error: flow.blockedSummary || null,
        errorCategory: flow.errorCategory || null,
        result: null
      };
    } catch (e) {
      return null;
    }
  }

  formatStatusMessage(statusInfo) {
    if (!statusInfo) return '';

    const { statusLabel, goal, progress, currentStep, completedSteps, totalSteps, error } = statusInfo;

    const parts = [`📋 工作流: ${goal || '未命名'}`];
    parts.push(`状态: ${statusLabel}`);

    if (totalSteps > 0) {
      parts.push(`进度: ${completedSteps}/${totalSteps} 步骤${progress > 0 ? ` (${progress}%)` : ''}`);
    }

    if (currentStep) {
      parts.push(`当前步骤: ${currentStep}`);
    }

    if (error) {
      parts.push(`错误: ${error}`);
    }

    return parts.join(' | ');
  }

  formatCompletionMessage(statusInfo) {
    if (!statusInfo) return '';

    const { status, goal, result, error, completedSteps, totalSteps, errorCategory } = statusInfo;

    if (status === 'succeeded') {
      const parts = [`✅ 工作流已完成: ${goal || '未命名'}`];
      if (totalSteps > 0) {
        parts.push(`共完成 ${completedSteps}/${totalSteps} 个步骤`);
      }
      if (result) {
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        if (resultStr.length <= 200) {
          parts.push(`结果: ${resultStr}`);
        } else {
          parts.push(`结果: ${resultStr.substring(0, 200)}...`);
        }
      }
      return parts.join('\n');
    }

    if (status === 'failed') {
      const parts = [`❌ 工作流执行失败: ${goal || '未命名'}`];
      if (error) {
        parts.push(`原因: ${error}`);
      }
      if (errorCategory) {
        parts.push(`错误分类: ${errorCategory}`);
      }
      parts.push('你可以让我重试或调整方案。');
      return parts.join('\n');
    }

    if (status === 'cancelled') {
      return `🚫 工作流已取消: ${goal || '未命名'}`;
    }

    return this.formatStatusMessage(statusInfo);
  }

  _onRuntimeEvent(eventType, data) {
    if (!data || !data.flowId) return;

    const flowEntry = this._activeFlows.get(data.flowId);

    switch (eventType) {
      case 'taskflow_started': {
        if (flowEntry) {
          flowEntry.lastStatus = 'running';
          flowEntry.lastUpdate = Date.now();
        }

        this.emit('flow_status_changed', {
          flowId: data.flowId,
          status: 'running',
          goal: data.goal,
          timestamp: data.timestamp
        });

        broadcastEvent('taskflow_status_update', {
          flowId: data.flowId,
          status: 'running',
          message: `🚀 工作流已启动: ${data.goal || '未命名'}`,
          timestamp: data.timestamp
        });
        break;
      }

      case 'taskflow_step_completed': {
        if (flowEntry) {
          flowEntry.stepProgress[data.stepId] = 'completed';
          flowEntry.lastUpdate = Date.now();
        }

        this.emit('flow_step_update', {
          flowId: data.flowId,
          stepId: data.stepId,
          stepType: data.stepType,
          status: 'completed',
          progress: data.progress,
          timestamp: data.timestamp
        });

        broadcastEvent('taskflow_status_update', {
          flowId: data.flowId,
          status: 'running',
          stepId: data.stepId,
          progress: data.progress,
          message: `✅ 步骤 ${data.stepId} 完成 (${data.progress}%)`,
          timestamp: data.timestamp
        });
        break;
      }

      case 'taskflow_step_failed': {
        if (flowEntry) {
          flowEntry.stepProgress[data.stepId] = 'failed';
          flowEntry.lastUpdate = Date.now();
        }

        this.emit('flow_step_update', {
          flowId: data.flowId,
          stepId: data.stepId,
          stepType: data.stepType,
          status: 'failed',
          error: data.error,
          errorCategory: data.errorCategory,
          strategy: data.strategy,
          timestamp: data.timestamp
        });

        broadcastEvent('taskflow_status_update', {
          flowId: data.flowId,
          status: 'running',
          stepId: data.stepId,
          message: `⚠️ 步骤 ${data.stepId} 失败: ${data.error}`,
          timestamp: data.timestamp
        });
        break;
      }

      case 'taskflow_completed':
      case 'taskflow_failed':
      case 'taskflow_cancelled': {
        const statusMap = {
          taskflow_completed: 'succeeded',
          taskflow_failed: 'failed',
          taskflow_cancelled: 'cancelled'
        };
        const newStatus = statusMap[eventType];

        if (flowEntry) {
          const prevStatus = flowEntry.lastStatus;
          flowEntry.lastStatus = newStatus;
          flowEntry.lastUpdate = Date.now();

          const justCompleted = !['succeeded', 'failed', 'cancelled'].includes(prevStatus);

          if (justCompleted) {
            const callback = this._completionCallbacks.get(data.flowId);
            if (callback) {
              try {
                callback({
                  flowId: data.flowId,
                  status: newStatus,
                  goal: data.goal,
                  error: data.error,
                  errorCategory: data.errorCategory
                });
              } catch (e) {
                console.warn('⚠️ 工作流完成回调异常:', e.message);
              }
            }

            const completionMessage = this.formatCompletionMessage({
              flowId: data.flowId,
              status: newStatus,
              goal: data.goal,
              error: data.error,
              errorCategory: data.errorCategory
            });

            this.emit('flow_completed', {
              flowId: data.flowId,
              status: newStatus,
              goal: data.goal,
              message: completionMessage,
              timestamp: data.timestamp
            });

            broadcastEvent('taskflow_status_update', {
              flowId: data.flowId,
              status: newStatus,
              message: completionMessage,
              timestamp: data.timestamp
            });

            this.unregisterFlow(data.flowId);
          }
        } else {
          this.emit('flow_completed', {
            flowId: data.flowId,
            status: newStatus,
            goal: data.goal,
            timestamp: data.timestamp
          });

          broadcastEvent('taskflow_status_update', {
            flowId: data.flowId,
            status: newStatus,
            message: this.formatCompletionMessage({
              flowId: data.flowId,
              status: newStatus,
              goal: data.goal,
              error: data.error
            }),
            timestamp: data.timestamp
          });
        }
        break;
      }

      case 'taskflow_approval_requested': {
        if (flowEntry) {
          flowEntry.lastStatus = 'waiting_approval';
          flowEntry.lastUpdate = Date.now();
        }

        this.emit('flow_approval_needed', {
          flowId: data.flowId,
          stepId: data.stepId,
          approvalId: data.approvalId,
          message: data.message,
          resumeToken: data.resumeToken,
          expiresAt: data.expiresAt,
          timestamp: data.timestamp
        });

        broadcastEvent('taskflow_approval', {
          flowId: data.flowId,
          approvalId: data.approvalId,
          message: data.message,
          resumeToken: data.resumeToken,
          expiresAt: data.expiresAt,
          timestamp: data.timestamp
        });
        break;
      }

      case 'taskflow_approval_resolved': {
        this.emit('flow_approval_resolved', {
          flowId: data.flowId,
          stepId: data.stepId,
          approvalId: data.approvalId,
          approved: data.approved,
          timestamp: data.timestamp
        });
        break;
      }

      case 'taskflow_resumed': {
        if (flowEntry) {
          flowEntry.lastStatus = 'running';
          flowEntry.lastUpdate = Date.now();
        }

        this.emit('flow_resumed', {
          flowId: data.flowId,
          resumedFromStep: data.resumedFromStep,
          timestamp: data.timestamp
        });
        break;
      }

      case 'taskflow_recovered': {
        this.emit('flow_recovered', {
          flowId: data.flowId,
          count: data.count,
          timestamp: data.timestamp
        });
        break;
      }
    }
  }

  handleRuntimeEvent(eventType, data) {
    this._onRuntimeEvent(eventType, data);
  }

  async buildWorkflowContextForPrompt(userId) {
    const activeFlows = [];
    for (const [flowId, entry] of this._activeFlows) {
      if (entry.userId === userId) {
        const statusInfo = await this.getFlowStatusForConversation(flowId);
        if (statusInfo && !['succeeded', 'failed', 'cancelled'].includes(statusInfo.status)) {
          activeFlows.push(statusInfo);
        }
      }
    }

    if (activeFlows.length === 0) return '';

    const lines = ['\n\n[当前活跃工作流]'];
    for (const flow of activeFlows) {
      lines.push(`- ${flow.goal}: ${flow.statusLabel}${flow.currentStep ? ` (当前: ${flow.currentStep})` : ''}`);
    }
    lines.push('用户可能询问工作流进度，你可以使用 taskflow 工具的 status 操作查询详情。');

    return lines.join('\n');
  }

  getActiveFlowCount() {
    return this._activeFlows.size;
  }

  getActiveFlowsForUser(userId) {
    const flows = [];
    for (const [, entry] of this._activeFlows) {
      if (entry.userId === userId) {
        flows.push(entry);
      }
    }
    return flows;
  }
}

let integrationInstance = null;
let integrationRuntime = null;

function getConversationIntegration(runtime) {
  if (!integrationInstance) {
    integrationInstance = new ConversationIntegration(runtime);
    integrationRuntime = runtime || null;
  } else if (runtime && integrationRuntime !== runtime) {
    console.warn('⚠️ ConversationIntegration 单例已初始化，忽略新的 runtime 参数。如需更换 runtime，请先重置实例。');
  }
  return integrationInstance;
}

module.exports = {
  ConversationIntegration,
  getConversationIntegration
};
