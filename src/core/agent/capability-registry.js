const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const CAPABILITIES = {
  researcher: {
    id: 'researcher',
    name: '调研员',
    nameEn: 'Researcher',
    emoji: '🔍',
    description: '信息搜集与来源验证',
    tier: 'worker',
    model: 'fast',
    maxIterations: 10,
    allowedTools: ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'memory_search'],
    disallowedTools: ['write', 'bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}调研员
核心职责：- 搜集{domain}领域的准确信息 - 验证信息来源的可靠性 - 整理关键发现并标注来源 - 不修改任何文档
{domain_soul}

调研规范：{domain_rules}

工作原则：1. 信息必须标注来源
2. 区分事实与观点
3. 不确定的信息明确标注置信度
4. 保持客观中立`,
  },

  monitor: {
    id: 'monitor',
    name: '监控员',
    nameEn: 'Monitor',
    emoji: '📡',
    description: '数据监控与异常检测',
    tier: 'worker',
    model: 'fast',
    maxIterations: 8,
    allowedTools: ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'memory_search'],
    disallowedTools: ['write', 'bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}监控员
核心职责：- 监控{domain}领域的关键指标 - 及时发现异常和偏差 - 发出预警并说明原因 - 跟踪变化趋势

{domain_soul}

监控规范：{domain_rules}

工作原则：1. 明确标注监控指标和阈值 2. 异常必须说明严重等级
3. 提供可能的原因分析 4. 建议应对措施`,
  },

  writer: {
    id: 'writer',
    name: '撰写员',
    nameEn: 'Writer',
    emoji: '✍️',
    description: '内容创作与文档编辑',
    tier: 'worker',
    model: 'fast',
    maxIterations: 12,
    allowedTools: ['read', 'write', 'edit', 'grep', 'glob', 'memory_search'],
    disallowedTools: ['bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}撰写员
核心职责：- 撰写{domain}领域的专业文档 - 确保内容准确、结构清晰 - 遵循行业写作规范
- 适配目标读者
{domain_soul}

撰写规范：{domain_rules}

工作原则：1. 内容必须准确无误
2. 结构层次分明
3. 语言专业但不晦涩
4. 关键数据必须标注来源`,
  },

  translator: {
    id: 'translator',
    name: '翻译员',
    nameEn: 'Translator',
    emoji: '🌐',
    description: '语言转换与本地化',
    tier: 'worker',
    model: 'fast',
    maxIterations: 8,
    allowedTools: ['read', 'write', 'edit', 'grep', 'glob'],
    disallowedTools: ['bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}翻译员
核心职责：- 准确翻译{domain}领域的专业内容 - 保持术语一致性 - 适配目标语言的表达习惯 - 确保专业术语准确

{domain_soul}

翻译规范：{domain_rules}

工作原则：1. 专业术语必须使用行业标准译法
2. 保持原文语义不偏差 3. 文化差异需做本地化适配
4. 不确定处标注原文`,
  },

  presenter: {
    id: 'presenter',
    name: '呈现员',
    nameEn: 'Presenter',
    emoji: '📊',
    description: '可视化与报告呈现',
    tier: 'worker',
    model: 'fast',
    maxIterations: 10,
    allowedTools: ['read', 'write', 'edit', 'grep', 'glob'],
    disallowedTools: ['bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}呈现员
核心职责：- 将{domain}数据和分析结果可视化
- 制作清晰直观的图表和报告
- 突出关键信息和趋势 - 适配不同呈现场景

{domain_soul}

呈现规范：{domain_rules}

工作原则：1. 数据可视化优先选择最合适的图表类型
2. 关键信息必须突出显示
3. 配色和排版专业美观 4. 标注数据来源和时间范围`,
  },

  analyst: {
    id: 'analyst',
    name: '分析员',
    nameEn: 'Analyst',
    emoji: '📈',
    description: '数据分析与趋势洞察',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 12,
    allowedTools: ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'memory_search'],
    disallowedTools: ['write', 'bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}分析员
核心职责：- 深度分析{domain}领域的数据和趋势
- 发现隐藏的模式和关联
- 提供数据驱动的洞察 - 评估风险和机会
{domain_soul}

分析规范：{domain_rules}

工作原则：1. 分析必须基于数据和事实 2. 区分相关性和因果性 3. 明确标注假设条件
4. 提供置信度评估`,
  },

  processor: {
    id: 'processor',
    name: '处理员',
    nameEn: 'Processor',
    emoji: '⚙️',
    description: '数据清洗与格式转换',
    tier: 'worker',
    model: 'fast',
    maxIterations: 15,
    allowedTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob'],
    disallowedTools: ['rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}处理员
核心职责：- 清洗和整理{domain}领域的数据 - 转换数据格式以适配不同系统
- 批量处理重复性任务 - 确保数据质量和一致性
{domain_soul}

处理规范：{domain_rules}

工作原则：1. 处理前必须备份原始数据 2. 每步操作记录日志
3. 处理结果需验证完整性 4. 异常数据单独标记`,
  },

  validator: {
    id: 'validator',
    name: '验证员',
    nameEn: 'Validator',
    emoji: '✅',
    description: '合规审查与质量检测',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 8,
    allowedTools: ['read', 'grep', 'glob', 'web_search', 'memory_search'],
    disallowedTools: ['write', 'bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}验证员
核心职责：- 审查{domain}领域的合规性 - 检查工作质量和标准符合性 - 识别风险和问题 - 提供改进建议

{domain_soul}

验证规范：{domain_rules}

工作原则：1. 审查必须依据明确的法规或标准
2. 问题必须分级（严重/中等/轻微） 3. 每个问题提供具体修改建议
4. 不做主观判断，以标准为准`,
  },

  planner: {
    id: 'planner',
    name: '规划员',
    nameEn: 'Planner',
    emoji: '📋',
    description: '任务分解与排期规划',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 8,
    allowedTools: ['read', 'grep', 'glob', 'memory_search'],
    disallowedTools: ['write', 'bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}规划员
核心职责：- 分解{domain}领域的复杂任务 - 制定可执行的排期计划
- 识别依赖关系和关键路径 - 预估资源需求
{domain_soul}

规划规范：{domain_rules}

工作原则：1. 任务分解到可执行粒度
2. 明确标注依赖关系
3. 预留缓冲时间
4. 设定可衡量的里程碑`,
  },

  executor: {
    id: 'executor',
    name: '执行员',
    nameEn: 'Executor',
    emoji: '🚀',
    description: '操作执行与流程推进',
    tier: 'worker',
    model: 'fast',
    maxIterations: 20,
    allowedTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'web_search', 'web_fetch'],
    disallowedTools: ['rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}执行员
核心职责：- 执行{domain}领域的具体操作 - 推进流程到下一步 - 处理日常事务性工作 - 确保操作准确无误

{domain_soul}

执行规范：{domain_rules}

工作原则：1. 执行前确认操作范围 2. 关键操作需二次确认
3. 执行结果即时反馈
4. 异常情况立即上报`,
  },

  advisor: {
    id: 'advisor',
    name: '顾问',
    nameEn: 'Advisor',
    emoji: '💡',
    description: '策略建议与决策支持',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 8,
    allowedTools: ['read', 'grep', 'glob', 'web_search', 'web_fetch', 'memory_search'],
    disallowedTools: ['write', 'bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}顾问
核心职责：- 提供{domain}领域的专业建议 - 支持决策分析
- 评估方案优劣
- 提示风险和注意事项
{domain_soul}

顾问规范：{domain_rules}

工作原则：1. 建议必须基于专业知识和数据 2. 提供多个可选方案并对比
3. 明确标注风险和不确定性 4. 区分建议与事实`,
  },

  coordinator: {
    id: 'coordinator',
    name: '协调员',
    nameEn: 'Coordinator',
    emoji: '🤝',
    description: '跨部门协调与进度跟踪',
    tier: 'reasoning',
    model: 'reasoning',
    maxIterations: 10,
    allowedTools: ['read', 'write', 'edit', 'grep', 'glob', 'memory_search'],
    disallowedTools: ['bash', 'rm_rf', 'format', 'shutdown'],
    promptTemplate: `你是一位专业的{domain}协调员
核心职责：- 协调{domain}领域的跨部门工作
- 跟踪任务进度和依赖 - 解决协作中的阻塞问题
- 汇总各方信息
{domain_soul}

协调规范：{domain_rules}

工作原则：1. 信息传递必须准确完整 2. 及时发现和上报阻塞 3. 保持各方信息同步
4. 记录关键决策和变更`,
  },
};

const CAPABILITY_TIER_MAP = {
  researcher: 'worker',
  monitor: 'worker',
  writer: 'worker',
  translator: 'worker',
  presenter: 'worker',
  analyst: 'reasoning',
  processor: 'worker',
  validator: 'reasoning',
  planner: 'reasoning',
  executor: 'worker',
  advisor: 'reasoning',
  coordinator: 'reasoning',
};

class CapabilityRegistry extends EventEmitter {
  constructor(config = {}) {
    super();
    this._capabilities = new Map();
    this._customCapabilities = new Map();
    this._soulsDir = config.soulsDir || path.join(__dirname, 'souls', 'capabilities');

    for (const [id, cap] of Object.entries(CAPABILITIES)) {
      this._capabilities.set(id, { ...cap, source: 'builtin' });
    }

    this._loadCustomCapabilities();
  }

  _loadCustomCapabilities() {
    if (!fs.existsSync(this._soulsDir)) return;

    try {
      const files = fs.readdirSync(this._soulsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(this._soulsDir, file), 'utf-8');
          const def = JSON.parse(content);
          if (def && def.id) {
            def.source = 'custom';
            this._customCapabilities.set(def.id, def);
            this.emit('capability:loaded', { id: def.id, source: 'custom' });
          }
        } catch (e) {
          this.emit('capability:load_error', { file, error: e.message });
        }
      }
    } catch { console.warn('[capability-registry] silent catch, error swallowed'); }
  }

  get(capabilityId) {
    const custom = this._customCapabilities.get(capabilityId);
    if (custom) return { ...custom };

    const builtin = this._capabilities.get(capabilityId);
    if (builtin) return { ...builtin };

    return null;
  }

  list() {
    const all = new Map();
    for (const [id, cap] of this._capabilities) {
      all.set(id, { ...cap });
    }
    for (const [id, cap] of this._customCapabilities) {
      all.set(id, { ...cap });
    }
    return [...all.values()];
  }

  listByTier(tier) {
    return this.list().filter(cap => {
      const capTier = CAPABILITY_TIER_MAP[cap.id] || cap.tier || 'worker';
      return capTier === tier;
    });
  }

  getTier(capabilityId) {
    return CAPABILITY_TIER_MAP[capabilityId] || this.get(capabilityId)?.tier || 'worker';
  }

  register(definition) {
    if (!definition || !definition.id) {
      throw new Error('Capability definition must have an id');
    }
    this._customCapabilities.set(definition.id, {
      ...definition,
      source: definition.source || 'custom',
    });
    this.emit('capability:registered', { id: definition.id });
  }

  unregister(capabilityId) {
    const builtin = this._capabilities.get(capabilityId);
    if (builtin) {
      this.emit('capability:unregister_denied', { id: capabilityId, reason: 'Cannot unregister builtin capability' });
      return false;
    }
    this._customCapabilities.delete(capabilityId);
    this.emit('capability:unregistered', { id: capabilityId });
    return true;
  }

  getPromptTemplate(capabilityId) {
    const cap = this.get(capabilityId);
    return cap?.promptTemplate || '';
  }

  getFilteredTools(capabilityId, allTools) {
    const cap = this.get(capabilityId);
    if (!cap) return allTools;

    let tools = [...allTools];

    if (cap.allowedTools && cap.allowedTools.length > 0) {
      const allowedSet = new Set(cap.allowedTools);
      tools = tools.filter(t => allowedSet.has(t.name || t));
    }

    if (cap.disallowedTools && cap.disallowedTools.length > 0) {
      const disallowedSet = new Set(cap.disallowedTools);
      tools = tools.filter(t => !disallowedSet.has(t.name || t));
    }

    return tools;
  }

  resolveModel(capabilityId) {
    const cap = this.get(capabilityId);
    return cap?.model || 'fast';
  }

  getMaxIterations(capabilityId) {
    const cap = this.get(capabilityId);
    return cap?.maxIterations || 10;
  }

  generatePrompt(capabilityId, domainId, domainRegistry) {
    const cap = this.get(capabilityId);
    if (!cap) return '';

    const template = cap.promptTemplate;
    if (!template) return '';

    const domain = domainRegistry?.get(domainId);
    const domainSoul = domainRegistry?.getSoulContent(domainId) || '';
    const domainRules = domain?.behaviorRules?.join('\n') || '';

    return template
      .replace(/\{domain\}/g, domain?.name || domainId)
      .replace('{domain_soul}', domainSoul)
      .replace('{domain_rules}', domainRules);
  }

  matchCapability(message) {
    const text = (message || '').toLowerCase();
    const scores = new Map();

    for (const cap of this.list()) {
      let score = 0;
      const keywords = [];
      if (cap.name) keywords.push(...cap.name.split(/\s+/));
      if (cap.nameEn) keywords.push(...cap.nameEn.toLowerCase().split(/\s+/));
      if (cap.description) keywords.push(...cap.description.toLowerCase().split(/[\s,，。、]+/));
      if (cap.keywords && Array.isArray(cap.keywords)) keywords.push(...cap.keywords.map(k => k.toLowerCase()));

      for (const kw of keywords) {
        if (kw && kw.length >= 2 && text.includes(kw)) {
          score += kw.length;
        }
      }
      if (score > 0) {
        scores.set(cap.id, score);
      }
    }

    if (scores.size === 0) return null;

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    return {
      capabilityId: sorted[0][0],
      score: sorted[0][1],
      confidence: Math.min(sorted[0][1] / 20, 1.0),
      alternatives: sorted.slice(1, 4).map(([id, s]) => ({ capabilityId: id, score: s })),
    };
  }
}

module.exports = { CapabilityRegistry, CAPABILITIES, CAPABILITY_TIER_MAP };
