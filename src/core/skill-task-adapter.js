// eslint-disable-next-line no-unused-vars
const { TASK_CATEGORIES, globalSkillRouter } = require('./skill-router');
const { globalScoringSystem } = require('./skill-scoring');
const { globalDependencyManager } = require('./skill-dependency-manager');

const SCENARIOS = {
  BUSINESS_ANALYSIS: {
    name: 'business_analysis',
    description: '商业分析和决策支持',
    keywords: ['商业', '分析', '决策', '报告', '投资', '市场'],
    preferredSkills: ['financial-analyst', 'consulting-analysis', 'stock-analyst-enhanced'],
    complexity: 'high',
    requiresData: true
  },
  DOCUMENT_WORKFLOW: {
    name: 'document_workflow',
    description: '文档处理和生成',
    keywords: ['文档', '报告', 'PDF', 'Word', 'PPT', '生成', '转换'],
    preferredSkills: ['pdf-generator', 'pptx-generator', 'markdown-converter'],
    complexity: 'medium',
    requiresData: false
  },
  RESEARCH_INVESTIGATION: {
    name: 'research_investigation',
    description: '研究和调查任务',
    keywords: ['研究', '调查', '搜索', '分析', '深度', '调研'],
    preferredSkills: ['deep-research', 'deep-research-pro', 'multi-search-engine'],
    complexity: 'high',
    requiresData: false
  },
  CODE_DEVELOPMENT: {
    name: 'code_development',
    description: '代码开发和调试',
    keywords: ['代码', '开发', '编程', '调试', '实现', '功能'],
    preferredSkills: ['prompt-engineering-expert', 'workflow-designer', 'frontend-design-ultimate'],
    complexity: 'high',
    requiresData: false
  },
  DATA_VISUALIZATION: {
    name: 'data_visualization',
    description: '数据可视化和图表',
    keywords: ['图表', '可视化', '数据', '展示', '图形', '绘图'],
    preferredSkills: ['chart-visualization', 'financial-analyst'],
    complexity: 'medium',
    requiresData: true
  },
  SYSTEM_ADMINISTRATION: {
    name: 'system_administration',
    description: '系统管理和监控',
    keywords: ['系统', '监控', '检查', '配置', '管理', '状态'],
    preferredSkills: ['healthcheck', 'system-info', 'desktop-control'],
    complexity: 'low',
    requiresData: false
  },
  INFORMATION_RETRIEVAL: {
    name: 'information_retrieval',
    description: '信息检索和查询',
    keywords: ['查询', '搜索', '获取', '查找', '信息', '天气'],
    preferredSkills: ['weather', 'agent-browser', 'multi-search-engine'],
    complexity: 'low',
    requiresData: false
  },
  AI_COLLABORATION: {
    name: 'ai_collaboration',
    description: 'AI 协作和智能增强',
    keywords: ['AI', '智能', '协作', '团队', '改进', '优化'],
    preferredSkills: ['self-improving-agent', 'agent-team-orchestration'],
    complexity: 'high',
    requiresData: false
  }
};

const USER_INTENT_PATTERNS = {
  CREATE: {
    pattern: /(?:创建|生成|新建|制作|写)/,
    action: 'create',
    priority: 1
  },
  ANALYZE: {
    pattern: /(?:分析|研究|调查|评估)/,
    action: 'analyze',
    priority: 2
  },
  CONVERT: {
    pattern: /(?:转换|转换|导出|导入)/,
    action: 'convert',
    priority: 1
  },
  QUERY: {
    pattern: /(?:查询|搜索|查找|获取|检索)/,
    action: 'query',
    priority: 1
  },
  MODIFY: {
    pattern: /(?:修改|编辑|更新|更改)/,
    action: 'modify',
    priority: 2
  },
  DELETE: {
    pattern: /(?:删除|移除|清除)/,
    action: 'delete',
    priority: 1
  },
  MONITOR: {
    pattern: /(?:监控|检查|查看|状态)/,
    action: 'monitor',
    priority: 1
  }
};

class TaskAdapter {
  constructor(config = {}) {
    this.config = config;
    this.skillRegistry = null;
    this.contextHistory = [];
    this.maxHistorySize = config.maxHistorySize || 100;
    this.learningEnabled = config.learningEnabled !== false;
  }

  setSkillRegistry(registry) {
    this.skillRegistry = registry;
    globalSkillRouter.setSkillRegistry(registry);
  }

  // eslint-disable-next-line no-unused-vars
  analyzeTask(userInput, context = {}) {
    const input = userInput.toLowerCase();
    
    const scenario = this.detectScenario(input);
    const intent = this.detectIntent(input);
    const complexity = this.estimateComplexity(input, scenario);
    const entities = this.extractEntities(input);
    const constraints = this.extractConstraints(input);

    return {
      scenario,
      intent,
      complexity,
      entities,
      constraints,
      originalInput: userInput
    };
  }

  detectScenario(input) {
    const matches = [];

    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      const keywordMatches = scenario.keywords.filter(kw => 
        input.includes(kw.toLowerCase())
      );

      if (keywordMatches.length > 0) {
        matches.push({
          scenario: key,
          config: scenario,
          score: keywordMatches.length / scenario.keywords.length,
          matchedKeywords: keywordMatches
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);

    return matches.length > 0 ? matches[0] : {
      scenario: 'GENERAL',
      config: {
        name: 'general',
        description: '通用任务',
        keywords: [],
        preferredSkills: [],
        complexity: 'medium'
      },
      score: 0
    };
  }

  detectIntent(input) {
    const intents = [];

    for (const [key, config] of Object.entries(USER_INTENT_PATTERNS)) {
      if (config.pattern.test(input)) {
        intents.push({
          intent: key,
          action: config.action,
          priority: config.priority
        });
      }
    }

    intents.sort((a, b) => b.priority - a.priority);

    return intents.length > 0 ? intents[0] : {
      intent: 'UNKNOWN',
      action: 'unknown',
      priority: 0
    };
  }

  estimateComplexity(input, scenario) {
    let score = 0;

    const wordCount = input.split(/\s+/).length;
    if (wordCount > 50) score += 2;
    else if (wordCount > 20) score += 1;

    if (scenario.config?.complexity === 'high') score += 2;
    else if (scenario.config?.complexity === 'medium') score += 1;

    if (/(?:多个|批量|同时|并行)/.test(input)) score += 1;
    if (/(?:复杂|详细|深度|全面)/.test(input)) score += 1;
    if (/(?:简单|快速|简要)/.test(input)) score -= 1;

    if (score >= 4) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
  }

  extractEntities(input) {
    const entities = {
      dates: [],
      numbers: [],
      urls: [],
      files: [],
      names: []
    };

    const datePatterns = [
      /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?/g,
      /\d{1,2}[-/月]\d{1,2}[日]?/g,
      /今天|明天|昨天|本周|上周|下周/g
    ];

    for (const pattern of datePatterns) {
      const matches = input.match(pattern);
      if (matches) entities.dates.push(...matches);
    }

    const numberMatches = input.match(/\d+(?:\.\d+)?(?:万|亿|千|百)?/g);
    if (numberMatches) entities.numbers = numberMatches;

    const urlMatches = input.match(/https?:\/\/[^\s]+/g);
    if (urlMatches) entities.urls = urlMatches;

    const fileMatches = input.match(/[\w-]+\.(?:pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|json)/gi);
    if (fileMatches) entities.files = fileMatches;

    return entities;
  }

  extractConstraints(input) {
    const constraints = {
      timeLimit: null,
      format: null,
      language: null,
      priority: 'normal'
    };

    if (/(?:紧急|立即|马上|尽快)/.test(input)) {
      constraints.priority = 'urgent';
    } else if (/(?:不急|稍后|有空)/.test(input)) {
      constraints.priority = 'low';
    }

    if (/(?:PDF|Word|Excel|PPT|Markdown|JSON|CSV)/i.test(input)) {
      const formatMatch = input.match(/(?:PDF|Word|Excel|PPT|Markdown|JSON|CSV)/i);
      if (formatMatch) constraints.format = formatMatch[0].toLowerCase();
    }

    if (/(?:中文|英文|日文|韩文)/.test(input)) {
      const langMatch = input.match(/(?:中文|英文|日文|韩文)/);
      if (langMatch) constraints.language = langMatch[0];
    }

    return constraints;
  }

  async getSkillRecommendations(taskAnalysis, options = {}) {
    const { maxResults = 5, includeAlternatives = true } = options;
    const recommendations = [];

    if (taskAnalysis.scenario?.config?.preferredSkills) {
      for (const skillName of taskAnalysis.scenario.config.preferredSkills) {
        if (!this.skillRegistry?.[skillName]) continue;
        const score = globalScoringSystem.getScore(skillName);
        const depStatus = await globalDependencyManager.getSkillDependencyStatus(skillName);
        recommendations.push({
          name: skillName, type: 'scenario_match',
          score: score * 0.8, ready: depStatus.ready,
          reason: `场景匹配: ${taskAnalysis.scenario.config.description}`
        });
      }
    }

    // 动态扩展：从 CapabilityRegistry 按能力匹配技能
    try {
      const { getCapabilityRegistry } = require('../taskflow/skill-capability-registry');
      const registry = getCapabilityRegistry();
      for (const skillName of registry.getSkillNames()) {
        if (recommendations.find(r => r.name === skillName)) continue;
        if (!this.skillRegistry?.[skillName]) continue;
        const score = globalScoringSystem.getScore(skillName);
        recommendations.push({
          name: skillName, type: 'capability_match',
          score: (score || 0.5) * 0.6, ready: true,
          reason: '能力注册表动态匹配',
        });
      }
    } catch (e) { console.warn('[skill-task-adapter] Failed to discover capabilities:', e.message); }

    const routerRecommendations = globalSkillRouter.getRecommendedSkills(
      taskAnalysis.originalInput,
      { maxResults: 3 }
    );

    for (const rec of routerRecommendations) {
      if (recommendations.find(r => r.name === rec.name)) continue;

      recommendations.push({
        name: rec.name,
        type: 'intent_match',
        score: rec.score,
        ready: true,
        reason: rec.reason
      });
    }

    recommendations.sort((a, b) => b.score - a.score);

    const topRecommendations = recommendations.slice(0, maxResults);

    if (includeAlternatives && topRecommendations.length > 0) {
      const alternatives = recommendations.slice(maxResults, maxResults + 3);
      return { primary: topRecommendations, alternatives };
    }

    return { primary: topRecommendations, alternatives: [] };
  }

  adaptTask(taskAnalysis, skillName) {
    const skill = this.skillRegistry?.[skillName];
    if (!skill) return null;

    const adaptation = {
      skillName,
      parameters: {},
      preprocessing: [],
      postprocessing: [],
      fallback: null
    };

    if (taskAnalysis.entities.files?.length > 0) {
      adaptation.parameters.inputFile = taskAnalysis.entities.files[0];
    }

    if (taskAnalysis.entities.urls?.length > 0) {
      adaptation.parameters.url = taskAnalysis.entities.urls[0];
    }

    if (taskAnalysis.constraints.format) {
      adaptation.parameters.outputFormat = taskAnalysis.constraints.format;
    }

    if (taskAnalysis.constraints.language) {
      adaptation.parameters.language = taskAnalysis.constraints.language;
    }

    if (taskAnalysis.complexity === 'high') {
      adaptation.preprocessing.push('validate_input');
      adaptation.postprocessing.push('quality_check');
    }

    return adaptation;
  }

  recordContext(userInput, selectedSkill, result) {
    this.contextHistory.push({
      timestamp: Date.now(),
      input: userInput,
      skill: selectedSkill,
      success: result.success,
      analysis: this.analyzeTask(userInput)
    });

    if (this.contextHistory.length > this.maxHistorySize) {
      this.contextHistory = this.contextHistory.slice(-this.maxHistorySize);
    }
  }

  getSimilarTasks(userInput) {
    const currentAnalysis = this.analyzeTask(userInput);
    
    return this.contextHistory
      .filter(ctx => ctx.analysis.scenario?.scenario === currentAnalysis.scenario?.scenario)
      .slice(-10)
      .map(ctx => ({
        input: ctx.input,
        skill: ctx.skill,
        success: ctx.success
      }));
  }

  getStats() {
    const stats = {
      totalTasks: this.contextHistory.length,
      successRate: 0,
      scenarioDistribution: {},
      intentDistribution: {},
      skillUsage: {}
    };

    let successCount = 0;

    for (const ctx of this.contextHistory) {
      if (ctx.success) successCount++;

      const scenario = ctx.analysis.scenario?.scenario || 'UNKNOWN';
      stats.scenarioDistribution[scenario] = (stats.scenarioDistribution[scenario] || 0) + 1;

      const intent = ctx.analysis.intent?.intent || 'UNKNOWN';
      stats.intentDistribution[intent] = (stats.intentDistribution[intent] || 0) + 1;

      stats.skillUsage[ctx.skill] = (stats.skillUsage[ctx.skill] || 0) + 1;
    }

    stats.successRate = stats.totalTasks > 0 ? successCount / stats.totalTasks : 0;

    return stats;
  }
}

const globalTaskAdapter = new TaskAdapter();

function initializeAdapter(skillRegistry) {
  globalTaskAdapter.setSkillRegistry(skillRegistry);
}

module.exports = {
  TaskAdapter,
  globalTaskAdapter,
  initializeAdapter,
  SCENARIOS,
  USER_INTENT_PATTERNS
};
