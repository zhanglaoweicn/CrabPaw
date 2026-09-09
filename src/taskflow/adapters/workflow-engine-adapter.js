const { BaseAdapter } = require('./base-adapter');

class WorkflowEngineAdapter extends BaseAdapter {
  constructor() {
    super();
  }

  convertToTaskFlow(workflow) {
    if (!workflow || !workflow.id) {
      throw new Error('无效的 WorkflowEngine 工作流数据');
    }

    const steps = [];

    if (workflow.conditions && workflow.conditions.length > 0) {
      const conditionStep = this._convertConditions(workflow.conditions);
      steps.push(conditionStep);
    }

    if (workflow.actions && workflow.actions.length > 0) {
      for (const action of workflow.actions) {
        const actionSteps = this._convertAction(action);
        steps.push(...actionSteps);
      }
    }

    const goal = steps.map(s => this._stepToString(s)).join('\n');

    return {
      goal,
      syncMode: 'managed',
      ownerKey: 'workflow-engine',
      notifyPolicy: this._convertNotifyPolicy(workflow.errorHandling),
      metadata: this._buildMetadata(workflow, 'workflow-engine'),
      stateJson: {
        originalWorkflow: {
          id: workflow.id,
          name: workflow.name,
          trigger: workflow.trigger,
          stats: workflow.stats
        }
      }
    };
  }

  convertFromTaskFlow(taskflow) {
    if (!taskflow || !taskflow.flowId) {
      throw new Error('无效的 TaskFlow 数据');
    }

    const steps = this._parseGoalString(taskflow.goal);
    const workflow = {
      id: taskflow.metadata?.originalId || taskflow.flowId,
      name: taskflow.stateJson?.originalWorkflow?.name || '迁移的工作流',
      trigger: taskflow.stateJson?.originalWorkflow?.trigger || { type: 'manual' },
      conditions: [],
      actions: [],
      errorHandling: this._convertFromNotifyPolicy(taskflow.notifyPolicy),
      stats: taskflow.stateJson?.originalWorkflow?.stats || {
        totalRuns: 0,
        successRuns: 0,
        failedRuns: 0,
        totalDuration: 0
      }
    };

    for (const step of steps) {
      if (step.type === 'condition') {
        workflow.conditions.push({
          type: 'expression',
          expression: step.condition
        });
      } else if (step.type === 'skill' || step.type === 'task') {
        workflow.actions.push(this._convertStepToAction(step));
      }
    }

    return workflow;
  }

  _convertConditions(conditions) {
    const expressions = conditions.map(c => {
      switch (c.type) {
        case 'expression':
          return c.expression;
        case 'time':
          return `time:${c.operator}:${c.value}`;
        case 'event':
          return `event:${c.eventType}`;
        default:
          return c.expression || 'true';
      }
    });

    return {
      type: 'condition',
      condition: expressions.join(' && ')
    };
  }

  _convertAction(action) {
    const steps = [];

    switch (action.type) {
      case 'skill':
        steps.push({
          type: 'skill',
          skill: action.skill,
          input: this._buildInputString(action.params)
        });
        break;

      case 'task':
        steps.push({
          type: 'task',
          taskId: action.taskId,
          input: this._buildInputString(action.params)
        });
        break;

      case 'notification':
        steps.push({
          type: 'skill',
          skill: 'send_notification',
          input: `message=${action.message || ''}`
        });
        break;

      case 'webhook':
        steps.push({
          type: 'webhook',
          url: action.url,
          input: action.body ? JSON.stringify(action.body) : ''
        });
        break;

      case 'delay':
        steps.push({
          type: 'delay',
          duration: action.duration || 1000
        });
        break;

      case 'parallel':
        if (action.actions && action.actions.length > 0) {
          const branches = action.actions.map(a => this._convertAction(a));
          steps.push({
            type: 'parallel',
            branches
          });
        }
        break;

      case 'sequence':
        if (action.actions && action.actions.length > 0) {
          for (const a of action.actions) {
            steps.push(...this._convertAction(a));
          }
        }
        break;

      default:
        steps.push({
          type: 'skill',
          skill: action.type,
          input: this._buildInputString(action.params)
        });
    }

    return steps;
  }

  _convertStepToAction(step) {
    const action = {
      type: step.type,
      params: {}
    };

    if (step.type === 'skill') {
      action.skill = step.skill;
    } else if (step.type === 'task') {
      action.taskId = step.taskId;
    }

    if (step.input) {
      action.params = this._parseInputString(step.input);
    }

    return action;
  }

  _buildInputString(params) {
    if (!params || typeof params !== 'object') {
      return '';
    }

    const parts = [];
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        parts.push(`${key}=${value}`);
      } else {
        parts.push(`${key}=${JSON.stringify(value)}`);
      }
    }

    return parts.join(', ');
  }

  _parseInputString(input) {
    if (!input || typeof input !== 'string') {
      return {};
    }

    const params = {};
    const parts = input.split(',').map(p => p.trim());

    for (const part of parts) {
      const match = part.match(/^([^=]+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        params[key.trim()] = value.trim();
      }
    }

    return params;
  }

  _convertNotifyPolicy(errorHandling) {
    if (!errorHandling) {
      return 'on_failure';
    }

    switch (errorHandling.strategy) {
      case 'retry':
        return 'on_failure';
      case 'fallback':
        return 'on_failure';
      case 'ignore':
        return 'silent';
      default:
        return 'on_failure';
    }
  }

  _convertFromNotifyPolicy(notifyPolicy) {
    switch (notifyPolicy) {
      case 'silent':
        return {
          strategy: 'ignore',
          config: {}
        };
      case 'always':
        return {
          strategy: 'retry',
          config: { maxRetries: 1 }
        };
      default:
        return {
          strategy: 'retry',
          config: { maxRetries: 3 }
        };
    }
  }
}

module.exports = { WorkflowEngineAdapter };
