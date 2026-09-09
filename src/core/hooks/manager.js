/**
 * Event Hooks - 可扩展事件系统
 * 
 * 事件类型:
 * - gateway:startup / gateway:shutdown
 * - session:start / session:end
 * - agent:start / agent:step / agent:end
 * - command:* (通配符匹配)
 * - tool:before / tool:after
 * - error:*
 * 
 * 存储: ~/.crabpaw/hooks/
 */

const fs = require('fs');
const path = require('path');
const { safeEvaluate } = require('../security/safe-expression');
const { getCrabPawSubDir } = require('../path-utils');

class EventEmitter {
  constructor() {
    this._handlers = new Map();
    this._onceHandlers = new Map();
    this._wildcards = [];
  }
  
  on(eventType, handler) {
    if (!this._handlers.has(eventType)) {
      this._handlers.set(eventType, []);
    }
    this._handlers.get(eventType).push(handler);
    return () => this.off(eventType, handler);
  }
  
  once(eventType, handler) {
    if (!this._onceHandlers.has(eventType)) {
      this._onceHandlers.set(eventType, []);
    }
    this._onceHandlers.get(eventType).push(handler);
    return () => this._offOnce(eventType, handler);
  }
  
  off(eventType, handler) {
    const handlers = this._handlers.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }
  
  _offOnce(eventType, handler) {
    const handlers = this._onceHandlers.get(eventType);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index !== -1) {
        handlers.splice(index, 1);
      }
    }
  }
  
  async emit(eventType, context = {}) {
    const handlers = this._handlers.get(eventType) || [];
    const onceHandlers = this._onceHandlers.get(eventType) || [];
    
    const wildcardHandlers = this._matchWildcards(eventType);
    
    const allHandlers = [
      ...handlers,
      ...onceHandlers,
      ...wildcardHandlers
    ];
    
    if (onceHandlers.length > 0) {
      this._onceHandlers.delete(eventType);
    }
    
    const results = [];
    
    for (const handler of allHandlers) {
      try {
        const result = handler(eventType, context);
        if (result instanceof Promise) {
          results.push(await result);
        } else {
          results.push(result);
        }
      } catch (err) {
        console.error(`[hooks] Error in handler for '${eventType}':`, err.message);
        results.push({ error: err.message });
      }
    }
    
    return results;
  }
  
  _matchWildcards(eventType) {
    const handlers = [];
    
    for (const { pattern, handler } of this._wildcards) {
      if (this._matchPattern(pattern, eventType)) {
        handlers.push(handler);
      }
    }
    
    return handlers;
  }
  
  _matchPattern(pattern, eventType) {
    if (pattern.endsWith(':*')) {
      const base = pattern.slice(0, -2);
      return eventType.startsWith(base + ':');
    }
    
    if (pattern.startsWith('*:')) {
      const suffix = pattern.slice(2);
      return eventType.endsWith(':' + suffix);
    }
    
    if (pattern === '*') {
      return true;
    }
    
    return pattern === eventType;
  }
  
  onWildcard(pattern, handler) {
    this._wildcards.push({ pattern, handler });
    return () => {
      const index = this._wildcards.findIndex(w => w.pattern === pattern && w.handler === handler);
      if (index !== -1) {
        this._wildcards.splice(index, 1);
      }
    };
  }
  
  removeAllListeners(eventType) {
    if (eventType) {
      this._handlers.delete(eventType);
      this._onceHandlers.delete(eventType);
    } else {
      this._handlers.clear();
      this._onceHandlers.clear();
      this._wildcards = [];
    }
  }
  
  listenerCount(eventType) {
    const handlers = this._handlers.get(eventType) || [];
    const onceHandlers = this._onceHandlers.get(eventType) || [];
    const wildcardCount = this._matchWildcards(eventType).length;
    return handlers.length + onceHandlers.length + wildcardCount;
  }
}

class HookManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.hooksPath = config.hooksPath || getCrabPawSubDir('hooks');
    
    this._loadedHooks = new Map();
    this._loadHooks();
  }
  
  registerHook(name, eventType, handler, options = {}) {
    const hook = {
      name,
      eventType,
      handler,
      enabled: options.enabled !== false,
      priority: options.priority || 0,
      description: options.description || '',
      createdAt: Date.now()
    };
    
    if (eventType.includes('*')) {
      this.onWildcard(eventType, handler);
    } else {
      this.on(eventType, handler);
    }
    
    this._loadedHooks.set(name, hook);
    this._saveHook(name, hook);
    
    return hook;
  }
  
  unregisterHook(name) {
    const hook = this._loadedHooks.get(name);
    if (!hook) return false;
    
    this.off(hook.eventType, hook.handler);
    this._loadedHooks.delete(name);
    this._deleteHookFile(name);
    
    return true;
  }
  
  enableHook(name) {
    const hook = this._loadedHooks.get(name);
    if (hook) {
      hook.enabled = true;
      this._saveHook(name, hook);
      return true;
    }
    return false;
  }
  
  disableHook(name) {
    const hook = this._loadedHooks.get(name);
    if (hook) {
      hook.enabled = false;
      this._saveHook(name, hook);
      return true;
    }
    return false;
  }
  
  getHook(name) {
    return this._loadedHooks.get(name);
  }
  
  listHooks() {
    return Array.from(this._loadedHooks.values());
  }
  
  async emitWithHooks(eventType, context = {}) {
    const enrichedContext = {
      ...context,
      eventType,
      timestamp: Date.now()
    };
    
    return this.emit(eventType, enrichedContext);
  }

  // ─── pre_llm_call 上下文注入 ────────────────────────────────

  /**
   * 触发 pre_llm_call 钩子并收集上下文注入
   *
   * 钩子可以返回字符串或 { context: "..." }，该文本将被追加到
   * 当前轮次的用户消息末尾（不修改系统提示，保留前缀缓存）。
   *
   * 注入规则：
   * - 返回 None/undefined → 不注入
   * - 返回字符串 → 直接注入
   * - 返回 { context: "..." } → 注入 context 值
   * - 多个钩子注入时，按注册顺序用双换行符连接
   * - 所有注入均为临时性，不持久化到对话历史
   *
   * @param {object} context
   * @param {string} context.sessionId 会话 ID
   * @param {string} context.userMessage 用户原始消息
   * @param {Array}  context.conversationHistory 对话历史副本
   * @param {boolean} context.isFirstTurn 是否新会话第一轮
   * @param {string} context.model 模型标识符
   * @param {string} context.platform 运行平台
   * @returns {string|null} 拼接后的注入上下文，或 null
   */
  async emitPreLLMCall(context = {}) {
    const enrichedContext = {
      ...context,
      eventType: EVENT_TYPES.PRE_LLM_CALL,
      timestamp: Date.now(),
    };

    const results = await this.emit(EVENT_TYPES.PRE_LLM_CALL, enrichedContext);

    const injections = [];
    for (const result of results) {
      if (result == null || result === undefined) continue;

      if (typeof result === 'string' && result.length > 0) {
        injections.push(result);
      } else if (typeof result === 'object' && result.context) {
        injections.push(result.context);
      }
    }

    return injections.length > 0 ? injections.join('\n\n') : null;
  }

  /**
   * 触发 post_llm_call 钩子
   *
   * @param {object} context
   * @param {string} context.sessionId 会话 ID
   * @param {string} context.userMessage 用户原始消息
   * @param {string} context.assistantResponse Agent 最终文本响应
   * @param {Array}  context.conversationHistory 完整消息列表副本
   * @param {string} context.model 模型标识符
   * @param {string} context.platform 运行平台
   */
  async emitPostLLMCall(context = {}) {
    const enrichedContext = {
      ...context,
      eventType: EVENT_TYPES.POST_LLM_CALL,
      timestamp: Date.now(),
    };

    return this.emit(EVENT_TYPES.POST_LLM_CALL, enrichedContext);
  }

  // ─── BOOT.md 启动钩子 ──────────────────────────────────────

  /**
   * 检查并执行 BOOT.md 启动指令
   *
   * - 检查 ~/.crabpaw/BOOT.md 是否存在
   * - 如果存在，返回其内容供 Agent 在后台会话中执行
   * - 如果不存在，静默跳过
   *
   * @returns {{ found: boolean, content: string|null, path: string }}
   */
  checkBootMd() {
    const bootPath = path.join(path.dirname(this.hooksPath), 'BOOT.md');

    try {
      if (fs.existsSync(bootPath)) {
        const content = fs.readFileSync(bootPath, 'utf8').trim();
        if (content.length > 0) {
          this.emit(EVENT_TYPES.GATEWAY_STARTUP, {
            bootMd: true,
            bootPath,
            contentLength: content.length,
          });
          return { found: true, content, path: bootPath };
        }
      }
    } catch (err) {
      console.error('[hooks] BOOT.md 读取失败:', err.message);
    }

    return { found: false, content: null, path: bootPath };
  }
  
  _loadHooks() {
    try {
      if (!fs.existsSync(this.hooksPath)) {
        fs.mkdirSync(this.hooksPath, { recursive: true });
        return;
      }
      
      const files = fs.readdirSync(this.hooksPath).filter(f => f.endsWith('.json'));
      
      for (const file of files) {
        try {
          const hookPath = path.join(this.hooksPath, file);
          const hookData = JSON.parse(fs.readFileSync(hookPath, 'utf8'));
          
          if (hookData.enabled === false) continue;
          
          let handler;
          
          if (hookData.handlerType === 'file') {
            const handlerPath = path.resolve(this.hooksPath, hookData.handlerPath);
            if (fs.existsSync(handlerPath)) {
              handler = require(handlerPath);
            }
          } else if (hookData.handlerType === 'inline') {
            const code = hookData.handlerCode || '';
            handler = (eventType, context) => {
              const result = safeEvaluate(code, { eventType, ...context });
              return result.value;
            };
          } else {
            handler = (eventType, context) => {
              console.log(`[${hookData.name}] ${eventType}:`, context);
            };
          }
          
          if (handler) {
            hookData.handler = handler;
            this._loadedHooks.set(hookData.name, hookData);
            
            if (hookData.eventType.includes('*')) {
              this.onWildcard(hookData.eventType, handler);
            } else {
              this.on(hookData.eventType, handler);
            }
          }
        } catch (err) {
          console.error(`Failed to load hook from ${file}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Failed to load hooks:', err.message);
    }
  }
  
  _saveHook(name, hook) {
    try {
      if (!fs.existsSync(this.hooksPath)) {
        fs.mkdirSync(this.hooksPath, { recursive: true });
      }
      
      const hookPath = path.join(this.hooksPath, `${name}.json`);
      
      const saveData = {
        name: hook.name,
        eventType: hook.eventType,
        enabled: hook.enabled,
        priority: hook.priority,
        description: hook.description,
        createdAt: hook.createdAt,
        handlerType: 'inline',
        handlerCode: hook.handler.toString()
      };
      
      fs.writeFileSync(hookPath, JSON.stringify(saveData, null, 2));
    } catch (err) {
      console.error(`Failed to save hook ${name}:`, err.message);
    }
  }
  
  _deleteHookFile(name) {
    try {
      const hookPath = path.join(this.hooksPath, `${name}.json`);
      if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
      }
    } catch (err) {
      console.error(`Failed to delete hook file ${name}:`, err.message);
    }
  }
}

const EVENT_TYPES = {
  GATEWAY_STARTUP: 'gateway:startup',
  GATEWAY_SHUTDOWN: 'gateway:shutdown',
  SESSION_START: 'session:start',
  SESSION_END: 'session:end',
  AGENT_START: 'agent:start',
  AGENT_STEP: 'agent:step',
  AGENT_END: 'agent:end',
  TOOL_BEFORE: 'tool:before',
  TOOL_AFTER: 'tool:after',
  ERROR: 'error',
  COMMAND: 'command',
  // 新增：LLM 生命周期钩子
  PRE_LLM_CALL: 'pre_llm_call',
  POST_LLM_CALL: 'post_llm_call',
};

function createStandardHooks(hookManager) {
  hookManager.registerHook('logger', '*', (eventType, context) => {
    console.log(`[${new Date().toISOString()}] ${eventType}`, context);
  }, { description: '记录所有事件' });
  
  hookManager.registerHook('session-tracker', 'session:*', (eventType, context) => {
    console.log(`会话事件: ${eventType}`, context.sessionId);
  }, { description: '跟踪会话事件' });
  
  hookManager.registerHook('error-handler', 'error:*', (eventType, context) => {
    console.error(`错误: ${eventType}`, context.error);
  }, { description: '处理错误事件' });
}

// 2026-08-25 S1：单例化（此前模块仅被 src/core/index.js lazyRequire 导出、
// 无任何启动接线——用户钩子 JSON 文件永不加载，均为孤儿）。
let _hookManager = null;

function getHookManager() {
  if (!_hookManager) {
    _hookManager = new HookManager();
    createStandardHooks(_hookManager);
  }
  return _hookManager;
}

module.exports = {
  EventEmitter,
  HookManager,
  EVENT_TYPES,
  createStandardHooks,
  getHookManager,
};
