const { BaseAdapter } = require('./base-adapter');

class SkillFlowAdapter extends BaseAdapter {
  constructor() {
    super();
  }

  convertToTaskFlow(flow) {
    if (!flow || !flow.id) {
      throw new Error('无效的 SkillFlow 数据');
    }

    const steps = this._convertSteps(flow.steps || []);
    const goal = steps.map(s => this._stepToString(s)).join('\n');

    return {
      goal,
      syncMode: 'managed',
      ownerKey: 'skill-flow',
      notifyPolicy: 'on_failure',
      metadata: this._buildMetadata(flow, 'skill-flow'),
      stateJson: {
        originalFlow: {
          id: flow.id,
          name: flow.name,
          description: flow.description,
          keywords: flow.keywords || [],
          version: flow.version
        }
      }
    };
  }

  convertFromTaskFlow(taskflow) {
    if (!taskflow || !taskflow.flowId) {
      throw new Error('无效的 TaskFlow 数据');
    }

    const steps = this._parseGoalString(taskflow.goal);
    
    const flow = {
      id: taskflow.metadata?.originalId || taskflow.flowId,
      name: taskflow.stateJson?.originalFlow?.name || '迁移的流程',
      description: taskflow.stateJson?.originalFlow?.description || '',
      keywords: taskflow.stateJson?.originalFlow?.keywords || [],
      steps: steps.map((step, index) => this._convertStepToFlowStep(step, index)),
      version: '2.0',
      createdAt: taskflow.createdAt ? new Date(taskflow.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return flow;
  }

  _convertSteps(flowSteps) {
    const steps = [];

    for (const flowStep of flowSteps) {
      const step = this._convertFlowStep(flowStep);
      if (step) {
        steps.push(step);
      }
    }

    return steps;
  }

  _convertFlowStep(flowStep) {
    const stepType = flowStep.type || 'skill';

    switch (stepType) {
      case 'skill':
        return {
          type: 'skill',
          skill: flowStep.skill || 'text-input',
          input: flowStep.input || '',
          outputKey: flowStep.outputKey
        };

      case 'condition':
        return {
          type: 'condition',
          condition: flowStep.condition || 'true',
          trueStep: flowStep.trueStep,
          falseStep: flowStep.falseStep
        };

      case 'text-input':
        return {
          type: 'skill',
          skill: 'text-input',
          input: flowStep.input || ''
        };

      case 'pass-through':
        return {
          type: 'skill',
          skill: 'pass-through',
          input: flowStep.input || ''
        };

      default:
        return {
          type: 'skill',
          skill: flowStep.skill || stepType,
          input: flowStep.input || ''
        };
    }
  }

  _convertStepToFlowStep(step, index) {
    const flowStep = {
      id: `step_${index}`,
      type: step.type,
      outputKey: `result_${index}`
    };

    switch (step.type) {
      case 'skill':
        flowStep.skill = step.skill;
        flowStep.input = step.input || '';
        break;

      case 'task':
        flowStep.type = 'skill';
        flowStep.skill = `task_${step.taskId}`;
        flowStep.input = step.input || '';
        break;

      case 'condition':
        flowStep.condition = step.condition || 'true';
        flowStep.trueStep = step.trueStep || null;
        flowStep.falseStep = step.falseStep || null;
        break;

      case 'delay':
        flowStep.type = 'skill';
        flowStep.skill = 'delay';
        flowStep.input = `duration=${step.duration || 1000}`;
        break;

      default:
        flowStep.skill = step.skill || step.type;
        flowStep.input = step.input || '';
    }

    return flowStep;
  }

  _buildMetadata(flow, type) {
    const metadata = super._buildMetadata(flow, type);
    
    metadata.name = flow.name;
    metadata.description = flow.description;
    metadata.keywords = flow.keywords || [];
    metadata.version = flow.version;

    return metadata;
  }
}

module.exports = { SkillFlowAdapter };
