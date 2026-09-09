/**
 * departments.js — 专家组织层：部门注册表 + 编制政策 + 岗位别名 + 班组模板
 * （2026-09-04 部门化重组 P1 数据层）
 *
 * 背景：专家库 279 位平铺（11 内置 + 268 agency-agents 导入），无 department/aliases
 * 字段，分类白名单把 268 位导入专家全部归一化为 custom——组织层缺失导致路由噪声大、
 * 语音无法按部门召唤、GUI 无法按部门导航。本模块是组织层的单一事实源：
 *
 *   1. DEPARTMENTS     七个部门（id/label/主管/部门级语音别名）
 *   2. DIVISION_POLICY agency-agents 上游 division → 本库部门 的编制政策
 *                      （active 全编入 / select 按关键词精选 / parked 泊车不入编）
 *   3. ROLE_ALIASES    星标岗位的手工中文别名（语音点名用）
 *   4. TEAM_PRESETS    预设班组（"经营分析会"等一键召开）
 *
 * 消费方：scripts/build-expert-org.js（导入管线生成 data/experts-org.json）、
 *         experts/index.js（加载/routeMessage 两级路由/resolveSummon）、
 *         evals/test-cases/expert-org.js（登记纪律）。
 * 纯数据模块，不依赖 fs。
 */

/** 七部门注册表（判据：老板遇到这件事会去哪个抽屉找，不按大企业组织架构） */
const DEPARTMENTS = Object.freeze({
  finance: {
    label: '财务部',
    icon: 'Wallet',
    description: '记账报税、成本利润、现金流与资金',
    voiceAliases: ['财务', '会计', '账', '账务', '税', '报销', '预算', '成本', '利润', '现金流'],
    lead: 'finance_advisor',
  },
  marketing: {
    label: '营销部',
    icon: 'Megaphone',
    description: '品牌市场策划合一：获客投放、内容平台、私域',
    voiceAliases: ['营销', '市场', '推广', '宣传', '品牌', '获客', '投放', '引流', '小红书', '抖音', '私域', '文案'],
    lead: 'marketing_consultant',
  },
  sales: {
    label: '销售部',
    icon: 'TrendingUp',
    description: '业绩漏斗、客户跟进、成交与丢单复盘',
    voiceAliases: ['销售', '客户', '成交', '订单', '业绩', '跟单', '提成', '客服'],
    lead: 'sales_director',
  },
  hr_admin: {
    label: '人力行政部',
    icon: 'Users2',
    description: '招聘绩效、薪酬社保、用工合规与行政',
    voiceAliases: ['人事', '人力', '招聘', '行政', '员工', '绩效', '工资', '社保', '离职', '面试'],
    lead: 'hr_manager',
  },
  tech_digital: {
    label: '技术与数字部',
    icon: 'Code',
    description: '技术决策、供应商评估、数字化与数据分析',
    // 2026-09-07 误路由修复: 移除"数据/系统/软件/网站"等超宽泛词——实测用户消息
    // 里"销售明细的全量数据"的"数据"两字命中别名, 给同部门"反馈分析师"加成激活
    // 接管了财务分析请求。部门点名保留 技术/研发/开发/程序员/数字化。
    voiceAliases: ['技术', '研发', '开发', '程序员', '数字化'],
    lead: null, // 无内置主管岗——运行时取本部门首位在编岗位
  },
  legal: {
    label: '法务合规部',
    icon: 'Scale',
    description: '合同审查、股权劳动、知产与合规风险',
    voiceAliases: ['法务', '法律', '合同', '合规', '纠纷', '律师', '仲裁', '侵权'],
    lead: 'legal_counsel',
  },
  strategy_invest: {
    label: '战略投资部',
    icon: 'PieChart',
    description: '经营分析、行业研究、融资估值与战略',
    voiceAliases: ['战略', '投资', '融资', '经营分析', '驾驶舱', '行业', '估值', '企划', '策划'],
    lead: 'boss_cockpit',
  },
});

const DEPARTMENT_IDS = Object.freeze(Object.keys(DEPARTMENTS));

/**
 * agency-agents 上游 division → 编制政策。
 * status: 'active' 全员编入 | 'select' 仅 id 命中 include 关键词者编入 | 'parked' 整部门泊车
 * 泊车岗位保留在人才库（可显式点名召唤），不参与自动路由。
 */
const DIVISION_POLICY = Object.freeze({
  finance: { dept: 'finance', status: 'active' },
  marketing: { dept: 'marketing', status: 'active' },
  sales: { dept: 'sales', status: 'active' },
  'paid-media': { dept: 'marketing', status: 'active' },
  design: {
    dept: 'marketing', status: 'select',
    include: ['brand', 'content', 'creative', 'presentation'],
  },
  product: {
    dept: 'tech_digital', status: 'select',
    include: ['product-manager', 'sprint', 'feedback'],
  },
  engineering: {
    dept: 'tech_digital', status: 'select',
    include: ['architect', 'ai-engineer', 'devops', 'security-engineer', 'code-reviewer', 'sre', 'tech-lead', 'data-engineer', 'database', 'cloud'],
  },
  security: { dept: 'tech_digital', status: 'select', include: ['compliance-auditor', 'penetration-tester', 'appsec'] },
  support: { dept: 'hr_admin', status: 'select', include: ['recruitment'] },
  strategy: { dept: 'strategy_invest', status: 'select', include: ['business-strategy', 'market', 'okr', 'm&a', 'competitive', 'growth'] },
  hr: { dept: 'hr_admin', status: 'active' },
  legal: { dept: 'legal', status: 'active' },
  // —— 泊车：对中小企业老板定位噪声大于价值（保留可点名召唤）——
  academic: { dept: null, status: 'parked' },
  'game-development': { dept: null, status: 'parked' },
  gis: { dept: null, status: 'parked' },
  'spatial-computing': { dept: null, status: 'parked' },
  testing: { dept: null, status: 'parked' },
  'project-management': { dept: null, status: 'parked' },
  research: { dept: null, status: 'parked' },
  specialized: { dept: null, status: 'parked' },
  healthcare: { dept: null, status: 'parked' },
});

/**
 * game-development 系角色的 id 前缀与目录名不一致（blender/unity/…），
 * 以源仓文件索引为准；此处仅兜底无法建索引时的前缀猜测。
 */
const DIVISION_PREFIX_FALLBACK = Object.freeze({
  blender: 'game-development', godot: 'game-development', unity: 'game-development',
  unreal: 'game-development', roblox: 'game-development', game: 'game-development',
  level: 'game-development', narrative: 'game-development', xr: 'spatial-computing',
  visionos: 'spatial-computing', vision: 'spatial-computing', macos: 'specialized',
  terminal: 'specialized', lsp: 'specialized', zk: 'specialized',
});

/** 星标岗位手工中文别名（语音点名主匹配源；键为专家 id） */
const ROLE_ALIASES = Object.freeze({
  'marketing-xiaohongshu-specialist': ['小红书', '小红书运营', '种草', '红书'],
  'marketing-douyin-strategist': ['抖音', '短视频', '直播电商'],
  'marketing-baidu-seo-specialist': ['百度', 'seo', '搜索优化'],
  'marketing-cross-border-ecommerce': ['跨境电商', '出海', '亚马逊'],
  'marketing-china-ecommerce-operator': ['电商运营', '电商', '网店', '淘宝', '拼多多'],
  'marketing-content-creator': ['内容创作', '写手', '文案策划'],
  'marketing-growth-hacker': ['增长黑客', '增长', '裂变'],
  'marketing-livestream-ecommerce-coach': ['直播', '直播带货'],
  'finance-bookkeeper': ['记账', '会计', '账务', '做账'],
  'sales-deal-closing-coach': ['逼单', '成交话术', '签单'],
  'sales-pipeline-architect': ['销售漏斗', '商机'],
  'product-manager': ['产品经理', '产品'],
  'engineering-ai-engineer': ['ai工程师', '人工智能'],
  'engineering-devops-engineer': ['运维', 'devops'],
  'strategy-business-strategist': ['战略顾问', '商业模式'],
  'support-customer-support-responder': ['客服', '售后'],
});

/** 预设班组（一键召开；expertIds 可含内置与在编导入岗位；defaultGoal 供语音一键直达） */
const TEAM_PRESETS = Object.freeze([
  {
    id: 'ops_review',
    label: '经营分析会',
    description: '驾驶舱主持，财务与税务列席，看数字找问题',
    defaultGoal: '审视当前经营状况、主要风险与下一步动作',
    expertIds: ['boss_cockpit', 'finance_advisor', 'tax_consultant', 'financing_advisor'],
  },
  {
    id: 'marketing_war_room',
    label: '营销作战会',
    description: '获客策略 + 平台打法，出可执行的投放方案',
    defaultGoal: '制定下一阶段的获客与投放方案',
    expertIds: ['marketing_consultant', 'brand_consultant', 'marketing-xiaohongshu-specialist', 'marketing-douyin-strategist'],
  },
  {
    id: 'sales_push',
    label: '销售冲刺会',
    description: '漏斗复盘 + 成交话术，盯业绩达成',
    defaultGoal: '复盘销售漏斗，给出本周冲刺动作',
    expertIds: ['sales_director', 'sales-deal-strategist', 'sales-discovery-coach'],
  },
]);

/** 部门默认工具面（2026-09-04 P3——岗位=人设+工具面+技能包三元组的第二元。
 *  键为 toolset-manager CORE_TOOLSETS 真名；enforcement 已在 tool-definitions 接线） */
const DEPARTMENT_TOOLSETS = Object.freeze({
  finance: ['file', 'document', 'general'],
  marketing: ['web', 'browser', 'media', 'file'],
  sales: ['messaging', 'web', 'calendar', 'file'],
  hr_admin: ['file', 'document', 'calendar'],
  tech_digital: ['terminal', 'file', 'browser', 'workflow'],
  legal: ['file', 'document', 'web'],
  strategy_invest: ['web', 'stock', 'file', 'document'],
});

/** 部门技能包（2026-09-04 P3 数据先行——技能名=skills/ 目录真名；enforcement 待 skill-router 接线） */
const DEPARTMENT_SKILLS = Object.freeze({
  finance: ['report-generator', 'excel-xlsx', 'summarize-pro'],
  // 2026-09-07: remotion-video 视频生成进营销(宣传片/短视频)与技术部(产品演示/技术讲解);
  // hyperframes-video（HTML 模板/给已有视频加字幕覆层）同批挂载
  marketing: ['content-planner', 'article-writer', 'promo-planner', 'listing-optimizer', 'trending-monitor', 'bilibili-knowledge', 'wechat-article-search', 'remotion-video', 'hyperframes-video'],
  sales: ['review-analyzer', 'product-research', 'productivity'],
  hr_admin: ['meeting-summary', 'word-docx', 'summarize-pro'],
  tech_digital: ['code-review', 'api-tester', 'git-ops', 'systematic-debugging', 'shell-enhance', 'html-generator', 'remotion-video', 'hyperframes-video'],
  legal: ['doc-processor', 'pdf-to-word-docx', 'summarize-pro'],
  strategy_invest: ['deep-research', 'report-generator', 'chart-generator', 'powerpoint-pptx', 'trending-monitor'],
});

function getDepartment(id) {
  return DEPARTMENTS[id] || null;
}

/** 部门默认工具面（岗位未显式声明时回落部门默认） */
function getDepartmentToolsets(deptId) {
  return DEPARTMENT_TOOLSETS[deptId] || null;
}

/** 部门技能包 */
function getDepartmentSkills(deptId) {
  return DEPARTMENT_SKILLS[deptId] || null;
}

/** division 编制政策解析：返回 { dept, status, include }（未知 division 一律泊车） */
function resolveDivisionPolicy(division) {
  const policy = DIVISION_POLICY[division];
  if (!policy) return { dept: null, status: 'parked', include: null };
  return { dept: policy.dept, status: policy.status, include: policy.include || null };
}

module.exports = {
  DEPARTMENTS,
  DEPARTMENT_IDS,
  DIVISION_POLICY,
  DIVISION_PREFIX_FALLBACK,
  ROLE_ALIASES,
  TEAM_PRESETS,
  DEPARTMENT_TOOLSETS,
  DEPARTMENT_SKILLS,
  getDepartment,
  getDepartmentToolsets,
  getDepartmentSkills,
  resolveDivisionPolicy,
};
