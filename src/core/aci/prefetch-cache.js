'use strict';

/**
 * prefetch-cache.js — ACI Prefetch Cache
 *
 * In-memory prefetch cache with SQLite persistence for the ACI system.
 * Stores prefetched context data with TTL, tags, and hit tracking.
 * Auto-sweeps expired entries every 5 minutes.
 *

 */

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _isExpired(entry) {
 return entry.expiresAt <= Date.now();
}

// ---------------------------------------------------------------------------
// PrefetchCache
// ---------------------------------------------------------------------------

class PrefetchCache extends EventEmitter {

 /**
 * @param {object} [options]
 * @param {number} [options.defaultTtlMs=1800000] Default TTL for entries
 * @param {string} [options.persistencePath] Path to SQLite persistence file
 * @param {boolean} [options.autoSweep=true] Enable auto-sweep interval
 */
 constructor(options = {}) {
 super();
 this._map = new Map(); // key -> entry
 this._defaultTtlMs = options.defaultTtlMs || DEFAULT_TTL_MS;
 this._persistencePath = options.persistencePath || null;
 this._autoSweep = options.autoSweep !== false;
 this._sweepTimer = null;

 if (this._autoSweep) {
 this._sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
 this._sweepTimer.unref();
 }

 // Load persisted data if available
 this._loadFromDisk();
 }

 // -----------------------------------------------------------------------
 // Public API
 // -----------------------------------------------------------------------

 /**
 * Store a prefetched result.
 *
 * @param {string} key Unique cache key
 * @param {*} data The data to cache (must be JSON-serializable)
 * @param {object} [options]
 * @param {number} [options.ttlMs] Time-to-live in milliseconds
 * @param {string[]} [options.tags=[]] Tags for grouped lookup
 * @param {string} [options.source=''] Source identifier (e.g. 'weather', 'hotspot')
 * @returns {boolean} True if stored successfully
 */
 set(key, data, options = {}) {
 if (!key) {
 console.warn('[prefetch-cache] set called with empty key');
 return false;
 }

 const ttlMs = options.ttlMs || this._defaultTtlMs;
 const now = Date.now();

 const entry = {
 key,
 data,
 fetchedAt: now,
 expiresAt: now + ttlMs,
 tags: Array.isArray(options.tags) ? options.tags : [],
 source: options.source || '',
 hits: 0,
 };

 this._map.set(key, entry);
 this.emit('cache:set', { key, source: entry.source, ttlMs, tags: entry.tags });
 this._persistToDisk();
 return true;
 }

 /**
 * Get a valid (non-expired) prefetched result.
 *
 * @param {string} key
 * @returns {object|null} The entry object, or null if missing/expired
 */
 get(key) {
 if (!key) return null;

 const entry = this._map.get(key);
 if (!entry) return null;

 if (_isExpired(entry)) {
 this._map.delete(key);
 this.emit('cache:expired', { key });
 return null;
 }

 entry.hits += 1;
 this.emit('cache:hit', { key, hits: entry.hits });
 return entry;
 }

 /**
 * Get all valid entries matching any of the given tags.
 *
 * @param {string[]} tags
 * @returns {object[]} Array of valid entry objects
 */
 getByTags(tags) {
 if (!Array.isArray(tags) || tags.length === 0) return [];

 const now = Date.now();
 const results = [];

 for (const entry of this._map.values()) {
 if (entry.expiresAt <= now) {
 // Expired — will be cleaned by sweep, skip silently
 continue;
 }
 if (entry.tags.some(t => tags.includes(t))) {
 entry.hits += 1;
 results.push(entry);
 }
 }

 return results;
 }

 /**
 * Remove expired entries from the cache.
 *
 * @returns {number} Number of entries removed
 */
 sweep() {
 const now = Date.now();
 let removed = 0;

 for (const [key, entry] of this._map.entries()) {
 if (entry.expiresAt <= now) {
 this._map.delete(key);
 removed += 1;
 this.emit('cache:swept', { key, source: entry.source });
 }
 }

 if (removed > 0) {
 this._persistToDisk();
 }

 return removed;
 }

 /**
 * Delete a specific key from the cache.
 *
 * @param {string} key
 * @returns {boolean} True if the key existed and was deleted
 */
 delete(key) {
 const existed = this._map.delete(key);
 if (existed) {
 this.emit('cache:delete', { key });
 this._persistToDisk();
 }
 return existed;
 }

 /**
 * Clear all entries from the cache.
 */
 clear() {
 const count = this._map.size;
 this._map.clear();
 if (count > 0) {
 this.emit('cache:cleared', { count });
 this._persistToDisk();
 }
 }

 /**
 * Get cache statistics.
 *
 * @returns {object} { entries, active, expired }
 */
 getStats() {
 const now = Date.now();
 let active = 0;
 let expired = 0;

 for (const entry of this._map.values()) {
 if (entry.expiresAt <= now) {
 expired += 1;
 } else {
 active += 1;
 }
 }

 return {
 entries: this._map.size,
 active,
 expired,
 };
 }

 /**
 * Get all active entries (for injection or debugging).
 *
 * @returns {object[]}
 */
 getAllActive() {
 const now = Date.now();
 const results = [];
 for (const entry of this._map.values()) {
 if (entry.expiresAt > now) {
 results.push(entry);
 }
 }
 return results;
 }

 // -----------------------------------------------------------------------
 // Lifecycle
 // -----------------------------------------------------------------------

 /**
 * Destroy the cache: stop auto-sweep, clear data, emit event.
 */
 destroy() {
 if (this._sweepTimer) {
 clearInterval(this._sweepTimer);
 this._sweepTimer = null;
 }
 this._persistToDisk();
 this._map.clear();
 this.emit('cache:destroyed');
 this.removeAllListeners();
 }

 // -----------------------------------------------------------------------
 // Persistence (JSON file)
 // -----------------------------------------------------------------------

 _loadFromDisk() {
 if (!this._persistencePath) return;

 try {
 if (fs.existsSync(this._persistencePath)) {
 const raw = fs.readFileSync(this._persistencePath, 'utf-8');
 const data = JSON.parse(raw);
 if (Array.isArray(data)) {
 const now = Date.now();
 for (const entry of data) {
 // Skip already-expired entries at load time
 if (entry.expiresAt > now) {
 this._map.set(entry.key, entry);
 }
 }
 }
 }
 } catch {
 console.warn('[prefetch-cache] silent catch, error loading from disk');
 }
 }

 _persistToDisk() {
 if (!this._persistencePath) return;

 try {
 const dir = path.dirname(this._persistencePath);
 if (!fs.existsSync(dir)) {
 fs.mkdirSync(dir, { recursive: true });
 }
 const entries = Array.from(this._map.values());
 const tmpP = this._persistencePath + '.tmp.' + Date.now();
 fs.writeFileSync(tmpP, JSON.stringify(entries, null, 2), 'utf-8');
 fs.renameSync(tmpP, this._persistencePath);
 } catch {
 console.warn('[prefetch-cache] silent catch, error persisting to disk');
 }
 }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance = null;

/**
 * Get or create the global PrefetchCache singleton.
 *
 * @param {object} [options] Options passed on first creation only
 * @returns {PrefetchCache}
 */
function getPrefetchCache(options) {
 if (!_instance) {
 _instance = new PrefetchCache(options);
 }
 return _instance;
}

function hasPrefetchCache() {
 return _instance !== null;
}

module.exports = { PrefetchCache, getPrefetchCache, hasPrefetchCache };
