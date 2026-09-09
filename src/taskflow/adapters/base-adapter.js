const {
  TASKFLOW_STEP_TYPE
} = require('../taskflow-types');

class BaseAdapter {
  constructor() {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter 是抽象类，不能直接实例化');
    }
  }

  convertToTaskFlow(_source) {
    throw new Error('子类必须实现 convertToTaskFlow 方法');
  }

  convertFromTaskFlow(_taskflow) {
    throw new Error('子类必须实现 convertFromTaskFlow 方法');
  }

  _stepToString(step) {
    switch (step.type) {
      case TASKFLOW_STEP_TYPE.SKILL:
        return `skill:${step.skill}${step.input ? `(${step.input})` : ''}`;

      case TASKFLOW_STEP_TYPE.TASK:
        return `task:${step.taskId}${step.input ? `(${step.input})` : ''}`;

      case TASKFLOW_STEP_TYPE.CONDITION:
        return `condition:${step.condition}`;

      case TASKFLOW_STEP_TYPE.DELAY:
        return `delay:${step.duration || 1000}`;

      case TASKFLOW_STEP_TYPE.WEBHOOK:
        return `webhook:${step.url || step.webhookUrl}`;

      case TASKFLOW_STEP_TYPE.APPROVAL:
        return `approval:${step.approver || 'user'}`;

      case TASKFLOW_STEP_TYPE.PARALLEL:
        return `parallel:${step.branches ? step.branches.length : 0} branches`;

      case TASKFLOW_STEP_TYPE.SEQUENCE:
        return `sequence:${step.steps ? step.steps.length : 0} steps`;

      case TASKFLOW_STEP_TYPE.LOOP:
        return `loop:${step.loopMode || 'fixed'}:${step.collection || step.count || '?'}`;

      case TASKFLOW_STEP_TYPE.LLM:
        return `llm:${step.prompt || step.model || 'default'}`;

      case TASKFLOW_STEP_TYPE.SUB_AGENT:
        return `sub_agent:${step.goal || 'unknown'}`;

      default:
        return `${step.type}:${step.skill || step.taskId || 'unknown'}`;
    }
  }

  _parseGoalString(goal) {
    if (!goal || typeof goal !== 'string') {
      return [];
    }

    const lines = goal.split('\n').filter(line => line.trim());
    const steps = [];

    for (const line of lines) {
      const step = this._parseStepLine(line.trim());
      if (step) {
        steps.push(step);
      }
    }

    return steps;
  }

  _parseStepLine(line) {
    const match = line.match(/^(\w+):(.+)$/);
    if (!match) {
      return null;
    }

    const [, type, rest] = match;
    const step = { type };

    switch (type) {
      case TASKFLOW_STEP_TYPE.SKILL:
      case TASKFLOW_STEP_TYPE.TASK:
      case 'skill':
      case 'task': {
        const paramMatch = rest.match(/^([^(]+)(?:\((.+)\))?$/);
        if (paramMatch) {
          step[type === 'skill' || type === TASKFLOW_STEP_TYPE.SKILL ? 'skill' : 'taskId'] = paramMatch[1].trim();
          if (paramMatch[2]) {
            step.input = paramMatch[2].trim();
          }
        }
        step.type = (type === 'skill' || type === TASKFLOW_STEP_TYPE.SKILL) ? TASKFLOW_STEP_TYPE.SKILL : TASKFLOW_STEP_TYPE.TASK;
        break;
      }

      case TASKFLOW_STEP_TYPE.CONDITION:
      case 'condition':
        step.type = TASKFLOW_STEP_TYPE.CONDITION;
        step.condition = rest.trim();
        break;

      case TASKFLOW_STEP_TYPE.DELAY:
      case 'delay':
        step.type = TASKFLOW_STEP_TYPE.DELAY;
        step.duration = parseInt(rest, 10) || 1000;
        break;

      case TASKFLOW_STEP_TYPE.WEBHOOK:
      case 'webhook':
        step.type = TASKFLOW_STEP_TYPE.WEBHOOK;
        step.url = rest.trim();
        break;

      case TASKFLOW_STEP_TYPE.APPROVAL:
      case 'approval':
        step.type = TASKFLOW_STEP_TYPE.APPROVAL;
        step.approver = rest.trim();
        break;

      case TASKFLOW_STEP_TYPE.LOOP:
      case 'loop': {
        step.type = TASKFLOW_STEP_TYPE.LOOP;
        const loopParts = rest.split(':');
        step.loopMode = loopParts[0] || 'fixed';
        step.collection = loopParts[1] || null;
        break;
      }

      case TASKFLOW_STEP_TYPE.LLM:
      case 'llm':
        step.type = TASKFLOW_STEP_TYPE.LLM;
        step.prompt = rest.trim();
        break;

      case TASKFLOW_STEP_TYPE.SUB_AGENT:
      case 'sub_agent':
        step.type = TASKFLOW_STEP_TYPE.SUB_AGENT;
        step.goal = rest.trim();
        break;

      default:
        step.value = rest.trim();
    }

    return step;
  }

  _buildMetadata(source, type) {
    return {
      originalId: source.id,
      originalType: type,
      migratedAt: Date.now(),
      version: '2.0'
    };
  }
}

module.exports = { BaseAdapter };
