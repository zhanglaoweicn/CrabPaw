// 2026-08-01 两代面板工具并存决策：
// - v1（本文件）mode 工具经 SSE 事件驱动旧面板（GUI Dashboard 仍监听 hotspot_mode/voice_retire 等事件，不可删除）
// - v2（panels-v2-tool.js）Show 工具驱动新 Scene 卡片（SceneShell 渲染）
// - LLM 引导：重叠工具的 description 已标注优先使用 v2 版本
/**
 * Panel Tools — 信息面板工具
 *
 * 注册为 AI 可调用的工具，让 AI 能主动展示：
 * 1. WeatherPanel — 天气面板（替代老旧 weather-tools.js）
 * 2. HotspotPanel — 热点趋势面板
 * 3. StatusPanel — 系统状态面板
 *
 * 信息面板体系：
 * 热点面板 | 天气卡片 | 人物卡片 | 文档面板 | 状态展示
 * 通过 ui_set（或等价的 tool）投影到用户界面。
 */

const { registry } = require('./registry');
const panels = require('../core/panels');

// ─── 天气面板工具 ───
registry.register({
 name: 'ShowWeather',
 toolset: 'panel',
 category: 'information',
 description: '展示指定城市的实时天气和未来5天预报。数据来自 wttr.in（无需 API Key）。使用终端友好的彩色表格格式显示。',
 schema: {
 type: 'object',
 properties: {
 city: {
 type: 'string',
 description: '城市名称，支持中文（如"北京"）或英文（如"Shanghai"）。默认: 北京',
 },
 format: {
 type: 'string',
 enum: ['terminal', 'compact'],
 description: '输出格式。terminal=彩色表格，compact=单行摘要。默认: terminal',
 default: 'terminal',
 },
 action: {
 type: 'string',
 enum: ['show', 'hide'],
 description: 'show=展示天气面板(默认)，hide=关闭面板',
 default: 'show',
 },
 },
 },
 handler: async (params) => {
 const action = String(params?.action || 'show').trim().toLowerCase();
 if (action === 'hide') {
  try {
   const { getSceneStore } = require('../core/scene/scene-store');
   const { setPanelState } = require('../core/panel-state');
   getSceneStore().removeSurface('weather-panel');
   setPanelState('weather', 'closed');
  } catch (e) {
   return { success: false, error: `关闭天气面板失败: ${e.message}` };
  }
  return { success: true, content: '天气面板已关闭。' };
 }
 const city = params.city || '北京';
 try {
 const data = await panels.weather.getWeather(city, {
 forceRefresh: params.refresh === true,
 });

 // 2026-08-01: 创建 weather-panel scene surface——触发天气面板展示。
 // 此前 ShowWeather 只返回文本，WeatherPopup（监听 weather-panel surface）
 // 永不出现，天气面板功能实际不可用。
 try {
 const { getSceneStore } = require('../core/scene/scene-store');
 getSceneStore().upsertSurface('weather-panel', {
 kind: 'weather',
 data: {
 city: data.city,
 temp: data.current?.temp || '',
 condition: data.current?.condition || '',
 humidity: data.current?.humidity || '',
 wind: data.current?.wind || '',
 forecast: (data.forecast || []).slice(0, 5),
 },
 intent: 'inform',
 });
 } catch (e) { console.warn('[ShowWeather] 天气面板 surface 创建失败:', e.message); }

  // 2026-08-15: 打开态写入 panel-state——此前 weather 只写 closed（remove 链路），
  // open 从不记录，注入侧打开态摘要永远不触发（wiring 断层 L2）
  try {
    const { setPanelState } = require('../core/panel-state');
    setPanelState('weather', 'open');
  } catch (e) { console.warn('[ShowWeather] panel-state 写入失败:', e.message); }

 if (params.format === 'compact') {
 return {
 success: true,
 content: panels.weather.renderCompact(data),
 data,
 };
 }

 return {
 success: true,
 content: panels.weather.render(data),
 data,
 };
 } catch (e) {
 return { success: false, error: `获取天气失败: ${e.message}` };
 }
 },
 checkFn: () => true,
 timeout: 15000,
});

// ─── 台风追踪面板工具（2026-08-14 新增；08-14 二次修复：真实数据源，删 mock）───
registry.register({
 name: 'ShowTyphoon',
 toolset: 'panel',
 category: 'information',
 description: '展示台风追踪面板：台风编号/等级/中心气压/风速、历史路径轨迹地图、7级/10级风圈、登陆点与防御提示。数据来自浙江水利厅台风路径实时发布系统（政府公益源，10s 超时），失败自动降级 apizero.cn 备源；两源均失败时如实告知用户数据暂不可用（绝不虚构台风数据），并建议查看官方发布渠道。当用户询问台风、台风路径、台风预警时调用。会以可视面板形式展示。',
 schema: {
 type: 'object',
 properties: {
 action: {
 type: 'string',
 enum: ['show', 'hide'],
 description: 'show=展示台风面板(默认)，hide=关闭面板',
 default: 'show',
 },
 },
 },
 handler: async (params, context) => {
 const { getSceneStore } = require('../core/scene/scene-store');
 if (params.action === 'hide') {
 try { getSceneStore().removeSurface('typhoon-panel'); } catch (e) { console.warn('[ShowTyphoon] 移除 surface 失败:', e.message); }
 return { success: true, content: '台风面板已关闭。' };
 }
 try {
 // 2026-08-14 二次修复: 真实双源数据（panels.typhoon 已删 mock）——
 // 失败路径抛可读错误 → 如实反馈, 不上任何虚构 surface
 const data = await panels.typhoon.getTyphoon(context);
 getSceneStore().upsertSurface('typhoon-panel', {
 kind: 'typhoon',
 data,
 intent: 'inform',
 });
 return { success: true, content: panels.typhoon.render(data), data };
 } catch (e) {
 // 2026-08-15: "暂无活跃台风"不是失败——面板以空态打开(用户可见面板存在
 // 且数据源工作正常), 而不是静默不弹面板让用户以为"没实现"
 if (/暂无活跃台风|没有活跃台风/i.test(e.message || '')) {
 const emptyData = { empty: true, message: e.message, updatedAt: new Date().toISOString(), disclaimer: '台风信息以官方发布为准。' };
 getSceneStore().upsertSurface('typhoon-panel', {
 kind: 'typhoon',
 data: emptyData,
 intent: 'inform',
 });
 return { success: true, content: e.message, data: emptyData };
 }
 return { success: false, error: `获取台风数据失败: ${e.message}` };
 }
 },
 checkFn: () => true,
 whenNotToUse: ['用户只问普通天气（非台风）时用 ShowWeather', '需要台风深度详情文本时用 TyphoonQuery'],
 timeout: 25000,
});

// ─── 股票行情面板工具（2026-08-14 新增：基于既有股票技能数据面）───
// 2026-08-15: 补 action=hide 关闭语义（对齐 ShowTyphoon 模式）——此前无关闭路径,
// AI 只能试 SceneSet/ControlUI(契约均拒), "关闭股票面板"无法实现(实机日志 07:54:33-47)。
registry.register({
 name: 'ShowStock',
 toolset: 'panel',
 category: 'information',
 description: '展示/关闭股票行情面板：查询股票（中文名或代码，逗号分隔多只，默认上证指数）的实时行情列表与首只股票K线图，附大盘指数。数据来自东方财富公开行情源（四源冗余自动降级）。当用户说"打开股票面板/看看行情/股票现在怎么样/大盘怎么样"等要求看行情面板时优先调用；用户要求关闭股票面板时调用 ShowStock(action="hide")；需要深度多因子分析（动量/风险/宏观/量化评分）时用 StockQuery。',
 // 2026-08-25(用户实机 18:31/18:47): 台风问题(最近有台风吗/打开台风卡片)模型曾
 // 2 轮误调 ShowStock——台风数据/面板各归其位: TyphoonQuery(数据)/ShowTyphoon(面板)。
 whenNotToUse: '用户询问台风/台风路径/台风预警时禁止调用(那是 ShowTyphoon 面板); 用户问天气用 ShowWeather, 问热点用 ShowHotspot。仅在用户确实问股票/行情/大盘/持仓/股价时调用。需深度多因子分析(动量/风险/宏观/量化评分)时用 StockQuery。',
 schema: {
 type: 'object',
 properties: {
 queries: {
 type: 'string',
 description: '股票名称或代码，逗号分隔多只（如"贵州茅台,宁德时代"或"600519,300750"），留空默认上证指数',
 },
 // 2026-08-17: query 单数别名——deepseek-v4-flash 实机两次传 query 被契约拒。
 // 与 tool-contract.js 契约三端同步（schema + handler 都要放行 query）。
 query: {
 type: 'string',
 description: '股票名称或代码（queries 的单数别名，任选其一）',
 },
 // 2026-08-21: symbols 别名——实机(10:49:18) deepseek-v4-flash 传 {"symbols":"688836"}
 // 被契约拒("should NOT have additional properties")→ handler 未执行 → 面板不弹。
 // 与 tool-contract.js 契约三端同步（schema + handler 都要放行 symbols）。
 symbols: {
 type: 'string',
 description: '股票名称或代码（queries 的复数别名，任选其一）。如"688836"或"宇树科技"',
 },
 period: {
 type: 'string',
 enum: ['day', 'week'],
 description: 'K线周期（day=日K, week=周K, 周K由日线聚合）。默认 day',
 default: 'day',
 },
 action: {
 type: 'string',
 enum: ['show', 'hide'],
 description: 'show=展示股票面板(默认)，hide=关闭面板',
 default: 'show',
 },
 },
 },
 handler: async (params, context) => {
 const { getSceneStore } = require('../core/scene/scene-store');
 const action = String(params?.action || 'show').trim().toLowerCase();
 // hide 短路：不取行情数据（避免无谓网络请求），直接移除 surface + 记录 closed 状态
 if (action === 'hide') {
  try {
  const { setPanelState } = require('../core/panel-state');
  getSceneStore().removeSurface('stock-panel');
  setPanelState('stock', 'closed');
  } catch (e) {
  return { success: false, error: `关闭股票面板失败: ${e.message}` };
  }
  return { success: true, message: '股票行情面板已关闭' };
 }
 try {
 const data = await panels.stock.getStockPanelData({ queries: params.queries || params.query || params.symbols, context, period: params.period === 'week' ? 'week' : 'day' });
 getSceneStore().upsertSurface('stock-panel', {
 kind: 'stock-panel',
 data,
 intent: 'inform',
 });
  // 2026-08-15: 打开态写入 panel-state（对称 :179 的 hide→closed 写入）
  try {
    const { setPanelState } = require('../core/panel-state');
    setPanelState('stock', 'open');
  } catch (e) { console.warn('[ShowStock] panel-state 写入失败:', e.message); }
 return { success: true, content: panels.stock.render(data), data };
 } catch (e) {
  // 2026-08-17: 产品要求"不论数据是否充足，都应当弹出卡片"——取数/解析失败也
  // upsert 失败态 surface（items:[]），StockPanel 前端空态渲染"暂无行情数据"+
  // "未取到行情：xxx"，卡片一定弹出，绝不静默无卡或只回文字错误（实机：
  // "津富士达"解析失败 → 无卡 → 用户反馈"没有弹出股票卡片"）。
  try {
    const raw = String(params?.queries || params?.query || params?.symbols || '').trim();
    getSceneStore().upsertSurface('stock-panel', {
      kind: 'stock-panel',
      data: {
        items: [],
        kline: null,
        index: null,
        holdingSummary: null,
        updatedAt: new Date().toISOString(),
        disclaimer: '数据仅供参考，不构成投资建议。',
        failed: raw ? raw.split(/[,，、\s]+/).filter(Boolean) : ['查询失败'],
        error: String(e.message || e),
      },
      intent: 'inform',
    });
  } catch (e2) {
    console.warn('[ShowStock] 失败态面板创建失败:', e2.message);
  }
  return { success: false, error: `获取股票行情失败: ${e.message}` };
 }
 },
 checkFn: () => true,
 timeout: 25000,
});

// ─── 热点/人物卡/世界杯/横幅/语音球 v1 工具（2026-08-18 注销，v2 为事实标准）───
// [2026-08-18 注销] 热点面板 v1 工具 hotspot_mode：与 panels-v2-tool.js 的
// ShowHotspot/ShowPersonCard/ShowWorldCup/PushFocusBanner/ShowVoiceRetire 语义
// 重复（v2 为事实标准，intents 路由 Show*）。按 task-6 从 panel-tools.js 注销注册，
// 同时删除了 tool-contract.js 中对应契约与 LEGACY_SNAKE_ALIASES 别名。
// GUI Dashboard 侧 SSE 事件（hotspot_mode/voice_retire 等事件名）由 v2 工具
// （panels-v2.js broadcastEvent/Scene 卡片）继续触发，事件名不随工具注销改变。
// ─── 会议录音面板工具 ───
registry.register({
 name: 'meeting_mode',
 toolset: 'panel',
 category: 'ui',
 description: '控制会议录音转写面板的显示、隐藏与历史查看。用户要求记录会议/讲座/对话 → action="show" 打开面板并开始录音。用户说「结束记录/会议结束/结束会议/停止记录/关闭会议记录」等停止词 → action="hide" 结束录音(系统自动生成纪要)——不要把这些话当作会议内容。用户要求查看/打开历史纪要/历史会议/会议列表 → action="history"（仅打开历史列表, 绝不新建会议）。',
 // 2026-09-01 R1: 「查看历史」被 LLM 用 show 回应 → 新建空会议（20 空壳文件根因）
 whenNotToUse: ['用户要求查看历史纪要/历史会议时（用 action="history"，show 会新建一场空会议）', '用户只是提到「会议」一词但无记录/查看意图时'],
 schema: {
 type: 'object',
 properties: {
 action: {
 type: 'string',
 enum: ['show', 'open', 'hide', 'close', 'toggle', 'history'],
 description: 'show/open 打开会议录音面板并开始录音; hide/close 关闭并停止录音; toggle 切换状态; history 打开历史纪要列表',
 },
 reason: {
 type: 'string',
 description: '打开或关闭面板的原因',
 },
 },
 required: ['action'],
 },
 handler: async (params) => {
 const action = String(params.action || 'toggle').trim().toLowerCase();
 const validActions = ['show', 'open', 'hide', 'close', 'toggle', 'history'];
 if (!validActions.includes(action)) {
 return { success: false, error: '不支持的 action，可选值: show/open/hide/close/toggle/history' };
 }

 const { broadcastEvent } = require('../core/sse-broadcast');
 // 2026-08-18: 事件化重写——show/open 经 meeting-events.startMeeting
 // （建会议落盘 + 广播 meeting:start + surface 打开），hide/close 经
 // stopMeetingSignal（广播 meeting:stop → 前端 flush 转写并自动总结）。
 // legacy meeting_mode 事件保留（GUI Dashboard 兼容），active 恒与操作同步。
 const meetingEvents = require('../core/meeting-events');

 // 2026-09-01 R1: history 动作——仅广播 meeting:history 让前端打开历史列表,
 // 不建会不落盘（拆「查看历史被 show 回应 → 新建空会议」空壳制造机）。
 // reason 声明上提: history 分支要用, 原 const reason 在 nextActive 之后(TDZ)。
 const reason = typeof params.reason === 'string' ? params.reason : '';
 if (action === 'history') {
 meetingEvents.historyMeetingSignal();
 broadcastEvent('meeting_mode', { action: 'history', active: false, reason });
 return {
 success: true,
 tool: 'meeting_mode',
 state: { active: false },
 message: '已打开历史纪要列表',
 };
 }

 let nextActive = null;
 if (action === 'show' || action === 'open') nextActive = true;
 if (action === 'hide' || action === 'close') nextActive = false;
 if (action === 'toggle') {
 // toggle：无进行中会议 → 开；有 → 停
 const st = meetingEvents.getMeetingStatus();
 nextActive = !(st && st.meetingId && st.status === 'recording');
 }

 if (nextActive) {
 const title = reason ? reason.slice(0, 24) : undefined;
 const meeting = meetingEvents.startMeeting({ title });
 broadcastEvent('meeting_mode', { action: 'show', active: true, reason });

 return {
 success: true,
 tool: 'meeting_mode',
 state: { active: true, meetingId: meeting.id },
 message: `已开始会议记录「${meeting.title}」，转写将实时显示在卡片内`,
 };
 }

 const meetingId = meetingEvents.stopMeetingSignal();
 broadcastEvent('meeting_mode', { action: 'hide', active: false, reason });

 return {
 success: true,
 tool: 'meeting_mode',
 state: { active: false, meetingId: meetingId || null },
 message: meetingId ? '已停止会议记录，正在自动总结生成纪要' : '当前没有进行中的会议记录',
 };
 },
 checkFn: () => true,
 timeout: 5000,
});

// ─── 系统状态面板工具 ───
registry.register({
 name: 'ShowSystemStatus',
 toolset: 'panel',
 category: 'information',
 description: '展示 CrabPaw 系统的实时运行状态，包括：运行时间、内存占用、记忆系统节点数、TTS 引擎状态、已注册工具数、定时任务数等。',
 schema: {
 type: 'object',
 properties: {
 format: {
 type: 'string',
 enum: ['terminal', 'compact'],
 description: '输出格式。terminal=完整状态，compact=精简摘要。默认: terminal',
 default: 'terminal',
 },
 },
 },
 handler: async (params) => {
 try {
 const status = await panels.status.getStatus();

 if (params.format === 'compact') {
 return {
 success: true,
 content: await panels.status.renderCompact(),
 data: status,
 };
 }

 return {
 success: true,
 content: await panels.status.render(),
 data: status,
 };
 } catch (e) {
 return { success: false, error: `获取系统状态失败: ${e.message}` };
 }
 },
 checkFn: () => true,
 timeout: 10000,
});

// ─── 活动状态查询工具 ───
registry.register({
 name: 'QueryActivity',
 toolset: 'panel',
 category: 'information',
 description: '查看 AI 的当前活动状态（idle/thinking/tooling/speaking/error）和最近活动历史。帮助用户了解 AI 刚才做了什么、现在在干什么。',
 schema: {
 type: 'object',
 properties: {
 recentCount: {
 type: 'number',
 description: '最近活动条数（默认: 10）',
 default: 10,
 },
 },
 },
 handler: async (params) => {
 try {
 const { globalActivityState } = require('../core/activity-state');
 const { globalActivityStream } = require('../core/activity-stream');

 const state = globalActivityState;
 const stream = globalActivityStream;
 const count = params.recentCount || 10;

 const recent = stream ? stream.recent(count) : [];
 const lines = [];

 lines.push(`当前状态: ${state.summary} (已持续 ${(state.elapsed / 1000).toFixed(1)}s)`);
 lines.push('');

 if (recent.length > 0) {
 lines.push('最近活动:');
 for (const a of recent.slice(-count)) {
 const ts = new Date(a.timestamp).toLocaleTimeString();
 const dur = a.duration ? ` (${a.duration}ms)` : '';
 lines.push(` ${a.icon} [${ts}] ${a.summary}${dur}`);
 }
 }

 return {
 success: true,
 content: lines.join('\n'),
 state: state.state,
 stateMeta: state.meta,
 diagnostics: state.getDiagnostics(),
 streamStats: stream ? stream.getStats() : null,
 };
 } catch (e) {
 return { success: false, error: `查询活动状态失败: ${e.message}` };
 }
 },
 checkFn: () => true,
 timeout: 5000,
});

// ─── 记忆图谱工具 ───
registry.register({
 name: 'ShowMemoryGraph',
 toolset: 'panel',
 category: 'information',
 description: '展示 CrabPaw 记忆实体关系图谱。显示记忆系统中的节点（实体/话题）和关系连线（关联/包含关系）。支持查看图谱统计摘要。',
 schema: {
 type: 'object',
 properties: {
 format: {
 type: 'string',
 enum: ['compact', 'full'],
 description: 'compact=精简统计，full=节点和关系数据。默认: compact',
 default: 'compact',
 },
 },
 },
 handler: async (params) => {
 try {
 const mg = require('../core/panels').memoryGraph;
 const data = await mg.getGraphData({ forceRefresh: true });

 if (params.format === 'compact' || params.format !== 'full') {
 const compact = await mg.renderCompact();
 return { success: true, content: compact, stats: data.stats };
 }

 const lines = [];
 lines.push('🧠 记忆图谱 (' + data.stats.nodes + ' 节点 / ' + data.stats.edges + ' 边)');
 lines.push(' 记忆总数: ' + data.stats.memoryTotal);
 lines.push('');
 lines.push('主要节点:');
 for (const n of data.nodes.slice(0, 20)) {
 lines.push(' ' + n.label + ' [' + n.type + '] size=' + n.size);
 }
 if (data.nodes.length > 20) lines.push(' ... 还有 ' + (data.nodes.length - 20) + ' 个节点');
 if (data.edges.length > 0) {
 lines.push('');
 lines.push('主要关系 (' + data.edges.length + ' 条):');
 for (const e of data.edges.slice(0, 15)) {
 lines.push(' ' + e.source + ' -> ' + e.target + ' (' + e.label + ', 权重=' + e.weight + ')');
 }
 }
 return { success: true, content: lines.join('\n'), data };
 } catch (e) {
 return { success: false, error: '获取记忆图谱失败: ' + e.message };
 }
 },
 checkFn: () => true,
 timeout: 10000,
});

// ─── 热点/人物卡/世界杯/横幅/语音球 v1 工具（2026-08-18 注销，v2 为事实标准）───
// [2026-08-18 注销] 人物卡片 v1 工具 person_card_mode：与 panels-v2-tool.js 的
// ShowHotspot/ShowPersonCard/ShowWorldCup/PushFocusBanner/ShowVoiceRetire 语义
// 重复（v2 为事实标准，intents 路由 Show*）。按 task-6 从 panel-tools.js 注销注册，
// 同时删除了 tool-contract.js 中对应契约与 LEGACY_SNAKE_ALIASES 别名。
// GUI Dashboard 侧 SSE 事件（hotspot_mode/voice_retire 等事件名）由 v2 工具
// （panels-v2.js broadcastEvent/Scene 卡片）继续触发，事件名不随工具注销改变。
// ─── 热点/人物卡/世界杯/横幅/语音球 v1 工具（2026-08-18 注销，v2 为事实标准）───
// [2026-08-18 注销] 体育赛事面板 v1 工具 worldcup_mode：与 panels-v2-tool.js 的
// ShowHotspot/ShowPersonCard/ShowWorldCup/PushFocusBanner/ShowVoiceRetire 语义
// 重复（v2 为事实标准，intents 路由 Show*）。按 task-6 从 panel-tools.js 注销注册，
// 同时删除了 tool-contract.js 中对应契约与 LEGACY_SNAKE_ALIASES 别名。
// GUI Dashboard 侧 SSE 事件（hotspot_mode/voice_retire 等事件名）由 v2 工具
// （panels-v2.js broadcastEvent/Scene 卡片）继续触发，事件名不随工具注销改变。
// ─── 热点/人物卡/世界杯/横幅/语音球 v1 工具（2026-08-18 注销，v2 为事实标准）───
// [2026-08-18 注销] 专注横幅 v1 工具 focus_banner：与 panels-v2-tool.js 的
// ShowHotspot/ShowPersonCard/ShowWorldCup/PushFocusBanner/ShowVoiceRetire 语义
// 重复（v2 为事实标准，intents 路由 Show*）。按 task-6 从 panel-tools.js 注销注册，
// 同时删除了 tool-contract.js 中对应契约与 LEGACY_SNAKE_ALIASES 别名。
// GUI Dashboard 侧 SSE 事件（hotspot_mode/voice_retire 等事件名）由 v2 工具
// （panels-v2.js broadcastEvent/Scene 卡片）继续触发，事件名不随工具注销改变。
// ─── 热点/人物卡/世界杯/横幅/语音球 v1 工具（2026-08-18 注销，v2 为事实标准）───
// [2026-08-18 注销] 语音球收起 v1 工具 voice_retire：与 panels-v2-tool.js 的
// ShowHotspot/ShowPersonCard/ShowWorldCup/PushFocusBanner/ShowVoiceRetire 语义
// 重复（v2 为事实标准，intents 路由 Show*）。按 task-6 从 panel-tools.js 注销注册，
// 同时删除了 tool-contract.js 中对应契约与 LEGACY_SNAKE_ALIASES 别名。
// GUI Dashboard 侧 SSE 事件（hotspot_mode/voice_retire 等事件名）由 v2 工具
// （panels-v2.js broadcastEvent/Scene 卡片）继续触发，事件名不随工具注销改变。
console.log('📊 信息面板工具已注册 (ShowWeather, ShowTyphoon, ShowStock, ShowSystemStatus, QueryActivity, ShowMemoryGraph, meeting_mode)');
