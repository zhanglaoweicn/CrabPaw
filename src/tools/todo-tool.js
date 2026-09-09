const { registry } = require('../tools/registry');
const { taskExecutor } = require('../tasks/core/task-executor');
// eslint-disable-next-line no-unused-vars -- 任务清洗在 taskExecutor 内部完成，此模块暂不直接调用 sanitize
const { sanitizeTaskList, sanitizeTaskError } = require('../tasks/core/task-sanitizer');

const VALID_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

class TodoManager {
  constructor() {
    this._todos = [];
    this._nextId = 1;
    this._sessionKey = 'default';
    this._ownerKey = 'default';
  }

  setSessionContext(sessionKey, ownerKey) {
    this._sessionKey = sessionKey || 'default';
    this._ownerKey = ownerKey || 'default';
  }

  setTodos(todos) {
    this._todos = todos.map((t, i) => ({
      id: t.id || String(this._nextId + i),
      content: t.content || '',
      status: t.status || 'pending',
      priority: t.priority || 'medium',
    }));
    this._nextId = this._todos.length + 1;
    return this._todos;
  }

  getTodos() {
    return [...this._todos];
  }

  getActiveTodos() {
    return this._todos.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
  }

  formatForInjection() {
    const active = this.getActiveTodos();
    if (active.length === 0) return '';

    const statusEmoji = {
      pending: '⬜',
      in_progress: '🔄',
      completed: '✅',
      cancelled: '❌'
    };

    const lines = active.map(t =>
      `${statusEmoji[t.status] || '⬜'} [${t.id}] ${t.content} (${t.priority})`
    );

    return `\n\n## 当前任务列表\n${lines.join('\n')}\n请按顺序完成任务，完成一项后更新状态。`;
  }

  clear() {
    this._todos = [];
    this._nextId = 1;
  }

  async persistTodos() {
    if (this._todos.length === 0) return;
    
    for (const todo of this._todos) {
      try {
        await taskExecutor.createTask({
          ownerKey: this._ownerKey,
          sessionKey: this._sessionKey,
          content: todo.content,
          status: todo.status,
          priority: todo.priority
        });
      } catch (e) {
        console.error('持久化任务失败:', e);
      }
    }
  }

  async loadPersistedTodos() {
    try {
      const tasks = await taskExecutor.listTasks({ 
        sessionKey: this._sessionKey,
        status: ['pending', 'in_progress']
      });
      
      this._todos = tasks.map(t => ({
        id: t.taskId,
        content: t.content,
        status: t.status,
        priority: t.priority
      }));
      
      this._nextId = this._todos.length + 1;
      return this._todos;
    } catch (e) {
      console.error('加载持久化任务失败:', e);
      return [];
    }
  }
}

const globalTodoManager = new TodoManager();

registry.register({
  name: 'TodoWrite',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: `管理当前会话的任务列表。用于跟踪多步骤任务的进度，确保不遗漏。

使用场景：
- 复杂任务（3+步骤）需要分解和跟踪
- 用户提供多个任务需要逐一完成
- 需要在长对话中保持任务状态

任务状态：
- pending: 未开始
- in_progress: 进行中（建议同时只有一个）
- completed: 已完成
- cancelled: 已取消

最佳实践：
- 列表顺序即优先级
- 完成一项立即标记 completed
- 失败时取消并添加修订项

压缩后任务列表会自动重新注入上下文。`,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '任务列表，每项包含 content(描述)、status(pending/in_progress/completed/cancelled)、priority(high/medium/low)',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '任务描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] }
            },
            required: ['content', 'status']
          }
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          description: 'replace=替换整个列表, merge=合并更新(按content匹配)'
        }
      },
      required: ['todos']
    }
  },
  handler: async (params, context) => {
    const { todos, mode = 'replace' } = params;
    const sessionKey = context?.sessionKey || 'default';
    const ownerKey = context?.userId || 'default';

    if (!Array.isArray(todos) || todos.length === 0) {
      return { error: '任务列表不能为空' };
    }

    if (todos.length > 10) {
      return { error: '任务列表最多10项，请精简' };
    }

    for (const todo of todos) {
      if (!todo.content || !todo.status) {
        return { error: '每个任务必须包含 content 和 status' };
      }
      if (!VALID_STATUSES.includes(todo.status)) {
        return { error: `无效状态: ${todo.status}` };
      }
    }

    globalTodoManager.setSessionContext(sessionKey, ownerKey);

    if (mode === 'merge') {
      const existing = globalTodoManager.getTodos();
      const updated = existing.map(e => {
        const match = todos.find(t => t.content && t.content === e.content);
        if (match) {
          return { ...e, ...match, id: e.id };
        }
        return e;
      });

      const newItems = todos.filter(t => !existing.some(e => e.content === t.content));
      for (const item of newItems) {
        updated.push(item);
      }

      globalTodoManager.setTodos(updated);
    } else {
      globalTodoManager.setTodos(todos);
    }

    const result = globalTodoManager.getTodos();
    const statusEmoji = { pending: '⬜', in_progress: '🔄', completed: '✅', cancelled: '❌' };

    const formatted = result.map(t =>
      `${statusEmoji[t.status] || '⬜'} [${t.id}] ${t.content} (${t.priority || 'medium'})`
    ).join('\n');

    const stats = {
      total: result.length,
      pending: result.filter(t => t.status === 'pending').length,
      inProgress: result.filter(t => t.status === 'in_progress').length,
      completed: result.filter(t => t.status === 'completed').length,
      cancelled: result.filter(t => t.status === 'cancelled').length
    };

    return {
      success: true,
      message: `📋 任务列表已更新:\n${formatted}`,
      todos: result,
      stats
    };
  },
  isReadOnly: false
});

registry.register({
  name: 'TodoRead',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: '读取当前会话的任务列表',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'active', 'pending', 'in_progress', 'completed'],
          description: '筛选条件，默认active(未完成)'
        }
      }
    }
  },
  handler: async (params, context) => {
    const { filter = 'active' } = params;
    const sessionKey = context?.sessionKey || 'default';
    
    globalTodoManager.setSessionContext(sessionKey, context?.userId || 'default');
    
    let todos;

    if (filter === 'all') {
      todos = globalTodoManager.getTodos();
    } else if (filter === 'active') {
      todos = globalTodoManager.getActiveTodos();
    } else {
      todos = globalTodoManager.getTodos().filter(t => t.status === filter);
    }

    if (todos.length === 0) {
      return {
        success: true,
        message: '📋 当前没有任务',
        todos: [],
        stats: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 }
      };
    }

    const statusEmoji = { pending: '⬜', in_progress: '🔄', completed: '✅', cancelled: '❌' };
    const formatted = todos.map(t =>
      `${statusEmoji[t.status] || '⬜'} [${t.id}] ${t.content} (${t.priority || 'medium'})`
    ).join('\n');

    const stats = {
      total: todos.length,
      pending: todos.filter(t => t.status === 'pending').length,
      inProgress: todos.filter(t => t.status === 'in_progress').length,
      completed: todos.filter(t => t.status === 'completed').length,
      cancelled: todos.filter(t => t.status === 'cancelled').length
    };

    return {
      success: true,
      message: `📋 当前任务列表:\n${formatted}`,
      todos,
      stats
    };
  },
  isReadOnly: true
});

registry.register({
  name: 'todo',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: `统一的任务管理工具（推荐使用）。支持读写合一模式。

省略 todos 参数：读取当前任务列表
提供 todos 参数：写入/更新任务列表

这是 TodoWrite/TodoRead 的统一版本，更简洁易用。`,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '任务列表。省略则读取当前列表。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '任务ID' },
              content: { type: 'string', description: '任务描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] }
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
          description: '读取时的筛选条件，默认 active'
        }
      }
    }
  },
  handler: async (params, context) => {
    const sessionKey = context?.sessionKey || 'default';
    const ownerKey = context?.userId || 'default';
    
    globalTodoManager.setSessionContext(sessionKey, ownerKey);
    
    if (params.todos !== undefined) {
      const writeParams = {
        todos: params.todos,
        mode: params.merge ? 'merge' : 'replace'
      };
      return registry.get('TodoWrite').handler(writeParams, context);
    }
    
    return registry.get('TodoRead').handler({ filter: params.filter }, context);
  },
  isReadOnly: false
});

module.exports = { TodoManager, globalTodoManager };

console.log('✅ Todo 工具已注册: TodoWrite, TodoRead, todo (统一版)');
