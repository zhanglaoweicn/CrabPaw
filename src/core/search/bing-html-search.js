/**
 * Bing HTML Search Backend — 免费 Bing 搜索（HTML 解析）
 *
 * 自主实现 `searchViaBing`。
 * 通过解析 cn.bing.com 的 HTML 搜索结果页面获取结果，
 * 无需 API Key，在中国网络环境直连可用。
 *
 * 使用改进的 HTML 解析策略：
 * - 按 <li class="b_algo"> 分割结果块
 * - 提取 <h2><a href="..."> 标题和 URL
 * - 解包 bing.com/ck/a 跳转链接
 * - 提取 b_lineclamp/b_caption 中的摘要
 */

const { normalizeResults, htmlToText, unwrapBingUrl, truncateForLog: _truncateForLog } = require('./search-utils');

const BING_TIMEOUT = 15000; // 15s
const ENGINE_NAME = 'bing';

/**
 * 通过 Bing HTML 搜索
 * @param {string} query
 * @param {number} limit
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ok:boolean, results?:Array, source?:string, reason?:string}|null>}
 */
async function searchViaBing(query, limit, signal) {
 const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`;

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), BING_TIMEOUT);

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

 // Bing 的 <li class="b_algo"> 不闭合 </li>，按下一个 b_algo 切块更稳
 const parts = html.split(/<li class="b_algo"/i).slice(1);
 const raw = [];

 for (const part of parts) {
 // 标题在 <h2><a href="...">...内可能嵌 <strong>
 const headerMatch = part.match(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
 if (!headerMatch) continue;

 const url = unwrapBingUrl(headerMatch[1]);
 const title = htmlToText(headerMatch[2]);
 if (!title || !url) continue;

 // 摘要：优先 b_lineclamp* / b_caption 内的 <p>
 const snippetMatch =
 part.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
 part.match(/class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
 part.match(/<p[^>]*>([\s\S]{30,}?)<\/p>/i);
 const snippet = snippetMatch ? htmlToText(snippetMatch[1]) : '';

 raw.push({ title, url, snippet });
 }

 const results = normalizeResults(raw, limit);
 if (results.length === 0) {
 // 检测是否被反爬/验证码拦截
 const blocked = /sorry|captcha|verify|访问被拒绝/i.test(html.slice(0, 4000));
 let reason;
 if (blocked) reason = '被拦截或触发验证码';
 else if (parts.length === 0) reason = '未找到结果块（页面结构可能已变更）';
 else reason = `找到 ${parts.length} 个结果块但解析出 0 条（h2>a 结构可能已变更）`;
 return { ok: false, reason };
 }

 console.log(`[search] Bing HTML 返回 ${results.length} 条结果`);
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

module.exports = { searchViaBing };
