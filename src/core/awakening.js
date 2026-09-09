'use strict';

/**
 * awakening.js — 觉醒阶段
 *
 * 设计参考 9.x 觉醒阶段:
 * - 后台异步预热，无需阻塞 init
 * - 步骤化：环境扫描 → 用户偏好 → 记忆预热 → scene 卡片推送
 * - 通过 EventEmitter 广播每个阶段
 * - 结果缓存到磁盘，下次启动时复用
 * - 超时保护：总时长不应超过 5s
 *
 * 公开 API:
 * - getAwakening() → 单例
 * - awakening.run({ userId }) → 触发一次觉醒
 * - awakening.getState() → 当前状态
 * - awakening.on('phase', fn) → 监听阶段事件
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDataDir } = require('./config');
const { broadcastEvent } = require('./sse-broadcast');

// ---------------------------------------------------------------------------
// 阶段定义
// ---------------------------------------------------------------------------

const AWAKENING_PHASES = {
 IDLE: 'idle',
 SCAN_ENV: 'scan_env',
 LOAD_USER: 'load_user',
 PRELOAD_MEMORY: 'preload_memory',
 GREETING: 'greeting',
 DONE: 'done',
 FAILED: 'failed',
};

const PHASE_ORDER = [
 AWAKENING_PHASES.SCAN_ENV,
 AWAKENING_PHASES.LOAD_USER,
 AWAKENING_PHASES.PRELOAD_MEMORY,
 AWAKENING_PHASES.GREETING,
 AWAKENING_PHASES.DONE,
];

const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// 辅助：获取 scene-store
// ---------------------------------------------------------------------------

let _sceneStoreRef = null;
function _getSceneStore() {
 if (_sceneStoreRef) return _sceneStoreRef;
 try {
 const { getSceneStore } = require('./scene/scene-store');
 _sceneStoreRef = getSceneStore();
 } catch (e) { console.warn('[awakening] 加载 scene-store 失败:', e.message); }
 return _sceneStoreRef;
}

function _pushAwakeningCard(state) {
 const store = _getSceneStore();
 if (!store) return;
 try {
 store.setSurface('awakening_status', {
 kind: 'awakening',
 intent: 'ambient',
 data: {
 text: state.message || '正在觉醒...',
 type: state.status === 'done' ? 'success' : (state.status === 'failed' ? 'error' : 'info'),
 phases: state.phases,
 currentPhase: state.currentPhase,
 progress: state.progress,
 userName: state.userName,
 environment: state.environment,
 startedAt: state.startedAt,
 durationMs: state.durationMs,
 },
 });
 } catch (e) {
 console.warn('[awakening] 推 scene 卡片失败:', e.message);
 }
}

function _removeAwakeningCard() {
 const store = _getSceneStore();
 if (!store) return;
 try {
 store.setSurface('awakening_status', null);
 } catch (e) { console.warn('[awakening] 移除 scene 卡片失败:', e.message); }
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

class Awakening extends EventEmitter {
 constructor() {
 super();
 this._state = {
 status: AWAKENING_PHASES.IDLE,
 currentPhase: null,
 phases: [],
 message: '',
 progress: 0,
 startedAt: null,
 finishedAt: null,
 durationMs: 0,
 userName: null,
 environment: null,
 memory: null,
 error: null,
 };
 this._cacheFile = path.join(getDataDir(), 'awakening-cache.json');
 this._running = null;
 }

 getState() {
 return { ...this._state };
 }

 _ensureCacheDir() {
 try {
 fs.mkdirSync(path.dirname(this._cacheFile), { recursive: true });
 } catch (e) { console.warn('[awakening] 创建缓存目录失败:', e.message); }
 }

 _loadCache() {
 try {
 if (!fs.existsSync(this._cacheFile)) return null;
 const raw = fs.readFileSync(this._cacheFile, 'utf-8');
 const data = JSON.parse(raw);
 // 检查是否过期
 if (data.timestamp && Date.now() - data.timestamp < CACHE_TTL_MS) {
 return data;
 }
 } catch (e) { console.warn('[awakening] 读取缓存失败:', e.message); }
 return null;
 }

 _saveCache(payload) {
 this._ensureCacheDir();
 try {
 fs.writeFileSync(this._cacheFile, JSON.stringify({
 timestamp: Date.now(),
 ...payload,
 }, null, 2));
 } catch (e) {
 console.warn('[awakening] 保存缓存失败:', e.message);
 }
 }

 /**
 * 触发一次觉醒。已有 running 实例则复用。
 * @param {object} [options]
 * @param {string} [options.userId]
 * @param {boolean} [options.force=false] 强制重新跑（忽略缓存）
 * @param {boolean} [options.skipSceneCard=false] 不推 scene 卡片
 * @param {number} [options.timeoutMs=5000]
 * @returns {Promise<object>}
 */
 async run(options = {}) {
 if (this._running) return this._running;

 // 命中缓存
 if (!options.force) {
 const cached = this._loadCache();
 if (cached) {
 this._state = {
 ...this._state,
 status: AWAKENING_PHASES.DONE,
 phases: cached.phases || [],
 progress: 100,
 message: '已从缓存恢复',
 userName: cached.userName || null,
 environment: cached.environment || null,
 memory: cached.memory || null,
 finishedAt: Date.now(),
 durationMs: cached.durationMs || 0,
 };
 this.emit('phase', this._state);
 return this._state;
 }
 }

 this._running = this._doRun(options);
 try {
 return await this._running;
 } finally {
 this._running = null;
 }
 }

 async _doRun(options) {
 const startTs = Date.now();
 this._state = {
 status: AWAKENING_PHASES.SCAN_ENV,
 currentPhase: AWAKENING_PHASES.SCAN_ENV,
 phases: [],
 message: '正在扫描本机环境...',
 progress: 5,
 startedAt: startTs,
 finishedAt: null,
 durationMs: 0,
 userName: null,
 environment: null,
 memory: null,
 error: null,
 };
 this.emit('phase', this._state);
 if (!options.skipSceneCard) _pushAwakeningCard(this._state);

 const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
 const timeoutPromise = new Promise((_, reject) =>
 setTimeout(() => reject(new Error(`awakening 超时 (${timeoutMs}ms)`)), timeoutMs)
 );

 try {
 await Promise.race([this._runPhases(options), timeoutPromise]);
 // 保存问候语（在 _runPhases 之后 message 已经是 greeting）
 const finalGreeting = this._state.message;
 this._state.status = AWAKENING_PHASES.DONE;
 this._state.finishedAt = Date.now();
 this._state.durationMs = this._state.finishedAt - startTs;
 this._state.progress = 100;
 // 保留 greeting 作为最终 message
 this._state.message = finalGreeting;
 this._saveCache({
 phases: this._state.phases,
 userName: this._state.userName,
 environment: this._state.environment,
 memory: this._state.memory,
 durationMs: this._state.durationMs,
 });
 if (!options.skipSceneCard) {
 _pushAwakeningCard(this._state);
 // 3s 后移除卡片
 setTimeout(_removeAwakeningCard, 3000);
 }
 broadcastEvent('awakening:done', {
 durationMs: this._state.durationMs,
 userName: this._state.userName,
 });
 this.emit('phase', this._state);
 this.emit('done', this._state);
 return this._state;
 } catch (e) {
 this._state.status = AWAKENING_PHASES.FAILED;
 this._state.finishedAt = Date.now();
 this._state.durationMs = this._state.finishedAt - startTs;
 this._state.error = e.message;
 this._state.message = `觉醒失败: ${e.message}`;
 if (!options.skipSceneCard) _pushAwakeningCard(this._state);
 this.emit('phase', this._state);
 this.emit('failed', this._state);
 // 失败不抛错，返回当前状态
 return this._state;
 }
 }

 async _runPhases(options) {
 // Phase 1: 环境扫描
 await this._runPhase(AWAKENING_PHASES.SCAN_ENV, 30, async () => {
 const env = await this._scanEnvironment();
 this._state.environment = env;
 });

 // Phase 2: 用户偏好
 await this._runPhase(AWAKENING_PHASES.LOAD_USER, 55, async () => {
 const userName = await this._loadUserName(options.userId);
 this._state.userName = userName;
 });

 // Phase 3: 记忆预热（best-effort）
 await this._runPhase(AWAKENING_PHASES.PRELOAD_MEMORY, 80, async () => {
 const mem = await this._preloadMemory();
 this._state.memory = mem;
 });

 // Phase 4: 问候语
 await this._runPhase(AWAKENING_PHASES.GREETING, 95, async () => {
 this._state.message = this._buildGreeting();
 });
 }

 async _runPhase(phase, progress, fn) {
 this._state.currentPhase = phase;
 this._state.progress = progress;
 const labels = {
 [AWAKENING_PHASES.SCAN_ENV]: '正在扫描本机环境...',
 [AWAKENING_PHASES.LOAD_USER]: '正在加载用户偏好...',
 [AWAKENING_PHASES.PRELOAD_MEMORY]: '正在预热记忆...',
 [AWAKENING_PHASES.GREETING]: '正在准备问候...',
 };
 this._state.message = labels[phase] || '处理中...';
 const phaseStart = Date.now();
 this.emit('phase', this._state);

 try {
 await fn();
 this._state.phases.push({
 phase,
 status: 'ok',
 durationMs: Date.now() - phaseStart,
 });
 } catch (e) {
 this._state.phases.push({
 phase,
 status: 'error',
 error: e.message,
 durationMs: Date.now() - phaseStart,
 });
 // 阶段失败不中断整个觉醒
 console.warn(`[awakening] 阶段 ${phase} 失败:`, e.message);
 }
 }

 // ── Phase 1: 环境扫描 ─────────────────────────────────────
 async _scanEnvironment() {
 const env = {
 os: { platform: process.platform, release: os.release(), arch: process.arch },
 cpus: os.cpus().length,
 totalMemGB: +(os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
 freeMemGB: +(os.freemem() / 1024 / 1024 / 1024).toFixed(2),
 nodeVersion: process.version,
 hostname: os.hostname(),
 username: os.userInfo().username,
 uptime: os.uptime(),
 tools: {},
 };

 // 探测常用工具
 const probes = [
 { name: 'winget', bin: 'winget.exe', args: ['--version'] },
 { name: 'git', bin: 'git.exe', args: ['--version'] },
 { name: 'node', bin: 'node.exe', args: ['--version'] },
 { name: 'python', bin: 'python.exe', args: ['--version'] },
 { name: 'code', bin: 'code.cmd', args: ['--version'] },
 { name: 'docker', bin: 'docker.exe', args: ['--version'] },
 ];

 await Promise.all(probes.map(async (p) => {
 try {
 const { spawn } = require('child_process');
 const result = await new Promise((resolve) => {
 let out = '';
 const proc = spawn(p.bin, p.args, { shell: false, windowsHide: true, timeout: 3000 });
 proc.stdout.on('data', (d) => { out += d.toString(); });
 proc.on('error', () => resolve(null));
 proc.on('close', (code) => {
 if (code === 0) resolve(out.trim().split('\n')[0]);
 else resolve(null);
 });
 });
 if (result) env.tools[p.name] = result;
 } catch (e) { console.warn('[awakening] 探测工具失败:', e.message); }
 }));

 return env;
 }

 // ── Phase 2: 用户偏好 ─────────────────────────────────────
 async _loadUserName(_userId) {
 try {
 const cfg = require('./config');
 const config = cfg.configManager?.get?.() || cfg.config || {};
 return config.userName || config.user_name || config.user?.name || os.userInfo().username;
 } catch (e) {
 return os.userInfo().username;
 }
 }

 // ── Phase 3: 记忆预热 ─────────────────────────────────────
 async _preloadMemory() {
 const mem = { recent: 0, total: 0, sampled: [] };
 try {
 const { memoryManager: mgr } = require('./memory-system');
 if (mgr && mgr.listRecent) {
 const recent = await mgr.listRecent({ limit: 5 });
 mem.recent = Array.isArray(recent) ? recent.length : 0;
 mem.sampled = (recent || []).slice(0, 3).map(m => ({
 id: m.id || m._id,
 summary: m.summary || m.content?.slice(0, 80) || '',
 }));
 }
 if (mgr && mgr.count) {
 mem.total = await mgr.count();
 }
 } catch (e) {
 mem.error = e.message;
 }
 return mem;
 }

 // ── Phase 4: 问候语 ─────────────────────────────────────
 _buildGreeting() {
 const name = this._state.userName ? `, ${this._state.userName}` : '';
 const hour = new Date().getHours();
 const timeOfDay = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
 const memCount = this._state.memory?.recent || 0;
 return `${timeOfDay}${name}。系统已就绪（${this._state.environment?.tools ? Object.keys(this._state.environment.tools).length : 0} 个工具可用${memCount > 0 ? `，${memCount} 条近期记忆` : ''}）。`;
 }

 /**
 * 失效缓存（用于强制重新觉醒）
 */
 invalidate() {
 try {
 if (fs.existsSync(this._cacheFile)) fs.unlinkSync(this._cacheFile);
 } catch (e) { console.warn('[awakening] 删除缓存文件失败:', e.message); }
 }
}

// ---------------------------------------------------------------------------
// 单例导出
// ---------------------------------------------------------------------------

let _instance = null;
function getAwakening() {
 if (!_instance) _instance = new Awakening();
 return _instance;
}

module.exports = {
 Awakening,
 AWAKENING_PHASES,
 PHASE_ORDER,
 getAwakening,
};
