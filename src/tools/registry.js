/**
 * Tool Registry - 中心化工具注册表
 * 
 * 工具注册中心 — 统一管理所有工具的注册、查找和调用。
 * - 无循环依赖
 * - 支持 toolset 分组
 * - 可用性检查 (checkFn)
 * - 自动生成 OpenAI 格式 schema
 */

class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._toolsets = new Map();
    this._categories = new Map();
    this._toolsBySource = new Map();
    // 2026-08-15 T7: snake_case 历史名 → PascalCase 规范主名别名表。
    // 注册时自动规范命名（snake_case name 存为 PascalCase 主名 + 原名别名），
    // get/execute 双向解析——历史 LLM 工具调用与旧代码引用不中断。
    this._aliases = new Map();
    this._initialized = false;
    this._executionLog = [];
    this._maxExecutionLog = 10000;
    this._preExecuteHooks = [];
    this._postExecuteHooks = [];
    this._policyManager = null;
  }

  /** snake_case → PascalCase 规范主名（仅全小写 snake_case 名触发；PascalCase/含连字符名原样返回） */
  _canonicalizeName(name) {
    if (typeof name !== 'string' || !name || !/^[a-z][a-z0-9_]*$/.test(name)) {
      return name;
    }
    const pascal = name
      .replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
    return pascal.charAt(0).toUpperCase() + pascal.slice(1);
  }

  /** 显式注册别名（snake_case 原名 → PascalCase 主名） */
  registerAlias(alias, canonical) {
    if (alias && canonical && typeof alias === 'string' && typeof canonical === 'string') {
      this._aliases.set(alias, canonical);
    }
  }

  /** 解析别名到规范主名（无别名时原样返回） */
  resolveName(name) {
    return this._aliases.get(name) || name;
  }

  setPolicyManager(policyManager) {
    this._policyManager = policyManager;
    this.addPreExecuteHook(async (name, params, context) => {
      const tool = this._tools.get(name);
      if (!tool || !this._policyManager) return null;

      // BUG FIX: isToolAllowed 是 async，未 await 时 result 为 Promise，
      // result.allowed 恒 undefined → 所有工具被无条件拦截。
      // input 传给策略管理器（危险命令检查需要实际参数）
      const result = await this._policyManager.isToolAllowed(name, tool.toolset, {
        ...context,
        isWrite: tool.isDangerous && !tool.isReadOnly,
        input: params,
      });

      if (!result.allowed) {
        return { blocked: true, reason: result.reason };
      }

      // S6: ask 权限触发人工审批（ApprovalHost 消费 approval_requested）。
      // R16 修复: 旧代码调 checkAndRequestApproval——该方法在 security/index 的
      // ApprovalSystemClass 上不存在(是 sandbox 的方法),调用抛 TypeError → catch
      // 默认拦截 → Write 等工具全被拦("写文章被系统拦截")。
      // 正确 API: request() 发起审批 + waitForApproval() 等待用户响应(60s)。
      // 审批系统不可用时安全拒绝。
      if (result.needsApproval) {
        return await this._requestToolApproval(tool, params, context, 'write');
      }

      // C1(Runtime差距分析): riskLevel=high 强制审批——此前 riskLevel 仅声明式元数据,
      // 无统一执行前拦截(真正拦截散落在权限规则/Bash 命令分级/沙箱内)。现在 high
      // 风险工具在执行前统一走审批; 声明 selfApproval 的工具(Bash/桌面/沙箱文件操作,
      // 自带命令级或操作级审批)豁免,避免双重弹窗。
      if (tool.riskLevel === 'high' && !tool.selfApproval) {
        return await this._requestToolApproval(tool, params, context, 'high_risk');
      }

      // P1 修复(2026-09-06): selfApproval 工具的高风险 action 单独闸。DesktopControl 整体
      // selfApproval 豁免（30 个 action 逐条弹窗不可用），但 kill_process/lock_screen/
      // sleep_system/start_process 等声明在 tool.highRiskActions 里的 action 仍强制人工审批。
      if (Array.isArray(tool.highRiskActions) && tool.highRiskActions.length > 0
          && typeof params?.action === 'string' && tool.highRiskActions.includes(params.action)) {
        return await this._requestToolApproval(tool, params, context, 'high_risk_action');
      }

      return null;
    });
  }

  /**
   * 发起工具执行前人工审批并阻塞等待(Run 生命周期感知)。
   * 等待期间把 run 标记为 waiting_approval(经 /events 广播),决议后恢复 running。
   * @returns {null|{blocked: true, reason: string}} null=放行
   */
  async _requestToolApproval(tool, params, context, operation) {
    try {
      const { getApprovalSystem } = require('../core/security/index');
      const { getApprovalWaitTimeout } = require('../core/security/approval');
      const approval = getApprovalSystem();
      if (approval && typeof approval.request === 'function' && typeof approval.waitForApproval === 'function') {
        const target = params?.path || params?.filePath || params?.url || params?.command
          || JSON.stringify(params || {}).slice(0, 120);
        const label = `[${operation}] ${target}`;
        const req = await approval.request(label, {
          userId: context.userId,
          sessionId: context.sessionId,
          message: context.message,
          operation,
          target,
        });
        if (req?.requestId) {
          this._markApprovalRunStatus(context, 'waiting_approval', { tool: tool.name, operation, requestId: req.requestId });
          try {
            const decision = await approval.waitForApproval(req.requestId, getApprovalWaitTimeout());
            if (decision?.status === 'approved' || decision?.approved) return null;
            return { blocked: true, reason: decision?.reason || '此操作需要人工审批' };
          } finally {
            this._markApprovalRunStatus(context, 'running', { tool: tool.name, operation, requestId: req.requestId });
          }
        }
        // 无 requestId → 可能是自动审批/已有决策
        if (req?.status === 'approved' || req?.status === 'auto_approved') return null;
        return { blocked: true, reason: req?.message || '此操作需要人工审批' };
      }
      return { blocked: true, reason: '审批系统不可用，操作已拦截' };
    } catch (e) {
      console.warn('[registry] 审批请求失败,默认拒绝:', e.message);
      return { blocked: true, reason: '审批系统不可用，操作已拦截' };
    }
  }

  /** 审批等待期间更新 run 状态(无 runId 上下文/RunStore 异常时静默跳过) */
  _markApprovalRunStatus(context, status, extra = {}) {
    try {
      if (!context || !context.runId) return;
      const { getRunStore } = require('../core/run-store');
      getRunStore().markRunStatus(context.runId, status, { approval: extra });
    } catch (e) {
      console.warn('[registry] run 审批状态更新失败(忽略):', e?.message || e);
    }
  }

  addPreExecuteHook(hook) {
    if (typeof hook === 'function') {
      this._preExecuteHooks.push(hook);
    }
  }

  /**
   * 添加后置执行 hook
   * hook 签名: (toolName, params, result, context) => void | Promise<void>
   * - toolName: 工具名
   * - params: 工具参数
   * - result: { success, data?, error? }
   * - context: 执行上下文
   * 后置 hook 不会阻塞工具返回结果，异常仅记录日志
   */
  addPostExecuteHook(hook) {
    if (typeof hook === 'function') {
      this._postExecuteHooks.push(hook);
    }
  }

  /**
   * 注册工具。checkFn/isDangerous/isReadOnly/source 等字段可选（有默认值）。
   *
   * 契约完备性（HARNESS.md v2.2.0）：以下字段构成工具契约的完整定义，
   * register() 会捕获并持久化到 entry，供 orchestrator/contract 系统读取：
   *   - handler      (必填) 工具执行函数，签名 (params, context) => result
   *   - schema       (必填) JSON Schema 或 { description, parameters } 包装
   *   - description  (强烈建议) 工具用途说明
   *   - whenNotToUse (建议) 不应使用本工具的场景列表，引导模型选择
   *   - riskLevel    (建议) low | medium | high，用于审批/审计/降级
   *
   * 注意：历史代码误用 `execute` 作为 handler 字段名，会被契约校验拦截并告警。
   *
   * @param {{
   *   name: string,
   *   toolset?: string,
   *   category?: string,
   *   schema: object,
   *   handler: Function,
   *   checkFn?: Function,
   *   timeout?: number,
   *   description?: string,
   *   isDangerous?: boolean,
   *   isReadOnly?: boolean,
   *   source?: string,
   *   whenNotToUse?: string[] | string,
   *   riskLevel?: string,
   *   fileParams?: string[]
   * }} tool
   */
  register({ name, toolset, category, schema, handler, execute, checkFn, checkPermissions, timeout, description, isDangerous, isReadOnly, source, whenNotToUse, riskLevel, fileParams, selfApproval, highRiskActions }) {
    if (!name || typeof name !== 'string') {
      throw new Error(`[ToolRegistry] register 失败：缺少合法 name`);
    }

    // 2026-08-15 T7 命名收敛：snake_case 注册名自动规范为 PascalCase 主名，原名保留为别名。
    const originalName = name;
    const canonicalName = this._canonicalizeName(name);
    if (canonicalName !== originalName) {
      if (!this._aliases.has(originalName)) {
        this._aliases.set(originalName, canonicalName);
      }
      name = canonicalName;
    }

    // 契约违例拦截：误用 `execute` 代替 `handler`（历史 BUG，会导致工具运行时 handler 为 undefined）
    if (!handler && typeof execute === 'function') {
      console.warn(`⚠️ [ToolRegistry] 工具 ${name} 误用 \`execute\` 字段，已自动映射为 handler。请尽快改为 \`handler\` 以符合契约规范。`);
      handler = execute;
    }

    if (typeof handler !== 'function') {
      throw new Error(`[ToolRegistry] register 失败：工具 ${name} 缺少可调用的 handler`);
    }

    if (this._tools.has(name)) {
      console.warn(`⚠️ 工具已存在，覆盖注册: ${name}`);
    }

    // 契约完备性软告警（不阻断注册，但提示补全）
    if (!description && !schema?.description) {
      console.warn(`⚠️ [ToolRegistry] 工具 ${name} 缺少 description，模型可能无法正确选用`);
    }
    if (!whenNotToUse || (Array.isArray(whenNotToUse) && whenNotToUse.length === 0)) {
      console.warn(`💡 [ToolRegistry] 工具 ${name} 未声明 whenNotToUse，建议补充以引导模型决策`);
    }
    const validRiskLevels = ['low', 'medium', 'high'];
    const resolvedRisk = riskLevel || (isDangerous ? 'high' : 'low');
    if (!validRiskLevels.includes(resolvedRisk)) {
      console.warn(`⚠️ [ToolRegistry] 工具 ${name} riskLevel 非法 (${resolvedRisk})，回退为 low`);
    }

    const entry = {
      name,
      toolset: toolset || 'general',
      category: category || toolset || 'general',
      schema,
      handler,
      checkFn: checkFn || (() => true),
      // 2026-09-04: checkPermissions 接线——此前 register 解构签名缺此字段,
      // 注册时被静默丢弃, ai.js:558 的 ask 确认分支对所有注册工具不可达(死路径补全)
      checkPermissions: typeof checkPermissions === 'function' ? checkPermissions : undefined,
      timeout: timeout || 60000,
      description: description || schema?.description || '',
      isDangerous: isDangerous || false,
      isReadOnly: isReadOnly || false,
      source: source || null,
      // 2026-08-27 B3 files 接线: 文件参数注解透传到 toolMeta，供插件权限钩子 files 分支校验
      fileParams: Array.isArray(fileParams) ? fileParams : [],
      // C1(Runtime差距分析): 自带审批流的工具(Bash 命令分级/沙箱写审批等)声明后
      // 豁免 registry 层的 high 风险强制审批,避免双重弹窗
      selfApproval: selfApproval || false,
      // P1(2026-09-06): selfApproval 工具内仍需人工审批的高风险 action 列表
      // (如 DesktopControl 的 kill_process/lock_screen/sleep_system/start_process)
      highRiskActions: Array.isArray(highRiskActions) ? highRiskActions : [],
      // 契约扩展字段（HARNESS.md v2.2.0 工具契约规范）
      whenNotToUse: Array.isArray(whenNotToUse) ? whenNotToUse : (whenNotToUse ? [whenNotToUse] : []),
      riskLevel: validRiskLevels.includes(resolvedRisk) ? resolvedRisk : 'low',
      registeredAt: new Date().toISOString()
    };

    this._tools.set(name, entry);
    if (entry.source) {
      if (!this._toolsBySource.has(entry.source)) {
        this._toolsBySource.set(entry.source, []);
      }
      this._toolsBySource.get(entry.source).push(name);
    }

    if (!this._toolsets.has(entry.toolset)) {
      this._toolsets.set(entry.toolset, []);
    }
    this._toolsets.get(entry.toolset).push(name);

    if (!this._categories.has(entry.category)) {
      this._categories.set(entry.category, []);
    }
    this._categories.get(entry.category).push(name);

    console.log(`✅ 工具注册: ${name} [${entry.toolset}/${entry.category}]`);
    return this;
  }

  get(name) {
    return this._tools.get(this.resolveName(name));
  }

  has(name) {
    return this._tools.has(this.resolveName(name));
  }

  getByToolset(toolset) {
    const names = this._toolsets.get(toolset) || [];
    return names.map(n => this._tools.get(n)).filter(Boolean);
  }

  getByCategory(category) {
    const names = this._categories.get(category) || [];
    return names.map(n => this._tools.get(n)).filter(Boolean);
  }

  getAll() {
    return [...this._tools.values()];
  }

  getToolsets() {
    return [...this._toolsets.keys()];
  }

  getCategories() {
    return [...this._categories.keys()];
  }

  getNames() {
    return [...this._tools.keys()];
  }

  /**
   * 搜索工具（find_tool 用）：按名称、描述、关键词查找
   * @param {string} query - 搜索关键词
   * @param {object} [options]
   * @param {number} [options.limit=5] 最多返回几个
   * @returns {Array<{name, description, toolset, category, score}>}
   */
  search(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const limit = options.limit || 5;
    const lower = query.toLowerCase();
    const results = [];

    for (const tool of this._tools.values()) {
      const name = (tool.name || '').toLowerCase();
      const desc = (tool.description || '').toLowerCase();
      const toolset = (tool.toolset || '').toLowerCase();
      const category = (tool.category || '').toLowerCase();

      let score = 0;
      if (name === lower) score += 100;          // 精确匹配
      else if (name.includes(lower)) score += 50; // 名称包含
      if (desc.includes(lower)) score += 10;      // 描述包含
      if (toolset.includes(lower)) score += 5;
      if (category.includes(lower)) score += 5;

      // 多词搜索：所有词都在名称/描述中
      const words = lower.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        const allMatch = words.every(w => name.includes(w) || desc.includes(w));
        if (allMatch) score += 20;
      }

      if (score > 0) {
        results.push({
          name: tool.name,
          description: tool.description,
          toolset: tool.toolset,
          category: tool.category,
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  toOpenAIFormat(toolsets = null) {
    const tools = toolsets
      ? toolsets.flatMap(t => this.getByToolset(t))
      : this.getAll();

    return tools
      .filter(t => t.schema)
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || t.schema?.description || '',
          parameters: t.schema?.parameters || t.schema || {}
        }
      }));
  }

  toClaudeFormat(toolsets = null) {
    const tools = toolsets
      ? toolsets.flatMap(t => this.getByToolset(t))
      : this.getAll();

    return tools
      .filter(t => t.schema)
      .map(t => ({
        name: t.name,
        description: t.description || t.schema?.description || '',
        input_schema: {
          type: 'object',
          properties: t.schema?.parameters?.properties || t.schema?.properties || {},
          required: t.schema?.parameters?.required || t.schema?.required || []
        }
      }));
  }

  async execute(name, params, context = {}) {
    // C2(Runtime差距分析): runId 存在且当前异步链未携带时,以 run 上下文重入——
    // hooks/handler 内部发出的审计条目(approval_requested/command_check 等)经
    // AsyncLocalStorage 自动关联本次 run(traceId/runId)。已有上下文时直接执行,
    // 避免嵌套 run 重入。
    if (context && context.runId) {
      try {
        const { globalTraceContext } = require('../core/trace-context');
        if (typeof globalTraceContext.getRunId === 'function' && globalTraceContext.getRunId() !== context.runId) {
          return await globalTraceContext.runWithRunId(context.runId, () => this._executeResolved(name, params, context));
        }
      } catch (e) { console.warn('[registry] run 上下文包装失败(降级直执行):', e.message); }
    }
    return this._executeResolved(name, params, context);
  }

  async _executeResolved(name, params, context = {}) {
    // 2026-08-15 T7: 别名解析——历史 LLM 调用 snake_case 原名仍可执行，hooks/审计统一见规范主名。
    const resolvedName = this.resolveName(name);
    const tool = this._tools.get(resolvedName);
    if (!tool) {
      throw new Error(`工具不存在: ${name}`);
    }

    // 2026-08-18 P0 修复: checkFn 调用此前在 try/catch 外——checkFn 为 null 或抛错
    // 会直接击穿 execute 调用链（可用性检查反成崩溃点），且被拒时不留执行日志。
    // 现包进 try/catch 并走 _logExecution，与其余拒绝路径日志语义一致。
    let checkPass = true;
    try {
      if (!tool.checkFn(params)) checkPass = false;
    } catch (checkErr) {
      console.warn(`⚠️ 工具检查函数异常: ${name}: ${checkErr.message}`);
      checkPass = false;
    }
    if (!checkPass) {
      this._logExecution(resolvedName, params, { success: false, blocked: true, reason: `checkFn 拒绝或异常: ${name}` });
      throw new Error(`工具参数检查失败: ${name}`);
    }

    // 2026-08-01: 只读工具结果缓存（tool-result-cache 此前读路径从未接线）。
    // 白名单（Read/Grep/Glob/LS/WebSearch/WebFetch 等）+ 15min TTL。
    try {
      const { getToolResultCache } = require('../core/tool-result-cache');
      const cached = getToolResultCache().get(resolvedName, params);
      if (cached) {
        this._logExecution(resolvedName, params, { success: true, cached: true });
        return { success: true, data: cached, fromCache: true };
      }
    } catch (cacheErr) {
      console.warn(`⚠️ 工具缓存读取失败: ${cacheErr.message}`);
    }

    for (const hook of this._preExecuteHooks) {
      try {
        // 2026-08-27 B3: 第 4 参 toolMeta 携带工具来源，供插件权限钩子裁决
        //（老 hook 仅声明 3 参，多余实参被忽略，向前兼容）。
        const toolMeta = { source: tool.source || null, fileParams: Array.isArray(tool.fileParams) ? tool.fileParams : [] };
        const decision = await hook(resolvedName, params, context, toolMeta);
        if (decision && decision.blocked) {
          this._logExecution(resolvedName, params, { blocked: true, reason: decision.reason });
          return { success: false, error: decision.reason || `工具执行被安全策略拦截: ${resolvedName}`, blocked: true };
        }
        // 支持 hook 修改工具参数（modifiedInput），供后续 hook 与 handler 使用
        if (decision && decision.modifiedInput) {
          params = decision.modifiedInput;
        }
      } catch (hookErr) {
        console.warn(`⚠️ 安全前置检查异常: ${hookErr.message}`);
      }
    }

    const startTime = Date.now();

    // A1(Runtime差距分析): 契约 maxTimeout 接线为权威上限——此前字段仅声明未读取,
    // 执行器只看 registry 条目 timeout,两套数值并存。生效超时 = min(条目 timeout, 契约 maxTimeout)。
    let timeout = tool.timeout;
    try {
      const { getToolContract } = require('../core/tool-contract');
      const contract = getToolContract(resolvedName);
      if (contract && Number.isFinite(contract.maxTimeout) && contract.maxTimeout > 0) {
        timeout = Math.min(timeout, contract.maxTimeout);
      }
    } catch (e) {
      console.warn('[registry] 契约 maxTimeout 读取失败(按条目 timeout 执行):', e.message);
    }
    // 发布 P1-2: 记录 timer id——此前 Promise.race 结束后 120s 定时器从不清理,
    // 每次工具执行残留一个空转定时器拖住进程退出(jest 实测)。
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`工具执行超时 (${timeout}ms): ${resolvedName}`)), timeout);
    });

    try {
      const result = await Promise.race([
        tool.handler(params, context),
        timeoutPromise
      ]);
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      const execResult = { success: true, data: result };
      // 2026-08-01: 成功结果写入缓存（白名单内只读工具）
      // 2026-08-03: getToolResultCache 提到块外（多个 try 内同名 const → TS2300）
      let getToolResultCache = null
      try { getToolResultCache = require('../core/tool-result-cache').getToolResultCache } catch (e) { console.warn('[registry] 工具结果缓存模块加载失败（缓存功能禁用）:', e.message); }
      try {
        getToolResultCache?.().set(resolvedName, params, execResult);
      } catch (cacheErr) {
        console.warn(`⚠️ 工具缓存写入失败: ${cacheErr.message}`);
      }
      // 2026-08-01: 写操作成功后失效相关路径的缓存（文件被修改后 Read 缓存应失效）
      if (!tool.isReadOnly) {
        const writePath = params?.file_path || params?.filePath;
        if (writePath) {
          try {
            getToolResultCache?.().invalidateByPath(writePath);
          } catch (e) {
            console.warn('[registry] 工具缓存失效失败:', e.message);
          }
        }
      }
      this._logExecution(resolvedName, params, { success: true, elapsed });
      this._runPostHooks(resolvedName, params, execResult, context);
      return execResult;
    } catch (error) {
      clearTimeout(timeoutId);
      const elapsed = Date.now() - startTime;
      const execResult = { success: false, error: error.message };
      this._logExecution(resolvedName, params, { success: false, elapsed, error: error.message });
      this._runPostHooks(resolvedName, params, execResult, context);
      return execResult;
    }
  }

  /**
   * 运行后置 hook（异步，不阻塞返回）
   */
  _runPostHooks(toolName, params, result, context) {
    if (this._postExecuteHooks.length === 0) return;
    for (const hook of this._postExecuteHooks) {
      try {
        const hookResult = hook(toolName, params, result, context);
        if (hookResult && typeof hookResult.catch === 'function') {
          hookResult.catch(e => console.error(`[ToolRegistry] PostExecuteHook 异常 (${toolName}): ${e.message}`));
        }
      } catch (e) {
        console.error(`[ToolRegistry] PostExecuteHook 异常 (${toolName}): ${e.message}`);
      }
    }
  }

  _logExecution(name, params, meta) {
    this._executionLog.push({
      ts: Date.now(),
      tool: name,
      paramsKeys: Object.keys(params || {}),
      ...meta,
    });
    if (this._executionLog.length > this._maxExecutionLog) {
      this._executionLog.shift();
    }
  }

  getExecutionLog(filter = {}) {
    let logs = [...this._executionLog];
    if (filter.tool) logs = logs.filter(l => l.tool === filter.tool);
    if (filter.since) logs = logs.filter(l => l.ts >= filter.since);
    if (filter.blocked) logs = logs.filter(l => l.blocked);
    return logs;
  }

  /**
   * 最近执行的工具名（尾段直读，P0-6：免 1 万条数组拷贝）。
   * getExecutionLog 每次全量拷贝 _executionLog（≤10000 条）供 ToolsetManager
   * 每轮只取最后 5 条——尾段扫描即可。
   */
  getRecentToolNames(limit = 5) {
    const out = [];
    const seen = new Set();
    for (let i = this._executionLog.length - 1; i >= 0 && out.length < limit; i--) {
      const name = this._executionLog[i] && this._executionLog[i].tool;
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }

  getStats() {
    return {
      totalTools: this._tools.size,
      toolsets: this.getToolsets().length,
      categories: this.getCategories().length,
      byToolset: Object.fromEntries(
        [...this._toolsets.entries()].map(([k, v]) => [k, v.length])
      ),
      byCategory: Object.fromEntries(
        [...this._categories.entries()].map(([k, v]) => [k, v.length])
      )
    };
  }

  clear() {
    this._tools.clear();
    this._toolsets.clear();
    this._categories.clear();
    this._toolsBySource.clear();
    console.log('🗑️ 工具注册表已清空');
  }

  unregisterBySource(source) {
    const names = this._toolsBySource.get(source);
    if (!names || names.length === 0) {
      console.warn(`[ToolRegistry] 来源 ${source} 没有注册的工具`);
      return 0;
    }
    let count = 0;
    for (const name of names) {
      const tool = this._tools.get(name);
      // 2026-08-25 Cordis Stage1 内置保护：只删 source 仍属于自己的工具。
      // 历史 P6：插件注册同名工具覆盖内置 → disable 把内置一起删掉（永久丢失）。
      // 现在条目被其他来源覆盖/占有时不删除——删除请求静默跳过。
      if (tool && tool.source === source) {
        this._tools.delete(name);
        count++;
      }
    }
    this._toolsBySource.delete(source);
    this._toolsets.clear();
    this._categories.clear();
    for (const tool of this._tools.values()) {
      if (!this._toolsets.has(tool.toolset)) this._toolsets.set(tool.toolset, []);
      this._toolsets.get(tool.toolset).push(tool.name);
      if (!this._categories.has(tool.category)) this._categories.set(tool.category, []);
      this._categories.get(tool.category).push(tool.name);
    }
    console.log(`[ToolRegistry] 已清除来源 ${source} 的 ${count} 个工具`);
    return count;
  }
}

const globalRegistry = new ToolRegistry();

module.exports = {
  ToolRegistry,
  registry: globalRegistry
};
