const crypto = require('crypto');
/**
 * ToolEvolutionBridge — 内置工具进化桥
 *
 * 打通"内置工具"与"技能进化体系"的断层：
 *   1. 工具执行后自动记录指标（成功率/耗时/错误模式）
 *   2. 基于指标生成进化建议（FIX/DERIVED）
 *   3. 支持工具参数自修复（API 失败时自动切换数据源/调整参数）
 *   4. 数据源质量评分（自动淘汰劣质 API，优先使用高质量源）
 *
 * 闭环：
 *   工具执行 → recordToolExecution → 评估质量 → 生成建议
 *   → 自修复（API 切换/参数调整）→ 验证效果 → 回写配置
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const TOOL_EVOLUTION_DIR = path.join(config.DATA_DIR, 'tool-evolution');
const TOOL_METRICS_FILE = path.join(TOOL_EVOLUTION_DIR, 'metrics.json');
const TOOL_SUGGESTIONS_FILE = path.join(TOOL_EVOLUTION_DIR, 'suggestions.json');
const DATA_SOURCE_SCORES_FILE = path.join(TOOL_EVOLUTION_DIR, 'data-source-scores.json');

// 数据源质量评分默认值
const DEFAULT_SOURCE_SCORES = {
  eastmoney_quote: { score: 0.8, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  eastmoney_kline: { score: 0.7, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  eastmoney_search: { score: 0.7, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  eastmoney_margin: { score: 0.5, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  eastmoney_northflow: { score: 0.6, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  eastmoney_market: { score: 0.8, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  sina_kline: { score: 0.6, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  flashclaw_python: { score: 0.4, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
  websearch_fallback: { score: 0.3, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0 },
};

class ToolEvolutionBridge {
  constructor() {
    this._metrics = {};
    this._suggestions = [];
    this._sourceScores = {};
    this._initialized = false;
    this._autoFixEnabled = true;
    this._evolutionCallbacks = [];
  }

  initialize() {
    if (this._initialized) return;

    if (!fs.existsSync(TOOL_EVOLUTION_DIR)) {
      fs.mkdirSync(TOOL_EVOLUTION_DIR, { recursive: true });
    }

    this._loadMetrics();
    this._loadSuggestions();
    this._loadSourceScores();
    this._initialized = true;

    console.log('[ToolEvolutionBridge] 内置工具进化桥已初始化');
  }

  /**
   * 注册进化回调（当工具需要进化时通知外部系统）
   */
  onEvolution(callback) {
    this._evolutionCallbacks.push(callback);
  }

  // ==================== 执行记录 ====================

  /**
   * 记录工具执行结果（核心入口）
   * 在 ai.js 工具调用完成后调用
   *
   * @param {string} toolName - 工具名称，如 'StockQuery'
   * @param {object} execution - 执行结果
   * @param {boolean} execution.success - 是否成功
   * @param {number} execution.durationMs - 执行耗时
   * @param {string|null} execution.error - 错误信息
   * @param {object|null} execution.metadata - 额外元数据（数据源、参数等）
   */
  recordToolExecution(toolName, { success, durationMs, error, metadata }) {
    if (!this._initialized) return;

    if (!this._metrics[toolName]) {
      this._metrics[toolName] = {
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        consecutiveFailures: 0,
        totalDurationMs: 0,
        errors: [],
        lastExecutionAt: 0,
        dailyStats: {},
        errorPatterns: {},
        dataSourceUsage: {},
      };
    }

    const m = this._metrics[toolName];
    m.totalCalls++;
    m.lastExecutionAt = Date.now();

    if (success) {
      m.successCount++;
      m.consecutiveFailures = 0;
    } else {
      m.failCount++;
      m.consecutiveFailures++;

      // 记录错误模式
      if (error) {
        const pattern = this._extractErrorPattern(error);
        m.errorPatterns[pattern] = (m.errorPatterns[pattern] || 0) + 1;
        m.errors.push({ error, pattern, timestamp: Date.now() });
        if (m.errors.length > 100) m.errors = m.errors.slice(-50);
      }
    }

    m.totalDurationMs += durationMs || 0;

    // 记录数据源使用情况
    if (metadata?.dataSource) {
      const ds = metadata.dataSource;
      m.dataSourceUsage[ds] = m.dataSourceUsage[ds] || { success: 0, fail: 0 };
      if (success) m.dataSourceUsage[ds].success++;
      else m.dataSourceUsage[ds].fail++;
    }

    // 更新数据源质量评分
    if (metadata?.dataSource) {
      this._updateSourceScore(metadata.dataSource, success, durationMs);
    }

    // 每日统计
    const today = new Date().toISOString().slice(0, 10);
    if (!m.dailyStats[today]) {
      m.dailyStats[today] = { calls: 0, success: 0, fail: 0 };
    }
    m.dailyStats[today].calls++;
    if (success) m.dailyStats[today].success++;
    else m.dailyStats[today].fail++;

    // 触发进化检查
    this._checkEvolutionNeeded(toolName);

    // 持久化
    this._saveMetrics();
  }

  /**
   * 提取错误模式（将具体错误抽象为模式）
   */
  _extractErrorPattern(error) {
    if (!error) return 'unknown';

    // HTTP 状态码模式
    const httpMatch = error.match(/(\d{3})/);
    if (httpMatch && ['400', '401', '403', '404', '429', '500', '502', '503'].includes(httpMatch[1])) {
      return `HTTP_${httpMatch[1]}`;
    }

    // 超时模式
    if (/timeout|超时|ETIMEDOUT/i.test(error)) return 'TIMEOUT';

    // 连接失败模式
    if (/ECONNREFUSED|ECONNRESET|connect|socket/i.test(error)) return 'CONNECTION_ERROR';

    // 解析失败模式
    if (/parse|JSON|解析/i.test(error)) return 'PARSE_ERROR';

    // API 废弃模式
    if (/报表配置不存在|report.*not.*found|deprecated|废弃/i.test(error)) return 'API_DEPRECATED';

    return 'OTHER';
  }

  // ==================== 数据源质量评分 ====================

  /**
   * 更新数据源质量评分
   */
  _updateSourceScore(sourceName, success, durationMs) {
    if (!this._sourceScores[sourceName]) {
      this._sourceScores[sourceName] = {
        score: 0.5, successCount: 0, failCount: 0, avgLatencyMs: 0, lastUsed: 0,
      };
    }

    const s = this._sourceScores[sourceName];
    s.lastUsed = Date.now();

    if (success) {
      s.successCount++;
      // 成功加分，但衰减到 1.0
      s.score = Math.min(1.0, s.score + 0.05);
    } else {
      s.failCount++;
      // 失败扣分，但保底 0.0
      s.score = Math.max(0.0, s.score - 0.15);
    }

    // 延迟影响评分
    if (durationMs) {
      s.avgLatencyMs = s.avgLatencyMs === 0
        ? durationMs
        : s.avgLatencyMs * 0.8 + durationMs * 0.2;

      // 延迟 > 5s 扣分
      if (durationMs > 5000) s.score = Math.max(0.0, s.score - 0.05);
    }

    this._saveSourceScores();
  }

  /**
   * 获取数据源质量排名（用于工具内部选择最优数据源）
   */
  getSourceRanking() {
    const ranking = Object.entries(this._sourceScores)
      .map(([name, data]) => ({
        name,
        score: data.score,
        successRate: data.successCount + data.failCount > 0
          ? data.successCount / (data.successCount + data.failCount)
          : 0,
        avgLatencyMs: data.avgLatencyMs,
      }))
      .sort((a, b) => b.score - a.score);

    return ranking;
  }

  /**
   * 获取指定数据源的评分
   */
  getSourceScore(sourceName) {
    return this._sourceScores[sourceName]?.score || 0.5;
  }

  /**
   * 判断数据源是否可用（评分 > 0.2）
   */
  isSourceAvailable(sourceName) {
    return this.getSourceScore(sourceName) > 0.2;
  }

  // ==================== 进化检查 ====================

  _checkEvolutionNeeded(toolName) {
    const m = this._metrics[toolName];
    if (!m) return;

    // 规则1: 连续失败 → 紧急修复
    if (m.consecutiveFailures >= 3) {
      this._emitSuggestion({
        type: 'fix',
        toolName,
        priority: 'critical',
        reason: `${toolName} 连续失败 ${m.consecutiveFailures} 次`,
        action: 'api_failover',
        details: this._getTopErrorPatterns(toolName),
      });
    }

    // 规则2: 成功率低于 60% → 修复建议
    if (m.totalCalls >= 5) {
      const successRate = m.successCount / m.totalCalls;
      if (successRate < 0.6) {
        this._emitSuggestion({
          type: 'fix',
          toolName,
          priority: 'high',
          reason: `${toolName} 成功率 ${(successRate * 100).toFixed(1)}%，低于 60%`,
          action: 'review_error_patterns',
          details: this._getTopErrorPatterns(toolName),
        });
      }
    }

    // 规则3: 特定错误模式高频出现 → 针对性修复
    for (const [pattern, count] of Object.entries(m.errorPatterns || {})) {
      if (count >= 3) {
        this._emitSuggestion({
          type: 'fix',
          toolName,
          priority: 'medium',
          reason: `${toolName} 错误模式 ${pattern} 出现 ${count} 次`,
          action: this._getFixAction(pattern),
          details: { pattern, count },
        });
      }
    }

    // 规则4: 高频使用且成功率高 → 增强建议
    if (m.totalCalls >= 20 && m.successCount / m.totalCalls > 0.8) {
      this._emitSuggestion({
        type: 'derived',
        toolName,
        priority: 'low',
        reason: `${toolName} 使用频繁 (${m.totalCalls}次) 且成功率 ${(m.successCount / m.totalCalls * 100).toFixed(1)}%，可增强`,
        action: 'enhance_capabilities',
        details: this._getEnhancementSuggestions(toolName),
      });
    }

    // 规则5: 数据源质量变化 → 切换建议
    const ranking = this.getSourceRanking();
    for (const source of ranking) {
      if (source.score < 0.3 && source.successRate > 0) {
        this._emitSuggestion({
          type: 'fix',
          toolName,
          priority: 'high',
          reason: `数据源 ${source.name} 质量评分 ${source.score.toFixed(2)} 过低`,
          action: 'deprecate_source',
          details: { source: source.name, score: source.score },
        });
      }
    }
  }

  _emitSuggestion(suggestion) {
    // 去重：同一工具同一 action 10分钟内不重复
    const dedupKey = `${suggestion.toolName}:${suggestion.action}`;
    const recent = this._suggestions.filter(s =>
      `${s.toolName}:${s.action}` === dedupKey &&
      Date.now() - s.timestamp < 600000
    );
    if (recent.length > 0) return;

    suggestion.id = `te-${Date.now()}-${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    suggestion.timestamp = Date.now();
    this._suggestions.push(suggestion);

    if (this._suggestions.length > 200) {
      this._suggestions = this._suggestions.slice(-100);
    }

    this._saveSuggestions();

    // 通知外部系统
    for (const cb of this._evolutionCallbacks) {
      try { cb(suggestion); } catch (e) {
        /* ignore */
        console.warn('[tool-evolution-bridge.js] 空 catch 补日志:', e && e.message);
      }

    }

    console.log(`[ToolEvolutionBridge] 进化建议: ${suggestion.type} ${suggestion.toolName} - ${suggestion.reason}`);
  }

  _getTopErrorPatterns(toolName) {
    const m = this._metrics[toolName];
    if (!m?.errorPatterns) return {};
    return Object.entries(m.errorPatterns)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {});
  }

  _getFixAction(pattern) {
    const actionMap = {
      'HTTP_400': 'check_api_params',
      'HTTP_401': 'refresh_auth',
      'HTTP_403': 'check_permissions',
      'HTTP_404': 'update_endpoint',
      'HTTP_429': 'add_rate_limit',
      'HTTP_500': 'add_retry',
      'HTTP_502': 'add_retry',
      'HTTP_503': 'add_retry',
      'TIMEOUT': 'increase_timeout',
      'CONNECTION_ERROR': 'add_retry_with_backoff',
      'PARSE_ERROR': 'update_parser',
      'API_DEPRECATED': 'migrate_to_new_api',
    };
    return actionMap[pattern] || 'investigate';
  }

  _getEnhancementSuggestions(toolName) {
    const suggestions = [];

    if (toolName === 'StockQuery') {
      const m = this._metrics[toolName];
      if (m?.totalCalls > 10) {
        suggestions.push('增加行业横向对比分析');
        suggestions.push('增加多日资金流向趋势');
        suggestions.push('增加技术形态自动识别');
        suggestions.push('增加同行业估值对比');
        suggestions.push('增加智能预警阈值学习');
        suggestions.push('增加支撑阻力位检测');
        suggestions.push('增加波动率分析（ATR/布林带宽度）');
        suggestions.push('增加多周期趋势共振分析');
        suggestions.push('增加风险收益比计算');
        suggestions.push('增加板块轮动分析');
      }
    }

    return suggestions;
  }

  // ==================== 自修复接口 ====================

  /**
   * 获取工具的自修复配置
   * 工具内部调用此方法获取当前最优数据源和参数
   */
  getToolConfig(toolName) {
    const config = {
      preferredSources: [],
      deprecatedSources: [],
      customParams: {},
    };

    const ranking = this.getSourceRanking();
    config.preferredSources = ranking.filter(s => s.score > 0.5).map(s => s.name);
    config.deprecatedSources = ranking.filter(s => s.score <= 0.2).map(s => s.name);

    // 工具特定配置
    if (toolName === 'StockQuery') {
      // 如果东方财富行情源评分低，优先用搜索
      if (!this.isSourceAvailable('eastmoney_quote')) {
        config.customParams.skipEastMoneyQuote = true;
      }
      // 如果融资融券 API 废弃，跳过
      if (!this.isSourceAvailable('eastmoney_margin')) {
        config.customParams.skipMarginData = true;
      }
      // 如果 FlashClaw 评分低，跳过
      if (!this.isSourceAvailable('flashclaw_python')) {
        config.customParams.skipFlashclaw = true;
      }
    }

    return config;
  }

  /**
   * 获取工具质量报告
   */
  getToolReport(toolName) {
    const m = this._metrics[toolName];
    if (!m) return null;

    const successRate = m.totalCalls > 0 ? m.successCount / m.totalCalls : 0;
    const avgDuration = m.totalCalls > 0 ? m.totalDurationMs / m.totalCalls : 0;

    return {
      toolName,
      totalCalls: m.totalCalls,
      successCount: m.successCount,
      failCount: m.failCount,
      successRate: (successRate * 100).toFixed(1) + '%',
      avgDurationMs: Math.round(avgDuration),
      consecutiveFailures: m.consecutiveFailures,
      topErrors: this._getTopErrorPatterns(toolName),
      dataSourceUsage: m.dataSourceUsage,
    };
  }

  /**
   * 获取所有工具的质量报告
   */
  getAllToolReports() {
    return Object.keys(this._metrics).map(name => this.getToolReport(name));
  }

  // ==================== 运行时工具缺口检测与自生成 ====================
  // (Browser Harness 启发: Agent 在任务中途发现能力缺口 → 自己写工具 → 立即使用)

  /**
   * 检测工具缺口
   * 当工具调用失败时，判断是否为"工具不存在"类型错误
   *
   * @param {Error|string} error - 错误对象或消息
   * @param {Object} [context] - 调用上下文
   * @param {string} [context.toolName] - 尝试调用的工具名称
   * @param {Object} [context.params] - 尝试传递的参数
   * @returns {Object|null} { missing: boolean, suggestedName, suggestedSchema, reason }
   */
  detectToolGap(error, context = {}) {
    const msg = typeof error === 'string' ? error : (error?.message || '');

    // 模式1: 工具未注册
    const unregisteredMatch = msg.match(/tool['"\s]+['"]?(\w+)['"]?\s*(?:not found|不存在|is not a function|未注册)/i);
    if (unregisteredMatch) {
      const toolName = unregisteredMatch[1] || context.toolName;
      return {
        missing: true,
        gapType: 'unregistered_tool',
        suggestedName: this._pascalize(toolName),
        suggestedSchema: this._inferSchema(toolName, context.params),
        reason: `Tool '${toolName}' is not registered`,
        severity: 'medium',
      };
    }

    // 模式2: 函数缺失（Browser Harness 模式: "is not a function"）
    const notFunctionMatch = msg.match(/(\w+)\s+is not a function/i);
    if (notFunctionMatch) {
      const funcName = notFunctionMatch[1];
      return {
        missing: true,
        gapType: 'missing_function',
        suggestedName: this._pascalize(funcName),
        suggestedSchema: this._inferSchema(funcName, context.params),
        reason: `Function '${funcName}' is not a function — needs CDP-level implementation`,
        severity: 'high',
      };
    }

    // 模式3: 功能缺失（"No handler for action"）
    const noHandlerMatch = msg.match(/no handler for action\s+['"](\w+)['"]/i);
    if (noHandlerMatch) {
      return {
        missing: true,
        gapType: 'missing_action_handler',
        suggestedName: context.toolName || noHandlerMatch[1],
        suggestedSchema: { action: noHandlerMatch[1] },
        reason: `No handler for action '${noHandlerMatch[1]}'`,
        severity: 'low',
      };
    }

    return null; // 不是工具缺口
  }

  /**
   * 将名称转换为 PascalCase
   */
  _pascalize(name) {
    return (name || 'UnknownTool')
      .replace(/[^a-zA-Z0-9]/g, ' ')
      .split(/[\s_]+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('');
  }

  /**
   * 根据名称和已有参数推断 schema
   */
  // eslint-disable-next-line no-unused-vars
  _inferSchema(name, params = {}) {
    const props = { action: { type: 'string', minLength: 1 } };
    const lower = (name || '').toLowerCase();

    if (lower.includes('search') || lower.includes('query')) {
      props.query = { type: 'string', minLength: 1 };
    }
    if (lower.includes('url') || lower.includes('navigate') || lower.includes('fetch')) {
      props.url = { type: 'string', minLength: 1 };
    }
    if (lower.includes('file') || lower.includes('write') || lower.includes('save')) {
      props.path = { type: 'string', minLength: 1 };
      props.content = { type: 'string' };
    }

    return { type: 'object', properties: props, required: ['action'], additionalProperties: false };
  }

  /**
   * 生成符合 CrabPaw Harness 规范的工具契约模板
   * 供 Agent 填充后注册为新工具
   *
   * @param {string} name - 工具名称（将自动 PascalCase）
   * @param {string} description - 工具用途描述
   * @param {Object} [schema] - JSON Schema（可选，会自动推断）
   * @returns {Object} 契约模板 { name, contract }
   */
  generateContractTemplate(name, description, schema = null) {
    const pascalName = this._pascalize(name);

    // 推断风险等级
    const lowerDesc = (description || '').toLowerCase();
    let riskLevel = 'medium';
    if (/(read|get|search|query|fetch|list|view|show|check|status)/.test(lowerDesc)) {
      riskLevel = 'low';
    } else if (/(execute|delete|remove|kill|stop|bash|command|shell|install)/.test(lowerDesc)) {
      riskLevel = 'high';
    }

    const contract = {
      description: description || `Auto-generated contract for ${pascalName}`,
      whenNotToUse: [`Don't use ${pascalName} for unsupported operations`],
      schema: schema || {
        type: 'object',
        properties: { action: { type: 'string', minLength: 1 } },
        required: ['action'],
        additionalProperties: false,
      },
      maxTimeout: riskLevel === 'high' ? 120000 : (riskLevel === 'medium' ? 60000 : 30000),
      riskLevel,
      validate: null,
      _meta: {
        generatedAt: new Date().toISOString(),
        generatedBy: 'tool-evolution-bridge',
        source: 'agent_authored',
        status: 'draft',
      },
    };

    return { name: pascalName, contract };
  }

  /**
   * 注册 Agent 创作的工具（Browser Harness 启发: 工具永久保留）
   * 将工具注册到 TOOL_CONTRACTS 并标记为 agent-authored，进入观察期
   *
   * @param {string} name - 工具名称
   * @param {Object} contract - 工具契约
   * @param {Object} [authoringContext] - 创作上下文（用于审计）
   * @param {string} [authoringContext.sessionId] - 会话 ID
   * @param {string} [authoringContext.taskDescription] - 触发创作的任务描述
   * @returns {Object} { registered, name, status }
   */
  registerAgentAuthoredTool(name, contract, authoringContext = {}) {
    const { registerToolContract } = require('./tool-contract');

    // 记录到本地存储
    const authoredToolsFile = path.join(TOOL_EVOLUTION_DIR, 'agent-authored-tools.json');
    let authoredTools = [];
    try {
      if (fs.existsSync(authoredToolsFile)) {
        authoredTools = JSON.parse(fs.readFileSync(authoredToolsFile, 'utf-8'));
      }
    } catch (e) {
      authoredTools = [];
    }

    const entry = {
      name,
      contract,
      authoredAt: new Date().toISOString(),
      sessionId: authoringContext.sessionId || 'unknown',
      taskDescription: authoringContext.taskDescription || 'Agent-authored tool',
      status: 'observing', // observing → approved → stable
      version: 1,
    };

    // 去重：同名工具不重复注册
    const existing = authoredTools.find(t => t.name === name);
    if (existing) {
      existing.contract = contract;
      existing.updatedAt = new Date().toISOString();
      existing.version = (existing.version || 1) + 1;
    } else {
      authoredTools.push(entry);
    }

    fs.writeFileSync(authoredToolsFile, JSON.stringify(authoredTools, null, 2));

    // 注册到运行时工具契约系统
    try {
      registerToolContract(name, contract);
    } catch (e) {
      console.warn(`[ToolEvolutionBridge] registerToolContract failed for ${name}:`, e.message);
    }

    // 记录到进化历史
    this._suggestions.push({
      id: `agent-tool-${Date.now()}`,
      type: 'agent_authored',
      toolName: name,
      priority: 'medium',
      reason: `Agent authored new tool: ${name}`,
      action: 'observe',
      timestamp: Date.now(),
      details: { contract, sessionId: authoringContext.sessionId },
    });

    console.log(`[ToolEvolutionBridge] Agent-authored tool registered: ${name} (status: observing)`);

    return {
      registered: true,
      name,
      status: 'observing',
      _hint: `Tool '${name}' registered. It will be monitored for quality. If successful over time, it will be promoted to stable.`,
    };
  }

  /**
   * 获取所有 Agent 创作的工具
   */
  getAgentAuthoredTools() {
    const authoredToolsFile = path.join(TOOL_EVOLUTION_DIR, 'agent-authored-tools.json');
    try {
      if (fs.existsSync(authoredToolsFile)) {
        return JSON.parse(fs.readFileSync(authoredToolsFile, 'utf-8'));
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  // ==================== 持久化 ====================

  _loadMetrics() {
    try {
      if (fs.existsSync(TOOL_METRICS_FILE)) {
        this._metrics = JSON.parse(fs.readFileSync(TOOL_METRICS_FILE, 'utf-8'));
      }
    } catch (e) {
      this._metrics = {};
    }
  }

  _saveMetrics() {
    try {
      fs.writeFileSync(TOOL_METRICS_FILE, JSON.stringify(this._metrics, null, 2));
    } catch (e) {
      // ignore
    }
  }

  _loadSuggestions() {
    try {
      if (fs.existsSync(TOOL_SUGGESTIONS_FILE)) {
        this._suggestions = JSON.parse(fs.readFileSync(TOOL_SUGGESTIONS_FILE, 'utf-8'));
      }
    } catch (e) {
      this._suggestions = [];
    }
  }

  _saveSuggestions() {
    try {
      fs.writeFileSync(TOOL_SUGGESTIONS_FILE, JSON.stringify(this._suggestions, null, 2));
    } catch (e) {
      // ignore
    }
  }

  _loadSourceScores() {
    try {
      if (fs.existsSync(DATA_SOURCE_SCORES_FILE)) {
        this._sourceScores = JSON.parse(fs.readFileSync(DATA_SOURCE_SCORES_FILE, 'utf-8'));
      } else {
        this._sourceScores = JSON.parse(JSON.stringify(DEFAULT_SOURCE_SCORES));
      }
    } catch (e) {
      this._sourceScores = JSON.parse(JSON.stringify(DEFAULT_SOURCE_SCORES));
    }
  }

  _saveSourceScores() {
    try {
      fs.writeFileSync(DATA_SOURCE_SCORES_FILE, JSON.stringify(this._sourceScores, null, 2));
    } catch (e) {
      // ignore
    }
  }
}

// 单例
let _instance = null;

function getToolEvolutionBridge() {
  if (!_instance) {
    _instance = new ToolEvolutionBridge();
    _instance.initialize();
  }
  return _instance;
}

module.exports = { ToolEvolutionBridge, getToolEvolutionBridge };
