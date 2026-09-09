/**
 * Jina Search Backend — 免费 AI 搜索引擎
 *
 * 自主实现 `searchViaJina`。
 * Jina AI (s.jina.ai) 提供免费的搜索 API，无 Key 也可使用（有限流），
 * 配置 JINA_API_KEY 后获得更高优先级。
 *
 * 响应格式：纯文本
 * [1] 标题
 * URL: https://...
 * Description: 摘要...
 */

const { normalizeResults, truncateForLog: _truncateForLog, combineSignals } = require('./search-utils');

const JINA_TIMEOUT = 18000; // 18s
const ENGINE_NAME = 'jina_search';

/**
 * 通过 Jina AI 搜索
 * @param {string} query
 * @param {number} limit
 * @param {AbortSignal} [signal]
 * @param {object} [credentials] { jinaKey }
 * @returns {Promise<{ok:boolean, results?:Array, source?:string, reason?:string}|null>}
 * null = 未配置/跳过；{ ok: true, ... } = 成功；{ ok: false, reason } = 失败
 */
async function searchViaJina(query, limit, signal, credentials = {}) {
 const { jinaKey } = credentials;
 const url = `https://s.jina.ai/${encodeURIComponent(query)}`;

 // 不需检查 Key — Jina 无 Key 也可用（但有限流）
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT);

 // 合并信号
 const mergedSignal = signal
 ? combineSignals(signal, controller.signal)
 : controller.signal;

 const headers = {
 'Accept': 'text/plain',
 'X-Respond-With': 'no-references',
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
 };
 if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;

 try {
 const res = await fetch(url, { headers, signal: mergedSignal });
 clearTimeout(timer);

 if (!res.ok) {
 let hint = '';
 if (res.status === 401 || res.status === 403) {
 hint = jinaKey ? '（检查 JINA_API_KEY）' : '（Jina 可能需要 API Key，可在设置中配置）';
 } else if (res.status === 429) {
 hint = '（限流中）';
 }
 return { ok: false, reason: `HTTP ${res.status}${hint}` };
 }

 const text = (await res.text()).trim();
 if (!text) return { ok: false, reason: '响应为空' };
 // Jina 限流时返回 200 + 几十字提示
 if (text.length < 50) {
 return { ok: false, reason: `响应过短 (${text.length} 字符，可能被限流)` };
 }

 // 解析 Jina 格式
 const raw = [];
 const blocks = text.split(/\n(?=\[\d+\])/);
 for (const block of blocks) {
 const titleMatch = block.match(/^\[\d+\]\s*(.+)/);
 const urlMatch = block.match(/^URL:\s*(\S+)/m);
 const descMatch = block.match(/^Description:\s*(.+)/m);
 if (titleMatch && urlMatch) {
 raw.push({ title: titleMatch[1], url: urlMatch[1], snippet: descMatch?.[1] || '' });
 }
 }

 const results = normalizeResults(raw, limit);
 if (results.length === 0) {
 return { ok: false, reason: '解析结果为空（格式可能已变更）' };
 }

 console.log(`[search] Jina AI 返回 ${results.length} 条结果`);
 return { ok: true, results, source: ENGINE_NAME };
 } catch (err) {
 clearTimeout(timer);
 if (err.name === 'AbortError') throw err;
 return { ok: false, reason: `网络错误: ${err.message || err}` };
 }
}



module.exports = { searchViaJina };
