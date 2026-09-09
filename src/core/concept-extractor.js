'use strict';

/**
 * concept-extractor.js — 概念提取（实体/关键词/主题）
 *
 * 设计参考 的概念提取器：
 * 1. 中英混合分词（去除标点、停用词、低频词）
 * 2. 实体识别（人名/地名/工具/时间/数字/URL）
 * 3. 主题关键词（TF 简单排序）
 * 4. 概念指纹（hash + 归一化）用于记忆检索
 *
 * 设计目标：
 * - 纯 JS 零依赖（仅用内置 RegExp + 简单中文分词启发式）
 * - 与 self-awareness、memory 等系统协作
 * - 可被 pre-turn 上下文注入器调用
 */

// ── 停用词表（中英基础） ─────────────────────────────────────
const STOP_WORDS_ZH = new Set([
 '的', '了', '和', '是', '在', '我', '有', '不', '这', '也', '就', '都', '而', '及',
 '与', '或', '把', '被', '为', '以', '对', '上', '下', '中', '到', '从', '向', '之',
 '你', '他', '她', '它', '们', '其', '此', '那', '什么', '怎么', '为什么', '可以',
 '啊', '吗', '呢', '吧', '哈', '嗯', '哦', '呀', '哎', '咯', '哇', '啦',
 '一个', '一些', '一种', '这个', '那个', '什么', '怎样', '如何',
 '是否', '是否', '因为', '所以', '但是', '不过', '然而', '如果', '虽然',
 '请', '帮我', '麻烦', '谢谢', '感谢', '好的', '是', '是的', '不是',
 '然后', '接着', '于是', '现在', '之前', '之后', '刚才', '刚刚',
 '来', '去', '做', '让', '想', '要', '会', '能', '得', '过', '了', '着',
 '没有', '还没', '还没', '不', '没', '无', '非', '未',
]);

const STOP_WORDS_EN = new Set([
 'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could',
 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'into',
 'about', 'between', 'through', 'after', 'before', 'above', 'below', 'up', 'down',
 'so', 'no', 'not', 'only', 'also', 'too', 'very', 'just', 'than', 'then',
 'what', 'when', 'where', 'why', 'how', 'which', 'who', 'whom', 'can', 'may',
 'please', 'thanks', 'thank', 'ok', 'okay', 'yes', 'no', 'yeah', 'yep', 'nope',
 'am', 'pm',
]);

// ── 实体类型正则 ─────────────────────────────────────
const ENTITY_PATTERNS = [
 { type: 'url', re: /https?:\/\/[^\s\u4e00-\u9fa5]+/g },
 { type: 'email', re: /[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}/g },
 { type: 'ipv4', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
 { type: 'datetime', re: /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\b/g },
 { type: 'time', re: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g },
 { type: 'number', re: /-?\d+(?:\.\d+)?%?/g },
 { type: 'camel_case', re: /\b[a-z]+(?:[A-Z][a-z]+)+\b/g },
 { type: 'snake_case', re: /\b[a-z]+(?:_[a-z]+)+\b/g },
 { type: 'quoted', re: /"([^"]{2,40})"|'([^']{2,40})'/g },
];

// ── 中文姓名启发 ─────────────────────────────────────
const COMMON_SURNAMES = new Set([
 '王', '李', '张', '刘', '陈', '杨', '黄', '赵', '吴', '周', '徐', '孙', '马', '朱',
 '胡', '郭', '何', '高', '林', '罗', '郑', '梁', '谢', '宋', '唐', '许', '韩', '冯',
 '邓', '曹', '彭', '曾', '萧', '田', '董', '袁', '潘', '于', '蒋', '蔡', '余', '杜',
 '叶', '程', '苏', '魏', '吕', '丁', '任', '沈', '姚', '卢', '姜', '崔', '钟', '谭',
 '陆', '汪', '范', '金', '石', '廖', '贾', '夏', '韦', '付', '方', '白', '邹', '孟',
]);

// ── 工具/平台关键字 ─────────────────────────────
const TOOL_KEYWORDS = new Set([
 'npm', 'node', 'node.js', 'git', 'github', 'gitlab', 'docker', 'kubernetes', 'k8s',
 'python', 'java', 'kotlin', 'swift', 'rust', 'go', 'golang', 'typescript', 'javascript',
 'react', 'vue', 'angular', 'svelte', 'next', 'nuxt', 'express', 'koa', 'fastify',
 'mysql', 'postgres', 'postgresql', 'mongodb', 'redis', 'sqlite', 'elasticsearch',
 'aws', 'azure', 'gcp', 'aliyun', 'tencent', 'feishu', 'lark', 'wecom', 'wechat',
 'claude', 'openai', 'gpt', 'deepseek', 'qwen', 'doubao', 'volcano', 'gemini',
 'crabpaw', 'vscode', 'cursor', 'intellij', 'pycharm',
 'powershell', 'bash', 'zsh', 'fish', 'cmd',
 'html', 'css', 'scss', 'json', 'yaml', 'xml', 'toml', 'markdown',
 'http', 'https', 'websocket', 'ws', 'grpc', 'rest',
]);

// ── 工具函数 ─────────────────────────────────────
function _isChineseChar(ch) {
 const c = ch.charCodeAt(0);
 return (c >= 0x4e00 && c <= 0x9fff)
 || (c >= 0x3400 && c <= 0x4dbf)
 || (c >= 0xf900 && c <= 0xfaff);
}

function _isEnglishWord(w) {
 return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(w);
}

function isStopWord(w) {
 const lw = w.toLowerCase();
 return STOP_WORDS_ZH.has(w) || STOP_WORDS_EN.has(lw) || w.length < 2;
}

// 简易中文分词：单字 + 二元 + 三元
function tokenizeChinese(text) {
 const tokens = [];
 // 提取连续中文字符
 const chineseRuns = text.match(/[\u4e00-\u9fff]+/g) || [];
 for (const run of chineseRuns) {
 // 单字
 for (let i = 0; i < run.length; i++) {
 tokens.push(run[i]);
 }
 // 二元
 for (let i = 0; i < run.length - 1; i++) {
 tokens.push(run.slice(i, i + 2));
 }
 // 三元
 for (let i = 0; i < run.length - 2; i++) {
 tokens.push(run.slice(i, i + 3));
 }
 }
 return tokens;
}

function tokenizeEnglish(text) {
 const matches = text.match(/[a-zA-Z][a-zA-Z0-9_-]*/g) || [];
 return matches.map(w => w.toLowerCase());
}

// 归一化（用于概念指纹）
function normalize(word) {
 return word.toLowerCase().replace(/[_\-\s]/g, '');
}

// 简单 hash
function hash32(str) {
 let h = 0x811c9dc5;
 for (let i = 0; i < str.length; i++) {
 h ^= str.charCodeAt(i);
 h = Math.imul(h, 0x01000193);
 }
 return (h >>> 0).toString(16).padStart(8, '0');
}

// ── 提取实体 ─────────────────────────────────────
function extractEntities(text) {
 const entities = {};
 for (const { type, re } of ENTITY_PATTERNS) {
 const matches = text.match(re) || [];
 if (matches.length > 0) {
 entities[type] = Array.from(new Set(matches.map(m => m.trim())));
 }
 }
 // 中文姓名（启发式）
 const personNames = new Set();
 for (let i = 0; i < text.length - 1; i++) {
 if (COMMON_SURNAMES.has(text[i])) {
 // 取姓后 1-2 字作名
 const name2 = text.substr(i, 2);
 const name3 = text.substr(i, 3);
 // 过滤常见误匹配（避免动词）
 if (name2 && /[\u4e00-\u9fff]/.test(name2[1]) && !STOP_WORDS_ZH.has(name2)) {
 personNames.add(name2);
 }
 if (name3 && /[\u4e00-\u9fff]/.test(name3[1]) && /[\u4e00-\u9fff]/.test(name3[2]) && !STOP_WORDS_ZH.has(name3)) {
 personNames.add(name3);
 }
 }
 }
 if (personNames.size > 0) {
 entities.person = Array.from(personNames).slice(0, 5);
 }
 return entities;
}

// ── 提取主题关键词 ────────────────────────────────
function extractKeywords(text, options = {}) {
 const topN = options.topN || 10;
 const minLen = options.minLen || 2;

 const tokens = [
 ...tokenizeChinese(text),
 ...tokenizeEnglish(text),
 ];

 const freq = new Map();
 for (const t of tokens) {
 if (isStopWord(t)) continue;
 if (t.length < minLen) continue;
 if (/^\d+$/.test(t)) continue;
 freq.set(t, (freq.get(t) || 0) + 1);
 }

 // 排序
 const sorted = Array.from(freq.entries())
 .sort((a, b) => b[1] - a[1])
 .slice(0, topN)
 .map(([word, count]) => ({ word, count }));

 return sorted;
}

// ── 工具/平台识别 ───────────────────────────────
function extractTools(text) {
 const lower = text.toLowerCase();
 const hits = [];
 for (const tool of TOOL_KEYWORDS) {
 if (lower.includes(tool.toLowerCase())) {
 hits.push(tool);
 }
 }
 return Array.from(new Set(hits));
}

// ── 概念指纹（用于记忆检索） ─────────────────────
function buildFingerprint(text) {
 const keywords = extractKeywords(text, { topN: 20 });
 const entities = extractEntities(text);
 const tools = extractTools(text);

 const fp = {
 keywords: keywords.map(k => k.word),
 entities,
 tools,
 hash: '',
 };

 // 用归一化的关键词集合生成 hash
 const normSet = new Set();
 for (const k of fp.keywords) normSet.add(normalize(k));
 for (const e of Object.values(entities).flat()) normSet.add(normalize(String(e)));
 for (const t of fp.tools) normSet.add(normalize(t));
 fp.hash = hash32(Array.from(normSet).sort().join('|'));

 return fp;
}

// ── 概念主类 ────────────────────────────────────
class ConceptExtractor {
 constructor() {
 this._cache = new Map(); // text -> fingerprint
 this._cacheTtlMs = 5 * 60 * 1000;
 }

 /**
 * 提取完整概念画像
 * @param {string} text
 * @returns {{
 * keywords: Array<{word:string, count:number}>,
 * entities: object,
 * tools: string[],
 * hash: string,
 * summary: string,
 * timestamp: number,
 * }}
 */
 extract(text) {
 if (!text || typeof text !== 'string') {
 return { keywords: [], entities: {}, tools: [], hash: '', summary: '', timestamp: Date.now() };
 }
 const cached = this._cache.get(text);
 if (cached && Date.now() - cached.timestamp < this._cacheTtlMs) {
 return cached;
 }

 const fp = buildFingerprint(text);
 const result = {
 keywords: extractKeywords(text, { topN: 10 }),
 entities: fp.entities,
 tools: fp.tools,
 hash: fp.hash,
 summary: '',
 timestamp: Date.now(),
 };

 // 生成 1-2 行摘要（适合注入 prompt）
 const parts = [];
 if (result.keywords.length > 0) {
 parts.push(`关键词: ${result.keywords.slice(0, 5).map(k => k.word).join('、')}`);
 }
 if (result.tools.length > 0) {
 parts.push(`工具: ${result.tools.join('/')}`);
 }
 const entityCount = Object.values(result.entities).reduce((s, v) => s + v.length, 0);
 if (entityCount > 0) {
 parts.push(`实体: ${entityCount} 个`);
 }
 result.summary = parts.join(' | ');

 this._cache.set(text, result);
 return result;
 }

 /**
 * 提取并格式化为 prompt 友好的字符串
 */
 extractForPrompt(text) {
 const fp = this.extract(text);
 const lines = [];
 lines.push('<concepts>');
 lines.push(`Hash: ${fp.hash}`);
 if (fp.keywords.length > 0) {
 lines.push(`Keywords: ${fp.keywords.slice(0, 8).map(k => `${k.word}(${k.count})`).join(', ')}`);
 }
 if (fp.tools.length > 0) {
 lines.push(`Tools: ${fp.tools.join(', ')}`);
 }
 for (const [type, list] of Object.entries(fp.entities)) {
 if (list.length > 0) {
 lines.push(`${type}: ${list.slice(0, 5).join(', ')}`);
 }
 }
 lines.push('</concepts>');
 return lines.join('\n');
 }

 clearCache() {
 this._cache.clear();
 }
}

let _instance = null;
function getConceptExtractor() {
 if (!_instance) _instance = new ConceptExtractor();
 return _instance;
}

module.exports = {
 ConceptExtractor,
 getConceptExtractor,
 // 暴露原子函数供测试和复用
 extractKeywords,
 extractEntities,
 extractTools,
 buildFingerprint,
 tokenizeChinese,
 tokenizeEnglish,
 normalize,
 hash32,
 STOP_WORDS_ZH,
 STOP_WORDS_EN,
 TOOL_KEYWORDS,
 COMMON_SURNAMES,
};
