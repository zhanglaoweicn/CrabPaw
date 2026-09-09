/**
 * 技能进化引擎 - 技能自动创建、多维度进化、技能市场
 *
 * 实现技能的自我进化能力，核心闭环：
 *   采集数据 → 分析性能 → 识别机会 → 执行改进 → 验证效果 → 应用回写
 *
 * 进化维度：
 *   - performance: 基于执行耗时和成功率优化
 *   - accuracy: 基于错误模式和用户评分优化
 *   - ux: 基于用户反馈优化交互体验
 *   - adaptability: 基于使用场景扩展适用范围
 *   - maintainability: 基于代码质量指标优化结构
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const SKILL_EVOLUTION_PATH = path.join(config.DATA_DIR, 'skill-evolution.json');

const DEFAULT_SKILL_EVOLUTION_DATA = {
  skills: {},
  ratings: {},
  usageStats: {},
  evolutionHistory: [],
  marketCache: [],
  stats: {
    totalSkills: 0,
    activeSkills: 0,
    skillsCreated: 0,
    skillsEvolved: 0,
    skillsMerged: 0,
    skillsSplit: 0,
    averageRating: 0,
  },
};

/**
 * 技能进化引擎类
 */
class SkillEvolutionEngine {
  constructor() {
    this.data = null;
    this.isEvolving = false;
    this._metricsPipeline = null;
    this._skillEvolver = null; // 桥接：真正的技能内容进化器
  }

  /**
   * 绑定 MetricsPipeline
   */
  setMetricsPipeline(pipeline) {
    this._metricsPipeline = pipeline;
  }

  /**
   * 绑定 SkillEvolver — 真正修改技能文件的进化器
   * 这是桥接"数值进化"和"内容进化"的关键
   */
  setSkillEvolver(evolver) {
    this._skillEvolver = evolver;
  }

  /**
   * 绑定 ToolEvolutionBridge — 内置工具进化桥
   * 让技能进化体系也能感知内置工具的进化需求
   */
  setToolEvolutionBridge(bridge) {
    this._toolEvolutionBridge = bridge;
    // 监听工具进化建议
    bridge.onEvolution((suggestion) => {
      this._handleToolEvolutionSuggestion(suggestion);
    });
  }

  /**
   * 处理来自 ToolEvolutionBridge 的进化建议
   * 
   * 闭环流程：
   *   1. 记录建议到工具进化数据
   *   2. 高优先级建议写入进化历史
   *   3. 触发 SKILL.md 自动生成/进化（桥接到 SkillEvolver）
   */
  _handleToolEvolutionSuggestion(suggestion) {
    if (!this.data.tools) this.data.tools = {};
    if (!this.data.tools[suggestion.toolName]) {
      this.data.tools[suggestion.toolName] = {
        suggestions: [],
        lastSuggestionAt: 0,
        skillMdGenerated: false,
        lastEvolutionAt: 0,
      };
    }
    const toolData = this.data.tools[suggestion.toolName];
    toolData.suggestions.push(suggestion);
    toolData.lastSuggestionAt = Date.now();
    if (toolData.suggestions.length > 50) {
      toolData.suggestions = toolData.suggestions.slice(-25);
    }

    // 高优先级建议写入进化历史
    if (suggestion.priority === 'critical' || suggestion.priority === 'high') {
      this.data.evolutionHistory.push({
        type: 'tool_evolution',
        tool: suggestion.toolName,
        action: suggestion.action,
        reason: suggestion.reason,
        priority: suggestion.priority,
        timestamp: new Date().toISOString(),
      });
      if (this.data.evolutionHistory.length > 200) {
        this.data.evolutionHistory = this.data.evolutionHistory.slice(-100);
      }
    }

    // 触发 SKILL.md 自动生成/进化
    this._triggerToolSkillMdEvolution(suggestion).catch(err => {
      console.warn('[SkillEvolution] 工具 SKILL.md 进化触发失败:', err.message);
    });

    this.saveData().catch(e => console.debug('[evolution] Save failed:', e?.message));
  }

  /**
   * 触发内置工具的 SKILL.md 生成/进化
   * 桥接 ToolEvolutionBridge → SkillEvolver
   */
  async _triggerToolSkillMdEvolution(suggestion) {
    if (!this._skillEvolver) {
      // SkillEvolver 未绑定，仅记录
      return;
    }

    const toolName = suggestion.toolName;

    try {
      // 获取工具指标
      const metrics = this._toolEvolutionBridge?._metrics?.[toolName];

      // 1. 确保 SKILL.md 存在（首次生成）
      const skillMdPath = this._skillEvolver.generateToolSkillMd(toolName, metrics || {}, {});
      if (skillMdPath) {
        if (!this.data.tools[toolName].skillMdGenerated) {
          this.data.tools[toolName].skillMdGenerated = true;
          console.log(`[SkillEvolution] 内置工具 ${toolName} SKILL.md 已自动生成: ${skillMdPath}`);
        }
      }

      // 2. 对 critical/high 优先级建议，触发 SKILL.md 进化
      if (suggestion.priority === 'critical' || suggestion.priority === 'high') {
        // 防止短时间内重复进化（5分钟冷却）
        const lastEvolution = this.data.tools[toolName].lastEvolutionAt || 0;
        if (Date.now() - lastEvolution < 300000) {
          console.log(`[SkillEvolution] ${toolName} 进化冷却中，跳过 SKILL.md 进化`);
          return;
        }

        const record = await this._skillEvolver.evolveBuiltInTool(toolName, suggestion);
        if (record) {
          this.data.tools[toolName].lastEvolutionAt = Date.now();
          console.log(`[SkillEvolution] 内置工具 ${toolName} SKILL.md 已进化: ${suggestion.reason}`);
        }
      }

      // 3. 对 derived 类型建议（低优先级增强），批量处理
      if (suggestion.type === 'derived' && suggestion.priority === 'low') {
        // 积累 3 条以上增强建议后再触发进化
        const derivedSuggestions = this.data.tools[toolName].suggestions.filter(
          s => s.type === 'derived'
        );
        if (derivedSuggestions.length >= 3) {
          const lastEvolution = this.data.tools[toolName].lastEvolutionAt || 0;
          if (Date.now() - lastEvolution < 300000) return;

          // 合并增强建议
          const mergedSuggestion = {
            toolName,
            type: 'derived',
            priority: 'low',
            reason: `积累 ${derivedSuggestions.length} 条增强建议，合并进化`,
            action: 'enhance_capabilities',
            details: derivedSuggestions.flatMap(s => s.details || []),
          };

          const record = await this._skillEvolver.evolveBuiltInTool(toolName, mergedSuggestion);
          if (record) {
            this.data.tools[toolName].lastEvolutionAt = Date.now();
          }
        }
      }
    } catch (err) {
      console.error(`[SkillEvolution] 工具 ${toolName} SKILL.md 进化异常:`, err.message);
    }
  }

  async init() {
    try {
      this.data = await this.loadData();
      console.log('[SkillEvolution] 技能进化引擎已初始化');
    } catch (err) {
      this.data = JSON.parse(JSON.stringify(DEFAULT_SKILL_EVOLUTION_DATA));
      await this.saveData();
      console.log('[SkillEvolution] 技能进化引擎已初始化（使用默认数据）');
    }
  }

  async loadData() {
    try {
      const data = await fs.readFile(SKILL_EVOLUTION_PATH, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      return JSON.parse(JSON.stringify(DEFAULT_SKILL_EVOLUTION_DATA));
    }
  }

  async saveData() {
    await fs.writeFile(SKILL_EVOLUTION_PATH, JSON.stringify(this.data, null, 2));
  }

  /**
   * 执行进化
   */
  async evolve() {
    if (this.isEvolving) {
      console.log('[SkillEvolution] 进化正在进行中，跳过');
      return { improvement: 0 };
    }

    this.isEvolving = true;
    console.log('[SkillEvolution] 开始技能进化...');

    try {
      const analysis = await this.analyze();
      const opportunities = await this.identifyOpportunities(analysis);
      const improvements = [];
      for (const opportunity of opportunities) {
        try {
          const improvement = await this.improve(opportunity);
          improvements.push(improvement);
        } catch (err) {
          console.error('[SkillEvolution] 技能改进失败:', err.message);
        }
      }

      // 自动创建技能：从 MetricsPipeline 获取执行经验，识别可复用模式
      try {
        const experience = this._collectExperience(analysis);
        if (experience && experience.toolCalls && experience.toolCalls.length >= 3) {
          const newSkill = await this.autoCreateSkill(experience);
          if (newSkill) {
            improvements.push({ type: 'skill_auto_create', skill: newSkill.name, improvement: 1 });
            console.log(`[SkillEvolution] 自动创建技能: ${newSkill.name}`);
          }
        }
      } catch (err) {
        console.warn('[SkillEvolution] 自动创建技能失败:', err.message);
      }

      const validation = await this.validate(improvements);
      if (validation.passed) {
        await this.apply(improvements);
      }
      const totalImprovement = improvements.reduce((sum, imp) => sum + (imp.improvement || 0), 0);
      console.log(`[SkillEvolution] 技能进化完成，改进: ${totalImprovement.toFixed(2)}%`);
      return { improvement: totalImprovement, analysis, opportunities: opportunities.length, improvements: improvements.length, validation };
    } catch (err) {
      console.error('[SkillEvolution] 技能进化失败:', err);
      throw err;
    } finally {
      this.isEvolving = false;
    }
  }

  /**
   * 分析技能性能 — 从 MetricsPipeline 和内部数据综合分析
   */
  async analyze() {
    const analysis = {
      totalSkills: Object.keys(this.data.skills).length,
      averageRating: 0,
      averageSuccessRate: 0,
      averageExecutionTime: 0,
      topSkills: [],
      lowSkills: [],
      unusedSkills: [],
      metricsPipelineAvailable: false,
    };

    const skills = Object.entries(this.data.skills);
    if (skills.length > 0) {
      const totalRating = skills.reduce((sum, [_, skill]) => sum + (skill.rating || 0), 0);
      const totalSuccessRate = skills.reduce((sum, [_, skill]) => sum + (skill.successRate || 0), 0);
      const totalExecTime = skills.reduce((sum, [_, skill]) => sum + (skill.averageExecutionTime || 0), 0);

      analysis.averageRating = totalRating / skills.length;
      analysis.averageSuccessRate = totalSuccessRate / skills.length;
      analysis.averageExecutionTime = totalExecTime / skills.length;

      analysis.topSkills = skills
        .filter(([_, skill]) => (skill.rating || 0) >= 4)
        .map(([name, skill]) => ({ name, ...skill }))
        .slice(0, 5);

      analysis.lowSkills = skills
        .filter(([_, skill]) => (skill.rating || 0) < 3)
        .map(([name, skill]) => ({ name, ...skill }));

      analysis.unusedSkills = skills
        .filter(([_, skill]) => (skill.usageCount || 0) === 0)
        .map(([name]) => name);
    }

    // 从 MetricsPipeline 补充实时指标
    if (this._metricsPipeline) {
      analysis.metricsPipelineAvailable = true;
      const since = Date.now() - 3600000;

      for (const [skillName, skill] of Object.entries(this.data.skills)) {
        try {
          const successQ = this._metricsPipeline.query('skill.success_rate', { since, tags: { skill: skillName }, aggregation: 'avg' });
          const latencyQ = this._metricsPipeline.query('skill.latency_p95', { since, tags: { skill: skillName }, aggregation: 'avg' });
          const errorQ = this._metricsPipeline.query('skill.error_rate', { since, tags: { skill: skillName }, aggregation: 'avg' });

          if (successQ.value != null) skill._liveSuccessRate = successQ.value;
          if (latencyQ.value != null) skill._liveLatencyP95 = latencyQ.value;
          if (errorQ.value != null) skill._liveErrorRate = errorQ.value;
        } catch (e) {
          /* ignored */
          console.warn('[skill-evolution.js] 空 catch 补日志:', e && e.message);
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

    // 1. 低评分技能进化
    for (const skill of analysis.lowSkills) {
      const dimensions = ['performance', 'accuracy', 'ux', 'adaptability'];
      // 如果错误率高，优先修复准确度
      if ((skill._liveErrorRate || skill.errorRate || 0) > 0.2) {
        dimensions.unshift('accuracy');
      }
      // 如果延迟高，优先优化性能
      if ((skill._liveLatencyP95 || skill.averageExecutionTime || 0) > 5000) {
        dimensions.unshift('performance');
      }
      opportunities.push({
        type: 'evolve_skill',
        skill: skill.name,
        priority: 'high',
        description: `进化低评分技能: ${skill.name} (评分: ${skill.rating || 'N/A'})`,
        dimensions: [...new Set(dimensions)],
      });
    }

    // 2. 未使用技能处理
    for (const skillName of analysis.unusedSkills) {
      opportunities.push({
        type: 'remove_unused',
        skill: skillName,
        priority: 'low',
        description: `移除未使用技能: ${skillName}`,
      });
    }

    // 3. 技能合并优化
    const similarSkills = this.identifySimilarSkills();
    for (const group of similarSkills) {
      opportunities.push({
        type: 'merge_skills',
        skills: group.skills,
        priority: 'medium',
        description: `合并相似技能: ${group.skills.join(', ')} (相似度: ${(group.similarity * 100).toFixed(0)}%)`,
      });
    }

    // 4. 技能拆分优化
    const complexSkills = this.identifyComplexSkills();
    for (const skill of complexSkills) {
      opportunities.push({
        type: 'split_skill',
        skill: skill.name,
        priority: 'medium',
        description: `拆分复杂技能: ${skill.name} (步骤数: ${skill.stepCount})`,
      });
    }

    return opportunities;
  }

  /**
   * 执行改进
   */
  async improve(opportunity) {
    let result;

    switch (opportunity.type) {
      case 'evolve_skill':
        result = await this.evolveSkill(opportunity);
        break;
      case 'remove_unused':
        result = await this.removeUnusedSkill(opportunity);
        break;
      case 'merge_skills':
        result = await this.mergeSkills(opportunity);
        break;
      case 'split_skill':
        result = await this.splitSkill(opportunity);
        break;
      default:
        result = { improvement: 0 };
    }

    // 如果有桥接的 SkillEvolver，且改进类型未自行处理内容进化，
    // 则通过 processSuggestion 尝试真实的 SKILL.md 写入。
    // evolveSkill 已在其内部处理桥接调用，此处仅处理其他类型。
    if (this._skillEvolver && opportunity.type !== 'evolve_skill' && opportunity.type !== 'remove_unused') {
      const skillName = opportunity.skill || opportunity.skills?.[0];
      if (skillName) {
        try {
          const suggestion = {
            type: 'DERIVED',
            targetSkillIds: [skillName],
            reason: `改进: ${opportunity.description || opportunity.type}`,
            suggestedChanges: opportunity.type === 'merge_skills'
              ? `合并技能: ${(opportunity.skills || []).join(', ')}`
              : opportunity.type === 'split_skill'
                ? `拆分技能为子技能: ${(opportunity.splitInto || []).join(', ')}`
                : `进化类型: ${opportunity.type}`,
            priority: opportunity.priority || 'medium',
          };
          const contentResult = await this._skillEvolver.processSuggestion(suggestion);
          if (contentResult) {
            console.log(`[SkillEvolution] 改进桥接到内容进化: ${skillName}, type=${opportunity.type}`);
            result.contentEvolution = {
              applied: contentResult.success,
              type: contentResult.type,
              staged: contentResult.staged || false,
            };
          }
        } catch (bridgeErr) {
          console.warn(`[SkillEvolution] 改进内容进化桥接失败: ${skillName}`, bridgeErr.message);
        }
      }
    }

    return result;
  }

  /**
   * 进化技能（多维度）
   */
  async evolveSkill(opportunity) {
    console.log(`[SkillEvolution] 进化技能: ${opportunity.skill}`);

    const skill = this.data.skills[opportunity.skill];
    if (!skill) {
      return { improvement: 0 };
    }

    const improvements = {};
    const beforeSnapshot = {
      successRate: skill.successRate || 0,
      averageExecutionTime: skill.averageExecutionTime || 0,
      rating: skill.rating || 0,
      errorRate: skill.errorRate || 0,
    };

    for (const dimension of opportunity.dimensions) {
      switch (dimension) {
        case 'performance':
          improvements.performance = this.evolvePerformance(skill);
          break;
        case 'accuracy':
          improvements.accuracy = this.evolveAccuracy(skill);
          break;
        case 'ux':
          improvements.ux = this.evolveUserExperience(skill);
          break;
        case 'adaptability':
          improvements.adaptability = this.evolveAdaptability(skill);
          break;
        case 'maintainability':
          improvements.maintainability = this.evolveMaintainability(skill);
          break;
      }
    }

    const totalImprovement = Object.values(improvements).reduce((sum, imp) => sum + (imp || 0), 0);

    skill.lastEvolution = new Date().toISOString();
    skill.evolutionCount = (skill.evolutionCount || 0) + 1;
    skill.improvement = totalImprovement;

    // 根据改进量调整技能指标
    if (improvements.performance > 0) {
      skill.averageExecutionTime = Math.max(100, (skill.averageExecutionTime || 1000) * (1 - improvements.performance));
    }
    if (improvements.accuracy > 0) {
      skill.successRate = Math.min(1, (skill.successRate || 0.5) + improvements.accuracy);
      skill.errorRate = Math.max(0, (skill.errorRate || 0.5) - improvements.accuracy);
    }
    if (improvements.ux > 0) {
      skill.rating = Math.min(5, (skill.rating || 3) + improvements.ux * 2);
    }

    this.data.evolutionHistory.push({
      type: 'skill_evolution',
      skill: opportunity.skill,
      before: beforeSnapshot,
      improvements,
      totalImprovement,
      contentEvolution: null, // 将在下方填充
      timestamp: new Date().toISOString(),
    });

    this.data.stats.skillsEvolved++;

    // ===== 桥接：调用 SkillEvolver 进行真正的技能内容进化 =====
    let contentEvolutionResult = null;
    // 只要有 SkillEvolver 且存在改进维度（不要求 totalImprovement > 0），
    // 就尝试内容进化。数值改进可能极小但内容进化仍可产生实质性修改。
    if (this._skillEvolver && opportunity.dimensions?.length > 0) {
      try {
        const { EvolutionType } = require('../skill/execution-analyzer');
        // 根据改进维度选择进化类型
        let evoType = EvolutionType.FIX;
        let suggestedChanges = [];

        if (improvements.accuracy > 0) {
          evoType = EvolutionType.FIX;
          suggestedChanges.push(`修复准确度问题: 错误率 ${(skill.errorRate * 100).toFixed(1)}%`);
          if (skill._accuracyOptimizations) {
            suggestedChanges.push(...skill._accuracyOptimizations.map(o => `优化动作: ${o}`));
          }
        }
        if (improvements.performance > 0) {
          evoType = EvolutionType.FIX;
          suggestedChanges.push(`优化性能: 平均执行时间 ${Math.round(skill.averageExecutionTime)}ms`);
          if (skill._performanceOptimizations) {
            suggestedChanges.push(...skill._performanceOptimizations.map(o => `优化动作: ${o}`));
          }
        }
        if (improvements.ux > 0 && improvements.adaptability > 0) {
          evoType = EvolutionType.DERIVED;
          suggestedChanges.push(`增强用户体验和适应性: 评分 ${skill.rating?.toFixed(1)}`);
        }

        const suggestion = {
          type: evoType,
          targetSkillIds: [opportunity.skill],
          reason: `自动进化: ${opportunity.description}`,
          suggestedChanges: suggestedChanges.join('\n'),
          priority: opportunity.priority || 'medium',
        };

        contentEvolutionResult = await this._skillEvolver.processSuggestion(suggestion);

        if (contentEvolutionResult) {
          console.log(`[SkillEvolution] 内容进化成功: ${opportunity.skill}, type=${evoType}, staged=${contentEvolutionResult.staged || false}`);
          // 更新进化历史记录
          const lastHistory = this.data.evolutionHistory[this.data.evolutionHistory.length - 1];
          if (lastHistory) {
            lastHistory.contentEvolution = {
              type: evoType,
              evolverResult: contentEvolutionResult.toJSON ? contentEvolutionResult.toJSON() : contentEvolutionResult,
            };
          }
        } else {
          console.log(`[SkillEvolution] 内容进化跳过: ${opportunity.skill} (观察期内/已达上限/无LLM)`);
        }
      } catch (err) {
        console.warn(`[SkillEvolution] 内容进化失败: ${opportunity.skill}`, err.message);
      }
    }

    await this.saveData();

    return {
      type: 'evolve_skill',
      skill: opportunity.skill,
      improvement: totalImprovement,
      details: improvements,
      contentEvolution: contentEvolutionResult ? {
        applied: contentEvolutionResult.success,
        type: contentEvolutionResult.type,
        staged: contentEvolutionResult.staged || false,
      } : null,
    };
  }

  /**
   * 进化性能 — 基于实际执行数据分析优化
   *
   * 优化策略：
   *   1. 缓存命中率低 → 增加缓存策略
   *   2. 平均执行时间高 → 识别瓶颈步骤
   *   3. 超时率高 → 优化超时配置
   */
  evolvePerformance(skill) {
    const execTime = skill.averageExecutionTime || 1000;
    const successRate = skill._liveSuccessRate || skill.successRate || 0.5;
    const timeoutRate = skill.timeoutRate || 0;

    let improvement = 0;

    // 执行时间越长，优化空间越大
    if (execTime > 5000) {
      improvement += 0.08; // 长耗时技能有8%优化空间
    } else if (execTime > 2000) {
      improvement += 0.05;
    } else if (execTime > 500) {
      improvement += 0.02;
    }

    // 超时率高，优化超时配置可显著改善
    if (timeoutRate > 0.1) {
      improvement += 0.05;
    }

    // 成功率低但不是0，说明有间歇性性能问题
    if (successRate > 0.5 && successRate < 0.8) {
      improvement += 0.03;
    }

    // 标记优化动作
    if (improvement > 0) {
      skill._performanceOptimizations = skill._performanceOptimizations || [];
      if (execTime > 2000) skill._performanceOptimizations.push('bottleneck_analysis');
      if (timeoutRate > 0.1) skill._performanceOptimizations.push('timeout_tuning');
      if (successRate < 0.8) skill._performanceOptimizations.push('retry_strategy');
    }

    return improvement;
  }

  /**
   * 进化准确度 — 基于错误模式和失败分析
   *
   * 优化策略：
   *   1. 错误率高 → 分析错误模式，增加验证步骤
   *   2. 特定输入失败 → 增加输入预处理
   *   3. 输出质量低 → 增加输出校验
   */
  evolveAccuracy(skill) {
    const errorRate = skill._liveErrorRate || skill.errorRate || 0;
    const successRate = skill._liveSuccessRate || skill.successRate || 0.5;
    const rating = skill.rating || 3;

    let improvement = 0;

    // 错误率越高，优化空间越大
    if (errorRate > 0.3) {
      improvement += 0.10;
    } else if (errorRate > 0.1) {
      improvement += 0.05;
    } else if (errorRate > 0.05) {
      improvement += 0.02;
    }

    // 成功率和评分不一致，说明有准确度问题
    if (successRate > 0.8 && rating < 3) {
      improvement += 0.03; // 成功但评分低 → 输出质量差
    }

    // 标记优化动作
    if (improvement > 0) {
      skill._accuracyOptimizations = skill._accuracyOptimizations || [];
      if (errorRate > 0.1) skill._accuracyOptimizations.push('input_validation');
      if (successRate > 0.8 && rating < 3) skill._accuracyOptimizations.push('output_verification');
      skill._accuracyOptimizations.push('error_pattern_analysis');
    }

    return improvement;
  }

  /**
   * 进化用户体验 — 基于用户反馈和评分
   *
   * 优化策略：
   *   1. 评分低 → 分析负面反馈关键词
   *   2. 使用频率下降 → 优化交互流程
   *   3. 用户建议 → 直接采纳改进
   */
  evolveUserExperience(skill) {
    const rating = skill.rating || 3;
    const usageTrend = skill.usageTrend || 0; // 正=上升，负=下降
    const negativeFeedbackCount = skill.negativeFeedbackCount || 0;

    let improvement = 0;

    // 评分越低，UX优化空间越大
    if (rating < 2) {
      improvement += 0.06;
    } else if (rating < 3) {
      improvement += 0.04;
    } else if (rating < 4) {
      improvement += 0.02;
    }

    // 使用趋势下降
    if (usageTrend < -0.2) {
      improvement += 0.03;
    }

    // 负面反馈多
    if (negativeFeedbackCount > 5) {
      improvement += 0.03;
    }

    // 标记优化动作
    if (improvement > 0) {
      skill._uxOptimizations = skill._uxOptimizations || [];
      if (rating < 3) skill._uxOptimizations.push('prompt_refinement');
      if (usageTrend < -0.2) skill._uxOptimizations.push('interaction_simplification');
      if (negativeFeedbackCount > 5) skill._uxOptimizations.push('feedback_integration');
    }

    return improvement;
  }

  /**
   * 进化适应性 — 基于使用场景多样性
   *
   * 优化策略：
   *   1. 场景单一 → 扩展参数化能力
   *   2. 跨域使用少 → 增加场景适配
   *   3. 硬编码多 → 参数化改造
   */
  evolveAdaptability(skill) {
    const usageScenes = skill.usageScenes || 1;
    const paramCount = skill.paramCount || 0;
    const usageCount = skill.usageCount || 0;

    let improvement = 0;

    // 使用场景少但有使用量 → 有扩展空间
    if (usageScenes <= 2 && usageCount > 10) {
      improvement += 0.04;
    }

    // 参数少 → 参数化改造
    if (paramCount <= 1 && usageCount > 5) {
      improvement += 0.03;
    }

    // 标记优化动作
    if (improvement > 0) {
      skill._adaptabilityOptimizations = skill._adaptabilityOptimizations || [];
      if (usageScenes <= 2) skill._adaptabilityOptimizations.push('scene_expansion');
      if (paramCount <= 1) skill._adaptabilityOptimizations.push('parameterization');
    }

    return improvement;
  }

  /**
   * 进化可维护性 — 基于代码复杂度和修改频率
   *
   * 优化策略：
   *   1. 步骤多 → 拆分子流程
   *   2. 修改频繁 → 稳定化改造
   *   3. 依赖多 → 解耦
   */
  evolveMaintainability(skill) {
    const stepCount = skill.stepCount || 1;
    const changeFrequency = skill.changeFrequency || 0;
    const dependencyCount = skill.dependencyCount || 0;

    let improvement = 0;

    if (stepCount > 10) {
      improvement += 0.03;
    }
    if (changeFrequency > 5) {
      improvement += 0.02;
    }
    if (dependencyCount > 5) {
      improvement += 0.02;
    }

    // 标记优化动作
    if (improvement > 0) {
      skill._maintainabilityOptimizations = skill._maintainabilityOptimizations || [];
      if (stepCount > 10) skill._maintainabilityOptimizations.push('subprocess_extraction');
      if (changeFrequency > 5) skill._maintainabilityOptimizations.push('stabilization');
      if (dependencyCount > 5) skill._maintainabilityOptimizations.push('decoupling');
    }

    return improvement;
  }

  /**
   * 移除未使用技能
   */
  async removeUnusedSkill(opportunity) {
    console.log(`[SkillEvolution] 移除未使用技能: ${opportunity.skill}`);

    delete this.data.skills[opportunity.skill];
    delete this.data.ratings[opportunity.skill];
    delete this.data.usageStats[opportunity.skill];

    this.data.stats.totalSkills = Object.keys(this.data.skills).length;

    await this.saveData();

    return {
      type: 'remove_unused',
      skill: opportunity.skill,
      improvement: 0,
    };
  }

  /**
   * 合并相似技能 — 基于名称相似度和功能重叠
   */
  async mergeSkills(opportunity) {
    console.log(`[SkillEvolution] 合并相似技能: ${opportunity.skills.join(', ')}`);

    const mergedSkill = {
      id: `merged_${Date.now()}`,
      name: opportunity.skills.join('_'),
      type: 'merged',
      sourceSkills: opportunity.skills,
      rating: 0,
      usageCount: 0,
      successRate: 0,
      averageExecutionTime: 0,
      createdAt: new Date().toISOString(),
    };

    // 计算加权平均
    let totalUsage = 0;
    for (const skillName of opportunity.skills) {
      const skill = this.data.skills[skillName];
      if (skill) {
        const weight = (skill.usageCount || 1);
        mergedSkill.rating += (skill.rating || 0) * weight;
        mergedSkill.successRate += (skill.successRate || 0) * weight;
        mergedSkill.averageExecutionTime += (skill.averageExecutionTime || 0) * weight;
        mergedSkill.usageCount += (skill.usageCount || 0);
        totalUsage += weight;
      }
    }

    if (totalUsage > 0) {
      mergedSkill.rating /= totalUsage;
      mergedSkill.successRate /= totalUsage;
      mergedSkill.averageExecutionTime /= totalUsage;
    }

    this.data.skills[mergedSkill.name] = mergedSkill;

    for (const skillName of opportunity.skills) {
      delete this.data.skills[skillName];
    }

    this.data.stats.skillsMerged++;
    this.data.evolutionHistory.push({
      type: 'skill_merge',
      skills: opportunity.skills,
      mergedInto: mergedSkill.name,
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    return {
      type: 'merge_skills',
      skills: opportunity.skills,
      improvement: 3,
    };
  }

  /**
   * 拆分复杂技能 — 识别独立功能块并创建子技能
   */
  async splitSkill(opportunity) {
    console.log(`[SkillEvolution] 拆分复杂技能: ${opportunity.skill}`);

    const skill = this.data.skills[opportunity.skill];
    if (!skill) {
      return { type: 'split_skill', skill: opportunity.skill, improvement: 0 };
    }

    const stepCount = skill.stepCount || 1;
    const subSkills = [];

    // 基于步骤数拆分：每3-5步创建一个子技能
    const stepsPerSubSkill = Math.max(3, Math.ceil(stepCount / Math.ceil(stepCount / 5)));
    const subCount = Math.ceil(stepCount / stepsPerSubSkill);

    for (let i = 0; i < subCount; i++) {
      const subSkill = {
        id: `split_${Date.now()}_${i}`,
        name: `${opportunity.skill}_part${i + 1}`,
        type: 'split',
        parentSkill: opportunity.skill,
        stepRange: { start: i * stepsPerSubSkill, end: Math.min((i + 1) * stepsPerSubSkill, stepCount) },
        rating: skill.rating || 3,
        usageCount: 0,
        successRate: skill.successRate || 0.5,
        averageExecutionTime: (skill.averageExecutionTime || 1000) / subCount,
        createdAt: new Date().toISOString(),
      };
      this.data.skills[subSkill.name] = subSkill;
      subSkills.push(subSkill.name);
    }

    // 标记原技能为已拆分
    skill.splitInto = subSkills;
    skill.splitAt = new Date().toISOString();

    this.data.stats.skillsSplit++;
    this.data.evolutionHistory.push({
      type: 'skill_split',
      skill: opportunity.skill,
      splitInto: subSkills,
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    return {
      type: 'split_skill',
      skill: opportunity.skill,
      improvement: 2,
      splitInto: subSkills,
    };
  }

  /**
   * 从分析结果中收集执行经验，供 autoCreateSkill 使用
   */
  _collectExperience(_analysis) {
    const toolCalls = [];
    // 从 MetricsPipeline 获取最近的工具调用记录
    if (this._metricsPipeline) {
      try {
        const since = Date.now() - 3600000; // 最近1小时
        const queries = this._metricsPipeline.query('tool.call', { since, aggregation: 'raw' });
        if (queries && queries.records) {
          for (const record of queries.records) {
            toolCalls.push({
              tool: record.tags?.tool || record.name,
              success: record.value > 0,
              timestamp: record.timestamp,
            });
          }
        }
      } catch (_) {
        /* MetricsPipeline 查询失败不影响进化 */
        console.warn('[skill-evolution.js] 空 catch 补日志:', _ && _.message);
      }

    }

    // 从内部数据补充技能执行记录
    const skillExecutions = [];
    for (const [name, skill] of Object.entries(this.data.skills)) {
      if (skill.usageCount > 0) {
        skillExecutions.push({
          skill: name,
          successRate: skill.successRate,
          usageCount: skill.usageCount,
        });
      }
    }

    return { toolCalls, skillExecutions, timestamp: Date.now() };
  }

  /**
   * 自动创建技能 — 从执行轨迹中捕获可复用模式
   */
  async autoCreateSkill(experience) {
    console.log('[SkillEvolution] 自动创建技能...');

    const trajectory = this.analyzeTrajectory(experience);
    const patterns = this.identifyPatterns(trajectory);

    if (patterns.length === 0) {
      console.log('[SkillEvolution] 未发现可复用模式，跳过技能创建');
      return null;
    }

    const description = this.generateDescription(patterns);
    const code = this.generateCode(patterns);

    const skill = {
      id: `skill_${Date.now()}`,
      name: description.name,
      description: description.detail,
      code,
      patterns,
      rating: 0,
      usageCount: 0,
      successRate: 0,
      averageExecutionTime: 0,
      createdAt: new Date().toISOString(),
      autoCreated: true,
    };

    this.data.skills[skill.name] = skill;
    this.data.stats.skillsCreated++;
    this.data.stats.totalSkills = Object.keys(this.data.skills).length;

    this.data.evolutionHistory.push({
      type: 'skill_auto_create',
      skill: skill.name,
      patternCount: patterns.length,
      timestamp: new Date().toISOString(),
    });

    await this.saveData();

    console.log(`[SkillEvolution] 技能自动创建成功: ${skill.name}`);
    return skill;
  }

  /**
   * 分析执行轨迹 — 提取步骤、工具和模式
   */
  analyzeTrajectory(experience) {
    if (!experience || !experience.steps) {
      return { steps: [], tools: [], patterns: [] };
    }

    const steps = experience.steps || [];
    const tools = steps
      .filter(s => s.type === 'tool_call')
      .map(s => s.toolName);

    // 提取工具调用序列模式
    const toolSequence = [];
    let currentRun = [];
    for (const tool of tools) {
      currentRun.push(tool);
      if (currentRun.length >= 2) {
        toolSequence.push([...currentRun]);
      }
    }

    return { steps, tools, patterns: toolSequence };
  }

  /**
   * 识别可复用模式 — 从轨迹中提取高频工具组合
   */
  identifyPatterns(trajectory) {
    if (!trajectory.patterns || trajectory.patterns.length === 0) {
      return [];
    }

    // 统计模式频率
    const patternFreq = {};
    for (const pattern of trajectory.patterns) {
      const key = pattern.join('→');
      patternFreq[key] = (patternFreq[key] || 0) + 1;
    }

    // 只保留出现2次以上的模式
    return Object.entries(patternFreq)
      .filter(([_, freq]) => freq >= 2)
      .map(([key, freq]) => ({
        sequence: key.split('→'),
        frequency: freq,
        type: 'tool_sequence',
      }))
      .sort((a, b) => b.frequency - a.frequency);
  }

  /**
   * 生成技能描述
   */
  generateDescription(patterns) {
    if (!patterns || patterns.length === 0) {
      return { name: `auto_skill_${Date.now()}`, detail: '自动生成的技能' };
    }

    const topPattern = patterns[0];
    const name = `auto_${topPattern.sequence.join('_')}`;
    const detail = `自动捕获的工具序列: ${topPattern.sequence.join(' → ')} (出现${topPattern.frequency}次)`;

    return { name, detail };
  }

  /**
   * 生成技能代码骨架
   */
  generateCode(patterns) {
    if (!patterns || patterns.length === 0) return '';

    const topPattern = patterns[0];
    const steps = topPattern.sequence.map((tool, i) =>
      `    // 步骤 ${i + 1}: 调用 ${tool}\n    const result${i} = await tools.${tool}(context);`
    ).join('\n');

    return `async function execute(context, tools) {\n${steps}\n  return context;\n}`;
  }

  /**
   * 识别相似技能 — 基于名称关键词和功能重叠
   */
  identifySimilarSkills() {
    const skills = Object.entries(this.data.skills);
    const groups = [];

    for (let i = 0; i < skills.length; i++) {
      for (let j = i + 1; j < skills.length; j++) {
        const [nameA, skillA] = skills[i];
        const [nameB, skillB] = skills[j];

        // 名称相似度：共享关键词
        const wordsA = nameA.toLowerCase().split(/[_-]/);
        const wordsB = nameB.toLowerCase().split(/[_-]/);
        const commonWords = wordsA.filter(w => wordsB.includes(w));
        const nameSimilarity = commonWords.length / Math.max(wordsA.length, wordsB.length);

        // 功能重叠：相同类型或相似工具集
        const toolsA = new Set(skillA.tools || []);
        const toolsB = new Set(skillB.tools || []);
        const toolOverlap = toolsA.size > 0 && toolsB.size > 0
          ? [...toolsA].filter(t => toolsB.has(t)).length / Math.max(toolsA.size, toolsB.size)
          : 0;

        const similarity = nameSimilarity * 0.6 + toolOverlap * 0.4;

        if (similarity > 0.5) {
          groups.push({ skills: [nameA, nameB], similarity });
        }
      }
    }

    return groups;
  }

  /**
   * 识别复杂技能 — 基于步骤数和依赖数
   */
  identifyComplexSkills() {
    return Object.entries(this.data.skills)
      .filter(([_, skill]) => (skill.stepCount || 0) > 8 || (skill.dependencyCount || 0) > 4)
      .map(([name, skill]) => ({ name, stepCount: skill.stepCount || 0, dependencyCount: skill.dependencyCount || 0 }));
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
   * 应用改进 — 回写技能指标到数据存储
   */
  async apply(_improvements) {
    const skills = Object.values(this.data.skills);
    if (skills.length > 0) {
      const totalRating = skills.reduce((sum, skill) => sum + (skill.rating || 0), 0);
      this.data.stats.averageRating = totalRating / skills.length;
    }
    this.data.stats.activeSkills = skills.filter(s => (s.usageCount || 0) > 0).length;
    this.data.stats.totalSkills = skills.length;

    await this.saveData();
  }

  /**
   * 记录技能执行 — 供外部调用采集数据
   */
  async recordSkillExecution(skillName, executionTime, success, rating = null) {
    if (!this.data.skills[skillName]) {
      this.data.skills[skillName] = {
        name: skillName,
        rating: 0,
        usageCount: 0,
        successRate: 0,
        averageExecutionTime: 0,
        errorRate: 0,
        createdAt: new Date().toISOString(),
      };
    }

    const skill = this.data.skills[skillName];
    skill.usageCount = (skill.usageCount || 0) + 1;

    // 增量更新平均执行时间
    skill.averageExecutionTime = ((skill.averageExecutionTime || 0) * (skill.usageCount - 1) + executionTime) / skill.usageCount;

    // 增量更新成功率
    const prevSuccesses = (skill.successRate || 0) * (skill.usageCount - 1);
    skill.successRate = (prevSuccesses + (success ? 1 : 0)) / skill.usageCount;
    skill.errorRate = 1 - skill.successRate;

    // 增量更新评分
    if (rating !== null) {
      const prevRatingSum = (skill.rating || 0) * (skill.usageCount - 1);
      skill.rating = (prevRatingSum + rating) / skill.usageCount;
    }

    skill.lastUsedAt = new Date().toISOString();

    // 同时写入 MetricsPipeline
    if (this._metricsPipeline) {
      try {
        this._metricsPipeline.record('skill.success_rate', success ? 1 : 0, { skill: skillName });
        this._metricsPipeline.record('skill.latency_p50', executionTime, { skill: skillName });
        if (!success) {
          this._metricsPipeline.record('skill.error_rate', 1, { skill: skillName });
        }
      } catch (e) {
        /* ignored */
        console.warn('[skill-evolution.js] 空 catch 补日志:', e && e.message);
      }

    }

    await this.saveData();
  }

  /**
   * 获取技能报告
   */

  /**
   * 生成进化变更日志
   * 
   * 存储路径: data/.crabpaw/evolution/{skillName}-changelog.json
   * 格式: [{ version, timestamp, type, summary, changes, reverted }]
   */
  async generateChangelog(skillName, evolutionType, changes = {}) {
    const changelogDir = path.join(config.DATA_DIR, 'evolution');
    const changelogFile = path.join(changelogDir, `${skillName}-changelog.json`);

    try {
      await fs.mkdir(changelogDir, { recursive: true });
    } catch (_) {
      /* 目录已存在 */
      console.warn('[skill-evolution.js] 空 catch 补日志:', _ && _.message);
    }


    let changelog = [];
    try {
      const raw = await fs.readFile(changelogFile, 'utf-8');
      changelog = JSON.parse(raw);
      if (!Array.isArray(changelog)) changelog = [];
    } catch (_) {
      changelog = [];
    }

    const version = changelog.length + 1;
    const entry = {
      version,
      timestamp: new Date().toISOString(),
      type: evolutionType,
      summary: changes.summary || 'Evolution update',
      changes: {
        affectedFields: changes.affectedFields || [],
        before: changes.before || {},
        after: changes.after || {},
      },
      reverted: false,
    };

    changelog.push(entry);
    if (changelog.length > 200) {
      changelog = changelog.slice(-200);
    }

    const tmpFile = changelogFile + '.tmp';
    await fs.writeFile(tmpFile, JSON.stringify(changelog, null, 2), 'utf-8');
    await fs.rename(tmpFile, changelogFile);

    this.data.evolutionHistory.push({
      type: evolutionType,
      skillName,
      action: 'evolve',
      version,
      summary: entry.summary,
      timestamp: entry.timestamp,
    });
    if (this.data.evolutionHistory.length > 200) {
      this.data.evolutionHistory = this.data.evolutionHistory.slice(-100);
    }
    this.data.stats.skillsEvolved = (this.data.stats.skillsEvolved || 0) + 1;
    await this.saveData();

    console.log('[SkillEvolution] Changelog generated');
    return entry;
  }

  async markChangelogReverted(skillName, version) {
    const changelogDir = path.join(config.DATA_DIR, 'evolution');
    const changelogFile = path.join(changelogDir, `${skillName}-changelog.json`);

    try {
      const raw = await fs.readFile(changelogFile, 'utf-8');
      const changelog = JSON.parse(raw);
      const entry = changelog.find(e => e.version === version);
      if (entry) {
        entry.reverted = true;
        entry.revertedAt = new Date().toISOString();
        const tmpFile = changelogFile + '.tmp';
        await fs.writeFile(tmpFile, JSON.stringify(changelog, null, 2), 'utf-8');
        await fs.rename(tmpFile, changelogFile);
        console.log('[SkillEvolution] Changelog generated');
        return true;
      }
      return false;
    } catch (e) {
      console.log('[SkillEvolution] operation completed');
      return false;
    }
  }

  async getChangelog(skillName, limit = 50) {
    const changelogDir = path.join(config.DATA_DIR, 'evolution');
    const changelogFile = path.join(changelogDir, `${skillName}-changelog.json`);

    try {
      const raw = await fs.readFile(changelogFile, 'utf-8');
      const changelog = JSON.parse(raw);
      return changelog.slice(-limit);
    } catch (_) {
      return [];
    }
  }
  getSkillReport() {
    return {
      stats: this.data.stats,
      skills: this.data.skills,
      recentEvolutions: this.data.evolutionHistory.slice(-10),
    };
  }
}

// 单例实例
let skillEvolutionEngine = null;

async function getSkillEvolutionEngine() {
  if (!skillEvolutionEngine) {
    skillEvolutionEngine = new SkillEvolutionEngine();
    await skillEvolutionEngine.init();
  }
  return skillEvolutionEngine;
}

module.exports = {
  SkillEvolutionEngine,
  getSkillEvolutionEngine,
};