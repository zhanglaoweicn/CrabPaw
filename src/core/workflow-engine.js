/**
 * Workflow Engine v2.0
 *
 * Executes multi-step workflows with condition/loop/parallel actions.
 * Produces structured execution records for Harness observability.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const ACTION_TIMEOUT = 300000;
const LOOP_DETECTION_WINDOW = 5;
const LOOP_DETECTION_THRESHOLD = 3;

class WorkflowEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxHistory = options.maxHistory || 100;
    this._executionHistory = [];
    // S2: 工作流存储 Map——此前不存在,而 handler/CLI 调用 listWorkflows/getWorkflow/
    // createWorkflow/saveWorkflow/deleteWorkflow/calculateROI/getStats/getWorkflowHistory
    // getExecutionHistory 等 9 个方法(全缺失)→ /api/workflows 全链路 100% 崩溃。
    // skill-flow.js L410/L428 也直接 workflowEngine.workflows.set/delete,故必须为 Map。
    this.workflows = new Map();
    this._storePath = this._resolveStorePath();
    this._loaded = false;
  }

  _resolveStorePath() {
    try {
      const { CRABPAW_HOME } = require('./path-utils');
      if (CRABPAW_HOME) return path.join(CRABPAW_HOME, 'workflows.json');
    } catch (e) {
      /* CRABPAW_HOME 不可用时退回内存持久化 */
      console.warn('[workflow-engine.js] 空 catch 补日志:', e && e.message);
    }

    return null;
  }

  _persist() {
    if (!this._storePath) return;
    try {
      fs.writeFileSync(this._storePath, JSON.stringify(Array.from(this.workflows.values()), null, 2), 'utf-8');
    } catch (e) {
      console.warn('[WorkflowEngine] 持久化失败:', e.message);
    }
  }

  _load() {
    if (this._loaded || !this._storePath || !fs.existsSync(this._storePath)) {
      this._loaded = true;
      return;
    }
    try {
      const arr = JSON.parse(fs.readFileSync(this._storePath, 'utf-8'));
      for (const wf of arr) {
        if (wf && wf.id) this.workflows.set(wf.id, wf);
      }
    } catch (e) {
      console.warn('[WorkflowEngine] 加载已存工作流失败:', e.message);
    }
    this._loaded = true;
  }

  // S2: 初始化——加载已持久化工作流(此前 handler 调用 initialize() 直接崩)
  async initialize() {
    this._load();
    return { ok: true, count: this.workflows.size };
  }

  // S2: 列表(此前 handler 调用 listWorkflows() 崩)
  listWorkflows() {
    this._load();
    return Array.from(this.workflows.values());
  }

  // S2: 单条查询
  getWorkflow(workflowId) {
    this._load();
    return this.workflows.get(workflowId) || null;
  }

  // S2: 创建(生成 id + metadata)
  createWorkflow(data = {}) {
    if (!data.name || !String(data.name).trim()) throw new Error('工作流名称不能为空');
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const workflow = {
      id,
      name: String(data.name).trim().slice(0, 100),
      description: data.description || '',
      trigger: data.trigger || { type: 'manual' },
      conditions: data.conditions || [],
      actions: data.actions || data.steps || [],
      errorHandling: data.errorHandling || {},
      tags: data.tags || [],
      stats: { totalRuns: 0, successRuns: 0, totalDuration: 0, lastRunAt: null },
      metadata: { createdAt: now, updatedAt: now },
    };
    this.workflows.set(id, workflow);
    this._persist();
    return workflow;
  }

  // S2: 保存(更新已存在的工作流)
  async saveWorkflow(workflow) {
    if (!workflow || !workflow.id) throw new Error('工作流缺少 id');
    if (!this.workflows.has(workflow.id)) throw new Error(`工作流不存在: ${workflow.id}`);
    const existing = this.workflows.get(workflow.id);
    workflow.metadata = { ...(existing?.metadata || {}), ...(workflow.metadata || {}), updatedAt: new Date().toISOString() };
    workflow.stats = existing?.stats || workflow.stats || { totalRuns: 0, successRuns: 0, totalDuration: 0, lastRunAt: null };
    this.workflows.set(workflow.id, workflow);
    this._persist();
    return workflow;
  }

  // S2: 删除
  async deleteWorkflow(workflowId) {
    this._load();
    const existed = this.workflows.delete(workflowId);
    this._persist();
    return { ok: true, deleted: existed };
  }

  // S2: 统计
  getStats() {
    const list = this.listWorkflows();
    const totalRuns = list.reduce((s, w) => s + (w.stats?.totalRuns || 0), 0);
    return {
      total: list.length,
      running: 0,
      completed: totalRuns,
      failed: 0,
      avgDuration: 0,
      workflows: list.map(w => ({ id: w.id, name: w.name, status: 'idle', runs: w.stats?.totalRuns || 0 })),
    };
  }

  // S2: ROI(基于执行历史,简单实现——耗时/运行次数维度的投入产出示意)
  calculateROI(workflowId) {
    this._load();
    const wf = this.workflows.get(workflowId);
    if (!wf) return null;
    const runs = this._executionHistory.filter(h => h.workflowId === workflowId);
    const success = runs.filter(h => h.status === 'completed').length;
    const totalMs = runs.reduce((s, h) => s + ((h.endTime || h.startTime) - h.startTime), 0);
    return {
      workflowId,
      totalRuns: runs.length,
      successRate: runs.length > 0 ? success / runs.length : 0,
      avgDurationMs: runs.length > 0 ? totalMs / runs.length : 0,
      estimatedSavingsHours: 0,
    };
  }

  // S2: 单工作流执行历史
  getWorkflowHistory(workflowId, limit = 50) {
    return this._executionHistory
      .filter(h => h.workflowId === workflowId)
      .slice(-limit)
      .map(this._sanitizeExecution);
  }

  // S2: 全局执行历史
  getExecutionHistory({ limit = 100, days, status } = {}) {
    let list = this._executionHistory;
    if (days) {
      const cutoff = Date.now() - days * 86400000;
      list = list.filter(h => h.startTime >= cutoff);
    }
    if (status) list = list.filter(h => h.status === status);
    return list.slice(-limit).map(this._sanitizeExecution);
  }

  _sanitizeExecution(h) {
    return { id: h.id, workflowId: h.workflowId, status: h.status, startTime: h.startTime, endTime: h.endTime, duration: (h.endTime || h.startTime) - h.startTime };
  }

  // ---- Public API ----

  async execute(workflow, input, context = {}) {
    // S2: 字符串 workflowId 时先解析为对象——旧实现直接返回"completed"假执行(不真正跑),
    // 且 handler 传 string 时从不解析,永远假完成。
    if (typeof workflow === 'string') {
      this._load();
      const resolved = this.workflows.get(workflow);
      if (!resolved) {
        throw new Error(`工作流不存在: ${workflow}`);
      }
      workflow = resolved;
    }
    const execution = {
      id: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      workflowId: workflow.id,
      startTime: Date.now(),
      status: 'running',
      input,
      context: { ...context },
      errors: [],
      timeline: [],
    };

    try {

      const conditionsMet = await this._evaluateConditions(workflow.conditions, execution.context);
      if (!conditionsMet) {
        execution.status = 'skipped';
        execution.endTime = Date.now();
        this._saveExecutionHistory(execution);
        this.emit('workflow:skipped', { executionId: execution.id, workflowId: workflow.id });
        return execution;
      }

      const result = await this._executeActions(workflow.actions, execution, context);
      execution.status = 'completed';
      execution.endTime = Date.now();
      execution.result = result;

      if (workflow.stats) {
        workflow.stats.totalRuns = (workflow.stats.totalRuns || 0) + 1;
        workflow.stats.successRuns = (workflow.stats.successRuns || 0) + 1;
        workflow.stats.totalDuration = (workflow.stats.totalDuration || 0) + (execution.endTime - execution.startTime);
        workflow.stats.lastRunAt = new Date().toISOString();
      }

      this._saveExecutionHistory(execution);
      this.emit('workflow:completed', {
        executionId: execution.id,
        workflowId: workflow.id,
        duration: execution.endTime - execution.startTime,
      });

      return execution;
    } catch (error) {
      execution.status = 'failed';
      execution.endTime = Date.now();
      execution.errors.push({ error: error.message, stack: error.stack });
      this._saveExecutionHistory(execution);
      this.emit('workflow:failed', { executionId: execution.id, workflowId: execution.workflowId, error: error.message });
      throw error;
    }
  }

  // ---- Suggestion Mode (no side effects) ----

  async suggest(workflow, input, context = {}) {
    const plan = {
      workflowId: typeof workflow === 'string' ? workflow : (workflow && workflow.id),
      preConditionsMet: null,
      steps: [],
      totalSteps: 0,
      hasConditions: false,
      hasLoops: false,
      hasParallel: false,
      sideEffects: [],
      generatedAt: Date.now(),
    };

    if (typeof workflow === 'string') {
      plan.preConditionsMet = null;
      plan.note = 'unresolved workflow ID — cannot determine steps';
      return plan;
    }

    if (!workflow || !workflow.actions) {
      plan.preConditionsMet = false;
      plan.note = 'invalid workflow or no actions';
      return plan;
    }

    const suggestContext = { ...context, input };
    const conditionsMet = await this._evaluateConditions(workflow.conditions, suggestContext);
    plan.preConditionsMet = conditionsMet;
    if (!conditionsMet) {
      plan.note = 'pre-conditions not met — workflow would be skipped';
      return plan;
    }

    await this._suggestActions(workflow.actions, plan, suggestContext, input);
    plan.totalSteps = plan.steps.length;
    return plan;
  }

  async _suggestActions(actions, plan, context, input) {
    if (!actions) return;
    for (const action of actions) {
      await this._suggestAction(action, plan, context, input);
    }
  }

  async _suggestAction(action, plan, context, input) {
    const step = {
      index: plan.steps.length,
      type: action.type,
      id: action.id || `${action.type}_${plan.steps.length}`,
      resolvedInput: action.input ? this._resolveVariables(action.input, context) : undefined,
    };

    switch (action.type) {
      case 'skill':
        step.skill = action.skill;
        plan.sideEffects.push(`skill:${action.skill}`);
        plan.steps.push(step);
        break;

      case 'tool':
        step.tool = action.tool;
        plan.sideEffects.push(`tool:${action.tool}`);
        plan.steps.push(step);
        break;

      case 'flow':
        step.flow = action.flow;
        plan.sideEffects.push(`flow:${action.flow}`);
        plan.steps.push(step);
        break;

      case 'parallel':
        plan.hasParallel = true;
        step.branches = (action.actions || []).length;
        step.substeps = [];
        if (action.actions) {
          for (const sub of action.actions) {
            const subPlan = { steps: [], sideEffects: [] };
            await this._suggestAction(sub, subPlan, context, input);
            step.substeps.push(subPlan.steps[0] || { type: sub.type, id: sub.id });
            plan.sideEffects.push(...subPlan.sideEffects);
          }
        }
        plan.steps.push(step);
        break;

      case 'condition': {
        plan.hasConditions = true;
        step.condition = action.condition;
        const result = await this._evaluateCondition(action.condition, context);
        step.expectedBranch = result ? 'then' : 'else';
        step.thenSteps = [];
        step.elseSteps = [];
        if (action.thenActions) {
          const thenPlan = { steps: [], sideEffects: [] };
          await this._suggestActions(action.thenActions, thenPlan, context, input);
          step.thenSteps = thenPlan.steps;
          plan.sideEffects.push(...thenPlan.sideEffects);
        }
        if (action.elseActions) {
          const elsePlan = { steps: [], sideEffects: [] };
          await this._suggestActions(action.elseActions, elsePlan, context, input);
          step.elseSteps = elsePlan.steps;
          plan.sideEffects.push(...elsePlan.sideEffects);
        }
        plan.steps.push(step);
        break;
      }

      case 'loop':
        plan.hasLoops = true;
        step.maxIterations = action.maxIterations || 10;
        step.breakCondition = action.breakCondition;
        step.loopBody = [];
        if (action.actions) {
          const bodyPlan = { steps: [], sideEffects: [] };
          await this._suggestActions(action.actions, bodyPlan, context, input);
          step.loopBody = bodyPlan.steps;
          plan.sideEffects.push(...bodyPlan.sideEffects);
        }
        plan.steps.push(step);
        break;

      case 'delay':
        step.delay = action.delay || 1000;
        plan.steps.push(step);
        break;

      case 'transform':
        step.transform = typeof action.transform === 'string' ? this._resolveVariables(action.transform, context) : undefined;
        plan.steps.push(step);
        break;

      default:
        step.skipped = true;
        step.reason = `unknown action type: ${action.type}`;
        plan.steps.push(step);
    }
  }

  // ---- Action Execution ----

  async _executeActions(actions, execution, context) {
    const results = [];
    let lastResult = execution.input;
    const stateFingerprints = [];

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const startTime = Date.now();
      const actionTimeout = action.timeout || ACTION_TIMEOUT;

      // Loop detection
      const fingerprint = this._computeStateFingerprint(action, lastResult);
      stateFingerprints.push(fingerprint);

      if (stateFingerprints.length >= LOOP_DETECTION_THRESHOLD) {
        const recentWindow = stateFingerprints.slice(-LOOP_DETECTION_WINDOW);
        const sameCount = recentWindow.filter(fp => fp === fingerprint).length;
        if (sameCount >= LOOP_DETECTION_THRESHOLD) {
          const loopError = new Error(
            `Loop detected: action ${action.id || i} fingerprint repeated ${sameCount} times in ${LOOP_DETECTION_WINDOW} steps`
          );
          loopError.code = 'LOOP_DETECTED';
          execution.errors.push({ actionId: action.id, error: loopError.message });
          execution.timeline.push({ actionId: action.id, status: 'loop_detected' });
          throw loopError;
        }
      }

      try {
        const result = await Promise.race([
          this._executeAction(action, execution, context, lastResult),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Action ${action.id || i} timeout (${actionTimeout}ms)`)), actionTimeout)
          ),
        ]);

        results.push({ actionId: action.id, success: true, result, duration: Date.now() - startTime });
        execution.context[action.outputKey] = result;
        execution.timeline.push({ actionId: action.id, status: 'success', duration: Date.now() - startTime });
        lastResult = result;
      } catch (error) {
        results.push({ actionId: action.id, success: false, error: error.message, duration: Date.now() - startTime });
        execution.errors.push({ actionId: action.id, error: error.message });
        execution.timeline.push({ actionId: action.id, status: 'failed', error: error.message });
        throw error;
      }
    }

    return results;
  }

  async _executeAction(action, execution, context, lastResult) {
    const input = this._resolveInput(action.input, execution.context, lastResult);
    const params = { ...action.params, input, data: input };

    switch (action.type) {
      case 'skill':
        return await this._executeSkill(action.skill, params, context);
      case 'tool':
        return await this._executeTool(action.tool, params, context);
      case 'flow':
        return await this.execute(action.flow, params, context);
      case 'parallel':
        return await this._executeParallel(action.actions, execution, context);
      case 'delay':
        await this._delay(action.delay || 1000);
        return { delayed: action.delay };
      case 'transform':
        return this._transformData(action.transform, execution.context);
      case 'condition':
        return await this._executeCondition(action, execution, context, lastResult);
      case 'loop':
        return await this._executeLoop(action, execution, context, lastResult);
      default:
        return { skipped: true, reason: `unknown action type: ${action.type}` };
    }
  }

  // ---- Skill/Tool Executors ----

  async _executeSkill(skillName, params, context) {
    if (context.skillExecutor) {
      return await context.skillExecutor(skillName, params);
    }
    return { mock: true, skill: skillName, params, data: { input: params?.input || params } };
  }

  async _executeTool(toolName, params, context) {
    if (context.toolExecutor) {
      return await context.toolExecutor(toolName, params);
    }
    return { mock: true, tool: toolName, params };
  }

  // ---- Parallel ----

  async _executeParallel(actions, execution, context) {
    const promises = (actions || []).map((action) =>
      Promise.resolve()
        .then(() => this._executeAction(action, execution, context, null))
        .then((value) => ({ status: 'fulfilled', value }))
        .catch((err) => {
          console.error('[workflow-engine] PARALLEL 分支失败:', err.message || err);
          return { status: 'rejected', reason: err.message || String(err) };
        })
    );
    return await Promise.all(promises); // allSettled 语义：单分支失败不整体抛
  }

  // ---- Condition ----

  async _executeCondition(action, execution, context, lastResult) {
    execution.errors = execution.errors || [];
    execution.timeline = execution.timeline || [];

    const conditionResult = await this._evaluateCondition(action.condition, {
      ...execution.context,
      lastResult,
      input: execution.input,
    });

    if (conditionResult) {
      if (action.thenActions && action.thenActions.length > 0) {
        return await this._executeActions(action.thenActions, execution, context);
      }
      return { condition: true, branch: 'then' };
    } else {
      if (action.elseActions && action.elseActions.length > 0) {
        return await this._executeActions(action.elseActions, execution, context);
      }
      return { condition: false, branch: 'else' };
    }
  }

  // ---- Loop ----

  async _executeLoop(action, execution, context, lastResult) {
    execution.errors = execution.errors || [];
    execution.timeline = execution.timeline || [];

    const maxIterations = action.maxIterations || 10;
    const results = [];
    let currentInput = lastResult;

    for (let i = 0; i < maxIterations; i++) {
      if (action.breakCondition) {
        const shouldBreak = await this._evaluateCondition(action.breakCondition, {
          ...execution.context,
          index: i,
          lastResult: currentInput,
        });
        if (shouldBreak) break;
      }

      const iterationResult = await this._executeActions(
        action.actions || [action],
        { ...execution, loopIndex: i },
        { ...context, loopIndex: i }
      );

      results.push(iterationResult);

      if (Array.isArray(iterationResult) && iterationResult.length > 0) {
        currentInput = iterationResult[iterationResult.length - 1].result;
      }

      execution.context._loopIteration = i + 1;
    }

    return { loop: true, iterations: results.length, results };
  }

  // ---- Condition Evaluation ----

  async _evaluateConditions(conditions, context) {
    if (!conditions || conditions.length === 0) return true;
    for (const condition of conditions) {
      const result = await this._evaluateCondition(condition, context);
      if (!result) return false;
    }
    return true;
  }

  async _evaluateCondition(condition, context) {
    switch (condition.type) {
      case 'simple':
        return this._evaluateSimpleCondition(condition, context);
      case 'expression':
        return this._evaluateExpressionCondition(condition, context);
      case 'and':
        for (const c of condition.and || []) {
          if (!(await this._evaluateCondition(c, context))) return false;
        }
        return true;
      case 'or':
        for (const c of condition.or || []) {
          if (await this._evaluateCondition(c, context)) return true;
        }
        return false;
      default:
        return true;
    }
  }

  _evaluateSimpleCondition(condition, context) {
    const { field, operator, value } = condition;
    const fieldValue = this._resolveValue(field, context);

    switch (operator) {
      case 'eq':
      case 'equals':
        return fieldValue === value;
      case 'neq':
      case 'not_equals':
        return fieldValue !== value;
      case 'contains':
        return String(fieldValue).includes(value);
      case 'not_contains':
        return !String(fieldValue).includes(value);
      case 'gt':
      case 'greater_than':
        return fieldValue > value;
      case 'gte':
      case 'greater_than_or_equal':
        return fieldValue >= value;
      case 'lt':
      case 'less_than':
        return fieldValue < value;
      case 'lte':
      case 'less_than_or_equal':
        return fieldValue <= value;
      case 'is_empty':
        return !fieldValue;
      case 'is_not_empty':
        return !!fieldValue;
      case 'matches': {
        // 2026-08-15 P2-6: value 来自用户定义工作流 → 防 ReDoS。
        // 1) 长度上限 200; 2) 嵌套量词启发式拒绝 (a+)+ / (.*)+ / a++ / a*+ 类灾难性回溯;
        // 3) 编译 try/catch 兜底。超出/命中一律判 false + warn(不抛,条件评估失败即不匹配)。
        const pattern = String(value);
        if (pattern.length > 200) {
          console.warn('[workflow-engine] matches 正则超长(>200)已拒绝:', pattern.slice(0, 80) + '...');
          return false;
        }
        if (/\(\s*[^()]*[+*]\s*\)\s*[+*]|\+\+|\*\+/.test(pattern)) {
          console.warn('[workflow-engine] matches 正则疑似灾难性回溯(嵌套量词)已拒绝:', pattern.slice(0, 80));
          return false;
        }
        try {
          return new RegExp(pattern).test(String(fieldValue));
        } catch (e) {
          console.warn('[workflow-engine] matches 正则编译失败:', e?.message || e, '| pattern:', pattern.slice(0, 80));
          return false;
        }
      }
      default:
        return false;
    }
  }

 _evaluateExpressionCondition(condition, context) {
   try {
     const expr = condition.expression;
     if (expr === 'true') return true;
     if (expr === 'false') return false;
      return this._safeEval(expr, context);
   } catch (e) {
     console.warn('[workflow-engine] 表达式条件求值失败:', e?.message || e, '| expr:', String(condition?.expression).slice(0, 120));
     return false;
   }
 }

  /**
   * Safely evaluate boolean expressions without new Function().
   * Supports: === !== == != > < >= <= && || ! () and context variable references.
   *
   * @deprecated 2026-08-15 P2-4: 求值器已收敛到 security/safe-expression.js
   * (全库唯一实现,_safeEval 为其导出别名)。本方法保留仅为兼容 CLI 文档
   * (AGENTS.md 契约 "use _safeEval() from workflow-engine.js")与旧引用,
   * 内部直接转发,不再维护本地解析器(_tokenize 保留仅供旧代码参考,不再被调用)。
   */
  _safeEval(expr, context) {
    const { _safeEval: safeEvalImpl } = require('./security/safe-expression');
    return safeEvalImpl(expr, context);
  }

  _tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      if (/\s/.test(expr[i])) { i++; continue; }
      if ('()!'.includes(expr[i])) { tokens.push({ type: 'op', value: expr[i++] }); continue; }
      if (expr[i] === '=' && expr[i+1] === '=' && expr[i+2] === '=') { tokens.push({ type: 'op', value: '===' }); i += 3; continue; }
      if (expr[i] === '!' && expr[i+1] === '=' && expr[i+2] === '=') { tokens.push({ type: 'op', value: '!==' }); i += 3; continue; }
      if (expr[i] === '&' && expr[i+1] === '&') { tokens.push({ type: 'op', value: '&&' }); i += 2; continue; }
      if (expr[i] === '|' && expr[i+1] === '|') { tokens.push({ type: 'op', value: '||' }); i += 2; continue; }
      if ('><='.includes(expr[i])) {
        if (expr[i+1] === '=') { tokens.push({ type: 'op', value: expr[i] + '=' }); i += 2; continue; }
        tokens.push({ type: 'op', value: expr[i++] }); continue;
      }
      if (expr[i] === "'" || expr[i] === '"') {
        const quote = expr[i++]; let s = '';
        while (i < expr.length && expr[i] !== quote) { s += expr[i++]; }
        i++; tokens.push({ type: 'str', value: s }); continue;
      }
      if (/[\d.]/.test(expr[i])) {
        let n = '';
        while (i < expr.length && /[\d.]/.test(expr[i])) { n += expr[i++]; }
        tokens.push({ type: 'num', value: parseFloat(n) }); continue;
      }
      if (/[a-zA-Z_]/.test(expr[i])) {
        let id = '';
        while (i < expr.length && /[a-zA-Z0-9_.]/.test(expr[i])) { id += expr[i++]; }
        if (id === 'true') { tokens.push({ type: 'bool', value: true }); continue; }
        if (id === 'false') { tokens.push({ type: 'bool', value: false }); continue; }
        if (id === 'null') { tokens.push({ type: 'null', value: null }); continue; }
        tokens.push({ type: 'var', value: id }); continue;
      }
      throw Error(`Unexpected char: ${expr[i]}`);
    }
    return tokens;
  }

  // ---- Helpers ----

  _resolveValue(key, context) {
    const keys = key.split('.');
    let value = context;
    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = value[k];
      } else {
        return undefined;
      }
    }
    return value;
  }

  _resolveInput(input, context, lastResult) {
    if (!input) return lastResult;
    return this._resolveVariables(input, context);
  }

  _resolveVariables(template, context) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const value = this._resolveValue(key.trim(), context);
      return value !== undefined ? value : match;
    });
  }

  _transformData(transform, context) {
    if (typeof transform === 'function') {
      return transform(context);
    }
    if (typeof transform === 'string') {
      return this._resolveVariables(transform, context);
    }
    return transform;
  }

  _computeStateFingerprint(action, lastResult) {
    return JSON.stringify({ id: action.id, type: action.type, hash: typeof lastResult === 'object' ? JSON.stringify(lastResult).length : lastResult });
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _saveExecutionHistory(execution) {
    this._executionHistory.push(execution);
    if (this._executionHistory.length > this.maxHistory) {
      this._executionHistory.shift();
    }
  }
}

module.exports = { WorkflowEngine };
