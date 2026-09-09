/**
 * Hotspot Intent — 热点-消息匹配 + 记忆化持久化
 *
 * 自主实现 hotspots.js 的核心智能：
 * 1. matchHotspots(message) — 分析用户消息是否提及已知热点
 * 2. persistMentionedHotspot(match) — 将匹配结果写入长期记忆
 * 3. buildHotspotRuntimeContext(message) — 构建上下文注入块
 */

const { getTrendingBlock } = require('./trending');

// ─── 缓存 ───────────────────────────────────────────────
let _cachedSources = []; // [{ name, items: [{title, hot, rank, url}] }]
let _cachedAt = 0;


function _refreshCache() {
 // 从 trending 模块获取最新数据
 try {
 const block = getTrendingBlock();
 if (block) {
 // 解析 Markdown 格式回结构化数据 (getTrendingBlock 返回 "## 当前热点\n\n### 微博热搜\n1. ...")
 // 这里直接从 _cached 读 — 但这是模块内变量不可达，用 require 方式
 }
 } catch (e) {
   /* ignore */
   console.warn('[hotspot-intent.js] 空 catch 补日志:', e && e.message);
 }
}

/**
 * 标准化标题：去空格、去标点、小写
 */
function normalizeTitle(title) {
 return String(title || '')
 .replace(/[\s,，。！？、；：""''（）()【】[\]]/g, '')
 .toLowerCase();
}

/**
 * 从文本中提取关键词（中文 n-gram + 英文 tokens）
 */
function extractKeywords(text, maxLen = 4) {
 const tokens = [];
 const cleaned = String(text || '');

 // 英文单词
 const enWords = cleaned.match(/[a-zA-Z]{2,}/g);
 if (enWords) tokens.push(...enWords.map(w => w.toLowerCase()));

 // 中文 2-gram 和 3-gram
 const chChars = cleaned.replace(/[^一-鿿]/g, '');
 for (let n = 2; n <= maxLen; n++) {
 for (let i = 0; i <= chChars.length - n; i++) {
 tokens.push(chChars.slice(i, i + n));
 }
 }

 // 去重
 return [...new Set(tokens)];
}

/**
 * 匹配用户消息到已知热点
 * @param {string} message 用户消息
 * @param {Array} sources 热点头条 [{ name, items }]
 * @returns {Array<{item, source, matchType, score}>} 匹配结果
 */
function matchHotspots(message, sources) {
 if (!message || !sources || sources.length === 0) return [];

 const msgNorm = normalizeTitle(message);
 const msgKeywords = extractKeywords(message, 4);
 const results = [];

 for (const source of sources) {
 if (!source.items) continue;
 for (const item of source.items) {
 if (!item.title) continue;
 const titleNorm = normalizeTitle(item.title);
 let matchType = '';
 let score = 0;

 // 1. 直接包含（标题是消息的子串或反之）
 if (msgNorm.includes(titleNorm)) {
 matchType = 'direct'; score = 1.0;
 } else if (titleNorm.includes(msgNorm) && msgNorm.length >= 4) {
 matchType = 'direct'; score = 0.9;
 }

 // 2. 排名引用（"热搜第3" / "热搜第三" / "排名第一"）
 if (!score) {
 // 阿拉伯数字: "热搜第3"、"热搜第10"
 const digitMatch = message.match(/热搜第(\d+)/);
 if (digitMatch && Number(digitMatch[1]) === item.rank) {
 matchType = 'rank_ref'; score = 0.95;
 }
 // 中文数字: "热搜第三"、"热搜第一"
 if (!digitMatch) {
 const chineseDigits = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
 const cnMatch = message.match(/热搜第([一二三四五六七八九十两])/);
 if (cnMatch && chineseDigits[cnMatch[1]] === item.rank) {
 matchType = 'rank_ref'; score = 0.95;
 }
 }
 }

 // 3. 关键词重叠（至少 2 个关键词匹配）
 if (!score && msgKeywords.length >= 3) {
 const itemKeywords = extractKeywords(item.title, 3);
 const overlap = msgKeywords.filter(k => itemKeywords.includes(k)).length;
 if (overlap >= 2) {
 matchType = 'keyword'; score = Math.min(0.8, overlap / itemKeywords.length);
 }
 }

 if (score > 0) {
 results.push({ item, source: source.name, matchType, score });
 }
 }
 }

 // 按匹配度排序
 return results.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * 将匹配的热点持久化到长期记忆
 * @param {object} match { item, source, matchType, score }
 * @param {string} message 原始用户消息
 */
async function persistMentionedHotspot(match, _message) {
 try {
 const { memoryManager } = require('./memory-system');
 if (!memoryManager || typeof memoryManager.addMemory !== 'function') return;

 // MemoryManager.addMemory 为位置参数签名 (type, title, content, tags, scope)
 await memoryManager.addMemory(
 'hotspot_event',
 `用户提及热点「${match.item.title}」`,
 `用户提及热点「${match.item.title}」(来源: ${match.source}, 匹配度: ${Math.round(match.score * 100)}%)`,
 ['hotspot', match.source],
 'private'
 );
 } catch (e) {
 console.debug('[hotspot-intent] persistMentionedHotspot failed:', e.message);
 }
}

/**
 * 构建热点上下文注入块
 * @param {string} message 用户消息
 * @returns {string} 格式化的上下文文本（空字符串 = 无需注入）
 */
function buildHotspotRuntimeContext(message) {
 const block = getTrendingBlock();
 if (!block) return '';

 // 从 getTrendingBlock 中提取 sources（通过重新导入获得最新数据）
 let sources = [];
 try {
 // 直接从 trending 模块获取最新采集结果
 // eslint-disable-next-line no-unused-vars
 const trending = require('./trending');
 // trending 模块的 _cached 是内部变量，无法直接访问。
 // 通过重新采集或读取缓存文件获取
 const cachedFile = require('path').join(require('./config').DATA_DIR, 'trending.json');
 if (require('fs').existsSync(cachedFile)) {
 const parsed = JSON.parse(require('fs').readFileSync(cachedFile, 'utf-8'));
 sources = parsed.sources || [];
 }
 } catch (e) {
   /* ignore */
   console.warn('[hotspot-intent.js] 空 catch 补日志:', e && e.message);
 }

 // 匹配热点
 const matches = matchHotspots(message, sources);

 // 持久化匹配结果
 for (const match of matches.slice(0, 3)) {
 persistMentionedHotspot(match, message).catch(e => console.debug('[hotspot] Persist failed:', e?.message));
 }

 if (matches.length === 0) return '';

 // 构建上下文块
 const lines = ['## 相关热点'];
 for (const m of matches.slice(0, 5)) {
 const icon = m.matchType === 'direct' ? '📌' : m.matchType === 'rank_ref' ? '🔢' : '🔗';
 lines.push(` ${icon} [${m.source}] ${m.item.title}${m.item.hot ? ` (热度 ${m.item.hot})` : ''}`);
 }
 return lines.join('\n');
}

module.exports = {
 matchHotspots,
 persistMentionedHotspot,
 buildHotspotRuntimeContext,
 extractKeywords,
 normalizeTitle,
};
