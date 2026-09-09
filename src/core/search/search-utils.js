/**
 * Search Utilities - 搜索工具函数集
 *
 * 自主实现，提供搜索相关的通用工具函数：
 * - HTML 实体解码
 * - HTML 转纯文本
 * - URL 解包 (Bing/DDG 跳转链接)
 * - 结果标准化/去重
 * - CJK 检测
 */

// ─── HTML 处理 ─────────────────────────────────────────────

/**
 * 解码 HTML 实体
 * @param {string} value
 * @returns {string}
 */
function decodeHtmlEntities(value = '') {
 return String(value)
 .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
 .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
 .replace(/&nbsp;/g, ' ')
 .replace(/&amp;/g, '&')
 .replace(/&lt;/g, '<')
 .replace(/&gt;/g, '>')
 .replace(/&quot;/g, '"')
 .replace(/&#39;/g, "'");
}

/**
 * HTML 转纯文本（去除标签、提取可见文字）
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html = '') {
 return decodeHtmlEntities(html)
 .replace(/<script[\s\S]*?<\/script>/gi, ' ')
 .replace(/<style[\s\S]*?<\/style>/gi, ' ')
 .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
 .replace(/<br\s*\/?>/gi, '\n')
 .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote)>/gi, '\n')
 .replace(/<[^>]+>/g, ' ')
 .replace(/[ \t]{2,}/g, ' ')
 .replace(/\n{3,}/g, '\n\n')
 .trim();
}

// ─── URL 处理 ─────────────────────────────────────────────

/**
 * DuckDuckGo 跳转链接解包
 * DDG 搜索结果链接是 `//duckduckgo.com/l/?uddg=<encoded_url>` 格式
 * @param {string} url
 * @returns {string} 真实 URL
 */
function unwrapDuckDuckGoUrl(url) {
 const decoded = decodeHtmlEntities(url);
 const uddg = decoded.match(/[?&]uddg=([^&]+)/);
 if (uddg) {
 try { return decodeURIComponent(uddg[1]); } catch { return uddg[1]; }
 }
 if (decoded.startsWith('//')) return `https:${decoded}`;
 return decoded;
}

/**
 * Bing 跳转链接解包
 * Bing 搜索结果常用 `bing.com/ck/a?...&u=a1<base64url>` 中转链接
 * @param {string} url
 * @returns {string} 真实 URL
 */
function unwrapBingUrl(url) {
 try {
 if (!url || !/bing\.com\/ck\/a/i.test(url)) return url;
 const u = new URL(url);
 const raw = u.searchParams.get('u');
 if (!raw) return url;
 let encoded = raw.startsWith('a1') ? raw.slice(2) : raw;
 encoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
 while (encoded.length % 4) encoded += '=';
 const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
 return /^https?:\/\//i.test(decoded) ? decoded : url;
 } catch {
 return url;
 }
}

// ─── 语言检测 ─────────────────────────────────────────────

/**
 * 检测字符串是否包含 CJK（中日韩）字符
 * 用于自动设置搜索语言偏好
 * @param {string} s
 * @returns {boolean}
 */
function hasCJK(s) {
 return /[㐀-鿿豈-﫿]/.test(s);
}

// ─── 信号处理 ─────────────────────────────────────────────

/**
 * 合并两个 AbortSignal
 * 任一信号 abort 时，返回的信号也会 abort
 * @param {AbortSignal} sig1
 * @param {AbortSignal} sig2
 * @returns {AbortSignal}
 */
function _combineSignals(sig1, sig2) {
  const controller = new AbortController();
  const onAbort1 = () => { if (!controller.signal.aborted) controller.abort(sig1.reason); };
  const onAbort2 = () => { if (!controller.signal.aborted) controller.abort(sig2.reason); };
  sig1.addEventListener('abort', onAbort1, { once: true });
  sig2.addEventListener('abort', onAbort2, { once: true });
  if (sig1.aborted) controller.abort(sig1.reason);
  else if (sig2.aborted) controller.abort(sig2.reason);
  return controller.signal;
}

// ─── 结果处理 ─────────────────────────────────────────────

const SEARCH_TITLE_MAX = 200;
const SEARCH_SNIPPET_MAX = 300;
const SEARCH_LOG_QUERY_MAX = 100;

/**
 * 各引擎原始结果统一处理：
 * 截断超长字段、丢弃空 url/title、按 URL 去重（host+path，忽略 query/fragment）
 * @param {Array<{title:string, url:string, snippet:string}>} raw
 * @param {number} limit
 * @returns {Array<{title:string, url:string, snippet:string}>}
 */
function normalizeResults(raw, limit) {
 const out = [];
 const seen = new Set();
 for (const r of raw) {
 const url = String(r?.url || '').trim();
 const title = String(r?.title || '').trim().slice(0, SEARCH_TITLE_MAX);
 if (!url || !title) continue;
 let dedupKey;
 try {
 const u = new URL(url);
 dedupKey = `${u.host}${u.pathname.replace(/\/$/, '')}`;
 } catch {
 dedupKey = url;
 }
 if (seen.has(dedupKey)) continue;
 seen.add(dedupKey);
 out.push({
 title,
 url,
 snippet: String(r?.snippet || '').trim().slice(0, SEARCH_SNIPPET_MAX),
 });
 if (out.length >= limit) break;
 }
 return out;
}

/**
 * 截断查询日志（过长时截断并标注长度）
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncateForLog(s, max = SEARCH_LOG_QUERY_MAX) {
 const str = String(s || '');
 return str.length <= max ? str : `${str.slice(0, max)}…(${str.length})`;
}

/**
 * 构建搜索结果 Payload
 * @param {string} query
 * @param {object} result 包含 source, results 字段
 * @returns {object}
 */
// 2026-08-19 搜索体验修复: 统一回答排版约束——此前 hint 只让 LLM"打开链接查看",
// 无输出格式要求, LLM 常把原始结果数组/JSON 原样堆叠(用户反馈"格式混乱")。
// 2026-09-06 资讯回复过简修复: hint 追加语音模式分支——语音 brevityHint(每轮注入
// "1-2 句口语化短句、避免列表")与 hint 的 Markdown 列表要求直接冲突, 且 brevityHint
// 在消息尾部每轮重复、实际总是赢 → 搜到 8 条也只播一两句(用户实测"AI 资讯推荐
// 特别简单")。语音分支显式声明"搜索转述不受默认简短约束"并给出口语化播报格式。
const SEARCH_ANSWER_HINT = '用 Markdown 列表回答：每条为【加粗标题＋一句摘要＋来源链接】。从 results 选取与问题相关的 3-5 条，按信息价值排序；结果含 date 字段的标注日期。禁止原样贴出原始结果数组或 JSON。若当前处于语音对话模式（有"1-2 句口语化短句"的系统提示）：本条回复是搜索结果转述，不受该默认简短约束——改用自然口语逐条播报最值得关注的 3 条左右，每条一句话说清「来源＋发生了什么＋关键数字/结论」，不要念 URL、序号和 Markdown 符号；此要求优先于"1-2 句"的默认简短要求。';

function buildSearchPayload(query, result) {
 return {
 ok: true,
 tool: 'WebSearch',
 query,
 source: result.source || result.backend || 'unknown',
 results: result.results,
 hint: SEARCH_ANSWER_HINT,
 };
}

module.exports = {
 decodeHtmlEntities,
 htmlToText,
 unwrapDuckDuckGoUrl,
 unwrapBingUrl,
 hasCJK,
 normalizeResults,
 truncateForLog,
 buildSearchPayload,
 SEARCH_ANSWER_HINT,
};
