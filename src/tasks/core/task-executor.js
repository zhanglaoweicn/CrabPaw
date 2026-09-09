// eslint-disable-next-line no-unused-vars
const { taskStore, taskFlowStore, generateId, generateFlowId } = require('./task-store');
const { sanitizeTaskRecord, sanitizeTaskList } = require('./task-sanitizer');

const FLOW_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
  LOST: 'lost'
};

const ACTIVE_STATUSES = [TASK_STATUS.PENDING, TASK_STATUS.QUEUED, TASK_STATUS.RUNNING, TASK_STATUS.IN_PROGRESS];
const TERMINAL_STATUSES = [TASK_STATUS.COMPLETED, TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.TIMED_OUT, TASK_STATUS.LOST];

class TaskFlowRegistry {
  constructor() {
    this.flows = new Map();
  }

  async createFlow(params) {
    const flowId = params.flowId || generateFlowId();
    
    const flow = await taskFlowStore.createFlow({
      flowId,
      ownerKey: params.ownerKey || 'default',
      sessionKey: params.sessionKey,
      parentFlowId: params.parentFlowId,
      status: FLOW_STATUS.PENDING,
      metadata: params.metadata
    });
    
    this.flows.set(flowId, {
      id: flowId,
      tasks: [],
      dependencies: new Map(),
      status: FLOW_STATUS.PENDING
    });
    
    return flow;
  }

  async getFlow(flowId) {
    return taskFlowStore.getFlowById(flowId);
  }

  async addTaskToFlow(flowId, taskId) {
    const flowData = this.flows.get(flowId);
    if (flowData) {
      flowData.tasks.push(taskId);
    }
    
    await taskStore.updateTask(taskId, { parentFlowId: flowId });
  }

  async addDependency(flowId, taskId, dependsOnTaskId) {
    const flowData = this.flows.get(flowId);
    if (!flowData) return false;
    
    if (!flowData.dependencies.has(taskId)) {
      flowData.dependencies.set(taskId, new Set());
    }
    
    flowData.dependencies.get(taskId).add(dependsOnTaskId);
    
    return true;
  }

  async getDependencies(flowId, taskId) {
    const flowData = this.flows.get(flowId);
    if (!flowData) return [];
    
    const deps = flowData.dependencies.get(taskId);
    return deps ? Array.from(deps) : [];
  }

  async canStartTask(flowId, taskId) {
    const dependencies = await this.getDependencies(flowId, taskId);
    
    for (const depId of dependencies) {
      const depTask = await taskStore.getTaskById(depId);
      if (!depTask || !TERMINAL_STATUSES.includes(depTask.status)) {
        return false;
      }
    }
    
    return true;
  }

  async updateFlowStatus(flowId) {
    const tasks = await taskStore.listTasks({ parentFlowId: flowId });
    
    if (tasks.length === 0) {
      return taskFlowStore.updateFlow(flowId, { status: FLOW_STATUS.PENDING });
    }
    
    const allTerminal = tasks.every(t => TERMINAL_STATUSES.includes(t.status));
    const anyRunning = tasks.some(t => ACTIVE_STATUSES.includes(t.status));
    const allSucceeded = tasks.every(t => t.status === TASK_STATUS.SUCCEEDED);
    const anyFailed = tasks.some(t => t.status === TASK_STATUS.FAILED || t.status === TASK_STATUS.TIMED_OUT);
    const anyCancelled = tasks.some(t => t.status === TASK_STATUS.CANCELLED);
    
    let newStatus;
    
    if (anyRunning) {
      newStatus = FLOW_STATUS.RUNNING;
    } else if (allSucceeded) {
      newStatus = FLOW_STATUS.SUCCEEDED;
    } else if (anyFailed) {
      newStatus = FLOW_STATUS.FAILED;
    } else if (anyCancelled) {
      newStatus = FLOW_STATUS.CANCELLED;
    } else if (allTerminal) {
      newStatus = FLOW_STATUS.SUCCEEDED;
    } else {
      newStatus = FLOW_STATUS.PENDING;
    }
    
    return taskFlowStore.updateFlow(flowId, { status: newStatus });
  }

  async cancelFlow(flowId) {
    const tasks = await taskStore.listTasks({ parentFlowId: flowId });
    
    for (const task of tasks) {
      if (ACTIVE_STATUSES.includes(task.status)) {
        await taskStore.updateTask(task.taskId, { status: TASK_STATUS.CANCELLED, endedAt: Date.now() });
      }
    }
    
    await taskFlowStore.updateFlow(flowId, { status: FLOW_STATUS.CANCELLED, endedAt: Date.now() });
    
    return true;
  }

  async deleteFlow(flowId) {
    const tasks = await taskStore.listTasks({ parentFlowId: flowId });
    
    for (const task of tasks) {
      await taskStore.deleteTask(task.taskId);
    }
    
    this.flows.delete(flowId);
    
    return taskFlowStore.deleteFlow(flowId);
  }

  async getFlowSummary(flowId) {
    const tasks = await taskStore.listTasks({ parentFlowId: flowId });
    
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === TASK_STATUS.PENDING).length,
      running: tasks.filter(t => ACTIVE_STATUSES.includes(t.status)).length,
      completed: tasks.filter(t => t.status === TASK_STATUS.SUCCEEDED).length,
      failed: tasks.filter(t => t.status === TASK_STATUS.FAILED).length,
      cancelled: tasks.filter(t => t.status === TASK_STATUS.CANCELLED).length
    };
  }
}

class TaskExecutor {
  constructor() {
    this.flows = new TaskFlowRegistry();
  }

  async createTask(params) {
    this._assertOwner(params);
    
    const task = await taskStore.createTask({
      ownerKey: params.ownerKey || 'default',
      scopeKind: params.scopeKind || 'session',
      sessionKey: params.sessionKey,
      content: params.content,
      priority: params.priority || 'medium',
      status: params.status || TASK_STATUS.PENDING,
      runtime: params.runtime,
      runId: params.runId,
      parentFlowId: params.parentFlowId,
      metadata: params.metadata
    });
    
    if (params.parentFlowId) {
      await this.flows.addTaskToFlow(params.parentFlowId, task.taskId);
      await this.flows.updateFlowStatus(params.parentFlowId);
    }
    
    return sanitizeTaskRecord(task);
  }

  async getTask(taskId, ownerKey) {
    const task = await taskStore.getTaskById(taskId);
    
    if (!task) return null;
    
    if (ownerKey && task.ownerKey !== ownerKey && task.scopeKind !== 'system') {
      return null;
    }
    
    return sanitizeTaskRecord(task);
  }

  async updateTask(taskId, updates, ownerKey) {
    const task = await taskStore.getTaskById(taskId);
    
    if (!task) return null;
    
    if (ownerKey && task.ownerKey !== ownerKey && task.scopeKind !== 'system') {
      throw new Error('Permission denied: not task owner');
    }
    
    const updated = await taskStore.updateTask(taskId, updates);
    
    if (task.parentFlowId) {
      await this.flows.updateFlowStatus(task.parentFlowId);
    }
    
    return sanitizeTaskRecord(updated);
  }

  async startTask(taskId, ownerKey) {
    return this.updateTask(taskId, {
      status: TASK_STATUS.RUNNING,
      startedAt: Date.now()
    }, ownerKey);
  }

  async completeTask(taskId, result, ownerKey) {
    return this.updateTask(taskId, {
      status: TASK_STATUS.SUCCEEDED,
      endedAt: Date.now(),
      terminalSummary: result
    }, ownerKey);
  }

  async failTask(taskId, error, ownerKey) {
    return this.updateTask(taskId, {
      status: TASK_STATUS.FAILED,
      endedAt: Date.now(),
      error: error
    }, ownerKey);
  }

  async cancelTask(taskId, ownerKey) {
    return this.updateTask(taskId, {
      status: TASK_STATUS.CANCELLED,
      endedAt: Date.now()
    }, ownerKey);
  }

  async listTasks(filters = {}) {
    const tasks = await taskStore.listTasks(filters);
    return sanitizeTaskList(tasks);
  }

  async deleteTask(taskId, ownerKey) {
    const task = await taskStore.getTaskById(taskId);
    
    if (!task) return false;
    
    if (ownerKey && task.ownerKey !== ownerKey && task.scopeKind !== 'system') {
      throw new Error('Permission denied: not task owner');
    }
    
    await taskStore.deleteTask(taskId);
    
    if (task.parentFlowId) {
      await this.flows.updateFlowStatus(task.parentFlowId);
    }
    
    return true;
  }

  async addProgress(taskId, progress, summary, ownerKey) {
    const task = await taskStore.getTaskById(taskId);
    
    if (!task) return null;
    
    if (ownerKey && task.ownerKey !== ownerKey && task.scopeKind !== 'system') {
      throw new Error('Permission denied: not task owner');
    }
    
    await taskStore.addCheckpoint(taskId, progress, summary);
    
    return this.updateTask(taskId, {
      progress,
      progressSummary: summary
    }, ownerKey);
  }

  async getTaskStats(ownerKey) {
    const filters = ownerKey ? { ownerKey } : {};
    return taskStore.getStats(filters);
  }

  _assertOwner(params) {
    if (!params.ownerKey && params.scopeKind !== 'system') {
      throw new Error('Task ownerKey is required for non-system tasks');
    }
  }
}

const taskExecutor = new TaskExecutor();
const taskFlowRegistry = new TaskFlowRegistry();

module.exports = {
  TaskExecutor,
  TaskFlowRegistry,
  taskExecutor,
  taskFlowRegistry,
  FLOW_STATUS,
  TASK_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES
};
