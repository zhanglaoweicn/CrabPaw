/**
 * Skill Chain Templates — 技能链模板系统
 *
 * 将高频技能组合固化为可复用的工作流模板：
 *
 *   技能链 = 有序技能序列 + 触发条件 + 数据流映射 + 质量门控
 *
 * 核心概念：
 *   - 触发条件：什么样的用户请求应激活此模板
 *   - 数据流映射：前序技能的输出如何传递给后续技能
 *   - 质量门控：每个步骤的成功条件，失败时的回退策略
 *   - 并行步骤：某些步骤可以并行执行
 *
 * 模板示例：
 *   "财务报告自动化" = pdf-to-word-docx → excel-xlsx → financial-analyst → word-docx
 *   "营销内容生产" = multi-search-engine → marketing → humanizer
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');

const TEMPLATES_DIR = path.join(DATA_DIR, 'composition', 'chain-templates');

// 内置模板：基于 CrabPaw 现有技能的常见组合
const BUILTIN_TEMPLATES = [
  {
    id: 'financial-report-automation',
    name: '财务报告自动化',
    description: '从 PDF/图片提取财务数据 → Excel 分析 → Word 报告',
    triggerPatterns: [
      /(?:财务报告|财务报表|年报|季报|审计报告).*(?:自动化|生成|制作|提取)/i,
      /(?:提取|转换).*(?:财务|年报|审计).*(?:数据|报告)/i,
    ],
    steps: [
      { skill: 'pdf-to-word-docx', outputKey: 'extractedData', qualityGate: 'conversionSuccess' },
      { skill: 'excel-xlsx', inputKey: 'extractedData', outputKey: 'analysisResult', qualityGate: 'noFormulaErrors' },
      { skill: 'financial-analyst', inputKey: 'analysisResult', outputKey: 'financialInsight', qualityGate: 'analysisComplete' },
      { skill: 'word-docx', inputKey: 'financialInsight', outputKey: 'report', qualityGate: 'documentValid' },
    ],
    fallbackStrategy: 'skip_step', // 失败时跳过当前步骤继续
    metadata: { category: 'finance', estimatedSteps: 4 },
  },
  {
    id: 'marketing-content-pipeline',
    name: '营销内容生产线',
    description: '市场调研 → 营销策略 → 内容写作 → 人性化润色',
    triggerPatterns: [
      /(?:营销|推广|内容).*(?:方案|策略|计划|生产线|pipeline)/i,
      /(?:做.*营销|营销.*内容|内容.*营销|全链路.*营销)/i,
    ],
    steps: [
      { skill: 'multi-search-engine', outputKey: 'marketData', qualityGate: 'resultsFound' },
      { skill: 'marketing', inputKey: 'marketData', outputKey: 'marketingPlan', qualityGate: 'planComplete' },
      { skill: 'marketing', inputKey: 'marketingPlan', outputKey: 'draftContent', qualityGate: 'contentGenerated', params: { mode: 'content-writing' } },
      { skill: 'humanizer', inputKey: 'draftContent', outputKey: 'finalContent', qualityGate: 'humanizedScore' },
    ],
    fallbackStrategy: 'retry_step',
    metadata: { category: 'marketing', estimatedSteps: 4 },
  },
  {
    id: 'document-format-conversion',
    name: '文档格式转换链',
    description: 'PDF 转换为 Word/Excel/PPT，保留格式和内容',
    triggerPatterns: [
      /(?:批量.*转换|转换.*文档|文档.*格式.*转换)/i,
      /(?:pdf.*转.*office|office.*转.*pdf)/i,
    ],
    steps: [
      { skill: 'pdf-to-word-docx', outputKey: 'convertedDoc', qualityGate: 'conversionSuccess' },
    ],
    fallbackStrategy: 'abort',
    metadata: { category: 'document', estimatedSteps: 1 },
    // 动态步骤：根据用户请求的目标格式决定
    dynamicStep: true,
  },
  {
    id: 'research-and-report',
    name: '调研报告生成',
    description: '多源搜索 → 信息整合 → Word 报告',
    triggerPatterns: [
      /(?:调研|研究|调查).*(?:报告|文档|文档)/i,
      /(?:写|生成|制作).*(?:调研|研究|调查).*(?:报告|文档)/i,
    ],
    steps: [
      { skill: 'multi-search-engine', outputKey: 'researchData', qualityGate: 'resultsFound' },
      { skill: 'summarize-pro', inputKey: 'researchData', outputKey: 'summary', qualityGate: 'summaryComplete' },
      { skill: 'word-docx', inputKey: 'summary', outputKey: 'report', qualityGate: 'documentValid' },
    ],
    fallbackStrategy: 'skip_step',
    metadata: { category: 'research', estimatedSteps: 3 },
  },
  {
    id: 'data-analysis-presentation',
    name: '数据分析演示',
    description: 'Excel 数据分析 → PPT 演示文稿',
    triggerPatterns: [
      /(?:数据分析|数据报告).*(?:演示|PPT|汇报|展示)/i,
      /(?:做|生成|制作).*(?:数据.*PPT|分析.*演示|汇报.*材料)/i,
    ],
    steps: [
      { skill: 'excel-xlsx', outputKey: 'analysisResult', qualityGate: 'noFormulaErrors' },
      { skill: 'financial-analyst', inputKey: 'analysisResult', outputKey: 'insights', qualityGate: 'analysisComplete' },
      { skill: 'powerpoint-pptx', inputKey: 'insights', outputKey: 'presentation', qualityGate: 'slidesValid' },
    ],
    fallbackStrategy: 'skip_step',
    metadata: { category: 'data', estimatedSteps: 3 },
  },
];

class SkillChainTemplates extends EventEmitter {
  constructor(config = {}) {
    super();
    this._templatesDir = config.templatesDir || TEMPLATES_DIR;
    this._templates = new Map(); // id → template
    this._customTemplates = new Map();
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;

    // 加载内置模板
    for (const template of BUILTIN_TEMPLATES) {
      this._templates.set(template.id, { ...template, builtin: true });
    }

    // 加载自定义模板
    this._loadCustomTemplates();

    this._initialized = true;
    console.log('[ChainTemplates] 技能链模板初始化完成', {
      builtin: this._templates.size,
      custom: this._customTemplates.size,
    });
  }

  /**
   * 匹配用户输入到模板
   * @returns {Array<{template, matchScore, matchedPattern}>}
   */
  matchInput(userInput) {
    const results = [];
    const allTemplates = [...this._templates.values(), ...this._customTemplates.values()];

    for (const template of allTemplates) {
      if (!template.triggerPatterns) continue;

      for (const pattern of template.triggerPatterns) {
        if (pattern.test(userInput)) {
          results.push({
            template,
            matchScore: 0.9,
            matchedPattern: pattern.source,
          });
          break;
        }
      }
    }

    results.sort((a, b) => b.matchScore - a.matchScore);
    return results;
  }

  /**
   * 获取模板
   */
  getTemplate(templateId) {
    return this._templates.get(templateId) || this._customTemplates.get(templateId) || null;
  }

  /**
   * 获取所有模板
   */
  getAllTemplates() {
    return {
      builtin: [...this._templates.values()],
      custom: [...this._customTemplates.values()],
      total: this._templates.size + this._customTemplates.size,
    };
  }

  /**
   * 注册自定义模板
   */
  registerCustomTemplate(template) {
    const required = ['id', 'name', 'steps'];
    for (const field of required) {
      if (!template[field]) {
        throw new Error(`自定义模板缺少必需字段: ${field}`);
      }
    }
    if (template.steps.length < 2) {
      throw new Error('技能链模板至少需要 2 个步骤');
    }

    this._customTemplates.set(template.id, {
      ...template,
      builtin: false,
      createdAt: new Date().toISOString(),
    });
    this._saveCustomTemplates();
    this.emit('template:registered', { id: template.id, name: template.name });
  }

  /**
   * 从组合发现引擎的模板创建技能链模板
   */
  createFromComposition(compositionTemplate) {
    const steps = compositionTemplate.skills.map((skill, i) => ({
      skill,
      outputKey: `step${i + 1}Output`,
      qualityGate: 'success',
    }));

    const template = {
      id: `auto-${compositionTemplate.key.replace(/→/g, '-')}`,
      name: compositionTemplate.name,
      description: compositionTemplate.description,
      triggerPatterns: [], // 自动发现的模板暂无触发模式，需手动添加
      steps,
      fallbackStrategy: 'skip_step',
      metadata: {
        autoDiscovered: true,
        sourceStrength: compositionTemplate.strength,
        sourceCount: compositionTemplate.count,
      },
    };

    this.registerCustomTemplate(template);
    return template;
  }

  /**
   * 验证模板中的技能是否都存在
   */
  validateTemplate(template, availableSkills) {
    const missing = [];
    for (const step of template.steps) {
      if (!availableSkills.includes(step.skill)) {
        missing.push(step.skill);
      }
    }
    return {
      valid: missing.length === 0,
      missing,
      totalSteps: template.steps.length,
      availableSteps: template.steps.length - missing.length,
    };
  }

  _loadCustomTemplates() {
    try {
      if (!fs.existsSync(this._templatesDir)) {
        fs.mkdirSync(this._templatesDir, { recursive: true });
        return;
      }
      const file = path.join(this._templatesDir, 'custom-templates.json');
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        for (const t of data.templates || []) {
          this._customTemplates.set(t.id, t);
        }
      }
    } catch (e) {
      console.warn('[skill-chain-templates] load failed (first run?):', e.message);
    }
  }

  _saveCustomTemplates() {
    try {
      if (!fs.existsSync(this._templatesDir)) {
        fs.mkdirSync(this._templatesDir, { recursive: true });
      }
      const file = path.join(this._templatesDir, 'custom-templates.json');
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        templates: [...this._customTemplates.values()],
      };
      const tmpFile = file + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, file);
    } catch (err) {
      console.error('[ChainTemplates] 保存自定义模板失败:', err.message);
    }
  }

  shutdown() {
    this._saveCustomTemplates();
  }

  /**
   * registerTemplate — registerCustomTemplate 的简写别名
   */
  registerTemplate(template) {
    return this.registerCustomTemplate(template);
  }
}

// 单例
let _instance = null;

function getSkillChainTemplates(config) {
  if (!_instance) {
    _instance = new SkillChainTemplates(config);
  }
  return _instance;
}

module.exports = { SkillChainTemplates, getSkillChainTemplates, BUILTIN_TEMPLATES };
