const { BaseAdapter } = require('./base-adapter');

class TaskWorkflowAdapter extends BaseAdapter {
  constructor() {
    super();
  }

  convertToTaskFlow(workflow) {
    if (!workflow || !workflow.id) {
      throw new Error('无效的 TaskWorkflowOrchestrator 数据');
    }

    const steps = this._convertNodesToSteps(workflow.nodes || [], workflow.edges || []);
    const goal = steps.map(s => this._stepToString(s)).join('\n');

    return {
      goal,
      syncMode: 'managed',
      ownerKey: 'task-workflow',
      notifyPolicy: 'on_failure',
      metadata: this._buildMetadata(workflow, 'task-workflow-orchestrator'),
      stateJson: {
        originalWorkflow: {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          status: workflow.status,
          variables: workflow.variables,
          triggerId: workflow.triggerId
        }
      }
    };
  }

  convertFromTaskFlow(taskflow) {
    if (!taskflow || !taskflow.flowId) {
      throw new Error('无效的 TaskFlow 数据');
    }

    const steps = this._parseGoalString(taskflow.goal);
    const nodes = [];
    const edges = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const node = this._convertStepToNode(step, i);
      nodes.push(node);

      if (i > 0) {
        edges.push({
          from: nodes[i - 1].id,
          to: node.id
        });
      }
    }

    const workflow = {
      id: taskflow.metadata?.originalId || taskflow.flowId,
      name: taskflow.stateJson?.originalWorkflow?.name || '迁移的工作流',
      description: taskflow.stateJson?.originalWorkflow?.description || '',
      nodes,
      edges,
      status: 'published',
      variables: taskflow.stateJson?.originalWorkflow?.variables || {},
      triggerId: taskflow.stateJson?.originalWorkflow?.triggerId || null,
      timeout: 86400000,
      retryPolicy: {
        maxRetries: 3,
        retryDelay: 5000
      },
      executionCount: 0,
      lastExecutedAt: null,
      createdAt: taskflow.createdAt ? new Date(taskflow.createdAt).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return workflow;
  }

  _convertNodesToSteps(nodes, edges) {
    const steps = [];
    const visited = new Set();
    const nodeMap = new Map();

    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    const startNodes = this._findStartNodes(nodes, edges);

    for (const startNode of startNodes) {
      this._traverseNode(startNode, nodeMap, edges, steps, visited);
    }

    return steps;
  }

  _findStartNodes(nodes, edges) {
    const targetNodeIds = new Set(edges.map(e => e.to));
    return nodes.filter(node => !targetNodeIds.has(node.id));
  }

  _traverseNode(nodeId, nodeMap, edges, steps, visited) {
    if (visited.has(nodeId)) {
      return;
    }

    visited.add(nodeId);
    const node = nodeMap.get(nodeId);

    if (!node) {
      return;
    }

    const step = this._convertNodeToStep(node);
    if (step) {
      steps.push(step);
    }

    const nextEdges = edges.filter(e => e.from === nodeId);
    for (const edge of nextEdges) {
      this._traverseNode(edge.to, nodeMap, edges, steps, visited);
    }
  }

  _convertNodeToStep(node) {
    switch (node.type) {
      case 'task':
        return {
          type: 'task',
          taskId: node.taskId,
          input: this._buildInputFromVariables(node.variables)
        };

      case 'condition':
        return {
          type: 'condition',
          condition: node.condition || 'true'
        };

      case 'parallel':
        return {
          type: 'parallel',
          branches: node.branches || []
        };

      case 'sequence':
        return {
          type: 'sequence',
          steps: node.steps || []
        };

      case 'loop':
        return {
          type: 'skill',
          skill: 'loop',
          input: `items=${node.items || '[]'}, action=${node.action || ''}`
        };

      case 'delay':
        return {
          type: 'delay',
          duration: node.duration || 1000
        };

      case 'webhook':
        return {
          type: 'webhook',
          url: node.url || node.webhookUrl,
          input: node.body ? JSON.stringify(node.body) : ''
        };

      default:
        return {
          type: 'skill',
          skill: node.type,
          input: this._buildInputFromVariables(node.variables)
        };
    }
  }

  _convertStepToNode(step, index) {
    const node = {
      id: `node_${index}`,
      type: step.type,
      status: 'pending',
      executedAt: null,
      result: null
    };

    switch (step.type) {
      case 'task':
        node.taskId = step.taskId;
        node.variables = this._parseInputToVariables(step.input);
        break;

      case 'condition':
        node.condition = step.condition || 'true';
        break;

      case 'parallel':
        node.branches = step.branches || [];
        break;

      case 'sequence':
        node.steps = step.steps || [];
        break;

      case 'delay':
        node.duration = step.duration || 1000;
        break;

      case 'webhook':
        node.url = step.url;
        node.body = step.input ? JSON.parse(step.input) : {};
        break;

      default:
        node.variables = this._parseInputToVariables(step.input);
    }

    return node;
  }

  _buildInputFromVariables(variables) {
    if (!variables || typeof variables !== 'object') {
      return '';
    }

    const parts = [];
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'string') {
        parts.push(`${key}=${value}`);
      } else {
        parts.push(`${key}=${JSON.stringify(value)}`);
      }
    }

    return parts.join(', ');
  }

  _parseInputToVariables(input) {
    if (!input || typeof input !== 'string') {
      return {};
    }

    const variables = {};
    const parts = input.split(',').map(p => p.trim());

    for (const part of parts) {
      const match = part.match(/^([^=]+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        variables[key.trim()] = value.trim();
      }
    }

    return variables;
  }

  _buildMetadata(workflow, type) {
    const metadata = super._buildMetadata(workflow, type);
    
    metadata.name = workflow.name;
    metadata.description = workflow.description;
    metadata.status = workflow.status;
    metadata.triggerId = workflow.triggerId;

    return metadata;
  }
}

module.exports = { TaskWorkflowAdapter };
