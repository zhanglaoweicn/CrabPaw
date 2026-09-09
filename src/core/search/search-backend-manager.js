/**
 * 搜索后端管理器
 *
 * 统一管理多个搜索后端，提供：
 */

// 注：该文件使用 UTF-8 编码，如果看到乱码请检查编辑器编码设置

const { EventEmitter } = require('events');

// ─── 导入免费搜索引擎（两层级联 Tier 2）────────────────
const { searchViaJina } = require('./jina-search');
const { searchViaBing } = require('./bing-html-search');
const { searchViaDDG } = require('./ddg-search');
const { buildSearchPayload, truncateForLog, SEARCH_ANSWER_HINT } = require('./search-utils');
const { searchCacheGet, searchCacheSet } = require('./search-cache');
// eslint-disable-next-line no-unused-vars

// 免费引擎配置键（从 Manager 获取）
let _jinaKey = null;
let _braveKey = null;
let _tavilyKey = null;
let _baiduKey = null;

class SearchBackend {
 constructor(config = {}) {
 this.name = config.name || 'unknown';
 this.type = config.type || 'generic';
 this.priority = config.priority || 50;
 this.enabled = config.enabled !== false;
 this.apiKey = config.apiKey || null;
 this.baseUrl = config.baseUrl || null;
 this.timeout = config.timeout || 10000;
 this.tags = config.tags || [];
 }

 // eslint-disable-next-line no-unused-vars
 async search(query, options = {}) {
 throw new Error(this.name + ' backend search method not implemented');
 }

 isAvailable() {
 return this.enabled;
 }

 matchesScenario(scenario) {
 return this.tags.includes(scenario);
 }
}

// ─── Baidu 后端 ──────────────────────────────────────

class BaiduBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'baidu', type: 'http', priority: 45, timeout: 8000, tags: ['chinese', 'free', 'general'], ...config });
 }

 isAvailable() { return this.enabled; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${num}&ie=utf-8`;

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), this.timeout);

 try {
 const response = await fetch(url, {
 signal: controller.signal,
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
 'Accept': 'text/html,application/xhtml+xml',
 'Accept-Language': 'zh-CN,zh;q=0.9',
 },
 });
 clearTimeout(timer);

 if (!response.ok) throw new Error(`HTTP ${response.status}`);

 const html = await response.text();

 // Detect Baidu anti-bot / CAPTCHA page (responds with short verification page, not results)
 if (html.includes("security-verify") || html.includes("antispider") || html.includes("verify") || html.length < 3000) {
 throw new Error("Baidu anti-bot verification triggered, falling back");
 }

 const results = [];

 // Baidu result blocks: class="result" or "c-container"
 const blockRegex = /<div[^>]*class="[^"]*(?:result|c-container)[^"]*"[^>]*data-mu="([^"]*)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*(?:result|c-container)|$)/gi;
 let match;
 while ((match = blockRegex.exec(html)) !== null && results.length < num) {
 const dataUrl = match[1];
 const block = match[2];
 const titleMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
 const descMatch = block.match(/<span[^>]*class="[^"]*content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
 || block.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
 || block.match(/<span[^>]*class="[^"]*c-span-last[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

 if (titleMatch) {
 results.push({
 title: titleMatch[2].replace(/<[^>]+>/g, '').trim(),
 url: titleMatch[1] || dataUrl,
 snippet: (descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : ''),
 });
 }
 }

 // Fallback: simpler regex
 if (results.length === 0) {
 const simpleRegex = /<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
 let m;
 const seen = new Set();
 while ((m = simpleRegex.exec(html)) !== null && results.length < num) {
 const url = m[1];
 if (!seen.has(url) && !url.includes('baidu.com')) {
 seen.add(url);
 results.push({ title: m[2].replace(/<[^>]+>/g, '').trim(), url, snippet: '' });
 }
 }
 }

 return { query, results, backend: this.name, method: 'http' };
 } catch (err) {
 clearTimeout(timer);
 throw err;
 }
 }
}

// ─── 百度千帆 AI 搜索 API 后端 ────────────────────────────────
// 2026-08-19 搜索能力增强: 百度智能云千帆 AI 搜索 web_search 接口
// (POST https://qianfan.baidubce.com/v2/ai_search/web_search, OpenAI 兼容 messages 格式,
// Bearer 鉴权)。免费额度 1500 次/月(按天发放), 中文检索质量最优, 且返回 content 正文
// (AI 可直接引用, 省一次 WebFetch)。优先级 65: 中文场景 +50 后 115 压过无 chinese tag
// 的 Tavily(80)/Exa(75); 若另配 Bing API key(chinese tag), 其 70+50=120 仍居首——合理。
// HTML 爬取版 BaiduBackend 被反爬实锤(security-verify), 勿再启用。
class BaiduApiBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'baidu_api', type: 'api', priority: 65, timeout: 15000, tags: ['chinese', 'news', 'general', 'agent-friendly'], ...config });
 }

 isAvailable() { return this.enabled && !!this.apiKey; }

 async search(query, options = {}) {
 const num = options.num || 10;
 // 官方文档: search_mode 支持 normal/news/academic; freshness 支持 pd/pw/pm/py 或日期区间
 const scenario = options.scenario || 'normal';
 const searchMode = scenario === 'news' ? 'news' : scenario === 'academic' ? 'academic' : 'normal';

 const response = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
 method: 'POST',
 headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
 body: JSON.stringify({
 messages: [{ role: 'user', content: query }],
 search_mode: searchMode,
 count: Math.min(num, 50), // 官方范围 1-50
 }),
 signal: AbortSignal.timeout(this.timeout),
 });

 if (!response.ok) throw new Error(`Baidu API ${response.status}`);

 const data = await response.json();
 if (data.code && data.code !== 0) throw new Error(`Baidu API: ${data.code} ${data.message || ''}`);

 const results = (data.references || [])
 .map(r => ({
 title: r.title || '',
 url: r.url || '',
 snippet: (r.snippet || (r.content || '').slice(0, 200) || '').trim(),
 source: r.website || '百度搜索',
 date: r.date || '',
 score: r.rerank_score || 0,
 }))
 .slice(0, num); // count 参数实测不生效(恒 20 条), 显式截断尊重 num 语义

 return { query, results, backend: this.name, method: 'api', stats: { request_id: data.request_id } };
 }
}

// ─── SearXNG Public 后端 ────────────────────────────────

class SearXNGPublicBackend extends SearchBackend {
 constructor(config = {}) {
 super({
 name: 'searxng_public',
 type: 'api',
 priority: 55,
 tags: ['general', 'news', 'free', 'agent-friendly'],
 ...config,
 });
 // Multiple public instances for redundancy
 this._instances = config.instances || [
 'https://search.sapti.me',
 'https://searx.be',
 'https://search.bus-hit.me',
 'https://search.rowie.site',
 'https://opnxng.com',
 'https://searx.tuxcloud.net',
 ];
 this._currentInstance = 0;
 }

 isAvailable() { return this.enabled; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const maxTries = Math.min(this._instances.length, 3);

 for (let attempt = 0; attempt < maxTries; attempt++) {
 const instance = this._instances[(this._currentInstance + attempt) % this._instances.length];
 try {
 const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN&categories=general&pageno=1`;

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 5000);

 const response = await fetch(url, {
 signal: controller.signal,
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
 'Accept': 'application/json',
 },
 });
 clearTimeout(timer);

 if (!response.ok) continue;

 const data = await response.json();
 const results = (data.results || []).slice(0, num).map(r => ({
 title: r.title || '',
 url: r.url || '',
 snippet: (r.content || r.snippet || '').replace(/<[^>]+>/g, '').substring(0, 300),
 source: r.engine || '',
 }));

 this._currentInstance = (this._currentInstance + attempt) % this._instances.length;
 return { query, results, backend: `searxng:${new URL(instance).hostname}`, method: 'api' };

 } catch (err) {
 console.warn('[search-backend-manager] SearXNG instance failed:', err.message);
 continue;
 }
 }

 throw new Error('SearXNG: all public instances unavailable');
 }
}

// ─── DuckDuckGo HTTP 后端 ─────────────────────────────────────

class DuckDuckGoBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'duckduckgo', type: 'http', priority: 20, timeout: 5000, tags: ['general', 'free'], ...config });
 }

 isAvailable() { return this.enabled; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), this.timeout);

 try {
 const response = await fetch(url, {
 signal: controller.signal,
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
 'Accept': 'text/html',
 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
 },
 });
 clearTimeout(timer);

 if (!response.ok) throw new Error(`HTTP ${response.status}`);

 const html = await response.text();
 const results = [];
 const regex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
 let match;
 while ((match = regex.exec(html)) !== null && results.length < num) {
 const block = html.slice(Math.max(0, match.index - 500), match.index + 2000);
 const descMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
 results.push({
 title: match[2].replace(/<[^>]+>/g, '').trim(),
 url: match[1],
 snippet: (descMatch ? descMatch[1] : '').replace(/<[^>]+>/g, '').trim(),
 });
 }

 return { query, results, backend: this.name, method: 'http' };
 } catch (err) {
 clearTimeout(timer);
 throw err;
 }
 }
}

// ─── Bing HTTP 后端 ──────────────────────────────────────────

class BingBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'bing', type: 'http', priority: 35, tags: ['general', 'free', 'chinese'], ...config });
 }

 isAvailable() { return this.enabled; }

 async search(query, options = {}) {
 const num = options.num || 10;
 // Try multiple URL formats for robustness
 const urls = [
 `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&count=${num}`,
 `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=${num}`,
 ];

 for (const url of urls) {
 try {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), this.timeout);
 const response = await fetch(url, {
 signal: controller.signal,
 headers: {
 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
 'Accept': 'text/html,application/xhtml+xml',
 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
 },
 });
 clearTimeout(timer);

 if (!response.ok) continue;

 const html = await response.text();
 const results = [];

 // Multi-strategy extraction
 const strategies = [
 // Strategy 1: b_algo class (classic Bing)
 { regex: /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi, extract: (block) => {
 const tm = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
 const dm = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
 return tm ? { title: tm[2].replace(/<[^>]+>/g, '').trim(), url: tm[1], snippet: (dm ? dm[1].replace(/<[^>]+>/g, '').trim() : '') } : null;
 }},
 // Strategy 2: b_caption + b_attribution (new Bing)
 { regex: /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi, extract: (block) => {
 const tm = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
 const dm = block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
 return tm ? { title: tm[2].replace(/<[^>]+>/g, '').trim(), url: tm[1], snippet: (dm ? dm[1].replace(/<[^>]+>/g, '').trim() : '') } : null;
 }},
 // Strategy 3: generic link extraction
 // eslint-disable-next-line no-unused-vars
 { regex: /<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, extract: (block) => null, useGlobal: true },
 ];

 for (const strategy of strategies) {
 if (strategy.useGlobal) {
 const globalRegex = /<a[^>]*href="(https?:\/\/(?!.*bing\.com|.*microsoft\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
 let m;
 const seen = new Set();
 while ((m = globalRegex.exec(html)) !== null && results.length < num) {
 const title = m[2].replace(/<[^>]+>/g, '').trim();
 const url = m[1];
 if (title.length > 5 && title.length < 200 && !seen.has(url) && !url.includes('bing.com')) {
 seen.add(url);
 results.push({ title, url, snippet: '' });
 }
 }
 break;
 }

 strategy.regex.lastIndex = 0;
 let match;
 while ((match = strategy.regex.exec(html)) !== null && results.length < num) {
 const item = strategy.extract(match[1] || match[0]);
 if (item && item.title && item.url && !results.find(r => r.url === item.url)) {
 results.push(item);
 }
 }
 if (results.length >= 3) break;
 }

 if (results.length > 0) {
 return { query, results, backend: this.name, method: 'http' };
 }
 } catch (err) {
 console.warn('[search-backend-manager] Bing URL failed:', err.message);
 continue;
 }
 }

 throw new Error('Bing: all strategies exhausted');
 }
}

// ─── Tavily 后端 ─────────────────────────────────────────────

// Bing API (Azure Cognitive Services)

class BingApiBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'bing_api', type: 'api', priority: 70, timeout: 10000, tags: ['general', 'chinese', 'news', 'agent-friendly'], ...config });
 this.apiEndpoint = config.endpoint || 'https://api.bing.microsoft.com/v7.0/search';
 this.market = config.market || 'zh-CN';
 }

 isAvailable() { return this.enabled && !!this.apiKey; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const freshness = options.freshness || '';
 const mkt = options.market || this.market;
 const url = this.apiEndpoint + '?q=' + encodeURIComponent(query) +
 '&count=' + num +
 '&mkt=' + mkt +
 '&responseFilter=webpages' +
 (freshness ? '&freshness=' + freshness : '');

 const response = await fetch(url, {
 headers: {
 'Ocp-Apim-Subscription-Key': this.apiKey,
 'Accept': 'application/json',
 },
 signal: AbortSignal.timeout(this.timeout),
 });

 if (!response.ok) throw new Error('Bing API HTTP ' + response.status);

 const data = await response.json();
 const results = (data.webPages?.value || []).slice(0, num).map(r => ({
 title: r.name || '',
 url: r.url || '',
 snippet: r.snippet || '',
 date: r.dateLastCrawled || '',
 source: r.displayUrl || '',
 }));

 return { query, results, backend: this.name, method: 'api', total: data.webPages?.totalEstimatedMatches || 0 };
 }
}

class TavilyBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'tavily', type: 'api', priority: 80, tags: ['agent-friendly', 'academic', 'news'], ...config });
 }

 isAvailable() { return this.enabled && !!this.apiKey; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const response = await fetch('https://api.tavily.com/search', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({
 api_key: this.apiKey,
 query,
 max_results: num,
 include_answer: true,
 search_depth: options.depth || 'basic',
 }),
 signal: AbortSignal.timeout(this.timeout),
 });

 if (!response.ok) throw new Error(`Tavily API ${response.status}`);

 const data = await response.json();
 const results = (data.results || []).map(r => ({
 title: r.title || '',
 url: r.url || '',
 snippet: r.content || '',
 score: r.score || 0,
 }));

 return {
 query,
 results,
 backend: this.name,
 method: 'api',
 answer: data.answer || null,
 stats: { response_time: data.response_time },
 };
 }
}

// ─── Exa 后端 ────────────────────────────────────────────────

class ExaBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'exa', type: 'api', priority: 75, tags: ['agent-friendly', 'academic', 'neural'], ...config });
 }

 isAvailable() { return this.enabled && !!this.apiKey; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const response = await fetch('https://api.exa.ai/search', {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'x-api-key': this.apiKey,
 },
 body: JSON.stringify({
 query,
 numResults: num,
 type: options.type || 'neural',
 contents: { text: { maxCharacters: 500 } },
 }),
 signal: AbortSignal.timeout(this.timeout),
 });

 if (!response.ok) throw new Error(`Exa API ${response.status}`);

 const data = await response.json();
 const results = (data.results || []).map(r => ({
 title: r.title || '',
 url: r.url || '',
 snippet: r.text || '',
 score: r.score || 0,
 source: r.author || '',
 }));

 return { query, results, backend: this.name, method: 'api' };
 }
}

// ─── Brave 后端 ──────────────────────────────────────────────

class BraveBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'brave', type: 'api', priority: 60, tags: ['general', 'news'], ...config });
 }

 isAvailable() { return this.enabled && !!this.apiKey; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${num}`, {
 headers: { 'X-Subscription-Token': this.apiKey },
 signal: AbortSignal.timeout(this.timeout),
 });

 if (!response.ok) throw new Error(`Brave API ${response.status}`);

 const data = await response.json();
 const results = (data.web?.results || []).map(r => ({
 title: r.title || '',
 url: r.url || '',
 snippet: r.description || '',
 date: r.age || '',
 }));

 return { query, results, backend: this.name, method: 'api' };
 }
}

// ─── SearXNG 后端 ────────────────────────────────────────────

class SearXNGBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'searxng', type: 'self-hosted', priority: 55, tags: ['self-hosted', 'general', 'free'], ...config });
 this.searxngUrl = config.searxngUrl || 'http://localhost:8080';
 }

 isAvailable() { return this.enabled && !!this.searxngUrl; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const url = `${this.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&limit=${num}`;

 const response = await fetch(url, {
 signal: AbortSignal.timeout(this.timeout),
 });

 if (!response.ok) throw new Error(`SearXNG ${response.status}`);

 const data = await response.json();
 const results = (data.results || []).map(r => ({
 title: r.title || '',
 url: r.url || '',
 snippet: r.content || '',
 source: r.engine || '',
 date: r.publishedDate || '',
 }));

 return { query, results, backend: this.name, method: 'self-hosted' };
 }
}

// ─── Playwright 后端（包装现有能力）──────────────────────────

class PlaywrightBackend extends SearchBackend {
 constructor(config = {}) {
 super({ name: 'playwright', type: 'browser', priority: 40, tags: ['chinese', 'js-render', 'general'], ...config });
 this._playwrightSearch = config.playwrightSearch || null;
 }

 isAvailable() { return this.enabled && !!this._playwrightSearch; }

 async search(query, options = {}) {
 const num = options.num || 10;
 const engine = options.engine || null;

 const result = await this._playwrightSearch.multiSearch(query, engine);
 const results = (result.results || []).slice(0, num).map(r => ({
 title: r.title,
 url: r.link,
 snippet: r.desc,
 source: r.source,
 date: r.date,
 }));

 return {
 query,
 results,
 backend: this.name,
 method: 'browser',
 engine: result.engine,
 stats: result.stats,
 };
 }
}

// ─── 后端管理器 ──────────────────────────────────────────────

class SearchBackendManager extends EventEmitter {
 constructor(config = {}) {
 super();
 this._backends = new Map();
 this._defaultScenario = config.defaultScenario || 'general';
 this._maxRetries = config.maxRetries || 4;
 this._scenarioMap = config.scenarioMap || null; // 自定义场景路由

 // 初始化默认后端
 this._initDefaultBackends(config);
 }

 /**
 * 初始化默认后端
 */

// 注：该文件使用 UTF-8 编码，如果看到乱码请检查编辑器编码设置

 _initDefaultBackends(config) {
 // Playwright（如果可用）
 this.register(new PlaywrightBackend({ playwrightSearch: null, enabled: false }));

 // HTTP 后端 — 仅注册实际可用的
 // Baidu: 禁用（实测触发反爬/验证码）
 // DuckDuckGo: 禁用（GFW 完全阻断）
 // SearXNG 公共实例: 禁用（GFW 阻断 9/11 实例）
 this.register(new BaiduBackend({ enabled: false }));
 this.register(new BingBackend({ enabled: true }));
 this.register(new DuckDuckGoBackend({ enabled: false }));
 this.register(new SearXNGPublicBackend({ enabled: false }));

 // API 后端（需要 API Key）
 // 2026-08-19: 百度千帆 AI 搜索(免费 1500 次/月, 中文最优)——BAIDU_API_KEY
 if (config.baiduApiKey || process.env.BAIDU_API_KEY) {
 this.register(new BaiduApiBackend({ apiKey: config.baiduApiKey || process.env.BAIDU_API_KEY }));
 }
 if (config.tavilyApiKey || process.env.TAVILY_API_KEY) {
 this.register(new TavilyBackend({ apiKey: config.tavilyApiKey || process.env.TAVILY_API_KEY }));
 }
 if (config.exaApiKey || process.env.EXA_API_KEY) {
 this.register(new ExaBackend({ apiKey: config.exaApiKey || process.env.EXA_API_KEY }));
 }
 if (config.bingApiKey || process.env.BING_API_KEY) {
 this.register(new BingApiBackend({ apiKey: config.bingApiKey || process.env.BING_API_KEY }));
 }
if (config.braveApiKey || process.env.BRAVE_API_KEY) {
 this.register(new BraveBackend({ apiKey: config.braveApiKey || process.env.BRAVE_API_KEY }));
 }
 if (config.searxngUrl || process.env.SEARXNG_URL) {
 this.register(new SearXNGBackend({ searxngUrl: config.searxngUrl || process.env.SEARXNG_URL }));
 }

 // RSS 缓存后端（本地缓存，零延迟）
 }

 /**
 * 注册后端
 */
 register(backend) {
 if (!(backend instanceof SearchBackend)) {
 throw new Error('后端必须是 SearchBackend 的实例');
 }
 this._backends.set(backend.name, backend);
 this.emit('registered', backend.name);
 return this;
 }

 /**
 * 注销后端
 */
 unregister(name) {
 const removed = this._backends.delete(name);
 if (removed) this.emit('unregistered', name);
 return removed;
 }

 /**
 * 获取后端
 */
 getBackend(name) {
 return this._backends.get(name) || null;
 }

 /**
  * 2026-08-31 修复(网络搜索恒失败): web-tools(_syncSearchCredentials/_ensureApiBackends)
  * 与 config-handler(保存即时生效)均调用本静态方法, 但类从未实现——
  * "SearchBackendManager.syncCredentials is not a function"(实测 9 连败)。
  * 语义: 外部凭据同步进共享 manager(web-tools.getSearchManager)——已有后端更新
  * apiKey, 缺失则注册新后端; 空键保持现状。config 页面保存即生效, 不依赖重启。
  */
 static syncCredentials({ jinaKey, braveKey, tavilyKey, baiduKey, bingKey, exaKey } = {}) {
   if (jinaKey) _jinaKey = jinaKey;
   // 惰性 require——core/search ← tools/web-tools 的循环依赖在运行期自然解开
   const { __getManagerInstance, getSearchManager } = require('../../tools/web-tools');
   // 优先取已构造实例——经 getSearchManager() 会再入 _ensureApiBackends→本方法(循环)
   const manager = __getManagerInstance() || getSearchManager();
   const specs = [
     ['baidu', baiduKey, 'baidu_api', BaiduApiBackend],
     ['tavily', tavilyKey, 'tavily', TavilyBackend],
     ['bing', bingKey, 'bing_api', BingApiBackend],
     ['brave', braveKey, 'brave', BraveBackend],
     ['exa', exaKey, 'exa', ExaBackend],
   ];
   for (const [, keyVal, backendName, BackendCtor] of specs) {
     const current = manager.getBackend(backendName);
     if (!keyVal) continue;
     if (current) { current.apiKey = keyVal; continue; }
     manager.register(new BackendCtor({ apiKey: keyVal }));
   }
   return manager;
 }

 /**
 * 列出所有后端
 */
 listBackends() {
 return Array.from(this._backends.values()).map(b => ({
 name: b.name,
 type: b.type,
 priority: b.priority,
 enabled: b.enabled,
 available: b.isAvailable(),
 tags: b.tags,
 }));
 }

 /**
 * 检测查询场景
 * @param {string} query 查询词
 * @returns {string} 场景标签
 */
 detectScenario(query) {
 // 自定义路由
 if (this._scenarioMap) {
 for (const [pattern, scenario] of Object.entries(this._scenarioMap)) {
 if (new RegExp(pattern, 'i').test(query)) return scenario;
 }
 }

 // 内置场景检测
 // 2026-09-06 修复: 中文场景词改包含匹配——旧写法把中文词也放进 \b(...)，而 JS \b
 // 只认 [A-Za-z0-9_] 词字符、中文字符间无词边界，\b(新闻|最新|...)\b 对纯中文查询
 // 永不命中 → "最新AI资讯"恒落 chinese 场景 → 千帆 search_mode 走 normal 而非
 // news，新闻时效排序失效（实测返回混 6 月旧文与频道首页）。英文词维持 \b
 //（避免 "newest" 误命中 "new" 类子串）；学术/技术行的中文词同病但改口语影响
 // 面大（"研究"会误入 academic 模式），本轮不动。
 const q = query.toLowerCase();

 // 学术
 if (/\b(paper|arxiv|论文|研究|research|journal|citation|引用)\b/.test(q)) return 'academic';
 // 新闻
 if (/\b(news|latest|today|breaking)\b/.test(q) || /(新闻|最新|今天|今日|昨日|资讯|热点|动态|头条|快讯)/.test(q)) return 'news';
 // 技术
 if (/\b(github|stackoverflow|文档|docs|api|教程|tutorial|how to|怎么|如何)\b/.test(q)) return 'technical';
 // 中文
 if (/[\u4e00-\u9fff]/.test(q)) return 'chinese';

 return 'general';
 }

 /**
 * 选择最佳后端
 * @param {string} scenario 场景
 * @param {Object} options 选项
 * @returns {SearchBackend[]}
 */
 selectBackends(scenario, options = {}) {
 const preferred = options.preferred || null;
 const available = Array.from(this._backends.values())
 .filter(b => b.isAvailable());

 if (available.length === 0) return [];

 // 如果指定了首选后端
 if (preferred && this._backends.has(preferred) && this._backends.get(preferred).isAvailable()) {
 const preferredBackend = this._backends.get(preferred);
 const others = available.filter(b => b.name !== preferred).sort((a, b) => b.priority - a.priority);
 return [preferredBackend, ...others];
 }

 // 按场景匹配 + 优先级排序
 const scored = available.map(b => {
 let score = b.priority;
 if (b.matchesScenario(scenario)) score += 50;
 // Network-aware: boost reliable backends, strongly penalize known-blocked ones
 // API backends: highest priority (用户配置的 API Key，最可靠)
 if (b.name === "tavily") score += 100; // Tavily API: 国内直连，最优先
 if (b.name === "bing_api") score += 95; // Bing API: Azure 官方，国内直连
 // HTTP backends
 if (b.name === "bing") score += 25; // Bing: most reliable HTTP backend in China
 if (b.name === "duckduckgo") score -= 80; // Completely blocked in China, never use
 if (b.name === "searxng_public") score -= 60; // Public instances unreachable in China
 if (b.name === "baidu" && b.type === "http") score -= 30; // Baidu HTTP always returns CAPTCHA in China
 return { backend: b, score };
 });

 scored.sort((a, b) => b.score - a.score);
 return scored.map(s => s.backend);
 }

 /**
 * 执行搜索 — 两层级联（Tier 1 付费 API 串行 + Tier 2 免费引擎并行竞速）
 *
 * 自主实现 `execWebSearch` 架构：
 * 1. 先串行尝试已配置的付费 API 后端（Serper/Brave/Tavily/SearXNG）
 * 2. 全部失败后并行竞速免费引擎（Jina/Bing/DDG）
 * 3. 全部失败返回带 hints 的详细错误
 *
 * @param {string} query 查询词
 * @param {Object} options 选项
 * @returns {Promise<SearchResponse>}
 */
 async search(query, options = {}) {
 const limit = Math.max(1, Math.min(Number(options.num) || 5, 8));
 const scenario = options.scenario || this.detectScenario(query);

 // 检查缓存（10min TTL, LRU 200条）
 const cacheKey = `${query}::${scenario}::${limit}`;
 const cached = searchCacheGet(cacheKey);
 if (cached) return { ...cached, cached: true };

 console.log(`[search] 查询: ${truncateForLog(query)} (场景: ${scenario})`);

 // ─── TIER 1: 付费 API 后端（串行） ─────────────────
 // 使用已有的 backends 选择逻辑，但只选 type 为 'api' 或 'self-hosted' 的后端
 const allBackends = this.selectBackends(scenario, { preferred: options.backend });
 const tier1Backends = allBackends.filter(b =>
 b.isAvailable() && (b.type === 'api' || b.type === 'self-hosted')
 );
 const failures = [];

 for (const backend of tier1Backends) {
 try {
 const result = await backend.search(query, { ...options, num: limit });
 this.emit('search:success', { backend: backend.name, scenario, query });
 // 缓存结果
 const payload = { ok: true, tool: 'WebSearch', query, source: backend.name, results: result.results, hint: SEARCH_ANSWER_HINT };
 searchCacheSet(cacheKey, payload);
 return { ...result, hint: SEARCH_ANSWER_HINT };
 } catch (err) {
 failures.push({ engine: backend.name, reason: err.message });
 this.emit('search:fallback', { backend: backend.name, error: err.message });
 console.log(`[search] ${backend.name} 失败: ${err.message}`);
 }
 }

 // ─── TIER 2: 免费引擎并行竞速 ────────────────────
 console.log(`[search] Tier 1 全部失败，启动免费引擎并行竞速...`);
 const tier2 = [
 ['bing', searchViaBing],
 ['jina', (...args) => searchViaJina(...args, { jinaKey: _jinaKey })],
 ['ddg', searchViaDDG],
 ];

 try {
 const raced = await SearchBackendManager.raceFreeEngines(tier2, query, limit, null, failures);
 if (raced && raced.ok) {
 const payload = buildSearchPayload(query, raced);
 searchCacheSet(cacheKey, payload);
 return {
 query,
 results: raced.results,
 backend: raced.source,
 method: 'http',
 hint: SEARCH_ANSWER_HINT,
 };
 }
 } catch (err) {
 if (err.name === 'AbortError') throw err;
 failures.push({ engine: 'free-race', reason: err.message });
 }

 // ─── 全部失败 ─────────────────────────────────────
 const summary = failures.length
 ? failures.map(f => `${f.engine}: ${f.reason}`).join('; ')
 : '未配置任何搜索引擎';
 return {
 query, results: [],
 backend: 'none', method: 'none',
 error: `所有搜索引擎均失败 (${summary})`,
 failures,
 hint: '尝试使用 fetch_url 直接获取已知 URL，或在设置中配置 Serper/Tavily/Brave API Key 以获得可靠的搜索服务。',
 };
 }

 /**
 * 运行两层级联搜索（与 search 相同逻辑，作为显式方法公开）
 */
 async tieredSearch(query, options = {}) {
 return this.search(query, options);
 }
}


module.exports = {
 SearchBackend,
 BaiduBackend,
 SearXNGPublicBackend,
 DuckDuckGoBackend,
 BingBackend,
 BingApiBackend,
 TavilyBackend,
 ExaBackend,
 BraveBackend,
 SearXNGBackend,
 PlaywrightBackend,
 SearchBackendManager,
};
