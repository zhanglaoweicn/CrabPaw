const { getWorkflowTemplateEngine } = require('./workflow-template-engine');
const { CapabilityRegistry } = require('../core/agent/capability-registry');
const { DomainRegistry } = require('../core/agent/domain-registry');

let _taskflowAPI = null;
function _getTaskFlowAPI() {
  if (!_taskflowAPI) {
    _taskflowAPI = require('./index').getTaskFlowAPI();
  }
  return _taskflowAPI;
}

const INTENT_TYPES = {
  SIMPLE_CHAT: 'simple_chat',
  SINGLE_SKILL: 'single_skill',
  COMPLEX_WORKFLOW: 'complex_workflow',
  EXPERT_TASK: 'expert_task',
  UNKNOWN: 'unknown'
};

const COMPLEXITY_INDICATORS = {
  multiStep: [/然后|接着|之后|再|and then|after that|next/i],
  conditional: [/如果|假如|当.*时|万一|if|when|unless/i],
  parallel: [/同时|并行|一起|同时.*和|parallel|simultaneously|at the same time/i],
  scheduled: [/每天|每周|定时|定期|every day|weekly|scheduled/i],
  aggregate: [/汇总|合并|收集|整合|aggregate|merge|collect|consolidate/i],
  transform: [/转换|格式化|整理|归档|transform|format|organize|archive/i]
};

const SKILL_KEYWORDS = {
  'wecom-daily-news': [/发送|发消息|通知|提醒|企业微信|send|notify|message|push/i],
  'data-analysis': [/分析|统计|数据|analysis|analyze|statistics/i],
  'chart-visualization': [/图表|可视化|chart|visualization|画图|绘图/i],
  'deep-research': [/研究|调研|深度|research|investigate/i],
  'deep-research-pro': [/专业研究|深度调研|深度分析|pro research/i],
  'multi-search-engine': [/搜索|查找|查询|search|find|查一下/i],
  'financial-analyst': [/财务|金融|审计|financial/i],
  'stock-analyst-enhanced': [/股票|行情|投资|stock/i],
  'pdf-generator': [/生成PDF|PDF文档|pdf generate/i],
  'pdf-smart-tool-cn': [/PDF处理|PDF提取|PDF转换|pdf tool/i],
  'pptx-generator': [/PPT|演示文稿|幻灯片|presentation|pptx/i],
  'excel-xlsx': [/Excel|表格|xlsx|电子表格/i],
  'markdown-converter': [/文档转换|格式转换|markdown convert/i],
  'summarize-pro': [/摘要|总结|概括|summarize/i],
  'prompt-engineering-expert': [/Prompt|提示词|prompt engineering/i],
  'healthcheck': [/健康检查|系统检查|healthcheck/i],
  'system-info': [/系统信息|系统状态|system info/i],
  'desktop-control': [/桌面控制|自动化操作|desktop/i],
  'agent-browser': [/网页浏览|打开网页|browse web/i],
  'frontend-design-ultimate': [/前端设计|UI设计|frontend/i],
  'workflow-designer': [/工作流设计|流程设计|workflow design/i],
  'agent-team-orchestration': [/团队协作|多Agent|team orchestration/i],
  'weather': [/天气|气温|weather/i],
  'consulting-analysis': [/咨询|顾问|consulting/i],
  'flashclaw-stock': [/实时行情|股票实时|realtime stock/i]
};

const SYNONYM_MAP = {
  '报告': ['报表', '汇报', '总结', '文档', 'report'],
  '分析': ['解析', '解读', '评估', '诊断', 'analysis'],
  '搜索': ['查找', '检索', '查询', '搜寻', 'search', 'find'],
  '通知': ['提醒', '告知', '发送', '推送', 'notify', 'alert'],
  '研究': ['调研', '调查', '探索', '深度了解', 'research'],
  '生成': ['创建', '制作', '建立', '产出', 'create', 'generate'],
  '转换': ['转化', '变更', '改换', 'transform', 'convert'],
  '监控': ['监测', '观察', '跟踪', '监视', 'monitor', 'watch'],
  '优化': ['改进', '提升', '完善', '增强', 'optimize', 'improve'],
  '设计': ['规划', '构思', '策划', 'design'],
  '统计': ['汇总', '合计', '计算', 'statistics', 'count'],
  '可视化': ['图表', '画图', '绘图', '展示', 'visualization', 'chart'],
  '日程': ['日历', '会议', '安排', 'schedule', 'calendar'],
  '自动化': ['自动', '批处理', '定时', 'automation', 'auto'],
  '投资': ['理财', '金融', '股票', 'fund', 'invest'],
  '文档': ['文件', '资料', '档案', 'document', 'file'],
  '数据': ['信息', '资料', '记录', 'data'],
  '系统': ['平台', '服务', '环境', 'system'],
  '团队': ['协作', '多人', '集体', 'team', 'collaborate']
};

const INTENT_BOOST_PATTERNS = [
  { pattern: /帮我|请|能不能|可以.*吗|麻烦/i, boost: 0.1, reason: 'request_tone' },
  { pattern: /怎么|如何|怎样|how to/i, boost: 0.15, reason: 'how_to_question' },
  { pattern: /快速|立即|马上|赶紧|urgent|asap/i, boost: 0.1, reason: 'urgency' },
  { pattern: /详细|全面|完整|深入|thorough|comprehensive/i, boost: 0.15, reason: 'depth_request' },
  { pattern: /简单|快速|简要|brief|quick/i, boost: -0.1, reason: 'simplicity_request' },
  { pattern: /步骤|流程|过程|step|process|workflow/i, boost: 0.2, reason: 'process_oriented' },
  { pattern: /比较|对比|差异|compare|contrast|versus/i, boost: 0.15, reason: 'comparison' },
  { pattern: /预测|趋势|未来|forecast|trend|predict/i, boost: 0.15, reason: 'prediction' }
];

const NEGATION_PATTERNS = [
  /不想|不要|无需|不用|别|don'?t|not|no/i
];

class IntentAnalyzer {
  constructor() {
    this.templateEngine = getWorkflowTemplateEngine();
    this.taskflowAPI = null;
    this._skillRouter = null;
    this._taskAdapter = null;
    this._matchCache = new Map();
    this._cacheMaxSize = 500;
    this._conversationContext = [];
    this._maxContextSize = 20;
    this._synonymIndex = this._buildSynonymIndex();
    this._usageStats = new Map();
    this._capabilityRegistry = new CapabilityRegistry();
    this._domainRegistry = new DomainRegistry();
  }

  _buildSynonymIndex() {
    const index = new Map();
    for (const [canonical, synonyms] of Object.entries(SYNONYM_MAP)) {
      const allTerms = [canonical, ...synonyms];
      for (const term of allTerms) {
        const lower = term.toLowerCase();
        if (!index.has(lower)) {
          index.set(lower, []);
        }
        index.get(lower).push(canonical);
      }
    }
    return index;
  }

  _expandWithSynonyms(message) {
    const expanded = new Set();
    const lower = message.toLowerCase();

    for (const [term, canonicals] of this._synonymIndex) {
      if (lower.includes(term)) {
        for (const canonical of canonicals) {
          expanded.add(canonical);
        }
      }
    }

    // eslint-disable-next-line no-unused-vars -- messageChars 未消费（含 .split() 调用，保留原式计算意图）
    const messageChars = lower.split('');
    for (const [term, canonicals] of this._synonymIndex) {
      if (lower.includes(term)) continue;
      if (term.length < 2) continue;

      const termChars = term.split('');
      let matchCount = 0;
      let msgIdx = 0;
      for (const tc of termChars) {
        const found = lower.indexOf(tc, msgIdx);
        if (found >= 0) {
          matchCount++;
          msgIdx = found + 1;
        }
      }

      if (matchCount >= termChars.length * 0.8 && matchCount >= 2) {
        for (const canonical of canonicals) {
          expanded.add(canonical);
        }
      }
    }

    return Array.from(expanded);
  }

  _fuzzyMatchKeyword(message, keyword) {
    const lower = message.toLowerCase();
    const kw = keyword.toLowerCase();

    if (lower.includes(kw)) return 1.0;

    if (kw.length >= 2) {
      let consecutive = 0;
      let maxConsecutive = 0;
      for (let i = 0; i < lower.length; i++) {
        if (lower[i] === kw[consecutive]) {
          consecutive++;
          maxConsecutive = Math.max(maxConsecutive, consecutive);
          if (consecutive === kw.length) return 0.9;
        } else {
          consecutive = 0;
        }
      }
      if (maxConsecutive >= kw.length * 0.7) return 0.7;
    }

    return 0;
  }

  _getIntentBoost(message) {
    let boost = 0;
    const matchedReasons = [];

    for (const { pattern, boost: b, reason } of INTENT_BOOST_PATTERNS) {
      if (pattern.test(message)) {
        boost += b;
        matchedReasons.push(reason);
      }
    }

    const hasNegation = NEGATION_PATTERNS.some(p => p.test(message));
    if (hasNegation) {
      boost -= 0.2;
    }

    return { boost, reasons: matchedReasons, hasNegation };
  }

  _updateConversationContext(userId, message, intentResult) {
    if (!userId) return;

    if (!this._conversationContext[userId]) {
      this._conversationContext[userId] = [];
    }

    this._conversationContext[userId].push({
      message: message.substring(0, 200),
      intentType: intentResult.type,
      timestamp: Date.now()
    });

    if (this._conversationContext[userId].length > this._maxContextSize) {
      this._conversationContext[userId] = this._conversationContext[userId].slice(-this._maxContextSize);
    }
  }

  _getContextualBoost(userId, currentIntent) {
    if (!userId || !this._conversationContext[userId]) return 0;

    const history = this._conversationContext[userId];
    const recent = history.slice(-3);

    let boost = 0;

    if (currentIntent.type === INTENT_TYPES.COMPLEX_WORKFLOW) {
      const recentWorkflows = recent.filter(h => h.intentType === INTENT_TYPES.COMPLEX_WORKFLOW);
      if (recentWorkflows.length >= 2) {
        boost += 0.1;
      }
    }

    if (currentIntent.type === INTENT_TYPES.SINGLE_SKILL) {
      const recentSkills = recent.filter(h => h.intentType === INTENT_TYPES.SINGLE_SKILL);
      if (recentSkills.length >= 2) {
        boost += 0.05;
      }
    }

    return boost;
  }

  _getTaskFlowAPI() {
    if (!this.taskflowAPI) {
      this.taskflowAPI = _getTaskFlowAPI();
    }
    return this.taskflowAPI;
  }

  setSkillRouter(router) {
    this._skillRouter = router;
  }

  setTaskAdapter(adapter) {
    this._taskAdapter = adapter;
  }

  analyze(userMessage, context = {}) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { type: INTENT_TYPES.UNKNOWN, confidence: 0 };
    }

    const cacheKey = userMessage.substring(0, 100);
    const cached = this._matchCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = this._doAnalyze(userMessage, context);

    if (this._matchCache.size >= this._cacheMaxSize) {
      const firstKey = this._matchCache.keys().next().value;
      this._matchCache.delete(firstKey);
    }
    this._matchCache.set(cacheKey, result);

    return result;
  }

  suggest(userMessage, context = {}) {
    const intent = this.analyze(userMessage, context);
    this._recordUsage(intent);
    return this._buildSuggestion(intent, userMessage, context);
  }

  _doAnalyze(userMessage, context = {}) {
    const complexity = this._assessComplexity(userMessage);
    const templateMatch = this.templateEngine.matchTemplate(userMessage);
    const expertMatch = this.templateEngine.matchExpertRole(userMessage);
    const skillMatch = this._matchSkill(userMessage);
    const intentBoost = this._getIntentBoost(userMessage);
    const synonymExpansion = this._expandWithSynonyms(userMessage);
    const domainMatch = this._domainRegistry.matchDomain(userMessage);
    const capabilityMatch = this._capabilityRegistry.matchCapability(userMessage);

    let enhancedTemplateMatch = templateMatch;
    if ((!templateMatch || templateMatch.score < 0.3) && synonymExpansion.length > 0) {
      const expandedMessage = userMessage + ' ' + synonymExpansion.join(' ');
      const expandedMatch = this.templateEngine.matchTemplate(expandedMessage);
      if (expandedMatch && (!templateMatch || expandedMatch.score > templateMatch.score)) {
        enhancedTemplateMatch = {
          ...expandedMatch,
          score: expandedMatch.score * 0.85,
          expanded: true,
          expandedTerms: synonymExpansion
        };
      }
    }

    let enhancedExpertMatch = expertMatch;
    if ((!expertMatch || expertMatch.score < 0.3) && synonymExpansion.length > 0) {
      const expandedMessage = userMessage + ' ' + synonymExpansion.join(' ');
      const expandedMatch = this.templateEngine.matchExpertRole(expandedMessage);
      if (expandedMatch && (!expertMatch || expandedMatch.score > expertMatch.score)) {
        enhancedExpertMatch = {
          ...expandedMatch,
          score: expandedMatch.score * 0.85,
          expanded: true
        };
      }
    }

    let enhancedSkillMatch = skillMatch;
    if ((!skillMatch || skillMatch.confidence < 0.5) && synonymExpansion.length > 0) {
      const expandedSkillMatch = this._matchSkillWithSynonyms(userMessage, synonymExpansion);
      if (expandedSkillMatch && (!skillMatch || expandedSkillMatch.confidence > skillMatch.confidence)) {
        enhancedSkillMatch = expandedSkillMatch;
      }
    }

    if (this._taskAdapter) {
      try {
        const taskAnalysis = this._taskAdapter.analyzeTask(userMessage);
        if (taskAnalysis && taskAnalysis.scenario && taskAnalysis.scenario.score > 0.3) {
          if (!enhancedTemplateMatch || enhancedTemplateMatch.score < 0.3) {
            const scenarioTemplates = this._findTemplatesForScenario(taskAnalysis.scenario);
            if (scenarioTemplates.length > 0) {
              enhancedTemplateMatch = {
                template: scenarioTemplates[0],
                score: taskAnalysis.scenario.score * 0.7,
                params: this._extractParamsFromAnalysis(taskAnalysis),
                source: 'scenario_match'
              };
            }
          }
        }
      } catch (e) {
        console.warn('[intent-analyzer] task adapter analysis failed:', e.message);
      }
    }

    const userId = context.userId;
    const contextualBoost = this._getContextualBoost(userId, {
      type: INTENT_TYPES.COMPLEX_WORKFLOW
    });

    const expertScore = enhancedExpertMatch ? enhancedExpertMatch.score + intentBoost.boost + contextualBoost : 0;
    const templateScore = enhancedTemplateMatch ? enhancedTemplateMatch.score + intentBoost.boost + contextualBoost : 0;
    const workflowScore = Math.max(
      complexity.score / 5,
      templateScore
    );

    const hasStrongTemplateOrExpert = (enhancedTemplateMatch && enhancedTemplateMatch.score >= 0.35) ||
                                       (enhancedExpertMatch && enhancedExpertMatch.score >= 0.4);

    if (enhancedExpertMatch && expertScore >= 0.45 && !intentBoost.hasNegation) {
      const result = {
        type: INTENT_TYPES.EXPERT_TASK,
        confidence: Math.min(expertScore, 1.0),
        complexity,
        templateMatch: enhancedTemplateMatch,
        expertMatch: enhancedExpertMatch,
        skillMatch: enhancedSkillMatch,
        synonymExpansion,
        intentBoost,
        domainMatch,
        capabilityMatch,
      };
      this._updateConversationContext(userId, userMessage, result);
      return result;
    }

    if ((complexity.score >= 1.5 || workflowScore >= 0.35 || hasStrongTemplateOrExpert) && !intentBoost.hasNegation) {
      const result = {
        type: INTENT_TYPES.COMPLEX_WORKFLOW,
        confidence: Math.min(Math.max(workflowScore, templateScore), 1.0),
        complexity,
        templateMatch: enhancedTemplateMatch,
        expertMatch: enhancedExpertMatch,
        skillMatch: enhancedSkillMatch,
        synonymExpansion,
        intentBoost,
        domainMatch,
        capabilityMatch,
      };
      this._updateConversationContext(userId, userMessage, result);
      return result;
    }

    if (enhancedTemplateMatch && enhancedTemplateMatch.score >= 0.35 && !intentBoost.hasNegation) {
      const result = {
        type: INTENT_TYPES.COMPLEX_WORKFLOW,
        confidence: Math.min(enhancedTemplateMatch.score + intentBoost.boost, 1.0),
        complexity,
        templateMatch: enhancedTemplateMatch,
        expertMatch: enhancedExpertMatch,
        skillMatch: enhancedSkillMatch,
        synonymExpansion,
        intentBoost,
        domainMatch,
        capabilityMatch,
      };
      this._updateConversationContext(userId, userMessage, result);
      return result;
    }

    if (enhancedSkillMatch && !intentBoost.hasNegation) {
      if (enhancedTemplateMatch && enhancedTemplateMatch.score >= 0.15) {
        const result = {
          type: INTENT_TYPES.COMPLEX_WORKFLOW,
          confidence: Math.min(enhancedTemplateMatch.score + intentBoost.boost + 0.1, 1.0),
          complexity,
          templateMatch: enhancedTemplateMatch,
          expertMatch: enhancedExpertMatch,
          skillMatch: enhancedSkillMatch,
          synonymExpansion,
          intentBoost,
          domainMatch,
          capabilityMatch,
        };
        this._updateConversationContext(userId, userMessage, result);
        return result;
      }

      const result = {
        type: INTENT_TYPES.SINGLE_SKILL,
        confidence: enhancedSkillMatch.confidence,
        skillMatch: enhancedSkillMatch,
        domainMatch,
        capabilityMatch,
      };
      this._updateConversationContext(userId, userMessage, result);
      return result;
    }

    const result = {
      type: INTENT_TYPES.SIMPLE_CHAT,
      confidence: 0.8,
      domainMatch,
      capabilityMatch,
    };
    this._updateConversationContext(userId, userMessage, result);
    return result;
  }

  _matchSkillWithSynonyms(message, synonymExpansion) {
    let bestSkill = null;
    let bestConfidence = 0;

    const expandedMessage = message + ' ' + synonymExpansion.join(' ');

    for (const [skill, patterns] of Object.entries(SKILL_KEYWORDS)) {
      let directMatch = false;
      let expandedMatch = false;

      for (const pattern of patterns) {
        if (pattern.test(message)) {
          directMatch = true;
          break;
        }
      }

      if (!directMatch) {
        for (const pattern of patterns) {
          if (pattern.test(expandedMessage)) {
            expandedMatch = true;
            break;
          }
        }
      }

      if (directMatch) {
        const confidence = 0.7;
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestSkill = skill;
        }
      } else if (expandedMatch) {
        const confidence = 0.5;
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestSkill = skill;
        }
      }
    }

    if (this._skillRouter) {
      try {
        const routeResult = this._skillRouter.classifyTask(message);
        if (routeResult && routeResult.confidence > bestConfidence) {
          if (routeResult.skillHint) {
            bestSkill = routeResult.skillHint;
            bestConfidence = routeResult.confidence;
          }
        }
      } catch (e) {
        console.warn('[intent-analyzer] skill router classification failed:', e.message);
      }
    }

    if (bestSkill) {
      return { skill: bestSkill, confidence: bestConfidence, expanded: bestConfidence === 0.5 };
    }

    return null;
  }

  _findTemplatesForScenario(scenario) {
    // eslint-disable-next-line no-unused-vars -- scenarioKey 暂未使用（保留属性读取语义）
    const scenarioKey = scenario.scenario;
    const scenarioConfig = scenario.config;
    if (!scenarioConfig || !scenarioConfig.preferredSkills) return [];

    const templates = this.templateEngine.listTemplates();
    return templates.filter(t => {
      if (!t.steps) return false;
      const templateSkills = t.steps
        .filter(s => s.type === 'skill')
        .map(s => s.skill);
      return templateSkills.some(s => scenarioConfig.preferredSkills.includes(s));
    });
  }

  _extractParamsFromAnalysis(taskAnalysis) {
    const params = {};
    if (taskAnalysis.entities) {
      if (taskAnalysis.entities.files?.length > 0) {
        params.file_path = taskAnalysis.entities.files[0];
      }
      if (taskAnalysis.entities.urls?.length > 0) {
        params.url = taskAnalysis.entities.urls[0];
      }
    }
    if (taskAnalysis.constraints) {
      if (taskAnalysis.constraints.format) {
        params.format = taskAnalysis.constraints.format;
      }
    }
    return params;
  }

  _assessComplexity(message) {
    let score = 0;
    const indicators = [];

    for (const [type, patterns] of Object.entries(COMPLEXITY_INDICATORS)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          score++;
          indicators.push(type);
          break;
        }
      }
    }

    const sentenceCount = message.split(/[。！？；\n.!?;]/).filter(s => s.trim()).length;
    if (sentenceCount >= 3) {
      score += 0.5;
      indicators.push('long_message');
    }

    const stepWords = (message.match(/[一二三四五六七八九十\d]+[、,，步]/g) || []).length;
    if (stepWords >= 2) {
      score += 0.5;
      indicators.push('numbered_steps');
    }

    const skillCount = Object.entries(SKILL_KEYWORDS).filter(([, patterns]) =>
      patterns.some(p => p.test(message))
    ).length;
    if (skillCount >= 2) {
      score += 0.5;
      indicators.push('multi_skill');
    }

    const synonymExpansion = this._expandWithSynonyms(message);
    if (synonymExpansion.length >= 3) {
      score += 0.3;
      indicators.push('rich_semantics');
    }

    const actionVerbs = (message.match(/(?:创建|生成|分析|搜索|发送|转换|监控|设计|优化|统计|制作|整理|汇总|导出|提取)/g) || []).length;
    if (actionVerbs >= 2) {
      score += 0.3;
      indicators.push('multi_action');
    }

    return { score, indicators };
  }

  _matchSkill(message) {
    let bestSkill = null;
    let bestConfidence = 0;

    for (const [skill, patterns] of Object.entries(SKILL_KEYWORDS)) {
      for (const pattern of patterns) {
        if (pattern.test(message)) {
          const confidence = 0.7;
          if (confidence > bestConfidence) {
            bestConfidence = confidence;
            bestSkill = skill;
          }
          break;
        }
      }
    }

    if (!bestSkill) {
      for (const [skill, patterns] of Object.entries(SKILL_KEYWORDS)) {
        for (const pattern of patterns) {
          const source = pattern.source.replace(/[^\\u4e00-\\u9fff\\w]/g, '');
          const keywords = source.split('|').filter(k => k.length >= 2);
          for (const kw of keywords) {
            const fuzzyScore = this._fuzzyMatchKeyword(message, kw);
            if (fuzzyScore >= 0.7 && fuzzyScore * 0.6 > bestConfidence) {
              bestConfidence = fuzzyScore * 0.6;
              bestSkill = skill;
            }
          }
        }
      }
    }

    if (this._skillRouter) {
      try {
        const routeResult = this._skillRouter.classifyTask(message);
        if (routeResult && routeResult.confidence > bestConfidence) {
          if (routeResult.skillHint) {
            bestSkill = routeResult.skillHint;
            bestConfidence = routeResult.confidence;
          }
        }
      } catch (e) {
        console.warn('[intent-analyzer] skill router classification failed:', e.message);
      }
    }

    if (this._taskAdapter) {
      try {
        const analysis = this._taskAdapter.analyzeTask(message);
        if (analysis && analysis.scenario && analysis.scenario.config) {
          const preferredSkills = analysis.scenario.config.preferredSkills || [];
          if (preferredSkills.length > 0 && analysis.scenario.score > bestConfidence) {
            bestSkill = preferredSkills[0];
            bestConfidence = analysis.scenario.score;
          }
        }
      } catch (e) {
        console.warn('[intent-analyzer] task adapter analysis failed:', e.message);
      }
    }

    if (bestSkill) {
      return { skill: bestSkill, confidence: bestConfidence };
    }

    return null;
  }

  _buildSuggestion(intent, userMessage, _context) {
    const suggestion = {
      intentType: intent.type,
      confidence: intent.confidence,
      shouldCreateFlow: false,
      flowParams: null,
      skillHint: null,
      expertHint: null,
      templateHint: null,
      reasoning: []
    };

    switch (intent.type) {
      case INTENT_TYPES.SIMPLE_CHAT:
        suggestion.reasoning.push('用户消息为简单聊天，无需工作流');
        break;

      case INTENT_TYPES.SINGLE_SKILL:
        suggestion.skillHint = intent.skillMatch?.skill || null;
        suggestion.reasoning.push(`匹配到单一技能: ${suggestion.skillHint}`);
        break;

      case INTENT_TYPES.EXPERT_TASK: {
        const expert = intent.expertMatch?.expert;
        const template = intent.templateMatch?.template;
        suggestion.shouldCreateFlow = true;
        suggestion.expertHint = expert ? { id: expert.id, name: expert.name } : null;
        suggestion.templateHint = template ? { id: template.id, name: template.name } : null;

        if (template && expert && expert.templateIds.includes(template.id)) {
          suggestion.flowParams = this.templateEngine.createFlowFromTemplate(
            template.id, intent.templateMatch.params
          );
          suggestion.reasoning.push(`专家 "${expert.name}" + 模板 "${template.name}" 高度匹配`);
        } else if (expert) {
          suggestion.flowParams = this.templateEngine.createFlowFromExpert(expert.id, userMessage);
          suggestion.reasoning.push(`专家 "${expert.name}" 匹配，将使用专家默认模板`);
        }

        if (template?.steps && suggestion.flowParams && !suggestion.flowParams.stateJson) {
          suggestion.flowParams.stateJson = { steps: template.steps };
        }
        break;
      }

      case INTENT_TYPES.COMPLEX_WORKFLOW: {
        const template = intent.templateMatch?.template;
        suggestion.shouldCreateFlow = true;
        suggestion.templateHint = template ? { id: template.id, name: template.name } : null;

        if (template && intent.templateMatch.score >= 0.35) {
          suggestion.flowParams = this.templateEngine.createFlowFromTemplate(
            template.id, intent.templateMatch.params
          );
          suggestion.reasoning.push(`模板 "${template.name}" 匹配 (分数: ${intent.templateMatch.score.toFixed(2)})`);
        } else {
          suggestion.flowParams = this.templateEngine.generateFromDescription(userMessage);
          suggestion.reasoning.push('无高匹配模板，从描述动态生成工作流');
        }

        if (template?.steps && suggestion.flowParams && !suggestion.flowParams.stateJson) {
          suggestion.flowParams.stateJson = { steps: template.steps };
        }
        break;
      }

      default:
        suggestion.reasoning.push('无法识别意图');
    }

    return suggestion;
  }

  async processIntent(userMessage, context = {}) {
    return this.suggest(userMessage, context);
  }

  _recordUsage(intent) {
    const type = intent.type;
    const current = this._usageStats.get(type) || { count: 0, lastUsed: 0, totalConfidence: 0 };
    current.count++;
    current.lastUsed = Date.now();
    current.totalConfidence += (intent.confidence || 0);
    this._usageStats.set(type, current);
  }

  getWorkflowStatus(flowId) {
    try {
      const api = this._getTaskFlowAPI();
      return api.getFlowStatus(flowId);
    } catch (error) {
      console.error('[IntentAnalyzer] 获取 TaskFlow 状态失败:', error);
      return null;
    }
  }

  getAvailableTemplates(category) {
    return this.templateEngine.listTemplates(category);
  }

  getAvailableExperts(category) {
    const taskflowExperts = this.templateEngine.listExpertRoles(category);

    // 合并 Expert Panel 的专家人格（仅限 builtin，避免 266+ 导入人格膨胀列表）
    let panelExperts = [];
    try {
      const expertModule = require('../core/experts');
      const allPanel = expertModule.getAllExperts();
      panelExperts = allPanel
        .filter(e => e.builtin && e.routingKeywords && e.routingKeywords.length > 0)
        .map(e => ({
          id: e.id,
          name: e.name,
          description: e.description,
          emoji: typeof e.icon === 'string' && e.icon.length <= 2 ? e.icon : '🎯',
          category: e.category || 'custom',
          keywords: e.routingKeywords || [],
        }));
    } catch {
      // Expert Panel 模块不可用时优雅降级
    }

    const seen = new Set(taskflowExperts.map(e => e.id));
    const merged = [...taskflowExperts];
    for (const pe of panelExperts) {
      if (!seen.has(pe.id)) {
        merged.push(pe);
      }
    }

    return merged;
  }

  getUsageStats() {
    const stats = {};
    let totalCount = 0;
    for (const [type, data] of this._usageStats) {
      stats[type] = { ...data };
      totalCount += data.count;
    }

    const workflowCount = (stats[INTENT_TYPES.COMPLEX_WORKFLOW]?.count || 0) +
                          (stats[INTENT_TYPES.EXPERT_TASK]?.count || 0);
    const workflowAvgConfidence = workflowCount > 0
      ? ((stats[INTENT_TYPES.COMPLEX_WORKFLOW]?.totalConfidence || 0) +
         (stats[INTENT_TYPES.EXPERT_TASK]?.totalConfidence || 0)) / workflowCount
      : 0;

    return {
      byType: stats,
      summary: {
        totalAnalyses: totalCount,
        workflowTriggerRate: totalCount > 0 ? workflowCount / totalCount : 0,
        workflowAvgConfidence: Math.round(workflowAvgConfidence * 100) / 100,
        skillMatchRate: totalCount > 0 ? (stats[INTENT_TYPES.SINGLE_SKILL]?.count || 0) / totalCount : 0,
        chatRate: totalCount > 0 ? (stats[INTENT_TYPES.SIMPLE_CHAT]?.count || 0) / totalCount : 0
      }
    };
  }

  getConversationContext(userId) {
    return this._conversationContext[userId] || [];
  }

  clearCache() {
    this._matchCache.clear();
  }
}

let intentAnalyzer = null;

function getIntentAnalyzer() {
  if (!intentAnalyzer) {
    intentAnalyzer = new IntentAnalyzer();
  }
  return intentAnalyzer;
}

module.exports = {
  IntentAnalyzer,
  getIntentAnalyzer,
  INTENT_TYPES,
  COMPLEXITY_INDICATORS,
  SKILL_KEYWORDS,
  SYNONYM_MAP,
  INTENT_BOOST_PATTERNS
};
