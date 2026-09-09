const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
// eslint-disable-next-line no-unused-vars
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');
const state = require('./state');
const {
  SubAgentConcurrencyManager,
  RecursionDetector,
  LockManager,
} = require('./subagent/concurrency-control');

const concurrencyManager = new SubAgentConcurrencyManager({
  maxConcurrent: 5,
  maxDepth: 3,
});
const recursionDetector = new RecursionDetector(3);
const lockManager = new LockManager();

const subagents = new Map();

const SUBAGENT_TYPES = {
  RESEARCH: 'research',
  IMPLEMENT: 'implement',
  VERIFY: 'verify',
  ANALYZE: 'analyze'
};

const SUBAGENT_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout'
};

const DEFAULT_ALLOWED_TOOLS = {
  [SUBAGENT_TYPES.RESEARCH]: ['read', 'grep', 'glob', 'web_search', 'web_fetch'],
  [SUBAGENT_TYPES.IMPLEMENT]: ['read', 'write', 'grep', 'glob', 'bash', 'str_replace'],
  [SUBAGENT_TYPES.VERIFY]: ['read', 'grep', 'glob', 'bash'],
  [SUBAGENT_TYPES.ANALYZE]: ['read', 'grep', 'glob']
};

const DEFAULT_DISALLOWED_TOOLS = ['rm_rf', 'format', 'shutdown', 'reboot', 'exec'];

const DEFAULT_TIMEOUTS = {
  [SUBAGENT_TYPES.RESEARCH]: 120000,
  [SUBAGENT_TYPES.IMPLEMENT]: 300000,
  [SUBAGENT_TYPES.VERIFY]: 180000,
  [SUBAGENT_TYPES.ANALYZE]: 120000
};

const MAX_CONCURRENT_SUBAGENTS = 5;

const SUBAGENT_PROMPTS = {
  [SUBAGENT_TYPES.RESEARCH]: `You are a research subagent. Your job is to:
- Investigate the codebase
- Find relevant files and patterns
- Report findings with specific file paths and line numbers
- Do NOT modify any files
- Be thorough but focused on the question asked`,

  [SUBAGENT_TYPES.IMPLEMENT]: `You are an implementation subagent. Your job is to:
- Make targeted code changes as specified
- Follow existing code patterns and conventions
- Run tests to verify changes work
- Commit changes if requested
- Report what was changed and the result`,

  [SUBAGENT_TYPES.VERIFY]: `You are a verification subagent. Your job is to:
- Independently verify that changes work correctly
- Test edge cases and error paths
- Run the actual tests with the feature enabled
- Report pass/fail with evidence
- Do NOT assume success - prove it`,

  [SUBAGENT_TYPES.ANALYZE]: `You are an analysis subagent. Your job is to:
- Analyze code structure and dependencies
- Identify potential issues or improvements
- Provide recommendations with reasoning
- Do NOT modify any files`
};

function validateToolAccess(subagent, toolName) {
  if (DEFAULT_DISALLOWED_TOOLS.includes(toolName)) {
    return { allowed: false, reason: `工具 ${toolName} 在全局黑名单中` };
  }

  const allowedTools = subagent.allowedTools || DEFAULT_ALLOWED_TOOLS[subagent.type] || [];
  if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
    return { allowed: false, reason: `工具 ${toolName} 不在子代理 ${subagent.id} 的白名单中` };
  }

  const disallowedTools = subagent.disallowedTools || [];
  if (disallowedTools.includes(toolName)) {
    return { allowed: false, reason: `工具 ${toolName} 在子代理 ${subagent.id} 的黑名单中` };
  }

  return { allowed: true };
}

class SubagentResult {
  constructor(taskId, traceId) {
    this.taskId = taskId;
    this.traceId = traceId;
    this.status = SUBAGENT_STATUS.PENDING;
    this.output = null;
    this.error = null;
    this.messages = [];
    this.startedAt = null;
    this.completedAt = null;
  }

  getDuration() {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  isTerminal() {
    return [SUBAGENT_STATUS.COMPLETED, SUBAGENT_STATUS.FAILED, SUBAGENT_STATUS.CANCELLED, SUBAGENT_STATUS.TIMEOUT].includes(this.status);
  }
}

class SubagentWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workerPath = options.workerPath || path.join(__dirname, 'subagent-worker-runtime.js');
    this.maxWorkers = options.maxWorkers || MAX_CONCURRENT_SUBAGENTS;
    this.timeout = options.timeout || 120000;
    this.activeWorkers = new Map();
  }

  async execute(task, options = {}) {
    const taskId = task.id || `task_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
    const traceId = task.traceId || taskId;
    const timeout = options.timeout || this.timeout;

    const result = new SubagentResult(taskId, traceId);
    result.startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let timer = null;
      let worker = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (worker) {
          this.activeWorkers.delete(taskId);
          worker.removeAllListeners();
          if (!worker.killed) {
            worker.terminate();
          }
        }
      };

      const onMessage = (message) => {
        if (message.type === 'progress') {
          result.messages.push(message.data);
          this.emit('progress', taskId, message.data);
        } else if (message.type === 'complete') {
          result.status = SUBAGENT_STATUS.COMPLETED;
          result.output = message.data;
          result.completedAt = Date.now();
          cleanup();
          this.emit('complete', taskId, result);
          resolve(result);
        } else if (message.type === 'error') {
          result.status = SUBAGENT_STATUS.FAILED;
          result.error = new Error(message.error);
          result.completedAt = Date.now();
          cleanup();
          this.emit('error', taskId, result.error);
          reject(result.error);
        }
      };

      const onError = (error) => {
        result.status = SUBAGENT_STATUS.FAILED;
        result.error = error;
        result.completedAt = Date.now();
        cleanup();
        this.emit('error', taskId, error);
        reject(error);
      };

      const onExit = (code) => {
        if (code !== 0 && result.status === SUBAGENT_STATUS.RUNNING) {
          result.status = SUBAGENT_STATUS.FAILED;
          result.error = new Error(`Worker exited with code ${code}`);
          result.completedAt = Date.now();
          cleanup();
          this.emit('error', taskId, result.error);
          reject(result.error);
        }
      };

      try {
        worker = new Worker(this.workerPath, {
          workerData: { taskId, traceId, task, options }
        });

        this.activeWorkers.set(taskId, worker);
        result.status = SUBAGENT_STATUS.RUNNING;

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);

        timer = setTimeout(() => {
          result.status = SUBAGENT_STATUS.TIMEOUT;
          result.error = new Error(`Subagent execution timeout (${timeout}ms)`);
          result.completedAt = Date.now();
          cleanup();
          this.emit('timeout', taskId, result.error);
          reject(result.error);
        }, timeout);

      } catch (error) {
        result.status = SUBAGENT_STATUS.FAILED;
        result.error = error;
        result.completedAt = Date.now();
        cleanup();
        reject(error);
      }
    });
  }

  cancel(taskId) {
    const worker = this.activeWorkers.get(taskId);
    if (worker) {
      worker.postMessage({ type: 'cancel' });
      return true;
    }
    return false;
  }

  cancelAll() {
    // eslint-disable-next-line no-unused-vars
    for (const [taskId, worker] of this.activeWorkers) {
      worker.postMessage({ type: 'cancel' });
    }
  }

  getActiveCount() {
    return this.activeWorkers.size;
  }

  getStats() {
    return {
      active: this.activeWorkers.size,
      maxWorkers: this.maxWorkers
    };
  }
}

class SubagentExecutor {
  constructor(options = {}) {
    this.useWorker = options.useWorker === true;
    this.timeout = options.timeout || 120000;
    this.maxConcurrent = options.maxConcurrent || MAX_CONCURRENT_SUBAGENTS;
    this.activeCount = 0;
    this.queue = [];
    this.worker = null;

    if (this.useWorker) {
      this.worker = new SubagentWorker({
        timeout: this.timeout,
        maxWorkers: this.maxConcurrent
      });
    }
  }

  async execute(task, options = {}) {
    if (this.activeCount >= this.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task, options, resolve, reject });
      });
    }

    this.activeCount++;

    try {
      let result;

      if (this.useWorker && this._shouldUseWorker(task)) {
        result = await this.worker.execute(task, options);
      } else {
        result = await this._executeInProcess(task, options);
      }

      return result;

    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        this.execute(next.task, next.options)
          .then(next.resolve)
          .catch(next.reject);
      }
    }
  }

  _shouldUseWorker(task) {
    return task.isolated === true || task.longRunning === true;
  }

  async _executeInProcess(task, options = {}) {
    const taskId = task.id || `task_${Date.now()}`;
    const traceId = task.traceId || taskId;
    const timeout = options.timeout || this.timeout;

    const result = new SubagentResult(taskId, traceId);
    result.startedAt = Date.now();
    result.status = SUBAGENT_STATUS.RUNNING;

    const abortController = new AbortController();
    let timer = null;

    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        result.status = SUBAGENT_STATUS.TIMEOUT;
        result.error = new Error(`Task timeout (${timeout}ms)`);
        result.completedAt = Date.now();
        reject(result.error);
      }, timeout);

      const signal = abortController.signal;

      Promise.resolve()
        .then(() => {
          if (signal.aborted) {
            throw new Error('Task cancelled');
          }

          if (typeof task.handler === 'function') {
            return task.handler(signal, task);
          }

          if (typeof task.execute === 'function') {
            return task.execute(signal);
          }

          throw new Error('Task must have handler or execute function');
        })
        .then((output) => {
          clearTimeout(timer);
          result.status = SUBAGENT_STATUS.COMPLETED;
          result.output = output;
          result.completedAt = Date.now();
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          if (result.status !== SUBAGENT_STATUS.TIMEOUT) {
            result.status = SUBAGENT_STATUS.FAILED;
            result.error = error;
          }
          result.completedAt = Date.now();
          reject(result.error);
        });
    });
  }

  cancel(taskId) {
    if (this.worker) {
      return this.worker.cancel(taskId);
    }
    return false;
  }

  getStats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      worker: this.worker ? this.worker.getStats() : null
    };
  }
}

function createSubAgent(options) {
  const {
    type = SUBAGENT_TYPES.RESEARCH,
    description,
    prompt,
    parentAgentId = null,
    timeout,
    tools,
    allowedTools,
    disallowedTools = [],
    maxTurns = 50,
    isolated = false,
    requiredResources = [],
  } = options;

  // 子代理契约校验（agent-contract-validator）— 强制执行
  try {
    const { globalAgentContractValidator } = require('./agent-contract-validator');
    // D1(Runtime差距分析): capabilities 从工具白名单派生(此前恒 [],校验形同虚设)
    const { deriveSubagentCapabilities } = require('./agent/capability-map');
    const effectiveTools = allowedTools || tools || DEFAULT_ALLOWED_TOOLS[type] || [];
    const agentDef = {
      capabilities: options.capabilities || deriveSubagentCapabilities(effectiveTools),
      tools: effectiveTools,
      budgetTokens: options.budgetTokens,
      maxIterations: options.maxTurns || maxTurns,
    };
    const validation = globalAgentContractValidator.validateSpawn(type, agentDef, options.input || {});
    if (!validation.valid) {
      throw new Error('Contract validation FAILED for ' + type + ': ' + validation.errors.join('; '));
    }
    if (validation.warnings.length > 0) {
      console.debug('[subagent] Contract warnings for ' + type + ': ' + validation.warnings.join('; '));
    }
  } catch (e) {
    console.warn('[subagent] Contract validation error:', e.message);
    throw e;
  }

  const stats = concurrencyManager.getStats();
  if (stats.coordinator.active >= MAX_CONCURRENT_SUBAGENTS) {
    throw new Error(`子代理并发数已达上限 (${MAX_CONCURRENT_SUBAGENTS})，请等待现有任务完成`);
  }

  const subagentId = `subagent_${uuidv4().slice(0, 8)}`;
  const effectiveTimeout = timeout || DEFAULT_TIMEOUTS[type] || 120000;
  const effectiveAllowedTools = allowedTools || tools || DEFAULT_ALLOWED_TOOLS[type] || [];

  try {
    recursionDetector.pushCall(subagentId, parentAgentId);
  } catch (e) {
    throw new Error(`递归深度超过限制: ${e.message}`);
  }

  concurrencyManager.registerAgent(subagentId, { type, parentAgentId });

  const subagent = {
    id: subagentId,
    type,
    description,
    prompt,
    parentAgentId,
    status: SUBAGENT_STATUS.PENDING,
    createdAt: Date.now(),
    timeout: effectiveTimeout,
    maxTurns,
    allowedTools: effectiveAllowedTools,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS, ...disallowedTools],
    tools: effectiveAllowedTools,
    isolated,
    requiredResources,
    result: null,
    error: null,
    timedOut: false,
    traceId: uuidv4().slice(0, 12),
    usage: {
      tokens: 0,
      toolCalls: 0,
      duration: 0
    },
    depth: recursionDetector.getDepth(subagentId),
  };

  subagents.set(subagentId, subagent);

  subagent._timeoutHandle = setTimeout(() => {
    if (subagent.status === SUBAGENT_STATUS.RUNNING || subagent.status === SUBAGENT_STATUS.PENDING) {
      subagent.timedOut = true;
      subagent.status = SUBAGENT_STATUS.TIMEOUT;
      failSubAgent(subagentId, `子代理执行超时 (${effectiveTimeout}ms)`);
      console.log(`⏰ SubAgent 超时: ${subagentId} (${effectiveTimeout}ms)`);
    }
  }, effectiveTimeout);

  state.recordEvent('subagent_created', {
    subagentId,
    type,
    description,
    traceId: subagent.traceId,
    timeout: effectiveTimeout,
    allowedTools: effectiveAllowedTools,
    isolated,
    depth: subagent.depth,
  });

  console.log(`🦀 SubAgent 创建: ${subagentId} (${type}) [depth:${subagent.depth}] [trace:${subagent.traceId}] - ${description}`);
  console.log(`   工具白名单: [${effectiveAllowedTools.join(', ')}]`);
  console.log(`   超时: ${effectiveTimeout}ms, 最大轮次: ${maxTurns}, 隔离: ${isolated}`);

  return subagent;
}

function getSubAgent(subagentId) {
  return subagents.get(subagentId);
}

function listSubAgents(filter = {}) {
  let result = Array.from(subagents.values());

  if (filter.status) {
    result = result.filter(s => s.status === filter.status);
  }
  if (filter.type) {
    result = result.filter(s => s.type === filter.type);
  }
  if (filter.parentAgentId) {
    result = result.filter(s => s.parentAgentId === filter.parentAgentId);
  }

  return result;
}

function updateSubAgent(subagentId, updates) {
  const subagent = subagents.get(subagentId);
  if (!subagent) {
    throw new Error(`SubAgent not found: ${subagentId}`);
  }

  Object.assign(subagent, updates);

  if (updates.status === SUBAGENT_STATUS.COMPLETED || 
      updates.status === SUBAGENT_STATUS.FAILED || 
      updates.status === SUBAGENT_STATUS.CANCELLED ||
      updates.status === SUBAGENT_STATUS.TIMEOUT) {
    subagent.usage.duration = Date.now() - subagent.createdAt;

    if (subagent._timeoutHandle) {
      clearTimeout(subagent._timeoutHandle);
      subagent._timeoutHandle = null;
    }

    state.recordEvent('subagent_completed', {
      subagentId,
      status: updates.status,
      duration: subagent.usage.duration,
      traceId: subagent.traceId,
      timedOut: subagent.timedOut || false
    });
  }

  return subagent;
}

function completeSubAgent(subagentId, result) {
  recursionDetector.popCall(subagentId);
  concurrencyManager.unregisterAgent(subagentId);
  
  return updateSubAgent(subagentId, {
    status: SUBAGENT_STATUS.COMPLETED,
    result
  });
}

function failSubAgent(subagentId, error) {
  recursionDetector.popCall(subagentId);
  concurrencyManager.unregisterAgent(subagentId);
  
  return updateSubAgent(subagentId, {
    status: SUBAGENT_STATUS.FAILED,
    error: typeof error === 'string' ? error : error.message
  });
}

function cancelSubAgent(subagentId) {
  const subagent = subagents.get(subagentId);
  if (!subagent) return false;

  if (subagent.status === SUBAGENT_STATUS.RUNNING) {
    console.log(`🦀 SubAgent 取消: ${subagentId}`);
  }

  recursionDetector.popCall(subagentId);
  concurrencyManager.unregisterAgent(subagentId);

  return updateSubAgent(subagentId, {
    status: SUBAGENT_STATUS.CANCELLED
  });
}

function cleanupSubAgent(subagentId) {
  const subagent = subagents.get(subagentId);
  if (!subagent) return false;

  if (subagent._timeoutHandle) {
    clearTimeout(subagent._timeoutHandle);
  }

  recursionDetector.popCall(subagentId);
  concurrencyManager.unregisterAgent(subagentId);

  subagents.delete(subagentId);
  console.log(`🦀 SubAgent 清理: ${subagentId}`);
  return true;
}

function cleanupCompletedSubAgents() {
  const completed = listSubAgents().filter(
    s => s.status === SUBAGENT_STATUS.COMPLETED || 
         s.status === SUBAGENT_STATUS.FAILED || 
         s.status === SUBAGENT_STATUS.CANCELLED ||
         s.status === SUBAGENT_STATUS.TIMEOUT
  );

  for (const subagent of completed) {
    cleanupSubAgent(subagent.id);
  }

  return completed.length;
}

function formatSubAgentNotification(subagent) {
  const lines = [
    '<subagent-notification>',
    `<subagent-id>${subagent.id}</subagent-id>`,
    `<trace-id>${subagent.traceId || 'unknown'}</trace-id>`,
    `<status>${subagent.status}</status>`,
    `<summary>${subagent.description} - ${subagent.status}</summary>`
  ];

  if (subagent.result) {
    lines.push('<result>');
    lines.push(typeof subagent.result === 'string'
      ? subagent.result
      : JSON.stringify(subagent.result, null, 2));
    lines.push('</result>');
  }

  if (subagent.error) {
    lines.push(`<error>${subagent.error}</error>`);
  }

  if (subagent.timedOut) {
    lines.push('<timed-out>true</timed-out>');
  }

  lines.push('<usage>');
  lines.push(`  <tokens>${subagent.usage.tokens}</tokens>`);
  lines.push(`  <tool_calls>${subagent.usage.toolCalls}</tool_calls>`);
  lines.push(`  <duration_ms>${subagent.usage.duration}</duration_ms>`);
  lines.push('</usage>');
  lines.push('</subagent-notification>');

  return lines.join('\n');
}

function getSubAgentSystemPrompt(type) {
  return SUBAGENT_PROMPTS[type] || SUBAGENT_PROMPTS[SUBAGENT_TYPES.RESEARCH];
}

function getActiveSubAgentCount() {
  return listSubAgents({ status: SUBAGENT_STATUS.RUNNING }).length;
}

function getSubAgentStats() {
  const all = listSubAgents();
  return {
    total: all.length,
    pending: all.filter(s => s.status === SUBAGENT_STATUS.PENDING).length,
    running: all.filter(s => s.status === SUBAGENT_STATUS.RUNNING).length,
    completed: all.filter(s => s.status === SUBAGENT_STATUS.COMPLETED).length,
    failed: all.filter(s => s.status === SUBAGENT_STATUS.FAILED).length,
    cancelled: all.filter(s => s.status === SUBAGENT_STATUS.CANCELLED).length,
    timedOut: all.filter(s => s.status === SUBAGENT_STATUS.TIMEOUT || s.timedOut).length
  };
}

const globalExecutor = new SubagentExecutor();

module.exports = {
  SUBAGENT_TYPES,
  SUBAGENT_STATUS,
  SUBAGENT_PROMPTS,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_TIMEOUTS,
  MAX_CONCURRENT_SUBAGENTS,
  createSubAgent,
  getSubAgent,
  listSubAgents,
  updateSubAgent,
  completeSubAgent,
  failSubAgent,
  cancelSubAgent,
  cleanupSubAgent,
  cleanupCompletedSubAgents,
  formatSubAgentNotification,
  getSubAgentSystemPrompt,
  getActiveSubAgentCount,
  getSubAgentStats,
  validateToolAccess,
  SubagentWorker,
  SubagentExecutor,
  SubagentResult,
  globalExecutor,
  concurrencyManager,
  recursionDetector,
  lockManager,
};
