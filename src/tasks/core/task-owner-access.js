const { taskStore, taskFlowStore } = require('./task-store');

const SCOPE_KINDS = {
  SESSION: 'session',
  SYSTEM: 'system',
  DETACHED: 'detached'
};

class PermissionError extends Error {
  constructor(message, code = 'PERMISSION_DENIED') {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
  }
}

class OwnerAccess {
  constructor() {
    this.superOwners = new Set();
  }

  addSuperOwner(ownerKey) {
    this.superOwners.add(ownerKey);
  }

  removeSuperOwner(ownerKey) {
    this.superOwners.delete(ownerKey);
  }

  isSuperOwner(ownerKey) {
    return this.superOwners.has(ownerKey);
  }

  async assertTaskOwner(taskId, ownerKey, options = {}) {
    const { allowSuperOwner = true, allowSystemScope = true } = options;
    
    if (!ownerKey) {
      throw new PermissionError('Owner key is required', 'MISSING_OWNER_KEY');
    }
    
    if (allowSuperOwner && this.isSuperOwner(ownerKey)) {
      return true;
    }
    
    const task = await taskStore.getTaskById(taskId);
    
    if (!task) {
      throw new PermissionError('Task not found', 'TASK_NOT_FOUND');
    }
    
    if (allowSystemScope && task.scopeKind === SCOPE_KINDS.SYSTEM) {
      return true;
    }
    
    if (task.ownerKey !== ownerKey) {
      throw new PermissionError(
        `Not authorized to access task ${taskId}`,
        'NOT_TASK_OWNER'
      );
    }
    
    return true;
  }

  async assertFlowOwner(flowId, ownerKey, options = {}) {
    const { allowSuperOwner = true, allowSystemScope = true } = options;
    
    if (!ownerKey) {
      throw new PermissionError('Owner key is required', 'MISSING_OWNER_KEY');
    }
    
    if (allowSuperOwner && this.isSuperOwner(ownerKey)) {
      return true;
    }
    
    const flow = await taskFlowStore.getFlowById(flowId);
    
    if (!flow) {
      throw new PermissionError('Flow not found', 'FLOW_NOT_FOUND');
    }
    
    if (allowSystemScope && flow.scopeKind === SCOPE_KINDS.SYSTEM) {
      return true;
    }
    
    if (flow.ownerKey !== ownerKey) {
      throw new PermissionError(
        `Not authorized to access flow ${flowId}`,
        'NOT_FLOW_OWNER'
      );
    }
    
    return true;
  }

  async canAccessTask(taskId, ownerKey) {
    try {
      await this.assertTaskOwner(taskId, ownerKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  async canAccessFlow(flowId, ownerKey) {
    try {
      await this.assertFlowOwner(flowId, ownerKey);
      return true;
    } catch (e) {
      return false;
    }
  }

  async filterTasksByOwner(tasks, ownerKey, options = {}) {
    const { allowSystemScope = true } = options;
    
    return tasks.filter(task => {
      if (allowSystemScope && task.scopeKind === SCOPE_KINDS.SYSTEM) {
        return true;
      }
      return task.ownerKey === ownerKey;
    });
  }

  async getTasksForOwner(ownerKey, filters = {}) {
    return taskStore.listTasks({
      ...filters,
      ownerKey
    });
  }

  async getFlowsForOwner(ownerKey, filters = {}) {
    return taskFlowStore.listFlows({
      ...filters,
      ownerKey
    });
  }

  async transferOwnership(taskId, newOwnerKey, currentOwnerKey) {
    await this.assertTaskOwner(taskId, currentOwnerKey, { allowSystemScope: false });
    
    if (!newOwnerKey || newOwnerKey.trim() === '') {
      throw new PermissionError('New owner key is required', 'MISSING_NEW_OWNER');
    }
    
    return taskStore.updateTask(taskId, { ownerKey: newOwnerKey });
  }

  async setTaskScope(taskId, scopeKind, ownerKey) {
    await this.assertTaskOwner(taskId, ownerKey);
    
    if (!Object.values(SCOPE_KINDS).includes(scopeKind)) {
      throw new PermissionError(
        `Invalid scope kind: ${scopeKind}`,
        'INVALID_SCOPE_KIND'
      );
    }
    
    return taskStore.updateTask(taskId, { scopeKind });
  }
}

const ownerAccess = new OwnerAccess();

module.exports = {
  OwnerAccess,
  ownerAccess,
  PermissionError,
  SCOPE_KINDS
};
