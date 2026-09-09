const { EventEmitter } = require('events');

const DEPENDENCY_TYPES = {
  SEQUENTIAL: 'sequential',
  PARALLEL: 'parallel',
  CONDITIONAL: 'conditional'
};

const DEPENDENCY_STATES = {
  PENDING: 'pending',
  WAITING: 'waiting',
  READY: 'ready',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

class TaskDependencyManager extends EventEmitter {
  constructor() {
    super();
    
    this.dependencies = new Map();
    this.dependents = new Map();
    this.dependencyGraph = new Map();
    this.executionOrder = [];
    this.maxDepth = 50; // Increased from 10 to support deep dependency chains
    
    console.log('🔗 任务依赖管理器已初始化');
  }
  
  addDependency(taskId, dependsOnTaskId, options = {}) {
    const { 
      type = DEPENDENCY_TYPES.SEQUENTIAL,
      condition = null,
      required = true,
      timeout = 3600000
    } = options;
    
    if (taskId === dependsOnTaskId) {
      return {
        success: false,
        error: '任务不能依赖自身'
      };
    }
    
    if (!this.dependencies.has(taskId)) {
      this.dependencies.set(taskId, []);
    }
    
    const existingDeps = this.dependencies.get(taskId);
    if (existingDeps.some(d => d.taskId === dependsOnTaskId)) {
      return {
        success: false,
        error: '依赖关系已存在'
      };
    }
    
    this.dependencies.get(taskId).push({
      taskId: dependsOnTaskId,
      type,
      condition,
      required,
      timeout,
      state: DEPENDENCY_STATES.PENDING,
      addedAt: Date.now()
    });
    
    if (!this.dependents.has(dependsOnTaskId)) {
      this.dependents.set(dependsOnTaskId, []);
    }
    this.dependents.get(dependsOnTaskId).push(taskId);
    
    this.rebuildDependencyGraph();
    
    const cycleCheck = this.detectCycle(taskId);
    if (cycleCheck.hasCycle) {
      this.removeDependency(taskId, dependsOnTaskId);
      return {
        success: false,
        error: `检测到循环依赖: ${cycleCheck.cycle.join(' -> ')}`
      };
    }
    
    console.log(`🔗 添加依赖: ${taskId} -> ${dependsOnTaskId} (${type})`);
    
    this.emit('dependency_added', { taskId, dependsOnTaskId, type });
    
    return {
      success: true,
      message: '依赖关系已添加'
    };
  }
  
  removeDependency(taskId, dependsOnTaskId) {
    const deps = this.dependencies.get(taskId);
    if (!deps) {
      return { success: false, error: '依赖关系不存在' };
    }
    
    const index = deps.findIndex(d => d.taskId === dependsOnTaskId);
    if (index === -1) {
      return { success: false, error: '依赖关系不存在' };
    }
    
    deps.splice(index, 1);
    
    const dependents = this.dependents.get(dependsOnTaskId);
    if (dependents) {
      const depIndex = dependents.indexOf(taskId);
      if (depIndex !== -1) {
        dependents.splice(depIndex, 1);
      }
    }
    
    this.rebuildDependencyGraph();
    
    console.log(`🔗 移除依赖: ${taskId} -> ${dependsOnTaskId}`);
    
    this.emit('dependency_removed', { taskId, dependsOnTaskId });
    
    return { success: true };
  }
  
  getDependencies(taskId) {
    const deps = this.dependencies.get(taskId);
    return deps ? deps.map(d => d.taskId) : [];
  }
  
  getDependents(taskId) {
    const dependents = this.dependents.get(taskId);
    return dependents ? [...dependents] : [];
  }
  
  getDependencyDetails(taskId) {
    return this.dependencies.get(taskId) || [];
  }
  
  async checkDependenciesMet(taskId, getTaskStatus) {
    const deps = this.dependencies.get(taskId);
    
    if (!deps || deps.length === 0) {
      return { met: true, reason: '无依赖' };
    }
    
    const unmetDeps = [];
    const failedDeps = [];
    
    for (const dep of deps) {
      const status = await getTaskStatus(dep.taskId);
      
      if (dep.required) {
        if (status !== 'completed' && status !== 'succeeded') {
          if (status === 'failed' || status === 'cancelled') {
            failedDeps.push(dep.taskId);
          } else {
            unmetDeps.push(dep.taskId);
          }
        }
        
        if (dep.condition) {
          const conditionMet = await this.evaluateCondition(dep.condition, dep.taskId);
          if (!conditionMet) {
            unmetDeps.push(dep.taskId);
          }
        }
      }
    }
    
    if (failedDeps.length > 0) {
      return {
        met: false,
        reason: `依赖任务失败: ${failedDeps.join(', ')}`,
        failedDeps
      };
    }
    
    if (unmetDeps.length > 0) {
      return {
        met: false,
        reason: `依赖未满足: ${unmetDeps.join(', ')}`,
        unmetDeps
      };
    }
    
    return { met: true, reason: '所有依赖已满足' };
  }
  
  async evaluateCondition(condition, taskId) {
    if (typeof condition === 'function') {
      try {
        return await condition(taskId);
      } catch (e) {
        console.error(`条件评估失败 (${taskId}):`, e.message);
        return false;
      }
    }
    
    if (typeof condition === 'object') {
      const { field, operator, value } = condition;
      return this.evaluateSimpleCondition(field, operator, value);
    }
    
    return true;
  }
  
  evaluateSimpleCondition(field, operator, value) {
    switch (operator) {
      case 'equals': return field === value;
      case 'not_equals': return field !== value;
      case 'contains': return String(field).includes(value);
      case 'greater_than': return Number(field) > Number(value);
      case 'less_than': return Number(field) < Number(value);
      default: return false;
    }
  }
  
  rebuildDependencyGraph() {
    this.dependencyGraph.clear();
    
    for (const [taskId, deps] of this.dependencies) {
      this.dependencyGraph.set(taskId, {
        dependencies: deps.map(d => d.taskId),
        dependents: this.dependents.get(taskId) || []
      });
    }
    
    for (const [taskId, dependents] of this.dependents) {
      if (!this.dependencyGraph.has(taskId)) {
        this.dependencyGraph.set(taskId, {
          dependencies: [],
          dependents: dependents
        });
      }
    }
  }
  
  detectCycle(startTaskId) {
    const visited = new Set();
    const recursionStack = new Set();
    const path = [];
    
    const hasCycle = (taskId, depth = 0) => {
      if (depth > this.maxDepth) {
        return { hasCycle: false, cycle: [] };
      }
      
      visited.add(taskId);
      recursionStack.add(taskId);
      path.push(taskId);
      
      const deps = this.dependencies.get(taskId) || [];
      
      for (const dep of deps) {
        if (!visited.has(dep.taskId)) {
          const result = hasCycle(dep.taskId, depth + 1);
          if (result.hasCycle) {
            return result;
          }
        } else if (recursionStack.has(dep.taskId)) {
          const cycleStart = path.indexOf(dep.taskId);
          return {
            hasCycle: true,
            cycle: [...path.slice(cycleStart), dep.taskId]
          };
        }
      }
      
      recursionStack.delete(taskId);
      path.pop();
      
      return { hasCycle: false, cycle: [] };
    };
    
    return hasCycle(startTaskId);
  }
  
  getExecutionOrder(taskIds) {
    const order = [];
    const visited = new Set();
    const visiting = new Set();
    
    const visit = (taskId, depth = 0) => {
      if (depth > this.maxDepth) return;
      if (visited.has(taskId)) return;
      if (visiting.has(taskId)) {
        console.warn(`检测到循环依赖: ${taskId}`);
        return;
      }
      
      visiting.add(taskId);
      
      const deps = this.dependencies.get(taskId) || [];
      for (const dep of deps) {
        visit(dep.taskId, depth + 1);
      }
      
      visiting.delete(taskId);
      visited.add(taskId);
      order.push(taskId);
    };
    
    for (const taskId of taskIds) {
      visit(taskId);
    }
    
    this.executionOrder = order;
    
    return order;
  }
  
  getParallelGroups(taskIds) {
    const order = this.getExecutionOrder(taskIds);
    const groups = [];
    const assigned = new Set();
    
    while (assigned.size < order.length) {
      const group = [];
      
      for (const taskId of order) {
        if (assigned.has(taskId)) continue;
        
        const deps = this.dependencies.get(taskId) || [];
        const allDepsAssigned = deps.every(d => assigned.has(d.taskId));
        
        if (allDepsAssigned) {
          group.push(taskId);
        }
      }
      
      if (group.length === 0) {
        const remaining = order.filter(id => !assigned.has(id));
        if (remaining.length > 0) {
          group.push(remaining[0]);
        } else {
          break;
        }
      }
      
      for (const taskId of group) {
        assigned.add(taskId);
      }
      
      groups.push(group);
    }
    
    return groups;
  }
  
  getDependencyDepth(taskId) {
    const visited = new Set();
    
    const getDepth = (id, depth = 0) => {
      if (visited.has(id)) return depth;
      visited.add(id);
      
      const deps = this.dependencies.get(id) || [];
      if (deps.length === 0) return depth;
      
      const maxDepDepth = Math.max(
        ...deps.map(d => getDepth(d.taskId, depth + 1))
      );
      
      return maxDepDepth;
    };
    
    return getDepth(taskId);
  }
  
  getStatistics() {
    let totalDependencies = 0;
    let maxDepth = 0;
    const tasksWithDeps = [];
    
    for (const [taskId, deps] of this.dependencies) {
      totalDependencies += deps.length;
      const depth = this.getDependencyDepth(taskId);
      maxDepth = Math.max(maxDepth, depth);
      
      if (deps.length > 0) {
        tasksWithDeps.push({
          taskId,
          dependencyCount: deps.length,
          depth
        });
      }
    }
    
    return {
      totalTasks: this.dependencyGraph.size,
      tasksWithDependencies: tasksWithDeps.length,
      totalDependencies,
      maxDependencyDepth: maxDepth,
      averageDependencies: this.dependencyGraph.size > 0 
        ? (totalDependencies / this.dependencyGraph.size).toFixed(2)
        : 0
    };
  }
  
  clearDependencies(taskId) {
    const deps = this.dependencies.get(taskId);
    if (deps) {
      for (const dep of deps) {
        const dependents = this.dependents.get(dep.taskId);
        if (dependents) {
          const index = dependents.indexOf(taskId);
          if (index !== -1) {
            dependents.splice(index, 1);
          }
        }
      }
      
      this.dependencies.delete(taskId);
    }
    
    this.dependents.delete(taskId);
    this.dependencyGraph.delete(taskId);
    
    this.rebuildDependencyGraph();
    
    console.log(`🔗 清除任务依赖: ${taskId}`);
  }
  
  clearAllDependencies() {
    this.dependencies.clear();
    this.dependents.clear();
    this.dependencyGraph.clear();
    this.executionOrder = [];
    
    console.log('🔗 清除所有任务依赖');
  }
}

let instance = null;

function getTaskDependencyManager() {
  if (!instance) {
    instance = new TaskDependencyManager();
  }
  return instance;
}

module.exports = {
  TaskDependencyManager,
  getTaskDependencyManager,
  DEPENDENCY_TYPES,
  DEPENDENCY_STATES
};
