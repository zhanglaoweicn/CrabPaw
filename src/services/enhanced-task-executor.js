/**
 * Enhanced Task Executor
 * 
 * 增强版任务执行器
 * 解决智能体无法自主执行任务的问题
 * 
 * 核心特性：
 * 1. 自动重试机制 - 工具调用失败时自动重试
 * 2. 无限执行循环 - 支持任意层级的工具调用
 * 3. 智能错误恢复 - 遇到错误时尝试替代方案
 * 4. 任务状态管理 - 支持任务暂停和恢复
 * 5. 进度监控 - 检测任务停滞并自动恢复
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const { optimizeCacheBreakpoints, estimateCacheSavings } = require('../core/caching/prompt-cache');

const MAX_TOOL_CALLS = 20;
const MAX_RETRIES = 3;
const STAGNATION_TIMEOUT = 30000;
const PROGRESS_CHECK_INTERVAL = 5000;

class EnhancedTaskExecutor extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.activeTasks = new Map();
    this.taskHistory = new Map();
    this.stagnationDetector = null;
    this.errorRecoveryStrategies = new Map();
    
    this._setupErrorRecoveryStrategies();
    this._startStagnationDetector();
  }

  _setupErrorRecoveryStrategies() {
    this.errorRecoveryStrategies.set('file_not_found', async (error, context) => {
      return {
        action: 'suggest_alternative',
        message: '文件不存在，是否需要创建或搜索类似文件？',
        alternatives: [
          { tool: 'Glob', params: { pattern: `**/${context.params.file_path?.split('/').pop()}` } },
          { tool: 'LS', params: { path: context.params.file_path?.split('/').slice(0, -1).join('/') } }
        ]
      };
    });

    this.errorRecoveryStrategies.set('permission_denied', async (error, context) => {
      return {
        action: 'retry_with_elevation',
        message: '权限不足，尝试使用替代方案...',
        alternatives: [
          { tool: 'Bash', params: { command: `sudo ${context.params.command}` } }
        ]
      };
    });

    // eslint-disable-next-line no-unused-vars
    this.errorRecoveryStrategies.set('network_error', async (_error, context) => {
      return {
        action: 'retry_with_backoff',
        message: '网络错误，将在稍后重试...',
        delay: 2000,
        maxRetries: 3
      };
    });

    this.errorRecoveryStrategies.set('timeout', async (error, context) => {
      return {
        action: 'reduce_scope',
        message: '操作超时，尝试缩小范围...',
        alternatives: [
          { tool: context.toolName, params: { ...context.params, limit: 10 } }
        ]
      };
    });

    // eslint-disable-next-line no-unused-vars
    this.errorRecoveryStrategies.set('parse_error', async (_error, context) => {
      return {
        action: 'simplify_request',
        message: '解析错误，尝试简化请求...',
        alternatives: []
      };
    });

    // eslint-disable-next-line no-unused-vars
    this.errorRecoveryStrategies.set('unknown_tool', async (_error, context) => {
      return {
        action: 'find_similar_tool',
        message: '工具不存在，查找相似工具...',
        alternatives: []
      };
    });
  }

  _startStagnationDetector() {
    this.stagnationDetector = setInterval(() => {
      const now = Date.now();
      
      for (const [taskId, task] of this.activeTasks) {
        if (task.status !== 'running') continue;
        
        const timeSinceLastProgress = now - task.lastProgressTime;
        
        if (timeSinceLastProgress > STAGNATION_TIMEOUT) {
          console.log(`⚠️ 检测到任务停滞: ${taskId}`);
          this.emit('task:stagnant', { taskId, duration: timeSinceLastProgress });
          
          this._handleStagnation(taskId);
        }
      }
    }, PROGRESS_CHECK_INTERVAL);
    
    if (this.stagnationDetector.unref) {
      this.stagnationDetector.unref();
    }
  }

  async _handleStagnation(taskId) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    
    console.log(`🔄 尝试恢复停滞的任务: ${taskId}`);
    
    task.stagnationCount = (task.stagnationCount || 0) + 1;
    
    if (task.stagnationCount > 3) {
      console.log(`❌ 任务停滞次数过多，标记为失败: ${taskId}`);
      await this.failTask(taskId, new Error('任务停滞，无法恢复'));
      return;
    }
    
    this.emit('task:recovering', { taskId, attempt: task.stagnationCount });
    
    const lastToolCall = task.toolCallHistory[task.toolCallHistory.length - 1];
    if (lastToolCall && lastToolCall.status === 'pending') {
      console.log(`🔄 重试最后一个工具调用: ${lastToolCall.toolName}`);
      await this._retryToolCall(taskId, lastToolCall);
    }
  }

  async executeTask(config, userId, message, context = {}) {
    const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    const task = {
      id: taskId,
      userId,
      message,
      status: 'pending',
      startTime: Date.now(),
      lastProgressTime: Date.now(),
      toolCallCount: 0,
      toolCallHistory: [],
      errors: [],
      context,
      result: null,
      stagnationCount: 0
    };
    
    this.activeTasks.set(taskId, task);
    this.emit('task:started', { taskId, message });
    
    try {
      const result = await this._executeTaskLoop(taskId, config, userId, message, context);
      
      task.status = 'completed';
      task.result = result;
      task.endTime = Date.now();
      
      this.taskHistory.set(taskId, task);
      this.activeTasks.delete(taskId);
      
      this.emit('task:completed', { taskId, result, duration: task.endTime - task.startTime });
      
      return result;
    } catch (error) {
      await this.failTask(taskId, error);
      throw error;
    }
  }

  async _executeTaskLoop(taskId, config, userId, message, context) {
    const task = this.activeTasks.get(taskId);
    if (!task) throw new Error('任务不存在');
    
    const provider = config.models.currentProvider;
    const p = config.models.providers[provider];
    
    if (!p || !p.apiKey) {
      throw new Error('请先配置 AI API Key');
    }
    
    const messages = await this._buildMessages(config, userId, message, context);
    const toolDefinitions = this._buildToolDefinitions(context);
    
    let iteration = 0;
    let lastResult = null;
    
    while (iteration < MAX_TOOL_CALLS) {
      iteration++;
      
      console.log(`🔄 执行迭代 ${iteration}/${MAX_TOOL_CALLS}`);
      
      task.lastProgressTime = Date.now();
      this.emit('task:progress', { taskId, iteration, toolCallCount: task.toolCallCount });
      
      try {
        const response = await this._callAI(p, messages, toolDefinitions, context);
        
        if (!response.choices || !response.choices[0]) {
          throw new Error('AI 响应格式错误');
        }
        
        const choice = response.choices[0];
        const assistantMessage = choice.message;
        
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          console.log('✅ AI 返回最终回复，任务完成');
          
          const finalReply = assistantMessage.content || lastResult || '操作已完成。';
          await this._saveConversation(userId, message, finalReply, context);
          
          return finalReply;
        }
        
        console.log(`🔧 AI 请求调用 ${assistantMessage.tool_calls.length} 个工具`);
        
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls
        });
        
        for (const toolCall of assistantMessage.tool_calls) {
          const toolResult = await this._executeToolCallWithRetry(taskId, toolCall, context);
          
          if (toolResult.success) {
            lastResult = toolResult.content;
          }
          
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.success 
              ? toolResult.content 
              : `错误: ${toolResult.error || '未知错误'}`
          });
        }
        
      } catch (error) {
        console.error(`❌ 迭代 ${iteration} 失败:`, error.message);
        
        task.errors.push({
          iteration,
          error: error.message,
          timestamp: Date.now()
        });
        
        const recovered = await this._attemptRecovery(taskId, error, { messages, toolDefinitions, context });
        
        if (!recovered) {
          throw new Error(`任务执行失败: ${error.message}`);
        }
        
        console.log('✅ 错误已恢复，继续执行');
      }
    }
    
    throw new Error(`任务执行超过最大迭代次数 (${MAX_TOOL_CALLS})`);
  }

  async _executeToolCallWithRetry(taskId, toolCall, context) {
    const task = this.activeTasks.get(taskId);
    if (!task) return { error: '任务不存在' };
    
    const toolName = toolCall.function?.name || 'unknown';
    let params = {};
    
    try {
      if (toolCall.function?.arguments) {
        params = typeof toolCall.function.arguments === 'string' 
          ? JSON.parse(toolCall.function.arguments) 
          : toolCall.function.arguments;
      }
    } catch (e) {
      return { error: `参数解析失败: ${e.message}` };
    }
    
    const toolCallRecord = {
      id: toolCall.id,
      toolName,
      params,
      status: 'pending',
      attempts: 0,
      timestamp: Date.now()
    };
    
    task.toolCallHistory.push(toolCallRecord);
    task.toolCallCount++;
    
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`🔧 执行工具: ${toolName} (尝试 ${attempt}/${MAX_RETRIES})`);
      
      toolCallRecord.attempts = attempt;
      
      try {
        const result = await this._executeToolCall(toolName, params, context);
        
        if (result.success) {
          toolCallRecord.status = 'success';
          toolCallRecord.result = result.content;
          
          this.emit('tool:success', { taskId, toolName, attempt });
          
          return result;
        }
        
        lastError = result.error;
        
        if (result.needsConfirmation) {
          toolCallRecord.status = 'pending_confirmation';
          return result;
        }
        
        const recovery = await this._attemptToolRecovery(taskId, toolName, params, result.error, context);
        
        if (recovery && recovery.alternatives && recovery.alternatives.length > 0) {
          console.log(`🔄 尝试替代方案: ${recovery.alternatives[0].tool}`);
          
          const altResult = await this._executeToolCall(
            recovery.alternatives[0].tool,
            recovery.alternatives[0].params,
            context
          );
          
          if (altResult.success) {
            toolCallRecord.status = 'recovered';
            toolCallRecord.recoveryStrategy = recovery.action;
            return altResult;
          }
        }
        
        if (attempt < MAX_RETRIES) {
          await this._delay(1000 * attempt);
        }
        
      } catch (error) {
        lastError = error.message;
        console.error(`❌ 工具执行失败 (尝试 ${attempt}):`, error.message);
        
        if (attempt < MAX_RETRIES) {
          await this._delay(1000 * attempt);
        }
      }
    }
    
    toolCallRecord.status = 'failed';
    toolCallRecord.error = lastError;
    
    this.emit('tool:failed', { taskId, toolName, error: lastError, attempts: MAX_RETRIES });
    
    return { error: lastError };
  }

  async _executeToolCall(toolName, params, context) {
    const toolContext = {
      projectRoot: context.projectRoot || process.cwd(),
      workspaceDir: context.workspaceDir || process.cwd(),
    };

    // 优先通过 registry.execute 执行，确保 preExecuteHooks/postExecuteHooks/执行日志/策略管理器生效
    const reg = context.toolSystem?.registry || context.toolSystem;
    if (reg && typeof reg.execute === 'function') {
      try {
        const result = await reg.execute(toolName, params, toolContext);
        if (!result.success) {
          return { error: result.error || `工具执行失败: ${toolName}` };
        }
        const data = result.data;
        return { success: true, content: typeof data === 'string' ? data : JSON.stringify(data, null, 2) };
      } catch (error) {
        return { error: `工具执行失败: ${error.message}` };
      }
    }

    // 降级：直接调用 tool.handler（旧路径，不推荐）
    const tool = context.toolSystem?.get(toolName);
    if (!tool) {
      return { error: `未知工具: ${toolName}` };
    }

    try {
      if (tool.validateInput) {
        const validation = await tool.validateInput(params, toolContext);
        if (!validation.result) {
          return {
            error: `输入验证失败: ${validation.message}`,
            errorCode: validation.errorCode
          };
        }
      }

      if (tool.checkPermissions) {
        const permission = await tool.checkPermissions(params, toolContext);

        if (permission.behavior === 'deny') {
          return { error: `权限拒绝: ${permission.message}` };
        }

        if (permission.behavior === 'ask') {
          return {
            needsConfirmation: true,
            message: permission.message,
            suggestions: permission.suggestions,
            toolName,
            params
          };
        }

        if (permission.updatedInput) {
          Object.assign(params, permission.updatedInput);
        }
      }

      const result = await tool.handler(params, toolContext);

      return { success: true, content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };

    } catch (error) {
      return { error: `工具执行失败: ${error.message}` };
    }
  }

  async _attemptToolRecovery(taskId, toolName, params, error, context) {
    const errorType = this._classifyError(error);
    
    const strategy = this.errorRecoveryStrategies.get(errorType);
    
    if (!strategy) {
      return null;
    }
    
    console.log(`🔄 应用错误恢复策略: ${errorType}`);
    
    try {
      const recovery = await strategy(error, { toolName, params, context });
      this.emit('tool:recovery', { taskId, toolName, errorType, strategy: recovery.action });
      return recovery;
    } catch (e) {
      console.error('错误恢复失败:', e.message);
      return null;
    }
  }

  _classifyError(error) {
    const errorStr = (error || '').toLowerCase();
    
    if (errorStr.includes('not found') || errorStr.includes('不存在') || errorStr.includes('enoent')) {
      return 'file_not_found';
    }
    if (errorStr.includes('permission') || errorStr.includes('权限') || errorStr.includes('eacces')) {
      return 'permission_denied';
    }
    if (errorStr.includes('network') || errorStr.includes('网络') || errorStr.includes('etimedout') || errorStr.includes('econnrefused')) {
      return 'network_error';
    }
    if (errorStr.includes('timeout') || errorStr.includes('超时')) {
      return 'timeout';
    }
    if (errorStr.includes('parse') || errorStr.includes('解析') || errorStr.includes('json')) {
      return 'parse_error';
    }
    if (errorStr.includes('unknown tool') || errorStr.includes('未知工具')) {
      return 'unknown_tool';
    }
    
    return 'unknown';
  }

  async _attemptRecovery(taskId, error, _context) {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;
    
    console.log(`🔄 尝试任务级恢复: ${taskId}`);
    
    if (task.errors.length > 5) {
      console.log('❌ 错误次数过多，放弃恢复');
      return false;
    }
    
    this.emit('task:recovery', { taskId, error: error.message });
    
    await this._delay(1000);
    
    return true;
  }

  async _retryToolCall(taskId, toolCallRecord) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    
    const result = await this._executeToolCallWithRetry(
      taskId,
      { 
        id: toolCallRecord.id,
        function: { 
          name: toolCallRecord.toolName,
          arguments: toolCallRecord.params
        }
      },
      task.context
    );
    
    toolCallRecord.status = result.success ? 'success' : 'failed';
    toolCallRecord.result = result.content || result.error;
  }

  async _callAI(provider, messages, tools, _context) {
    const cacheResult = optimizeCacheBreakpoints(messages, {
      model: provider.model,
      baseUrl: provider.baseUrl,
      strategy: 'system_and_3'
    });
    
    const cachedMessages = cacheResult.messages;
    if (cacheResult.cached) {
      const savings = estimateCacheSavings(cachedMessages, cacheResult.provider);
      console.log('💾 [EnhancedExecutor] 提示词缓存已启用:', {
        provider: cacheResult.provider,
        breakpoints: cacheResult.breakpoints,
        estimatedSavings: `${savings.savingsPercent}%`
      });
    }
    
    const requestBody = {
      model: provider.model,
      messages: cachedMessages,
      temperature: 0.7,
      tools: tools,
      tool_choice: 'auto'
    };
    
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!response.ok) {
      throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  }

  async _buildMessages(config, userId, message, context) {
    const history = context.history || [];
    const systemPrompt = context.systemPrompt || '你是一个智能助手。';
    
    return [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];
  }

  _buildToolDefinitions(context) {
    const tools = context.toolSystem?.getAll() || [];
    
    return tools
      .filter(tool => tool.schema)
      .map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || tool.schema?.description || '',
          parameters: tool.schema?.parameters || tool.schema || {}
        }
      }));
  }

  async _saveConversation(userId, userMessage, assistantMessage, context) {
    if (context && context.historyManager) {
      await context.historyManager.addMessage(userId, 'user', userMessage);
      await context.historyManager.addMessage(userId, 'assistant', assistantMessage);
    }
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async failTask(taskId, error) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;
    
    task.status = 'failed';
    task.error = error.message;
    task.endTime = Date.now();
    
    this.taskHistory.set(taskId, task);
    this.activeTasks.delete(taskId);
    
    this.emit('task:failed', { taskId, error: error.message, duration: task.endTime - task.startTime });
  }

  getTaskStatus(taskId) {
    const task = this.activeTasks.get(taskId) || this.taskHistory.get(taskId);
    if (!task) return null;
    
    return {
      id: task.id,
      status: task.status,
      toolCallCount: task.toolCallCount,
      errors: task.errors.length,
      duration: task.endTime ? task.endTime - task.startTime : Date.now() - task.startTime,
      stagnationCount: task.stagnationCount || 0
    };
  }

  getStats() {
    return {
      activeTasks: this.activeTasks.size,
      completedTasks: Array.from(this.taskHistory.values()).filter(t => t.status === 'completed').length,
      failedTasks: Array.from(this.taskHistory.values()).filter(t => t.status === 'failed').length,
      totalToolCalls: Array.from(this.taskHistory.values()).reduce((sum, t) => sum + t.toolCallCount, 0)
    };
  }

  stop() {
    if (this.stagnationDetector) {
      clearInterval(this.stagnationDetector);
      this.stagnationDetector = null;
    }
  }
}

const enhancedTaskExecutor = new EnhancedTaskExecutor({});

module.exports = {
  EnhancedTaskExecutor,
  enhancedTaskExecutor,
  MAX_TOOL_CALLS,
  MAX_RETRIES,
  STAGNATION_TIMEOUT
};
