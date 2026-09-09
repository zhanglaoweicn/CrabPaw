const { registry } = require('../../tools/registry');
const { taskExecutor, TASK_STATUS } = require('./task-executor');
// eslint-disable-next-line no-unused-vars
const { ownerAccess } = require('./task-owner-access');
const { sanitizeTaskList, sanitizeTaskError } = require('./task-sanitizer');

const VALID_STATUSES = Object.values(TASK_STATUS).filter(s => 
  ['pending', 'in_progress', 'completed', 'cancelled'].includes(s)
);

class TodoManager {
  constructor() {
    this._sessionTodos = new Map();
  }

  async getOrCreateSessionTodos(sessionKey) {
    if (!this._sessionTodos.has(sessionKey)) {
      const tasks = await taskExecutor.listTasks({ 
        sessionKey,
        status: ['pending', 'in_progress']
      });
      this._sessionTodos.set(sessionKey, tasks);
    }
    return this._sessionTodos.get(sessionKey);
  }

  async writeTodos(sessionKey, todos, merge = false, ownerKey = 'default') {
    const existing = await this.getOrCreateSessionTodos(sessionKey);
    
    if (!merge) {
      for (const task of existing) {
        if (!todos.find(t => t.id === task.taskId)) {
          await taskExecutor.cancelTask(task.taskId, ownerKey);
        }
      }
      
      const newTasks = [];
      for (const todo of todos) {
        const task = await taskExecutor.createTask({
          ownerKey,
          sessionKey,
          content: todo.content,
          status: this._mapTodoStatus(todo.status),
          priority: todo.priority || 'medium'
        });
        newTasks.push(task);
      }
      
      this._sessionTodos.set(sessionKey, newTasks);
      return newTasks;
    }
    
    const updatedTasks = [];
    
    for (const todo of todos) {
      const existingTask = existing.find(t => t.taskId === todo.id);
      
      if (existingTask) {
        const updated = await taskExecutor.updateTask(todo.id, {
          content: todo.content,
          status: this._mapTodoStatus(todo.status),
          priority: todo.priority || 'medium'
        }, ownerKey);
        updatedTasks.push(updated);
      } else {
        const newTask = await taskExecutor.createTask({
          ownerKey,
          sessionKey,
          content: todo.content,
          status: this._mapTodoStatus(todo.status),
          priority: todo.priority || 'medium'
        });
        updatedTasks.push(newTask);
      }
    }
    
    this._sessionTodos.set(sessionKey, updatedTasks);
    return updatedTasks;
  }

  async readTodos(sessionKey, filter = 'active') {
    const all = await this.getOrCreateSessionTodos(sessionKey);
    
    if (filter === 'all') return all;
    if (filter === 'active') {
      return all.filter(t => t.status === 'pending' || t.status === 'in_progress');
    }
    return all.filter(t => t.status === filter);
  }

  formatForInjection(sessionKey) {
    const todos = this._sessionTodos.get(sessionKey);
    if (!todos || todos.length === 0) return '';
    
    const active = todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
    if (active.length === 0) return '';
    
    const markers = {
      'completed': '✅',
      'in_progress': '🔄',
      'pending': '⬜',
      'cancelled': '❌'
    };
    
    const lines = ['\n\n## 当前任务列表 (已从上下文恢复)'];
    for (const t of active) {
      const marker = markers[t.status] || '⬜';
      lines.push(`${marker} [${t.taskId}] ${t.content} (${t.priority})`);
    }
    lines.push('请继续跟踪和更新这个任务列表。');
    
    return lines.join('\n');
  }

  _mapTodoStatus(status) {
    const mapping = {
      'pending': 'pending',
      'in_progress': 'in_progress',
      'completed': 'completed',
      'cancelled': 'cancelled'
    };
    return mapping[status] || 'pending';
  }

  clear(sessionKey) {
    this._sessionTodos.delete(sessionKey);
  }
}

const globalTodoManager = new TodoManager();

registry.register({
  name: 'todo',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: `管理当前会话的任务列表。用于跟踪多步骤任务的进度，确保不遗漏。

使用场景：
- 复杂任务（3+步骤）需要分解和跟踪
- 用户提供多个任务需要逐一完成
- 需要在长对话中保持任务状态

操作模式：
- 省略 todos 参数：读取当前任务列表
- 提供 todos 参数：写入/更新任务列表
- merge=false（默认）：替换整个列表
- merge=true：按 id 更新现有任务，添加新任务

任务状态：
- pending: 未开始
- in_progress: 进行中（建议同时只有一个）
- completed: 已完成
- cancelled: 已取消

最佳实践：
- 列表顺序即优先级
- 完成一项立即标记 completed
- 失败时取消并添加修订项
- 每次调用返回完整列表`,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '任务列表。省略则读取当前列表。',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: '任务唯一标识符'
              },
              content: {
                type: 'string',
                description: '任务描述'
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: '任务状态'
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: '优先级'
              }
            },
            required: ['content', 'status']
          }
        },
        merge: {
          type: 'boolean',
          description: 'true=按id更新现有任务并添加新任务；false=替换整个列表',
          default: false
        },
        filter: {
          type: 'string',
          enum: ['all', 'active', 'pending', 'in_progress', 'completed', 'cancelled'],
          description: '读取时的筛选条件，默认 active（未完成）'
        }
      }
    }
  },
  handler: async (params, context) => {
    const sessionKey = context?.sessionKey || 'default';
    const ownerKey = context?.userId || 'default';
    
    try {
      if (params.todos !== undefined) {
        if (!Array.isArray(params.todos)) {
          return { error: 'todos 必须是数组' };
        }
        
        if (params.todos.length > 10) {
          return { error: '任务列表最多 10 项，请精简' };
        }
        
        for (const todo of params.todos) {
          if (!todo.content || !todo.status) {
            return { error: '每个任务必须包含 content 和 status' };
          }
          
          if (!VALID_STATUSES.includes(todo.status)) {
            return { error: `无效状态: ${todo.status}` };
          }
        }
        
        const todos = await globalTodoManager.writeTodos(
          sessionKey,
          params.todos,
          params.merge || false,
          ownerKey
        );
        
        const stats = {
          total: todos.length,
          pending: todos.filter(t => t.status === 'pending').length,
          inProgress: todos.filter(t => t.status === 'in_progress').length,
          completed: todos.filter(t => t.status === 'completed').length,
          cancelled: todos.filter(t => t.status === 'cancelled').length
        };
        
        const formatted = todos.map(t => {
          const marker = t.status === 'completed' ? '✅' 
            : t.status === 'in_progress' ? '🔄' 
            : t.status === 'cancelled' ? '❌' : '⬜';
          return `${marker} [${t.taskId}] ${t.content} (${t.priority})`;
        }).join('\n');
        
        return {
          success: true,
          message: `📋 任务列表已更新:\n${formatted}`,
          todos: sanitizeTaskList(todos),
          stats
        };
      }
      
      const filter = params.filter || 'active';
      const todos = await globalTodoManager.readTodos(sessionKey, filter);
      
      if (todos.length === 0) {
        return {
          success: true,
          message: '📋 当前没有任务',
          todos: [],
          stats: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 }
        };
      }
      
      const stats = {
        total: todos.length,
        pending: todos.filter(t => t.status === 'pending').length,
        inProgress: todos.filter(t => t.status === 'in_progress').length,
        completed: todos.filter(t => t.status === 'completed').length,
        cancelled: todos.filter(t => t.status === 'cancelled').length
      };
      
      const formatted = todos.map(t => {
        const marker = t.status === 'completed' ? '✅' 
          : t.status === 'in_progress' ? '🔄' 
          : t.status === 'cancelled' ? '❌' : '⬜';
        return `${marker} [${t.taskId}] ${t.content} (${t.priority})`;
      }).join('\n');
      
      return {
        success: true,
        message: `📋 当前任务列表:\n${formatted}`,
        todos: sanitizeTaskList(todos),
        stats
      };
      
    } catch (error) {
      return {
        success: false,
        error: sanitizeTaskError(error)
      };
    }
  },
  isReadOnly: false
});

registry.register({
  name: 'task_flow',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: '创建和管理任务流，支持任务依赖和编排。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'add_task', 'add_dependency', 'cancel', 'status'],
          description: '操作类型'
        },
        flowId: {
          type: 'string',
          description: '任务流ID'
        },
        taskId: {
          type: 'string',
          description: '任务ID'
        },
        dependsOn: {
          type: 'string',
          description: '依赖的任务ID'
        }
      },
      required: ['action']
    }
  },
  handler: async (params, context) => {
    const { taskFlowRegistry } = require('./task-executor');
    const ownerKey = context?.userId || 'default';
    
    try {
      switch (params.action) {
        case 'create': {
          const flow = await taskFlowRegistry.createFlow({ ownerKey });
          return { success: true, flowId: flow.flowId, flow };
        }
        
        case 'add_task': {
          if (!params.flowId || !params.taskId) {
            return { error: '需要 flowId 和 taskId' };
          }
          await taskFlowRegistry.addTaskToFlow(params.flowId, params.taskId);
          return { success: true };
        }
        
        case 'add_dependency': {
          if (!params.flowId || !params.taskId || !params.dependsOn) {
            return { error: '需要 flowId, taskId 和 dependsOn' };
          }
          await taskFlowRegistry.addDependency(params.flowId, params.taskId, params.dependsOn);
          return { success: true };
        }
        
        case 'cancel': {
          if (!params.flowId) {
            return { error: '需要 flowId' };
          }
          await taskFlowRegistry.cancelFlow(params.flowId);
          return { success: true };
        }
        
        case 'status': {
          if (!params.flowId) {
            return { error: '需要 flowId' };
          }
          const flow = await taskFlowRegistry.getFlow(params.flowId);
          const summary = await taskFlowRegistry.getFlowSummary(params.flowId);
          return { success: true, flow, summary };
        }
        
        default:
          return { error: `未知操作: ${params.action}` };
      }
    } catch (error) {
      return { success: false, error: sanitizeTaskError(error) };
    }
  },
  isReadOnly: false
});

module.exports = { TodoManager, globalTodoManager };

console.log('✅ Todo 工具已注册: todo, task_flow');
