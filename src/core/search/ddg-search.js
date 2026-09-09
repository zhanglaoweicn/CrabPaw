/**
 * DuckDuckGo HTML Search Backend — 免费 DDG 搜索（HTML 解析）
 *
 * 自主实现 `searchViaDDG` 和 `parseDuckDuckGoResults`。
 * 通过解析 duckduckgo.com/html 的 HTML 搜索结果页面获取结果。
 *
 * 注意：DDG 在国内（GFW 内）通常不可用，仅作为海外用户的兜底选项。
 */

const { normalizeResults, htmlToText, unwrapDuckDuckGoUrl, truncateForLog: _truncateForLog } = require('./search-utils');

const DDG_TIMEOUT = 15000; // 15s
const ENGINE_NAME = 'duckduckgo';

/**
 * 解析 DuckDuckGo HTML 页面中的搜索结果
 */
function parseDuckDuckGoResults(html, limit) {
 const raw = [];
 const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
 let match;
 while ((match = resultRegex.exec(html)) !== null) {
 const url = unwrapDuckDuckGoUrl(match[1]);
 const title = htmlToText(match[2]);
 if (!url || !title) continue;

 // 查找紧随的 snippet（在下一个 result__a 之前）
 const nextStart = resultRegex.lastIndex;
 const nextMatch = html.slice(nextStart).match(/<a[^>]+class="result__a"/i);
 const block = nextMatch
 ? html.slice(nextStart, nextStart + nextMatch.index)
 : html.slice(nextStart, nextStart + 2000);
 const snippetMatch = block.match(
 /class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i
 );
 const snippet = htmlToText(snippetMatch?.[1] || snippetMatch?.[2] || '');
 raw.push({ title, url, snippet });
 }
 return normalizeResults(raw, limit);
}

/**
 * 通过 DuckDuckGo HTML 搜索
 * @param {string} query
 * @param {number} limit
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok:boolean, results?:Array, source?:string, reason?:string}|null>}
 */
async function searchViaDDG(query, limit, signal) {
 const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), DDG_TIMEOUT);

 const mergedSignal = signal
 ? combineSignals(signal, controller.signal)
 : controller.signal;

 try {
 const res = await fetch(searchUrl, {
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7',
 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
 },
 signal: mergedSignal,
 });
 clearTimeout(timer);

 if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

 const html = await res.text();

 // DDG 返回 403/CAPTCHA 页时 HTML 中不含 result__a
 if (!html.includes('result__a')) {
 return { ok: false, reason: '被拦截或触发验证码（未找到 result__a）' };
 }

 const results = parseDuckDuckGoResults(html, limit);
 if (results.length === 0) {
 return { ok: false, reason: '解析结果为空' };
 }

 console.log(`[search] DuckDuckGo 返回 ${results.length} 条结果`);
 return { ok: true, results, source: ENGINE_NAME };
 } catch (err) {
 clearTimeout(timer);
 if (err.name === 'AbortError') throw err;
 return { ok: false, reason: `网络错误: ${err.message || err}` };
 }
}

/**
 * 合并两个 AbortSignal
 */
function combineSignals(sig1, sig2) {
 const controller = new AbortController();
 const onAbort1 = () => { if (!controller.signal.aborted) controller.abort(sig1.reason); };
 const onAbort2 = () => { if (!controller.signal.aborted) controller.abort(sig2.reason); };
 sig1.addEventListener('abort', onAbort1, { once: true });
 sig2.addEventListener('abort', onAbort2, { once: true });
 if (sig1.aborted) controller.abort(sig1.reason);
 else if (sig2.aborted) controller.abort(sig2.reason);
 return controller.signal;
}

module.exports = { searchViaDDG };
