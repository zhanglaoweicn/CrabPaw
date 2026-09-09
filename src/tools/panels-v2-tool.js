'use strict';

/**
 * panels-v2-tool.js — 风格 7 个信息面板工具
 *
 * 工具:
 * ShowHotspot — 热点（多平台）
 * ShowWorldCup — 体育赛事
 * ShowPersonCard — 人物卡片
 * ShowDocPanel — 文档面板
 * PushFocusBanner — 焦点横幅（推送重要通知）
 * PushTerminalStream — 终端流（推送实时日志）
 * ShowVoiceRetire — 语音退休总结
 *
 * 设计：每个工具都支持 text / compact / scene 三种 format。
 * text = 终端友好字符串
 * compact = 单行摘要
 * scene = 直接推 SceneSet 卡片给前端
 */

const { registry } = require('./registry');
const v2 = require('../core/panels-v2');

// 通用：把 scene 格式直接写到 scene store
function _pushScene(id, sceneData, intent = 'inform') {
 try {
 const { getSceneStore } = require('../core/scene/scene-store');
 const store = getSceneStore();
 // 2026-08-18 修复: 原 setSurface 非 scene-store API → 所有 v2 工具 scene 格式
 // 静默失败(被 catch 吞掉)。改用 upsertSurface(与 panel-handler 一致)。
 store.upsertSurface(id, { kind: sceneData.kind, intent, data: sceneData });
 } catch (e) { console.warn('[Scene] push failed:', e.message) }
}

// ── 1. ShowHotspot ─────────────────────────────────
registry.register({
 name: 'ShowHotspot',
 toolset: 'panel',
 category: 'information',
 description: '展示热点/热搜榜单。支持 weibo/zhihu/baidu/douyin/bilibili 平台。GUI/桌面端用户一律传 action="show" + format="scene"(弹出 hotspot-panel 热点面板卡片); format=text 仅用于终端表格输出, GUI 请求勿用文本表格替代面板。',
 // 2026-08-19 搜索体验修复: 注册日志 WARN"未声明 whenNotToUse"实锤——
 // "推荐最近的AI资讯"曾落 general 后 LLM 自选本工具弹 UI 卡片(用户反感)。
 // 资讯/新闻/信息查询类请求应走 WebSearch 文本回答, 仅明确要热搜榜单才用本工具。
 whenNotToUse: '仅当用户明确要求热点/热搜/实时榜单时使用（如"热搜榜""今日热点排行"）。推荐资讯、查询新闻、搜索信息等请求应使用 WebSearch 工具，不要弹出热点面板。',
 schema: {
 type: 'object',
 properties: {
 action: {
 type: 'string',
 enum: ['show', 'hide'],
 description: 'show=展示热点榜单(默认)，hide=关闭热点面板',
 default: 'show',
 },
 platform: { type: 'string', enum: ['weibo', 'zhihu', 'baidu', 'douyin', 'bilibili'], default: 'weibo' },
 format: { type: 'string', enum: ['text', 'compact', 'scene'], default: 'text' },
 },
 },
 handler: async (params) => {
 const action = String(params?.action || 'show').trim().toLowerCase();
 if (action === 'hide') {
  try {
   const { getSceneStore } = require('../core/scene/scene-store');
   const { setPanelState } = require('../core/panel-state');
   getSceneStore().removeSurface('hotspot-panel');
   setPanelState('hotspot', 'closed');
  } catch (e) {
   return { success: false, error: `关闭热点面板失败: ${e.message}` };
  }
  return { success: true, content: '热点面板已关闭。' };
 }
 const data = await v2.getHotspotData(params.platform || 'weibo', { forceRefresh: params.refresh === true });
 if (params.format === 'scene') {
 // 2026-08-18 v1(v2) 迁移接线: 固定写 hotspot-panel surface(SURFACE_PANEL_MAP 映射) +
 // panel-state open——此前写 hotspot_<platform> 与 hide 删的 'hotspot-panel' 不对称,
 // 打开后永远关不掉; 也不写 panel-state → AI 上下文恒见"已关闭"
 _pushScene('hotspot-panel', v2.renderHotspot(data, 'scene'));
 try {
  const { setPanelState } = require('../core/panel-state');
  setPanelState('hotspot', 'open');
 } catch (e) { console.warn('[ShowHotspot] setPanelState failed:', e.message); }
 return { success: true, sceneCard: true, itemCount: data.items?.length || 0, platform: data.platform };
 }
 return { success: true, content: v2.renderHotspot(data, params.format || 'text'), data };
 },
 checkFn: () => true,
 timeout: 15000,
});

// ── 2. ShowWorldCup ───────────────────────────────
registry.register({
 name: 'ShowWorldCup',
 toolset: 'panel',
 category: 'information',
 description: '展示体育赛事面板：赛程/比分/积分榜。sport=football/basketball/tennis/esports。',
 schema: {
 type: 'object',
 properties: {
 sport: { type: 'string', enum: ['football', 'basketball', 'tennis', 'esports'], default: 'football' },
 format: { type: 'string', enum: ['text', 'scene'], default: 'text' },
 },
 },
 handler: async (params) => {
 const data = await v2.getWorldCupData({ sport: params.sport || 'football' });
 if (params.format === 'scene') {
 _pushScene(`worldcup_${params.sport || 'football'}`, v2.renderWorldCup(data, 'scene'));
 return { success: true, sceneCard: true, eventCount: data.events?.length || 0 };
 }
 return { success: true, content: v2.renderWorldCup(data, 'text'), data };
 },
 checkFn: () => true,
 timeout: 10000,
});

// ── 3. ShowPersonCard ─────────────────────────────
registry.register({
 name: 'ShowPersonCard',
 toolset: 'panel',
 category: 'information',
 description: '展示人物卡片：基础信息 + 关联记忆 + 联系方式。从记忆系统中查找 name 的所有关联。',
 schema: {
 type: 'object',
 properties: {
 name: { type: 'string', description: '人物姓名（必填）' },
 title: { type: 'string' },
 role: { type: 'string' },
 company: { type: 'string' },
 format: { type: 'string', enum: ['text', 'scene'], default: 'text' },
 },
 required: ['name'],
 },
 handler: async (params) => {
 const data = await v2.getPersonCardData(params.name, params);
 if (params.format === 'scene') {
 _pushScene(`person_${params.name}`, v2.renderPersonCard(data, 'scene'), 'inform');
 return { success: true, sceneCard: true, related: data.related?.length || 0 };
 }
 return { success: true, content: v2.renderPersonCard(data, 'text'), data };
 },
 checkFn: () => true,
 timeout: 5000,
});

// ── 4. ShowDocPanel ──────────────────────────────
registry.register({
 name: 'ShowDocPanel',
 toolset: 'panel',
 category: 'information',
 description: '展示文档面板：标题 + 摘要 + 章节。直接传入 docId 和可选的 title/summary/sections。',
 schema: {
 type: 'object',
 properties: {
 docId: { type: 'string' },
 title: { type: 'string' },
 summary: { type: 'string' },
 sections: { type: 'array', items: { type: 'object' } },
 author: { type: 'string' },
 wordCount: { type: 'number' },
 format: { type: 'string', enum: ['text', 'scene'], default: 'text' },
 },
 required: ['docId'],
 },
 handler: async (params) => {
 const data = await v2.getDocData(params.docId, params);
 if (params.format === 'scene') {
 _pushScene(`doc_${params.docId}`, v2.renderDoc(data, 'scene'));
 return { success: true, sceneCard: true };
 }
 return { success: true, content: v2.renderDoc(data, 'text'), data };
 },
 checkFn: () => true,
 timeout: 5000,
});

// ── 5. PushFocusBanner ───────────────────────────
registry.register({
 name: 'PushFocusBanner',
 toolset: 'panel',
 category: 'ui',
 description: '推送焦点横幅（重要通知/告警/进度）。level=info/success/warning/error/alert。ttlMs 后自动消失（0 表示不自动消失）。',
 schema: {
 type: 'object',
 properties: {
 level: { type: 'string', enum: ['info', 'success', 'warning', 'error', 'alert'], default: 'info' },
 title: { type: 'string' },
 message: { type: 'string' },
 actions: { type: 'array', items: { type: 'object' } },
 ttlMs: { type: 'number', default: 0 },
 },
 required: ['title', 'message'],
 },
 handler: async (params) => {
 const banner = await v2.pushFocusBanner(params);
 return { success: true, banner, _hint: '横幅已推送，前端会立即显示。' };
 },
 checkFn: () => true,
 timeout: 3000,
});

// ── 6. PushTerminalStream ────────────────────────
registry.register({
 name: 'PushTerminalStream',
 toolset: 'panel',
 category: 'ui',
 description: '向终端流面板推送一行实时日志（用于工具执行进度、后台任务、调试等）。',
 schema: {
 type: 'object',
 properties: {
 line: { type: 'string', description: '日志内容' },
 level: { type: 'string', enum: ['info', 'warn', 'error', 'debug'], default: 'info' },
 stream: { type: 'string', enum: ['stdout', 'stderr', 'system'], default: 'stdout' },
 },
 required: ['line'],
 },
 handler: async (params) => {
 v2.getTerminalStream().push(params.line, { level: params.level, stream: params.stream });
 return { success: true, _hint: '已推送到终端流面板' };
 },
 checkFn: () => true,
 timeout: 2000,
});

// ── 7. ShowVoiceRetire ───────────────────────────
registry.register({
 name: 'ShowVoiceRetire',
 toolset: 'panel',
 category: 'information',
 description: '展示语音会话退休总结：时长/回合/ASR/TTS/重连/提示。',
 schema: {
 type: 'object',
 properties: {
 sessionId: { type: 'string' },
 duration: { type: 'number' },
 turns: { type: 'number' },
 asrChars: { type: 'number' },
 ttsChars: { type: 'number' },
 reconnects: { type: 'number' },
 errors: { type: 'number' },
 format: { type: 'string', enum: ['text', 'scene'], default: 'text' },
 },
 required: ['sessionId'],
 },
 handler: async (params) => {
 const data = await v2.getVoiceRetireData(params.sessionId, params);
 if (params.format === 'scene') {
 _pushScene(`voice_retire_${params.sessionId}`, v2.renderVoiceRetire(data, 'scene'));
 return { success: true, sceneCard: true };
 }
 return { success: true, content: v2.renderVoiceRetire(data, 'text'), data };
 },
 checkFn: () => true,
 timeout: 3000,
});

console.log('📊 信息面板 v2 工具已注册 (ShowHotspot, ShowWorldCup, ShowPersonCard, ShowDocPanel, PushFocusBanner, PushTerminalStream, ShowVoiceRetire)');

module.exports = {};
