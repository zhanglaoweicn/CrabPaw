/**
 * Execution Analyzer — 执行后置分析器
 *
 * 参考 OpenSpace ExecutionAnalyzer 设计，为 CrabPaw 提供：
 * - 任务执行后的自动分析
 * - LLM 评估技能表现，生成进化建议
 * - 三类进化建议：FIX（修复）、DERIVED（增强）、CAPTURED（捕获新模式）
 * - 与 SkillQualityTracker 联动，注入语义评估
 *
 * 闭环流程：
 *   执行完成 → recordExecution → analyzeExecution → 生成 EvolutionSuggestion
 *   → SkillEvolver.processSuggestion → 技能进化
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const { getQualityTracker } = require('./skill-quality-tracker');

const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');
const ANALYSIS_HISTORY_FILE = path.join(ANALYSIS_DIR, 'history.json');
const MAX_HISTORY = 200;
const MAX_CONVERSATION_CHARS = 40000;

const EvolutionType = {
  FIX: 'fix',
  DERIVED: 'derived',
  CAPTURED: 'captured',
};

class EvolutionSuggestion {
  constructor({ type, targetSkillIds, reason, suggestedChanges, priority = 'medium' }) {
    this.type = type;
    this.targetSkillIds = targetSkillIds || [];
    this.reason = reason;
    this.suggestedChanges = suggestedChanges || '';
    this.priority = priority;
    this.createdAt = new Date().toISOString();
  }
}

class ExecutionAnalysis {
  constructor({ skillName, success, durationMs, error, conversationLog, suggestions = [] }) {
    this.skillName = skillName;
    this.success = success;
    this.durationMs = durationMs;
    this.error = error;
    this.conversationLog = conversationLog || '';
    this.suggestions = suggestions;
    this.analyzedAt = new Date().toISOString();
  }
}

class ExecutionAnalyzer {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      analysisInterval: config.analysisInterval || 5, // 每 N 次执行分析一次
      maxSuggestionsPerAnalysis: config.maxSuggestionsPerAnalysis || 3,
      autoEvolve: config.autoEvolve || false,
      ...config,
    };

    this._executionCount = 0;
    this._history = [];
    this._pendingSuggestions = [];
    this._processingPending = false;
    this._llmClient = null;
    this._evolver = null;
    this._initialized = false;
  }

  initialize({ llmClient, evolver, autoEvolve } = {}) {
    this._llmClient = llmClient || null;
    this._evolver = evolver || null;
    if (autoEvolve !== undefined) {
      this.config.autoEvolve = autoEvolve;
    }

    if (!fs.existsSync(ANALYSIS_DIR)) {
      fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    }

    this._loadHistory();
    this._initialized = true;
    console.log('[ExecutionAnalyzer] 初始化完成');
  }

  setLLMClient(client) {
    this._llmClient = client;
  }

  setEvolver(evolver) {
    this._evolver = evolver;
  }

  /**
   * 记录执行并触发分析（核心入口）
   * 在 skill-executor 完成后调用
   */
  async onExecutionComplete({ skillName, success, durationMs, error, result, conversationLog }) {
    if (!this._initialized) return;

    // 1. 记录到质量追踪器
    const tracker = getQualityTracker();
    tracker.recordExecution(skillName, { success, durationMs, error });

    // 2. 累计执行计数
    this._executionCount++;

    // 3. 快速规则检查（无需 LLM）
    const ruleBasedSuggestions = this._ruleBasedAnalysis(skillName, { success, durationMs, error });

    if (ruleBasedSuggestions.length > 0) {
      this._pendingSuggestions.push(...ruleBasedSuggestions);
      this._processPendingSuggestions();
    }

    // 4. 定期 LLM 深度分析
    if (this._executionCount % this.config.analysisInterval === 0) {
      await this._llmAnalysis(skillName, { success, durationMs, error, result, conversationLog });
    }

    // 5. 保存分析历史
    this._saveAnalysis(new ExecutionAnalysis({
      skillName, success, durationMs, error,
      conversationLog: (conversationLog || '').substring(0, MAX_CONVERSATION_CHARS),
      suggestions: ruleBasedSuggestions,
    }));
  }

  /**
   * 规则驱动分析（无需 LLM，快速响应）
   */
  // eslint-disable-next-line no-unused-vars
  _ruleBasedAnalysis(skillName, { success, durationMs, error }) {
    const suggestions = [];
    const tracker = getQualityTracker();
    const report = tracker.getQualityReport(skillName);

    if (!report) return suggestions;

    // 规则1: 连续失败 → FIX 建议
    if (report.consecutiveFailures >= 3) {
      suggestions.push(new EvolutionSuggestion({
        type: EvolutionType.FIX,
        targetSkillIds: [skillName],
        reason: `技能 ${skillName} 连续失败 ${report.consecutiveFailures} 次，最近成功率 ${(report.recentSuccessRate * 100).toFixed(1)}%`,
        suggestedChanges: '检查技能指令是否过时、依赖是否可用、错误处理是否完善',
        priority: 'high',
      }));
    }

    // 规则2: 整体成功率低 → FIX 建议
    if (report.totalCalls >= 5 && report.successRate < 0.5) {
      suggestions.push(new EvolutionSuggestion({
        type: EvolutionType.FIX,
        targetSkillIds: [skillName],
        reason: `技能 ${skillName} 整体成功率 ${(report.successRate * 100).toFixed(1)}%，低于 50% 阈值`,
        suggestedChanges: '审查技能步骤，优化关键路径，增加错误恢复机制',
        priority: 'medium',
      }));
    }

    // 规则3: 执行超时频繁 → FIX 建议
    if (report.totalCalls >= 3 && report.avgExecutionTimeMs > 30000) {
      suggestions.push(new EvolutionSuggestion({
        type: EvolutionType.FIX,
        targetSkillIds: [skillName],
        reason: `技能 ${skillName} 平均执行时间 ${(report.avgExecutionTimeMs / 1000).toFixed(1)}s，可能存在性能问题`,
        suggestedChanges: '优化执行步骤，减少不必要的等待，增加超时处理',
        priority: 'low',
      }));
    }

    // 规则4: 高频使用但无错误处理 → DERIVED 建议
    if (report.totalCalls >= 10 && report.successRate > 0.8) {
      // 成功率高且使用频繁，可以增强
      suggestions.push(new EvolutionSuggestion({
        type: EvolutionType.DERIVED,
        targetSkillIds: [skillName],
        reason: `技能 ${skillName} 使用频繁 (${report.totalCalls}次) 且成功率 ${(report.successRate * 100).toFixed(1)}%，可考虑增强`,
        suggestedChanges: '增加高级功能、优化输出格式、添加更多示例',
        priority: 'low',
      }));
    }

    return suggestions;
  }

  /**
   * LLM 深度分析（需要 LLM 客户端）
   */
  async _llmAnalysis(skillName, { success, durationMs, error, result, conversationLog }) {
    if (!this._llmClient) return;

    try {
      const tracker = getQualityTracker();
      const report = tracker.getQualityReport(skillName);

      const prompt = this._buildAnalysisPrompt(skillName, {
        success, durationMs, error, result, conversationLog, report,
      });

      const response = await this._callLLM(prompt);
      if (!response) return;

      const suggestions = this._parseLLMResponse(response, skillName);

      if (suggestions.length > 0) {
        this._pendingSuggestions.push(...suggestions);

        // 注入 LLM 语义评估到质量追踪器
        for (const s of suggestions) {
          if (s.type === EvolutionType.FIX) {
            tracker.addLLMFlag(skillName, s.reason);
          }
        }

        this._processPendingSuggestions();
      }
    } catch (e) {
      console.error('[ExecutionAnalyzer] LLM 分析失败:', e.message);
    }
  }

  _buildAnalysisPrompt(skillName, { success, durationMs, error, result, conversationLog, report }) {
    const parts = [
      `## 技能执行分析任务`,
      ``,
      `请分析以下技能的执行情况，判断是否需要进化改进。`,
      ``,
      `### 技能名称: ${skillName}`,
      `### 执行结果: ${success ? '成功' : '失败'}`,
    ];

    if (error) parts.push(`### 错误信息: ${String(error).substring(0, 1000)}`);
    if (durationMs) parts.push(`### 执行耗时: ${(durationMs / 1000).toFixed(1)}s`);
    if (result) parts.push(`### 输出摘要: ${String(result).substring(0, 2000)}`);

    if (report) {
      parts.push('');
      parts.push('### 历史统计:');
      parts.push(`- 总调用: ${report.totalCalls} 次`);
      parts.push(`- 成功率: ${(report.successRate * 100).toFixed(1)}%`);
      parts.push(`- 最近成功率: ${(report.recentSuccessRate * 100).toFixed(1)}%`);
      parts.push(`- 连续失败: ${report.consecutiveFailures} 次`);
      parts.push(`- 平均耗时: ${(report.avgExecutionTimeMs / 1000).toFixed(1)}s`);
      parts.push(`- LLM 标记: ${report.llmFlaggedCount} 次`);
    }

    if (conversationLog) {
      parts.push('');
      parts.push('### 对话日志 (截断):');
      parts.push(conversationLog.substring(0, MAX_CONVERSATION_CHARS));
    }

    parts.push('');
    parts.push('### 进化类型说明:');
    parts.push('- fix: 修复损坏/过时的技能指令');
    parts.push('- derived: 增强现有技能（添加功能、优化流程）');
    parts.push('- captured: 捕获新的可复用模式（当没有现有技能匹配时）');
    parts.push('');
    parts.push('### 输出格式 (JSON):');
    parts.push('```json');
    parts.push('{');
    parts.push('  "needs_evolution": true/false,');
    parts.push('  "suggestions": [');
    parts.push('    {');
    parts.push('      "type": "fix|derived|captured",');
    parts.push('      "target_skill": "技能名",');
    parts.push('      "reason": "进化原因",');
    parts.push('      "suggested_changes": "具体建议",');
    parts.push('      "priority": "high|medium|low"');
    parts.push('    }');
    parts.push('  ]');
    parts.push('}');
    parts.push('```');

    return parts.join('\n');
  }

  _parseLLMResponse(response, defaultSkillName) {
    try {
      // 提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.needs_evolution || !parsed.suggestions) return [];

      return parsed.suggestions.slice(0, this.config.maxSuggestionsPerAnalysis).map(s => new EvolutionSuggestion({
        type: s.type || EvolutionType.FIX,
        targetSkillIds: [s.target_skill || defaultSkillName],
        reason: s.reason || '',
        suggestedChanges: s.suggested_changes || '',
        priority: s.priority || 'medium',
      }));
    } catch {
      return [];
    }
  }

  async _callLLM(prompt) {
    if (!this._llmClient) return null;

    try {
      if (typeof this._llmClient.chat === 'function') {
        const result = await this._llmClient.chat({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2000,
        });
        return result?.content || result?.choices?.[0]?.message?.content || null;
      }

      if (typeof this._llmClient.complete === 'function') {
        return await this._llmClient.complete(prompt);
      }

      return null;
    } catch (e) {
      console.error('[ExecutionAnalyzer] LLM 调用失败:', e.message);
      return null;
    }
  }

  /**
   * 处理待执行的进化建议（串行执行，避免并发失控）
   */
  async _processPendingSuggestions() {
    if (!this._evolver || !this.config.autoEvolve) return;
    if (this._processingPending) return; // 防止重入
    this._processingPending = true;

    try {
      while (this._pendingSuggestions.length > 0) {
        const suggestion = this._pendingSuggestions.shift();
        try {
          await this._evolver.processSuggestion(suggestion);
        } catch (e) {
          console.error('[ExecutionAnalyzer] 进化执行失败:', e.message);
        }
      }
    } finally {
      this._processingPending = false;
    }
  }

  /**
   * 获取待处理的进化建议
   */
  getPendingSuggestions() {
    return [...this._pendingSuggestions];
  }

  /**
   * 获取分析历史
   */
  getHistory(skillName, limit = 20) {
    if (skillName) {
      return this._history
        .filter(h => h.skillName === skillName)
        .slice(-limit);
    }
    return this._history.slice(-limit);
  }

  _loadHistory() {
    try {
      if (fs.existsSync(ANALYSIS_HISTORY_FILE)) {
        this._history = JSON.parse(fs.readFileSync(ANALYSIS_HISTORY_FILE, 'utf-8'));
      }
    } catch {
      this._history = [];
    }
  }

  _saveAnalysis(analysis) {
    this._history.push(analysis);
    if (this._history.length > MAX_HISTORY) {
      this._history = this._history.slice(-MAX_HISTORY);
    }

    try {
      if (!fs.existsSync(ANALYSIS_DIR)) {
        fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
      }
      fs.writeFileSync(ANALYSIS_HISTORY_FILE, JSON.stringify(this._history, null, 2), 'utf-8');
    } catch (e) {
      console.error('[ExecutionAnalyzer] 保存分析历史失败:', e.message);
    }
  }

  shutdown() {
    // 处理剩余建议
    if (this._pendingSuggestions.length > 0 && this._evolver) {
      console.log(`[ExecutionAnalyzer] 关闭前处理 ${this._pendingSuggestions.length} 条待处理建议`);
      this._processPendingSuggestions();
    }
  }
}

// 单例
let _instance = null;

function getExecutionAnalyzer() {
  if (!_instance) {
    _instance = new ExecutionAnalyzer();
  }
  return _instance;
}

module.exports = {
  ExecutionAnalyzer,
  getExecutionAnalyzer,
  EvolutionSuggestion,
  ExecutionAnalysis,
  EvolutionType,
};
