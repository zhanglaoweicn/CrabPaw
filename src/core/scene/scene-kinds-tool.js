'use strict';

/**
 * scene-kinds-tool.js — SCENE-PROTOCOL §6 标准 kind 工具集
 *
 * 在 SceneSet 通用 upsert 之外，为常用卡片提供语义化专用工具。
 * 遵循 SCENE-PROTOCOL v1 §6 kind 词汇表：
 * - §6.1 内容 kind:
 * text (核心) / media (核心) / form (可选) / awakening (领域) / weather (领域)
 * - §6.2 排版原语: stack / row / col
 * - 自有: Progress / SelfCheck / Metric / Choice / Image / Chart / Timeline
 *
 * 所有工具都通过 getSceneStore().upsertSurface() 写入同一份场景状态，
 * 由前端 SceneShell 统一渲染。
 */

const { getSceneStore } = require('./scene-store');

function _unwrap(res) {
 if (!res) return res;
 if (res.data && typeof res.data === 'object') return res.data;
 return res;
}

// ── 1. SceneProgress ─────────────────────────────────────
const sceneProgress = {
 name: 'SceneProgress',
 toolset: 'scene',
 category: 'scene',
 description: '向用户展示一个进度条卡片。适合在长任务（如文件写入、安装、批处理）执行时实时显示完成度。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string', description: '卡片唯一 ID（更新同 ID 会替换进度）' },
 label: { type: 'string', description: '进度条上方说明文字（如"正在安装 Node.js"）' },
 progress: { type: 'number', minimum: 0, maximum: 100, description: '0-100 的整数' },
 text: { type: 'string', description: '可选副标题（如"已下载 12MB / 28MB"）' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'ambient' },
 },
 required: ['id', 'progress'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const surface = {
 kind: 'progress',
 data: {
 label: params.label || '',
 progress: Math.max(0, Math.min(100, Number(params.progress) || 0)),
 text: params.text || '',
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'ambient',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'progress',
 progress: surface.data.progress,
 display: `Progress "${params.id}" = ${surface.data.progress}%`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 2. SceneSelfCheck ───────────────────────────────────
const sceneSelfCheck = {
 name: 'SceneSelfCheck',
 toolset: 'scene',
 category: 'scene',
 description: '展示一个自检/诊断扫描卡片，列出多个检查项及其状态（checking/ok/warn/error）。适合在启动/排错时让用户看到完整的诊断过程。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 title: { type: 'string', description: '卡片标题（如"系统自检"）' },
 items: {
 type: 'array',
 description: '检查项列表',
 items: {
 type: 'object',
 properties: {
 label: { type: 'string' },
 status: { type: 'string', enum: ['pending', 'checking', 'ok', 'warn', 'error'] },
 detail: { type: 'string' },
 },
 required: ['label', 'status'],
 },
 },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'title', 'items'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const items = Array.isArray(params.items) ? params.items.map(it => ({
 label: String(it.label || ''),
 status: ['pending', 'checking', 'ok', 'warn', 'error'].includes(it.status) ? it.status : 'pending',
 detail: it.detail || '',
 })) : [];
 const surface = {
 kind: 'selfcheck',
 data: { title: params.title || '自检', items },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'selfcheck',
 itemCount: items.length,
 display: `SelfCheck "${params.id}" (${items.length} 项)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 3. SceneMetric ─────────────────────────────────────
const sceneMetric = {
 name: 'SceneMetric',
 toolset: 'scene',
 category: 'scene',
 description: '展示一个指标卡片（关键数据点），适合显示一个具体数字 + 标签，如"今日消息 1,234"、"延迟 87ms"。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 label: { type: 'string', description: '指标名称' },
 value: { type: 'string', description: '指标值（字符串，允许"1,234"或"87ms"）' },
 unit: { type: 'string', description: '单位（如 "ms" / "MB"）' },
 trend: { type: 'string', enum: ['up', 'down', 'flat'] },
 subtitle: { type: 'string' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'label', 'value'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const surface = {
 kind: 'metric',
 data: {
 label: params.label,
 value: String(params.value),
 unit: params.unit || '',
 trend: ['up', 'down', 'flat'].includes(params.trend) ? params.trend : undefined,
 subtitle: params.subtitle || '',
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'metric',
 display: `Metric "${params.label}" = ${params.value}${params.unit || ''}`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 4. SceneChoice ─────────────────────────────────────
const sceneChoice = {
 name: 'SceneChoice',
 toolset: 'scene',
 category: 'scene',
 description: '展示一个交互选择卡片，让用户从多个选项中挑选。选项点击后会通过 pushIntent 回到下一轮对话。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 question: { type: 'string', description: '问题/标题' },
 options: {
 type: 'array',
 description: '选项列表',
 items: {
 type: 'object',
 properties: {
 label: { type: 'string' },
 value: { type: 'string' },
 description: { type: 'string' },
 },
 required: ['label', 'value'],
 },
 },
 multi: { type: 'boolean', description: '是否多选', default: false },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'confront' },
 },
 required: ['id', 'question', 'options'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const options = Array.isArray(params.options) ? params.options.map(o => ({
 label: String(o.label || o.value || ''),
 value: String(o.value || o.label || ''),
 description: o.description || '',
 })) : [];
 const surface = {
 kind: 'choice',
 data: {
 question: params.question,
 options,
 multi: params.multi === true,
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'confront',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'choice',
 optionCount: options.length,
 display: `Choice "${params.id}" (${options.length} 选项)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 5. SceneImage ──────────────────────────────────────
const sceneImage = {
 name: 'SceneImage',
 toolset: 'scene',
 category: 'scene',
 description: '展示一张图片卡片。src 接受 http(s) URL 或 data: URI。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 src: { type: 'string', description: '图片 URL 或 data URI' },
 alt: { type: 'string', description: '替代文字' },
 caption: { type: 'string' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'src'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const surface = {
 kind: 'image',
 data: {
 src: params.src,
 alt: params.alt || '',
 caption: params.caption || '',
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'image',
 display: `Image "${params.id}"`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 6. SceneChart ──────────────────────────────────────
const sceneChart = {
 name: 'SceneChart',
 toolset: 'scene',
 category: 'scene',
 description: '展示数据图表。type 支持 line / bar / pie。data 格式因 type 而异。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 title: { type: 'string' },
 type: { type: 'string', enum: ['line', 'bar', 'pie'], default: 'bar' },
 labels: { type: 'array', items: { type: 'string' }, description: 'X 轴标签' },
 datasets: {
 type: 'array',
 description: '数据集 [{ label, data, color? }]',
 items: {
 type: 'object',
 properties: {
 label: { type: 'string' },
 data: { type: 'array', items: { type: 'number' } },
 color: { type: 'string' },
 },
 },
 },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'datasets'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const type = ['line', 'bar', 'pie'].includes(params.type) ? params.type : 'bar';
 const datasets = Array.isArray(params.datasets) ? params.datasets.map(d => ({
 label: String(d.label || ''),
 data: Array.isArray(d.data) ? d.data.map(v => Number(v) || 0) : [],
 color: d.color || undefined,
 })) : [];
 const surface = {
 kind: 'chart',
 data: {
 title: params.title || '',
 type,
 labels: Array.isArray(params.labels) ? params.labels.map(String) : [],
 datasets,
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'chart',
 chartType: type,
 datasetCount: datasets.length,
 display: `Chart "${params.id}" (${type}, ${datasets.length} 系列)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 7. SceneTimeline ───────────────────────────────────
const sceneTimeline = {
 name: 'SceneTimeline',
 toolset: 'scene',
 category: 'scene',
 description: '展示时间线/历史事件卡片。events 按时间倒序展示。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 title: { type: 'string' },
 events: {
 type: 'array',
 items: {
 type: 'object',
 properties: {
 timestamp: { type: 'number', description: 'Unix ms' },
 title: { type: 'string' },
 description: { type: 'string' },
 icon: { type: 'string' },
 color: { type: 'string' },
 },
 },
 },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'events'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const events = Array.isArray(params.events) ? params.events
 .map(e => ({
 timestamp: Number(e.timestamp) || Date.now(),
 title: String(e.title || ''),
 description: String(e.description || ''),
 icon: e.icon || undefined,
 color: e.color || undefined,
 }))
 .sort((a, b) => b.timestamp - a.timestamp) : [];
 const surface = {
 kind: 'timeline',
 data: { title: params.title || '', events },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 id: params.id,
 kind: 'timeline',
 eventCount: events.length,
 display: `Timeline "${params.id}" (${events.length} 事件)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 7.5 SceneFocusThread (focus_thread 投影) ─────────
const sceneFocusThread = {
 name: 'SceneFocusThread',
 toolset: 'scene',
 category: 'scene',
 description: '焦点线程面板：风格的多线索（commitment/loop）跟踪卡。threads 数组每条包含 title/status/progress/items；与 commitment-tracker 联动。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 title: { type: 'string', description: '面板标题（如"今日焦点"）' },
 threads: {
 type: 'array',
 description: '线程列表',
 items: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 title: { type: 'string' },
 status: { type: 'string', enum: ['pending', 'active', 'done', 'blocked', 'snoozed'] },
 progress: { type: 'number', minimum: 0, maximum: 100 },
 dueAt: { type: 'number' },
 items: {
 type: 'array',
 items: {
 type: 'object',
 properties: {
 label: { type: 'string' },
 done: { type: 'boolean' },
 },
 },
 },
 },
 required: ['id', 'title'],
 },
 },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'threads'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const threads = Array.isArray(params.threads) ? params.threads.map(t => ({
 id: String(t.id || ''),
 title: String(t.title || ''),
 status: ['pending', 'active', 'done', 'blocked', 'snoozed'].includes(t.status) ? t.status : 'pending',
 progress: Math.max(0, Math.min(100, Number(t.progress) || 0)),
 dueAt: t.dueAt ? Number(t.dueAt) : null,
 items: Array.isArray(t.items) ? t.items.map(it => ({
 label: String(it.label || ''),
 done: !!it.done,
 })) : [],
 })) : [];

 const surface = {
 kind: 'focus_thread',
 data: { title: params.title || '', threads },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: 'focus_thread',
 threadCount: threads.length,
 display: `FocusThread "${params.id}" (${threads.length} threads)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 8. SceneText (§6.1 核心 kind) ─────────────────────────
const sceneText = {
 name: 'SceneText',
 toolset: 'scene',
 category: 'scene',
 description: '展示一段语义文本块（标题 + 正文 + 可选脚注）。SCENE-PROTOCOL §6.1 text 核心 kind。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string', description: '卡片唯一 ID' },
 title: { type: 'string', description: '可选标题' },
 body: { type: 'string', description: '正文内容（必填）' },
 footnote: { type: 'string', description: '可选脚注' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'body'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const surface = {
 kind: 'text',
 data: {
 title: params.title || '',
 body: String(params.body || ''),
 footnote: params.footnote || '',
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: 'text',
 display: `Text "${params.id}" (${(params.body || '').length} 字)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 9. SceneMedia (§6.1 核心 kind) ─────────────────────────
const sceneMedia = {
 name: 'SceneMedia',
 toolset: 'scene',
 category: 'scene',
 description: '展示音视频（应用内媒体卡片）。用户要求播放/观看视频时使用本工具：传 B站 BV 号（bvid）自动解析直链，或传已获取的直链 url。视频在应用内面板播放，不要打开外部浏览器。SCENE-PROTOCOL §6.1 media 核心 kind。data.kind 区分 video|audio。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 kind: { type: 'string', enum: ['video', 'audio'], default: 'video' },
 url: { type: 'string', description: '音视频直链 URL（提供 bvid 时可不传）' },
 bvid: { type: 'string', description: 'B站视频 BV 号。提供后自动解析直链作为播放源，并写入视频标题（先 BilibiliSearch 搜关键词得 bvid）。' },
 title: { type: 'string' },
 poster: { type: 'string', description: '封面图（仅 video）' },
 autoplay: { type: 'boolean', default: false },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id'],
 },
 whenNotToUse: '用户未要求播放/展示音视频时勿用；url 与 bvid 均缺失或 bvid 解析失败时勿硬调用',
 handler: async (params) => {
 const store = getSceneStore();
 const mediaKind = ['video', 'audio'].includes(params.kind) ? params.kind : 'video';
 // 2026-08-16: bvid 直链解析(media-stage-tools 同款)——AI 只知 BV 号时
 // 一条调用完成: BilibiliSearch 搜到 bvid → SceneMedia(bvid) → 直链 + 标题
 let playUrl = typeof params.url === 'string' && params.url ? params.url : '';
 let resolvedTitle = typeof params.title === 'string' ? params.title : '';
 if (params.bvid && !playUrl) {
 try {
 const { getBilibiliPlayUrl } = require('../../tools/bilibili-tools');
 const video = await getBilibiliPlayUrl(String(params.bvid).trim());
 if (video && video.playUrl) {
 playUrl = video.playUrl;
 resolvedTitle = video.title || resolvedTitle;
 console.log(`🎬 [SceneMedia] bvid 直链解析成功: ${params.bvid}（${video.quality}）`);
 } else {
 console.warn(`[SceneMedia] bvid 直链解析失败: ${params.bvid}（可能需登录），使用原始参数`);
 }
 } catch (e) {
 console.warn('[SceneMedia] bvid 解析异常:', e.message || e);
 }
 }
 if (!playUrl) {
 return { success: false, error: '缺少播放源: 请提供 url 或 bvid' };
 }
 // 构造 MediaItem 格式的数据
 const item = {
 id: params.id,
 type: mediaKind === 'audio' ? 'music' : 'video',
 title: resolvedTitle,
 url: playUrl,
 thumbnail: params.poster || '',
 autoplay: params.autoplay === true,
 muted: false,
 };
 const surface = {
 kind: 'media',
 data: {
 items: [item],
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: 'media',
 mediaKind,
 display: `Media "${params.id}" (${mediaKind})`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 10. SceneForm (§6.1 可选 kind) ─────────────────────────
const sceneForm = {
 name: 'SceneForm',
 toolset: 'scene',
 category: 'scene',
 description: '收集结构化输入（多字段表单）。SCENE-PROTOCOL §6.1 form 可选 kind。提交后通过 pushIntent(name=submit) 回流。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 prompt: { type: 'string', description: '表单上方说明' },
 fields: {
 type: 'array',
 items: {
 type: 'object',
 properties: {
 name: { type: 'string' },
 label: { type: 'string' },
 type: { type: 'string', enum: ['text', 'number', 'select', 'toggle'] },
 options: { type: 'array', items: { type: 'string' } },
 default: {},
 },
 required: ['name', 'label', 'type'],
 },
 },
 submit: { type: 'string', description: '提交按钮文字', default: '提交' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'confront' },
 },
 required: ['id', 'fields'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const fields = Array.isArray(params.fields) ? params.fields.map(f => ({
 name: String(f.name || ''),
 label: String(f.label || f.name || ''),
 type: ['text', 'number', 'select', 'toggle'].includes(f.type) ? f.type : 'text',
 options: Array.isArray(f.options) ? f.options.map(String) : [],
 default: f.default !== undefined ? f.default : undefined,
 })) : [];
 const surface = {
 kind: 'form',
 data: {
 prompt: params.prompt || '',
 fields,
 submit: params.submit || '提交',
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'confront',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: 'form',
 fieldCount: fields.length,
 display: `Form "${params.id}" (${fields.length} 字段)`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 11. SceneAwakening (§6.1 领域 kind) ─────────────────────
const sceneAwakening = {
 name: 'SceneAwakening',
 toolset: 'scene',
 category: 'scene',
 description: '觉醒期探索反馈。SCENE-PROTOCOL §6.1 awakening 领域 kind。同 id 反复调用推进 index，结束时 ui_set(null) 移除。建议 intent=ambient。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 index: { type: 'number', description: '当前条数（1..total）' },
 total: { type: 'number', description: '总条数' },
 title: { type: 'string' },
 finding: { type: 'string', description: '本次发现的内容' },
 emoji: { type: 'string' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'ambient' },
 },
 required: ['id', 'index', 'total'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const surface = {
 kind: 'awakening',
 data: {
 index: Math.max(1, Number(params.index) || 1),
 total: Math.max(1, Number(params.total) || 1),
 title: String(params.title || ''),
 finding: String(params.finding || ''),
 emoji: params.emoji || '',
 },
 intent: 'ambient',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: 'awakening',
 index: surface.data.index,
 total: surface.data.total,
 display: `Awakening "${params.id}" [${surface.data.index}/${surface.data.total}]`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 12. SceneWeather (§6.1 领域 kind) ───────────────────────
const sceneWeather = {
 name: 'SceneWeather',
 toolset: 'scene',
 category: 'scene',
 description: '天气展示。SCENE-PROTOCOL §6.1 weather 领域 kind 范例。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 city: { type: 'string' },
 temp: { type: 'number', description: '当前温度' },
 condition: { type: 'string', description: '天气状况（如"晴"）' },
 forecast: {
 type: 'array',
 items: {
 type: 'object',
 properties: {
 day: { type: 'string' },
 low: { type: 'number' },
 high: { type: 'number' },
 condition: { type: 'string' },
 },
 },
 description: '未来几天预报',
 },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'ambient' },
 },
 required: ['id', 'city', 'temp'],
 },
 handler: async (params) => {
 const store = getSceneStore();
 const forecast = Array.isArray(params.forecast) ? params.forecast.map(f => ({
 day: String(f.day || ''),
 low: Number(f.low) || 0,
 high: Number(f.high) || 0,
 condition: String(f.condition || ''),
 })) : [];
 const surface = {
 kind: 'weather',
 data: {
 city: String(params.city || ''),
 temp: Number(params.temp) || 0,
 condition: String(params.condition || ''),
 forecast,
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'ambient',
 };
 const result = store.upsertSurface(params.id, surface);
 // 天气卡片 20 秒后自动移除（瞬态 surface）
 const { scheduleSceneSurfaceRemoval } = require('./transient-surfaces');
 scheduleSceneSurfaceRemoval(params.id, { kind: 'weather' });
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: 'weather',
 display: `Weather "${params.city}" = ${surface.data.temp}° ${surface.data.condition}`,
 };
 },
 isReadOnly: false,
 timeout: 3000,
};

// ── 13. SceneStack (§6.2 排版原语) ─────────────────────────
const sceneStack = {
 name: 'SceneStack',
 toolset: 'scene',
 category: 'scene',
 description: '纵向容器（stack）。SCENE-PROTOCOL §6.2 排版原语。children 是内联 surface 数组，id 在父内唯一。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 children: {
 type: 'array',
 items: { type: 'object' },
 description: '子 surface 数组（每项至少含 id）',
 },
 gap: { type: 'string', enum: ['sm', 'md', 'lg'], default: 'md' },
 align: { type: 'string', enum: ['start', 'center', 'end'], default: 'start' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'children'],
 },
 handler: async (params) => _handleLayout(params, 'stack'),
 isReadOnly: false,
 timeout: 3000,
};

// ── 14. SceneRow (§6.2 排版原语) ─────────────────────────
const sceneRow = {
 name: 'SceneRow',
 toolset: 'scene',
 category: 'scene',
 description: '横向容器（row）。SCENE-PROTOCOL §6.2 排版原语。children 是内联 surface 数组，id 在父内唯一。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 children: { type: 'array', items: { type: 'object' } },
 gap: { type: 'string', enum: ['sm', 'md', 'lg'], default: 'md' },
 align: { type: 'string', enum: ['start', 'center', 'end'], default: 'center' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'children'],
 },
 handler: async (params) => _handleLayout(params, 'row'),
 isReadOnly: false,
 timeout: 3000,
};

// ── 15. SceneCol (§6.2 排版原语) ─────────────────────────
const sceneCol = {
 name: 'SceneCol',
 toolset: 'scene',
 category: 'scene',
 description: '网格列容器（col）。SCENE-PROTOCOL §6.2 排版原语。children 是内联 surface 数组，id 在父内唯一。',
 schema: {
 type: 'object',
 properties: {
 id: { type: 'string' },
 children: { type: 'array', items: { type: 'object' } },
 gap: { type: 'string', enum: ['sm', 'md', 'lg'], default: 'md' },
 align: { type: 'string', enum: ['start', 'center', 'end'], default: 'start' },
 intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
 },
 required: ['id', 'children'],
 },
 handler: async (params) => _handleLayout(params, 'col'),
 isReadOnly: false,
 timeout: 3000,
};

/**
 * 排版原语通用 handler（stack/row/col 共用）。
 * - 校验 children 内 id 唯一
 * - 写入 SceneStore 后由前端递归渲染
 */
async function _handleLayout(params, layoutKind) {
 const store = getSceneStore();
 const children = Array.isArray(params.children) ? params.children : [];

 // 校验 id 唯一
 const seen = new Set();
 const validated = [];
 for (const c of children) {
 if (!c || typeof c !== 'object' || !c.id) continue;
 if (seen.has(c.id)) {
 console.warn(`[scene-kinds-tool] ${layoutKind}: duplicate child id "${c.id}", skipped`);
 continue;
 }
 seen.add(c.id);
 validated.push(c);
 }

 const surface = {
 kind: layoutKind,
 data: {
 children: validated,
 gap: ['sm', 'md', 'lg'].includes(params.gap) ? params.gap : 'md',
 align: ['start', 'center', 'end'].includes(params.align) ? params.align : 'start',
 },
 intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
 };
 const result = store.upsertSurface(params.id, surface);
 return {
 success: true,
 rev: result.rev,
 dataRev: result.dataRev,
 changed: result.changed,
 id: params.id,
 kind: layoutKind,
 childCount: validated.length,
 display: `${layoutKind} "${params.id}" (${validated.length} children)`,
 };
}

// ── 16. SceneMusic (§6.1 领域 kind) ───────────────────────
const sceneMusic = {
  name: 'SceneMusic',
  toolset: 'scene',
  category: 'scene',
  description: '展示音乐播放器卡片。data: { title, artist?, album?, cover?, duration?, progress?, playing? }。同 id 反复调用更新进度。',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string', description: '曲目标题' },
      artist: { type: 'string', description: '艺术家' },
      album: { type: 'string' },
      cover: { type: 'string', description: '封面 URL' },
      duration: { type: 'number', description: '总时长(秒)' },
      progress: { type: 'number', minimum: 0, maximum: 100, description: '播放进度 0-100' },
      playing: { type: 'boolean', default: true },
      volume: { type: 'number', minimum: 0, maximum: 100 },
      intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'ambient' },
    },
    required: ['id', 'title'],
  },
  handler: async (params) => {
    const store = getSceneStore();
    const surface = {
      kind: 'music',
      data: {
        title: String(params.title || ''),
        artist: params.artist || '',
        album: params.album || '',
        cover: params.cover || '',
        duration: Number(params.duration) || undefined,
        progress: Math.max(0, Math.min(100, Number(params.progress) || 0)),
        playing: params.playing !== false,
        volume: Math.max(0, Math.min(100, Number(params.volume) || 70)),
      },
      intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'ambient',
    };
    const result = store.upsertSurface(params.id, surface);
    return {
      success: true,
      rev: result.rev,
      dataRev: result.dataRev,
      changed: result.changed,
      id: params.id,
      kind: 'music',
      display: `Music "${params.title}"${params.artist ? ` - ${params.artist}` : ''}`,
    };
  },
  isReadOnly: false,
  timeout: 3000,
};

// ── 17. SceneMeetingRecording (§6.1 领域 kind) ───────────
const sceneMeetingRecording = {
  name: 'SceneMeetingRecording',
  toolset: 'scene',
  category: 'scene',
  description: '展示会议录音/纪要卡片。data: { title, status, duration?, speakerCount?, summary?, keywords? }。随录制/转写/摘要进度更新 status。',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string', enum: ['recording', 'transcribing', 'summarizing', 'done'] },
      duration: { type: 'number', description: '秒' },
      speakerCount: { type: 'number' },
      summary: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
    },
    required: ['id', 'title', 'status'],
  },
  handler: async (params) => {
    const store = getSceneStore();
    const surface = {
      kind: 'meeting_recording',
      data: {
        title: String(params.title || ''),
        status: ['recording', 'transcribing', 'summarizing', 'done'].includes(params.status) ? params.status : 'recording',
        duration: params.duration !== undefined ? Number(params.duration) : undefined,
        speakerCount: params.speakerCount !== undefined ? Number(params.speakerCount) : undefined,
        summary: params.summary || undefined,
        keywords: Array.isArray(params.keywords) ? params.keywords : undefined,
      },
      intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
    };
    const result = store.upsertSurface(params.id, surface);
    return {
      success: true,
      rev: result.rev,
      dataRev: result.dataRev,
      changed: result.changed,
      id: params.id,
      kind: 'meeting_recording',
      status: surface.data.status,
      display: `Meeting "${params.title}" (${surface.data.status})`,
    };
  },
  isReadOnly: false,
  timeout: 3000,
};

// ── 18. SceneKanban (§6.1 领域 kind) ─────────────────────
const sceneKanban = {
  name: 'SceneKanban',
  toolset: 'scene',
  category: 'scene',
  description: '展示看板组件。data: { title, columns: [{ id, title, cards: [{ id, title, tags?, dueAt? }] }] }。适合任务/技能/需求管理。',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string', description: '看板标题' },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            cards: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  dueAt: { type: 'number' },
                  color: { type: 'string' },
                },
                required: ['id', 'title'],
              },
            },
          },
          required: ['id', 'title'],
        },
      },
      intent: { type: 'string', enum: ['ambient', 'inform', 'confront'], default: 'inform' },
    },
    required: ['id', 'columns'],
  },
  handler: async (params) => {
    const store = getSceneStore();
    const columns = Array.isArray(params.columns) ? params.columns.map(col => ({
      id: String(col.id || ''),
      title: String(col.title || ''),
      cards: Array.isArray(col.cards) ? col.cards.map(card => ({
        id: String(card.id || ''),
        title: String(card.title || ''),
        tags: Array.isArray(card.tags) ? card.tags.map(String) : [],
        dueAt: card.dueAt || undefined,
        color: card.color || undefined,
      })) : [],
    })) : [];
    const surface = {
      kind: 'kanban',
      data: { title: params.title || '', columns },
      intent: ['ambient', 'inform', 'confront'].includes(params.intent) ? params.intent : 'inform',
    };
    const result = store.upsertSurface(params.id, surface);
    return {
      success: true,
      rev: result.rev,
      dataRev: result.dataRev,
      changed: result.changed,
      id: params.id,
      kind: 'kanban',
      columnCount: columns.length,
      cardCount: columns.reduce((sum, c) => sum + (c.cards?.length || 0), 0),
      display: `Kanban "${params.id}" (${columns.length} cols, ${columns.reduce((sum, c) => sum + (c.cards?.length || 0), 0)} cards)`,
    };
  },
  isReadOnly: false,
  timeout: 3000,
};

// ── Registration ───────────────────────────────────────
function registerSceneKindTools(registry) {
  if (!registry || typeof registry.register !== 'function') {
    console.warn('[scene-kinds-tool] Invalid registry');
    return 0;
  }
  const tools = [
    sceneProgress, sceneSelfCheck, sceneMetric, sceneChoice, sceneImage, sceneChart, sceneTimeline,
    sceneFocusThread,
    sceneText, sceneMedia, sceneForm, sceneAwakening, sceneWeather,
    sceneStack, sceneRow, sceneCol,
    sceneMusic, sceneMeetingRecording, sceneKanban,
  ];
  for (const t of tools) {
    registry.register(t);
  }
  console.log(`🎬 scene-kinds 工具已注册 (${tools.length} 个: 8 自有 + 5 PROTOCOL + 3 排版 + 3 领域)`);
  return tools.length;
}

try {
 const { registry } = require('../../tools/registry');
 if (registry) registerSceneKindTools(registry);
} catch (e) {

  // Registry not available yet

  console.warn('[scene-kinds-tool.js] 空 catch 补日志:', e && e.message);
}


module.exports = {
  sceneProgress,
  sceneSelfCheck,
  sceneMetric,
  sceneChoice,
  sceneImage,
  sceneChart,
  sceneTimeline,
  sceneFocusThread,
  sceneText,
  sceneMedia,
  sceneForm,
  sceneAwakening,
  sceneWeather,
  sceneStack,
  sceneRow,
  sceneCol,
  sceneMusic,
  sceneMeetingRecording,
  sceneKanban,
  registerSceneKindTools,
};
