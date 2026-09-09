'use strict';

/**
 * memory-audit.js — 记忆审计系统
 *
 * 设计参考 的 memory audit：
 * 1. recall: 检索相关记忆（关键词/概念/时间/重要性）
 * 2. extract: 从文本提取可入记忆的实体/事实
 * 3. audit: 审计记忆健康度（重复/冲突/过期/孤岛）
 * 4. summarize: 生成记忆摘要报告
 *
 * 与 EnhancedMemorySystem 协作：
 * - 使用 concept-extractor 提取概念指纹
 * - 使用 time-parser 解析时间引用
 * - 使用 UnifiedMemoryStore / GlobalMemoryStore 作为底层
 *
 * 公开 API:
 * - getMemoryAuditor() → 单例
 * - auditor.recall(query, options)
 * - auditor.extract(text, options)
 * - auditor.audit(options)
 * - auditor.summarize(scope)
 */

const { getConceptExtractor, buildFingerprint: _buildFingerprint } = require('./concept-extractor');
const { parseTime, parseChineseNumber: _parseChineseNumber } = require('./time-parser');

// ── 重要性等级 ──────────────────────────────────
const IMPORTANCE = {
 CRITICAL: 'critical', // 5
 HIGH: 'high', // 4
 MEDIUM: 'medium', // 3
 LOW: 'low', // 2
 TRIVIAL: 'trivial', // 1
};

// ── 记忆分类 ──────────────────────────────────
const MEMORY_TYPES = {
 FACT: 'fact', // 客观事实
 PREFERENCE: 'preference', // 偏好
 INSTRUCTION: 'instruction', // 指令/规则
 EVENT: 'event', // 事件
 ENTITY: 'entity', // 实体（人/物/工具）
 CONVERSATION: 'conversation', // 对话片段
 TODO: 'todo', // 待办
};

// ── 抽取启发式（轻量 LLM 替代） ──────────────────────

const PREFERENCE_KEYWORDS = ['喜欢', '不喜欢', '偏好', '想要', '不要', '需要', '习惯'];
const INSTRUCTION_KEYWORDS = ['请', '必须', '不要', '应该', '记得', '务必', '记得', '不要忘了', '记住', '记得'];
const EVENT_KEYWORDS = ['今天', '昨天', '明天', '发生', '完成', '做了', '发现'];
const TODO_KEYWORDS = ['待办', 'TODO', 'todo', '需要做', '记得做', '记得', '要', '别忘了'];

/**
 * 启发式分类：基于关键词判断
 */
function classifyMemory(text) {
 if (!text) return MEMORY_TYPES.FACT;
 const lower = text.toLowerCase();
 if (TODO_KEYWORDS.some(k => text.includes(k) || lower.includes(k.toLowerCase()))) return MEMORY_TYPES.TODO;
 if (INSTRUCTION_KEYWORDS.some(k => text.includes(k))) return MEMORY_TYPES.INSTRUCTION;
 if (PREFERENCE_KEYWORDS.some(k => text.includes(k))) return MEMORY_TYPES.PREFERENCE;
 if (EVENT_KEYWORDS.some(k => text.includes(k))) return MEMORY_TYPES.EVENT;
 return MEMORY_TYPES.FACT;
}

/**
 * 估算重要性（基于特征）
 */
function estimateImportance(text, type) {
 if (!text) return IMPORTANCE.LOW;
 let score = 3;
 if (type === MEMORY_TYPES.INSTRUCTION || type === MEMORY_TYPES.PREFERENCE) score += 1;
 if (type === MEMORY_TYPES.TODO) score += 1;
 if (type === MEMORY_TYPES.TRIVIAL) score -= 1;
 // 含 URL/邮箱/数字 → 客观信息
 if (/https?:\/\//.test(text) || /[\w._%+-]+@[\w.-]+/.test(text)) score += 1;
 // 含强烈情感词
 if (/紧急|重要|必须|务必|critical|urgent|important/i.test(text)) score += 1;
 if (score >= 5) return IMPORTANCE.CRITICAL;
 if (score >= 4) return IMPORTANCE.HIGH;
 if (score >= 3) return IMPORTANCE.MEDIUM;
 if (score >= 2) return IMPORTANCE.LOW;
 return IMPORTANCE.TRIVIAL;
}

/**
 * 简易句子切分（中英混合）
 */
function splitSentences(text) {
 if (!text) return [];
 // 中文句号/问号/感叹号 + 英文 .?!
 return text.split(/(?<=[。！？!?；;])|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

// ── MemoryEntry ──────────────────────────────────
class MemoryEntry {
 constructor(data) {
 this.id = data.id || `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
 this.text = data.text;
 this.type = data.type || MEMORY_TYPES.FACT;
 this.importance = data.importance || IMPORTANCE.MEDIUM;
 this.tags = data.tags || [];
 this.concepts = data.concepts || null;
 this.time = data.time || null;
 this.createdAt = data.createdAt || Date.now();
 this.updatedAt = data.updatedAt || Date.now();
 this.source = data.source || 'audit';
 this.metadata = data.metadata || {};
 }

 toJSON() {
 return {
 id: this.id,
 text: this.text,
 type: this.type,
 importance: this.importance,
 tags: this.tags,
 concepts: this.concepts,
 time: this.time,
 createdAt: this.createdAt,
 updatedAt: this.updatedAt,
 source: this.source,
 metadata: this.metadata,
 };
 }
}

// ── MemoryAuditor ──────────────────────────────────
class MemoryAuditor {
 // eslint-disable-next-line no-unused-vars
 constructor(options = {}) {
 this._store = new Map(); // id → MemoryEntry
 this._byHash = new Map(); // hash → [id] (用于去重)
 this._byType = new Map(); // type → [id]
 this._byTag = new Map(); // tag → [id]
 }

 /**
 * 添加记忆
 */
 add(entry) {
 if (!entry || !entry.text) return null;
 const e = entry instanceof MemoryEntry ? entry : new MemoryEntry(entry);
 this._store.set(e.id, e);
 // 索引
 if (e.concepts?.hash) {
 if (!this._byHash.has(e.concepts.hash)) this._byHash.set(e.concepts.hash, []);
 this._byHash.get(e.concepts.hash).push(e.id);
 }
 if (!this._byType.has(e.type)) this._byType.set(e.type, []);
 this._byType.get(e.type).push(e.id);
 for (const tag of e.tags) {
 if (!this._byTag.has(tag)) this._byTag.set(tag, []);
 this._byTag.get(tag).push(e.id);
 }
 return e;
 }

 /**
 * 删除
 */
 remove(id) {
 const e = this._store.get(id);
 if (!e) return false;
 this._store.delete(id);
 if (e.concepts?.hash) {
 const list = this._byHash.get(e.concepts.hash) || [];
 const idx = list.indexOf(id);
 if (idx >= 0) list.splice(idx, 1);
 }
 const tlist = this._byType.get(e.type) || [];
 const tidx = tlist.indexOf(id);
 if (tidx >= 0) tlist.splice(tidx, 1);
 for (const tag of e.tags) {
 const alist = this._byTag.get(tag) || [];
 const aidx = alist.indexOf(id);
 if (aidx >= 0) alist.splice(aidx, 1);
 }
 return true;
 }

 /**
 * 检索：基于概念指纹 + 关键词匹配
 * @param {string} query
 * @param {object} [options] { type?, tag?, minImportance?, limit? }
 */
 recall(query, options = {}) {
 if (!query) return [];
 const ext = getConceptExtractor();
 const qfp = ext.extract(query);
 const qHash = qfp.hash;
 const qKeywords = new Set(qfp.keywords.map(k => (k.word || String(k)).toLowerCase()));

 const scored = [];
 for (const e of this._store.values()) {
 let score = 0;
 // 概念指纹命中
 if (e.concepts?.hash && e.concepts.hash === qHash) score += 50;
 // 关键词重叠（兼容字符串数组与对象数组）
 if (e.concepts?.keywords) {
 for (const k of e.concepts.keywords) {
 const word = (typeof k === 'string' ? k : k.word || '').toLowerCase();
 if (!word) continue;
 if (qKeywords.has(word)) {
 score += (typeof k === 'string' ? 1 : (k.count || 1));
 }
 }
 }
 // 文本直接包含查询
 if (e.text && e.text.includes(query)) score += 30;
 // 工具匹配
 for (const t of qfp.tools) {
 if (e.concepts?.tools?.includes(t)) score += 5;
 }

 // 时间接近（仅在已有显著得分时加分）
 if (e.time && score > 0) score += 1;

 if (score <= 0) continue;

 // 过滤
 if (options.type && e.type !== options.type) continue;
 if (options.tag && !e.tags.includes(options.tag)) continue;
 if (options.minImportance) {
 const imp = { critical: 5, high: 4, medium: 3, low: 2, trivial: 1 };
 if ((imp[e.importance] || 0) < (imp[options.minImportance] || 0)) continue;
 }

 scored.push({ entry: e, score });
 }

 scored.sort((a, b) => b.score - a.score);
 return scored.slice(0, options.limit || 10).map(s => ({
 ...s.entry.toJSON(),
 score: s.score,
 }));
 }

 /**
 * 抽取：把一段对话/文本拆分为可入记忆的条目
 * @param {string} text
 * @param {object} [options] { types?, includeTime? }
 */
 extract(text, options = {}) {
 if (!text) return [];
 const ext = getConceptExtractor();
 const sentences = splitSentences(text);
 const results = [];

 for (const s of sentences) {
 if (s.length < 4) continue;
 const type = classifyMemory(s);
 if (options.types && !options.types.includes(type)) continue;
 const importance = estimateImportance(s, type);
 const concepts = ext.extract(s);
 // 解析时间引用
 let time = null;
 if (options.includeTime !== false) {
 // 简单查找：句子里含"今天/昨天/明天"等
 const tm = s.match(/(今天|明天|后天|昨天|前天|上周|下周|上个月|下个月|\d{4}[-/]\d{1,2}[-/]\d{1,2}|3天后|两周后|一周后|两小时后|\d+天后)/);
 if (tm) {
 const parsed = parseTime(tm[0]);
 if (parsed) time = parsed.toISOString();
 }
 }
 const entry = {
 text: s,
 type,
 importance,
 tags: concepts.keywords.slice(0, 5).map(k => k.word),
 concepts: {
 hash: concepts.hash,
 keywords: concepts.keywords.slice(0, 8).map(k => k.word),
 entities: concepts.entities,
 tools: concepts.tools,
 },
 time,
 source: 'extract',
 };
 results.push(new MemoryEntry(entry));
 }
 return results.map(e => e.toJSON());
 }

 /**
 * 审计：检查重复/冲突/孤岛
 * @returns {{ summary: object, duplicates: Array, conflicts: Array, orphans: Array, stats: object }}
 */
 audit() {
 const duplicates = [];
 const conflicts = [];
 const allEntries = Array.from(this._store.values());

 // 1. 重复检测（同 hash 视为重复）
 for (const [hash, ids] of this._byHash) {
 if (ids.length > 1) {
 duplicates.push({
 hash,
 count: ids.length,
 entries: ids.map(id => this._store.get(id).toJSON()),
 });
 }
 }

 // 2. 冲突检测：相同关键词但 type 不同 / 矛盾词
 const contradictionPairs = [
 ['喜欢', '不喜欢'],
 ['是', '不是'],
 ['要', '不要'],
 ['可以', '不可以'],
 ['能', '不能'],
 ];
 for (let i = 0; i < allEntries.length; i++) {
 for (let j = i + 1; j < allEntries.length; j++) {
 const a = allEntries[i];
 const b = allEntries[j];
 for (const [pos, neg] of contradictionPairs) {
 if ((a.text.includes(pos) && b.text.includes(neg)) ||
 (a.text.includes(neg) && b.text.includes(pos))) {
 // 检查是否同一主题（共享关键词）
 const aKw = new Set((a.concepts?.keywords || []).map(k => (typeof k === 'string' ? k : k.word || '').toLowerCase()).filter(Boolean));
 const bKw = new Set((b.concepts?.keywords || []).map(k => (typeof k === 'string' ? k : k.word || '').toLowerCase()).filter(Boolean));
 const overlap = [...aKw].filter(k => bKw.has(k));
 if (overlap.length >= 2) {
 conflicts.push({
 entryA: a.toJSON(),
 entryB: b.toJSON(),
 contradiction: `${pos} vs ${neg}`,
 sharedKeywords: overlap,
 });
 }
 }
 }
 }
 }

 // 3. 孤岛：没有 tags/keywords 的条目
 const orphans = allEntries.filter(e =>
 (!e.tags || e.tags.length === 0) &&
 (!e.concepts?.keywords || e.concepts.keywords.length === 0)
 ).map(e => e.toJSON());

 // 4. 统计
 const stats = {
 total: allEntries.length,
 byType: {},
 byImportance: {},
 duplicateGroups: duplicates.length,
 conflictPairs: conflicts.length,
 orphanCount: orphans.length,
 coverageRatio: allEntries.length > 0 ? Number(((allEntries.length - orphans.length) / allEntries.length * 100).toFixed(1)) : 0,
 };
 for (const e of allEntries) {
 stats.byType[e.type] = (stats.byType[e.type] || 0) + 1;
 stats.byImportance[e.importance] = (stats.byImportance[e.importance] || 0) + 1;
 }

 return {
 summary: {
 total: stats.total,
 duplicateGroups: stats.duplicateGroups,
 conflictPairs: stats.conflictPairs,
 orphanCount: stats.orphanCount,
 coverageRatio: stats.coverageRatio + '%',
 },
 duplicates,
 conflicts,
 orphans,
 stats,
 };
 }

 /**
 * 摘要：生成记忆库健康报告
 */
 summarize() {
 const audit = this.audit();
 const lines = [];
 lines.push('🧠 记忆库摘要');
 lines.push('━'.repeat(40));
 lines.push(`总条数: ${audit.summary.total}`);
 lines.push(`重复组: ${audit.summary.duplicateGroups}`);
 lines.push(`冲突对: ${audit.summary.conflictPairs}`);
 lines.push(`孤岛: ${audit.summary.orphanCount}`);
 lines.push(`覆盖率: ${audit.summary.coverageRatio}`);
 lines.push('');
 lines.push('按类型:');
 for (const [t, c] of Object.entries(audit.stats.byType)) {
 lines.push(` ${t}: ${c}`);
 }
 lines.push('');
 lines.push('按重要性:');
 for (const [i, c] of Object.entries(audit.stats.byImportance)) {
 lines.push(` ${i}: ${c}`);
 }
 if (audit.duplicates.length > 0) {
 lines.push('');
 lines.push(`⚠️ 重复组示例:`);
 for (const d of audit.duplicates.slice(0, 3)) {
 lines.push(` [${d.hash.slice(0, 8)}] ${d.count} 条重复`);
 }
 }
 if (audit.conflicts.length > 0) {
 lines.push('');
 lines.push(`⚠️ 冲突对示例:`);
 for (const c of audit.conflicts.slice(0, 3)) {
 lines.push(` [${c.contradiction}] ${c.entryA.text.slice(0, 20)} ↔ ${c.entryB.text.slice(0, 20)}`);
 }
 }
 return lines.join('\n');
 }

 list(options = {}) {
 let list = Array.from(this._store.values());
 if (options.type) list = list.filter(e => e.type === options.type);
 if (options.tag) list = list.filter(e => e.tags.includes(options.tag));
 if (options.limit) list = list.slice(0, options.limit);
 return list.map(e => e.toJSON());
 }

 clear() {
 this._store.clear();
 this._byHash.clear();
 this._byType.clear();
 this._byTag.clear();
 }

 get size() {
 return this._store.size;
 }
}

let _instance = null;
function getMemoryAuditor() {
 if (!_instance) _instance = new MemoryAuditor();
 return _instance;
}

module.exports = {
 MemoryAuditor,
 MemoryEntry,
 getMemoryAuditor,
 IMPORTANCE,
 MEMORY_TYPES,
 classifyMemory,
 estimateImportance,
 splitSentences,
};
