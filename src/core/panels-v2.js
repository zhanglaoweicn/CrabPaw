'use strict';

/**
 * panels-v2.js — 风格信息面板数据源
 *
 * 提供 7 个面板的数据获取 + 渲染：
 * 1. Hotspot — 热点趋势（增强版，含多平台聚合）
 * 2. WorldCup — 体育赛事（赛程/积分/比分）
 * 3. PersonCard — 人物卡片（基本信息 + 关联记忆 + 联系方式）
 * 4. Doc — 文档面板（关键信息 + 摘要）
 * 5. FocusBanner — 焦点横幅（重要通知/告警/进度）
 * 6. Terminal — 终端流（实时日志/命令输出捕获）
 * 7. VoiceRetire — 语音退休（语音会话结束后的总结/交接）
 *
 * 设计原则：
 * - 每个面板独立函数，单测友好
 * - 数据获取失败时返回 mock 数据，保证 UI 不断
 * - 渲染格式：text（终端表格）/ compact（单行）/ scene（scene 卡片数据）
 */


const { broadcastEvent } = require('./sse-broadcast');

// ---------------------------------------------------------------------------
// 1. Hotspot（增强版）
// ---------------------------------------------------------------------------

const HOTSPOT_SOURCES = {
 weibo: { name: '微博热搜', icon: '🔥' },
 zhihu: { name: '知乎热榜', icon: '💡' },
 baidu: { name: '百度热搜', icon: '🔍' },
 douyin: { name: '抖音热点', icon: '🎵' },
 bilibili: { name: 'B站热门', icon: '📺' },
};

async function getHotspotData(platform = 'weibo', options = {}) {
 try {
 const { globalHotspotPanel } = require('./panels/hotspot');
 return await globalHotspotPanel.getHotspot(platform, options);
 } catch (e) {
 // mock 兜底
 return {
 platform,
 platformName: HOTSPOT_SOURCES[platform]?.name || platform,
 icon: HOTSPOT_SOURCES[platform]?.icon || '📰',
 items: [
 { rank: 1, title: `热门话题 ${platform} #1`, heat: 9850000 },
 { rank: 2, title: `热门话题 ${platform} #2`, heat: 7620000 },
 { rank: 3, title: `热门话题 ${platform} #3`, heat: 5430000 },
 ],
 mock: true,
 error: e.message,
 timestamp: Date.now(),
 };
 }
}

function renderHotspot(data, format = 'text') {
 if (format === 'compact') {
 return `${data.icon} ${data.platformName}: ${(data.items || []).slice(0, 3).map(i => i.title).join(' | ')}`;
 }
 if (format === 'scene') {
 return {
 kind: 'hotspot',
 title: `${data.icon} ${data.platformName}`,
 items: (data.items || []).slice(0, 20).map(i => ({
 rank: i.rank,
 title: i.title,
 heat: i.heat,
 url: i.url,
 })),
 mock: !!data.mock,
 };
 }
 const lines = [`${data.icon} ${data.platformName}`];
 for (const it of (data.items || []).slice(0, 20)) {
 const heat = it.heat ? ` [${(it.heat / 10000).toFixed(0)}万]` : '';
 lines.push(` ${String(it.rank).padStart(2)}. ${it.title}${heat}`);
 }
 return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 2. WorldCup（体育赛事）
// ---------------------------------------------------------------------------

const SPORT_TYPES = {
 football: '足球',
 basketball: '篮球',
 tennis: '网球',
 esports: '电竞',
};

async function getWorldCupData(options = {}) {
 const sport = options.sport || 'football';
 // 占位数据源（实际接入需对接具体 API）
 return {
 sport,
 sportName: SPORT_TYPES[sport] || sport,
 events: [
 {
 id: 'evt1',
 home: '皇家马德里',
 away: '巴塞罗那',
 score: '2-1',
 status: 'live',
 time: '78\'',
 league: '西甲',
 startTime: Date.now() - 78 * 60 * 1000,
 },
 {
 id: 'evt2',
 home: '曼城',
 away: '阿森纳',
 score: '0-0',
 status: 'upcoming',
 time: '',
 league: '英超',
 startTime: Date.now() + 3 * 60 * 60 * 1000,
 },
 {
 id: 'evt3',
 home: '拜仁慕尼黑',
 away: '多特蒙德',
 score: '3-2',
 status: 'finished',
 time: 'FT',
 league: '德甲',
 startTime: Date.now() - 4 * 60 * 60 * 1000,
 },
 ],
 standings: [
 { rank: 1, team: '曼城', played: 30, won: 22, drawn: 5, lost: 3, points: 71 },
 { rank: 2, team: '阿森纳', played: 30, won: 21, drawn: 5, lost: 4, points: 68 },
 { rank: 3, team: '利物浦', played: 30, won: 19, drawn: 6, lost: 5, points: 63 },
 ],
 timestamp: Date.now(),
 note: '示例数据 — 实际接入需对接体育数据 API',
 };
}

function renderWorldCup(data, format = 'text') {
 if (format === 'scene') {
 return {
 kind: 'worldcup',
 title: `⚽ ${data.sportName}`,
 events: (data.events || []).map(e => ({
 id: e.id,
 home: e.home,
 away: e.away,
 score: e.score,
 status: e.status,
 time: e.time,
 league: e.league,
 })),
 standings: data.standings,
 };
 }
 const lines = [`⚽ ${data.sportName} 赛事`];
 lines.push('');
 lines.push('【进行中 / 即将开始】');
 for (const e of (data.events || []).filter(x => x.status !== 'finished')) {
 lines.push(` ${e.league} | ${e.home} vs ${e.away} ${e.score || '-'}${e.time ? ' (' + e.time + ')' : ''} [${e.status}]`);
 }
 if (data.standings && data.standings.length > 0) {
 lines.push('');
 lines.push('【积分榜 Top 3】');
 for (const s of data.standings) {
 lines.push(` ${s.rank}. ${s.team} ${s.played}场 ${s.won}胜${s.drawn}平${s.lost}负 = ${s.points}分`);
 }
 }
 return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 3. PersonCard（人物卡片）
// ---------------------------------------------------------------------------

async function getPersonCardData(name, options = {}) {
 // 从记忆系统中查找该人物的关联信息
 const related = [];
 let contact = null;
 try {
 const { memoryManager: mgr } = require('./memory-system');
 if (mgr && mgr.search) {
 const results = await mgr.search(name, { limit: 5 });
 for (const r of results || []) {
 related.push({
 source: 'memory',
 summary: r.summary || r.content?.slice(0, 100) || '',
 timestamp: r.timestamp || r.createdAt,
 });
 }
 }
 } catch (e) {
   /* ignore */
   console.warn('[panels-v2.js] 空 catch 补日志:', e && e.message);
 }

 return {
 name,
 title: options.title || null,
 role: options.role || null,
 company: options.company || null,
 contact: contact || { email: null, phone: null, wechat: null },
 related,
 avatar: null,
 timestamp: Date.now(),
 };
}

function renderPersonCard(data, format = 'text') {
 if (format === 'scene') {
 return {
 kind: 'person_card',
 title: `👤 ${data.name}`,
 name: data.name,
 jobTitle: data.title,
 role: data.role,
 company: data.company,
 contact: data.contact,
 related: (data.related || []).slice(0, 5),
 };
 }
 const lines = [`👤 ${data.name}`];
 if (data.title) lines.push(` 职位: ${data.title}`);
 if (data.company) lines.push(` 公司: ${data.company}`);
 if (data.role) lines.push(` 角色: ${data.role}`);
 if (data.contact && Object.values(data.contact).some(v => v)) {
 lines.push(` 联系方式: ${Object.entries(data.contact).filter(([_, v]) => v).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
 }
 if (data.related && data.related.length > 0) {
 lines.push('');
 lines.push('【相关记忆】');
 for (const r of data.related.slice(0, 5)) {
 lines.push(` · ${r.summary}`);
 }
 }
 return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 4. Doc（文档面板）
// ---------------------------------------------------------------------------

async function getDocData(docId, options = {}) {
 // 模拟：实际应该从 Lark/Notion/本地文件获取
 return {
 docId,
 title: options.title || '文档 ' + docId,
 summary: options.summary || '这是一个文档的简要摘要...',
 sections: options.sections || [
 { heading: '概述', content: '文档的主要内容和目的说明。' },
 { heading: '关键要点', content: '1. 要点一\n2. 要点二\n3. 要点三' },
 { heading: '结论', content: '总结和后续行动。' },
 ],
 metadata: {
 author: options.author || null,
 updatedAt: options.updatedAt || Date.now(),
 wordCount: options.wordCount || 0,
 },
 };
}

function renderDoc(data, format = 'text') {
 if (format === 'scene') {
 return {
 kind: 'doc',
 title: `📄 ${data.title}`,
 docId: data.docId,
 summary: data.summary,
 sections: data.sections,
 metadata: data.metadata,
 };
 }
 const lines = [`📄 ${data.title}`];
 if (data.metadata?.author) lines.push(` 作者: ${data.metadata.author}`);
 if (data.metadata?.wordCount) lines.push(` 字数: ${data.metadata.wordCount}`);
 lines.push('');
 lines.push(data.summary);
 lines.push('');
 for (const sec of (data.sections || [])) {
 lines.push(`## ${sec.heading}`);
 lines.push(sec.content);
 lines.push('');
 }
 return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 5. FocusBanner（焦点横幅）
// ---------------------------------------------------------------------------

const BANNER_LEVELS = {
 info: { icon: 'ℹ️', color: 'blue' },
 success: { icon: '✅', color: 'green' },
 warning: { icon: '⚠️', color: 'yellow' },
 error: { icon: '❌', color: 'red' },
 alert: { icon: '🚨', color: 'red' },
};

async function pushFocusBanner(options = {}) {
 const level = options.level || 'info';
 const banner = {
 id: `banner_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
 level,
 icon: BANNER_LEVELS[level]?.icon || 'ℹ️',
 color: BANNER_LEVELS[level]?.color || 'gray',
 title: options.title || '',
 message: options.message || '',
 actions: options.actions || [],
 timestamp: Date.now(),
 ttlMs: options.ttlMs || 0,
 };

 // 通过 SSE 广播
 broadcastEvent('focus_banner', banner);

 // 推 scene 卡片
 try {
 const { getSceneStore } = require('./scene/scene-store');
 const store = getSceneStore();
 const cardId = `focus_banner_${banner.id}`;
 store.setSurface(cardId, {
 kind: 'focus_banner',
 intent: 'confront',
 data: banner,
 });
 if (banner.ttlMs > 0) {
 setTimeout(() => {
 try { store.setSurface(cardId, null); } catch (e) {
   /* ignore */
   console.warn('[panels-v2.js] 空 catch 补日志:', e && e.message);
 }
 }, banner.ttlMs);
 }
 } catch (e) {
   /* ignore */
   console.warn('[panels-v2.js] 空 catch 补日志:', e && e.message);
 }

 return banner;
}

function renderFocusBanner(data, format = 'text') {
 if (format === 'scene') return { kind: 'focus_banner', ...data };
 return `${data.icon} ${data.title}\n ${data.message}`;
}

// ---------------------------------------------------------------------------
// 6. TerminalStream（终端流）
// ---------------------------------------------------------------------------

class TerminalStream {
 constructor(options = {}) {
 this._buffer = []; // 最近的输出行
 this._maxLines = options.maxLines || 200;
 this._subscribers = new Set();
 }

 push(line, meta = {}) {
 const entry = {
 ts: Date.now(),
 stream: meta.stream || 'stdout',
 level: meta.level || 'info',
 line: typeof line === 'string' ? line : JSON.stringify(line),
 };
 this._buffer.push(entry);
 if (this._buffer.length > this._maxLines) {
 this._buffer.shift();
 }
 // 广播给订阅者
 broadcastEvent('terminal_stream', entry);
 for (const fn of this._subscribers) {
 try { fn(entry); } catch (e) {
   /* ignore */
   console.warn('[panels-v2.js] 空 catch 补日志:', e && e.message);
 }
 }
 }

 pushBatch(lines, meta = {}) {
 for (const line of lines) this.push(line, meta);
 }

 clear() {
 this._buffer = [];
 }

 recent(n = 50) {
 return this._buffer.slice(-n);
 }

 subscribe(fn) {
 this._subscribers.add(fn);
 return () => this._subscribers.delete(fn);
 }

 render(options = {}) {
 const n = options.lines || 30;
 const entries = this.recent(n);
 const lines = [];
 for (const e of entries) {
 const ts = new Date(e.ts).toLocaleTimeString();
 const level = e.level === 'error' ? '❌' : e.level === 'warn' ? '⚠️' : ' ';
 lines.push(`[${ts}] ${level} ${e.line}`);
 }
 return {
 kind: 'terminal_stream',
 total: this._buffer.length,
 lines,
 };
 }
}

let _terminalStream = null;
function getTerminalStream() {
 if (!_terminalStream) _terminalStream = new TerminalStream();
 return _terminalStream;
}

// ---------------------------------------------------------------------------
// 7. VoiceRetire（语音退休总结）
// ---------------------------------------------------------------------------

async function getVoiceRetireData(sessionId, options = {}) {
 // 汇总语音会话的统计
 let summary = {
 sessionId,
 duration: options.duration || 0,
 turns: options.turns || 0,
 asrChars: options.asrChars || 0,
 ttsChars: options.ttsChars || 0,
 reconnects: options.reconnects || 0,
 errors: options.errors || 0,
 };

 // 2026-08-14: 删除 voice-session 死调用——voiceSession.getSessionMetrics 并不存在
 // (VoiceSessionManager 无此方法),旧代码每次进来都抛 TypeError 被空 catch 吞掉。
 // 前端已有完整 watchdog 状态机负责会话统计,后端不再维护该快照。

 // 生成退休建议
 const tips = [];
 if (summary.reconnects > 3) tips.push('本次语音会话重连次数较多，建议检查网络稳定性。');
 if (summary.asrChars === 0) tips.push('没有识别到语音输入。');
 if (summary.ttsChars === 0) tips.push('没有语音回复输出。');
 if (summary.errors > 0) tips.push(`遇到 ${summary.errors} 次错误。`);
 if (tips.length === 0) tips.push('会话顺利完成。');

 return {
 ...summary,
 tips,
 farewell: '下次再见！',
 timestamp: Date.now(),
 };
}

function renderVoiceRetire(data, format = 'text') {
 if (format === 'scene') {
 return {
 kind: 'voice_retire',
 title: '🎙️ 语音会话结束',
 duration: data.duration,
 turns: data.turns,
 asrChars: data.asrChars,
 ttsChars: data.ttsChars,
 reconnects: data.reconnects,
 tips: data.tips,
 farewell: data.farewell,
 };
 }
 const lines = ['🎙️ 语音会话总结'];
 lines.push(` 时长: ${(data.duration / 1000).toFixed(1)}s`);
 lines.push(` 回合: ${data.turns}`);
 lines.push(` ASR 识别: ${data.asrChars} 字`);
 lines.push(` TTS 合成: ${data.ttsChars} 字`);
 lines.push(` 重连: ${data.reconnects} 次`);
 if (data.tips && data.tips.length > 0) {
 lines.push('');
 lines.push('提示:');
 for (const t of data.tips) lines.push(` · ${t}`);
 }
 lines.push('');
 lines.push(data.farewell || '');
 return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
 // 数据获取
 getHotspotData,
 getWorldCupData,
 getPersonCardData,
 getDocData,
 pushFocusBanner,
 getTerminalStream,
 getVoiceRetireData,
 // 渲染
 renderHotspot,
 renderWorldCup,
 renderPersonCard,
 renderDoc,
 renderFocusBanner,
 renderVoiceRetire,
 // 元数据
 HOTSPOT_SOURCES,
 SPORT_TYPES,
 BANNER_LEVELS,
};
