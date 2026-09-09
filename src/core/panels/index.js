/**
 * Panels — 信息面板统一入口
 *
 * 整合天气 (WeatherPanel)、热点 (HotspotPanel)、系统状态 (StatusPanel)，
 * 对外暴露统一的初始化、注册、获取、渲染接口。
 *
 * 设计理念多种信息面板：
 * 热点面板 | 天气卡片 | 文档面板 | 人物卡片 | 媒体舞台 | 状态展示
 * CrabPaw 作为 CLI Agent，面板以终端格式输出，未来可扩展 HTTP/SSE 推送。
 */

const { globalWeatherPanel } = require('./weather');
const { globalHotspotPanel } = require('./hotspot');
const { globalStatusPanel } = require('./status');
const { globalMemoryGraph } = require('./memory-graph');
const { globalTyphoonPanel } = require('./typhoon');
const { globalStockPanel } = require('./stock');

// ─── 实时同步：监听 memory-system 事件，自动清除图谱缓存 ───
// 风格：新增记忆时节点图谱应立即反映
try {
 const { memoryManager } = require('../memory-system');
 if (memoryManager) {
 memoryManager.on('memory:added', () => {
 try { globalMemoryGraph.clearCache(); } catch (_) {
   /* 静默 */
   console.warn('[index.js] 空 catch 补日志:', _ && _.message);
 }
 });
 memoryManager.on('memory:updated', () => {
   try { globalMemoryGraph.clearCache(); } catch (_) {
     /* 静默 */
     console.warn('[index.js] 空 catch 补日志:', _ && _.message);
   }

 });
 memoryManager.on('memory:removed', () => {
 try { globalMemoryGraph.clearCache(); } catch (_) {
   /* 静默 */
   console.warn('[index.js] 空 catch 补日志:', _ && _.message);
 }
 });
 console.log('[panels] Memory graph cache auto-clear listener installed');
 }
} catch (e) {
 console.warn('[panels] Failed to install memory auto-clear listener:', e.message);
}

// ─── 内置面板注册表 ───
const _panels = new Map();

/**
 * 注册一个面板
 */
function registerPanel(name, panel, meta = {}) {
 _panels.set(name, { panel, meta });
}

/**
 * 获取所有已注册面板
 */
function getPanels() {
 const result = {};
 // eslint-disable-next-line no-unused-vars
 for (const [name, { panel, meta }] of _panels) {
 result[name] = { name, ...meta };
 }
 return result;
}

/**
 * 初始化所有面板
 */
async function initializePanels() {
 // 注册内置面板
 registerPanel('weather', globalWeatherPanel, {
 label: '天气',
 icon: '🌤',
 description: '实时天气与预报（数据源: wttr.in）',
 });

 registerPanel('status', globalStatusPanel, {
 label: '系统状态',
 icon: '📊',
 description: 'CrabPaw 运行时状态',
 });

 registerPanel('hotspot', globalHotspotPanel, {
 label: '热点',
 icon: '🔥',
 description: '多平台热搜趋势',
 });

 registerPanel('memory_graph', globalMemoryGraph, {
 label: '记忆图谱',
 icon: '🧠',
 description: '记忆实体关系网络可视化',
 });

 registerPanel('typhoon', globalTyphoonPanel, {
 label: '台风追踪',
 icon: '🌀',
 description: '台风路径轨迹/风圈/登陆点（数据源: 浙江水利厅实时发布系统 + apizero 备源）',
 });

 registerPanel('stock', globalStockPanel, {
 label: '股票行情',
 icon: '📈',
 description: '股票实时行情列表 + K线（数据源: 东方财富四源冗余）',
 });

 // 注册热点数据源（如果 trending-scraper 可用）
 try {
 const scraper = require('../../core/trending-scraper');

 // 微博
 if (typeof scraper.fetchWeiboHotSearch === 'function') {
 globalHotspotPanel.register('weibo', scraper.fetchWeiboHotSearch, {
 label: '微博热搜', icon: '🔴',
 });
 }

 // 知乎 — 导出名为 fetchZhihuHot
 // 2026-08-16 数据链审计 #1: 数据已降级为 hotdata 'nethot'(综合网络热榜,
 // 知乎直连源 401 需登录) — 标签诚实显示真实数据源, 不再伪装"知乎热榜"。
 if (typeof scraper.fetchZhihuHot === 'function') {
 globalHotspotPanel.register('zhihu', scraper.fetchZhihuHot, {
 label: '综合热榜', icon: '🔵',
 });
 }

 // 百度 — 导出名为 fetchBaiduTrending
 if (typeof scraper.fetchBaiduTrending === 'function') {
 globalHotspotPanel.register('baidu', scraper.fetchBaiduTrending, {
 label: '百度热搜', icon: '🟣',
 });
 }

 // 头条
 if (typeof scraper.fetchToutiaoHot === 'function') {
 globalHotspotPanel.register('toutiao', scraper.fetchToutiaoHot, {
 label: '头条热点', icon: '🟠',
 });
 }

 // 抖音
 if (typeof scraper.fetchDouyinHot === 'function') {
 globalHotspotPanel.register('douyin', scraper.fetchDouyinHot, {
 label: '抖音热点', icon: '⬛',
 });
 }

 // 小红书
 if (typeof scraper.fetchXiaohongshuHot === 'function') {
 globalHotspotPanel.register('xiaohongshu', scraper.fetchXiaohongshuHot, {
 label: '小红书', icon: '🔴',
 });
 }

 // 微信热点
 if (typeof scraper.fetchWechatHot === 'function') {
 globalHotspotPanel.register('wechat', scraper.fetchWechatHot, {
 label: '微信热点', icon: '🟢',
 });
 }

 // V2EX 热帖
 if (typeof scraper.fetchV2exHot === 'function') {
 globalHotspotPanel.register('v2ex', scraper.fetchV2exHot, {
 label: 'V2EX 热帖', icon: '💻',
 });
 }

 // 雪球热帖
 // 2026-08-16 数据链审计 #2: 数据已降级为东方财富股票涨幅榜(雪球接口需登录
 // cookie 返回 400016) — 标签诚实显示真实数据源, 不再伪装"雪球热帖"。
 if (typeof scraper.fetchXueqiuHot === 'function') {
 globalHotspotPanel.register('xueqiu', scraper.fetchXueqiuHot, {
 label: '股市涨幅', icon: '💰',
 });
 }
 } catch (e) {

   // trending-scraper 不可用时静默降级

   console.warn('[index.js] 空 catch 补日志:', e && e.message);
 }

 console.log(`📊 面板系统已初始化 (${_panels.size} 面板, ${globalHotspotPanel.platforms.length} 热点源)`);
}

// ─── 导出面板实例 ───
// 2026-08-16 修复: 删除模块加载时的自动 initializePanels()——init.js 启动链已
// 显式 await initializePanels(), 两处同时执行导致热点源重复注册两遍(9→18 平台),
// 全量抓取翻倍(串行 9 平台 → 30s+)。注册只由启动链执行一次。

module.exports = {
 weather: globalWeatherPanel,
 hotspot: globalHotspotPanel,
 status: globalStatusPanel,
 memoryGraph: globalMemoryGraph,
 typhoon: globalTyphoonPanel,
 stock: globalStockPanel,
 initializePanels,
 registerPanel,
 getPanels,
};
