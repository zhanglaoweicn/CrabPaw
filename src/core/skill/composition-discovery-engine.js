/**
 * Composition Discovery Engine — 组合发现引擎
 *
 * 在技能组合图谱之上，提供高层发现和推荐能力：
 *
 *   1. 自动发现：定期扫描图谱，将高频组合固化为"隐式技能"
 *   2. 智能推荐：给定用户意图，推荐技能组合而非单个技能
 *   3. 预加载：当技能 A 被激活时，预测并预加载后续技能 B
 *   4. 组合路由：将复杂请求拆解为技能链，而非路由到单个技能
 *
 * 与 skill-router.js 的集成点：
 *   - getRecommendedSkills() 增强为可返回技能组合
 *   - route() 增强为可返回技能链
 */

const { EventEmitter } = require('events');
const { getCompositionGraph } = require('./skill-composition-graph');
const { getSkillLineage } = require('./skill-lineage');

const DISCOVERY_INTERVAL = 4 * 3600 * 1000; // 4 小时发现一次
const MIN_TEMPLATE_STRENGTH = 0.4;           // 最低强度才固化为模板
const MIN_TEMPLATE_COUNT = 5;                 // 最少出现次数
const REVIEWED_SKILLS_FILE = 'reviewed-skills.json';

class CompositionDiscoveryEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this._graph = null;
    this._discoveredTemplates = [];  // 自动发现的技能链模板
    this._customTemplates = [];      // 用户自定义模板
    this._discoveryTimer = null;
    this._initialized = false;
    this._reviewedSkills = new Set(); // 已审查技能集合
    this._config = {
      discoveryInterval: config.discoveryInterval || DISCOVERY_INTERVAL,
      minTemplateStrength: config.minTemplateStrength || MIN_TEMPLATE_STRENGTH,
      minTemplateCount: config.minTemplateCount || MIN_TEMPLATE_COUNT,
      ...config,
    };
  }

  initialize({ graph } = {}) {
    if (this._initialized) return;

    this._graph = graph || getCompositionGraph();
    this._loadTemplates();
    this._loadReviewedSkills();

    // 启动定期发现
    this._discoveryTimer = setInterval(() => {
      this.runDiscovery();
    }, this._config.discoveryInterval);

    this._initialized = true;
    console.log('[CompositionDiscovery] 组合发现引擎初始化完成', {
      templates: this._discoveredTemplates.length + this._customTemplates.length,
    });
  }

  /**
   * 运行一次发现周期
   * 扫描图谱 → 发现高频组合 → 固化为模板 → 检测涌现
   */
  runDiscovery() {
    if (!this._graph) return;

    // Step 1: 重新计算强度
    this._graph.recalculateStrengths();

    // Step 2: 发现高频组合
    const compositions = this._graph.discoverFrequentCompositions({
      minCount: this._config.minTemplateCount,
      minStrength: this._config.minTemplateStrength,
    });

    // Step 3: 固化为模板（去重）
    const newTemplates = [];
    const warnedUnreviewed = new Set();
    for (const comp of compositions) {
      // Warn about unreviewed skills in compositions (do not silently skip)
      for (const skill of comp.skills) {
        if (!this._reviewedSkills.has(skill) && !warnedUnreviewed.has(skill)) {
          warnedUnreviewed.add(skill);
          console.warn(`[CompositionDiscovery] Composition uses unreviewed skill "${skill}" -- including but not verified`);
          this.emit('warning:unreviewed_skill', { skill, composition: comp.skills });
        }
      }

      const key = comp.skills.join('→');
      const existing = this._discoveredTemplates.find(t => t.key === key);
      if (!existing) {
        const template = {
          key,
          skills: comp.skills,
          strength: comp.strength,
          count: comp.count,
          successRate: comp.successRate,
          autoDiscovered: true,
          discoveredAt: new Date().toISOString(),
          // 生成模板名称和描述
          name: this._generateTemplateName(comp.skills),
          description: this._generateTemplateDescription(comp.skills, comp.successRate),
        };
        newTemplates.push(template);
        this.emit('template:discovered', template);

        // Record lineage: fused (composition discovery)
        try {
          if (comp.skills && comp.skills.length > 1) {
            getSkillLineage().recordDerivation(comp.skills, template.name || key, 'fused', {
              strength: comp.strength,
              count: comp.count,
              successRate: comp.successRate,
              autoDiscovered: true,
            });
          }
        } catch (e) {
          console.warn('[CompositionDiscovery] Lineage recording failed:', e.message);
        }
      } else {
        // 更新已有模板的统计
        existing.strength = comp.strength;
        existing.count = comp.count;
        existing.successRate = comp.successRate;
      }
    }

    this._discoveredTemplates = [
      ...newTemplates,
      ...this._discoveredTemplates.filter(t => !newTemplates.find(n => n.key === t.key)),
    ];

    // Step 4: 检测涌现能力
    const emergences = this._graph.detectEmergence();
    if (emergences.length > 0) {
      this.emit('emergence:detected', emergences);
      console.log(`[CompositionDiscovery] 检测到 ${emergences.length} 个涌现能力`);
    }

    this._saveTemplates();

    console.log(`[CompositionDiscovery] 发现周期完成`, {
      compositions: compositions.length,
      newTemplates: newTemplates.length,
      totalTemplates: this._discoveredTemplates.length + this._customTemplates.length,
      emergences: emergences.length,
    });
  }

  /**
   * 智能推荐：给定用户输入，返回技能组合推荐
   *
   * 优先级：
   *   1. 匹配自定义模板
   *   2. 匹配自动发现模板
   *   3. 基于图谱的预测推荐
   *   4. 降级为单技能推荐
   */
  recommendComposition(userInput, options = {}) {
    const maxResults = options.maxResults || 3;
    const results = [];

    // Step 1: 匹配模板
    const allTemplates = [...this._customTemplates, ...this._discoveredTemplates];
    for (const template of allTemplates) {
      const matchScore = this._matchTemplateToInput(template, userInput);
      if (matchScore > 0.5) {
        results.push({
          type: 'template',
          name: template.name,
          skills: template.skills,
          score: matchScore * template.strength,
          reason: `匹配技能链模板「${template.name}」`,
          successRate: template.successRate,
        });
      }
    }

    // Step 2: 基于意图模式预测后续技能
    const intentMatch = this._matchIntent(userInput);
    if (intentMatch && intentMatch.skillHint) {
      const predictions = this._graph.predictNext(intentMatch.skillHint, { maxResults: 2 });
      if (predictions.length > 0) {
        results.push({
          type: 'predicted_chain',
          skills: [intentMatch.skillHint, ...predictions.map(p => p.skill)],
          score: intentMatch.confidence * predictions[0].strength,
          reason: `基于「${intentMatch.skillHint}」的后续预测`,
          predictions: predictions.map(p => ({
            skill: p.skill,
            confidence: p.confidence,
            strength: p.strength,
          })),
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  /**
   * 预加载推荐：给定当前激活的技能，返回应预加载的后续技能
   */
  getPreloadRecommendations(currentSkill) {
    return this._graph.predictNext(currentSkill, { maxResults: 3, minStrength: 0.2 });
  }

  /**
   * 注册自定义模板
   */
  registerCustomTemplate(template) {
    if (!template.skills || template.skills.length < 2) {
      throw new Error('Composition error');
    }
    const key = template.skills.join('→');
    this._customTemplates.push({
      key,
      skills: template.skills,
      name: template.name || key,
      description: template.description || '',
      strength: 1.0, // 用户自定义模板默认最高强度
      autoDiscovered: false,
      createdAt: new Date().toISOString(),
    });
    this._saveTemplates();
    this.emit('template:registered', { key, name: template.name });
  }

  /**
   * 标记技能为已审查
   */
  markSkillAsReviewed(skillName) {
    this._reviewedSkills.add(skillName);
    this._saveReviewedSkills();
    this.emit('skill:reviewed', { skill: skillName });
  }

  /**
   * 检查技能是否已审查
   */
  isSkillReviewed(skillName) {
    return this._reviewedSkills.has(skillName);
  }

  /**
   * 获取未审查技能列表
   */
  getUnreviewedSkills() {
    const allSkills = new Set();
    for (const t of this._discoveredTemplates) {
      for (const s of t.skills) allSkills.add(s);
    }
    for (const t of this._customTemplates) {
      for (const s of t.skills) allSkills.add(s);
    }
    return [...allSkills].filter(s => !this._reviewedSkills.has(s));
  }

  /**
   * 获取所有模板
   */
  getAllTemplates() {
    return {
      custom: this._customTemplates,
      discovered: this._discoveredTemplates,
      total: this._customTemplates.length + this._discoveredTemplates.length,
    };
  }

  /**
   * 匹配模板到用户输入
   */
  _matchTemplateToInput(template, userInput) {
    const input = userInput.toLowerCase();
    // 简单关键词匹配：模板中的技能名出现在输入中
    let matchCount = 0;
    for (const skill of template.skills) {
      // 将技能名拆分为可匹配的关键词
      const keywords = skill.split(/[-_]/);
      for (const kw of keywords) {
        if (kw.length > 2 && input.includes(kw.toLowerCase())) {
          matchCount++;
          break;
        }
      }
    }
    return template.skills.length > 0 ? matchCount / template.skills.length : 0;
  }

  /**
   * 匹配意图模式（延迟加载避免循环依赖）
   */
  _matchIntent(userInput) {
    const { INTENT_PATTERNS } = require('../skill-router');
    for (const { pattern, category, skillHint, confidence } of INTENT_PATTERNS) {
      if (pattern.test(userInput)) {
        return { category, skillHint, confidence };
      }
    }
    return null;
  }

  /**
   * 生成模板名称
   */
  _generateTemplateName(skills) {
    const nameMap = {
      'pdf-to-word-docx': 'PDF转换',
      'excel-xlsx': 'Excel',
      'word-docx': 'Word',
      'powerpoint-pptx': 'PPT',
      'financial-analyst': '财务分析',
      'stock-analyst-enhanced': '股票分析',
      'marketing': '营销',
      'humanizer': '人性化写作',
      'frontend-design': '前端设计',
      'multi-search-engine': '搜索',
      'file-manager': '文件管理',
      'browser-use': '浏览器',
      'windows-ui-automation': '桌面自动化',
      'wechat-article-search': '微信搜索',
      'self-improving-agent': '自我改进',
    };

    const names = skills.map(s => nameMap[s] || s);
    return names.join(' + ');
  }

  /**
   * 生成模板描述
   */
  _generateTemplateDescription(skills, successRate) {
    const pct = (successRate * 100).toFixed(0);
    return `自动发现的技能链 ${skills.join(' → ')}，成功率 ${pct}%`;
  }

  _loadTemplates() {
    try {
      const fs = require('fs');
      const path = require('path');
      const { DATA_DIR } = require('../config');
      const file = path.join(DATA_DIR, 'composition', 'templates.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        this._discoveredTemplates = data.discovered || [];
        this._customTemplates = data.custom || [];
      }
    } catch (e) {
      console.warn('[composition-discovery-engine] load failed (first run?):', e.message);
    }
  }

  _loadReviewedSkills() {
    try {
      const fs = require('fs');
      const path = require('path');
      const { DATA_DIR } = require('../config');
      const file = path.join(DATA_DIR, 'composition', REVIEWED_SKILLS_FILE);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Array.isArray(data.skills)) {
          this._reviewedSkills = new Set(data.skills);
        }
      }
    } catch (e) {
      console.warn('[composition-discovery-engine] reviewed skills load failed:', e.message);
    }
  }

  _saveReviewedSkills() {
    try {
      const fs = require('fs');
      const path = require('path');
      const { DATA_DIR } = require('../config');
      const dir = path.join(DATA_DIR, 'composition');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, REVIEWED_SKILLS_FILE);
      const data = { version: 1, updatedAt: new Date().toISOString(), skills: [...this._reviewedSkills] };
      const tmpFile = file + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, file);
    } catch (err) {
      console.error('[CompositionDiscovery] save reviewed skills failed:', err.message);
    }
  }

  _saveTemplates() {
    try {
      const fs = require('fs');
      const path = require('path');
      const { DATA_DIR } = require('../config');
      const dir = path.join(DATA_DIR, 'composition');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const file = path.join(dir, 'templates.json');
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        discovered: this._discoveredTemplates,
        custom: this._customTemplates,
      };
      const tmpFile = file + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, file);
    } catch (err) {
      console.error('[CompositionDiscovery] 保存模板失败:', err.message);
    }
  }

  shutdown() {
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
    this._saveTemplates();
    this._saveReviewedSkills();
  }
}

// 单例
let _instance = null;

function getCompositionDiscoveryEngine(config) {
  if (!_instance) {
    _instance = new CompositionDiscoveryEngine(config);
  }
  return _instance;
}

module.exports = { CompositionDiscoveryEngine, getCompositionDiscoveryEngine };
