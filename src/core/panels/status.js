/**
 * Status Panel — 系统状态面板
 *
 * 展示 CrabPaw 运行时的关键指标：
 * - 记忆系统状态（节点数、关系数、最近合并）
 * - TTS 引擎状态（可用 Provider、总请求数）
 * - 技能系统状态（已加载数、活跃数）
 * - 工具系统状态（注册工具数、调用统计）
 * - 活动流状态
 * - LLM 调用统计
 *
 * /status 页面 + memory audit 统计
 */


const process = require('process');

class StatusPanel {
 constructor() {
 this._checkFns = new Map();
 this._registerDefaults();
 }

 /**
 * 注册状态检查函数
 * @param {string} name 检查项名
 * @param {function} fn 异步函数，返回 { status, detail, metrics? }
 * @param {string} category 分类
 */
 register(name, fn, category = 'system') {
 this._checkFns.set(name, { fn, category });
 }

 /**
 * 获取完整状态报告
 * @returns {Promise<object>}
 */
 async getStatus() {
 const results = {};

 for (const [name, { fn, category }] of this._checkFns) {
 try {
 const result = await fn();
 results[name] = { ...result, category };
 } catch (e) {
 results[name] = {
 status: 'error',
 detail: e.message,
 category,
 };
 }
 }

 return {
 ts: Date.now(),
 uptime: process.uptime(),
 memory: this._getMemoryInfo(),
 platform: process.platform,
 nodeVersion: process.version,
 checks: results,
 };
 }

 /**
 * 渲染为终端文本
 */
 async render() {
 const status = await this.getStatus();
 const uptime = this._formatUptime(status.uptime);

 const lines = [];
 lines.push('┌── 🦀 CrabPaw 系统状态 ────────────────────┐');
 lines.push(`│ 运行时间: ${uptime} │`);
 lines.push(`│ 内存: ${status.memory.heap}MB / ${status.memory.rss}MB (RSS) │`);
 lines.push(`│ 平台: ${status.platform} · Node ${status.nodeVersion}`);
 lines.push('├────────────────────────────────────────────┤');

 // 按分类展示
 const categories = new Map();
 for (const [name, check] of Object.entries(status.checks)) {
 const cat = check.category || 'other';
 if (!categories.has(cat)) categories.set(cat, []);
 categories.get(cat).push({ name, ...check });
 }

 for (const [cat, checks] of categories) {
 lines.push(`│ [${cat}]`);
 for (const c of checks) {
 const icon = c.status === 'healthy' || c.status === 'ok' ? '✅'
 : c.status === 'warning' ? '⚠️'
 : c.status === 'error' ? '❌' : '➖';
 const detail = c.detail ? ` — ${c.detail}` : '';
 lines.push(`│ ${icon} ${c.name}${detail}`);
 if (c.metrics) {
 for (const [k, v] of Object.entries(c.metrics)) {
 lines.push(`│ ${k}: ${v}`);
 }
 }
 }
 }

 lines.push('└────────────────────────────────────────────┘');
 return lines.join('\n');
 }

 /**
 * 渲染为紧凑摘要
 */
 async renderCompact() {
 const status = await this.getStatus();
 const healthy = Object.values(status.checks).filter(c => c.status === 'healthy' || c.status === 'ok').length;
 const total = Object.keys(status.checks).length;
 return `[状态] 运行 ${this._formatUptime(status.uptime)} | 内存 ${status.memory.heap}MB | ${healthy}/${total} 正常`;
 }

 // ─── 默认检查项 ───

 _registerDefaults() {
 this.register('process', async () => ({
 status: 'ok',
 detail: `PID ${process.pid}`,
 }), 'system');

 this.register('event_bus', async () => {
 try {
 const bus = require('../event-bus');
 const stats = bus.getStats();
 return {
 status: 'ok',
 detail: `${stats.totalEvents} 事件, ${Object.keys(stats.subscriberCounts || {}).length} 订阅者`,
 };
 } catch {
 return { status: 'warning', detail: '不可用' };
 }
 }, 'system');

 this.register('activity_state', async () => {
 try {
 const { globalActivityState } = require('../activity-state');
 const diag = globalActivityState.getDiagnostics();
 return {
 status: 'ok',
 detail: `${diag.current} (${(diag.elapsed / 1000).toFixed(1)}s)`,
 metrics: { stateChanges: diag.historyCount },
 };
 } catch {
 return { status: 'warning', detail: '不可用' };
 }
 }, 'system');

 this.register('memory', async () => {
 try {
 const { getMemoryTreeOrchestrator } = require('../memory/memory-tree-v2');
 const orch = getMemoryTreeOrchestrator();
 const stats = orch.getStats ? orch.getStats() : {};
 return {
 status: stats.nodeCount > 0 ? 'ok' : 'warning',
 detail: `${stats.nodeCount || 0} 节点`,
 metrics: {
 relationships: stats.relationshipCount || 0,
 trees: stats.treeCount || 0,
 },
 };
 } catch {
 return { status: 'warning', detail: '不可用' };
 }
 }, 'memory');

 this.register('tts', async () => {
 try {
 const { getTextToSpeechEngine, TTS_PROVIDERS: _TTS_PROVIDERS } = require('../tts');
 const engine = getTextToSpeechEngine();
 const providers = engine.getProviders();
 const stats = engine.getStats();
 const available = providers.filter(p => p.available).length;
 return {
 status: available > 0 ? 'ok' : 'warning',
 detail: `${available}/${providers.length} 可用`,
 metrics: {
 totalRequests: stats.totalRequests,
 successRate: stats.totalRequests > 0
 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) + '%'
 : 'N/A',
 },
 };
 } catch {
 return { status: 'warning', detail: '不可用' };
 }
 }, 'tts');

 this.register('tools', async () => {
 try {
 const { getToolRegistry } = require('../toolset-manager');
 const registry = getToolRegistry();
 const tools = registry.listTools ? registry.listTools() : [];
 return {
 status: 'ok',
 detail: `${tools.length} 工具已注册`,
 };
 } catch {
 return { status: 'warning', detail: '不可用' };
 }
 }, 'tools');

 this.register('scheduler', async () => {
 try {
 const { getScheduler } = require('../scheduler');
 const sched = getScheduler();
 const count = sched.getScheduledTasks ? sched.getScheduledTasks().length : '?';
 return {
 status: 'ok',
 detail: `${count} 定时任务`,
 };
 } catch {
 return { status: 'warning', detail: '不可用' };
 }
 }, 'tasks');
 }

 _getMemoryInfo() {
 const usage = process.memoryUsage();
 return {
 rss: Math.round(usage.rss / 1024 / 1024),
 heap: Math.round(usage.heapUsed / 1024 / 1024),
 heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
 external: Math.round(usage.external / 1024 / 1024),
 };
 }

 _formatUptime(seconds) {
 if (!seconds || seconds < 0) return '0s';
 const d = Math.floor(seconds / 86400);
 const h = Math.floor((seconds % 86400) / 3600);
 const m = Math.floor((seconds % 3600) / 60);
 const s = Math.floor(seconds % 60);
 const parts = [];
 if (d > 0) parts.push(`${d}d`);
 if (h > 0) parts.push(`${h}h`);
 if (m > 0) parts.push(`${m}m`);
 parts.push(`${s}s`);
 return parts.join(' ');
 }
}

// 全局单例
const globalStatusPanel = new StatusPanel();

module.exports = {
 StatusPanel,
 globalStatusPanel,
};
