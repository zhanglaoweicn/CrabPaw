/**
 * SceneStore — Declarative Agent-driven UI Scene State
 *

 * Holds current scene as an ordered array of surfaces (UI panels/views).
 * Provides monotonic revision tracking, incremental patches, and
 * a compact manifest for agent context injection.
 *
 * Events:
 * 'change' — { rev, ops: [{ op, id, surface? }] }
 * 'upserted' — { id, surface }
 * 'removed' — { id }
 * 'cleared' — {}
 * 'updated' — { rev, snapshot: { rev, surfaces } }
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── Constants ────────────────────────────────────────────────

const VALID_INTENTS = new Set(['ambient', 'inform', 'confront']);

const DEFAULT_MAX_HISTORY = 200;

// ── Helpers ──────────────────────────────────────────────────

function isPlainObject(v) {
 return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 稳定哈希：对 plain object 做 key 排序后 JSON 序列化，再 sha1。
 * 用于幂等 ui.set —— 同样内容产出同样 hash。
 */
function stableHash(value) {
 if (value === undefined) return '';
 if (value === null) return 'null';
 if (typeof value === 'string') return 's:' + crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
 if (typeof value === 'number') return 'n:' + value;
 if (typeof value === 'boolean') return 'b:' + (value ? 1 : 0);
 if (Array.isArray(value)) {
 return '[' + value.map(stableHash).join('|') + ']';
 }
 if (isPlainObject(value)) {
 const keys = Object.keys(value).sort();
 return '{' + keys.map(k => k + '=' + stableHash(value[k])).join('&') + '}';
 }
 return '?';
}

function inferIntent(raw) {
 if (VALID_INTENTS.has(raw)) return raw;
 return 'ambient';
}

function sanitizeSurface(id, data) {
 if (!id || typeof id !== 'string') {
 throw new Error(`SceneStore: surface id must be a non-empty string, got ${typeof id}`);
 }
 if (!isPlainObject(data)) {
 throw new Error(`SceneStore: surface data must be a plain object, got ${typeof data}`);
 }
 // 递归收集 children 内的所有内联 surface（用于 stack/row/col 排版原语）
 const inlineSurfaces = collectInlineSurfaces(data);
 return {
 id,
 kind: String(data.kind || 'panel'),
 data: isPlainObject(data.data) ? { ...data.data } : (data.data !== undefined ? data.data : {}),
 intent: inferIntent(data.intent),
 focus: data.focus === true,
 order: Number.isFinite(data.order) ? data.order : Date.now(),
 // 2026-08-17: TTL（毫秒）——内部字段，不参与 stableHash（_ 前缀）
 _ttlMs: Number.isFinite(data.ttlMs) && data.ttlMs > 0 ? data.ttlMs : null,
 inlineSurfaces,
 };
}

/**
 * 从 data 中提取 children 内的内联 surface（stack/row/col 的排版原语支持）。
 * 校验父内 id 唯一。
 */
function collectInlineSurfaces(data) {
 if (!isPlainObject(data.data)) return [];
 const d = data.data;
 if (!['stack', 'row', 'col'].includes(data.kind)) return [];
 if (!Array.isArray(d.children)) return [];
 const seen = new Set();
 const result = [];
 for (const child of d.children) {
 if (!isPlainObject(child) || !child.id) continue;
 if (seen.has(child.id)) {
 console.warn(`[scene-store] duplicate inline surface id in container: ${child.id}`);
 continue;
 }
 seen.add(child.id);
 result.push(sanitizeSurface(child.id, child));
 }
 return result;
}

function summarizeData(data) {
 if (data === null || data === undefined) return '';
 if (typeof data === 'string') {
 return data.length > 80 ? data.slice(0, 77) + '...' : data;
 }
 if (typeof data === 'number' || typeof data === 'boolean') return String(data);
 if (Array.isArray(data)) {
 return `[${data.length} items]`;
 }
 if (isPlainObject(data)) {
 const keys = Object.keys(data);
 if (keys.length === 0) return '{}';
 if (keys.length <= 3) {
 const parts = keys.map(k => `${k}:${summarizeData(data[k])}`);
 return `{${parts.join(', ')}}`;
 }
 return `{${keys.length} keys}`;
 }
 return String(data).slice(0, 80);
}

// ── SceneStore ───────────────────────────────────────────────

class SceneStore extends EventEmitter {
 /**
 * @param {object} [options]
 * @param {number} [options.maxHistory=200] Max ops retained for patch generation
 */
 constructor(options = {}) {
 super();
 this._surfaces = new Map(); // id -> surface
 this._rev = 0;
 this._ops = []; // append-only log: { rev, op, id, surface? }
 this._maxHistory = options.maxHistory || DEFAULT_MAX_HISTORY;
 // 2026-08-17: per-surface TTL（upsertSurface 传 ttlMs）——到期自动 removeSurface，
 // 防查询结果卡（stocks-card/stocks-kline）永久残留盖窗口（实机：20:08 茅台
 // K线卡 20:23 仍挂右下角遮对话）。
 this._ttlTimers = new Map(); // id -> setTimeout handle

 // Silence "MaxListenersExceededWarning" — scene changes are broadcast to many
 this.setMaxListeners(100);
 }

 // ── Public API ─────────────────────────────────────────────

 /**
 * Upsert a surface. Creates if new, updates if existing.
 *
 * 幂等：若新内容与已存在内容的 stableHash 一致（含 inlineSurfaces），
 * 则不递增 rev、不广播 change。
 * data_rev 字段在内容变化时递增，供前端 morph 动画判断。
 *
 * @param {string} id
 * @param {object} surfaceData { kind?, data?, intent?, focus?, order? }
 * @returns {{ rev: number, surface: object, changed: boolean, dataRev: number }}
 */
 upsertSurface(id, surfaceData) {
 const existing = this._surfaces.get(id);
 const sanitized = sanitizeSurface(id, surfaceData);

 // Merge data: keep existing fields not overwritten
 if (existing && isPlainObject(existing.data) && isPlainObject(sanitized.data)) {
 sanitized.data = { ...existing.data, ...sanitized.data };
 }

 // Preserve order if not explicitly set
 if (!Number.isFinite(sanitized.order) && existing) {
 sanitized.order = existing.order;
 }

 // 幂等判定：稳定哈希比较
 const newHash = stableHash({
 kind: sanitized.kind,
 data: sanitized.data,
 intent: sanitized.intent,
 focus: sanitized.focus,
 inlineSurfaces: sanitized.inlineSurfaces.map(s => ({ id: s.id, hash: stableHash({ kind: s.kind, data: s.data }) })),
 });
 const oldHash = existing?._stableHash;

 if (existing && oldHash === newHash) {
 // 幂等：内容未变，data_rev 不递增、不广播
 return { rev: this._rev, surface: existing, changed: false, dataRev: existing.data_rev || 0 };
 }

 // 内容变化
 this._rev++;
 const prevDataRev = existing?.data_rev || 0;
 sanitized.data_rev = prevDataRev + 1;
 sanitized._updatedAt = Date.now();
 sanitized._stableHash = newHash;
 this._surfaces.set(id, sanitized);

 // TTL：内容变化 → 清旧 timer，按新 ttlMs 重设（无 ttlMs = 取消 TTL）。
 // 幂等分支（内容未变）不触碰 timer——TTL 从最后一次内容变化起算。
 this._clearTtlTimer(id);
 if (sanitized._ttlMs) {
  const t = setTimeout(() => {
    try { this.removeSurface(id); } catch (e) { console.error('[scene-store] TTL 到期移除 surface 失败:', e.message); }
  }, sanitized._ttlMs);
  if (typeof t.unref === 'function') t.unref(); // 不阻止进程退出
  this._ttlTimers.set(id, t);
 }

 this._pushOp('upsert', id, sanitized);

 this.emit('upserted', { id, surface: sanitized });
 this.emit('change', {
 rev: this._rev,
 ops: [{ op: 'upsert', id, surface: sanitized }],
 });

 return { rev: this._rev, surface: sanitized, changed: true, dataRev: sanitized.data_rev };
 }

 /**
 * 取消 surface 的 TTL 到期 timer（内部）
 * @param {string} id
 */
 _clearTtlTimer(id) {
 const t = this._ttlTimers.get(id);
 if (t) {
   clearTimeout(t);
   this._ttlTimers.delete(id);
 }
 }

 /**
 * Remove a surface by id. No-op if not found.
 * @param {string} id
 * @returns {{ rev: number, found: boolean }}
 */
 removeSurface(id) {
 const found = this._surfaces.has(id);
 if (!found) {
 return { rev: this._rev, found: false };
 }

 this._clearTtlTimer(id);
 this._rev++;
 this._surfaces.delete(id);
 this._pushOp('remove', id);

 this.emit('removed', { id });
 this.emit('change', {
 rev: this._rev,
 ops: [{ op: 'remove', id }],
 });

 return { rev: this._rev, found: true };
 }

 /**
 * Get a full snapshot of the current scene.
 * @returns {{ rev: number, surfaces: object[] }}
 */
 getSnapshot() {
 return {
 rev: this._rev,
 surfaces: this._getOrderedSurfaces(),
 };
 }

 /**
 * Get an incremental patch of operations since baseRev.
 * Returns all ops with rev > baseRev.
 * If baseRev is unknown / too old, returns null (caller should use full snapshot).
 * @param {number} baseRev
 * @returns {{ rev: number, ops: Array<{op:string,id:string,surface?:object}>, partial: boolean } | null}
 */
 getPatch(baseRev) {
 if (!Number.isFinite(baseRev) || baseRev < 0) return null;
 if (baseRev >= this._rev) {
 return { rev: this._rev, ops: [], partial: false };
 }

 // Find first op after baseRev
 const ops = [];
 let found = false;
 for (const entry of this._ops) {
 if (entry.rev > baseRev) {
 found = true;
 if (entry.op === 'upsert') {
 ops.push({ op: 'upsert', id: entry.id, surface: entry.surface });
 } else {
 ops.push({ op: 'remove', id: entry.id });
 }
 }
 }

 // If we never crossed baseRev, either no changes or history was trimmed
 if (!found) {
 return null; // signal full resync needed
 }

 return { rev: this._rev, ops, partial: false };
 }

 /**
 * Compact manifest for agent context injection.
 * Returns a summary with id, kind, 1-line data preview, and intent per surface.
 * @returns {{ rev: number, manifest: Array<{id:string,kind:string,dataSummary:string,intent:string}> }}
 */
 getManifest() {
 const manifest = [];
 for (const surface of this._getOrderedSurfaces()) {
 manifest.push({
 id: surface.id,
 kind: surface.kind,
 dataSummary: summarizeData(surface.data),
 intent: surface.intent,
 });
 }
 return { rev: this._rev, manifest };
 }

 /**
 * Batch replace the entire scene.
 * Accepts an array of { id, ...surfaceData } objects.
 * @param {Array<{id:string} & object>} newSurfaces
 * @returns {{ rev: number, ops: Array<{op:string,id:string,surface?:object}> }}
 */
 setScene(newSurfaces) {
 if (!Array.isArray(newSurfaces)) {
 throw new Error('SceneStore: setScene requires an array of surface objects');
 }

 const ops = [];
 const oldIds = new Set(this._surfaces.keys());
 const newIds = new Set();

 // Upsert all new surfaces
 for (const entry of newSurfaces) {
 if (!entry || !entry.id) continue;
 newIds.add(entry.id);
 oldIds.delete(entry.id);

 this._rev++;
 const sanitized = sanitizeSurface(entry.id, entry);
 sanitized._updatedAt = Date.now();
 sanitized.data_rev = entry.data_rev || 1;
 sanitized._stableHash = stableHash({
 kind: sanitized.kind,
 data: sanitized.data,
 intent: sanitized.intent,
 focus: sanitized.focus,
 });
 this._surfaces.set(entry.id, sanitized);
 this._pushOp('upsert', entry.id, sanitized);
 ops.push({ op: 'upsert', id: entry.id, surface: sanitized });
 }

 // Remove surfaces not in the new set
 for (const id of oldIds) {
 this._clearTtlTimer(id);
 this._rev++;
 this._surfaces.delete(id);
 this._pushOp('remove', id);
 ops.push({ op: 'remove', id });
 }

 this.emit('cleared', {});
 this.emit('change', { rev: this._rev, ops });

 return { rev: this._rev, ops };
 }

 /**
 * AI tool method: set or remove a surface.
 * If data is null, removes the surface. Otherwise upserts.
 * @param {string} id
 * @param {object|null} data
 * @returns {{ rev: number, op: string, id: string, surface?: object }}
 */
 ui_set(id, data) {
 if (data === null || data === undefined) {
 return this.removeSurface(id);
 }
 return this.upsertSurface(id, data);
 }

 /**
 * Get a single surface by id.
 * @param {string} id
 * @returns {object|undefined}
 */
 getSurface(id) {
 return this._surfaces.get(id);
 }

 /**
 * Number of surfaces currently in the scene.
 * @returns {number}
 */
 get size() {
 return this._surfaces.size;
 }

 /**
 * Get the current revision number.
 * @returns {number}
 */
 get revision() {
 return this._rev;
 }

 /**
 * Clear all surfaces.
 * @returns {{ rev: number }}
 */
 clear() {
 return this.setScene([]);
 }

 /**
 * Serialize the entire state for persistence.
 * @returns {{ rev: number, surfaces: object[] }}
 */
 toJSON() {
 return this.getSnapshot();
 }

 /**
 * Restore state from a serialized snapshot.
 * @param {{ rev: number, surfaces: object[] }} json
 */
 fromJSON(json) {
 if (!json || !Array.isArray(json.surfaces)) return;
 this._surfaces.clear();
 for (const [, t] of this._ttlTimers) clearTimeout(t);
 this._ttlTimers.clear();
 this._ops = [];
 this._rev = json.rev || 0;

 for (const entry of json.surfaces) {
 if (entry && entry.id) {
 const s = sanitizeSurface(entry.id, entry);
 s._updatedAt = entry._updatedAt || Date.now();
 s.data_rev = entry.data_rev || 1;
 s._stableHash = stableHash({
 kind: s.kind,
 data: s.data,
 intent: s.intent,
 focus: s.focus,
 });
 this._surfaces.set(entry.id, s);
 }
 }
 // Rebuild ops from current state (full replace, no incremental history)
 for (const s of this._surfaces.values()) {
 this._ops.push({ rev: 0, op: 'upsert', id: s.id, surface: s });
 }

 this.emit('change', { rev: this._rev, ops: [{ op: 'setScene', ids: Array.from(this._surfaces.keys()) }] });
 }

 get currentRev() {
 return this._rev;
 }

 // ── Internal ───────────────────────────────────────────────

 _getOrderedSurfaces() {
 return Array.from(this._surfaces.values()).sort((a, b) => {
 if (a.order !== b.order) return a.order - b.order;
 if (a.id < b.id) return -1;
 if (a.id > b.id) return 1;
 return 0;
 });
 }

 _pushOp(op, id, surface) {
 this._ops.push({ rev: this._rev, op, id, surface: surface || undefined });
 if (this._ops.length > this._maxHistory) {
 this._ops.splice(0, this._ops.length - this._maxHistory);
 }
 }

 // ── Intent Queue（UI → Core 信道） ──

 /** @type {Array<{surface: string, name: string, data: any, ts: number}>} */
 _pendingIntents = [];

 /**
 * 记录一条来自 UI 的用户意图。
 * 在下一轮对话中被注入 Agent 上下文，注入后自动清空。
 * @param {string} surfaceId
 * @param {string} name
 * @param {any} data
 */
 pushIntent(surfaceId, name, data) {
 this._pendingIntents.push({ surface: surfaceId, name, data, ts: Date.now() });
 this.emit('intent', { surface: surfaceId, name, data });
 }

 /**
 * 消费并清空所有待处理意图（供 per-turn 上下文注入使用）。
 * @returns {Array<{surface: string, name: string, data: any, ts: number}>}
 */
 consumePendingIntents() {
 const intents = this._pendingIntents.slice();
 this._pendingIntents = [];
 return intents;
 }
}

// ── Singleton ────────────────────────────────────────────────

let _globalSceneStore = null;

/**
 * Get or create the global SceneStore singleton.
 * @param {object} [options]
 * @returns {SceneStore}
 */
function getSceneStore(options) {
 if (!_globalSceneStore) {
 _globalSceneStore = new SceneStore(options);
 }
 return _globalSceneStore;
}

module.exports = {
 SceneStore,
 getSceneStore,
 VALID_INTENTS,
 stableHash,
};
