/**
 * Trending — 启动时热点采集 + 上下文注入
 *
 * 自主实现 trending.js + geo-weather.js 的启动采集模式。
 * 在 Server 启动时采集微博/知乎热点，注入系统 prompt。
 *
 * 数据源（免费，无需 API Key）：
 * - 微博：vvhan API (https://api.vvhan.com/api/hotlist/wbHot)
 * - 知乎：vvhan API (https://api.vvhan.com/api/hotlist/zhihuHot)
 * - 非中国：HackerNews + Reddit worldnews
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const CACHE_FILE = path.join(DATA_DIR, 'trending.json');
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const STARTUP_TIMEOUT_MS = 12000; // 启动时最长等待

let _cached = { items: [], fetchedAt: 0, countryCode: 'CN' };

// ─── VVH 系列 API（免费，无需 Key） ─────────────────────

async function fetchFromVVhan(endpoint) {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 8000);
 try {
 const res = await fetch(`https://api.vvhan.com/api/hotlist/${endpoint}`, {
 signal: controller.signal,
 headers: { 'User-Agent': 'Mozilla/5.0 CrabPaw/2.0' },
 });
 clearTimeout(timer);
 if (!res.ok) return null;
 const data = await res.json();
 return data;
 } catch {
 clearTimeout(timer);
 return null;
 }
}

async function fetchWeiboTrending() {
 // 优先使用现有 trending-scraper
 try {
 const scraper = require('./trending-scraper');
 if (typeof scraper.fetchWeiboHotSearch === 'function') {
 const result = await scraper.fetchWeiboHotSearch();
 if (result && result.items && result.items.length > 0) {
 return result.items.map((item, i) => ({
 title: item.title || '',
 hot: item.hot || '',
 rank: i + 1,
 url: item.url || '',
 }));
 }
 }
 } catch (e) {
   /* fallback */
   console.warn('[trending.js] 空 catch 补日志:', e && e.message);
 }
 // 备选：vvhan API
 const data = await fetchFromVVhan('wbHot');
 if (!data || !data.data) return [];
 return (data.data || []).slice(0, 15).map((item, i) => ({
 title: item.title || item.word || '',
 hot: item.hot || item.hotnum || '',
 rank: i + 1,
 url: item.url || '',
 }));
}

async function fetchZhihuTrending() {
 try {
 const scraper = require('./trending-scraper');
 if (typeof scraper.fetchZhihuHot === 'function') {
 const result = await scraper.fetchZhihuHot();
 if (result && result.items && result.items.length > 0) {
 return result.items.map((item, i) => ({
 title: item.title || '',
 hot: item.hot || '',
 rank: i + 1,
 url: item.url || '',
 }));
 }
 }
 } catch (e) {
   /* fallback */
   console.warn('[trending.js] 空 catch 补日志:', e && e.message);
 }
 const data = await fetchFromVVhan('zhihuHot');
 if (!data || !data.data) return [];
 return (data.data || []).slice(0, 15).map((item, i) => ({
 title: item.title || '',
 hot: item.hot || '',
 rank: i + 1,
 url: item.url || '',
 }));
}

async function fetchHNTrending() {
 try {
 const res = await fetch(
 'https://hacker-news.firebaseio.com/v0/topstories.json',
 { signal: AbortSignal.timeout(8000) }
 );
 if (!res.ok) return [];
 const ids = (await res.json()).slice(0, 8);
 const items = await Promise.all(
 ids.map(async (id) => {
 try {
 const r = await fetch(
 `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
 { signal: AbortSignal.timeout(5000) }
 );
 if (!r.ok) return null;
 const d = await r.json();
 return { title: d.title || '', hot: d.score || 0, url: d.url || `https://news.ycombinator.com/item?id=${id}`, rank: 0 };
 } catch { return null; }
 })
 );
 return items.filter(Boolean).map((item, i) => ({ ...item, rank: i + 1 }));
 } catch { return []; }
}

// ─── 主采集 ────────────────────────────────────────────

async function collectTrending(countryCode = 'CN') {
 const sources = [];
 const isChina = countryCode === 'CN';

 if (isChina) {
 // 中国：微博 + 知乎（vvhan 免费 API）
 const [wb, zh] = await Promise.allSettled([
 fetchWeiboTrending(),
 fetchZhihuTrending(),
 ]);

 if (wb.status === 'fulfilled' && wb.value.length > 0) {
 sources.push({ name: '微博热搜', items: wb.value });
 }
 if (zh.status === 'fulfilled' && zh.value.length > 0) {
 sources.push({ name: '知乎热榜', items: zh.value });
 }
 } else {
 // 海外：HN
 const hn = await fetchHNTrending();
 if (hn.length > 0) {
 sources.push({ name: 'HackerNews', items: hn });
 }
 }

 const result = {
 version: 1,
 country_code: countryCode,
 mode: isChina ? 'cn' : 'global',
 sources,
 fetched_at: new Date().toISOString(),
 };

 // 缓存到内存 + 磁盘
 _cached = { items: sources, fetchedAt: Date.now(), countryCode };

 try {
 fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2), 'utf-8');
 } catch (e) {
   /* 磁盘写入失败不阻塞 */
   console.warn('[trending.js] 空 catch 补日志:', e && e.message);
 }

 return result;
}

// ─── 公开 API ──────────────────────────────────────────

function getTrendingBlock() {
 if (!_cached.items || _cached.items.length === 0) return '';
 const elapsed = Date.now() - _cached.fetchedAt;
 if (elapsed > CACHE_TTL_MS) return ''; // 缓存过期

 const lines = ['## 当前热点'];
 for (const source of _cached.items) {
 if (source.items.length === 0) continue;
 lines.push(`\n### ${source.name}`);
 for (const item of source.items.slice(0, 5)) {
 const heat = item.hot ? ` 🔥${item.hot}` : '';
 lines.push(`${item.rank}. ${item.title}${heat}`);
 }
 }
 return lines.join('\n');
}

async function startupCollection() {
 try {
 const result = await Promise.race([
 collectTrending(),
 new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), STARTUP_TIMEOUT_MS)),
 ]);
 const count = result.sources?.reduce((sum, s) => sum + s.items.length, 0) || 0;
 console.log(`📰 启动采集: ${result.sources?.length || 0} 个来源, ${count} 条热点`);
 return result;
 } catch (e) {
 console.warn('📰 启动采集超时:', e.message);
 return null;
 }
}

module.exports = {
 collectTrending,
 getTrendingBlock,
 startupCollection,
 fetchWeiboTrending,
 fetchZhihuTrending,
 fetchHNTrending,
};
