'use strict';

/**
 * pattern-learner.js — ACI Tool Call Pattern Learner
 *
 * Learns and stores tool call patterns from history for the ACI system.
 * Maps user intents to known tool call chains, enabling anticipatory prefetch.
 * Patterns are persisted to a JSON file on changes.
 *

 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// PatternLearner
// ---------------------------------------------------------------------------

class PatternLearner {

 /**
 * @param {object} [options]
 * @param {string} [options.persistencePath] Path to persist patterns JSON
 * @param {number} [options.maxPatterns=200] Maximum number of patterns to retain
 */
 constructor(options = {}) {
 this._patterns = new Map(); // intent -> pattern object
 this._totalSequences = 0;
 this._persistencePath = options.persistencePath || null;
 this._maxPatterns = options.maxPatterns || 200;
 this._modified = false;

 this._loadFromDisk();
 }

 // -----------------------------------------------------------------------
 // Public API
 // -----------------------------------------------------------------------

 /**
 * Record a tool call sequence for a given intent.
 *
 * @param {string} intent The user intent key (e.g. 'write_daily_brief')
 * @param {string[]} toolNames Array of tool names called in sequence
 * @param {number} durationMs Total execution time in milliseconds
 * @returns {boolean} True if recorded successfully
 */
 recordSequence(intent, toolNames, durationMs) {
 if (!intent || !Array.isArray(toolNames) || toolNames.length === 0) {
 console.warn('[pattern-learner] recordSequence called with invalid args');
 return false;
 }

 this._totalSequences += 1;

 const existing = this._patterns.get(intent);
 const now = Date.now();

 if (existing) {
 // Update existing pattern
 const prevAvg = existing.avgDuration;
 existing.count += 1;
 // Running average: newAvg = prevAvg + (durationMs - prevAvg) / count
 existing.avgDuration = prevAvg + (durationMs - prevAvg) / existing.count;
 existing.lastUsed = now;
 existing.chain = toolNames; // Use latest chain (could be refined later)
 } else {
 // Create new pattern
 if (this._patterns.size >= this._maxPatterns) {
 // Evict least recently used
 this._evictLRU();
 }

 this._patterns.set(intent, {
 intent,
 chain: toolNames,
 count: 1,
 avgDuration: durationMs,
 lastUsed: now,
 });
 }

 this._modified = true;
 this._persistToDisk();
 return true;
 }

 /**
 * Get the known pattern for an intent.
 *
 * @param {string} intent
 * @returns {object|null} Pattern object or null if not found
 */
 getPattern(intent) {
 if (!intent) return null;

 const pattern = this._patterns.get(intent);
 if (!pattern) return null;

 // Touch lastUsed
 pattern.lastUsed = Date.now();
 this._modified = true;

 return pattern;
 }

 /**
 * Get all known patterns.
 *
 * @returns {object[]} Array of all pattern objects
 */
 getAllPatterns() {
 return Array.from(this._patterns.values());
 }

 /**
 * Get pattern statistics.
 *
 * @returns {object} { patterns: number, totalSequences: number }
 */
 getStats() {
 return {
 patterns: this._patterns.size,
 totalSequences: this._totalSequences,
 };
 }

 /**
 * Get patterns that match a set of intents (returns only existing ones).
 *
 * @param {string[]} intents
 * @returns {object[]}
 */
 getPatternsByIntents(intents) {
 if (!Array.isArray(intents)) return [];
 const results = [];
 for (const intent of intents) {
 const p = this._patterns.get(intent);
 if (p) results.push(p);
 }
 return results;
 }

 /**
 * Remove a specific pattern by intent.
 *
 * @param {string} intent
 * @returns {boolean}
 */
 removePattern(intent) {
 const existed = this._patterns.delete(intent);
 if (existed) {
 this._modified = true;
 this._persistToDisk();
 }
 return existed;
 }

 /**
 * Clear all patterns.
 */
 clear() {
 this._patterns.clear();
 this._totalSequences = 0;
 this._modified = true;
 this._persistToDisk();
 }

 // -----------------------------------------------------------------------
 // Internal
 // -----------------------------------------------------------------------

 /**
 * Evict the least recently used pattern.
 */
 _evictLRU() {
 let oldest = Infinity;
 let oldestIntent = null;

 for (const [intent, pattern] of this._patterns.entries()) {
 if (pattern.lastUsed < oldest) {
 oldest = pattern.lastUsed;
 oldestIntent = intent;
 }
 }

 if (oldestIntent) {
 this._patterns.delete(oldestIntent);
 }
 }

 // -----------------------------------------------------------------------
 // Persistence
 // -----------------------------------------------------------------------

 _loadFromDisk() {
 if (!this._persistencePath) return;

 try {
 if (fs.existsSync(this._persistencePath)) {
 const raw = fs.readFileSync(this._persistencePath, 'utf-8');
 const data = JSON.parse(raw);
 if (Array.isArray(data)) {
 for (const entry of data) {
 if (entry && entry.intent && Array.isArray(entry.chain)) {
 this._patterns.set(entry.intent, entry);
 this._totalSequences += entry.count || 0;
 }
 }
 }
 }
 } catch {
 console.warn('[pattern-learner] silent catch, error loading from disk');
 }
 }

 _persistToDisk() {
 if (!this._persistencePath || !this._modified) return;

 try {
 const dir = path.dirname(this._persistencePath);
 if (!fs.existsSync(dir)) {
 fs.mkdirSync(dir, { recursive: true });
 }
 const data = Array.from(this._patterns.values());
 const tmpP = this._persistencePath + '.tmp.' + Date.now();
 fs.writeFileSync(tmpP, JSON.stringify(data, null, 2), 'utf-8');
 fs.renameSync(tmpP, this._persistencePath);
 this._modified = false;
 } catch {
 console.warn('[pattern-learner] silent catch, error persisting to disk');
 }
 }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance = null;

/**
 * Get or create the global PatternLearner singleton.
 *
 * @param {object} [options] Options passed on first creation only
 * @returns {PatternLearner}
 */
function getPatternLearner(options) {
 if (!_instance) {
 _instance = new PatternLearner(options);
 }
 return _instance;
}

function hasPatternLearner() {
 return _instance !== null;
}

module.exports = { PatternLearner, getPatternLearner, hasPatternLearner };
