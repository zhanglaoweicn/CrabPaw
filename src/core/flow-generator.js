const SKILL_PATTERNS = {
  'excel-xlsx': {
    keywords: ['excel', 'xlsx', '表格', '电子表格', '读取文件', '读取数据', '导入数据', 'excel文件', '表格文件'],
    displayName: '📗 Excel处理',
    description: '读取和处理 Excel 文件',
    category: '文档'
  },
  'financial-analyst': {
    keywords: ['财务', '财务分析', '财务报表', '资产负债', '利润表', '现金流', '经营分析', '财务数据', '财务指标'],
    displayName: '📊 财务分析',
    description: '分析财务数据和报表',
    category: '分析'
  },
  'summarize-pro': {
    keywords: ['摘要', '总结', '概括', '提炼', '摘要报告', '生成摘要', '总结报告', '内容摘要', '文本摘要'],
    displayName: '📝 摘要引擎',
    description: '生成各种格式的摘要',
    category: '文本处理'
  },
  'multi-search-engine': {
    keywords: ['搜索', '查找', '检索', '搜索信息', '查找资料', '搜索内容', '网络搜索', '资讯', '新闻'],
    displayName: '🔍 搜索引擎',
    description: '搜索网络信息',
    category: '搜索'
  },
  'weather': {
    keywords: ['天气', '天气预报', '气象', '温度', '下雨', '晴天'],
    displayName: '🌤️ 天气查询',
    description: '查询天气信息',
    category: '信息查询'
  },
  'stock-analyst-enhanced': {
    keywords: ['股票', '股价', '股市', '股票分析', '证券', 'A股', '港股', '美股'],
    displayName: '📈 股票分析',
    description: '分析股票数据',
    category: '金融'
  },
  'pdf-generator': {
    keywords: ['pdf', 'PDF', '生成pdf', '导出pdf', 'pdf文件', 'pdf文档'],
    displayName: '📄 PDF生成',
    description: '生成 PDF 文档',
    category: '文档'
  },
  'chart-visualization': {
    keywords: ['图表', '可视化', '画图', '绘图', '柱状图', '折线图', '饼图', '数据可视化'],
    displayName: '📊 图表可视化',
    description: '生成数据图表',
    category: '可视化'
  },
  'pptx-generator': {
    keywords: ['ppt', 'PPT', '幻灯片', '演示文稿', 'pptx', '生成ppt'],
    displayName: '📽️ PPT生成',
    description: '生成演示文稿',
    category: '文档'
  },
  'text-input': {
    keywords: ['输入', '文本', '文字', '内容'],
    displayName: '📝 文本输入',
    description: '提供初始文本',
    category: '控制'
  }
};

const WORKFLOW_TEMPLATES = [
  {
    id: 'financial-report',
    name: '财务报告生成',
    description: '读取 Excel 财务数据，进行分析并生成摘要报告',
    keywords: ['财务', '报告', 'excel', '分析'],
    steps: [
      { skill: 'excel-xlsx', input: '', outputKey: 'excel_data' },
      { skill: 'financial-analyst', input: '${excel_data}', outputKey: 'analysis' },
      { skill: 'summarize-pro', input: '${analysis}', outputKey: 'report' }
    ]
  },
  {
    id: 'daily-news',
    name: '每日资讯摘要',
    description: '搜索最新资讯并生成摘要报告',
    keywords: ['新闻', '资讯', '搜索', '摘要', '每日'],
    steps: [
      { skill: 'multi-search-engine', input: '', outputKey: 'search_results' },
      { skill: 'summarize-pro', input: '${search_results}', outputKey: 'summary' }
    ]
  },
  {
    id: 'stock-analysis',
    name: '股票分析报告',
    description: '分析股票数据并生成报告',
    keywords: ['股票', '分析', '投资'],
    steps: [
      { skill: 'stock-analyst-enhanced', input: '', outputKey: 'stock_data' },
      { skill: 'summarize-pro', input: '${stock_data}', outputKey: 'report' }
    ]
  },
  {
    id: 'data-to-chart',
    name: '数据可视化',
    description: '将数据转换为可视化图表',
    keywords: ['图表', '可视化', '数据', '绘图'],
    steps: [
      { skill: 'excel-xlsx', input: '', outputKey: 'data' },
      { skill: 'chart-visualization', input: '${data}', outputKey: 'chart' }
    ]
  },
  {
    id: 'weather-report',
    name: '天气报告',
    description: '查询天气并生成报告',
    keywords: ['天气', '气象', '预报'],
    steps: [
      { skill: 'weather', input: '', outputKey: 'weather_data' },
      { skill: 'summarize-pro', input: '${weather_data}', outputKey: 'report' }
    ]
  },
  {
    id: 'research-summary',
    name: '研究摘要',
    description: '搜索研究主题并生成摘要',
    keywords: ['研究', '调研', '搜索', '总结'],
    steps: [
      { skill: 'multi-search-engine', input: '', outputKey: 'research_data' },
      { skill: 'summarize-pro', input: '${research_data}', outputKey: 'summary' }
    ]
  }
];

const SKILL_SEQUENCE_HINTS = {
  'excel-xlsx': {
    next: ['financial-analyst', 'summarize-pro', 'chart-visualization', 'pptx-generator'],
    reason: 'Excel 数据可用于分析、摘要、可视化或生成演示文稿'
  },
  'financial-analyst': {
    next: ['summarize-pro', 'chart-visualization', 'pptx-generator'],
    reason: '财务分析结果可用于生成摘要、图表或演示文稿'
  },
  'multi-search-engine': {
    next: ['summarize-pro', 'financial-analyst', 'stock-analyst-enhanced'],
    reason: '搜索结果可用于生成摘要或进一步分析'
  },
  'stock-analyst-enhanced': {
    next: ['summarize-pro', 'chart-visualization'],
    reason: '股票分析结果可用于生成摘要或图表'
  },
  'weather': {
    next: ['summarize-pro'],
    reason: '天气数据可用于生成报告'
  },
  'chart-visualization': {
    next: ['pptx-generator', 'pdf-generator'],
    reason: '图表可导出为演示文稿或 PDF'
  },
  'summarize-pro': {
    next: ['pptx-generator', 'pdf-generator'],
    reason: '摘要可导出为演示文稿或 PDF'
  }
};

// eslint-disable-next-line no-unused-vars -- 函数签名参数 skillsRegistry 未用（不改签名）
function parseNaturalLanguage(text, skillsRegistry = {}) {
  const result = {
    success: true,
    steps: [],
    detectedSkills: [],
    confidence: 0,
    suggestions: []
  };

  const lowerText = text.toLowerCase();
  const detectedSkillScores = {};

  for (const [skillId, pattern] of Object.entries(SKILL_PATTERNS)) {
    let score = 0;
    const matchedKeywords = [];

    for (const keyword of pattern.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        score += keyword.length;
        matchedKeywords.push(keyword);
      }
    }

    if (score > 0) {
      detectedSkillScores[skillId] = {
        score,
        matchedKeywords,
        pattern
      };
    }
  }

  const sortedSkills = Object.entries(detectedSkillScores)
    .sort((a, b) => b[1].score - a[1].score);

  for (const [skillId, data] of sortedSkills) {
    result.detectedSkills.push({
      id: skillId,
      displayName: data.pattern.displayName,
      description: data.pattern.description,
      matchedKeywords: data.matchedKeywords,
      score: data.score
    });
  }

  if (result.detectedSkills.length === 0) {
    result.success = false;
    result.needsSkillGeneration = true;
    result.suggestions.push('未识别到相关技能，可以尝试以下方式：');
    result.suggestions.push('1. 描述更具体的需求，例如：帮我分析财务数据并生成报告');
    result.suggestions.push('2. 让 AI 自动生成新技能来满足需求');
    result.skillGenerationPrompt = text;
    return result;
  }

  const orderedSkills = orderSkillsBySequence(result.detectedSkills.map(s => s.id));
  
  for (let i = 0; i < orderedSkills.length; i++) {
    const skillId = orderedSkills[i];
    const skillInfo = SKILL_PATTERNS[skillId];
    
    result.steps.push({
      id: `step_${i}`,
      skill: skillId,
      displayName: skillInfo?.displayName || skillId,
      description: skillInfo?.description || '',
      input: i > 0 ? `\${step_${i - 1}}` : '',
      outputKey: `step_${i}`
    });
  }

  result.confidence = Math.min(
    result.detectedSkills.reduce((sum, s) => sum + s.score, 0) / 100,
    1
  );

  if (result.steps.length > 1) {
    const lastSkill = orderedSkills[orderedSkills.length - 1];
    const hints = SKILL_SEQUENCE_HINTS[lastSkill];
    if (hints && hints.next.length > 0) {
      for (const nextSkill of hints.next) {
        if (!orderedSkills.includes(nextSkill)) {
          result.suggestions.push(`建议添加「${SKILL_PATTERNS[nextSkill]?.displayName || nextSkill}」作为下一步`);
        }
      }
    }
  }

  return result;
}

function orderSkillsBySequence(skillIds) {
  const ordered = [];
  const remaining = [...skillIds];

  const priorityOrder = [
    'text-input',
    'excel-xlsx',
    'multi-search-engine',
    'weather',
    'stock-analyst-enhanced',
    'financial-analyst',
    'chart-visualization',
    'summarize-pro',
    'pptx-generator',
    'pdf-generator'
  ];

  for (const priority of priorityOrder) {
    const index = remaining.indexOf(priority);
    if (index !== -1) {
      ordered.push(priority);
      remaining.splice(index, 1);
    }
  }

  ordered.push(...remaining);

  return ordered;
}

function findMatchingTemplates(text) {
  const lowerText = text.toLowerCase();
  const matches = [];

  for (const template of WORKFLOW_TEMPLATES) {
    let score = 0;
    const matchedKeywords = [];

    for (const keyword of template.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        score += keyword.length;
        matchedKeywords.push(keyword);
      }
    }

    if (score > 0) {
      matches.push({
        ...template,
        score,
        matchedKeywords,
        matchRatio: matchedKeywords.length / template.keywords.length
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

function getRecommendedNextSkills(currentSkillId) {
  const hints = SKILL_SEQUENCE_HINTS[currentSkillId];
  if (!hints) return [];

  return hints.next.map(skillId => ({
    id: skillId,
    displayName: SKILL_PATTERNS[skillId]?.displayName || skillId,
    description: SKILL_PATTERNS[skillId]?.description || '',
    reason: hints.reason
  }));
}

function generateFlowFromTemplate(templateId) {
  const template = WORKFLOW_TEMPLATES.find(t => t.id === templateId);
  if (!template) return null;

  return {
    name: template.name,
    description: template.description,
    steps: template.steps.map((step, index) => ({
      id: `step_${index}`,
      skill: step.skill,
      displayName: SKILL_PATTERNS[step.skill]?.displayName || step.skill,
      description: SKILL_PATTERNS[step.skill]?.description || '',
      input: step.input,
      outputKey: step.outputKey
    }))
  };
}

module.exports = {
  parseNaturalLanguage,
  findMatchingTemplates,
  getRecommendedNextSkills,
  generateFlowFromTemplate,
  WORKFLOW_TEMPLATES,
  SKILL_PATTERNS,
  SKILL_SEQUENCE_HINTS
};
