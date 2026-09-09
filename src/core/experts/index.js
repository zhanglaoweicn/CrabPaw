/**
 * Expert Registry — 专家面板后端核心
 *
 * 功能：
 * 1. 内置专家定义（含系统提示词、能力标签、路由关键词、协作链）
 * 2. CRUD 存储 (`<DATA_DIR>/experts.json`)
 * 3. 消息→专家 路由匹配（关键词 + 语义）
 * 4. 协作链建议
 * 5. 使用统计追踪
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// M7: 统一使用 config 的 DATA_DIR（CRABPAW_DATA_DIR 或 <repo>/data/.crabpaw），消除 cwd 依赖
const { DATA_DIR } = require('../config');
const STORE_FILE = path.join(DATA_DIR, 'experts.json');
// 2026-09-05: 资产层(agency-agents 导入)删除墓碑——org 层每次启动全量回装,
// 不落墓碑的话用户删除的专家重启后"复活"
const DELETED_FILE = path.join(DATA_DIR, 'experts-deleted.json');
const STATS_FILE = path.join(DATA_DIR, 'expert-stats.json');
const AGENCY_AGENTS_FILE = path.join(DATA_DIR, 'experts-from-agency-agents.json');
// 2026-09-04 部门化重组 P1: 组织库(带 department/status/aliases)优先于原始 agency 文件;
// 生成管线 scripts/build-expert-org.js, 资产随仓(data/experts-org.json), DATA_DIR 有副本则优先。
const REPO_DATA_DIR = path.resolve(__dirname, '../../../data');
const ORG_FILE_CANDIDATES = [
  path.join(DATA_DIR, 'experts-org.json'),
  path.join(REPO_DATA_DIR, 'experts-org.json'),
];
const {
  DEPARTMENTS, DEPARTMENT_IDS, TEAM_PRESETS,
  getDepartment: getDepartmentDef, getDepartmentToolsets, getDepartmentSkills,
} = require('./departments');

/* ─── 内置专家（2026-08-21 重构：老板客户；2026-08-28 EX-1：7 新增 → 11 位，prompt 四段结构化） ─── */
const BUILTIN_EXPERTS = [
  {
    id: 'boss_cockpit',
    name: '老板驾驶舱',
    title: '经营分析顾问',
    description: '营收、毛利、现金流一页看懂，判断经营健康度',
    icon: 'Gauge',
    category: 'strategy',
    tags: ['经营', '分析', '驾驶舱'],
    capabilities: ['business_overview', 'health_check', 'kpi_summary'],
    routingKeywords: ['经营', '营收', '毛利', '现金流', '驾驶舱', '健康度', '业绩总览', '盈', '亏', 'dashboard', '经营状况'],
    voiceStyle: '沉稳专业的经营汇报口吻，数据先行，结论清晰',
    systemPrompt: '①你是企业老板的经营参谋，以老板视角审视经营全局。②框架：营收→毛利→现金流→应收→库存，先看趋势后看结构。③输出：一页看懂的健康判断＋风险点排序＋下一步动作。④未提供的经营数据不编造、不推测，缺数必追问口径；数据不足时不得下结论，先要数据再判断。',
    collaborationChain: ['boss_cockpit', 'finance_advisor'],
    dataScope: { businessData: true },
    builtin: true,
  },
  {
    id: 'finance_advisor',
    name: '财务顾问',
    title: '中小企业财务顾问',
    description: '报表解读、税务、成本控制、资金计划',
    icon: 'Wallet',
    category: 'finance',
    tags: ['财务', '税务', '报表'],
    capabilities: ['statement_reading', 'tax_guidance', 'cost_control', 'cash_planning'],
    routingKeywords: ['财务', '税务', '报表', '现金流', '成本', '利润', '发票', '纳税', '账', '回款', 'finance', 'tax'],
    voiceStyle: '严谨细致的财务顾问口吻，数字精确，风险提示明确',
    systemPrompt: '①你是中小企业财务顾问，用通俗语言讲清经营数字。②框架：报表解读→现金流→税务合规→成本结构→资金计划。③输出：数字结论＋可执行动作，金额测算给区间，少堆术语、说人话。④未提供的经营数字不编造、不推测，关键数据缺失必追问；口径不明时不得拍数字，先对齐口径。',
    collaborationChain: ['finance_advisor', 'boss_cockpit'],
    dataScope: { businessData: true },
    builtin: true,
  },
  {
    id: 'sales_director',
    name: '销售总监',
    title: '销售管理顾问',
    description: '业绩分析、客户跟进、成交话术、丢单复盘',
    icon: 'TrendingUp',
    category: 'sales',
    tags: ['销售', '业绩', '客户'],
    capabilities: ['sales_analysis', 'customer_followup', 'deal_closing', 'loss_review'],
    routingKeywords: ['销售', '业绩', '客户', '成交', '订单', '丢单', '跟单', '提成', '拜访', '销售目标', 'sales', 'deal'],
    voiceStyle: '干练直接的销售教练口吻，行动导向',
    systemPrompt: '①你是销售总监，干练直接、行动导向，替老板盯住业绩大盘。②框架：业绩达成→客户漏斗→跟单节奏→丢单复盘。③输出：可落地的成交动作与话术，丢单复盘必提炼改进点，给能直接派给团队的任务清单。④未提供的业绩数据不编造，漏斗关键数据缺失必追问；数据不足时不得空谈结论，先讲清已知与缺口。',
    collaborationChain: ['sales_director', 'boss_cockpit'],
    dataScope: { businessData: true },
    builtin: true,
  },
  {
    id: 'hr_manager',
    name: '人事主管',
    title: '人力资源顾问',
    description: '招聘、绩效、考勤、劳动合同风险',
    icon: 'Users2',
    category: 'hr',
    tags: ['人事', '招聘', '绩效'],
    capabilities: ['recruiting', 'performance', 'attendance', 'labor_contract'],
    routingKeywords: ['招聘', '人事', '绩效', '考勤', '劳动合同', '社保', '离职', '面试', '工资', '裁员', 'hr', 'recruit'],
    voiceStyle: '温和专业的人力顾问口吻，兼顾合规与人性化',
    systemPrompt: '①你是中小企业人事主管，帮老板管好人力这盘账，兼顾合规与人性化。②框架：招聘效率→绩效管理→用工合规→劳动风险→处理节奏。③输出：合规要点＋风险提示＋可落地的务实建议，不空谈原则。④劳动法条文不确定不得杜撰，涉及具体案情的关键事实必追问；事实不清时不下结论，先说清还需什么信息再给建议。',
    collaborationChain: ['hr_manager', 'boss_cockpit'],
    dataScope: {},
    builtin: true,
  },
  {
    id: 'planning_consultant',
    name: '企划专家',
    title: '企划与项目顾问',
    description: '把想法变成可执行方案：年度计划、项目、活动策划',
    icon: 'Map',
    category: 'strategy',
    tags: ['企划', '规划', '项目'],
    capabilities: ['business_planning', 'project_planning', 'activity_planning'],
    routingKeywords: ['企划', '规划', '年度计划', '经营计划', '项目', '开业', '活动策划', '庆典', '宣传方案', '方案'],
    voiceStyle: '务实规划的参谋口吻，先对齐目标再给路径',
    systemPrompt: '①你是面向中小企业业主的企划专家，把模糊想法变成可执行方案。②框架：目标→现状（资源/约束/缺口）→三条路径对比→里程碑→预算与风险。③输出：落地企划（时间段/责任人/预算/量化目标），先确认关键前提再展开。④未提供的经营数据不编造，缺预算、周期、人手必追问；方案中的假设项明确标注，前提不实不得定案。',
    collaborationChain: ['planning_consultant', 'boss_cockpit'],
    dataScope: { businessData: true },
    builtin: true,
  },
  {
    id: 'market_consultant',
    name: '市场专家',
    title: '市场与行业顾问',
    description: '行业格局、竞争分析、市场容量与调研',
    icon: 'Globe',
    category: 'marketing',
    tags: ['市场', '行业', '竞对'],
    capabilities: ['industry_analysis', 'competitor_analysis', 'market_sizing', 'market_research'],
    routingKeywords: ['市场', '行业', '竞对', '竞争对手', '容量', '行情分析', '市场调研'],
    voiceStyle: '冷静客观的行业分析师口吻，事实与推断分明',
    systemPrompt: '①你是中小企业市场顾问，帮老板看清所处行业与竞争格局。②框架：行业格局→需求洞察→相对位置→切入与定价。③输出：结构化情报＋可验证结论，严格区分事实、推断与假设。④无外部数据不得编造市占率或容量，关键口径不明必追问；推断必须标注「基于模型、不可查证」。',
    collaborationChain: ['market_consultant', 'boss_cockpit'],
    dataScope: {},
    builtin: true,
  },
  {
    id: 'brand_consultant',
    name: '品牌专家',
    title: '品牌定位顾问',
    description: '定位、命名、广告语与品牌传播',
    icon: 'Gem',
    category: 'marketing',
    tags: ['品牌', '定位', '传播'],
    capabilities: ['brand_positioning', 'naming', 'brand_identity', 'brand_communication'],
    routingKeywords: ['品牌', '定位', '命名', 'VI', '广告语', '传播', '品牌形象'],
    voiceStyle: '犀利有审美感的品牌顾问口吻，一句话说清定位',
    systemPrompt: '①你是品牌顾问，把「无感产品」变成「记得住」的品牌。②框架：目标受众→差异化→一句话定位→记忆点→触点一致性。③输出：定位句＋风格基调＋3 条传播主张，不堆大词、句句可上广告位。④未确认受众与竞品不得妄下定位，关键选择必追问；命名与广告语给 3 组备选供老板拍板。',
    collaborationChain: ['brand_consultant', 'boss_cockpit'],
    dataScope: {},
    builtin: true,
  },
  {
    id: 'legal_counsel',
    name: '法务专家',
    title: '企业法务顾问',
    description: '合同、股权、劳动、知产与合规风险',
    icon: 'Scale',
    category: 'legal',
    tags: ['法务', '合同', '合规'],
    capabilities: ['contract_review', 'equity_structure', 'labor_law', 'ip_protection', 'compliance'],
    routingKeywords: ['法务', '合同', '股权', '劳动法', '劳务', '纠纷', '知识产权', '商标', '合规', '仲裁'],
    voiceStyle: '严谨保守的法务口吻，风险分级、底线明确',
    systemPrompt: '①你是中小企业法务顾问，识别风险并给出行动建议。②框架：事实→适用规则→风险分级（红线/高/中/低）→行动清单→底线。③输出：清单式风险点，清晰保守，明确举证要求。④科普不构成正式法律意见，涉仲裁、诉讼、重大合同建议对接执业律师复核；不得凭空引用法条，案情不清必追问。',
    collaborationChain: ['legal_counsel', 'boss_cockpit'],
    dataScope: {},
    builtin: true,
  },
  {
    id: 'tax_consultant',
    name: '税务专家',
    title: '税务筹划顾问',
    description: '合法降税负：政策适用、发票与税收优惠',
    icon: 'Calculator',
    category: 'finance',
    tags: ['税务', '税筹', '发票'],
    capabilities: ['tax_planning', 'invoice_management', 'tax_preference', 'tax_risk'],
    routingKeywords: ['税', '税筹', '纳税', '发票', '增值税', '所得税', '税收优惠', '个税'],
    voiceStyle: '谨慎合规的税务顾问口吻，红线清晰、测算给区间',
    systemPrompt: '①你是中小企业税务顾问，帮老板合法降低税负。②框架：业务事实→税收场景→适用政策→合规筹划空间→风险提示。③输出：合规优先，划清「税收筹划 vs 逃税漏税」红线，金额测算给区间。④政策时效性强，以申报期官方口径为准并建议专业复核；不编造优惠条款，未提供的经营数字必追问，依据不足不得下结论。',
    collaborationChain: ['tax_consultant', 'boss_cockpit'],
    dataScope: { businessData: true },
    builtin: true,
  },
  {
    id: 'marketing_consultant',
    name: '营销专家',
    title: '获客与营销顾问',
    description: '渠道组合、投放获客、私域与 ROI',
    icon: 'Megaphone',
    category: 'marketing',
    tags: ['营销', '获客', '渠道'],
    capabilities: ['channel_strategy', 'acquisition_campaign', 'content_hooks', 'roi_estimation'],
    routingKeywords: ['营销', '获客', '推广', '投放', '广告', '引流', '拉新', '转化', '私域', '渠道'],
    voiceStyle: '结果导向的增长顾问口吻，算清每笔预算的账',
    systemPrompt: '①你是中小企业营销顾问，帮老板把预算花在有效获客上（营销管获客面，与销售区分）。②框架：目标客户→渠道组合→内容钩子→转化路径→ROI 预估。③输出：渠道清单＋行动优先级＋每项预算、人效与预期，ROI 标注「估算＋验证方法」。④无历史数据给保守与乐观两套假设，不鼓吹「必爆」；关键信息缺失必追问，事实不清不得拍板方案。',
    collaborationChain: ['marketing_consultant', 'boss_cockpit'],
    dataScope: {},
    builtin: true,
  },
  {
    id: 'financing_advisor',
    name: '投融资专家',
    title: '融资与估值顾问',
    description: '估值、BP、股权条款与融资渠道',
    icon: 'PieChart',
    category: 'finance',
    tags: ['融资', '估值', '股权'],
    capabilities: ['valuation', 'business_plan_writing', 'term_sheet_review', 'fundraising_route', 'negotiation'],
    routingKeywords: ['融资', '投资', '估值', 'BP', '商业计划书', '股权', '天使', '贷款', '资金', '募资'],
    voiceStyle: '务实的资本顾问口吻，讲清估值故事与谈判底线',
    systemPrompt: '①你是投融资顾问，帮老板理解「值多少钱、怎么拿到钱」。②框架：资金需求→估值故事→股权与条款→渠道路径→谈判要点。③输出：BP 建议框架＋估值区间方法论＋谈判红线清单。④估值是叙事加市场共识而非科学；无真实财务数据不编造，关键数据缺失必追问，数据不足不得拍数字；口头承诺无效、条款以书面为准并请专业人士复核。',
    collaborationChain: ['financing_advisor', 'boss_cockpit'],
    dataScope: { businessData: true },
    builtin: true,
  },
];

/* ─── 专家注册表 ─── */
let _experts = null;      // [{ id, name, ... }] 完整列表
let _indexMap = null;     // { id -> index }

// 内置 11 人入编表(2026-09-04 P1): department + 岗位别名(语音点名)。
// 别名与 departments.ROLE_ALIASES(导入岗位)分治——此处只管内置。
const BUILTIN_DEPARTMENT_ASSIGNMENT = Object.freeze({
  boss_cockpit: { department: 'strategy_invest', aliases: ['驾驶舱', '经营参谋', '老板视角'], allowedToolsets: ['web', 'stock', 'file', 'document'] },
  finance_advisor: { department: 'finance', aliases: ['财务顾问'], allowedToolsets: ['file', 'document', 'general'] },
  sales_director: { department: 'sales', aliases: ['销售总监'], allowedToolsets: ['messaging', 'web', 'calendar'] },
  hr_manager: { department: 'hr_admin', aliases: ['人事主管', '人力资源'], allowedToolsets: ['file', 'document', 'calendar'] },
  planning_consultant: { department: 'strategy_invest', aliases: ['企划', '策划'], allowedToolsets: ['web', 'file', 'document'] },
  market_consultant: { department: 'marketing', aliases: ['行业分析', '市场调研'], allowedToolsets: ['web', 'browser', 'file'] },
  brand_consultant: { department: 'marketing', aliases: ['品牌顾问'], allowedToolsets: ['web', 'media', 'file'] },
  legal_counsel: { department: 'legal', aliases: ['法务顾问', '律师'], allowedToolsets: ['file', 'document', 'web'] },
  tax_consultant: { department: 'finance', aliases: ['报税', '税筹'], allowedToolsets: ['file', 'document', 'general'] },
  marketing_consultant: { department: 'marketing', aliases: ['营销顾问', '获客'], allowedToolsets: ['web', 'messaging', 'file'] },
  financing_advisor: { department: 'strategy_invest', aliases: ['投融资', '融资顾问'], allowedToolsets: ['web', 'stock', 'document'] },
});

function _ensureLoaded() {
  if (_experts) return;
  _experts = [...BUILTIN_EXPERTS];
  // 内置入编
  for (const e of _experts) {
    const assign = BUILTIN_DEPARTMENT_ASSIGNMENT[e.id];
    if (assign) {
      e.department = assign.department;
      e.status = 'active';
      e.aliases = assign.aliases;
      if (assign.allowedToolsets) e.allowedToolsets = assign.allowedToolsets;
    }
  }
  // 部门化重组(2026-09-04 P1): 优先加载 experts-org.json——全量 268 位带 department/status
  // (泊车岗位保留人才库可显式召唤, 不参与自动路由) + 清洗后的 routingKeywords + 中文别名。
  let orgLoaded = false;
  try {
    const orgPath = ORG_FILE_CANDIDATES.find(p => fs.existsSync(p));
    if (orgPath) {
      const org = JSON.parse(fs.readFileSync(orgPath, 'utf-8'));
      if (Array.isArray(org.experts)) {
        for (const agent of org.experts) {
          agent.builtin = false;
          agent.source = agent.source || 'agency-agents';
          if (!_experts.find(e => e.id === agent.id)) _experts.push(agent);
        }
        orgLoaded = true;
        const activeCount = org.experts.filter(e => e.status === 'active').length;
        console.log(`[Experts] 已加载组织库 ${org.experts.length} 位(在编 ${activeCount}/泊车 ${org.experts.length - activeCount}), 来源 ${path.basename(orgPath)}`);
      }
    }
  } catch (e) { console.warn('[Experts] 加载组织库失败(回退原始 agency 文件):', e.message); }
  // 回退: 无组织库时按旧行为加载原始 agency 文件(无组织字段, 全量可路由——兼容旧数据)
  if (!orgLoaded) {
    try {
      if (fs.existsSync(AGENCY_AGENTS_FILE)) {
        const raw = fs.readFileSync(AGENCY_AGENTS_FILE, 'utf-8');
        const imported = JSON.parse(raw);
        if (Array.isArray(imported)) {
          for (const agent of imported) {
            agent.builtin = false;
            agent.source = 'agency-agents';
            // 避免 ID 覆盖原有的 11 个内置专家
            if (!_experts.find(e => e.id === agent.id)) {
              _experts.push(agent);
            }
          }
        }
        console.log(`[Experts] 已导入 ${_experts.length - BUILTIN_EXPERTS.length} 个 agency-agents 专家(无组织层)`);
      }
    } catch (e) { console.warn('[Experts] 加载 agency-agents 专家库失败:', e.message); }
  }
  // 从磁盘加载自定义专家
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      const custom = JSON.parse(raw);
      if (Array.isArray(custom)) {
        for (const c of custom) {
          c.builtin = false;
          const idx = _experts.findIndex(e => e.id === c.id);
          if (idx >= 0) _experts[idx] = c;
          else _experts.push(c);
        }
      }
    }
  } catch (e) { console.warn('[Experts] 加载自定义专家失败:', e.message); }
  // 2026-09-05: 墓碑过滤——用户已删除的资产层专家不复活
  _ensureDeleted();
  if (_deletedIds.size > 0) {
    const before = _experts.length;
    _experts = _experts.filter(e => !_deletedIds.has(e.id));
    if (before !== _experts.length) console.log(`[Experts] 墓碑过滤: ${before - _experts.length} 位已删除专家未回装`);
  }
  _rebuildIndex();
}

function _rebuildIndex() {
  _indexMap = {};
  _experts.forEach((e, i) => { _indexMap[e.id] = i; });
}

/* ─── 删除墓碑(资产层) ─── */
let _deletedIds = null;
function _ensureDeleted() {
  if (_deletedIds) return;
  _deletedIds = new Set();
  try {
    if (fs.existsSync(DELETED_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DELETED_FILE, 'utf-8'));
      if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string') _deletedIds.add(id);
    }
  } catch (e) { console.warn('[Experts] 读取删除墓碑失败:', e.message); }
}
function _saveDeleted() {
  _ensureDeleted();
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DELETED_FILE, JSON.stringify([..._deletedIds], null, 2), 'utf-8');
  } catch (e) { console.warn('[Experts] 保存删除墓碑失败:', e.message); }
}

function _saveStore() {
  // 2026-09-05 修复: 此前过滤条件 !e.builtin 会把 268 位导入专家(运行时 builtin=false)
  // 全量快照进 experts.json——此后 experts-org.json 的再生成被陈旧快照永久遮蔽
  // (加载序: 自定义层同 id 覆盖一切)。用户层只存真正自建的记录。
  const custom = _experts.filter(e => !e.builtin && e.source !== 'agency-agents');
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(custom, null, 2), 'utf-8');
  } catch (e) { console.warn('[Experts] 保存自定义专家失败:', e.message); }
}

/* ─── 使用统计 ─── */
let _stats = null;

function _ensureStats() {
  if (_stats) return;
  try {
    if (fs.existsSync(STATS_FILE)) {
      _stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    }
  } catch (e) { console.warn('[experts] Failed to load stats:', e.message); }
  if (!_stats) _stats = { totalSessions: 0, expertUsage: {} };
}

function _saveStats() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(_stats, null, 2), 'utf-8');
  } catch (e) { console.warn('[experts] Failed to save stats:', e.message); }
}

/* ─── 公共 API ─── */

// 2026-08-27 审计 E3: 规范分类白名单——此前 getCategories 用 _experts 的 category 并集,
// 自定义专家带任意字符串时并集爆炸(实测 268 项), 污染筛选下拉且输出未翻译裸字符串。
// 读出口统一归一化: 非规范值按 custom 计(存储不动, 仅 API 输出面收敛)。
const CANONICAL_CATEGORY_IDS = ['strategy', 'finance', 'sales', 'hr', 'marketing', 'legal', 'custom'];
function _normalizeCategory(cat) {
  return CANONICAL_CATEGORY_IDS.includes(cat) ? cat : 'custom';
}

// 部门化重组(2026-09-04 P1): department 是组织真值, category 降级为向后兼容派生值
// (旧 GUI 分类下拉继续可用), 直至 GUI 部门树上线。
const DEPT_TO_CATEGORY = {
  finance: 'finance', marketing: 'marketing', sales: 'sales',
  hr_admin: 'hr', legal: 'legal', strategy_invest: 'strategy', tech_digital: 'custom',
};
function _deriveCategory(e) {
  if (e.department && DEPT_TO_CATEGORY[e.department]) return DEPT_TO_CATEGORY[e.department];
  return _normalizeCategory(e.category);
}

function _departmentOutput(e) {
  const def = e.department ? getDepartmentDef(e.department) : null;
  return {
    department: e.department || null,
    departmentLabel: def ? def.label : null,
    status: e.status || 'active',
    aliases: e.aliases || [],
    // P3(2026-09-04): 工具面三元组第二/三元——岗位显式声明优先, 回落部门默认
    allowedToolsets: e.allowedToolsets || (e.department ? getDepartmentToolsets(e.department) : null) || [],
    allowedSkills: e.allowedSkills || (e.department ? getDepartmentSkills(e.department) : null) || [],
  };
}

/** 获取所有专家 */
function getAllExperts() {
  _ensureLoaded();
  return _experts.map(e => ({
    id: e.id, name: e.name, title: e.title, description: e.description,
    icon: e.icon, category: _deriveCategory(e), tags: e.tags,
    capabilities: e.capabilities, builtin: e.builtin,
    routingKeywords: e.routingKeywords || [],
    dataScope: e.dataScope || {},
    voiceStyle: e.voiceStyle || '自然亲切的助手口吻',
    ..._departmentOutput(e),
    lastUsedAt: _stats?.expertUsage?.[e.id]?.lastUsedAt || null,
    usageCount: _stats?.expertUsage?.[e.id]?.count || 0,
  }));
}

/** 获取专家详情（含 prompt） */
function getExpert(id) {
  _ensureLoaded();
  const e = _experts.find(x => x.id === id);
  if (!e) return null;
  return {
    id: e.id, name: e.name, title: e.title, description: e.description,
    icon: e.icon, category: _deriveCategory(e), tags: e.tags,
    capabilities: e.capabilities,
    systemPrompt: e.systemPrompt,
    promptTemplate: e.promptTemplate || null,
    routingKeywords: e.routingKeywords || [],
    collaborationChain: e.collaborationChain || [],
    builtin: e.builtin,
    // 2026-08-26 E1: 透传 voiceStyle/dataScope——expert-context 注入人设与数据源时
    // 需要完整的认知框架字段(此前丢失, 系统提示注入时 voiceStyle 恒空)。
    voiceStyle: e.voiceStyle || '自然亲切的助手口吻',
    dataScope: e.dataScope || null,
    ..._departmentOutput(e),
    lastUsedAt: _stats?.expertUsage?.[e.id]?.lastUsedAt || null,
    usageCount: _stats?.expertUsage?.[e.id]?.count || 0,
  };
}

/** 创建自定义专家 */
function createExpert(data) {
  _ensureLoaded();
  const id = data.id || 'custom_' + crypto.randomBytes(4).toString('hex');
  // 2026-09-05 修复: 真值判断漏掉下标 0(boss_cockpit)——可用自定义专家永久遮蔽内置岗
  if (_indexMap[id] !== undefined) return { error: '专家ID已存在', id };
  const expert = {
    id,
    name: data.name || '未命名专家',
    title: data.title || '',
    description: data.description || '',
    icon: data.icon || 'Brain',
    category: data.category || 'custom',
    tags: Array.isArray(data.tags) ? data.tags : [],
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    routingKeywords: Array.isArray(data.routingKeywords) ? data.routingKeywords : [],
    // P1(2026-09-04): 自定义专家可选入编——department 须为注册部门, 默认泊车外
    department: DEPARTMENT_IDS.includes(data.department) ? data.department : null,
    status: DEPARTMENT_IDS.includes(data.department) ? 'active' : 'parked',
    aliases: Array.isArray(data.aliases) ? data.aliases : [],
    systemPrompt: data.systemPrompt || '',
    promptTemplate: data.promptTemplate || null,
    collaborationChain: Array.isArray(data.collaborationChain) ? data.collaborationChain : [],
    builtin: false,
  };
  _experts.push(expert);
  _rebuildIndex();
  _saveStore();
  return { id, expert };
}

/** 更新专家 */
function updateExpert(id, data) {
  _ensureLoaded();
  const idx = _indexMap[id];
  if (idx === undefined) return { error: '专家不存在' };
  const e = _experts[idx];
  // 2026-09-05 修复: `data.builtin !== false` 旁路——请求带 builtin:false 即可篡改内置岗
  if (e.builtin) return { error: '内置专家不可修改' };
  delete data.builtin; // builtin 归属不可经更新通道变更
  if (data.name !== undefined) e.name = data.name;
  if (data.title !== undefined) e.title = data.title;
  if (data.description !== undefined) e.description = data.description;
  if (data.icon !== undefined) e.icon = data.icon;
  if (data.category !== undefined) e.category = data.category;
  if (data.tags !== undefined) e.tags = data.tags;
  if (data.capabilities !== undefined) e.capabilities = data.capabilities;
  if (data.routingKeywords !== undefined) e.routingKeywords = data.routingKeywords;
  // P1(2026-09-04): 组织字段——department 变更须为注册部门, 泊车/在编随之
  if (data.department !== undefined) {
    if (data.department === null) { e.department = null; e.status = 'parked'; }
    else if (DEPARTMENT_IDS.includes(data.department)) { e.department = data.department; e.status = data.status === 'parked' ? 'parked' : 'active'; }
  }
  if (data.status !== undefined && ['active', 'parked'].includes(data.status) && data.department === undefined) e.status = data.status;
  if (data.aliases !== undefined) e.aliases = Array.isArray(data.aliases) ? data.aliases : [];
  if (data.systemPrompt !== undefined) e.systemPrompt = data.systemPrompt;
  if (data.promptTemplate !== undefined) e.promptTemplate = data.promptTemplate;
  if (data.collaborationChain !== undefined) e.collaborationChain = data.collaborationChain;
  _saveStore();
  return { success: true, expert: e };
}

/** 删除自定义专家 */
function deleteExpert(id) {
  _ensureLoaded();
  const idx = _indexMap[id];
  if (idx === undefined) return { error: '专家不存在' };
  if (_experts[idx].builtin) return { error: '内置专家不可删除' };
  const victim = _experts[idx];
  _experts.splice(idx, 1);
  _rebuildIndex();
  // 2026-09-05: 资产层删除落墓碑(否则重启后 org 层原样加回, 删除形同虚设)
  if (victim.source === 'agency-agents') {
    _ensureDeleted();
    _deletedIds.add(id);
    _saveDeleted();
  }
  _saveStore();
  return { success: true };
}

/** 重置内置专家 prompt */
function resetExpertPrompt(id) {
  _ensureLoaded();
  const builtin = BUILTIN_EXPERTS.find(e => e.id === id);
  if (!builtin) return { error: '没有该内置专家' };
  const e = _experts.find(x => x.id === id);
  if (e) e.systemPrompt = builtin.systemPrompt;
  _saveStore();
  return { success: true, prompt: builtin.systemPrompt };
}

/* ─── 路由（2026-09-04 P1 两级化：部门作用域 + 岗位别名 + 泊车排除） ─── */

/** 对消息进行专家路由匹配 */
function routeMessage(message) {
  _ensureLoaded();
  if (!message || typeof message !== 'string') return [];
  const msg = message.toLowerCase();
  const results = [];

  // 第一级：部门别名命中集——部门被点名时其成员获得加成（两级路由的作用域收窄）
  const hitDepts = new Set();
  for (const [deptId, def] of Object.entries(DEPARTMENTS)) {
    if ((def.voiceAliases || []).some(a => msg.includes(a.toLowerCase()))) hitDepts.add(deptId);
  }

  for (const expert of _experts) {
    // 泊车岗位不参与自动路由（外部人才库，仅显式召唤可达）
    if (expert.status === 'parked') continue;
    const dept = expert.department || null;
    const keywords = expert.routingKeywords || [];
    const aliases = expert.aliases || [];
    const matched = [];

    // 2026-09-07 误路由修复: 旧归一化分制(score/maxScore)惩罚关键词多的专家——
    // 实测用户精确点名"财务分析师"(6 词→maxScore 7)只得 14 分低于激活下限 15,
    // 而消息里"数据"两字命中部门别名, 给仅 2 关键词的"反馈分析师"加成后 33 分
    // 反超激活。改为固定分档(不再随关键词总数浮动):
    //   精确点名(消息含专家名) +100 ｜ 岗位别名 +80 ｜ 关键词每命中 +20(上限 60)
    //   部门别名命中: 主管 +20 / 成员 +10(10 分低于激活下限, 泛部门词不再带出任意成员)
    let score = 0;

    // 精确点名: 专家名整体出现在消息中（最高置信，直通激活）
    const expertName = String(expert.name || '').toLowerCase();
    if (expertName && msg.includes(expertName)) {
      score += 100;
      matched.push(expert.name);
    }

    for (const kw of keywords) {
      if (msg.includes(kw.toLowerCase())) {
        score += 20;
        matched.push(kw);
      }
    }
    score = Math.min(score, 160); // 点名/别名 + 关键词命中合计上限

    // 别名强匹配（语音/自然语言点名主通道，权重高于普通关键词）
    let aliasHit = null;
    for (const al of aliases) {
      if (al && msg.includes(al.toLowerCase())) { score += 80; aliasHit = al; break; }
    }

    // 部门点名加成（主管高于成员——泛部门词命中时不该等权带出任意成员）
    let deptMatched = false;
    if (dept && hitDepts.has(dept)) {
      deptMatched = true;
      const deptDef = getDepartmentDef(dept);
      score += (deptDef?.lead && deptDef.lead === expert.id) ? 20 : 10;
    }

    if (score > 0) {
      results.push({
        expertId: expert.id,
        name: expert.name,
        department: dept,
        departmentLabel: dept ? (getDepartmentDef(dept)?.label || null) : null,
        score,
        matchedKeywords: matched,
        aliasHit,
        departmentMatched: deptMatched,
        reason: aliasHit
          ? `别名命中: ${aliasHit}`
          : (matched.length > 0 && matched[0] === expert.name
            ? `精确点名: ${expert.name}`
            : (deptMatched && matched.length === 0
              ? `部门命中: ${getDepartmentDef(dept)?.label || dept}`
              : (matched.length > 0 ? `匹配关键词: ${matched.slice(0, 3).join('、')}` : '通用匹配'))),
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* ─── 召唤解析（P1: 语音/GUI 显式召唤的统一入口） ─── */

function _summarizeExpert(e) {
  const def = e.department ? getDepartmentDef(e.department) : null;
  return {
    id: e.id, name: e.name, title: e.title || '', icon: e.icon || 'Brain',
    department: e.department || null, departmentLabel: def ? def.label : null,
    status: e.status || 'active',
    // P3(2026-09-04): 播报音色——GUI 侧 resolveExpertTtsVoice(voiceStyle) 选 TTS 声线
    voiceStyle: e.voiceStyle || '',
  };
}

/**
 * 召唤解析：query = 专家 id | 岗位别名/姓名 | 部门 id/部门别名。
 * 返回 {type:'expert'|'department'|'ambiguous'|null, ...}——
 *   expert     精确命中（泊车岗位也可达：外部人才库显式召唤）
 *   department 部门命中（含主管与在编成员，供班组会议/播报）
 *   ambiguous  多候选（语音二段式消歧的载荷）
 */
function resolveSummon(query) {
  _ensureLoaded();
  if (!query || typeof query !== 'string') return null;
  const q = query.trim().toLowerCase();
  if (!q) return null;

  // 1) 精确 id
  const byId = _experts.find(e => e.id.toLowerCase() === q);
  if (byId) return { type: 'expert', expert: _summarizeExpert(byId) };

  // 2) 岗位别名/姓名/职务 精确命中（优先于部门——"小红书"点名的是岗位不是营销部）
  const exactRole = _experts.find(e => {
    const pool = [...(e.aliases || []).map(a => String(a).toLowerCase()),
      String(e.name || '').toLowerCase(), String(e.title || '').toLowerCase()].filter(Boolean);
    return pool.includes(q);
  });
  if (exactRole) return { type: 'expert', expert: _summarizeExpert(exactRole) };

  // 3) 部门 id / 别名（含"叫财务来看看"式短句包含别名）
  for (const [deptId, def] of Object.entries(DEPARTMENTS)) {
    const aliasHit = (def.voiceAliases || []).find(a => a.toLowerCase() === q);
    const contained = (def.voiceAliases || []).find(a => a.length >= 2 && q.includes(a.toLowerCase()) && q.length <= a.length + 6);
    if (deptId.toLowerCase() === q || aliasHit || contained) {
      const members = _experts.filter(e => e.department === deptId && e.status !== 'parked');
      const lead = (def.lead && members.some(m => m.id === def.lead))
        ? def.lead
        : (members[0] ? members[0].id : null);
      return {
        type: 'department',
        department: { id: deptId, label: def.label, icon: def.icon, lead, memberCount: members.length },
        members: members.slice(0, 8).map(_summarizeExpert),
      };
    }
  }

  // 4) 岗位别名 / 姓名 / 职务（双向包含，≥2 字符）
  const matches = _experts.filter(e => {
    const aliases = (e.aliases || []).map(a => String(a).toLowerCase());
    const names = [e.name, e.title].filter(Boolean).map(s => String(s).toLowerCase());
    const pool = [...aliases, ...names];
    return pool.some(t => (t.length >= 2 && t.includes(q)) || (q.length >= 2 && q.includes(t)));
  });
  if (matches.length === 1) return { type: 'expert', expert: _summarizeExpert(matches[0]) };
  if (matches.length > 1) {
    // 精确等于优先消歧：若恰有一个 name/alias 与 query 全等，直接命中
    const exact = matches.find(e => (e.aliases || []).some(a => String(a).toLowerCase() === q)
      || String(e.name || '').toLowerCase() === q || String(e.title || '').toLowerCase() === q);
    if (exact) return { type: 'expert', expert: _summarizeExpert(exact) };
    return { type: 'ambiguous', candidates: matches.slice(0, 5).map(_summarizeExpert) };
  }
  return null;
}

/** 部门列表（含主管解析与在编计数） */
function getDepartments() {
  _ensureLoaded();
  return DEPARTMENT_IDS.map(id => {
    const def = DEPARTMENTS[id];
    const members = _experts.filter(e => e.department === id && e.status !== 'parked');
    const lead = (def.lead && members.some(m => m.id === def.lead))
      ? def.lead
      : (members[0] ? members[0].id : null);
    return {
      id, label: def.label, icon: def.icon, description: def.description,
      voiceAliases: def.voiceAliases, lead, memberCount: members.length,
    };
  });
}

/** 预设班组（校验：expertIds 中不存在的岗位自动剔除） */
function getTeamPresets() {
  _ensureLoaded();
  return TEAM_PRESETS.map(p => {
    const expertIds = (p.expertIds || []).filter(id => _experts.some(e => e.id === id));
    return { ...p, expertIds, memberCount: expertIds.length };
  });
}

/** 建议协作链：给定主专家 ID，返回推荐的协作链 */
function suggestCollaborationChain(primaryExpertId) {
  _ensureLoaded();
  const primary = _experts.find(e => e.id === primaryExpertId);
  if (!primary) return [];
  const chain = primary.collaborationChain || [];
  return chain.map(id => {
    const e = _experts.find(x => x.id === id);
    return e ? { expertId: e.id, name: e.name, title: e.title, icon: e.icon } : null;
  }).filter(Boolean);
}

/** 获取所有分类（2026-08-27 E3: 仅规范分类, 不再从专家并集爆炸派生） */
function getCategories() {
  _ensureLoaded();
  return CANONICAL_CATEGORY_IDS.map(c => ({
    id: c,
    label: { strategy: '经营分析', finance: '财务', sales: '销售', hr: '人事', marketing: '市场', legal: '法务', custom: '自定义' }[c] || c,
  }));
}


/**
 * 专家可用数据源描述（聊天链路注入用）。返回形如
 * "可查询：ERP 财务库、经营数据 2 张表"；无数据源返回 null。
 */
function getExpertDataSources(expertId) {
  _ensureLoaded();
  const expert = _experts.find((e) => e.id === expertId);
  if (!expert || !expert.dataScope) return null;
  const parts = [];
  if (expert.dataScope.businessData) {
    try {
      const { listTables } = require('../business-data-registry');
      const biz = listTables().filter((t) => !t.external);
      if (biz.length > 0) parts.push(`经营数据 ${biz.length} 张表`);
    } catch (e) { console.warn('[experts] 数据源检测失败(biz):', e.message || e); }
  }
  return parts.length > 0 ? '可查询：' + parts.join('、') : null;
}

/** 记录使用会话 */
function recordSession(expertId) {
  _ensureStats();
  _stats.totalSessions++;
  if (!_stats.expertUsage[expertId]) _stats.expertUsage[expertId] = { count: 0, lastUsedAt: null };
  _stats.expertUsage[expertId].count++;
  _stats.expertUsage[expertId].lastUsedAt = Date.now();
  _saveStats();
}

/** 获取使用统计 */
function getStats() {
  _ensureStats();
  return _stats;
}

module.exports = {
  BUILTIN_EXPERTS,
  getAllExperts,
  getExpert,
  createExpert,
  updateExpert,
  deleteExpert,
  resetExpertPrompt,
  routeMessage,
  resolveSummon,
  getDepartments,
  getTeamPresets,
  suggestCollaborationChain,
  getCategories,
  getExpertDataSources,
  recordSession,
  getStats,
};
