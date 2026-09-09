/**
 * Enhanced SubAgent System - 增强 SubAgent 系统
 * 集成 Flow、Tool Policy、Channel Registry 和 Routing 系统
 */

const { v4: uuidv4 } = require('uuid');
const state = require('./state');
const { toolPolicyManager } = require('./tool-profiles');
const { routeResolver, SessionKeyBuilder } = require('./routing');
// eslint-disable-next-line no-unused-vars
const { channelRegistry } = require('./channel-registry');
const { RecursionDetector, SubAgentConcurrencyManager } = require('./subagent/concurrency-control');
const { AgentComposer } = require('./agent/agent-composer');
// eslint-disable-next-line no-unused-vars
const { ACPLiteProtocol, ACP_MESSAGE_TYPES } = require('./agent/acp-lite-protocol');
// eslint-disable-next-line no-unused-vars
const { AgentEventLedger, EVENT_TYPES } = require('./agent/agent-event-ledger');

const subagents = new Map();

const MAX_DEPTH = 3;
const MAX_CONCURRENT = 5;

const DEFAULT_MAX_ITERATIONS = 30;   // 默认最大迭代次数（从 10 提升至 30）
const MAX_PARALLEL_TASKS = 3;        // 并行批量委派最大并发数

const recursionDetector = new RecursionDetector(MAX_DEPTH);
const concurrencyManager = new SubAgentConcurrencyManager(MAX_CONCURRENT);

const SUBAGENT_TYPES = {
  RESEARCH: 'research',
  IMPLEMENT: 'implement',
  VERIFY: 'verify',
  ANALYZE: 'analyze',
  COORDINATOR: 'coordinator',
  WORKER: 'worker',
};

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
- Do NOT modify any files`,

  [SUBAGENT_TYPES.COORDINATOR]: `You are a coordinator subagent. Your job is to:
- Decompose complex tasks into subtasks
- Assign subtasks to worker subagents
- Monitor progress and handle failures
- Aggregate results and report to parent
- Ensure task completion`,

  [SUBAGENT_TYPES.WORKER]: `You are a worker subagent. Your job is to:
- Execute assigned subtasks
- Report progress to coordinator
- Handle errors gracefully
- Complete assigned work efficiently`,
};

const SUBAGENT_TOOL_SETS = {
  [SUBAGENT_TYPES.RESEARCH]: ['read', 'web_search', 'web_fetch', 'memory_search'],
  [SUBAGENT_TYPES.IMPLEMENT]: ['read', 'write', 'edit', 'exec', 'web_search'],
  [SUBAGENT_TYPES.VERIFY]: ['read', 'exec', 'web_search'],
  [SUBAGENT_TYPES.ANALYZE]: ['read', 'web_search', 'memory_search'],
  [SUBAGENT_TYPES.COORDINATOR]: ['read', 'sessions_spawn', 'sessions_send'],
  [SUBAGENT_TYPES.WORKER]: ['read', 'write', 'edit', 'exec'],
};

class SubAgentConfig {
  constructor(options = {}) {
    this.id = options.id || `subagent_${uuidv4().slice(0, 8)}`;
    this.type = options.type || SUBAGENT_TYPES.RESEARCH;
    this.description = options.description || '';
    this.prompt = options.prompt || '';
    this.parentAgentId = options.parentAgentId || null;
    this.coordinatorId = options.coordinatorId || null;
    this.timeout = options.timeout || 300000;
    this.maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.toolProfile = options.toolProfile || 'coding';
    this.channel = options.channel || 'cli';
    this.accountId = options.accountId || 'default';
    this.metadata = options.metadata || {};
    this.composedAgentId = options.composedAgentId || null;
    this.capabilityId = options.capabilityId || null;
    this.domainId = options.domainId || null;
    this.acp = options.acp || null;
    this.eventLedger = options.eventLedger || null;
    // 2026-09-05 真传: 专家身份(id/name/systemPrompt)——execute 时注入岗位 system 消息
    this.expert = options._expert || null;
  }

  getToolPolicy() {
    return toolPolicyManager.resolveToolProfilePolicy(this.toolProfile);
  }

  getAllowedTools() {
    const baseTools = SUBAGENT_TOOL_SETS[this.type] || [];
    const policy = this.getToolPolicy();
    
    if (!policy) return baseTools;
    
    return toolPolicyManager.applyPolicy(baseTools, policy);
  }

  getSessionKey() {
    return SessionKeyBuilder.build({
      agentId: this.id,
      channel: this.channel,
      accountId: this.accountId,
      dmScope: 'per-channel-peer',
    });
  }

  getRoute() {
    return routeResolver.resolveAgentRoute({
      channel: this.channel,
      accountId: this.accountId,
    });
  }
}

class SubAgent {
  constructor(config) {
    this.config = config instanceof SubAgentConfig ? config : new SubAgentConfig(config);
    
    this.id = this.config.id;
    this.type = this.config.type;
    this.description = this.config.description;
    this.prompt = this.config.prompt;
    this.parentAgentId = this.config.parentAgentId;
    this.coordinatorId = this.config.coordinatorId;
    this.timeout = this.config.timeout;
    this.maxIterations = this.config.maxIterations;
    
    this.status = 'pending';
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    
    this.result = null;
    this.error = null;
    
    this.usage = {
      tokens: 0,
      toolCalls: 0,
      duration: 0,
    };
    
    this.progress = [];
    this.children = [];
    
    // 中断传播：每个子 Agent 持有 AbortController
    this._abortController = new AbortController();
    this._aborted = false;
    
    subagents.set(this.id, this);
    
    state.recordEvent('subagent_created', {
      subagentId: this.id,
      type: this.type,
      description: this.description,
      toolProfile: this.config.toolProfile,
    });

    console.log(`🦀 SubAgent 创建: ${this.id} (${this.type}) - ${this.description}`);
  }

  start() {
    if (this.status !== 'pending') {
      throw new Error(`Cannot start subagent in status: ${this.status}`);
    }
    
    this.status = 'running';
    this.startedAt = Date.now();
    
    state.recordEvent('subagent_started', {
      subagentId: this.id,
      type: this.type,
    });
    
    console.log(`🦀 SubAgent 启动: ${this.id}`);
    return this;
  }

  updateProgress(message, data = {}) {
    this.progress.push({
      timestamp: Date.now(),
      message,
      data,
    });
    
    state.recordEvent('subagent_progress', {
      subagentId: this.id,
      message,
    });
  }

  /**
   * 2026-08-01: 幂等释放并发槽位与递归栈（P0 泄漏修复——
   * 此前 complete/fail/cancel 均不释放，MAX_CONCURRENT 耗尽后系统永久不可用）
   */
  _releaseResources() {
    if (this._released) return;
    this._released = true;
    try { concurrencyManager.unregisterAgent(this.id); } catch (e) { console.warn('[subagent-enhanced] unregisterAgent failed:', e.message); }
    try { recursionDetector.popCall(this.id); } catch (e) { console.warn('[subagent-enhanced] popCall failed:', e.message); }
  }

  complete(result) {
    this.status = 'completed';
    this.result = result;
    this.completedAt = Date.now();
    this.usage.duration = this.completedAt - this.startedAt;
    this._releaseResources();

    state.recordEvent('subagent_completed', {
      subagentId: this.id,
      status: 'completed',
      duration: this.usage.duration,
    });

    if (this.config.acp) {
      try {
        this.config.acp.reportResult(this.id, this.parentAgentId || 'root', result, this.id);
      } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }
    }

    if (this.config.eventLedger) {
      try {
        this.config.eventLedger.record(EVENT_TYPES.AGENT_COMPLETED, {
          agentId: this.id,
          type: this.type,
          duration: this.usage.duration,
          domainId: this.config.domainId,
          capabilityId: this.config.capabilityId,
        });
      } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }
    }

    console.log(`🦀 SubAgent 完成: ${this.id} (${this.usage.duration}ms)`);
    return this;
  }

  fail(error) {
    this.status = 'failed';
    this.error = typeof error === 'string' ? error : error.message;
    this.completedAt = Date.now();
    if (this.startedAt) {
      this.usage.duration = this.completedAt - this.startedAt;
    }
    this._releaseResources();

    state.recordEvent('subagent_failed', {
      subagentId: this.id,
      error: this.error,
    });

    if (this.config.acp) {
      try {
        this.config.acp.reportError(this.id, this.parentAgentId || 'root', this.error, this.id);
      } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }
    }

    if (this.config.eventLedger) {
      try {
        this.config.eventLedger.record(EVENT_TYPES.AGENT_FAILED, {
          agentId: this.id,
          type: this.type,
          error: this.error,
          domainId: this.config.domainId,
          capabilityId: this.config.capabilityId,
        });
      } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }
    }

    console.log(`🦀 SubAgent 失败: ${this.id} - ${this.error}`);
    return this;
  }

  cancel() {
    if (this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled') {
      return this;
    }
    
    this.status = 'cancelled';
    this._aborted = true;
    this._abortController.abort();
    this.completedAt = Date.now();

    // 中断传播：递归取消所有子 Agent
    for (const childId of this.children) {
      const child = subagents.get(childId);
      if (child && (child.status === 'running' || child.status === 'pending')) {
        child.cancel();
      }
    }

    state.recordEvent('subagent_cancelled', {
      subagentId: this.id,
    });

    this._releaseResources();
    console.log(`🦀 SubAgent 取消: ${this.id}`);
    return this;
  }

  spawnChild(config) {
    const childConfig = new SubAgentConfig({
      ...config,
      parentAgentId: this.parentAgentId,
      coordinatorId: this.id,
    });
    
    const child = new SubAgent(childConfig);
    this.children.push(child.id);
    
    return child;
  }

  getSystemPrompt() {
    if (this.config.composedAgentId && this.config.capabilityId && this.config.domainId) {
      try {
        const composer = new AgentComposer();
        const composedPrompt = composer.generateSystemPrompt(
          this.config.capabilityId,
          this.config.domainId
        );
        if (composedPrompt) return composedPrompt;
      } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }
    }

    if (this.config.prompt) {
      return this.config.prompt;
    }

    return SUBAGENT_PROMPTS[this.type] || SUBAGENT_PROMPTS[SUBAGENT_TYPES.RESEARCH];
  }

  getAllowedTools() {
    return this.config.getAllowedTools();
  }

  getToolPolicy() {
    return this.config.getToolPolicy();
  }

  getSessionKey() {
    return this.config.getSessionKey();
  }

  getRoute() {
    return this.config.getRoute();
  }

  isTimedOut() {
    if (this.status !== 'running') return false;
    return Date.now() - this.startedAt > this.timeout;
  }

  /**
   * 执行子智能体任务
   * 
   * 这是子智能体的核心执行方法，由 TieredSubAgentRunner 调用）   * 执行流程。
   * 1. 启动子智能体
   * 2. 构建执行上下文（系统提示 + 工具 + 任务描述）   * 3. 调用 LLM 执行任务
   * 4. 处理工具调用循环
   * 5. 返回结果
   * 
   * @param {object} options - 执行选项
   * @param {object} options.llmFn - LLM 调用函数
   * @param {object} options.toolExecutor - 工具执行器   * @returns {Promise<string>} 执行结果
   */
  async execute(options = {}) {
    this.start();

    const systemPrompt = this.getSystemPrompt();
    const allowedTools = this.getAllowedTools();
    const task = this.description || this.prompt || '';

    if (!task) {
      this.fail('No task description provided');
      throw new Error('SubAgent execute: no task description');
    }

    this.updateProgress('开始执行', { type: this.type, tools: allowedTools });

    try {
      const llmFn = options.llmFn || this._getDefaultLLMFn();
      const toolExecutor = options.toolExecutor || this._getDefaultToolExecutor();

      const messages = [
        { role: 'system', content: systemPrompt },
        // 2026-09-05 真传: 岗位人设为独立 system 消息(无 800 字截断, 位置=system 层)
        ...(this.config.expert && this.config.expert.systemPrompt
          ? [{ role: 'system', content: `【岗位身份：${this.config.expert.name}】\n${this.config.expert.systemPrompt}` }]
          : []),
        { role: 'user', content: task },
      ];

      let iteration = 0;
      const maxIterations = this.maxIterations || DEFAULT_MAX_ITERATIONS;
      let finalContent = '';

      while (iteration < maxIterations) {
        // 中断检查：AbortSignal 触发时立即退出
        if (this._aborted || this._abortController.signal.aborted) {
          this.cancel();
          return '任务被中断';
        }

        iteration++;
        this.usage.toolCalls = iteration;

        const response = await llmFn(messages, allowedTools);

        if (!response) {
          finalContent = 'LLM 未返回有效响应';
          break;
        }

        // 提取助手回复
        const assistantContent = response.content || '';
        const toolCalls = response.tool_calls || [];

        messages.push({
          role: 'assistant',
          content: assistantContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        // 无工具调用，任务完成
        if (toolCalls.length === 0) {
          finalContent = assistantContent;
          break;
        }

        // 执行工具调用
        for (const toolCall of toolCalls) {
          // 中断检查
          if (this._aborted) break;

          try {
            const toolResult = await toolExecutor(toolCall.name || toolCall.function?.name, toolCall.arguments || toolCall.function?.arguments);
            const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id || `tc_${iteration}`,
              content: resultStr,
            });

            this.updateProgress(`工具调用: ${toolCall.name || 'unknown'}`, { result: resultStr.slice(0, 200) });
          } catch (toolErr) {
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id || `tc_${iteration}`,
              content: `工具执行错误: ${toolErr.message}`,
            });
          }
        }

        if (this._aborted) break;
      }

      if (this._aborted) {
        this.cancel();
        return '任务被中断';
      }

      if (iteration >= maxIterations) {
        finalContent = finalContent || `达到最大迭代次数(${maxIterations})，任务可能未完全完成`;
      }

      this.complete(finalContent);
      return finalContent;
    } catch (err) {
      this.fail(err.message);
      throw err;
    }
  }

  /**
   * 获取默认 LLM 调用函数
   * 尝试从主系统获取 AI 配置
   *
   * S5 修复: 旧实现拿到 router 却返回写死的假响应
   * { content:'子智能体执行完成（降级模式）', tool_calls:[] }——无真实模型时多智能体
   * 与双阶段审查全部"假完成"(审查基于假话术判通过,记录显示完成实际产出空)。
   * 现改为: ① 经 router 取当前 provider 的 adapter 真实调用模型;
   *        ② 适配器不可用/调用失败 → 显式抛错,由上游(agent-router/tiered runner)
   *           catch 并标记 failed——诚实失败而非假完成。
   */
  _getDefaultLLMFn() {
    try {
      const { getModelRouter } = require('./model-router');
      const router = getModelRouter();
      if (router) {
        return async (messages, tools) => {
          const provider = router.getCurrentProvider();
          let adapter = router.getAdapter(provider);
          // 2026-09-06: 懒绑定自愈——启动期"Adapter registry bound to model router"
          // 先于 globalRouter 创建执行而静默落空(router=null 时跳过), router 就绪后
          // 适配器注册中心从未绑上 → 子智能体/部门例会全部"无可用模型适配器"。
          // 首次使用时补绑注册中心再取, 失败仍走显式报错。
          if (!adapter) {
            try {
              const { getAdapterRegistry } = require('./llm');
              const reg = getAdapterRegistry();
              if (reg) {
                router.setAdapterRegistry(reg);
                adapter = router.getAdapter(provider);
                if (adapter) console.warn('[subagent-enhanced] 适配器注册中心懒绑定成功:', provider);
              }
            } catch (bindErr) {
              console.warn('[subagent-enhanced] 适配器注册中心懒绑定失败:', bindErr?.message);
            }
          }
          if (!adapter || typeof adapter.chat !== 'function') {
            throw new Error(`子智能体无可用模型适配器（provider=${provider}）`);
          }
          const resp = await adapter.chat({
            messages,
            tools: Array.isArray(tools) ? tools : [],
            temperature: 0.3,
          });
          return {
            content: resp?.content || '',
            tool_calls: resp?.toolCalls || [],
          };
        };
      }
    } catch (e) {
      console.warn('[subagent-enhanced] LLM 路由初始化失败:', e?.message);
    }

    // 显式失败而非假完成——无真实模型注入时让上游感知执行失败
    return async () => {
      throw new Error('子智能体无可用 LLM（模型未配置或适配器不可用）——请配置模型后重试');
    };
  }

  /**
   * 获取默认工具执行器   */
  _getDefaultToolExecutor() {
    return async (toolName, args) => {
      try {
        const toolSystem = require('./tool-system');
        const tool = toolSystem.get(toolName);
        if (tool && tool.execute) {
          const parsedArgs = typeof args === 'string' ? JSON.parse(args) : (args || {});
          return await tool.execute(parsedArgs);
        }
      } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }

      return { error: `工具 ${toolName} 不可用` };
    };
  }

  getDuration() {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      description: this.description,
      status: this.status,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      duration: this.getDuration(),
      result: this.result,
      error: this.error,
      usage: this.usage,
      progress: this.progress,
      children: this.children,
      toolProfile: this.config.toolProfile,
      allowedTools: this.getAllowedTools(),
      maxIterations: this.maxIterations,
    };
  }
}

class SubAgentCoordinator {
  constructor(parentAgentId) {
    this.parentAgentId = parentAgentId;
    this.workers = new Map();
    this.tasks = new Map();
    this.results = new Map();
  }

  spawnWorker(config) {
    const worker = new SubAgent({
      ...config,
      type: SUBAGENT_TYPES.WORKER,
      parentAgentId: this.parentAgentId,
    });
    
    this.workers.set(worker.id, worker);
    return worker;
  }

  assignTask(workerId, task) {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }
    
    this.tasks.set(workerId, task);
    worker.updateProgress('Task assigned', { task });
    return worker;
  }

  collectResults() {
    const results = [];
    
    for (const [workerId, worker] of this.workers) {
      if (worker.status === 'completed') {
        results.push({
          workerId,
          result: worker.result,
        });
      }
    }
    
    return results;
  }

  getProgress() {
    const workers = Array.from(this.workers.values());
    return {
      total: workers.length,
      pending: workers.filter(w => w.status === 'pending').length,
      running: workers.filter(w => w.status === 'running').length,
      completed: workers.filter(w => w.status === 'completed').length,
      failed: workers.filter(w => w.status === 'failed').length,
    };
  }

  isComplete() {
    const workers = Array.from(this.workers.values());
    return workers.every(w => 
      w.status === 'completed' || w.status === 'failed' || w.status === 'cancelled'
    );
  }

  cancelAll() {
    for (const worker of this.workers.values()) {
      worker.cancel();
    }
  }

  /**
   * SDD 双阶段审查（参照 Superpowers Subagent-Driven Development）   * 
   * 每个子代理完成任务后，经过两个独立审查阶段：
   * 阶段1: 规格合规审查 (Spec Compliance) — 对照计划检查实现是否满足规）   * 阶段2: 代码质量审查 (Code Quality) \u2014 \u68c0\u67e5\u4ee3\u7801\u98ce\u683c、错误处理、边界情）   * 
   * 两个审查由独立的子代理执行，避免自我审查偏差
   * 
   * @param {string} workerId - 完成任务的 worker ID
   * @param {object} plan - 原始计划（包含任务规格和验收标准）   * @returns {{ specCompliance: object, codeQuality: object, approved: boolean }}
   */
  async dualStageReview(workerId, plan = {}) {
    const worker = this.workers.get(workerId);
    if (!worker || worker.status !== 'completed') {
      return { specCompliance: { passed: false, reason: 'Worker 未完成' }, codeQuality: { passed: false }, approved: false };
    }

    const workerResult = worker.result || '';
    const taskSpec = plan.taskSpec || plan.description || '';

    // 阶段1: 规格合规审查 — 派遣独立审查子代理
    let specCompliance = { passed: true, details: [] };
    try {
      const reviewer = new SubAgent({
        type: SUBAGENT_TYPES.VERIFY,
        parentAgentId: this.parentAgentId,
        description: `规格合规审查: 检查实现是否满足以下规格\n\n规格:\n${taskSpec}\n\n实现结果:\n${typeof workerResult === 'string' ? workerResult.slice(0, 3000) : JSON.stringify(workerResult).slice(0, 3000)}`,
        maxIterations: 5,
      });

      const specReviewResult = await reviewer.execute();
      
      // 解析审查结果
      const specText = typeof specReviewResult === 'string' ? specReviewResult : JSON.stringify(specReviewResult);
      const specFailed = specText.toLowerCase().includes('不满意') || 
                         specText.toLowerCase().includes('未实现') || 
                         specText.toLowerCase().includes('missing') ||
                         specText.toLowerCase().includes('not implemented');
      
      specCompliance = {
        passed: !specFailed,
        details: specText.slice(0, 500),
        reviewerId: reviewer.id,
      };
    } catch (e) {
      specCompliance = { passed: true, details: `审查执行异常: ${e.message}，默认通过` };
    }

    // 阶段2: 代码质量审查 — 派遣另一个独立审查子代理
    let codeQuality = { passed: true, details: [] };
    try {
      const qualityReviewer = new SubAgent({
        type: SUBAGENT_TYPES.ANALYZE,
        parentAgentId: this.parentAgentId,
        description: `代码质量审查: 检查以下实现的代码质量\n\n实现结果:\n${typeof workerResult === 'string' ? workerResult.slice(0, 3000) : JSON.stringify(workerResult).slice(0, 3000)}\n\n检查项:\n1. 错误处理是否完善\n2. 边界情况是否覆盖\n3. 代码风格是否一致\n4. 是否有硬编码或魔法数字\n5. 是否有潜在的性能问题`,
        maxIterations: 5,
      });

      const qualityReviewResult = await qualityReviewer.execute();
      
      const qualityText = typeof qualityReviewResult === 'string' ? qualityReviewResult : JSON.stringify(qualityReviewResult);
      const qualityFailed = qualityText.toLowerCase().includes('严重问题') || 
                            qualityText.toLowerCase().includes('critical') ||
                            qualityText.toLowerCase().includes('必须修复');
      
      codeQuality = {
        passed: !qualityFailed,
        details: qualityText.slice(0, 500),
        reviewerId: qualityReviewer.id,
      };
    } catch (e) {
      codeQuality = { passed: true, details: `质量审查异常: ${e.message}，默认通过` };
    }

    const approved = specCompliance.passed && codeQuality.passed;

    return { specCompliance, codeQuality, approved };
  }

  /**
   * SDD 执行计划（参照 Superpowers Subagent-Driven Development）   * 
   * 将计划拆分为独立任务，每个任务派遣子代理执行）   * 完成后经过双阶段审查，审查通过才继续下一个任）   * 
   * @param {Array} tasks - 任务列表 [{ description, taskSpec, toolSet }]
   * @param {object} options - 执行选项
   * @returns {Array} 任务执行结果
   */
  async executePlanWithSDD(tasks, options = {}) {
    const results = [];
    const { onTaskComplete, onReviewFailed, maxRetries = 1 } = options;

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      
      // 派遣子代理执行任务
      const worker = this.spawnWorker({
        description: task.description,
        toolSet: task.toolSet || SUBAGENT_TOOL_SETS[SUBAGENT_TYPES.IMPLEMENT],
        maxIterations: task.maxIterations || DEFAULT_MAX_ITERATIONS,
      });

      this.assignTask(worker.id, task);
      
      try {
        await worker.execute();
      } catch (e) {
        results.push({ taskIndex: i, task: task.description, success: false, error: e.message });
        if (onReviewFailed) onReviewFailed(i, { error: e.message });
        continue;
      }

      // 双阶段审查
      const review = await this.dualStageReview(worker.id, task);

      if (review.approved) {
        results.push({
          taskIndex: i,
          task: task.description,
          success: true,
          result: worker.result,
          review,
        });
        if (onTaskComplete) onTaskComplete(i, results[i]);
      } else {
        // 审查未通过，尝试重试
        let retried = false;
        for (let retry = 0; retry < maxRetries; retry++) {
          const retryWorker = this.spawnWorker({
            description: `[重试 ${retry + 1}] ${task.description}\n\n审查反馈:\n规格合规: ${review.specCompliance.details}\n代码质量: ${review.codeQuality.details}`,
            toolSet: task.toolSet || SUBAGENT_TOOL_SETS[SUBAGENT_TYPES.IMPLEMENT],
            maxIterations: task.maxIterations || DEFAULT_MAX_ITERATIONS,
          });

          try {
            await retryWorker.execute();
            const retryReview = await this.dualStageReview(retryWorker.id, task);
            
            if (retryReview.approved) {
              results.push({
                taskIndex: i,
                task: task.description,
                success: true,
                result: retryWorker.result,
                review: retryReview,
                retryCount: retry + 1,
              });
              retried = true;
              if (onTaskComplete) onTaskComplete(i, results[results.length - 1]);
              break;
            }
          } catch { console.warn('[subagent-enhanced] silent catch, error swallowed'); }
        }

        if (!retried) {
          results.push({
            taskIndex: i,
            task: task.description,
            success: false,
            result: worker.result,
            review,
          });
          if (onReviewFailed) onReviewFailed(i, review);
        }
      }
    }

    return results;
  }
}

function createSubAgent(options) {
 const parentAgentId = options?.parentAgentId || 'root';

  // 子代理契约校验（agent-contract-validator）— 强制执行
  // 如果有 contract 配置则 enforceSpawn，没有合约则跳过（向后兼容）
  try {
    const { globalAgentContractValidator } = require('./agent-contract-validator');
    const agentType = options.type || 'analyst';
    const contracts = globalAgentContractValidator.getContracts();
    if (contracts[agentType]) {
      // D1(Runtime差距分析): capabilities 从类型工具白名单派生(此前恒 [],
      // requiredCapabilities 校验形同虚设); tools 回退到该类型的真实白名单,
      // recommendedTools 检查同样有据可依。
      const { deriveSubagentCapabilities } = require('./agent/capability-map');
      const effectiveTools = options.allowedTools || options.tools || SUBAGENT_TOOL_SETS[agentType] || [];
      const agentDef = {
        capabilities: options.capabilities || deriveSubagentCapabilities(effectiveTools),
        tools: effectiveTools,
        budgetTokens: options.budgetTokens,
        maxIterations: options.maxTurns || options.maxIterations,
      };
      globalAgentContractValidator.enforceSpawn(agentType, agentDef, options.input || {});
    } else {
      console.debug('[subagent-enhanced] No contract defined for type "' + agentType + '", skipping validation');
    }
  } catch (e) {
    console.warn('[subagent-enhanced] Contract enforcement error:', e.message);
    throw e;
  }

  const config = new SubAgentConfig(options);
  const agent = new SubAgent(config);

  // 2026-08-01: P0 泄漏修复——pushCall 改用 agent.id（此前用临时 key
  // `enhanced_${Date.now()}`，complete/fail/cancel 无法对应释放；且并发失败
  // 路径 pop 的是 parentAgentId（错误 key），调用栈只增不减）
  try {
    recursionDetector.pushCall(agent.id, parentAgentId);
  } catch (e) {
    throw new Error(`递归深度超过限制: ${e.message}`);
  }

  const stats = concurrencyManager.getStats();
  if (stats.coordinator.active >= MAX_CONCURRENT) {
    recursionDetector.popCall(agent.id);
    throw new Error(`子代理并发数已达上限 (${MAX_CONCURRENT})`);
  }

  concurrencyManager.registerAgent(agent.id, { type: agent.type, parentAgentId });
  return agent;
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

function cleanupSubAgent(subagentId) {
  const subagent = subagents.get(subagentId);
  if (!subagent) return false;
  
  subagents.delete(subagentId);
  console.log(`🦀 SubAgent 清理: ${subagentId}`);
  return true;
}

function cleanupCompletedSubAgents() {
  const completed = listSubAgents().filter(
    s => s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled'
  );
  
  for (const subagent of completed) {
    cleanupSubAgent(subagent.id);
  }
  
  return completed.length;
}

function getSubAgentStats() {
  const all = listSubAgents();
  return {
    total: all.length,
    pending: all.filter(s => s.status === 'pending').length,
    running: all.filter(s => s.status === 'running').length,
    completed: all.filter(s => s.status === 'completed').length,
    failed: all.filter(s => s.status === 'failed').length,
    cancelled: all.filter(s => s.status === 'cancelled').length,
  };
}

function formatSubAgentNotification(subagent) {
  const lines = [
    '<subagent-notification>',
    `<subagent-id>${subagent.id}</subagent-id>`,
    `<type>${subagent.type}</type>`,
    `<status>${subagent.status}</status>`,
    `<summary>${subagent.description} - ${subagent.status}</summary>`,
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
  
  lines.push('<usage>');
  lines.push(`  <tokens>${subagent.usage.tokens}</tokens>`);
  lines.push(`  <tool_calls>${subagent.usage.toolCalls}</tool_calls>`);
  lines.push(`  <duration_ms>${subagent.usage.duration}</duration_ms>`);
  lines.push('</usage>');
  
  if (subagent.progress && subagent.progress.length > 0) {
    lines.push('<progress>');
    for (const p of subagent.progress.slice(-5)) {
      lines.push(`  <step timestamp="${p.timestamp}">${p.message}</step>`);
    }
    lines.push('</progress>');
  }
  
  lines.push('</subagent-notification>');
  
  return lines.join('\n');
}

// ─── 并行批量委派 ───────────────────────────────────────────

/**
 * 并行批量委派多个 Agent
 *
 * 参照 Hermes delegate_task(tasks: [...]) 设计，一次调用启动多个并行子 Agent） * 最多同时运行 MAX_PARALLEL_TASKS 个，超出部分排队等待\uff09\n * @param {Array<{goal, type?, toolProfile?, maxIterations?, timeout?}>} tasks 任务列表
 * @param {object} options
 * @param {string} options.parentAgentId — Agent ID
 * @param {number} options.concurrency 并发数（默认 MAX_PARALLEL_TASKS） * @param {AbortSignal} options.signal 外部中断信号
 * @param {Function} [options.onTaskStart] 任务启动回调 (index) => void（2026-08-15 T7）
 * @param {Function} [options.onTaskComplete] 任务完成回调 (index, result) => void（2026-08-15 T7）
 * @returns {Promise<Array<{id, status, result?, error?}>>}
 */
async function delegateTasks(tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return [];
  }

  const parentAgentId = options.parentAgentId || 'root';
  const concurrency = Math.min(options.concurrency || MAX_PARALLEL_TASKS, MAX_PARALLEL_TASKS);
  const externalSignal = options.signal || null;

  // 创建 Agent 实例
  const agents = tasks.map((task, index) => {
    return createSubAgent({
      type: task.type || SUBAGENT_TYPES.RESEARCH,
      description: task.goal || task.description || `并行任务 #${index + 1}`,
      prompt: task.goal || task.description,
      parentAgentId,
      toolProfile: task.toolProfile || 'coding',
      maxIterations: task.maxIterations || DEFAULT_MAX_ITERATIONS,
      timeout: task.timeout || 300000,
      // 2026-09-05 真传: 专家身份经 _expert 到达 SubAgent(执行时注入岗位 system 消息)
      _expert: task._expert || null,
    });
  });

  // 中断传播：外部信号触发时取消所有子 Agent
  let cancelled = false;
  const onExternalAbort = () => {
    if (cancelled) return;
    cancelled = true;
    for (const agent of agents) {
      if (agent.status === 'running' || agent.status === 'pending') {
        agent.cancel();
      }
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
      return agents.map(a => ({ id: a.id, status: 'cancelled', error: '外部中断' }));
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // 并发执行（信号量模式）
  const results = [];
  let running = 0;
  let nextIndex = 0;
  // 2026-09-07: 完成计数——results 是按下标回填的稀疏数组，用 results.length
  // 判"全部完成"会提前假完成：最后下标的任务先完成时 length 立即等于总数，
  // 其余仍在跑的任务被上层协作看门狗标记"整体看门狗"超时（实测 4 成员例会
  // 恒定 2 个超时——税务/簿记数组前两位每次中招）。
  let completed = 0;

  return new Promise((resolve) => {
    function tryNext() {
      if (cancelled) {
        // 填充未启动的任务
        for (let idx = 0; idx < agents.length; idx++) {
          if (results[idx]) continue;
          results[idx] = { id: agents[idx].id, status: 'cancelled', error: '批量中断' };
          completed++;
          try {
            if (options.onTaskComplete) options.onTaskComplete(idx, results[idx]);
          } catch (cbErr) {
            console.warn('[delegateTasks] onTaskComplete 回调异常:', cbErr?.message || cbErr);
          }
        }
        resolve(results);
        return;
      }

      // 所有任务完成
      if (completed === agents.length) {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
        resolve(results);
        return;
      }

      // 启动下一个任务
      while (running < concurrency && nextIndex < agents.length) {
        const agent = agents[nextIndex];
        const agentIndex = nextIndex;
        nextIndex++;
        running++;

        // 任务启动回调（2026-08-15 T7: 专家协作 collab:progress running 态）
        try {
          if (options.onTaskStart) options.onTaskStart(agentIndex);
        } catch (cbErr) {
          console.warn('[delegateTasks] onTaskStart 回调异常:', cbErr?.message || cbErr);
        }

        // 执行的 Agent
        // 2026-09-05 真传: llmFn/toolExecutor 透传到 executeOptions(测试与外部注入)
        const executeOptions = { ...(options.executeOptions || {}) };
        if (options.llmFn) executeOptions.llmFn = options.llmFn;
        if (options.toolExecutor) executeOptions.toolExecutor = options.toolExecutor;
        agent.execute(executeOptions).then((result) => {
          results[agentIndex] = {
            id: agent.id,
            status: agent.status,
            result: agent.result || result,
            error: agent.error,
            duration: agent.getDuration(),
          };
          completed++;
          running--;
          try {
            if (options.onTaskComplete) options.onTaskComplete(agentIndex, results[agentIndex]);
          } catch (cbErr) {
            console.warn('[delegateTasks] onTaskComplete 回调异常:', cbErr?.message || cbErr);
          }
          tryNext();
        }).catch((err) => {
          results[agentIndex] = {
            id: agent.id,
            status: 'failed',
            error: err.message,
            duration: agent.getDuration(),
          };
          completed++;
          running--;
          try {
            if (options.onTaskComplete) options.onTaskComplete(agentIndex, results[agentIndex]);
          } catch (cbErr) {
            console.warn('[delegateTasks] onTaskComplete 回调异常:', cbErr?.message || cbErr);
          }
          tryNext();
        });
      }
    }

    tryNext();
  });
}

/**
 * 取消指定的 Agent 下的所有活跃子 Agent
 * 用于中断传播：父 Agent 被中断时调用
 *
 * @param {string} parentAgentId — Agent ID
 * @returns {number} 被取消的 Agent 数量
 */
function cancelChildren(parentAgentId) {
  let count = 0;
  for (const agent of subagents.values()) {
    if (agent.parentAgentId === parentAgentId &&
        (agent.status === 'running' || agent.status === 'pending')) {
      agent.cancel();
      count++;
    }
  }
  return count;
}

module.exports = {
  SUBAGENT_TYPES,
  SUBAGENT_PROMPTS,
  SUBAGENT_TOOL_SETS,
  SubAgentConfig,
  SubAgent,
  SubAgentCoordinator,
  createSubAgent,
  getSubAgent,
  listSubAgents,
  cleanupSubAgent,
  cleanupCompletedSubAgents,
  getSubAgentStats,
  formatSubAgentNotification,
  // 新增
  delegateTasks,
  cancelChildren,
  DEFAULT_MAX_ITERATIONS,
  MAX_PARALLEL_TASKS,
};
