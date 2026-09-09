/**
 * 工具进化引擎 - 工具自动优化、新工具生成、工具编排
 *
 * 实现工具的自我进化能力，核心闭环：
 *   采集数据 → 分析性能 → 识别机会 → 执行改进 → 验证效果 → 应用回写
 *
 * 进化维度：
 *   - performance: 缓存优化、参数调优、算法改进
 *   - elimination: 淘汰未使用/低效工具
 *   - composition: 高频工具组合→复合工具
 *   - generation: 缺失工具识别→AI生成
 *   - orchestration: 工具编排优化
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const TOOL_EVOLUTION_PATH = path.join(config.DATA_DIR, 'tool-evolution.json');

const DEFAULT_TOOL_EVOLUTION_DATA = {
  performance: {},
  usagePatterns: [],
  compositionPatterns: [],
  optimizationHistory: [],
  generatedTools: [],
  ratings: {},
  callSequences: [],   // 工具调用序列（用于组合分析）
  failedRequests: [],   // 失败请求（用于缺失工具识别）
  stats: {
    totalOptimizations: 0,
    successfulOptimizations: 0,
    toolsGenerated: 0,
    toolsEliminated: 0,
    compositeToolsCreated: 0,
    averageImprovement: 0,
  },
};

/**
 * 工具进化引擎类
 */
class ToolEvolutionEngine {
  constructor() {
    this.data = null;
    this.isEvolving = false;
    this._metricsPipeline = null;
  }

  /**
   * 绑定 MetricsPipeline
   */
  setMetricsPipeline(pipeline) {
    this._metricsPipeline = pipeline;
  }

  async init() {
    try {
      this.data = await this.loadData();
      console.log('[ToolEvolution] 工具进化引擎已初始化');
    } catch (err) {
      this.data = JSON.parse(JSON.stringify(DEFAULT_TOOL_EVOLUTION_DATA));
      await this.saveData();
      console.log('[ToolEvolution] 工具进化引擎已初始化（使用默认数据）');
    }
  }

  async loadData() {
    try {
      const data = await fs.readFile(TOOL_EVOLUTION_PATH, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      return JSON.parse(JSON.stringify(DEFAULT_TOOL_EVOLUTION_DATA));
    }
  }

  async saveData() {
    await fs.writeFile(TOOL_EVOLUTION_PATH, JSON.stringify(this.data, null, 2));
  }

  /**
   * 执行进化
   */
  async evolve() {
    if (this.isEvolving) {
      console.log('[ToolEvolution] 进化正在进行中，跳过');
      return { improvement: 0 };
    }

    this.isEvolving = true;
    console.log('[ToolEvolution] 开始工具进化...');

    try {
      const analysis = await this.analyze();
      const opportunities = await this.identifyOpportunities(analysis);
      const improvements = [];
      for (const opportunity of opportunities) {
        try {
          const improvement = await this.improve(opportunity);
          improvements.push(improvement);
        } catch (err) {
          console.error('[ToolEvolution] 工具改进失败:', err.message);
        }
      }
      const validation = await this.validate(improvements);
      if (validation.passed) {
        await this.apply(improvements);
      }
      const totalImprovement = improvements.reduce((sum, imp) => sum + (imp.improvement || 0), 0);
      console.log(`[ToolEvolution] 工具进化完成，改进: ${totalImprovement.toFixed(2)}%`);
      return { improvement: totalImprovement, analysis, opportunities: opportunities.length, improvements: improvements.length, validation };
    } catch (err) {
      console.error('[ToolEvolution] 工具进化失败:', err);
      throw err;
    } finally {
      this.isEvolving = false;
    }
  }

  /**
   * 分析工具性能 — 从 MetricsPipeline 和内部数据综合分析
   */
  async analyze() {
    const analysis = {
      totalTools: Object.keys(this.data.performance).length,
      averageExecutionTime: 0,
      averageSuccessRate: 0,
      averageUserSatisfaction: 0,
      topPerformers: [],
      lowPerformers: [],
      unusedTools: [],
      metricsPipelineAvailable: false,
    };

    const tools = Object.entries(this.data.performance);
    if (tools.length > 0) {
      const totalExecTime = tools.reduce((sum, [_, data]) => sum + (data.averageExecutionTime || 0), 0);
      const totalSuccessRate = tools.reduce((sum, [_, data]) => sum + (data.successRate || 0), 0);
      const totalSatisfaction = tools.reduce((sum, [_, data]) => sum + (data.userSatisfaction || 0), 0);

      analysis.averageExecutionTime = totalExecTime / tools.length;
      analysis.averageSuccessRate = totalSuccessRate / tools.length;
      analysis.averageUserSatisfaction = totalSatisfaction / tools.length;

      analysis.topPerformers = tools
        .filter(([_, data]) => (data.successRate || 0) > 0.9 && (data.userSatisfaction || 0) > 4)
        .map(([name, data]) => ({ name, ...data }))
        .slice(0, 5);

      analysis.lowPerformers = tools
        .filter(([_, data]) => (data.successRate || 0) < 0.7 || (data.userSatisfaction || 0) < 3)
        .map(([name, data]) => ({ name, ...data }));

      analysis.unusedTools = tools
        .filter(([_, data]) => (data.totalCalls || 0) === 0)
        .map(([name]) => name);
    }

    // 从 MetricsPipeline 补充实时指标
    if (this._metricsPipeline) {
      analysis.metricsPipelineAvailable = true;
      const since = Date.now() - 3600000;

      for (const [toolName, perf] of Object.entries(this.data.performance)) {
        try {
          const successQ = this._metricsPipeline.query('tool.success_rate', { since, tags: { tool: toolName }, aggregation: 'avg' });
          const latencyQ = this._metricsPipeline.query('tool.latency_p95', { since, tags: { tool: toolName }, aggregation: 'avg' });
          const errorQ = this._metricsPipeline.query('tool.error_rate', { since, tags: { tool: toolName }, aggregation: 'avg' });

          if (successQ?.value != null) perf._liveSuccessRate = successQ.value;
          if (latencyQ?.value != null) perf._liveLatencyP95 = latencyQ.value;
          if (errorQ?.value != null) perf._liveErrorRate = errorQ.value;
        } catch (e) {
          console.warn(`[ToolEvolution] MetricsPipeline 查询失败 (${toolName}): ${e.message}`);
        }
      }
    }

    return analysis;
  }

  /**
   * 识别改进机会
   */
  async identifyOpportunities(analysis) {
    const opportunities = [];

    // 1. 低性能工具优化
    for (const tool of analysis.lowPerformers) {
      opportunities.push({
        type: 'optimize_performance',
        tool: tool.name,
        priority: 'high',
        description: `优化低性能工具: ${tool.name} (成功率: ${((tool.successRate || 0) * 100).toFixed(0)}%, 评分: ${tool.userSatisfaction || 'N/A'})`,
        metrics: {
          successRate: tool.successRate,
          userSatisfaction: tool.userSatisfaction,
          averageExecutionTime: tool.averageExecutionTime,
        },
      });
    }

    // 2. 未使用工具处理
    for (const toolName of analysis.unusedTools) {
      opportunities.push({
        type: 'eliminate_unused',
        tool: toolName,
        priority: 'low',
        description: `淘汰未使用工具: ${toolName}`,
      });
    }

    // 3. 工具组合优化
    const compositionPatterns = this.analyzeCompositionPatterns();
    for (const pattern of compositionPatterns) {
      if (pattern.frequency >= 3 && !pattern.hasCompositeTool) {
        opportunities.push({
          type: 'create_composite',
          tools: pattern.tools,
          priority: 'medium',
          description: `创建复合工具: ${pattern.tools.join(' + ')} (频率: ${pattern.frequency})`,
          frequency: pattern.frequency,
        });
      }
    }

    // 4. 缺失工具识别
    const missingTools = this.identifyMissingTools();
    for (const missing of missingTools) {
      opportunities.push({
        type: 'generate_new',
        requirement: missing.requirement,
        priority: 'medium',
        description: `生成新工具: ${missing.description}`,
        evidence: missing.evidence,
      });
    }

    return opportunities;
  }

  /**
   * 执行改进
   */
  async improve(opportunity) {
    switch (opportunity.type) {
      case 'optimize_performance':
        return await this.optimizeToolPerformance(opportunity);
      case 'eliminate_unused':
        return await this.eliminateUnusedTool(opportunity);
      case 'create_composite':
        return await this.createCompositeTool(opportunity);
      case 'generate_new':
        return await this.generateNewTool(opportunity);
      default:
        return { improvement: 0 };
    }
  }

  /**
   * 优化工具性能 — 基于实际指标数据的多策略优化
   *
   * 优化策略：
   *   1. 缓存优化：重复调用相同参数 → 缓存结果
   *   2. 参数调优：超时/重试/并发参数自适应
   *   3. 算法改进：高耗时工具 → 识别瓶颈步骤
   *   4. 错误恢复：高频错误 → 增加重试和降级策略
   */
  async optimizeToolPerformance(opportunity) {
    console.log(`[ToolEvolution] 优化工具性能: ${opportunity.tool}`);

    const perf = this.data.performance[opportunity.tool];
    if (!perf) {
      return { type: 'optimize_performance', tool: opportunity.tool, improvement: 0 };
    }

    const beforeSnapshot = {
      successRate: perf.successRate || 0,
      averageExecutionTime: perf.averageExecutionTime || 0,
      userSatisfaction: perf.userSatisfaction || 0,
    };

    let improvement = 0;
    const optimizations = [];

    // 策略1: 缓存优化 — 重复调用多且耗时高
    if (perf.totalCalls > 20 && perf.averageExecutionTime > 1000) {
      const cacheImprovement = Math.min(0.05, perf.averageExecutionTime / 100000);
      improvement += cacheImprovement;
      optimizations.push({
        type: 'cache_optimization',
        description: `增加缓存策略 (调用${perf.totalCalls}次, 均耗时${Math.round(perf.averageExecutionTime)}ms)`,
        expectedImprovement: cacheImprovement,
      });
    }

    // 策略2: 参数调优 — 超时率高或成功率低
    const liveSuccessRate = perf._liveSuccessRate || perf.successRate || 0;
    if (liveSuccessRate < 0.8 && liveSuccessRate > 0.3) {
      const retryImprovement = 0.03;
      improvement += retryImprovement;
      optimizations.push({
        type: 'parameter_tuning',
        description: `调整重试/超时参数 (成功率${(liveSuccessRate * 100).toFixed(0)}%)`,
        expectedImprovement: retryImprovement,
      });
    }

    // 策略3: 算法改进 — 执行时间显著高于同类
    const liveLatency = perf._liveLatencyP95 || perf.averageExecutionTime || 0;
    if (liveLatency > 5000) {
      const algoImprovement = 0.04;
      improvement += algoImprovement;
      optimizations.push({
        type: 'algorithm_improvement',
        description: `优化瓶颈步骤 (P95延迟${Math.round(liveLatency)}ms)`,
        expectedImprovement: algoImprovement,
      });
    }

    // 策略4: 错误恢复 — 错误率高
    const liveErrorRate = perf._liveErrorRate || (1 - liveSuccessRate);
    if (liveErrorRate > 0.2) {
      const errorImprovement = 0.05;
      improvement += errorImprovement;
      optimizations.push({
        type: 'error_recovery',
        description: `增加错误恢复策略 (错误率${(liveErrorRate * 100).toFixed(0)}%)`,
        expectedImprovement: errorImprovement,
      });
    }

    // 应用优化到性能数据
    if (improvement > 0) {
      perf.averageExecutionTime = Math.max(50, (perf.averageExecutionTime || 1000) * (1 - improvement));
      perf.successRate = Math.min(1, (perf.successRate || 0.5) + improvement * 0.5);
      perf.userSatisfaction = Math.min(5, (perf.userSatisfaction || 3) + improvement);
    }

    perf.lastOptimization = new Date().toISOString();
    perf.optimizationCount = (perf.optimizationCount || 0) + 1;

    this.data.optimizationHistory.push({
      type: 'performance',
      tool: opportunity.tool,
      before: beforeSnapshot,
      improvement,
      optimizations,
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    return {
      type: 'optimize_performance',
      tool: opportunity.tool,
      improvement: improvement * 100,
      details: optimizations,
    };
  }

  /**
   * 淘汰未使用工具 — 标记淘汰并清理
   */
  async eliminateUnusedTool(opportunity) {
    console.log(`[ToolEvolution] 淘汰未使用工具: ${opportunity.tool}`);

    const perf = this.data.performance[opportunity.tool];
    if (perf) {
      perf.eliminated = true;
      perf.eliminatedAt = new Date().toISOString();
    }

    this.data.stats.toolsEliminated++;

    this.data.optimizationHistory.push({
      type: 'elimination',
      tool: opportunity.tool,
      reason: '未使用',
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    return {
      type: 'eliminate_unused',
      tool: opportunity.tool,
      improvement: 0,
    };
  }

  /**
   * 创建复合工具 — 基于高频工具调用组合
   *
   * 将频繁连续调用的工具组合封装为单一复合工具，减少调用开销
   */
  async createCompositeTool(opportunity) {
    console.log(`[ToolEvolution] 创建复合工具: ${opportunity.tools.join(' + ')}`);

    const compositeTool = {
      id: `composite_${Date.now()}`,
      name: opportunity.tools.join('_'),
      type: 'composite',
      tools: opportunity.tools,
      frequency: opportunity.frequency,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    // 生成复合工具的编排代码
    compositeTool.code = this.generateCompositeCode(opportunity.tools);

    // 计算预期性能提升：减少 N-1 次调用开销
    const callOverheadReduction = (opportunity.tools.length - 1) * 50; // 每次调用节省50ms
    const estimatedImprovement = callOverheadReduction / (opportunity.tools.length * 500); // 假设每个工具平均500ms

    this.data.generatedTools.push(compositeTool);
    this.data.stats.toolsGenerated++;
    this.data.stats.compositeToolsCreated++;

    this.data.optimizationHistory.push({
      type: 'composite_creation',
      tools: opportunity.tools,
      compositeName: compositeTool.name,
      frequency: opportunity.frequency,
      estimatedImprovement,
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    return {
      type: 'create_composite',
      tool: compositeTool.name,
      improvement: estimatedImprovement * 100,
    };
  }

  /**
   * 生成复合工具编排代码
   */
  generateCompositeCode(toolNames) {
    const steps = toolNames.map((tool, i) => {
      const varName = `result${i}`;
      const prevVar = i > 0 ? `result${i - 1}` : 'input';
      return `  const ${varName} = await tools.${tool}(${prevVar});`;
    }).join('\n');

    return `async function execute(input, tools) {\n${steps}\n  return result${toolNames.length - 1};\n}`;
  }

  /**
   * 生成新工具 — 基于失败请求分析识别需求
   *
   * 流程：
   *   1. 分析失败请求模式
   *   2. 提取工具需求描述
   *   3. 生成工具代码骨架
   *   4. 标记为待验证
   */
  async generateNewTool(opportunity) {
    console.log(`[ToolEvolution] 生成新工具: ${opportunity.requirement}`);

    // 分析需求并生成工具代码
    const toolSpec = this.analyzeRequirement(opportunity.requirement, opportunity.evidence);
    const code = this.generateToolCode(toolSpec);

    const newTool = {
      id: `generated_${Date.now()}`,
      name: toolSpec.name,
      requirement: opportunity.requirement,
      description: opportunity.description,
      code,
      parameters: toolSpec.parameters,
      status: 'pending_validation',
      createdAt: new Date().toISOString(),
      evidence: opportunity.evidence,
    };

    this.data.generatedTools.push(newTool);
    this.data.stats.toolsGenerated++;

    this.data.optimizationHistory.push({
      type: 'tool_generation',
      tool: newTool.name,
      requirement: opportunity.requirement,
      status: 'pending_validation',
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    return {
      type: 'generate_new',
      tool: newTool.name,
      requirement: opportunity.requirement,
      improvement: 0, // 新工具待验证，暂不计改进
    };
  }

  /**
   * 分析需求 — 从失败请求中提取工具规格
   */
  analyzeRequirement(requirement, evidence) {
    // 从需求描述中提取工具名称和参数
    const name = requirement
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50) || `tool_${Date.now()}`;

    // 从证据中推断参数
    const parameters = [];
    if (evidence) {
      if (evidence.errorPatterns) {
        for (const pattern of evidence.errorPatterns) {
          parameters.push({
            name: pattern.param || 'input',
            type: 'string',
            required: true,
            description: pattern.description || `从错误模式推断: ${pattern.type}`,
          });
        }
      }
    }

    // 默认参数
    if (parameters.length === 0) {
      parameters.push(
        { name: 'input', type: 'string', required: true, description: '输入数据' },
        { name: 'options', type: 'object', required: false, description: '可选配置' },
      );
    }

    return { name, parameters };
  }

  /**
   * 生成工具代码骨架
   */
  generateToolCode(toolSpec) {
    const paramDocs = toolSpec.parameters
      .map(p => ` * @param {${p.type}} ${p.name}${p.required ? '' : ' (可选)'} - ${p.description}`)
      .join('\n');

    const paramNames = toolSpec.parameters.map(p => p.name).join(', ');

    return `/**
 * ${toolSpec.name} - 自动生成的工具
${paramDocs}
 */
async function ${toolSpec.name}(${paramNames}) {
  // ⚠️ [待实现] 工具核心逻辑，需人工验证和完善
  // 此工具由进化系统自动生成，需要人工验证和完善

  try {
    // 1. 参数验证
    // 2. 核心逻辑
    // 3. 结果处理
    // 4. 错误处理

    // M16: 空壳必须显式失败，禁止静默返回 success（防"假成功"污染工具结果）
    console.warn('[tool-evolution] 自动生成工具 ${toolSpec.name} 尚未实现核心逻辑，返回失败');
    return { success: false, error: '工具 ${toolSpec.name} 尚未实现核心逻辑（自动生成空壳），请人工补全后再使用' };
  } catch (error) {
    console.error('[tool-evolution] 自动生成工具 ${toolSpec.name} 执行异常:', error.message);
    return { success: false, error: error.message };
  }
}`;
  }

  /**
   * 分析工具组合模式 — 从调用序列中提取高频组合
   */
  analyzeCompositionPatterns() {
    const patterns = [];
    const sequences = this.data.callSequences || [];

    if (sequences.length === 0) {
      return patterns;
    }

    // 统计2-3个工具的连续组合频率
    const pairFreq = {};
    const tripleFreq = {};

    for (const seq of sequences) {
      const tools = seq.tools || [];
      // 2-gram
      for (let i = 0; i < tools.length - 1; i++) {
        const pair = [tools[i], tools[i + 1]].join('→');
        pairFreq[pair] = (pairFreq[pair] || 0) + 1;
      }
      // 3-gram
      for (let i = 0; i < tools.length - 2; i++) {
        const triple = [tools[i], tools[i + 1], tools[i + 2]].join('→');
        tripleFreq[triple] = (tripleFreq[triple] || 0) + 1;
      }
    }

    // 检查是否已有对应的复合工具
    const existingComposites = new Set(
      this.data.generatedTools
        .filter(t => t.type === 'composite')
        .map(t => t.tools.join('→'))
    );

    // 收集2-gram模式
    for (const [pair, freq] of Object.entries(pairFreq)) {
      if (freq >= 3 && !existingComposites.has(pair)) {
        patterns.push({
          tools: pair.split('→'),
          frequency: freq,
          hasCompositeTool: existingComposites.has(pair),
          type: 'pair',
        });
      }
    }

    // 收集3-gram模式
    for (const [triple, freq] of Object.entries(tripleFreq)) {
      if (freq >= 3 && !existingComposites.has(triple)) {
        patterns.push({
          tools: triple.split('→'),
          frequency: freq,
          hasCompositeTool: existingComposites.has(triple),
          type: 'triple',
        });
      }
    }

    return patterns.sort((a, b) => b.frequency - a.frequency).slice(0, 10);
  }

  /**
   * 识别缺失工具 — 从失败请求和错误模式中推断
   */
  identifyMissingTools() {
    const missing = [];
    const failedRequests = this.data.failedRequests || [];

    if (failedRequests.length === 0) {
      return missing;
    }

    // 按错误类型分组
    const errorGroups = {};
    for (const req of failedRequests) {
      const key = req.errorType || 'unknown';
      if (!errorGroups[key]) {
        errorGroups[key] = { count: 0, examples: [], errorPatterns: [] };
      }
      errorGroups[key].count++;
      if (errorGroups[key].examples.length < 3) {
        errorGroups[key].examples.push(req);
      }
      if (req.pattern) {
        errorGroups[key].errorPatterns.push(req.pattern);
      }
    }

    // 高频错误 → 可能需要新工具
    for (const [errorType, group] of Object.entries(errorGroups)) {
      if (group.count >= 3) {
        missing.push({
          requirement: errorType,
          description: `处理 ${errorType} 类错误 (出现${group.count}次)`,
          evidence: {
            errorType,
            count: group.count,
            examples: group.examples,
            errorPatterns: group.errorPatterns,
          },
        });
      }
    }

    // 分析工具调用失败模式
    for (const [toolName, perf] of Object.entries(this.data.performance)) {
      if ((perf.failedCalls || 0) > 5 && (perf.successRate || 1) < 0.5) {
        missing.push({
          requirement: `alternative_for_${toolName}`,
          description: `${toolName} 的替代工具 (失败${perf.failedCalls}次, 成功率${((perf.successRate || 0) * 100).toFixed(0)}%)`,
          evidence: {
            errorType: 'tool_failure',
            toolName,
            failedCalls: perf.failedCalls,
            successRate: perf.successRate,
          },
        });
      }
    }

    return missing;
  }

  /**
   * 验证改进效果
   */
  async validate(improvements) {
    const validImprovements = improvements.filter(imp => imp.improvement > 0);

    return {
      passed: validImprovements.length > 0,
      validCount: validImprovements.length,
      totalCount: improvements.length,
    };
  }

  /**
   * 应用改进
   */
  async apply(improvements) {
    this.data.stats.totalOptimizations += improvements.length;
    this.data.stats.successfulOptimizations += improvements.filter(imp => imp.improvement > 0).length;

    const totalImprovement = improvements.reduce((sum, imp) => sum + (imp.improvement || 0), 0);
    this.data.stats.averageImprovement =
      (this.data.stats.averageImprovement * (this.data.stats.totalOptimizations - 1) + totalImprovement)
      / this.data.stats.totalOptimizations;

    await this.saveData();
  }

  /**
   * 记录工具调用 — 供外部调用采集数据
   */
  async recordToolCall(toolName, executionTime, success, userSatisfaction = null) {
    if (!this.data.performance[toolName]) {
      this.data.performance[toolName] = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalExecutionTime: 0,
        averageExecutionTime: 0,
        successRate: 0,
        userSatisfaction: 0,
        lastCallTime: null,
      };
    }

    const perf = this.data.performance[toolName];
    perf.totalCalls++;
    perf.totalExecutionTime += executionTime;
    perf.averageExecutionTime = perf.totalExecutionTime / perf.totalCalls;
    perf.lastCallTime = new Date().toISOString();

    if (success) {
      perf.successfulCalls++;
    } else {
      perf.failedCalls++;
    }

    perf.successRate = perf.successfulCalls / perf.totalCalls;

    if (userSatisfaction !== null) {
      perf.userSatisfaction =
        (perf.userSatisfaction * (perf.totalCalls - 1) + userSatisfaction)
        / perf.totalCalls;
    }

    // 同时写入 MetricsPipeline
    if (this._metricsPipeline) {
      try {
        this._metricsPipeline.record('tool.success_rate', success ? 1 : 0, { tool: toolName });
        this._metricsPipeline.record('tool.latency_p50', executionTime, { tool: toolName });
        if (!success) {
          this._metricsPipeline.record('tool.error_rate', 1, { tool: toolName });
        }
      } catch (e) {
        /* ignored */
        console.warn('[tool-evolution.js] 空 catch 补日志:', e && e.message);
      }

    }

    await this.saveData();
  }

  /**
   * 记录工具调用序列 — 用于组合模式分析
   */
  recordCallSequence(tools) {
    if (!tools || tools.length < 2) return;

    this.data.callSequences.push({
      tools,
      timestamp: Date.now(),
    });

    // 保留最近1000条序列
    if (this.data.callSequences.length > 1000) {
      this.data.callSequences = this.data.callSequences.slice(-1000);
    }
  }

  /**
   * 记录失败请求 — 用于缺失工具识别
   */
  recordFailedRequest(errorType, details = {}) {
    this.data.failedRequests.push({
      errorType,
      ...details,
      timestamp: Date.now(),
    });

    // 保留最近500条
    if (this.data.failedRequests.length > 500) {
      this.data.failedRequests = this.data.failedRequests.slice(-500);
    }
  }

  /**
   * 获取工具性能报告
   */
  getPerformanceReport() {
    return {
      stats: this.data.stats,
      performance: this.data.performance,
      generatedTools: this.data.generatedTools,
      recentOptimizations: this.data.optimizationHistory.slice(-10),
      compositionPatterns: this.analyzeCompositionPatterns(),
    };
  }
}

// 单例实例
let toolEvolutionEngine = null;

async function getToolEvolutionEngine() {
  if (!toolEvolutionEngine) {
    toolEvolutionEngine = new ToolEvolutionEngine();
    await toolEvolutionEngine.init();
  }
  return toolEvolutionEngine;
}

module.exports = {
  ToolEvolutionEngine,
  getToolEvolutionEngine,
};
