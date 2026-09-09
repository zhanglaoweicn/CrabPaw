'use strict';

/**
 * self-awareness.js — 自我感知系统
 *
 * 设计参考 自我意识层:
 * - 自我感知 (perception): 当前能用的工具/技能/agents
 * - 自我进化 (evolution): 学到的东西、生成的技能、成功率
 * - 自我知识 (knowledge): 身份/版本/能力/限制
 *
 * 公开 API:
 * - getSelfAwareness() → 单例
 * - awareness.perceive() → 完整自我画像
 * - awareness.perceiveLite() → 轻量画像（注入 prompt）
 * - awareness.on('change', fn) → 监听变化
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// 技能感知缓存（60s TTL）— 避免高频 perceive 全量重扫技能目录
const SKILLS_CACHE_TTL = 60000;
let _skillsCache = null;
let _skillsCacheTime = 0;

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

class SelfAwareness extends EventEmitter {
 constructor() {
 super();
 this._cache = null;
 this._cacheTime = 0;
 this._cacheTtlMs = 60 * 1000; // 60s
 }

 invalidate() {
 this._cache = null;
 this._cacheTime = 0;
 this.emit('change');
 }

 /**
 * 完整自我画像
 */
 async perceive(options = {}) {
 if (!options.force && this._cache && Date.now() - this._cacheTime < this._cacheTtlMs) {
 return this._cache;
 }

 const profile = {
 timestamp: Date.now(),
 knowledge: await this._perceiveKnowledge(),
 perception: await this._perceivePerception(),
 evolution: await this._perceiveEvolution(),
 };

 this._cache = profile;
 this._cacheTime = Date.now();
 return profile;
 }

 /**
 * 轻量画像（适合注入 prompt）
 */
 async perceiveLite() {
 const p = await this.perceive();
 return formatForPrompt(p);
 }

 // ── 自我知识：身份、版本、能力边界 ────────────────────
 async _perceiveKnowledge() {
 const knowledge = {
 name: 'CrabPaw',
 description: '多通道 AI 助手平台',
 version: this._readVersion(),
 identities: [],
 capabilities: [],
 limitations: [],
 };

 // 读取 package.json
 try {
 const pkgPath = path.join(__dirname, '..', '..', 'package.json');
 const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
 knowledge.version = pkg.version || knowledge.version;
 knowledge.description = pkg.description || knowledge.description;
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // 读取 IDENTITY.md
 try {
 const identityPath = path.join(__dirname, '..', '..', 'workspace', 'IDENTITY.md');
 if (fs.existsSync(identityPath)) {
 const text = fs.readFileSync(identityPath, 'utf-8');
 const m = text.match(/^# (.+)/m);
 if (m) knowledge.identities.push(m[1].trim());
 }
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // 列举核心能力（来自 config）
 try {
 const config = require('./config');
 const cfg = (config.configManager && typeof config.configManager.get === 'function'
 ? (() => { try { return config.configManager.get(''); } catch (e) { return null; } })()
 : null) || (config.getConfig ? config.getConfig() : null) || (config.config && typeof config.config === 'object' ? config.config : null) || {};
 if (cfg && cfg.capabilities && Array.isArray(cfg.capabilities) && cfg.capabilities.length >= 4) {
 knowledge.capabilities = cfg.capabilities;
 } else {
 knowledge.capabilities = [
 '工具调用（100+ 工具）',
 '多通道接入（飞书/企微/Web/CLI）',
 '记忆与上下文管理',
 '技能系统与工作流',
 '子智能体委派',
 '本地 Agent 委派',
 '持久化 Shell',
 '软件安装/卸载（winget）',
 '自我感知与自我进化',
 ];
 }
 } catch (e) {
 knowledge.capabilities = [
 '工具调用（100+ 工具）',
 '多通道接入（飞书/企微/Web/CLI）',
 '记忆与上下文管理',
 '技能系统与工作流',
 '子智能体委派',
 '本地 Agent 委派',
 '持久化 Shell',
 '软件安装/卸载（winget）',
 '自我感知与自我进化',
 ];
 }

 // 已知限制
 knowledge.limitations = [
 '无法直接访问外部网络（需通过 WebSearch/WebFetch 工具）',
 '工具调用受权限和安全策略约束',
 '某些操作需要用户显式确认',
 ];

 return knowledge;
 }

 // ── 自我感知：当前可用资源 ─────────────────────────────
 async _perceivePerception() {
 const perception = {
 tools: { total: 0, byToolset: {} },
 skills: { total: 0, names: [] },
 agents: { total: 0, byTier: {} },
 channels: [],
 currentState: 'idle',
 };

 // 工具
 try {
 const { registry } = require('../../tools/registry');
 const stats = registry.getStats?.() || {};
 perception.tools.total = stats.totalTools || 0;
 const tools = registry.getAll?.() || [];
 for (const t of tools) {
 const ts = t.toolset || 'default';
 perception.tools.byToolset[ts] = (perception.tools.byToolset[ts] || 0) + 1;
 }
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // 技能
 try {
 // BUG FIX: 此前从 skill/index.js 解构不存在的 getAllSkills/listSkills（恒 undefined），
 // 技能感知恒为 0。改用 skills.js 的真实加载入口，并加 60s 缓存
 // （避免 100x 压测等高频 perceive 场景全量重扫 87 个技能目录）。
 const { loadSkills } = require('./skills');
 let all = _skillsCache;
 const now = Date.now();
 if (!all || now - _skillsCacheTime > SKILLS_CACHE_TTL) {
   all = loadSkills();
   _skillsCache = all;
   _skillsCacheTime = now;
 }
 perception.skills.total = Array.isArray(all) ? all.length : 0;
 perception.skills.names = all.slice(0, 30).map(s => s.name || s.id);
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // Agents
 try {
 const { getAgentRegistry } = require('./agent/agent-registry');
 const reg = getAgentRegistry();
 const all = reg.listSpawnable?.() || [];
 perception.agents.total = all.length;
 for (const a of all) {
 const tier = a.tier || 'worker';
 perception.agents.byTier[tier] = (perception.agents.byTier[tier] || 0) + 1;
 }
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // 渠道
 try {
 const { channelRegistry } = require('./channel-registry');
 const list = channelRegistry.list?.() || [];
 perception.channels = list.map(c => c.name || c.id);
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // 当前活动状态
 try {
 const { globalActivityState } = require('./activity-state');
 perception.currentState = globalActivityState.state || 'idle';
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 return perception;
 }

 // ── 自我进化：学习轨迹 ───────────────────────────────
 async _perceiveEvolution() {
   const evolution = {
   generatedSkills: [],
   successfulPatterns: 0,
   failedPatterns: 0,
   toolUsage: {},
   lastReview: null,
   };
   // 生成的技能
   try {
   const fs2 = require('fs');
   const skillsDir = path.join(__dirname, '..', '..', 'skills');
   if (fs2.existsSync(skillsDir)) {
   const dirs = fs2.readdirSync(skillsDir).filter(d => {
   try { return fs2.statSync(path.join(skillsDir, d)).isDirectory(); } catch (e) { return false; }
   });
   evolution.generatedSkills = dirs.slice(0, 30);
   }
   } catch (e) {
     /* ignore */
     console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
   }


 // 工具使用统计
 try {
 const telemetry = require('./skill/skill-usage-telemetry');
 if (telemetry && telemetry.getStats) {
 const stats = telemetry.getStats();
 evolution.toolUsage = stats.tools || {};
 evolution.successfulPatterns = stats.totalSuccess || 0;
 evolution.failedPatterns = stats.totalFailure || 0;
 }
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 // 上次 review
 try {
 const review = require('./learning/post-turn-review');
 if (review && review.getLastReview) {
 evolution.lastReview = review.getLastReview();
 }
 } catch (e) {
   /* ignore */
   console.warn('[self-awareness.js] 空 catch 补日志:', e && e.message);
 }

 return evolution;
 }

 // ── 工具 ─────────────────────────────────────
 _readVersion() {
 try {
 const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
 return pkg.version || 'unknown';
 } catch (e) { return 'unknown'; }
 }
}

// ---------------------------------------------------------------------------
// 格式化输出
// ---------------------------------------------------------------------------

function formatForPrompt(profile) {
 const lines = [];
 lines.push(`<self_awareness>`);
 lines.push(`Name: ${profile.knowledge.name} v${profile.knowledge.version}`);
 lines.push(`Description: ${profile.knowledge.description}`);

 if (profile.knowledge.capabilities.length > 0) {
 lines.push(`Capabilities: ${profile.knowledge.capabilities.join(', ')}`);
 }

 const p = profile.perception;
 lines.push(`Resources: ${p.tools.total} tools, ${p.skills.total} skills, ${p.agents.total} agents, channels=${p.channels.join('/')}`);
 lines.push(`Current state: ${p.currentState}`);

 const e = profile.evolution;
 if (e.successfulPatterns || e.failedPatterns) {
 lines.push(`Evolution: ${e.successfulPatterns} success, ${e.failedPatterns} failure, ${e.generatedSkills.length} generated skills`);
 }
 if (e.lastReview) {
 lines.push(`Last review: ${new Date(e.lastReview.timestamp || e.lastReview).toLocaleString()}`);
 }

 lines.push(`</self_awareness>`);
 return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

let _instance = null;
function getSelfAwareness() {
 if (!_instance) _instance = new SelfAwareness();
 return _instance;
}

module.exports = {
 SelfAwareness,
 getSelfAwareness,
 formatForPrompt,
};
