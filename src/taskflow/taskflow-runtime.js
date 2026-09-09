const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { WORKSPACE_DIR } = require('../core/config');
const { getTaskFlowRegistry } = require('./taskflow-registry');
const { getTaskFlowStore } = require('./taskflow-store');
const { getApprovalGate } = require('./approval-gate');
// eslint-disable-next-line no-unused-vars
const { classifyError, getErrorStrategy, isRetryable, formatErrorReport } = require('./error-classifier');
const { safeEvaluate } = require('../core/security/safe-expression');
const {
  TASKFLOW_STATUS,
  TASKFLOW_STEP_TYPE,
  TASKFLOW_STEP_STATUS,
  TASKFLOW_ERROR_CATEGORY,
  // eslint-disable-next-line no-unused-vars
  TASKFLOW_ERROR_SEVERITY,
  TASKFLOW_ERROR_STRATEGY,
  TASKFLOW_RETRY_BACKOFF,
  TASKFLOW_LOOP_MODE,
  TASKFLOW_APPROVAL_STATUS
} = require('./taskflow-types');

const MAX_EXECUTION_TIME = 300000;
const STEP_TIMEOUT = 60000;
const MAX_EXECUTION_DEPTH = 20;
const MAX_PARALLEL_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

const BUILTIN_FLOWS = [
  {
    id: 'market_research',
    name: '市场调研',
    description: '调研市场信息并生成分析报告',
    keywords: ['市场调研', '行业分析', '竞品分析', '市场分析', 'market research', 'industry analysis'],
    steps: [
      { name: '信息搜集', capabilityId: 'researcher', domainId: 'marketing', order: 1 },
      { name: '数据分析', capabilityId: 'analyst', domainId: 'marketing', order: 2 },
      { name: '报告撰写', capabilityId: 'writer', domainId: 'marketing', order: 3 },
    ],
    active: true,
  },
  {
    id: 'code_review',
    name: '代码审查',
    description: '审查代码质量并给出改进建议',
    keywords: ['代码审查', '代码评审', 'code review', '审查代码', 'review code'],
    steps: [
      { name: '代码阅读', capabilityId: 'researcher', domainId: 'tech', order: 1 },
      { name: '质量评审', capabilityId: 'reviewer', domainId: 'tech', order: 2 },
      { name: '改进建议', capabilityId: 'advisor', domainId: 'tech', order: 3 },
    ],
    active: true,
  },
  {
    id: 'product_launch',
    name: '产品发布',
    description: '产品发布全流程支持',
    keywords: ['产品发布', '上线', '发布产品', 'product launch', 'release'],
    steps: [
      { name: '需求确认', capabilityId: 'researcher', domainId: 'product', order: 1 },
      { name: '方案设计', capabilityId: 'planner', domainId: 'product', order: 2 },
      { name: '开发执行', capabilityId: 'executor', domainId: 'tech', order: 3 },
      { name: '质量验证', capabilityId: 'reviewer', domainId: 'tech', order: 4 },
    ],
    active: true,
  },
  {
    id: 'contract_review',
    name: '合同审查',
    description: '审查合同条款并标注风险',
    keywords: ['合同审查', '合同审核', '合同风险', 'contract review', '审查合同'],
    steps: [
      { name: '合同阅读', capabilityId: 'researcher', domainId: 'legal', order: 1 },
      { name: '风险评估', capabilityId: 'reviewer', domainId: 'legal', order: 2 },
      { name: '修改建议', capabilityId: 'advisor', domainId: 'legal', order: 3 },
    ],
    active: true,
  },
  {
    id: 'financial_report',
    name: '财务报告',
    description: '生成财务分析报告',
    keywords: ['财务报告', '财务分析', '财务报表', 'financial report', 'financial analysis'],
    steps: [
      { name: '数据搜集', capabilityId: 'researcher', domainId: 'finance', order: 1 },
      { name: '数据分析', capabilityId: 'analyst', domainId: 'finance', order: 2 },
      { name: '报告撰写', capabilityId: 'writer', domainId: 'finance', order: 3 },
    ],
    active: true,
  },
  {
    id: 'hr_recruitment',
    name: '招聘流程',
    description: '岗位招聘全流程支持',
    keywords: ['招聘', '招人', '岗位', 'recruitment', 'hiring', 'JD'],
    steps: [
      { name: '需求分析', capabilityId: 'researcher', domainId: 'hr', order: 1 },
      { name: '方案制定', capabilityId: 'planner', domainId: 'hr', order: 2 },
      { name: '执行支持', capabilityId: 'executor', domainId: 'hr', order: 3 },
    ],
    active: true,
  },
  {
    id: 'strategy_planning',
    name: '战略规划',
    description: '企业战略分析与规划',
    keywords: ['战略规划', '战略分析', '战略制定', 'strategic planning', 'strategy'],
    steps: [
      { name: '环境分析', capabilityId: 'researcher', domainId: 'strategy', order: 1 },
      { name: '战略评估', capabilityId: 'analyst', domainId: 'strategy', order: 2 },
      { name: '方案规划', capabilityId: 'planner', domainId: 'strategy', order: 3 },
      { name: '建议输出', capabilityId: 'advisor', domainId: 'strategy', order: 4 },
    ],
    active: true,
  },
  {
    id: 'quality_inspection',
    name: '质量检查',
    description: '产品质量检查与改进',
    keywords: ['质量检查', '品质检验', '质检', 'quality inspection', 'QC'],
    steps: [
      { name: '标准查询', capabilityId: 'researcher', domainId: 'qc', order: 1 },
      { name: '问题分析', capabilityId: 'analyst', domainId: 'qc', order: 2 },
      { name: '改进建议', capabilityId: 'advisor', domainId: 'qc', order: 3 },
    ],
    active: false,
  },
];

class FlowEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this._flows = new Map();
    this._customFlows = new Map();
    this._workspaceDir = config.workspaceDir || WORKSPACE_DIR;
    for (const flow of BUILTIN_FLOWS) {
      this._flows.set(flow.id, { ...flow, source: 'builtin' });
    }
    this._loadCustomFlows();
  }
  _loadCustomFlows() {
    const flowDir = path.join(this._workspaceDir, '.crabpaw', 'flows');
    if (!fs.existsSync(flowDir)) return;
    try {
      const files = fs.readdirSync(flowDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(flowDir, file), 'utf-8');
          const flow = JSON.parse(content);
          if (flow && flow.id) {
            flow.source = 'custom';
            this._customFlows.set(flow.id, flow);
            this.emit('flow:loaded', { id: flow.id, source: 'custom' });
          }
        } catch {
          console.warn('[taskflow-runtime.js] failed to load custom flow file');
        }
      }
    } catch {
      console.warn('[taskflow-runtime.js] failed to scan custom flow directory');
    }
  }
  get(flowId) {
    const custom = this._customFlows.get(flowId);
    if (custom) return { ...custom };
    const builtin = this._flows.get(flowId);
    if (builtin) return { ...builtin };
    return null;
  }
  list() {
    const all = new Map();
    for (const [id, flow] of this._flows) { all.set(id, { ...flow }); }
    for (const [id, flow] of this._customFlows) { all.set(id, { ...flow }); }
    return [...all.values()];
  }
  listActive() { return this.list().filter(f => f.active !== false); }
  matchFlow(message, context = {}) {
    const text = (message || '').toLowerCase();
    const activeFlows = this.listActive();
    const matches = [];
    for (const flow of activeFlows) {
      let score = 0;
      for (const kw of flow.keywords || []) { if (text.includes(kw.toLowerCase())) { score += kw.length; } }
      if (context.domainId && flow.steps) { score += flow.steps.filter(s => s.domainId === context.domainId).length * 2; }
      if (score > 0) { matches.push({ flow, score, confidence: Math.min(score / 15, 1.0) }); }
    }
    if (matches.length === 0) return null;
    matches.sort((a, b) => b.score - a.score);
    return matches[0];
  }
  registerFlow(flowDefinition) {
    if (!flowDefinition || !flowDefinition.id) { throw new Error('Flow definition must have an id'); }
    this._customFlows.set(flowDefinition.id, { ...flowDefinition, source: 'custom' });
    this.emit('flow:registered', { id: flowDefinition.id });
  }
  unregisterFlow(flowId) {
    const builtin = this._flows.get(flowId);
    if (builtin) { this.emit('flow:unregister_denied', { id: flowId, reason: 'Cannot unregister builtin flow' }); return false; }
    this._customFlows.delete(flowId);
    this.emit('flow:unregistered', { id: flowId });
    return true;
  }
  activateFlow(flowId) {
    const flow = this.get(flowId);
    if (!flow) return false;
    flow.active = true;
    if (flow.source === 'builtin') { this._flows.set(flowId, flow); } else { this._customFlows.set(flowId, flow); }
    this.emit('flow:activated', { id: flowId });
    return true;
  }
  deactivateFlow(flowId) {
    const flow = this.get(flowId);
    if (!flow) return false;
    flow.active = false;
    if (flow.source === 'builtin') { this._flows.set(flowId, flow); } else { this._customFlows.set(flowId, flow); }
    this.emit('flow:deactivated', { id: flowId });
    return true;
  }
}
class TaskFlowRuntime extends EventEmitter {
  constructor() {
    super();
    this.registry = getTaskFlowRegistry();
    this.store = getTaskFlowStore();
    this.approvalGate = null;
    this.executingFlows = new Map();
    this.skillExecutor = null;
    this.taskExecutor = null;
    this.llmProvider = null;
    this.initialized = false;
    this._broadcastFn = null;
    this._executionDepth = new Map();
    this._webhookAllowList = null;
    this._retryConfig = {
      maxRetries: DEFAULT_MAX_RETRIES,
      retryDelay: RETRY_DELAY_MS,
      backoff: TASKFLOW_RETRY_BACKOFF.EXPONENTIAL,
      retryableTypes: [
        TASKFLOW_STEP_TYPE.SKILL,
        TASKFLOW_STEP_TYPE.TASK,
        TASKFLOW_STEP_TYPE.WEBHOOK,
        TASKFLOW_STEP_TYPE.LLM
      ]
    };
    this._metrics = {
      totalFlows: 0,
      completedFlows: 0,
      failedFlows: 0,
      recoveredFlows: 0,
      totalDuration: 0,
      stepExecutions: 0,
      stepSuccesses: 0,
      stepFailures: 0,
      stepRetries: 0,
      stepDegraded: 0,
      approvalRequested: 0,
      approvalResolved: 0,
      startTime: Date.now()
    };
  }

  async initialize() {
    if (this.initialized) return;

    await this.registry.initialize();

    this.approvalGate = getApprovalGate(this.store);
    await this.approvalGate.initialize();

    this.initialized = true;
    console.log('✅ TaskFlow Runtime 初始化完成');
  }

  setSkillExecutor(executor) {
    this.skillExecutor = executor;
  }

  setTaskExecutor(executor) {
    this.taskExecutor = executor;
  }

  setLlmProvider(provider) {
    this.llmProvider = provider;
  }

  setBroadcastFn(fn) {
    this._broadcastFn = fn;
  }

  setRetryConfig(config) {
    this._retryConfig = { ...this._retryConfig, ...config };
  }

  setWebhookAllowList(domains) {
    this._webhookAllowList = domains;
  }

  getMetrics() {
    const m = this._metrics;
    const avgDuration = m.completedFlows > 0 ? m.totalDuration / m.completedFlows : 0;
    const completionRate = m.totalFlows > 0 ? m.completedFlows / m.totalFlows : 0;
    const stepSuccessRate = m.stepExecutions > 0 ? m.stepSuccesses / m.stepExecutions : 0;
    const uptime = Date.now() - m.startTime;

    return {
      flows: {
        total: m.totalFlows,
        completed: m.completedFlows,
        failed: m.failedFlows,
        recovered: m.recoveredFlows,
        completionRate: Math.round(completionRate * 10000) / 100,
        avgDurationMs: Math.round(avgDuration),
        totalDurationMs: m.totalDuration
      },
      steps: {
        executions: m.stepExecutions,
        successes: m.stepSuccesses,
        failures: m.stepFailures,
        retries: m.stepRetries,
        degraded: m.stepDegraded,
        successRate: Math.round(stepSuccessRate * 10000) / 100
      },
      approvals: {
        requested: m.approvalRequested,
        resolved: m.approvalResolved
      },
      uptimeMs: uptime
    };
  }

  _broadcast(eventType, data) {
    if (this._broadcastFn) {
      try {
        this._broadcastFn(eventType, data);
      } catch (e) {
        console.warn('⚠️ TaskFlow 广播失败:', e.message);
      }
    }
    this.emit(eventType, data);
  }

  async executeFlow(flowId, context = {}) {
    await this._ensureInitialized();

    if (this.executingFlows.has(flowId)) {
      throw new Error(`Flow ${flowId} is already executing`);
    }

    const flow = await this.registry.getFlow(flowId);
    if (!flow) {
      throw new Error(`Flow not found: ${flowId}`);
    }

    if (flow.status !== TASKFLOW_STATUS.QUEUED &&
        flow.status !== TASKFLOW_STATUS.WAITING &&
        flow.status !== TASKFLOW_STATUS.LOST) {
      throw new Error(`Flow ${flowId} is not in executable state: ${flow.status}`);
    }

    this.executingFlows.set(flowId, { startTime: Date.now(), context });
    this.registry.markFlowActive(flowId);
    this._metrics.totalFlows++;

    this._broadcast('taskflow_started', {
      flowId,
      goal: flow.goal,
      timestamp: Date.now()
    });

    try {
      await this.registry.updateFlow(flowId, {
        status: TASKFLOW_STATUS.RUNNING,
        currentStep: 'start'
      });

      const startTime = Date.now();
      const result = await this._executeWithTimeout(
        flow,
        context,
        flow.timeout || MAX_EXECUTION_TIME
      );

      const duration = Date.now() - startTime;

      await this.registry.finishFlow(flowId);

      await this.store.addHistory(flowId, 'completed', {
        duration,
        result: result.success,
        stepCount: Object.keys(result.results || {}).length
      });

      this._broadcast('taskflow_completed', {
        flowId,
        goal: flow.goal,
        duration,
        result: result.success,
        stepResults: this._summarizeResults(result.results),
        timestamp: Date.now()
      });

      console.log(`✅ TaskFlow ${flowId} 执行完成 (${duration}ms)`);

      this._metrics.completedFlows++;
      this._metrics.totalDuration += duration;

      return result;
    } catch (error) {
      const classification = classifyError(error);
      await this.registry.failFlow(
        flowId,
        error,
        classification.category,
        classification.strategy
      );

      await this.store.addHistory(flowId, 'failed', {
        error: error.message,
        errorCategory: classification.category,
        errorSeverity: classification.severity,
        stack: error.stack?.substring(0, 500)
      });

      this._broadcast('taskflow_failed', {
        flowId,
        goal: flow.goal,
        error: error.message,
        errorCategory: classification.category,
        timestamp: Date.now()
      });

      console.error(`❌ TaskFlow ${flowId} 执行失败:`, error.message);

      this._metrics.failedFlows++;

      throw error;
    } finally {
      this.executingFlows.delete(flowId);
      this.registry.markFlowInactive(flowId);
    }
  }

  _summarizeResults(results) {
    if (!results) return [];
    return Object.entries(results).map(([stepId, r]) => ({
      stepId,
      type: r.type,
      success: r.result?.success !== false
    }));
  }

  async _executeWithTimeout(flow, context, timeout) {
    const steps = this._ensureSteps(this._resolveSteps(flow), flow.goal);
    const completedStepIndex = await this._findResumePoint(flow.flowId, steps);
    const results = await Promise.race([
      this._executeSteps(flow.flowId, steps, context, completedStepIndex),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Flow execution timeout after ${timeout}ms`)), timeout)
      )
    ]);
    return { success: true, results };
  }

  async _findResumePoint(flowId, steps) {
    try {
      const tasks = await this.store.getTasksByFlow(flowId);
      if (!tasks || tasks.length === 0) return 0;

      const completedSteps = new Set(
        tasks
          .filter(t => t.status === TASKFLOW_STEP_STATUS.COMPLETED || t.status === TASKFLOW_STEP_STATUS.WAITING_APPROVAL)
          .map(t => t.stepId)
      );

      for (let i = 0; i < steps.length; i++) {
        const stepId = `step_${i}`;
        if (!completedSteps.has(stepId)) {
          return i;
        }
      }

      return steps.length;
    } catch (e) {
      return 0;
    }
  }

  _resolveSteps(flow) {
    if (flow.stateJson && typeof flow.stateJson === 'object' && flow.stateJson.steps) {
      return flow.stateJson.steps.map((step, idx) => {
        if (typeof step === 'object') {
          // Resolve capabilityId → skill name if needed
          if (step.capabilityId && !step.skill) {
            try {
              const { getCapabilityRegistry } = require('./skill-capability-registry');
              const registry = getCapabilityRegistry();
              const resolved = registry.resolveCapability(step.capabilityId, step.domainId);
              if (resolved) {
                return {
                  ...step,
                  skill: resolved,
                  type: step.type || TASKFLOW_STEP_TYPE.SKILL,
                  _index: idx,
                  _source: 'template',
                  _resolved: true
                };
              }
            } catch (e) {
              console.warn('[taskflow-runtime] failed to resolve capability in _resolveSteps:', e.message);
            }
          }
          if (step.type) {
            return { ...step, _index: idx, _source: 'template' };
          }
          return null;
        }
        const parsed = this._parseStep(String(step));
        if (parsed) {
          return { ...parsed, _index: idx, _source: 'template_string' };
        }
        return null;
      }).filter(Boolean);
    }

    if (flow.stateJson && typeof flow.stateJson === 'string') {
      try {
        const parsed = JSON.parse(flow.stateJson);
        if (parsed && parsed.steps) {
          return parsed.steps.map((step, idx) => {
            if (typeof step === 'object') {
              if (step.capabilityId && !step.skill) {
                try {
                  const { getCapabilityRegistry } = require('./skill-capability-registry');
                  const registry = getCapabilityRegistry();
                  const resolved = registry.resolveCapability(step.capabilityId, step.domainId);
                  if (resolved) {
                    return { ...step, skill: resolved, type: step.type || TASKFLOW_STEP_TYPE.SKILL, _index: idx, _source: 'template_json', _resolved: true };
                  }
                } catch (e) { console.warn('[taskflow-runtime] failed to resolve capability:', e.message); }
              }
              if (step.type) {
                return { ...step, _index: idx, _source: 'template_json' };
              }
              return null;
            }
            const p = this._parseStep(String(step));
            if (p) return { ...p, _index: idx, _source: 'template_json_string' };
            return null;
          }).filter(Boolean);
        }
      } catch (e) {
        console.warn('[taskflow-runtime] failed to parse stateJson, falling through:', e.message);
      }
    }

    return this._parseGoal(flow.goal);
  }

  _ensureSteps(steps, goal) {
    if (steps.length > 0) return steps;

    if (goal && typeof goal === 'string' && goal.trim()) {
      console.log(`⚠️ 目标无法解析为步骤，将整体作为任务执行: ${goal.substring(0, 100)}`);
      return [{
        type: TASKFLOW_STEP_TYPE.TASK,
        task: goal.trim(),
        _index: 0,
        _source: 'goal_fallback'
      }];
    }

    return steps;
  }

  _parseGoal(goal) {
    if (!goal || typeof goal !== 'string') {
      return [];
    }

    const lines = goal.split('\n').filter(line => line.trim());
    const steps = [];

    for (let i = 0; i < lines.length; i++) {
      const step = this._parseStep(lines[i]);
      if (step) {
        step._index = i;
        step._source = 'goal';
        steps.push(step);
      }
    }

    return steps;
  }

  _parseStep(line) {
    const trimmed = (typeof line === 'string') ? line.trim() : '';

    if (typeof line === 'object' && line.type) {
      return line;
    }

    if (trimmed.startsWith('skill:')) {
      const skillCall = trimmed.slice(6).trim();
      const match = skillCall.match(/^(\w[\w-]*)\((.*)\)$/);

      if (match) {
        return {
          type: TASKFLOW_STEP_TYPE.SKILL,
          skill: match[1],
          params: this._parseParams(match[2])
        };
      }

      return {
        type: TASKFLOW_STEP_TYPE.SKILL,
        skill: skillCall,
        params: {}
      };
    }

    if (trimmed.startsWith('task:')) {
      const taskCall = trimmed.slice(5).trim();
      return {
        type: TASKFLOW_STEP_TYPE.TASK,
        task: taskCall
      };
    }

    if (trimmed.startsWith('condition:')) {
      const condition = trimmed.slice(10).trim();
      return {
        type: TASKFLOW_STEP_TYPE.CONDITION,
        condition
      };
    }

    if (trimmed.startsWith('delay:')) {
      const delayStr = trimmed.slice(6).trim();
      const delay = parseInt(delayStr, 10);

      if (!isNaN(delay)) {
        return {
          type: TASKFLOW_STEP_TYPE.DELAY,
          delay
        };
      }
    }

    if (trimmed.startsWith('approval:')) {
      const message = trimmed.slice(9).trim();
      return {
        type: TASKFLOW_STEP_TYPE.APPROVAL,
        message
      };
    }

    if (trimmed.startsWith('parallel:')) {
      const parallelContent = trimmed.slice(9).trim();
      return {
        type: TASKFLOW_STEP_TYPE.PARALLEL,
        branches: this._parseParallelBranches(parallelContent)
      };
    }

    if (trimmed.startsWith('webhook:')) {
      const url = trimmed.slice(8).trim();
      return {
        type: TASKFLOW_STEP_TYPE.WEBHOOK,
        url
      };
    }

    if (trimmed.startsWith('loop:')) {
      const loopContent = trimmed.slice(5).trim();
      return this._parseLoopStep(loopContent);
    }

    if (trimmed.startsWith('llm:')) {
      const prompt = trimmed.slice(4).trim();
      return {
        type: TASKFLOW_STEP_TYPE.LLM,
        prompt
      };
    }

    if (trimmed.startsWith('sub_agent:')) {
      const agentContent = trimmed.slice(10).trim();
      return this._parseSubAgentStep(agentContent);
    }

    return null;
  }

  _parseLoopStep(content) {
    const fixedMatch = content.match(/^(\d+)\s*x\s*(.+)$/i);
    if (fixedMatch) {
      return {
        type: TASKFLOW_STEP_TYPE.LOOP,
        mode: TASKFLOW_LOOP_MODE.FIXED,
        count: parseInt(fixedMatch[1], 10),
        steps: [this._parseStep(fixedMatch[2])].filter(Boolean)
      };
    }

    return {
      type: TASKFLOW_STEP_TYPE.LOOP,
      mode: TASKFLOW_LOOP_MODE.CONDITION,
      condition: content,
      steps: []
    };
  }

  _parseSubAgentStep(content) {
    const match = content.match(/^(\w[\w-]*)\((.*)\)$/);
    if (match) {
      return {
        type: TASKFLOW_STEP_TYPE.SUB_AGENT,
        agent: match[1],
        goal: match[2]
      };
    }

    return {
      type: TASKFLOW_STEP_TYPE.SUB_AGENT,
      agent: content,
      goal: ''
    };
  }

  _parseParallelBranches(content) {
    if (!content) return [];
    return content.split('|').map(b => b.trim()).filter(Boolean);
  }

  _parseParams(paramsStr) {
    if (!paramsStr || paramsStr.trim() === '') {
      return {};
    }

    const params = {};
    const pairs = paramsStr.split(',');

    for (const pair of pairs) {
      const [key, value] = pair.split('=').map(s => s.trim());
      if (key && value) {
        params[key] = this._parseValue(value);
      }
    }

    return params;
  }

  _parseValue(value) {
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1);
    }

    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }

    if (value === 'true') return true;
    if (value === 'false') return false;
    if (!isNaN(value)) return Number(value);

    return value;
  }

  async _executeSteps(flowId, steps, context, startFromIndex = 0) {
    const results = {};

    if (startFromIndex > 0) {
      try {
        const completedTasks = await this.store.getTasksByFlow(flowId);
        for (const task of completedTasks) {
          if (task.status === TASKFLOW_STEP_STATUS.COMPLETED && task.result) {
            results[task.stepId] = task.result;
          }
        }
      } catch (e) {
        console.warn('⚠️ 恢复已完成步骤结果失败:', e.message);
      }

      this._broadcast('taskflow_resumed', {
        flowId,
        resumedFromStep: startFromIndex,
        totalSteps: steps.length,
        timestamp: Date.now()
      });

      console.log(`🔄 TaskFlow ${flowId} 从步骤 ${startFromIndex} 恢复执行`);
    }

    for (let i = startFromIndex; i < steps.length; i++) {
      const step = steps[i];
      const stepId = `step_${i}`;
      const progress = Math.round(((i) / steps.length) * 100);

      const flow = await this.registry.getFlow(flowId);
      if (flow && flow.cancelRequestedAt) {
        await this.cancelFlow(flowId);
        break;
      }

      await this.registry.updateFlow(flowId, {
        currentStep: stepId
      });

      this._broadcast('taskflow_step_started', {
        flowId,
        stepId,
        stepType: step.type,
        stepIndex: i,
        totalSteps: steps.length,
        progress,
        timestamp: Date.now()
      });

      const task = {
        taskId: `${flowId}_${stepId}`,
        flowId,
        stepId,
        status: TASKFLOW_STEP_STATUS.RUNNING,
        startedAt: Date.now()
      };

      await this.store.saveTask(task);

      try {
        const result = await this._executeStepWithRetryAndClassification(
          flowId, step, stepId, context, results
        );

        results[stepId] = result;

        await this.store.saveTask({
          ...task,
          status: TASKFLOW_STEP_STATUS.COMPLETED,
          result,
          completedAt: Date.now()
        });

        // —— I-3 T3: step checkpoint ——
        try {
          const cp = this._getCheckpointStore();
          cp.saveCheckpoint("flow_" + flowId, {
            flowId,
            completedSteps: Object.keys(results),
            contextSnapshot: context ? { flowId: context.flowId, domainId: context.domainId, message: context.message } : {},
            updatedAt: Date.now(),
          });
        } catch (e) {
          console.warn("[taskflow] checkpoint 写失败（不阻塞）:", e.message || e);
        }

        const completedProgress = Math.round(((i + 1) / steps.length) * 100);

        this._broadcast('taskflow_step_completed', {
          flowId,
          stepId,
          stepType: step.type,
          stepIndex: i,
          totalSteps: steps.length,
          progress: completedProgress,
          result: result ? 'success' : 'empty',
          timestamp: Date.now()
        });

        this._metrics.stepExecutions++;
        this._metrics.stepSuccesses++;

        if (result && result.waiting) {
          await this.store.saveTask({
            ...task,
            status: TASKFLOW_STEP_STATUS.WAITING_APPROVAL,
            result,
            completedAt: null
          });

          await this.registry.updateFlow(flowId, {
            status: TASKFLOW_STATUS.WAITING,
            currentStep: stepId
          });

          this._broadcast('taskflow_step_waiting_approval', {
            flowId,
            stepId,
            stepType: step.type,
            stepIndex: i,
            totalSteps: steps.length,
            approvalId: result.approvalId,
            resumeToken: result.resumeToken,
            timestamp: Date.now()
          });

          console.log(`⏸️ TaskFlow ${flowId} 在步骤 ${stepId} 暂停等待审批`);

          return results;
        }

        if (step.type === TASKFLOW_STEP_TYPE.CONDITION) {
          const shouldContinue = result.conditionResult;

          if (!shouldContinue) {
            this._broadcast('taskflow_step_condition_false', {
              flowId,
              stepId,
              condition: step.condition,
              progress: completedProgress,
              timestamp: Date.now()
            });
            break;
          }
        }
      } catch (error) {
        const classification = classifyError(error);
        const strategy = getErrorStrategy(classification, step);

        await this.store.saveTask({
          ...task,
          status: TASKFLOW_STEP_STATUS.FAILED,
          error: error.message,
          errorCategory: classification.category,
          errorSeverity: classification.severity,
          completedAt: Date.now()
        });

        this._broadcast('taskflow_step_failed', {
          flowId,
          stepId,
          stepType: step.type,
          stepIndex: i,
          totalSteps: steps.length,
          error: error.message,
          errorCategory: classification.category,
          strategy,
          timestamp: Date.now()
        });

        this._metrics.stepExecutions++;
        this._metrics.stepFailures++;

        if (strategy === TASKFLOW_ERROR_STRATEGY.IGNORE) {
          console.warn(`⚠️ 步骤 ${stepId} 失败但策略为忽略，继续执行`);
          results[stepId] = { type: step.type, error: error.message, ignored: true };
          continue;
        }

        if (strategy === TASKFLOW_ERROR_STRATEGY.FALLBACK && step.fallback) {
          console.log(`🔄 步骤 ${stepId} 执行降级方案`);
          try {
            const fallbackResult = await this._executeStep(step.fallback, context, results);
            results[stepId] = { type: 'fallback', originalError: error.message, result: fallbackResult };
            this._metrics.stepDegraded++;
            continue;
          } catch (fallbackError) {
            console.warn(`⚠️ 降级方案也失败: ${fallbackError.message}`);
          }
        }


        if (strategy === TASKFLOW_ERROR_STRATEGY.DEGRADE && step.degrade) {
          console.log(`降级执行步骤 ${stepId} (DEGRADE)`);
          try {
            const degradedResult = await this._executeStep(step.degrade, context, results);
            results[stepId] = { type: 'degrade', originalError: error.message, result: degradedResult };
            this._metrics.stepDegraded++;
            continue;
          } catch (degradeError) {
            console.warn(`降级方案也失败: ${degradeError.message}`);
          }
        }

        throw error;
      }
    }

    return results;
  }

  async _executeStepWithRetryAndClassification(flowId, step, stepId, context, previousResults) {
    const maxRetries = step.retry ?? this._retryConfig.maxRetries;
    const isRetryableType = this._retryConfig.retryableTypes.includes(step.type);
    let lastError = null;
    let attempt = 0;
    let localStepRetryDelay = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (attempt > 0) {
          const delay = this._calculateBackoffDelay(attempt);
          console.log(`🔄 步骤重试 (${attempt}/${maxRetries}): ${step.type}, 等待 ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));

          this._broadcast('taskflow_step_retry', {
            flowId,
            stepId,
            stepType: step.type,
            attempt,
            maxRetries,
            timestamp: Date.now()
          });

          this._metrics.stepRetries++;

          await this.store.saveTask({
            taskId: `${flowId}_${stepId}`,
            flowId,
            stepId,
            status: TASKFLOW_STEP_STATUS.RUNNING,
            retryCount: attempt,
            startedAt: Date.now()
          });
        }

        const stepTimeout = step.timeout || STEP_TIMEOUT;
        const result = await this._executeStepWithTimeout(step, context, previousResults, stepTimeout);

        if (attempt > 0) {
          console.log(`✅ 步骤重试成功 (${attempt}次): ${step.type}`);
        }

        return result;
      } catch (error) {
        lastError = error;
        attempt++;

        const classification = classifyError(error);
        const canRetry = isRetryable(
          classification,
          attempt - 1,
          maxRetries
        ) && isRetryableType;

        if (!canRetry) {
          break;
        }

        if (classification.suggestedDelay) {
          localStepRetryDelay = classification.suggestedDelay;
        }

        const delay = this._calculateBackoffDelay(attempt, localStepRetryDelay || this._retryConfig.retryDelay);
        console.log(`🔄 步骤重试等待 ${delay}ms (第${attempt}次)...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  _calculateBackoffDelay(attempt, baseDelay) {
    baseDelay = baseDelay || this._retryConfig.retryDelay;
    switch (this._retryConfig.backoff) {
      case TASKFLOW_RETRY_BACKOFF.EXPONENTIAL:
        return baseDelay * Math.pow(2, attempt - 1);
      case TASKFLOW_RETRY_BACKOFF.LINEAR:
        return baseDelay * attempt;
      case TASKFLOW_RETRY_BACKOFF.FIXED:
      default:
        return baseDelay;
    }
  }

  async _executeStepWithTimeout(step, context, previousResults, timeout) {
    return Promise.race([
      this._executeStep(step, context, previousResults),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Step execution timeout after ${timeout}ms: ${step.type}`)), timeout)
      )
    ]);
  }

  async _executeStep(step, context, previousResults) {

    const depthId = Symbol('depth');
    this._executionDepth.set(depthId, true);
    if (this._executionDepth.size > MAX_EXECUTION_DEPTH) {
      this._executionDepth.delete(depthId);
      throw new Error("Max execution depth (" + MAX_EXECUTION_DEPTH + ") exceeded at step: " + step.type);
    }

    try {
    switch (step.type) {
      case TASKFLOW_STEP_TYPE.SKILL:
        return await this._executeSkill(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.TASK:
        return await this._executeTask(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.CONDITION:
        return await this._evaluateCondition(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.DELAY:
        return await this._executeDelay(step);

      case TASKFLOW_STEP_TYPE.APPROVAL:
        return await this._executeApproval(step, context);

      case TASKFLOW_STEP_TYPE.PARALLEL:
        return await this._executeParallel(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.WEBHOOK:
        return await this._executeWebhook(step, context);

      case TASKFLOW_STEP_TYPE.SEQUENCE:
        return await this._executeSequence(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.LOOP:
        return await this._executeLoop(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.LLM:
        return await this._executeLlm(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.SUB_AGENT:
        return await this._executeSubAgent(step, context, previousResults);

      case TASKFLOW_STEP_TYPE.GATE:
        return await this._executeGate(step, context, previousResults);

      default:
        // 如果步骤有 capabilityId 但未解析，尝试通过能力注册表解析
        if (step.capabilityId && !step.skill) {
          try {
            const { getCapabilityRegistry } = require('./skill-capability-registry');
            const registry = getCapabilityRegistry();
            const resolved = registry.resolveCapability(step.capabilityId, step.domainId);
            if (resolved) {
              step.skill = resolved;
              console.log(`🔧 能力注册表解析: ${step.capabilityId} → ${resolved}`);
              return await this._executeSkill(step, context, previousResults);
            }
          } catch (e) {
            console.warn(`[TaskFlow] 能力注册表不可用:`, e.message);
          }
        }
        console.warn(`⚠️ 未知步骤类型: ${step.type}, 尝试作为技能执行`);
        if (step.skill) {
          return await this._executeSkill(step, context, previousResults);
        }
        throw new Error(`Unknown step type: ${step.type}`);
    }

    } finally {
      this._executionDepth.delete(depthId);
    }  }

  async _executeSkill(step, context, previousResults) {
    if (!this.skillExecutor) {
      throw new Error('Skill executor not configured');
    }

    const params = this._resolveParams(step.params || step.input, context, previousResults);
    const enrichedParams = this._enrichParamsFromPreviousResults(params, previousResults);

    console.log(`🔧 执行技能: ${step.skill}`, JSON.stringify(enrichedParams).substring(0, 200));

    const result = await this.skillExecutor(step.skill, enrichedParams);

    return {
      type: 'skill',
      skill: step.skill,
      result
    };
  }

  _enrichParamsFromPreviousResults(params, previousResults) {
    const enriched = { ...params };

    const resultKeys = Object.keys(previousResults);
    if (resultKeys.length > 0) {
      const lastStepId = resultKeys[resultKeys.length - 1];
      const lastResult = previousResults[lastStepId];

      if (lastResult && lastResult.result && typeof lastResult.result === 'object') {
        if (!enriched.previousResult && lastResult.result.result) {
          enriched.previousResult = typeof lastResult.result.result === 'string'
            ? lastResult.result.result
            : JSON.stringify(lastResult.result.result);
        }
      }
    }

    return enriched;
  }

  async _executeTask(step, context, previousResults) {
    if (!this.taskExecutor) {
      throw new Error('Task executor not configured');
    }

    const params = this._resolveParams(step.params || step.input, context, previousResults);

    console.log(`📋 执行任务: ${step.task}`);

    const result = await this.taskExecutor(step.task, params, context);

    return {
      type: 'task',
      task: step.task,
      result
    };
  }

  async _evaluateCondition(step, context, previousResults) {
    const condition = step.condition;
    let result = false;

    if (typeof condition === 'function') {
      result = condition(context, previousResults);
    } else if (typeof condition === 'string') {
      try {
        result = this._safeEvalExpression(condition, context, previousResults);
      } catch (e) {
        console.warn(`⚠️ 条件评估失败: ${condition}`, e.message);
        result = false;
      }
    } else if (typeof condition === 'object' && condition !== null) {
      result = this._evaluateStructuredCondition(condition, context, previousResults);
    }

    console.log(`🔍 条件评估: ${typeof condition === 'string' ? condition : 'structured'} = ${result}`);

    return {
      type: 'condition',
      conditionResult: !!result
    };
  }

  _evaluateStructuredCondition(condition, context, previousResults) {
    if (condition.operator === 'and') {
      return (condition.conditions || []).every(c =>
        this._evaluateStructuredCondition(c, context, previousResults)
      );
    }
    if (condition.operator === 'or') {
      return (condition.conditions || []).some(c =>
        this._evaluateStructuredCondition(c, context, previousResults)
      );
    }
    if (condition.operator === 'not') {
      return !this._evaluateStructuredCondition(condition.condition, context, previousResults);
    }
    if (condition.field && condition.operator) {
      const fieldValue = context[condition.field] ?? previousResults[condition.field];
      switch (condition.operator) {
        case 'equals': return fieldValue === condition.value;
        case 'not_equals': return fieldValue !== condition.value;
        case 'contains': return String(fieldValue).includes(condition.value);
        case 'greater_than': return fieldValue > condition.value;
        case 'less_than': return fieldValue < condition.value;
        case 'exists': return fieldValue !== undefined && fieldValue !== null;
        default: return false;
      }
    }
    return false;
  }

  _safeEvalExpression(expression, context, previousResults) {
    const evalContext = { ...context, results: previousResults };
    const result = safeEvaluate(expression, evalContext);
    if (!result.safe) {
      throw new Error(`条件表达式不安全: ${result.reason || expression}`);
    }
    return result.value;
  }

  async _executeDelay(step) {
    const delay = step.delay || 1000;
    console.log(`⏱️ 延迟 ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return {
      type: 'delay',
      delay,
      completed: true
    };
  }

  async _executeApproval(step, context) {
    await this._ensureInitialized();

    const message = step.message || '需要审批';
    const config = {
      approver: step.approver || null,
      expiryMs: step.expiryMs || undefined,
      metadata: step.metadata || {}
    };

    const approval = await this.approvalGate.createApproval(
      context.flowId || 'unknown',
      context.stepId || 'unknown',
      message,
      config
    );

    this._metrics.approvalRequested++;

    this._broadcast('taskflow_approval_requested', {
      flowId: context.flowId,
      stepId: context.stepId,
      approvalId: approval.approvalId,
      message: approval.message,
      resumeToken: approval.resumeToken,
      expiresAt: approval.expiresAt,
      timestamp: Date.now()
    });

    return {
      type: 'approval',
      approvalId: approval.approvalId,
      resumeToken: approval.resumeToken,
      message: approval.message,
      status: TASKFLOW_APPROVAL_STATUS.PENDING,
      waiting: true
    };
  }

  async resumeApproval(resumeToken, approved, result = null) {
    await this._ensureInitialized();

    const resolution = await this.approvalGate.resumeWithToken(resumeToken, approved, result);

    this._metrics.approvalResolved++;

    this._broadcast('taskflow_approval_resolved', {
      flowId: resolution.flowId,
      stepId: resolution.stepId,
      approvalId: resolution.approvalId,
      approved: resolution.approved,
      timestamp: Date.now()
    });

    if (approved) {
      const flow = await this.registry.getFlow(resolution.flowId);
      if (flow && flow.status === TASKFLOW_STATUS.WAITING) {
        await this.registry.resumeFlow(resolution.flowId, {
          approvalResult: { approved, result: resolution.result }
        });

        this.executeFlow(resolution.flowId, { resumedFromApproval: true }).catch(async (e) => {
          console.warn(`⚠️ 审批恢复执行失败: ${resolution.flowId}`, e.message);
          try {
            await this.registry.updateFlow(resolution.flowId, {
              status: TASKFLOW_STATUS.FAILED,
              errorCategory: TASKFLOW_ERROR_CATEGORY.RECOVERY_FAILURE,
              currentStep: resolution.stepId
            });
          } catch (updateErr) {
            console.warn(`⚠️ 无法更新失败状态: ${resolution.flowId}`, updateErr.message);
          }
        });
      }
    }

    return resolution;
  }

  async _executeParallel(step, context, previousResults) {
    const branches = step.branches || step.steps || [];

    if (branches.length === 0) {
      return { type: 'parallel', branches: [], completed: true };
    }

    const concurrency = step.concurrency || step.maxConcurrency || MAX_PARALLEL_CONCURRENCY;
    console.log(`并行执行 ${branches.length} 个分支 (并发上限: ${concurrency})`);

    const results = new Array(branches.length);
    let currentIndex = 0;

    const executeOne = async (idx, branch) => {
      const branchStep = typeof branch === 'string' ? this._parseStep(branch) : branch;
      if (!branchStep) {
        results[idx] = { index: idx, status: 'skipped' };
        return;
      }
      try {
        const result = await this._executeStep(branchStep, context, previousResults);
        results[idx] = { index: idx, status: 'fulfilled', result };
      } catch (error) {
        results[idx] = { index: idx, status: 'rejected', error: error.message };
      }
    };

    const workers = [];
    const workerCount = Math.min(concurrency, branches.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push((async () => {
        while (currentIndex < branches.length) {
          const idx = currentIndex++;
          await executeOne(idx, branches[idx]);
        }
      })());
    }

    await Promise.all(workers);

    return {
      type: 'parallel',
      concurrency,
      branches: results
    };
  }

  async _executeSequence(step, context, previousResults) {
    const subSteps = step.steps || [];
    if (subSteps.length === 0) {
      return { type: 'sequence', results: [], completed: true };
    }

    console.log(`📦 顺序执行 ${subSteps.length} 个子步骤`);

    const subResults = {};
    for (let i = 0; i < subSteps.length; i++) {
      const subStep = this._parseStep(subSteps[i]);
      if (!subStep) continue;

      const subStepId = `sub_${i}`;
      const result = await this._executeStep(subStep, context, { ...previousResults, ...subResults });
      subResults[subStepId] = result;
    }

    return {
      type: 'sequence',
      results: subResults,
      completed: true
    };
  }

  async _executeLoop(step, context, previousResults) {
    const mode = step.loopMode || step.mode || TASKFLOW_LOOP_MODE.FIXED;
    const loopSteps = step.steps || [];
    const loopResults = [];
    const maxIterations = step.maxIterations || 100;

    if (mode === TASKFLOW_LOOP_MODE.FIXED) {
      const count = Math.min(step.count || 1, maxIterations);
      for (let i = 0; i < count; i++) {
        for (const subStepDef of loopSteps) {
          const subStep = typeof subStepDef === 'string' ? this._parseStep(subStepDef) : subStepDef;
          if (!subStep) continue;
          const result = await this._executeStep(subStep, context, previousResults);
          loopResults.push({ iteration: i, result });
        }
      }
      if (step.count > maxIterations) {
        console.warn(`Loop FIXED count ${step.count} exceeds maxIterations ${maxIterations}, capped`);
      }
    } else if (mode === TASKFLOW_LOOP_MODE.CONDITION) {
      let iteration = 0;
      const condition = step.condition;

      while (iteration < maxIterations) {
        let shouldContinue = false;

        if (typeof condition === 'function') {
          shouldContinue = condition({ ...context, iteration }, previousResults);
        } else if (typeof condition === 'string') {
          try {
            const evalResult = this._safeEvalExpression(condition, { ...context, iteration }, previousResults);
            shouldContinue = !!evalResult;
          } catch (e) {
            console.warn(`Loop condition evaluation failed: ${condition}`, e.message);
            shouldContinue = false;
          }
        } else if (typeof condition === 'object' && condition !== null) {
          shouldContinue = this._evaluateStructuredCondition(condition, { ...context, iteration }, previousResults);
        } else {
          shouldContinue = false;
        }

        if (!shouldContinue) break;

        for (const subStepDef of loopSteps) {
          const subStep = typeof subStepDef === 'string' ? this._parseStep(subStepDef) : subStepDef;
          if (!subStep) continue;
          const result = await this._executeStep(subStep, context, previousResults);
          loopResults.push({ iteration, result });
          if (result && result.stepId) {
            previousResults[result.stepId] = result;
          }
        }
        iteration++;
      }

      if (iteration >= maxIterations && loopSteps.length > 0) {
        console.warn(`Loop CONDITION exceeded maxIterations ${maxIterations}, stopped`);
      }
    } else if (mode === TASKFLOW_LOOP_MODE.COLLECTION) {
      const collection = step.collection || step.items || [];
      const effectiveCount = Math.min(collection.length, maxIterations);
      for (let i = 0; i < effectiveCount; i++) {
        const item = collection[i];
        const loopContext = { ...context, currentItem: item, currentIndex: i };
        for (const subStepDef of loopSteps) {
          const subStep = typeof subStepDef === 'string' ? this._parseStep(subStepDef) : subStepDef;
          if (!subStep) continue;
          const result = await this._executeStep(subStep, loopContext, previousResults);
          loopResults.push({ iteration: i, item, result });
        }
      }
      if (collection.length > maxIterations) {
        console.warn(`Loop COLLECTION length ${collection.length} exceeds maxIterations ${maxIterations}, capped`);
      }
    }

    return {
      type: 'loop',
      mode,
      iterations: loopResults.length,
      results: loopResults,
      completed: true
    };
  }

  async _executeLlm(step, context, previousResults) {
    if (!this.llmProvider) {
      throw new Error('LLM provider not configured');
    }

    const prompt = this._resolveTemplate(step.prompt, context, previousResults);
    const options = step.options || {};

    console.log(`🤖 执行 LLM 调用: ${prompt.substring(0, 100)}...`);

    const result = await this.llmProvider(prompt, options);

    return {
      type: 'llm',
      prompt: prompt.substring(0, 200),
      result
    };
  }

  async _executeSubAgent(step, context, previousResults) {
    const agent = step.agent;
    const goal = this._resolveTemplate(step.goal || step.prompt || '', context, previousResults);

    console.log(`🤖 启动子代理: ${agent}, 目标: ${goal.substring(0, 100)}`);

    if (this.skillExecutor) {
      try {
        const result = await this.skillExecutor(`${agent}_agent`, {
          goal,
          parentContext: context,
          previousResults
        });

        return {
          type: 'sub_agent',
          agent,
          goal,
          result
        };
      } catch (e) {
        console.warn(`⚠️ 子代理 ${agent} 执行失败:`, e.message);
        throw e;
      }
    }

    throw new Error(`Sub-agent ${agent} execution requires skill executor`);
  }

  /**
   * _executeGate — 质量门禁执行器
   *
   * 检查 pipeline 模板中定义的 qualityGates 是否满足。
   * 门禁条件由 pipeline 模板中的 condition 字段定义。
   *
   * 内置条件（condition 自动检测）：
   *   - plan_approved / spec_approved / refactor_plan_approved: 检查 planner/sub-agent 步骤的输出是否包含"批准/方案/计划"等关键词
   *   - code_quality_pass / ui_review_pass: 检查 critic 步骤的输出是否通过了审查
   *   - tests_pass / tests_still_pass / fix_confirmed: 检查技能测试步骤是否执行成功
   *   - root_cause_found: 检查是否找到根因
   *   - improvement_confirmed: 检查是否有质量/性能提升描述
   */
  async _executeGate(step, context, previousResults) {
    const condition = step.condition || step.check || '';
    const description = step.description || `检查门禁条件: ${condition}`;
    console.log(`🔒 质量门禁: ${description}`);

    if (!condition) {
      console.warn('⚠️ 门禁步骤缺少 condition 字段，跳过');
      return { type: 'gate', condition: 'skipped', passed: true, note: '无 condition，自动通过' };
    }

    // 收集所有前置步骤的输出来判断条件是否满足
    const allOutputs = [];
    if (previousResults) {
      for (const key of Object.keys(previousResults)) {
        const val = previousResults[key];
        if (typeof val === 'string') allOutputs.push(val);
        else if (val && typeof val === 'object') {
          allOutputs.push(JSON.stringify(val));
          if (val.result) allOutputs.push(typeof val.result === 'string' ? val.result : JSON.stringify(val.result));
          if (val.content) allOutputs.push(val.content);
          if (val.output) allOutputs.push(val.output);
        }
      }
    }
    const combinedOutput = allOutputs.join(' ').toLowerCase();

    /**
     * 门禁判断逻辑：
     * 每个条件类型对应一个检测范围。passAll 为 true 时，
     * 只要一个条件满足就通过（适用于宽松门禁）。
     * passAll 为 false 时，所有条件都必须满足。
     */
    const checks = {
      plan_approved: /(?:方案|plan|计划|架构|设计).*(?:通过|批准|approved|confirmed|ok|确认)/i.test(combinedOutput),
      spec_approved: /(?:规范|spec|规格|specification|设计).*(?:通过|批准|approved|ok)/i.test(combinedOutput),
      refactor_plan_approved: /(?:重构|refactor).*(?:方案|计划|范围|plan|scope).*(?:通过|确定|approved|confirmed)/i.test(combinedOutput),
      code_quality_pass: /(?:通过|pass|good|clean|没问题|标准|quality).*(?:审查|review|code)/i.test(combinedOutput) || !/(?:失败|问题|错误|warning|error|issue)/i.test(combinedOutput),
      ui_review_pass: /(?:一致|匹配|符合|正确|good|pass|通过).*(?:设计|design|ui|布局|layout)/i.test(combinedOutput),
      tests_pass: context.success !== false || !/(?:失败|错误|fail|error)/i.test(combinedOutput) || /(?:通过|pass|success|完成|done)/i.test(combinedOutput),
      tests_still_pass: !/(?:失败|broken|regression|不通过|出错)/i.test(combinedOutput),
      fix_confirmed: /(?:修复|fix|fixed|解决|resolved|confirmed|验证通过).*(?:bug|问题|issue|测试|test)/i.test(combinedOutput) || /(?:测试通过|pass.*test|verified)/i.test(combinedOutput),
      root_cause_found: /(?:根因|root.cause|原因|cause|because|定位|identify|found)/i.test(combinedOutput),
      improvement_confirmed: /(?:提升|improve|更好|better|减少|reduce|更快|faster|cleaner|可维护)/i.test(combinedOutput),
    };

    // 通配：如果 condition 直接匹配到 checks 中的 key，使用对应结果
    const passed = checks[condition] !== undefined ? checks[condition] : true;

    if (!passed) {
      console.warn(`❌ 质量门禁未通过: ${description} (condition: ${condition})`);
      return {
        type: 'gate',
        condition,
        passed: false,
        description,
        note: `门禁条件 "${condition}" 未满足。前置步骤输出中未检测到通过信号。`,
        // 提供建议帮助 pipeline 继续
        suggestions: [
          '检查上一个步骤是否正确执行',
          '尝试回退并调整方案',
          '如果门禁过于严格，可以修改 pipeline 模板的 qualityGates 配置',
        ],
      };
    }

    console.log(`✅ 质量门禁通过: ${description}`);
    return {
      type: 'gate',
      condition,
      passed: true,
      description,
      note: `门禁条件 "${condition}" 已满足`,
    };
  }

  _resolveTemplate(template, context, _previousResults) {
    if (!template || typeof template !== 'string') return template;

    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
      const parts = path.split('.');
      let value = context;
      for (const part of parts) {
        if (value && typeof value === 'object') {
          value = value[part];
        } else {
          return match;
        }
      }
      return value !== undefined ? String(value) : match;
    });
  }

  async _executeWebhook(step, context) {
    const url = step.url;

    const validation = this._validateWebhookUrl(url);
    if (!validation.valid) {
      return {
        type: 'webhook',
        url,
        error: validation.reason
      };
    }

    console.log(`🌐 发送 Webhook: ${url}`);

    try {
      const http = require('http');
      const https = require('https');
      const dns = require('dns');
      const client = url.startsWith('https') ? https : http;

      const parsedUrl = new URL(url);
      const resolvedIps = await new Promise((resolve, reject) => {
        dns.lookup(parsedUrl.hostname, { all: true }, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses.map(a => a.address));
        });
      });

      for (const ip of resolvedIps) {
        if (this._isBlockedIp(ip)) {
          return {
            type: 'webhook',
            url,
            error: `DNS 解析后目标 IP 被禁止: ${ip}`
          };
        }
      }

      const result = await new Promise((resolve, reject) => {
        const req = client.request(url, {
          method: step.method || 'POST',
          timeout: step.timeout || 10000,
          headers: {
            'Content-Type': 'application/json',
            ...(step.headers || {})
          },
          lookup: (hostname, opts, cb) => {
            cb(null, resolvedIps[0], 4);
          }
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            resolve({ statusCode: res.statusCode, body: body.substring(0, 1000) });
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
        req.end(JSON.stringify(step.body || context));
      });

      return {
        type: 'webhook',
        url,
        result
      };
    } catch (error) {
      console.warn(`⚠️ Webhook 执行失败: ${url}`, error.message);
      return {
        type: 'webhook',
        url,
        error: error.message
      };
    }
  }

  _validateWebhookUrl(url) {
    if (!url || typeof url !== 'string') {
      return { valid: false, reason: 'Webhook URL 为空或格式无效' };
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { valid: false, reason: 'Webhook URL 格式无效' };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, reason: `不支持的协议: ${parsed.protocol}` };
    }

    const hostname = parsed.hostname.toLowerCase();
    const blockedHosts = [
      'localhost', '127.0.0.1', '0.0.0.0', '::1',
      '169.254.169.254', 'metadata.google.internal',
      'metadata.azure.com'
    ];
    if (blockedHosts.includes(hostname)) {
      return { valid: false, reason: `目标地址被禁止: ${hostname}` };
    }

    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(hostname)) {
      return { valid: false, reason: `内网地址被禁止: ${hostname}` };
    }

    if (this._webhookAllowList && this._webhookAllowList.length > 0) {
      const allowed = this._webhookAllowList.some(pattern => {
        if (pattern.startsWith('*.')) {
          return hostname.endsWith(pattern.slice(1)) || hostname === pattern.slice(2);
        }
        return hostname === pattern;
      });
      if (!allowed) {
        return { valid: false, reason: `域名不在白名单中: ${hostname}` };
      }
    }

    return { valid: true };
  }

  _isBlockedIp(ip) {
    const blockedIps = ['127.0.0.1', '0.0.0.0', '::1', '169.254.169.254'];
    if (blockedIps.includes(ip)) return true;

    if (/^10\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^fc00:/i.test(ip)) return true;
    if (/^fe80:/i.test(ip)) return true;

    return false;
  }

  _resolveParams(params, context, previousResults) {
    if (!params) return {};

    if (typeof params === 'string') {
      const parsed = {};
      const pairs = params.split('&');
      for (const pair of pairs) {
        const [key, value] = pair.split('=').map(s => s.trim());
        if (key) {
          parsed[key] = value || '';
        }
      }
      return parsed;
    }

    const resolved = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && value.startsWith('$')) {
        const ref = value.slice(1);

        if (ref.includes('.')) {
          const [stepId, field] = ref.split('.');
          if (previousResults[stepId] && previousResults[stepId].result) {
            resolved[key] = previousResults[stepId].result[field];
          }
        } else if (context[ref] !== undefined) {
          resolved[key] = context[ref];
        } else {
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  async cancelFlow(flowId) {
    await this._ensureInitialized();

    const flow = await this.registry.getFlow(flowId);
    if (!flow) {
      throw new Error(`Flow not found: ${flowId}`);
    }

    await this.registry.cancelFlow(flowId);

    await this.store.addHistory(flowId, 'cancelled', {
      previousStatus: flow.status
    });

    this._broadcast('taskflow_cancelled', { flowId, timestamp: Date.now() });

    console.log(`🚫 TaskFlow ${flowId} 已取消`);
  }

  async getFlowStatus(flowId) {
    await this._ensureInitialized();

    const flow = await this.registry.getFlow(flowId);
    if (!flow) {
      return null;
    }

    const tasks = await this.registry.getFlowTasks(flowId);
    const steps = this._ensureSteps(this._resolveSteps(flow), flow.goal);

    let progress = 0;
    if (steps.length > 0) {
      const completedCount = tasks.filter(t => t.status === TASKFLOW_STEP_STATUS.COMPLETED).length;
      progress = Math.round((completedCount / steps.length) * 100);
    }

    return {
      flow,
      tasks,
      isExecuting: this.executingFlows.has(flowId),
      progress,
      stepCount: steps.length,
      completedStepCount: tasks.filter(t => t.status === TASKFLOW_STEP_STATUS.COMPLETED).length
    };
  }

  async recoverLostFlows() {
    await this._ensureInitialized();

    const lostFlows = await this.registry.detectLostFlows();
    const recovered = [];

    for (const flow of lostFlows) {
      if (this.executingFlows.has(flow.flowId)) continue;

      console.log(`🔄 恢复丢失的 TaskFlow: ${flow.flowId}`);

      try {
        await this.registry.recoverLostFlow(flow.flowId);

        this.executeFlow(flow.flowId, { originalMessage: flow.goal }).catch(e => {
          console.warn(`⚠️ 恢复执行 TaskFlow 失败: ${flow.flowId}`, e.message);
        });

        recovered.push(flow.flowId);
        this._metrics.recoveredFlows++;
      } catch (e) {
        console.warn(`⚠️ 恢复 TaskFlow 失败: ${flow.flowId}`, e.message);
      }
    }

    if (recovered.length > 0) {
      this._broadcast('taskflow_recovered', {
        count: recovered.length,
        flowIds: recovered,
        timestamp: Date.now()
      });
      console.log(`✅ 已恢复 ${recovered.length} 个丢失的 TaskFlow`);
    }

    return recovered;
  }

  async listPendingApprovals(flowId) {
    await this._ensureInitialized();
    return this.approvalGate.listPendingApprovals(flowId);
  }

  async resumeFlow(resumeToken, approvalResult = {}) {
    await this._ensureInitialized();

    const parsed = this.approvalGate.parseResumeToken(resumeToken);
    if (!parsed) {
      throw new Error('无效的恢复令牌');
    }

    const { flowId, stepId, approvalId } = parsed;

    const approval = await this.approvalGate.getApproval(approvalId);
    if (!approval) {
      throw new Error(`审批记录不存在: ${approvalId}`);
    }

    if (approval.status !== TASKFLOW_APPROVAL_STATUS.PENDING) {
      throw new Error(`审批已处理: ${approval.status}`);
    }

    if (approval.expiresAt && Date.now() > approval.expiresAt) {
      await this.approvalGate.expireApproval(approvalId);
      throw new Error('审批已过期');
    }

    await this.approvalGate.resolve(approvalId, approvalResult.approved !== false, approvalResult);

    if (approvalResult.approved !== false) {
      const taskId = `${flowId}_${stepId}`;
      await this.store.saveTask({
        taskId,
        flowId,
        stepId,
        status: TASKFLOW_STEP_STATUS.COMPLETED,
        result: { type: 'approval', approved: true, approvalId },
        completedAt: Date.now()
      });

      await this.registry.updateFlow(flowId, {
        status: TASKFLOW_STATUS.QUEUED
      });

      this._broadcast('taskflow_approval_resolved', {
        flowId,
        stepId,
        approvalId,
        approved: true,
        timestamp: Date.now()
      });

      this._broadcast('taskflow_resumed', {
        flowId,
        resumedFromStep: stepId,
        timestamp: Date.now()
      });

      this.executeFlow(flowId, { resumedFromStep: stepId }).catch(e => {
        console.warn(`⚠️ 恢复执行 TaskFlow 失败: ${flowId}`, e.message);
      });
    } else {
      this._broadcast('taskflow_approval_resolved', {
        flowId,
        stepId,
        approvalId,
        approved: false,
        timestamp: Date.now()
      });
    }

    return {
      flowId,
      stepId,
      approvalId,
      approved: approvalResult.approved !== false,
      resumed: approvalResult.approved !== false
    };
  }

  async runFlow(flowId, context = {}) {
    return this.executeFlow(flowId, context);
  }

  async createFlow(params) {
    await this._ensureInitialized();
    return this.registry.createFlow(params);
  }

  _getCheckpointStore() {
    if (!this._checkpointStore) {
      const path = require("path");
      const { DATA_DIR } = require("../core/config");
      const { CheckpointStore } = require("../core/checkpoint-store");
      this._checkpointStore = new CheckpointStore({ dir: path.join(DATA_DIR, "checkpoints") });
    }
    return this._checkpointStore;
  }

  async _ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async close() {
    if (this.approvalGate) {
      this.approvalGate.stopCleanup();
    }
    await this.registry.close();
    this.initialized = false;
  }
}

let runtimeInstance = null;

function getTaskFlowRuntime() {
  if (!runtimeInstance) {
    runtimeInstance = new TaskFlowRuntime();
  }
  return runtimeInstance;
}

module.exports = {
  TaskFlowRuntime,
  getTaskFlowRuntime,
  FlowEngine,
  BUILTIN_FLOWS
};
