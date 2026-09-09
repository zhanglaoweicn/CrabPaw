'use strict';

/**
 * ACI (Anticipatory Context Injection) — Public API
 *
 * Creates all singletons, wires them together, and provides
 * a single entry point for the ACI system.
 *

 *
 * Usage:
 * const aci = require('./core/aci');
 * aci.initializeACI({ dataDir: './data' });
 */

const { PrefetchCache, getPrefetchCache, hasPrefetchCache } = require('./prefetch-cache');
const { PatternLearner, getPatternLearner, hasPatternLearner } = require('./pattern-learner');
const { ACIInjector, getACIInjector, hasACIInjector } = require('./injector');
const { PrefetchRunner, getPrefetchRunner } = require('./prefetch-runner');
const path = require('path');

// Lazy import of config to avoid circular deps at load time
let _DATA_DIR = null;
function _getDataDir() {
 if (!_DATA_DIR) {
 try {
 const config = require('../config');
 _DATA_DIR = config.DATA_DIR;
 } catch {
 _DATA_DIR = path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
 }
 }
 return _DATA_DIR;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the full ACI system.
 *
 * Creates all singletons and wires them together:
 * 1. PrefetchCache (with SQLite/JSON persistence)
 * 2. PatternLearner (with JSON persistence)
 * 3. ACIInjector (wired with cache + patternLearner)
 * 4. PrefetchRunner (wired with cache, default tasks registered)
 *
 * Safe to call multiple times — returns the existing singletons after first call.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] Directory for persistence files
 * @param {object} [options.sceneStore] SceneStore instance (optional)
 * @param {object} [options.threadManager] ThreadManager instance (optional)
 * @param {function} [options.toolExecutor] Tool executor for prefetch
 * @param {object} [options.cacheOptions] Options passed to PrefetchCache
 * @param {object} [options.patternLearnerOptions] Options passed to PatternLearner
 * @param {object} [options.injectorOptions] Options passed to ACIInjector
 * @param {object} [options.runnerOptions] Options passed to PrefetchRunner
 * @param {boolean} [options.startRunner=true] Auto-start the prefetch runner
 * @returns {object} { cache, patternLearner, injector, runner }
 */
function initializeACI(options = {}) {
 // Check if already initialized
 const existing = getExistingSingletons();
 if (existing && existing.cache && existing.patternLearner && existing.injector && existing.runner) {
 // 已存在：保证 runner 已启动（防御性）
 if (options.startRunner !== false && existing.runner && !existing.runner.isRunning()) {
 try { existing.runner.start() } catch (e) {
   /* ignore */
   console.warn('[index.js] 空 catch 补日志:', e && e.message);
 }
 }
 return existing;
 }

 const dataDir = options.dataDir || path.join(_getDataDir(), 'aci');
 const cacheOptions = Object.assign({}, options.cacheOptions);
 const patternLearnerOptions = Object.assign({}, options.patternLearnerOptions);
 const injectorOptions = Object.assign({}, options.injectorOptions);
 const runnerOptions = Object.assign({}, options.runnerOptions);

 // Set persistence paths if not explicitly provided
 if (!cacheOptions.persistencePath) {
 cacheOptions.persistencePath = path.join(dataDir, 'prefetch-cache.json');
 }
 if (!patternLearnerOptions.persistencePath) {
 patternLearnerOptions.persistencePath = path.join(dataDir, 'pattern-learner.json');
 }

 // 1. Create PrefetchCache singleton
 const cache = getPrefetchCache(cacheOptions);

 // 2. Create PatternLearner singleton
 const patternLearner = getPatternLearner(patternLearnerOptions);

 // 3. Create ACIInjector singleton
 const injectorDeps = {
 cache,
 patternLearner,
 sceneStore: options.sceneStore || null,
 threadManager: options.threadManager || null,
 memoryManager: options.memoryManager || null,
 };
 injectorOptions.toolExecutor = injectorOptions.toolExecutor || options.toolExecutor || null;
 const injector = getACIInjector(injectorDeps, injectorOptions);

 // 4. Create PrefetchRunner singleton
 const runner = getPrefetchRunner(cache, runnerOptions);

 // Auto-start runner
 if (options.startRunner !== false) {
 runner.start();
 }

 return { cache, patternLearner, injector, runner };
}

/**
 * Get existing ACI singletons without initializing.
 * Uses has* checks to avoid accidentally creating empty singletons.
 *
 * @returns {object|null} { cache, patternLearner, injector, runner } or null
 */
function getExistingSingletons() {
 let cache, patternLearner, injector, runner;

 // Use has* to avoid creating empty singletons on first check
 if (hasPrefetchCache()) cache = getPrefetchCache();
 if (hasPatternLearner()) patternLearner = getPatternLearner();
 if (hasACIInjector()) injector = getACIInjector();
 try { runner = getPrefetchRunner(); } catch (e) {
   /* not created yet */
   console.warn('[index.js] 空 catch 补日志:', e && e.message);
 }

 return (cache || patternLearner || injector || runner)
 ? { cache, patternLearner, injector, runner }
 : null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
 // Classes
 PrefetchCache,
 PatternLearner,
 ACIInjector,
 PrefetchRunner,

 // Singleton getters
 getPrefetchCache,
 getPatternLearner,
 getACIInjector,
 getPrefetchRunner,

 // Has checks
 hasPrefetchCache,
 hasPatternLearner,
 hasACIInjector,

 // Initialization
 initializeACI,
 getExistingSingletons,
};
