/**
 * Hotspot Panel — 热点信息面板
 *
 * 基于 CrabPaw 已有的 trending-scraper.js 封装，增加缓存、渲染和面板接口。
 * 覆盖平台：微博、知乎、百度、抖音
 *
 * 热点面板（小红书/抖音/微信/微博 + 30min 刷新间隔 + TTL）
 */

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟（一致）
const ERROR_CACHE_TTL_MS = 60 * 1000; // 2026-08-16: 失败结果短缓存 60s——失败不缓存
 // 会每次请求都重等慢源超时(如 v2ex 20s), 轮询 30s 一次, 面板反复挂起。
 // 60s 后自动重试, 保留自愈能力。

class HotspotPanel {
 constructor() {
 this._cache = new Map();
 this._fetching = new Map(); // 防并发请求
 this._platforms = [];
 }

 /**
 * 注册数据源抓取函数
 * @param {string} name 数据源名（如 'weibo'）
 * @param {function} fetcher 异步抓取函数，返回 [{title, heat, url}] 数组
 * @param {object} meta 元信息 { label, icon, color }
 */
 register(name, fetcher, meta = {}) {
 this._platforms.push({ name, fetcher, meta });
 }

 /**
 * 获取指定平台的热点
 * @param {string} platform 平台名
 * @param {boolean} forceRefresh 强制刷新
 * @returns {Promise<{platform, items, fetchedAt}>}
 */
 async getHotspot(platform, forceRefresh = false) {
 const cached = this._cache.get(platform);
 if (!forceRefresh && cached && Date.now() - cached.ts < (cached.ttl || CACHE_TTL_MS)) {
 return cached.data;
 }

 // 防重入：同一平台正在抓取中等
 if (this._fetching.has(platform)) {
 return this._fetching.get(platform);
 }

 const fetcher = this._platforms.find(p => p.name === platform)?.fetcher;
 if (!fetcher) {
 throw new Error(`未知热点平台: ${platform}`);
 }

 const promise = (async () => {
 try {
 const raw = await fetcher();
 const items = Array.isArray(raw) ? raw : (raw?.items || []);
 const result = {
 platform,
 items,
 fetchedAt: Date.now(),
 };
 // 2026-08-16 数据链审计 #5: 错误透传——trending-scraper 的 fetcher 失败时
 // 返回 {source, error: msg, items: []}(内部 catch 不抛), 此前 error 被丢弃 →
 // 前端 _error 恒空, "N 个源异常"计数永远 0, 平台列表显示"暂无数据"而非原因。
 // 透传到 result._error, 前端失败卡/统计卡/重试按钮全部激活。
 if (raw && typeof raw === 'object' && raw.error && items.length === 0) {
   result._error = raw.error;
 }
 // 2026-08-16 数据链审计 #5: 空结果不缓存——抓取失败(fetcher 返回 items:[])
 // 此前也写入 30min 缓存, 面板恒"暂无数据", 30s 轮询无法自愈(只能点"重试"绕过)。
 // 仅成功结果进缓存, 下次轮询自动重试。
 if (items.length > 0) {
   this._cache.set(platform, { data: result, ts: Date.now() });
 } else if (result._error) {
   // 2026-08-16: 失败也短缓存 60s——纯"失败不缓存"导致每次轮询都重等
   // 慢源超时(v2ex 20s), 并行抓取被最慢源拖累, 面板反复挂起。
   // 60s 后自动过期重试, 自愈能力保留。
   this._cache.set(platform, { data: result, ts: Date.now(), ttl: ERROR_CACHE_TTL_MS });
 }
 return result;
 } finally {
 this._fetching.delete(platform);
 }
 })();

 this._fetching.set(platform, promise);
 return promise;
 }

 /**
 * 获取所有平台的最新热点
 * @param {boolean} forceRefresh
 * @returns {Promise<Array>}
 */
 async getAllHotspots(forceRefresh = false) {
   // 2026-08-16 修复: 并行化——旧实现 for-await 串行抓 9 平台,
   // 降级链最坏 20s/平台, 首开面板 30s+ 无数据。并发后总耗时 = 最慢平台。
   // getHotspot 内部已有 _fetching 防重入, 并发调用安全。
   const results = await Promise.all(this._platforms.map(async (p) => {
     try {
       const data = await this.getHotspot(p.name, forceRefresh);
       data._meta = p.meta;
       return data;
     } catch (e) {
       return { platform: p.name, items: [], _error: e.message, _meta: p.meta };
     }
   }));
   return results;
 }

 /**
 * 将热点数据渲染为终端文本
 */
 render(data) {
 if (!data || !data.items || data.items.length === 0) {
 return `${data?._meta?.icon || '📊'} ${data?.platform || '热点'} 数据不可用`;
 }

 const meta = data._meta || {};
 const label = meta.label || data.platform || '热点';
 const icon = meta.icon || '📊';

 const lines = [];
 lines.push(`┌── ${icon} ${label} ${new Date(data.fetchedAt || Date.now()).toLocaleTimeString()} ──────┐`);

 const maxShow = 15;
 for (let i = 0; i < Math.min(data.items.length, maxShow); i++) {
 const item = data.items[i];
 const rank = (i + 1).toString().padStart(2, ' ');
 const title = item.title || '';
 const heat = item.heat ? ` 🔥${item.heat}` : '';
 // 控制单行长度
 const line = `${rank}. ${title}${heat}`;
 if (line.length > 60) {
 lines.push(` ${line.slice(0, 58)}..`);
 } else {
 lines.push(` ${line}`);
 }
 }

 if (data.items.length > maxShow) {
 lines.push(` ... 还有 ${data.items.length - maxShow} 条`);
 }

 if (data._error) {
 lines.push(` ⚠️ ${data._error}`);
 }

 lines.push('└' + '─'.repeat(36) + '┘');
 return lines.join('\n');
 }

 /**
 * 渲染为紧凑摘要（注入 prompt）
 */
 renderCompact(data) {
 if (!data || !data.items || data.items.length === 0) return '';
 const top3 = data.items.slice(0, 3).map(i => i.title).join('、');
 return `[${data._meta?.label || data.platform}] ${top3} 等 ${data.items.length} 条`;
 }

 /**
 * 清除缓存
 */
 clearCache() { this._cache.clear(); }

 /**
 * 获取已注册平台列表
 */
 get platforms() {
 return this._platforms.map(p => ({
 name: p.name,
 meta: p.meta,
 }));
 }

 // 2026-08-16 数据链审计 #6: getCacheSync() 已删除——Array.isArray(entry.data)
 // 恒 false(entry.data 是 {platform, items, fetchedAt} 对象), 永远返回 null;
 // 全库零调用者(panel-state 重构后上下文注入改走 scene surface), 纸面功能。
}

// 全局单例
const globalHotspotPanel = new HotspotPanel();

module.exports = {
 HotspotPanel,
 globalHotspotPanel,
};
