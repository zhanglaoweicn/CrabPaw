'use strict';

/**
 * prefetch-runner.js — Scheduled Prefetch Runner
 *
 * Periodically fetches data and caches it in the prefetch cache.
 * Default tasks: weather, hotspots, system status.
 *

 */




// Default intervals




// ---------------------------------------------------------------------------
// PrefetchRunner
// ---------------------------------------------------------------------------

class PrefetchRunner {

 /**
 * @param {object} cache PrefetchCache instance
 * @param {object} [options]
 * @param {boolean} [options.autoRegisterDefaults=true] Register default tasks
 */
 constructor(cache, options = {}) {
 if (!cache) {
 throw new Error('[prefetch-runner] PrefetchCache instance is required');
 }

 this._cache = cache;
 this._tasks = new Map(); // name -> task descriptor
 this._timers = new Map(); // name -> interval handle
 this._statuses = new Map(); // name -> { lastRun, lastResult, error }

 if (options.autoRegisterDefaults !== false) {
 this._registerDefaultTasks();
 }
 }

 // -----------------------------------------------------------------------
 // Public API
 // -----------------------------------------------------------------------

 /**
 * Register a scheduled prefetch task.
 *
 * @param {string} name Unique task name
 * @param {function} fetcherFn Async function () => data
 * @param {object} [options]
 * @param {number} [options.intervalMs] How often to run in ms
 * @param {string[]} [options.tags=[]] Tags for the cached data
 * @param {number} [options.ttlMs] TTL for cached data (default: same as intervalMs)
 * @param {boolean} [options.runOnRegister] Run immediately on registration
 * @returns {boolean}
 */
 registerTask(name, fetcherFn, options = {}) {
 if (!name) {
 console.warn('[prefetch-runner] registerTask: name is required');
 return false;
 }
 if (typeof fetcherFn !== 'function') {
 console.warn('[prefetch-runner] registerTask: fetcherFn must be a function');
 return false;
 }
 if (this._tasks.has(name)) {
 console.warn('[prefetch-runner] registerTask: task already registered:', name);
 return false;
 }

 const task = {
 name,
 fetcherFn,
 intervalMs: options.intervalMs || 30 * 60 * 1000,
 tags: Array.isArray(options.tags) ? options.tags : [],
 ttlMs: options.ttlMs || options.intervalMs || 30 * 60 * 1000,
 runOnRegister: options.runOnRegister !== false,
 };

 this._tasks.set(name, task);
 this._statuses.set(name, {
 lastRun: null,
 lastResult: null,
 error: null,
 });

 // If already started, schedule the interval
 if (this._running) {
 this._scheduleTask(task);
 }

 // Run immediately if requested
 if (task.runOnRegister) {
 this._executeTask(task);
 }

 return true;
 }

 /**
 * Unregister a task.
 *
 * @param {string} name
 * @returns {boolean}
 */
 unregisterTask(name) {
 if (!this._tasks.has(name)) return false;

 this._stopTaskTimer(name);
 this._tasks.delete(name);
 this._statuses.delete(name);
 return true;
 }

 /**
 * Start all registered tasks.
 */
 start() {
 if (this._running) return;

 this._running = true;

 for (const task of this._tasks.values()) {
 this._scheduleTask(task);
 // Run immediately on start
 this._executeTask(task);
 }
 }

 /**
 * Stop all tasks. Cancels all pending/running tasks gracefully.
 */
 stop() {
 if (!this._running) return;

 this._running = false;

 for (const name of this._timers.keys()) {
 this._stopTaskTimer(name);
 }
 }

 /**
 * Get the status of all tasks (or a specific task).
 *
 * @param {string} [name] Optional task name
 * @returns {object|Array<object>}
 */
 getStatus(name) {
 if (name) {
 const status = this._statuses.get(name);
 const task = this._tasks.get(name);
 if (!task) return null;
 return {
 name,
 intervalMs: task.intervalMs,
 tags: task.tags,
 running: this._timers.has(name),
 ...status,
 };
 }

 const results = [];
 for (const [taskName, task] of this._tasks.entries()) {
 const status = this._statuses.get(taskName) || {};
 results.push({
 name: taskName,
 intervalMs: task.intervalMs,
 tags: task.tags,
 running: this._timers.has(taskName),
 ...status,
 });
 }
 return results;
 }

 /**
 * Manually trigger a single task run.
 *
 * @param {string} name
 * @returns {Promise<boolean>} True if the task ran successfully
 */
 async runTask(name) {
 const task = this._tasks.get(name);
 if (!task) return false;

 await this._executeTask(task);
 return true;
 }

 /**
 * Check if the runner is running.
 *
 * @returns {boolean}
 */
 isRunning() {
 return this._running === true;
 }

 /**
 * Destroy the runner: stop all tasks, clear state.
 */
 destroy() {
 this.stop();
 this._tasks.clear();
 this._statuses.clear();
 }

 // -----------------------------------------------------------------------
 // Internal
 // -----------------------------------------------------------------------

 _registerDefaultTasks() {
 // 天气预取：wttr.in 实时天气
 // 2026-08-01: task 名与 ai.js 读取键统一（此前写入 'weather' 而 ai.js 读
 // 'aci_weather'，定时预热数据永不命中缓存）
 this.registerTask(
 'aci_weather',
 async () => {
 try {
 const res = await fetch('https://wttr.in/?format=j1&lang=zh', { signal: AbortSignal.timeout(10000) });
 if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
 const data = await res.json();
 if (data?.current_condition?.[0]) {
 const c = data.current_condition[0];
 return {
 status: 'ok',
 temp: c.temp_C,
 feelsLike: c.FeelsLikeC,
 humidity: c.humidity,
 condition: c.weatherDesc?.[0]?.value || '未知',
 wind: `${c.winddir} ${c.windspeedKmph}km/h`,
 };
 }
 return { status: 'empty' };
 } catch (e) {
 return { status: 'error', message: e.message };
 }
 },
 { intervalMs: 30 * 60 * 1000, tags: ['weather', 'daily'], ttlMs: 30 * 60 * 1000, runOnRegister: false }
 );

 // 热点预取：通过 trending 模块
 this.registerTask(
 'aci_hotspot',
 async () => {
 try {
 const { collectTrending } = require('../trending');
 const result = await collectTrending('CN');
 return result || { status: 'error', message: 'fetch returned null' };
 } catch (e) {
 return { status: 'error', message: e.message };
 }
 },
 { intervalMs: 30 * 60 * 1000, tags: ['hotspot', 'trending'], ttlMs: 30 * 60 * 1000, runOnRegister: false }
 );

 // 系统状态任务（保留）
 this.registerTask(
 'system_status',
 async () => ({
 status: 'ok',
 uptime: process.uptime(),
 memory: process.memoryUsage(),
 pid: process.pid,
 }),
 { intervalMs: 5 * 60 * 1000, tags: ['system'], ttlMs: 5 * 60 * 1000, runOnRegister: false }
 );
 }

 _scheduleTask(task) {
 this._stopTaskTimer(task.name);

 const timer = setInterval(() => {
 this._executeTask(task);
 }, task.intervalMs);

 timer.unref();
 this._timers.set(task.name, timer);
 }

 _stopTaskTimer(name) {
 const timer = this._timers.get(name);
 if (timer) {
 clearInterval(timer);
 this._timers.delete(name);
 }
 }

 async _executeTask(task) {
 const status = this._statuses.get(task.name);
 if (!status) return;

 const startTs = Date.now();

 try {
 const data = await task.fetcherFn();

 // Store in prefetch cache
 if (this._cache && data !== null && data !== undefined) {
 this._cache.set(task.name, data, {
 ttlMs: task.ttlMs,
 tags: task.tags,
 source: `prefetch-runner:${task.name}`,
 });
 }

 status.lastRun = startTs;
 status.lastResult = 'success';
 status.error = null;
 status.lastDuration = Date.now() - startTs;
 } catch (err) {
 status.lastRun = startTs;
 status.lastResult = 'error';
 status.error = err.message || String(err);
 status.lastDuration = Date.now() - startTs;
 console.warn(`[prefetch-runner] task "${task.name}" failed:`, status.error);
 }
 }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance = null;

/**
 * Get or create the global PrefetchRunner singleton.
 *
 * @param {object} [cache] PrefetchCache instance (required on first call)
 * @param {object} [options] Options passed on first creation only
 * @returns {PrefetchRunner}
 */
function getPrefetchRunner(cache, options) {
 if (!_instance) {
 if (!cache) {
 // 容错：未传 cache 时尝试从 getPrefetchCache 拿（解决 initializeACI 内部
 // getExistingSingletons 调 getPrefetchRunner() 时未传参导致的死锁问题）
 try {
 const { getPrefetchCache } = require('./prefetch-cache');
 cache = getPrefetchCache();
 } catch {
 throw new Error('[prefetch-runner] PrefetchCache instance required to create singleton');
 }
 if (!cache) {
 throw new Error('[prefetch-runner] PrefetchCache instance required to create singleton');
 }
 }
 _instance = new PrefetchRunner(cache, options || {});
 }
 return _instance;
}

module.exports = { PrefetchRunner, getPrefetchRunner };
