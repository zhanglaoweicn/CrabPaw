/**
 * Thread Manager — conversational thread state management
 *
 * maintains a list of open threads, tracks which thread
 * is in the foreground, and provides operations for creating, continuing,
 * freezing, and expiring threads.
 *
 * Each thread tracks:
 * - id, title, created/lastActive timestamps
 * - keywords[] for classifier matching
 * - summary for context injection
 * - temperature (0-1) representing "how hot/active" this thread
 * - status: active | frozen | background
 *
 * Events emitted:
 * thread:created — { thread }
 * thread:activated — { thread, previousId }
 * thread:deactivated — { thread }
 * thread:updated — { thread, changes }
 * thread:frozen — { thread }
 * thread:thawed — { thread }
 * thread:expired — { thread, reason }
 * thread:keywords — { thread, keywords }
 * thread:temperature — { thread, temperature, delta }
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ─── Constants ───

const DEFAULT_MAX_OPEN = 5;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_TEMPERATURE = 0.5;
const MIN_TEMPERATURE = 0.0;
const MAX_TEMPERATURE = 1.0;

const THREAD_STATUS = {
 ACTIVE: 'active',
 BACKGROUND: 'background',
 FROZEN: 'frozen',
};

// ─── Thread Class ───

class Thread {
 /**
 * @param {string} title
 * @param {string} firstMessage - the initiating message content
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {number} [options.temperature]
 */
 constructor(title, firstMessage, options = {}) {
 this.id = options.id || crypto.randomUUID();
 this.title = title;
 this.created = Date.now();
 this.lastActive = Date.now();
 this.firstMessage = firstMessage || '';
 this.keywords = [];
 this.summary = '';
 this.temperature = typeof options.temperature === 'number'
 ? Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, options.temperature))
 : DEFAULT_TEMPERATURE;
 this.status = THREAD_STATUS.ACTIVE;
 this._extractKeywords(firstMessage);
 }

 /**
 * Mark thread as active (touch timestamp)
 */
 touch() {
 this.lastActive = Date.now();
 }

 /**
 * Refresh temperature decay — called periodically
 * Temperatures decay toward 0.5 over time when not in use
 */
 tickDecay(elapsedMs) {
 if (this.status === THREAD_STATUS.FROZEN) return;
 // 0.1 decay per hour of inactivity
 const decayRate = 0.1 / (60 * 60 * 1000);
 const decay = elapsedMs * decayRate;
 this.temperature = Math.max(MIN_TEMPERATURE, this.temperature - decay);
 }

 /**
 * Extract initial keywords from the first message
 * Tokenization by delimiters + CJK 2-char sliding windows
 * @param {string} message
 */
 _extractKeywords(message) {
 if (!message) return;
 const seen = new Set();

 // 1. Tokenize by whitespace and punctuation
 const tokens = message.split(/[\s,，。、；;：:！!？?()（）[\]【】{}]+/);
 for (const token of tokens) {
 const cleaned = token.replace(/[^a-zA-Z0-9_\-一-鿿]/g, '').trim();
 if (cleaned.length >= 2 && !seen.has(cleaned.toLowerCase())) {
 seen.add(cleaned.toLowerCase());
 this.keywords.push(cleaned);
 }
 }

 // 2. For CJK-heavy text, add 2-char sliding windows
 // This ensures "爬虫" is extracted from "网页爬虫"
 const cjkChars = message.replace(/[^一-鿿]/g, '');
 if (cjkChars.length >= 2) {
 for (let i = 0; i <= cjkChars.length - 2; i++) {
 const bigram = cjkChars.slice(i, i + 2);
 if (!seen.has(bigram)) {
 seen.add(bigram);
 this.keywords.push(bigram);
 }
 }
 }

 // Cap keywords
 if (this.keywords.length > 20) {
 this.keywords = this.keywords.slice(0, 20);
 }
 }

 /**
 * Serialize to plain object (for logging / transmission)
 * @returns {object}
 */
 toJSON() {
 return {
 id: this.id,
 title: this.title,
 created: this.created,
 lastActive: this.lastActive,
 keywords: [...this.keywords],
 summary: this.summary,
 temperature: this.temperature,
 status: this.status,
 };
 }
}

// ─── ThreadManager Class ───

class ThreadManager extends EventEmitter {
 /**
 * @param {object} [options]
 * @param {number} [options.maxOpen] - max concurrent threads (default 5)
 * @param {number} [options.defaultMaxAge] - max thread age in ms (default 24h)
 */
 constructor(options = {}) {
 super();
 /** @type {Map<string, Thread>} */
 this._threads = new Map();
 /** @type {string|null} */
 this._foregroundId = null;
 this._maxOpen = options.maxOpen || DEFAULT_MAX_OPEN;
 this._defaultMaxAge = options.defaultMaxAge || DEFAULT_MAX_AGE_MS;
 this._decayInterval = null;
 }

 // ─── Accessors ───

 /**
 * Number of open threads
 * @returns {number}
 */
 get count() {
 return this._threads.size;
 }

 /**
 * Maximum concurrent threads
 * @returns {number}
 */
 get maxOpen() {
 return this._maxOpen;
 }

 // ─── Core Operations ───

 /**
 * Create a new thread and set it as foreground.
 * If at maxOpen, the coldest background thread is expired.
 *
 * @param {string} title - thread title
 * @param {string} firstMessage - initiating message
 * @param {object} [options]
 * @returns {string} thread id
 */
 createThread(title, firstMessage, options = {}) {
 // Evict coldest if at capacity
 if (this._threads.size >= this._maxOpen) {
 this._evictColdest();
 }

 const thread = new Thread(title, firstMessage, options);
 this._threads.set(thread.id, thread);

 const previousId = this._foregroundId;
 this._foregroundId = thread.id;

 this.emit('thread:created', { thread: thread.toJSON() });
 this.emit('thread:activated', {
 thread: thread.toJSON(),
 previousId,
 });

 return thread.id;
 }

 /**
 * Continue a thread — update lastActive and optionally append summary
 *
 * @param {string} id
 * @param {string} message - message content for keyword extraction
 * @returns {boolean} whether the thread exists
 */
 continueThread(id, message) {
 const thread = this._threads.get(id);
 if (!thread) {
 this.emit('thread:error', { error: `thread not found: ${id}` });
 return false;
 }

 thread.touch();
 thread._extractKeywords(message);

 // Automatically activate threaded messages
 if (thread.status === THREAD_STATUS.BACKGROUND) {
 this.activateThread(id);
 }

 this.emit('thread:updated', {
 thread: thread.toJSON(),
 changes: { lastActive: thread.lastActive },
 });

 return true;
 }

 /**
 * Activate a thread to the foreground
 *
 * @param {string} id
 * @returns {boolean}
 */
 activateThread(id) {
 const thread = this._threads.get(id);
 if (!thread) return false;

 const previousId = this._foregroundId;
 // Deactivate previous foreground
 if (previousId && previousId !== id) {
 const prev = this._threads.get(previousId);
 if (prev && prev.status !== THREAD_STATUS.FROZEN) {
 prev.status = THREAD_STATUS.BACKGROUND;
 }
 }

 thread.status = THREAD_STATUS.ACTIVE;
 thread.touch();
 this._foregroundId = id;

 this.emit('thread:activated', {
 thread: thread.toJSON(),
 previousId,
 });

 return true;
 }

 /**
 * Deactivate a thread — move to background
 *
 * @param {string} id
 * @returns {boolean}
 */
 deactivateThread(id) {
 const thread = this._threads.get(id);
 if (!thread) return false;

 if (thread.status === THREAD_STATUS.FROZEN) return false;

 thread.status = THREAD_STATUS.BACKGROUND;
 if (this._foregroundId === id) {
 this._foregroundId = null;
 }

 this.emit('thread:deactivated', { thread: thread.toJSON() });
 return true;
 }

 /**
 * Update a thread's summary
 *
 * @param {string} id
 * @param {string} summary
 * @returns {boolean}
 */
 summarizeThread(id, summary) {
 const thread = this._threads.get(id);
 if (!thread) return false;

 thread.summary = summary;
 thread.touch();

 this.emit('thread:updated', {
 thread: thread.toJSON(),
 changes: { summary },
 });

 return true;
 }

 /**
 * Tag a thread with additional keywords
 *
 * @param {string} id
 * @param {...string} keywords
 * @returns {boolean}
 */
 tagKeyword(id, ...keywords) {
 const thread = this._threads.get(id);
 if (!thread) return false;

 const added = [];
 const existing = new Set(thread.keywords.map(k => k.toLowerCase()));

 for (const kw of keywords) {
 if (kw.length >= 2 && !existing.has(kw.toLowerCase())) {
 thread.keywords.push(kw);
 existing.add(kw.toLowerCase());
 added.push(kw);
 }
 }

 // Cap keywords
 if (thread.keywords.length > 20) {
 thread.keywords = thread.keywords.slice(-20);
 }

 if (added.length > 0) {
 this.emit('thread:keywords', {
 thread: thread.toJSON(),
 added,
 });
 }

 return true;
 }

 /**
 * Adjust a thread's temperature by a delta, clamped to [0, 1]
 *
 * @param {string} id
 * @param {number} delta - positive to increase, negative to decrease
 * @returns {number|null} new temperature, or null if thread not found
 */
 adjustTemperature(id, delta) {
 const thread = this._threads.get(id);
 if (!thread) return null;

 const old = thread.temperature;
 thread.temperature = Math.max(
 MIN_TEMPERATURE,
 Math.min(MAX_TEMPERATURE, thread.temperature + delta)
 );

 this.emit('thread:temperature', {
 thread: thread.toJSON(),
 temperature: thread.temperature,
 delta: thread.temperature - old,
 });

 return thread.temperature;
 }

 /**
 * Freeze a thread — pin its temperature and prevent deactivation
 *
 * @param {string} id
 * @returns {boolean}
 */
 freezeThread(id) {
 const thread = this._threads.get(id);
 if (!thread) return false;

 thread.status = THREAD_STATUS.FROZEN;
 this.emit('thread:frozen', { thread: thread.toJSON() });
 return true;
 }

 /**
 * Thaw a frozen thread — return to active status
 *
 * @param {string} id
 * @returns {boolean}
 */
 thawThread(id) {
 const thread = this._threads.get(id);
 if (!thread || thread.status !== THREAD_STATUS.FROZEN) return false;

 thread.status = THREAD_STATUS.ACTIVE;
 this._foregroundId = id;
 this.emit('thread:thawed', { thread: thread.toJSON() });
 return true;
 }

 /**
 * Remove expired threads (cold threads beyond maxAge)
 *
 * @param {number} [maxAge] - max age in ms, defaults to constructor setting
 * @returns {number} number of threads expired
 */
 expireOldThreads(maxAge) {
 const threshold = Date.now() - (maxAge || this._defaultMaxAge);
 const expired = [];

 for (const [id, thread] of this._threads) {
 if (thread.status === THREAD_STATUS.FROZEN) continue;
 if (thread.lastActive < threshold) {
 expired.push(id);
 }
 }

 for (const id of expired) {
 const thread = this._threads.get(id);
 this._threads.delete(id);
 if (this._foregroundId === id) {
 // Promote next most recent to foreground
 this._foregroundId = this._findNextActive();
 }
 this.emit('thread:expired', {
 thread: thread.toJSON(),
 reason: 'maxAge exceeded',
 });
 }

 return expired.length;
 }

 /**
 * Get all threads formatted for prompt injection.
 * Returns a human-readable block describing all open threads.
 *
 * @returns {string}
 */
 getAllThreads() {
 if (this._threads.size === 0) return '';

 const lines = ['[Open Threads]'];
 for (const thread of this._threads.values()) {
 const prefix = thread.id === this._foregroundId ? '>>> ' : ' ';
 const frozen = thread.status === THREAD_STATUS.FROZEN ? ' [frozen]' : '';
 const temp = thread.temperature.toFixed(2);
 lines.push(
 `${prefix}"${thread.title}"` +
 ` temp=${temp}${frozen}` +
 ` keywords=[${thread.keywords.slice(0, 5).join(', ')}]` +
 (thread.summary ? ` summary="${thread.summary.slice(0, 80)}"` : '')
 );
 }
 return lines.join('\n');
 }

 /**
 * Get the current foreground thread
 *
 * @returns {object|null} thread JSON or null
 */
 getForegroundThread() {
 if (!this._foregroundId) return null;
 const thread = this._threads.get(this._foregroundId);
 return thread ? thread.toJSON() : null;
 }

 /**
 * Get a thread by id
 *
 * @param {string} id
 * @returns {object|null}
 */
 getThread(id) {
 const thread = this._threads.get(id);
 return thread ? thread.toJSON() : null;
 }

 /**
 * Get thread by id — returns the internal Thread object
 * @param {string} id
 * @returns {Thread|null}
 * @internal
 */
 _getThreadInternal(id) {
 return this._threads.get(id) || null;
 }

 /**
 * Get all threads as an array of plain objects
 *
 * @returns {object[]}
 */
 listThreads() {
 return Array.from(this._threads.values()).map(t => t.toJSON());
 }

 /**
 * Start periodic temperature decay
 *
 * @param {number} [intervalMs=60000] - decay tick interval (default 1 min)
 */
 startDecay(intervalMs = 60000) {
 if (this._decayInterval) return;
 this._decayInterval = setInterval(() => {
 const now = Date.now();
 for (const thread of this._threads.values()) {
 if (thread.status === THREAD_STATUS.FROZEN) continue;
 const elapsed = now - thread.lastActive;
 if (elapsed > 60000) {
 thread.tickDecay(elapsed);
 }
 }
 }, intervalMs);
 if (this._decayInterval && typeof this._decayInterval === 'object') {
 this._decayInterval.unref();
 }
 }

 /**
 * Stop periodic temperature decay
 */
 stopDecay() {
 if (this._decayInterval) {
 clearInterval(this._decayInterval);
 this._decayInterval = null;
 }
 }

 /**
 * Reset all threads
 */
 reset() {
 this._threads.clear();
 this._foregroundId = null;
 this.emit('thread:reset', { timestamp: Date.now() });
 }

 // ─── Internal ───

 /**
 * Evict the coldest background thread
 */
 _evictColdest() {
 let coldest = null;
 let coldestTemp = Infinity;

 for (const thread of this._threads.values()) {
 if (thread.status === THREAD_STATUS.FROZEN) continue;
 if (thread.temperature < coldestTemp) {
 coldestTemp = thread.temperature;
 coldest = thread;
 }
 }

 if (coldest) {
 this._threads.delete(coldest.id);
 if (this._foregroundId === coldest.id) {
 this._foregroundId = this._findNextActive();
 }
 this.emit('thread:expired', {
 thread: coldest.toJSON(),
 reason: 'evicted — maxOpen reached',
 });
 }
 }

 /**
 * Find the next most recently active thread for foreground promotion
 * @returns {string|null}
 */
 _findNextActive() {
 let best = null;
 let bestTime = 0;
 for (const thread of this._threads.values()) {
 if (thread.lastActive > bestTime) {
 bestTime = thread.lastActive;
 best = thread;
 }
 }
 return best ? best.id : null;
 }
}

// ─── Global Singleton ───
const globalThreadManager = new ThreadManager();

module.exports = {
 ThreadManager,
 globalThreadManager,
 Thread,
 THREAD_STATUS,
 DEFAULT_MAX_OPEN,
 DEFAULT_TEMPERATURE,
};
