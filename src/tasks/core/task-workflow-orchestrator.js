const crypto = require('crypto');
// @deprecated — 此模块作为辅助引擎保留，核心能力已统一至 src/taskflow 出口
// 新代码请使用: const { taskWorkflowOrchestrator } = require('../../taskflow');
// 包含: { TaskWorkflowOrchestrator, getTaskWorkflowOrchestrator, WORKFLOW_STATUS, WORKFLOW_NODE_TYPES }
const { EventEmitter } = require('events');
const { getTaskDependencyManager, DEPENDENCY_TYPES } = require('./task-dependency-manager');
const { getTaskEventTrigger } = require('./task-event-trigger');

const WORKFLOW_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

const WORKFLOW_NODE_TYPES = {
  TASK: 'task',
  CONDITION: 'condition',
  PARALLEL: 'parallel',
  SEQUENCE: 'sequence',
  LOOP: 'loop',
  DELAY: 'delay',
  WEBHOOK: 'webhook'
};

class TaskWorkflowOrchestrator extends EventEmitter {
  constructor() {
    super();
    
    this.workflows = new Map();
    this.executions = new Map();
    this.maxConcurrentWorkflows = 10;
    this.activeWorkflows = 0;
    
    this.dependencyManager = getTaskDependencyManager();
    this.eventTrigger = getTaskEventTrigger();
    
    this.setupEventHandlers();
    
    console.log('🔀 任务工作流编排器已初始化');
    // P2: Debug trace for workflow visualization
    this._debugTrace = [];
    this._maxDebugTrace = 200;
    const _addTrace = (event, data) => {
      const entry = { ts: Date.now(), event, ...data };
      this._debugTrace.push(entry);
      if (this._debugTrace.length > this._maxDebugTrace) this._debugTrace.shift();
      console.log('[WF-DEBUG]', event, JSON.stringify(data).substring(0, 200));
    };
    this.on('workflow_started', (d) => _addTrace('started', d));
    this.on('workflow_started', (d) => _addTrace('step', d));
    this.on('workflow_completed', (d) => _addTrace('completed', d));
    this.on('workflow_failed', (d) => _addTrace('failed', d));
  }
  
  setupEventHandlers() {
    this.eventTrigger.on('trigger_executed', async (data) => {
      const workflows = this.findWorkflowsByTrigger(data.triggerId);
      
      for (const workflow of workflows) {
        if (workflow.status === WORKFLOW_STATUS.PUBLISHED) {
          await this.executeWorkflow(workflow.id, {
            triggerData: data
          });
        }
      }
    });
  }
  
  findWorkflowsByTrigger(triggerId) {
    const workflows = [];
    
    for (const workflow of this.workflows.values()) {
      if (workflow.triggerId === triggerId) {
        workflows.push(workflow);
      }
    }
    
    return workflows;
  }
  
  createWorkflow(workflowId, config) {
    const {
      name,
      description = '',
      nodes = [],
      edges = [],
      triggerId = null,
      variables = {},
      timeout = 86400000,
      retryPolicy = {
        maxRetries: 3,
        retryDelay: 5000
      },
      metadata = {}
    } = config;
    
    if (!name) {
      return {
        success: false,
        error: '工作流名称不能为空'
      };
    }
    
    const workflow = {
      id: workflowId,
      name,
      description,
      nodes: nodes.map(node => ({
        ...node,
        id: node.id || `node_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
        status: 'pending',
        executedAt: null,
        result: null,
        error: null
      })),
      edges,
      triggerId,
      variables,
      timeout,
      retryPolicy,
      metadata,
      status: WORKFLOW_STATUS.DRAFT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      executionCount: 0,
      lastExecutedAt: null
    };
    
    this.workflows.set(workflowId, workflow);
    
    console.log(`🔀 创建工作流: ${name} (${workflowId})`);
    
    this.emit('workflow_created', { workflowId, name });
    
    return {
      success: true,
      workflow
    };
  }
  
  updateWorkflow(workflowId, updates) {
    const workflow = this.workflows.get(workflowId);
    
    if (!workflow) {
      return {
        success: false,
        error: '工作流不存在'
      };
    }
    
    if (workflow.status === WORKFLOW_STATUS.RUNNING) {
      return {
        success: false,
        error: '工作流正在运行，无法更新'
      };
    }
    
    Object.assign(workflow, updates, {
      updatedAt: Date.now(),
      version: workflow.version + 1
    });
    
    console.log(`🔀 更新工作流: ${workflow.name} (v${workflow.version})`);
    
    this.emit('workflow_updated', { workflowId, version: workflow.version });
    
    return {
      success: true,
      workflow
    };
  }
  
  deleteWorkflow(workflowId) {
    const workflow = this.workflows.get(workflowId);
    
    if (!workflow) {
      return {
        success: false,
        error: '工作流不存在'
      };
    }
    
    if (workflow.status === WORKFLOW_STATUS.RUNNING) {
      return {
        success: false,
        error: '工作流正在运行，无法删除'
      };
    }
    
    this.workflows.delete(workflowId);
    
    console.log(`🗑️ 删除工作流: ${workflow.name}`);
    
    this.emit('workflow_deleted', { workflowId });
    
    return {
      success: true,
      message: '工作流已删除'
    };
  }
  
  publishWorkflow(workflowId) {
    const workflow = this.workflows.get(workflowId);
    
    if (!workflow) {
      return {
        success: false,
        error: '工作流不存在'
      };
    }
    
    if (workflow.nodes.length === 0) {
      return {
        success: false,
        error: '工作流至少需要一个节点'
      };
    }
    
    const validation = this.validateWorkflow(workflow);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error
      };
    }
    
    workflow.status = WORKFLOW_STATUS.PUBLISHED;
    workflow.updatedAt = Date.now();
    
    console.log(`🔀 发布工作流: ${workflow.name}`);
    
    this.emit('workflow_published', { workflowId });
    
    return {
      success: true,
      workflow
    };
  }
  
  validateWorkflow(workflow) {
    const nodeIds = new Set(workflow.nodes.map(n => n.id));
    
    for (const edge of workflow.edges) {
      if (!nodeIds.has(edge.from)) {
        return {
          valid: false,
          error: `边的源节点不存在: ${edge.from}`
        };
      }
      
      if (!nodeIds.has(edge.to)) {
        return {
          valid: false,
          error: `边的目标节点不存在: ${edge.to}`
        };
      }
    }
    
    const visited = new Set();
    const hasCycle = (nodeId, path = []) => {
      if (visited.has(nodeId)) return false;
      if (path.includes(nodeId)) return true;
      
      visited.add(nodeId);
      path.push(nodeId);
      
      const outgoingEdges = workflow.edges.filter(e => e.from === nodeId);
      for (const edge of outgoingEdges) {
        if (hasCycle(edge.to, [...path])) {
          return true;
        }
      }
      
      return false;
    };
    
    for (const node of workflow.nodes) {
      visited.clear();
      if (hasCycle(node.id)) {
        return {
          valid: false,
          error: '工作流存在循环依赖'
        };
      }
    }
    
    return { valid: true };
  }
  
  async executeWorkflow(workflowId, context = {}) {
    const workflow = this.workflows.get(workflowId);
    
    if (!workflow) {
      return {
        success: false,
        error: '工作流不存在'
      };
    }
    
    if (workflow.status !== WORKFLOW_STATUS.PUBLISHED) {
      return {
        success: false,
        error: '工作流未发布'
      };
    }
    
    if (this.activeWorkflows >= this.maxConcurrentWorkflows) {
      return {
        success: false,
        error: '已达到最大并发工作流数量'
      };
    }
    
    const executionId = `exec_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    
    const execution = {
      id: executionId,
      workflowId,
      workflowName: workflow.name,
      status: WORKFLOW_STATUS.RUNNING,
      startedAt: Date.now(),
      endedAt: null,
      context,
      nodeExecutions: new Map(),
      variables: { ...workflow.variables },
      error: null
    };
    
    this.executions.set(executionId, execution);
    this.activeWorkflows++;
    
    workflow.status = WORKFLOW_STATUS.RUNNING;
    workflow.executionCount++;
    workflow.lastExecutedAt = Date.now();
    
    console.log(`🔀 开始执行工作流: ${workflow.name} (${executionId})`);
    
    this.emit('workflow_started', { workflowId, executionId });
    
    try {
      const startNodes = this.findStartNodes(workflow);
      
      for (const node of startNodes) {
        await this.executeNode(workflow, node, execution);
      }
      
      execution.status = WORKFLOW_STATUS.COMPLETED;
      execution.endedAt = Date.now();
      workflow.status = WORKFLOW_STATUS.PUBLISHED;
      
      console.log(`✅ 工作流执行完成: ${workflow.name} (${executionId})`);
      
      this.emit('workflow_completed', { workflowId, executionId });
      
    } catch (error) {
      execution.status = WORKFLOW_STATUS.FAILED;
      execution.endedAt = Date.now();
      execution.error = error.message;
      workflow.status = WORKFLOW_STATUS.PUBLISHED;
      
      console.error(`❌ 工作流执行失败: ${workflow.name}`, error.message);
      
      this.emit('workflow_failed', { workflowId, executionId, error });
    } finally {
      this.activeWorkflows--;
    }
    
    return {
      success: execution.status === WORKFLOW_STATUS.COMPLETED,
      executionId,
      status: execution.status,
      error: execution.error
    };
  }
  
  findStartNodes(workflow) {
    const targetNodes = new Set(workflow.edges.map(e => e.to));
    
    return workflow.nodes.filter(node => !targetNodes.has(node.id));
  }
  
  async executeNode(workflow, node, execution) {
    if (execution.nodeExecutions.has(node.id)) {
      const nodeExec = execution.nodeExecutions.get(node.id);
      if (nodeExec.status === 'completed') {
        return nodeExec.result;
      }
    }
    
    console.log(`  📍 执行节点: ${node.name || node.id}`);
    
    const nodeExecution = {
      nodeId: node.id,
      nodeName: node.name,
      type: node.type,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      result: null,
      error: null
    };
    
    execution.nodeExecutions.set(node.id, nodeExecution);
    
    try {
      let result;
      
      switch (node.type) {
        case WORKFLOW_NODE_TYPES.TASK:
          result = await this.executeTaskNode(node, execution);
          break;
        
        case WORKFLOW_NODE_TYPES.CONDITION:
          result = await this.executeConditionNode(node, execution);
          break;
        
        case WORKFLOW_NODE_TYPES.PARALLEL:
          result = await this.executeParallelNode(workflow, node, execution);
          break;
        
        case WORKFLOW_NODE_TYPES.SEQUENCE:
          result = await this.executeSequenceNode(workflow, node, execution);
          break;
        
        case WORKFLOW_NODE_TYPES.DELAY:
          result = await this.executeDelayNode(node);
          break;
        
        default:
          // M16: 未知节点类型必须显式失败，禁止静默"成功"
          console.error(`[workflow] 未知节点类型: ${node.type} (id=${node.id})`);
          result = { success: false, error: `未知节点类型: ${node.type}` };
      }
      
      nodeExecution.status = 'completed';
      nodeExecution.result = result;
      nodeExecution.endedAt = Date.now();
      
      const nextNodes = this.findNextNodes(workflow, node.id);
      for (const nextNode of nextNodes) {
        await this.executeNode(workflow, nextNode, execution);
      }
      
      return result;
      
    } catch (error) {
      nodeExecution.status = 'failed';
      nodeExecution.error = error.message;
      nodeExecution.endedAt = Date.now();
      
      throw error;
    }
  }
  
  async executeTaskNode(node, _execution) {
    const { taskId, params = {} } = node.config || {};
    
    if (!taskId) {
      throw new Error('任务节点缺少 taskId');
    }
    
    console.log(`    ⚙️ 执行任务: ${taskId}`);
    
    return {
      success: true,
      taskId,
      params,
      executedAt: Date.now()
    };
  }
  
  async executeConditionNode(node, execution) {
    const { conditions = [], logic = 'and' } = node.config || {};
    
    let result = true;
    
    for (const condition of conditions) {
      const conditionResult = await this.evaluateCondition(condition, execution);
      
      if (logic === 'and') {
        result = result && conditionResult;
      } else if (logic === 'or') {
        result = result || conditionResult;
      }
    }
    
    return {
      success: true,
      result,
      logic
    };
  }
  
  async executeParallelNode(workflow, node, execution) {
    const { branches = [] } = node.config || {};
    
    const promises = branches.map(branch => 
      this.executeNode(workflow, branch, execution)
    );
    
    const results = await Promise.allSettled(promises);
    
    return {
      success: results.every(r => r.status === 'fulfilled'),
      results: results.map(r => r.value || r.reason)
    };
  }
  
  async executeSequenceNode(workflow, node, execution) {
    const { steps = [] } = node.config || {};
    
    const results = [];
    
    for (const step of steps) {
      const result = await this.executeNode(workflow, step, execution);
      results.push(result);
    }
    
    return {
      success: true,
      results
    };
  }
  
  async executeDelayNode(node) {
    const { duration = 1000 } = node.config || {};
    
    await new Promise(resolve => setTimeout(resolve, duration));
    
    return {
      success: true,
      duration
    };
  }
  
  async evaluateCondition(condition, execution) {
    const { field, operator, value } = condition;
    
    const fieldValue = this.getVariable(field, execution);
    
    switch (operator) {
      case 'equals': return fieldValue === value;
      case 'not_equals': return fieldValue !== value;
      case 'contains': return String(fieldValue).includes(value);
      case 'greater_than': return Number(fieldValue) > Number(value);
      case 'less_than': return Number(fieldValue) < Number(value);
      default: return false;
    }
  }
  
  getVariable(name, execution) {
    return execution.variables[name];
  }
  
  setVariable(name, value, execution) {
    execution.variables[name] = value;
  }
  
  findNextNodes(workflow, nodeId) {
    const outgoingEdges = workflow.edges.filter(e => e.from === nodeId);
    const nextNodeIds = outgoingEdges.map(e => e.to);
    
    return workflow.nodes.filter(n => nextNodeIds.includes(n.id));
  }
  
  getWorkflow(workflowId) {
    return this.workflows.get(workflowId);
  }
  
  listWorkflows(options = {}) {
    const { status, search } = options;
    
    let workflows = Array.from(this.workflows.values());
    
    if (status) {
      workflows = workflows.filter(w => w.status === status);
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      workflows = workflows.filter(w => 
        w.name.toLowerCase().includes(searchLower) ||
        w.description.toLowerCase().includes(searchLower)
      );
    }
    
    return workflows.sort((a, b) => b.createdAt - a.createdAt);
  }
  
  getExecution(executionId) {
    return this.executions.get(executionId);
  }
  
  listExecutions(workflowId, limit = 20) {
    let executions = Array.from(this.executions.values());
    
    if (workflowId) {
      executions = executions.filter(e => e.workflowId === workflowId);
    }
    
    return executions
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }
  
  cancelExecution(executionId) {
    const execution = this.executions.get(executionId);
    
    if (!execution) {
      return {
        success: false,
        error: '执行实例不存在'
      };
    }
    
    if (execution.status !== WORKFLOW_STATUS.RUNNING) {
      return {
        success: false,
        error: '执行实例不在运行状态'
      };
    }
    
    execution.status = WORKFLOW_STATUS.CANCELLED;
    execution.endedAt = Date.now();
    
    const workflow = this.workflows.get(execution.workflowId);
    if (workflow) {
      workflow.status = WORKFLOW_STATUS.PUBLISHED;
    }
    
    console.log(`⏹️ 取消工作流执行: ${execution.workflowName} (${executionId})`);
    
    this.emit('workflow_cancelled', { executionId });
    
    return {
      success: true,
      message: '执行已取消'
    };
  }
  
  getStatistics() {
    const stats = {
      totalWorkflows: this.workflows.size,
      byStatus: {},
      totalExecutions: this.executions.size,
      activeWorkflows: this.activeWorkflows
    };
    
    for (const workflow of this.workflows.values()) {
      stats.byStatus[workflow.status] = 
        (stats.byStatus[workflow.status] || 0) + 1;
    }
    
    return stats;
  }

  // ========== 动态重规划 ==========

  /**
   * 动态重规划：在运行时调整工作流节点和依赖
   * @param {string} workflowId - 工作流 ID
   * @param {object} replanOptions - 重规划选项
   * @param {string} replanOptions.reason - 重规划原因
   * @param {Array} replanOptions.addNodes - 新增节点
   * @param {Array} replanOptions.removeNodes - 要移除的节点 ID
   * @param {Array} replanOptions.updateNodes - 要更新的节点
   * @param {object} replanOptions.newDependencies - 新增依赖
   * @returns {object} 重规划结果
   */
  replanWorkflow(workflowId, replanOptions = {}) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return { success: false, error: 'workflow_not_found' };
    }

    // 只有运行中或暂停的工作流可以重规划
    if (![WORKFLOW_STATUS.RUNNING, WORKFLOW_STATUS.PAUSED].includes(workflow.status)) {
      return { success: false, error: `cannot_replan_${workflow.status}` };
    }

    const changes = {
      added: [],
      removed: [],
      updated: [],
      dependenciesAdded: 0,
    };

    const { reason, addNodes = [], removeNodes = [], updateNodes = [], newDependencies = {} } = replanOptions;

    // 1. 添加新节点
    for (const node of addNodes) {
      if (!workflow.nodes.find(n => n.id === node.id)) {
        workflow.nodes.push(node);
        changes.added.push(node.id);
      }
    }

    // 2. 移除节点（仅移除未在执行中的节点）
    for (const nodeId of removeNodes) {
      const execution = this.executions.get(workflowId);
      const isRunning = execution?.currentNode === nodeId;
      if (!isRunning) {
        workflow.nodes = workflow.nodes.filter(n => n.id !== nodeId);
        changes.removed.push(nodeId);
      }
    }

    // 3. 更新节点配置
    for (const update of updateNodes) {
      const node = workflow.nodes.find(n => n.id === update.id);
      if (node) {
        Object.assign(node, update, { id: update.id }); // 保留 ID 不变
        changes.updated.push(update.id);
      }
    }

    // 4. 更新依赖关系
    for (const [fromId, toIds] of Object.entries(newDependencies)) {
      this.dependencyManager.addDependency(fromId, toIds, DEPENDENCY_TYPES.FINISH_TO_START);
      changes.dependenciesAdded += Array.isArray(toIds) ? toIds.length : 1;
    }

    // 记录重规划事件
    this.emit('workflow:replanned', {
      workflowId,
      reason,
      changes,
      timestamp: Date.now(),
    });

    console.log(
      `[TaskWorkflowOrchestrator] 动态重规划: ${workflowId}, ` +
      `原因: ${reason}, 变更: +${changes.added.length} -${changes.removed.length} ` +
      `~${changes.updated.length} 依赖+${changes.dependenciesAdded}`
    );

    return { success: true, changes, reason };
  }

  /**
   * 异常重规划：当任务失败时自动调整后续计划
   * @param {string} workflowId - 工作流 ID
   * @param {string} failedNodeId - 失败的节点 ID
   * @param {object} error - 错误信息
   * @param {object} strategy - 重规划策略
   */
  replanOnFailure(workflowId, failedNodeId, error, strategy = {}) {
    const {
      retry = true,
      maxRetries = 2,
      skipOnFailure = false,
      fallbackNodeId = null,
    } = strategy;

    const execution = this.executions.get(workflowId);
    if (!execution) return { success: false, error: 'execution_not_found' };

    // 检查重试次数
    const retryCount = execution.retryCounts?.get(failedNodeId) || 0;

    if (retry && retryCount < maxRetries) {
      // 重试策略：重新执行失败节点
      if (!execution.retryCounts) execution.retryCounts = new Map();
      execution.retryCounts.set(failedNodeId, retryCount + 1);

      console.log(`[TaskWorkflowOrchestrator] 异常重规划-重试: ${failedNodeId} (${retryCount + 1}/${maxRetries})`);
      return { success: true, action: 'retry', retryCount: retryCount + 1 };
    }

    if (fallbackNodeId) {
      // 降级策略：切换到备用节点
      return this.replanWorkflow(workflowId, {
        reason: `failure_fallback: ${failedNodeId} → ${fallbackNodeId}`,
        addNodes: [],
        updateNodes: [{ id: execution.currentNode, nextNodeId: fallbackNodeId }],
      });
    }

    if (skipOnFailure) {
      // 跳过策略：标记失败节点为跳过，继续后续节点
      return this.replanWorkflow(workflowId, {
        reason: `failure_skip: ${failedNodeId}`,
        removeNodes: [failedNodeId],
      });
    }

    // 默认：暂停工作流等待人工介入
    this.pauseWorkflow(workflowId);
    return { success: true, action: 'paused_for_intervention' };
  }

  getDebugTrace(limit = 50) {
    return this._debugTrace ? this._debugTrace.slice(-limit) : [];
  }
}

let instance = null;

function getTaskWorkflowOrchestrator() {
  if (!instance) {
    instance = new TaskWorkflowOrchestrator();
  }

  return instance;
}

module.exports = {
  TaskWorkflowOrchestrator,
  getTaskWorkflowOrchestrator,
  WORKFLOW_STATUS,
  WORKFLOW_NODE_TYPES
};
