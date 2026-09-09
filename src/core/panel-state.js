/**
 * panel-state.js — 面板状态 TTL 跟踪 + 上下文注入
 *
 * 借鉴历史实现的 panel-state/context-ttl 机制：
 * - 面板打开/关闭时记录事件和时间戳
 * - 关闭后 ~120s 内仍返回"已关闭"状态，让 AI 上下文能看到
 * - 提供统一入口 buildPanelStateContext() 按相关度注入每轮上下文
 *   （仅非 null 状态注入：open 60min / closed 120s TTL，从未交互的面板零注入）
 *
 * 关键区别（相对旧设计）：
 *   1. 面板状态跟踪和 SceneStore surface 是两回事。
 *      SceneStore 用于 UI 渲染，panel-state 用于 AI 上下文注入。
 *   2. 状态上下文按相关度注入（仅非 null 状态：open 60min 内 / closed 120s 内），
 *      从未交互的面板零注入——Scene Manifest 已覆盖当前可见性。
 *   3. 打开态快照只在面板打开时注入（取 scene surface data，与 manifest 同源不同形）。
 */

const PANEL_CLOSED_TTL_MS = 120_000;  // 面板关闭后继续注入"已关闭"信息的时间
const PANEL_OPEN_TTL_MS = 60 * 60 * 1000;  // 面板打开后数据上下文有效时间（历史实现: 60min）

// 2026-08-25 Phase3a: 面板键由 panel-registry(卡片贡献点)构建——新增卡片=注册条目,
// panel-state 零改动；与历史硬编码 1:1(行为等价)。
const { getPanelKeys } = require('./panels/panel-registry');
const panelStates = Object.fromEntries(getPanelKeys().map((k) => [k, { state: null, updatedAt: 0 }]));

// 2026-08-16: surface id → panel key 映射上收至本模块（单一事实源，依赖零模块故无 require 环）。
// 使用方：/api/scene/upsert（open/closed 双向同步）、/api/scene/remove（closed）、
// SceneSet data=null 关闭链路（closed）——对齐 panel-tools.js / music-tools.js 的 surface id。
// 2026-08-25 Phase3a: surface→key 映射由 panel-registry 提供(单一事实源)。
const { getSurfaceMap } = require('./panels/panel-registry');
const SURFACE_PANEL_MAP = getSurfaceMap();

/**
 * 2026-08-27 面板禁用开关配套：toggle 后重建 panelStates/SURFACE_PANEL_MAP（与 registry 读面一致）。
 * panelStates/SURFACE_PANEL_MAP 为 const 对象——原地增删，已导出引用保持有效。
 */
function refreshPanelStateMaps() {
  const { getPanelKeys, getSurfaceMap } = require('./panels/panel-registry');
  const keys = new Set(getPanelKeys());
  for (const k of Object.keys(panelStates)) if (!keys.has(k)) delete panelStates[k];
  for (const k of keys) if (!panelStates[k]) panelStates[k] = { state: null, updatedAt: 0 };
  for (const k of Object.keys(SURFACE_PANEL_MAP)) delete SURFACE_PANEL_MAP[k];
  Object.assign(SURFACE_PANEL_MAP, getSurfaceMap());
}

/**
 * 设置面板状态
 * @param {'music'|'hotspot'|'weather'|'stock'|'filegen'} panel
 * @param {'open'|'closed'} state
 */
function setPanelState(panel, state) {
  if (!panelStates[panel]) return;
  panelStates[panel].state = state;
  panelStates[panel].updatedAt = Date.now();
}

/**
 * 获取某面板的当前有效状态
 * @param {'music'|'hotspot'|'weather'|'stock'|'filegen'} panel
 * @returns {'open'|'closed'|null}
 */
function getEffectiveState(panel) {
  const record = panelStates[panel];
  if (!record || record.state == null) return null;
  const now = Date.now();
  const elapsed = now - record.updatedAt;
  if (record.state === 'open') {
    // 打开状态 60min TTL
    return elapsed < PANEL_OPEN_TTL_MS ? 'open' : null;
  }
  // 关闭状态 120s TTL
  return elapsed < PANEL_CLOSED_TTL_MS ? 'closed' : null;
}

/**
 * 获取面板状态摘要（给 ai.js 注入用）
 */
function getPanelState() {
  const result = {};
  for (const key of Object.keys(panelStates)) {
    result[key] = getEffectiveState(key);
  }
  return result;
}

// ─── 上下文注入函数（统一入口，2026-08-15 重构） ───

const PANEL_LABELS = { music: '音乐面板', hotspot: '热点面板', weather: '天气面板', stock: '股票面板', filegen: '文件生成面板', meeting: '会议记录面板', schedule: '日程卡片', knowledge: '知识库面板', typhoon: '台风面板', receivable: '应收账款卡', contractExpiry: '合同到期卡', businessBriefing: '经营简报卡', approvals: '审批待办卡', stockAlert: '库存预警卡', customerView: '客户跟进卡', supplierProfile: '供应商档案卡' };

// 操作指引（2026-08-15 契约核正：与 registry/tool-contract 一致，
// 由 panel-state-guidance.test.js 守卫测试锁定，勿单独改此处文案）
const GUIDANCE = {
  music: {
    open: [
      '控制: Music(action="pause"|"next"|"prev")',
      '关闭: Music(action="stop")',
    ],
    closed: [
      '打开并播放: Music(action="search", query="歌曲名")',
    ],
  },
  hotspot: {
    open: [
      '查看平台详情: ShowHotspot(platform="weibo")',
      '关闭面板: ShowHotspot(action="hide")',
    ],
    closed: [
      '打开面板: ShowHotspot(action="show", format="scene")',
    ],
  },
  weather: {
    open: [
      '查其他城市: ShowWeather(city="城市名")',
      '关闭面板: ShowWeather(action="hide")',
    ],
    closed: [
      '查询天气: ShowWeather(city="城市名")',
    ],
  },
  stock: {
    open: [
      '查询其他行情: ShowStock(queries="股票名")',
      '关闭面板: ShowStock(action="hide")',
    ],
    closed: [
      '打开面板: ShowStock(queries="贵州茅台"（留空默认上证指数）)',
    ],
  },
  // 2026-08-17 M4: 原指引引用 FileGen(action="show"/"hide") 工具，但该工具从未注册
  // （模型按指引调用必然工具契约失败）。改纯指令文案，不具名任何未注册工具。
  // 2026-08-17 R2-1: AI 语音关闭链路——复用已注册 SceneSet(id, data=null)（契约
  // oneOf object|null + 实现 removeSurface→panel-state closed 均已测试锁定）。
  filegen: {
    open: [
      '查看生成进度/预览: 无需操作（面板内实时呈现）',
      '关闭面板: SceneSet(id=\'file-panel\', data=null)（用户要求关闭文件生成面板时）',
    ],
    closed: [
      '生成文件: 直接说需求（如"写一篇市场分析文章"）',
      '打开面板: 当用户要求打开文件生成面板时，直接开始生成任务即可（生成开始后面板自动打开，无独立打开工具）',
    ],
  },
  // 2026-08-18: meeting——会议记录面板（MeetingPanel 卡片）
  meeting: {
    open: [
      '停止记录并总结: meeting_mode(action="hide")（结束录音，转写自动总结生成纪要）',
      '关闭面板: SceneSet(id=\'meeting-panel\', data=null)（用户要求关闭会议面板时）',
    ],
    closed: [
      '开始记录: meeting_mode(action="show")（打开会议面板并开始录音；转写实时显示在卡片内，不要复述）',
      '查看历史纪要: meeting_mode(action="history")（仅打开历史列表；不要用 show 回应查看请求——会新建空会议）',
    ],
  },
  // 2026-08-19: schedule——日程卡片（SchedulePanel，数据走 /api/calendar）
  schedule: {
    open: [
      '关闭面板: SceneSet(id=\'schedule-panel\', data=null)（用户要求关闭日程卡片时）',
    ],
    closed: [
      '打开面板: SceneSet(id=\'schedule-panel\', data={action:"show"})（用户要求查看日程时；卡片内已展示近 7 天日程）',
    ],
  },
  // 2026-08-20: knowledge——知识库面板（KnowledgePanel，数据走 /api/kb/*）
  // 打开后面板内自检索,LLM 不代查; 内容问题仍走 KbSearch 文本回答。
  knowledge: {
    open: [
      '关闭面板: SceneSet(id=\'kb-panel\', data=null)（用户要求关闭知识库面板时）',
    ],
    closed: [
      '打开面板: SceneSet(id=\'kb-panel\', data={action:"show"})（用户要求查看知识库/知识库面板时；面板内提供检索与文档清单，内容问题先 KbSearch 再回答）',
    ],
  },
  // 2026-08-29: typhoon 键注册补齐配套——此前 key 未注册零注入（指引工具均已在 registry 注册）
  typhoon: {
    open: [
      '关闭面板: ShowTyphoon(action="hide")',
      '查台风文本详情: TyphoonQuery(query="台风名或编号")',
    ],
    closed: [
      '打开面板: ShowTyphoon()（用户询问台风/台风路径/台风预警时）',
    ],
  },
  receivable: {
    open: [
      '关闭卡片: ShowReceivablePanel(action="hide")',
    ],
    closed: [
      '打开卡片: ShowReceivablePanel()（用户询问应收账款/回款/谁欠我钱时）',
    ],
  },
  contractExpiry: {
    open: [
      '关闭卡片: ShowContractExpiryPanel(action="hide")',
      '调整到期窗口: ShowContractExpiryPanel(windowDays=7)',
    ],
    closed: [
      '打开卡片: ShowContractExpiryPanel()（用户询问合同到期/续约提醒时）',
    ],
  },
  businessBriefing: {
    open: [
      '关闭卡片: ShowBusinessBriefingPanel(action="hide")',
    ],
    closed: [
      '打开卡片: ShowBusinessBriefingPanel()（用户询问经营简报/营收概况时）',
    ],
  },
  approvals: {
    open: [
      '关闭卡片: ShowApprovalsPanel(action="hide")',
      '落地审批: ResolveApproval(approvalId="apr_xxx", approved=true)',
    ],
    closed: [
      '打开卡片: ShowApprovalsPanel()（用户询问待审批/要审批的事情时）',
    ],
  },
  stockAlert: {
    open: [
      '关闭卡片: ShowStockAlertPanel(action="hide")',
    ],
    closed: [
      '打开卡片: ShowStockAlertPanel()（用户询问库存预警/该补什么货时）',
    ],
  },
  customerView: {
    open: [
      '关闭卡片: ShowCustomerPanel(action="hide")',
    ],
    closed: [
      '打开卡片: ShowCustomerPanel()（用户询问客户情况/客户排名时）',
    ],
  },
  supplierProfile: {
    open: [
      '关闭卡片: ShowSupplierPanel(action="hide")',
      '查某供应商: ShowSupplierPanel(supplier="供应商名")',
    ],
    closed: [
      '打开卡片: ShowSupplierPanel()（用户询问供应商/采购情况时）',
    ],
  },
};

// 打开态行内快照——从 scene surface 的 data 提取一行极简摘要（与 manifest 同源不同形）；
// 无可用内容返回 null（此时只有状态行 + 指引）。
function snapshotFor(panel, surfaceData) {
  if (!surfaceData) return null;
  if (panel === 'weather') {
    const d = surfaceData;
    const parts = [];
    if (d.city) parts.push(d.city);
    if (d.temp != null && d.temp !== '') parts.push(`${d.temp}°`);
    if (d.condition) parts.push(d.condition);
    if (d.humidity) parts.push(`· 湿度 ${d.humidity}`);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (panel === 'stock') {
    const items = Array.isArray(surfaceData.items) ? surfaceData.items : [];
    const first = items[0];
    if (!first || first.name == null) return null;
    const pct = first.changePct != null
      ? `${first.changePct >= 0 ? '+' : ''}${first.changePct}%` : '';
    return `${first.name}${first.price != null ? ' ' + first.price : ''}${pct ? ' ' + pct : ''}`.trim();
  }
  if (panel === 'filegen') {
    const d = surfaceData;
    const parts = [];
    if (d.title) parts.push(d.title);
    if (d.phase && d.phase !== 'idle') parts.push(`[${d.phase}]`);
    if (d.file && d.file.name) parts.push(d.file.name);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  if (panel === 'meeting') {
    const d = surfaceData;
    const parts = [];
    if (d.title) parts.push(d.title);
    if (d.status && d.status !== 'idle') parts.push(`[${d.status}]`);
    if (d.segmentCount) parts.push(`${d.segmentCount} 段转写`);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  // hotspot / music：surface data 无可用摘要内容（hotspot-panel data 仅为 {action,active}）
  return null;
}

/**
 * 构建面板状态上下文（统一入口，替代 buildMusic/Hotspot/WeatherStateContext）
 * @param {'music'|'hotspot'|'weather'|'stock'|'filegen'} panel
 * @param {'open'|'closed'|null} effectiveState — null 返回 null（相关度注入：非 null 才注入）
 * @param {object|null} surfaceData — scene store 对应 surface 的 data（快照源，可缺省）
 * @returns {string|null}
 */
function buildPanelStateContext(panel, effectiveState, surfaceData) {
  if (effectiveState == null) return null;
  const open = effectiveState === 'open';
  const title = PANEL_LABELS[panel] || `${panel}面板`;
  const snap = open ? snapshotFor(panel, surfaceData) : null;
  const statusLine = open
    ? (snap ? `当前: ✅ 已打开（${snap}）` : '当前: ✅ 已打开')
    : '当前: ⛔ 已关闭（用户手动关闭）';
  const guidance = (GUIDANCE[panel] || { open: [], closed: [] })[open ? 'open' : 'closed'];
  const lines = [
    `## ${title}状态`,
    statusLine,
    '',
    '操作指引:',
    ...guidance.map(line => `  - ${line}`),
  ];
  if (!open) {
    lines.push('');
    lines.push('⚠️ 如果当前状态为未打开，你绝对不可以说"面板已打开"。必须先调用工具。');
  }
  return lines.join('\n');
}

module.exports = {
  SURFACE_PANEL_MAP,
  setPanelState,
  getPanelState,
  getEffectiveState,
  buildPanelStateContext,
  refreshPanelStateMaps,
  PANEL_CLOSED_TTL_MS,
  PANEL_OPEN_TTL_MS,
};
