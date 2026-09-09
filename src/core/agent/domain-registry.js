const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const { WORKSPACE_DIR } = require('../config');

const DOMAINS = {
  finance: {
    id: 'finance',
    name: '财务',
    nameEn: 'Finance',
    emoji: '💰',
    description: '会计、税务、预算、成本、报表',
    keywords: ['财务', '会计', '税务', '预算', '成本', '报表', '账目', '发票', '报销', '审计', 'finance', 'accounting', 'tax', 'budget'],
    behaviorRules: [
      '所有金额必须标注币种和单位',
      '税务相关必须注明适用法规条款',
      '财务数据必须标注时间范围',
      '涉及估算必须说明假设条件',
      '敏感财务信息不对外泄露',
    ],
    exclusive: false,
    active: true,
  },

  admin: {
    id: 'admin',
    name: '行政',
    nameEn: 'Administration',
    emoji: '🏢',
    description: '办公、流程、制度、印章、档案',
    keywords: ['行政', '办公', '流程', '制度', '印章', '档案', '会议', '通知', 'admin', 'office', 'administration'],
    behaviorRules: [
      '流程变更需说明依据',
      '制度文件引用需标注版本',
      '涉及印章使用需提醒审批',
      '档案管理遵循保密等级',
    ],
    exclusive: false,
    active: true,
  },

  hr: {
    id: 'hr',
    name: '人事',
    nameEn: 'Human Resources',
    emoji: '👥',
    description: '招聘、薪酬、绩效、培训、考勤',
    keywords: ['人事', '招聘', '薪酬', '绩效', '培训', '考勤', '员工', '离职', '入职', 'HR', 'human resources'],
    behaviorRules: [
      '薪酬信息严格保密',
      '招聘流程遵循公平原则',
      '绩效评估需有数据支撑',
      '员工个人信息不对外泄露',
      '劳动法规必须注明适用条款',
    ],
    exclusive: false,
    active: true,
  },

  legal: {
    id: 'legal',
    name: '法务',
    nameEn: 'Legal',
    emoji: '⚖️',
    description: '合同、合规、知识产权、诉讼',
    keywords: ['法务', '合同', '合规', '知识产权', '诉讼', '法律', '条款', '协议', 'legal', 'contract', 'compliance'],
    behaviorRules: [
      '法律建议必须注明仅供参考',
      '合同审查需逐条标注风险',
      '合规要求需引用具体法规',
      '知识产权问题需区分类型',
      '涉及诉讼需建议咨询专业律师',
    ],
    exclusive: false,
    active: true,
  },

  qc: {
    id: 'qc',
    name: '品控',
    nameEn: 'Quality Control',
    emoji: '🔬',
    description: '质检、标准、认证、抽检',
    keywords: ['品控', '质检', '质量', '标准', '认证', '抽检', '合格率', 'QC', 'quality', 'inspection'],
    behaviorRules: [
      '质量标准需标注版本和来源',
      '检测结果需注明检测方法',
      '不合格项需分级处理',
      '认证要求需引用具体标准号',
    ],
    exclusive: false,
    active: false,
  },

  warehouse: {
    id: 'warehouse',
    name: '仓管',
    nameEn: 'Warehouse',
    emoji: '🏭',
    description: '库存、出入库、盘点、WMS',
    keywords: ['仓管', '库存', '出入库', '盘点', 'WMS', '仓库', '仓储', 'warehouse', 'inventory'],
    behaviorRules: [
      '库存数据需标注时间点',
      '出入库记录需有单据号',
      '盘点差异需分析原因',
      '安全库存需动态计算',
    ],
    exclusive: false,
    active: false,
  },

  procurement: {
    id: 'procurement',
    name: '采购',
    nameEn: 'Procurement',
    emoji: '🛒',
    description: '供应商、招标、比价、采购合同',
    keywords: ['采购', '供应商', '招标', '比价', '采购合同', 'procurement', 'purchasing', 'supplier'],
    behaviorRules: [
      '采购需遵循审批流程',
      '供应商评估需多维度打分',
      '比价需包含至少三家报价',
      '合同条款需法务审核',
    ],
    exclusive: false,
    active: false,
  },

  logistics: {
    id: 'logistics',
    name: '物流',
    nameEn: 'Logistics',
    emoji: '🚚',
    description: '运输、配送、运费、追踪',
    keywords: ['物流', '运输', '配送', '运费', '追踪', '快递', 'logistics', 'shipping', 'delivery'],
    behaviorRules: [
      '物流信息需实时更新',
      '运费计算需注明计费方式',
      '异常件需及时处理',
      '配送时效需区分地区',
    ],
    exclusive: false,
    active: false,
  },

  rnd: {
    id: 'rnd',
    name: '研发',
    nameEn: 'R&D',
    emoji: '🧪',
    description: '实验、配方、工艺、测试',
    keywords: ['研发', '实验', '配方', '工艺', '测试', 'R&D', 'research', 'development'],
    behaviorRules: [
      '实验数据需记录完整条件',
      '配方信息严格保密',
      '工艺变更需验证后执行',
      '测试结果需可追溯',
    ],
    exclusive: false,
    active: false,
  },

  sales: {
    id: 'sales',
    name: '销售',
    nameEn: 'Sales',
    emoji: '💼',
    description: '客户、订单、业绩、CRM',
    keywords: ['销售', '客户', '订单', '业绩', 'CRM', '销售额', 'sales', 'customer', 'revenue'],
    behaviorRules: [
      '客户信息严格保密',
      '业绩数据需标注统计口径',
      '销售预测需注明置信度',
      '竞品信息需标注来源',
    ],
    exclusive: false,
    active: true,
  },

  marketing: {
    id: 'marketing',
    name: '市场',
    nameEn: 'Marketing',
    emoji: '📢',
    description: '推广、渠道、活动、ROI',
    keywords: ['市场', '推广', '渠道', '活动', 'ROI', '营销', 'marketing', 'promotion', 'campaign'],
    behaviorRules: [
      '市场数据需标注来源和时间',
      'ROI 计算需说明口径',
      '渠道效果需多维评估',
      '竞品分析需客观中立',
    ],
    exclusive: false,
    active: true,
  },

  brand: {
    id: 'brand',
    name: '品牌',
    nameEn: 'Brand',
    emoji: '🎨',
    description: '形象、设计、VI、传播',
    keywords: ['品牌', '形象', '设计', 'VI', '传播', '品牌价值', 'brand', 'branding', 'design'],
    behaviorRules: [
      '品牌规范需严格遵循 VI 手册',
      '对外传播内容需审核',
      '品牌资产需统一管理',
      '设计稿需标注版本',
    ],
    exclusive: false,
    active: false,
  },

  strategy: {
    id: 'strategy',
    name: '战略',
    nameEn: 'Strategy',
    emoji: '🎯',
    description: '规划、竞争、定位、愿景',
    keywords: ['战略', '规划', '竞争', '定位', '愿景', '战略分析', 'strategy', 'strategic'],
    behaviorRules: [
      '战略建议需基于数据和分分析',
      '竞争分析需多维度',
      '定位需考虑市场阶段',
      '规划需分短期/中期/长期',
    ],
    exclusive: false,
    active: false,
  },

  operations: {
    id: 'operations',
    name: '运营',
    nameEn: 'Operations',
    emoji: '🔄',
    description: '流程、效率、指标、优化',
    keywords: ['运营', '流程', '效率', '指标', '优化', '运营分析', 'operations', 'ops'],
    behaviorRules: [
      '运营指标需定义统计口径',
      '流程优化需先评估影响',
      '效率提升需量化效果',
      '异常指标需分析根因',
    ],
    exclusive: false,
    active: true,
  },

  planning: {
    id: 'planning',
    name: '策划',
    nameEn: 'Planning',
    emoji: '📝',
    description: '方案、创意、活动、执行',
    keywords: ['策划', '方案', '创意', '活动策划', '执行方案', 'planning', 'creative'],
    behaviorRules: [
      '策划方案需有明确目标',
      '创意需可执行可衡量',
      '活动需有应急预案',
      '执行方案需分解到责任人',
    ],
    exclusive: false,
    active: false,
  },

  investment: {
    id: 'investment',
    name: '投资',
    nameEn: 'Investment',
    emoji: '💹',
    description: '尽调、估值、风控、回报',
    keywords: ['投资', '尽调', '估值', '风控', '回报', '融资', 'investment', 'due diligence', 'valuation'],
    behaviorRules: [
      '投资建议仅供参考',
      '估值需说明方法和假设',
      '风险需分级评估',
      '回报预测需注明置信度',
    ],
    exclusive: false,
    active: false,
  },

  tech: {
    id: 'tech',
    name: '技术',
    nameEn: 'Technology',
    emoji: '💻',
    description: '架构、代码、部署、运维',
    keywords: ['技术', '架构', '代码', '部署', '运维', '开发', '编程', 'tech', 'technology', 'code', 'devops'],
    behaviorRules: [
      '代码变更需通过审查',
      '架构决策需记录 ADR',
      '部署需有回滚方案',
      '安全漏洞需及时修复',
    ],
    exclusive: false,
    active: true,
  },

  product: {
    id: 'product',
    name: '产品',
    nameEn: 'Product',
    emoji: '📱',
    description: '需求、原型、迭代、用户研究',
    keywords: ['产品', '需求', '原型', '迭代', '用户研究', 'PRD', 'product', 'requirement', 'prototype'],
    behaviorRules: [
      '需求需有优先级排序',
      '用户研究需标注样本量',
      '原型需标注交互逻辑',
      '迭代需记录变更原因',
    ],
    exclusive: false,
    active: true,
  },
};

class DomainRegistry extends EventEmitter {
  constructor(config = {}) {
    super();
    this._domains = new Map();
    this._customDomains = new Map();
    this._activeDomains = new Set();
    this._soulsDir = config.soulsDir || path.join(__dirname, 'souls', 'domains');
    this._workspaceDir = config.workspaceDir || WORKSPACE_DIR;
    this._soulCache = new Map();

    for (const [id, domain] of Object.entries(DOMAINS)) {
      this._domains.set(id, { ...domain, source: 'builtin' });
      if (domain.active) {
        this._activeDomains.add(id);
      }
    }

    this._loadCustomDomains();
    this._loadActiveState();
  }

  _loadCustomDomains() {
    const customDir = path.join(this._workspaceDir, '.crabpaw', 'domains');
    if (!fs.existsSync(customDir)) return;

    try {
      const files = fs.readdirSync(customDir).filter(f => f.endsWith('.json') || f.endsWith('.toml'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(customDir, file), 'utf-8');
          let def;
          if (file.endsWith('.json')) {
            def = JSON.parse(content);
          } else {
            def = this._parseTomlDomain(content);
          }
          if (def && def.id) {
            def.source = 'custom';
            this._customDomains.set(def.id, def);
            if (def.active) {
              this._activeDomains.add(def.id);
            }
            this.emit('domain:loaded', { id: def.id, source: 'custom' });
          }
        } catch (e) {
          this.emit('domain:load_error', { file, error: e.message });
        }
      }
    } catch { console.warn('[domain-registry] silent catch, error swallowed'); }
  }

  _loadActiveState() {
    const statePath = path.join(this._workspaceDir, '.crabpaw', 'domain-state.json');
    if (!fs.existsSync(statePath)) return;

    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.active && Array.isArray(state.active)) {
        this._activeDomains = new Set(state.active);
      }
    } catch { console.warn('[domain-registry] silent catch, error swallowed'); }
  }

  _saveActiveState() {
    const stateDir = path.join(this._workspaceDir, '.crabpaw');
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const statePath = path.join(stateDir, 'domain-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: [...this._activeDomains],
      updatedAt: Date.now(),
    }, null, 2), 'utf-8');
  }

  _parseTomlDomain(content) {
    const def = {};
    const lines = content.split('\n');
    let currentSection = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        // eslint-disable-next-line no-unused-vars
        currentSection = trimmed.slice(1, -1).trim();
        continue;
      }
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key === 'keywords') {
        def[key] = value.split(',').map(s => s.trim()).filter(Boolean);
      } else if (key === 'behavior_rules') {
        def.behaviorRules = value.split(';').map(s => s.trim()).filter(Boolean);
      } else if (key === 'active') {
        def[key] = value === 'true';
      } else if (key === 'exclusive') {
        def[key] = value === 'true';
      } else {
        def[key] = value;
      }
    }

    return def.id ? def : null;
  }

  get(domainId) {
    const custom = this._customDomains.get(domainId);
    if (custom) return { ...custom };

    const builtin = this._domains.get(domainId);
    if (builtin) return { ...builtin };

    return null;
  }

  list() {
    const all = new Map();
    for (const [id, domain] of this._domains) {
      all.set(id, { ...domain });
    }
    for (const [id, domain] of this._customDomains) {
      all.set(id, { ...domain });
    }
    return [...all.values()];
  }

  listActive() {
    return this.list().filter(d => this._activeDomains.has(d.id));
  }

  isActive(domainId) {
    return this._activeDomains.has(domainId);
  }

  activate(domainId) {
    const domain = this.get(domainId);
    if (!domain) {
      this.emit('domain:activate_error', { id: domainId, reason: 'Domain not found' });
      return false;
    }
    this._activeDomains.add(domainId);
    this._saveActiveState();
    this.emit('domain:activated', { id: domainId });
    return true;
  }

  deactivate(domainId) {
    this._activeDomains.delete(domainId);
    this._saveActiveState();
    this.emit('domain:deactivated', { id: domainId });
    return true;
  }

  getSoulContent(domainId) {
    if (this._soulCache.has(domainId)) {
      return this._soulCache.get(domainId);
    }

    const soulPaths = [
      path.join(this._workspaceDir, '.crabpaw', 'souls', 'domains', `${domainId}.md`),
      path.join(this._soulsDir, `${domainId}.md`),
    ];

    for (const soulPath of soulPaths) {
      if (fs.existsSync(soulPath)) {
        try {
          const content = fs.readFileSync(soulPath, 'utf-8');
          this._soulCache.set(domainId, content);
          return content;
        } catch { console.warn('[domain-registry] silent catch, error swallowed'); }
      }
    }

    const domain = this.get(domainId);
    if (domain) {
      const fallback = `# ${domain.name}领域专家\n\n你是${domain.name}领域的专业助手。\n\n## 核心专长\n${domain.description}\n\n## 行为规范\n${(domain.behaviorRules || []).join('\n')}`;
      this._soulCache.set(domainId, fallback);
      return fallback;
    }

    return '';
  }

  invalidateSoulCache(domainId) {
    if (domainId) {
      this._soulCache.delete(domainId);
    } else {
      this._soulCache.clear();
    }
  }

  getRules(domainId) {
    const domain = this.get(domainId);
    return domain?.behaviorRules || [];
  }

  getKeywords(domainId) {
    const domain = this.get(domainId);
    return domain?.keywords || [];
  }

  matchDomain(message) {
    const text = (message || '').toLowerCase();
    const scores = new Map();

    for (const domain of this.listActive()) {
      let score = 0;
      for (const kw of domain.keywords || []) {
        if (text.includes(kw.toLowerCase())) {
          score += kw.length;
        }
      }
      if (score > 0) {
        scores.set(domain.id, score);
      }
    }

    if (scores.size === 0) return null;

    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    return {
      domainId: sorted[0][0],
      score: sorted[0][1],
      confidence: Math.min(sorted[0][1] / 20, 1.0),
      alternatives: sorted.slice(1, 4).map(([id, s]) => ({ domainId: id, score: s })),
    };
  }

  registerCustomDomain(definition) {
    if (!definition || !definition.id) {
      throw new Error('Domain definition must have an id');
    }
    this._customDomains.set(definition.id, {
      ...definition,
      source: definition.source || 'custom',
    });
    if (definition.active) {
      this._activeDomains.add(definition.id);
    }
    this.emit('domain:registered', { id: definition.id });
  }

  unregisterCustomDomain(domainId) {
    const builtin = this._domains.get(domainId);
    if (builtin) {
      this.emit('domain:unregister_denied', { id: domainId, reason: 'Cannot unregister builtin domain' });
      return false;
    }
    this._customDomains.delete(domainId);
    this._activeDomains.delete(domainId);
    this.emit('domain:unregistered', { id: domainId });
    return true;
  }
}

module.exports = { DomainRegistry, DOMAINS };
