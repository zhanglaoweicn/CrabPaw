'use strict';

/**
 * injector.js — ACI Injector (Anticipatory Context Injection)
 *
 * Orchestrates prefetch + injection for the ACI system.
 * Called BEFORE each LLM call to gather and prepare contextual data.
 *
 * Responsibilities:
 * 1. Detect intent from user message (keyword matching)
 * 2. Look up known tool chain patterns for this intent
 * 3. Execute prefetched read-only tools in parallel
 * 4. Check prefetch cache for valid results
 * 5. Attach thread context from thread manager
 * 6. Attach scene manifest from scene store
 * 7. Emit 'aci:context-ready' event with confidence-gated context
 *

 */

const { EventEmitter } = require('events');

const PREPARE_TIMEOUT_MS = 1500; // Max time injector waits for prefetch
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.5;

// Default intent patterns (keyword-based detection)
const DEFAULT_INTENT_PATTERNS = {
 weather: { keywords: ['weather', '天气', 'temperature', '温度', 'forecast', '预报', 'rain', '下雨', 'sunny', '晴天'], confidence: 0.9, tags: ['weather'] },
 news: { keywords: ['news', '新闻', 'headlines', '头条', 'trending', '热点', 'what happened', '发生了什么'], confidence: 0.85, tags: ['hotspot', 'trending'] },
 daily_brief: { keywords: ['daily brief', '今日简报', '早报', 'morning brief', '日报'], confidence: 0.9, tags: ['weather', 'hotspot', 'daily'] },
 schedule: { keywords: ['schedule', '日程', 'calendar', '日历', 'my day', '我的今天', 'appointment', '会议', 'meeting'], confidence: 0.85, tags: ['daily'] },
 memory_lookup: { keywords: ['remember', '回忆', '回顾', '上次', 'previous', '之前', 'recall', 'what did we'], confidence: 0.9, tags: [] },
 system_status: { keywords: ['status', '状态', 'system', '系统', 'health', '健康', 'diagnostic', '诊断'], confidence: 0.8, tags: ['system'] },
};

// ---------------------------------------------------------------------------
// ACIInjector
// ---------------------------------------------------------------------------

class ACIInjector extends EventEmitter {

 /**
 * @param {object} deps
 * @param {object} deps.cache PrefetchCache instance
 * @param {object} deps.patternLearner PatternLearner instance
 * @param {object} [deps.sceneStore] SceneStore instance (optional)
 * @param {object} [deps.threadManager] ThreadManager instance (optional)
 * @param {object} [options]
 * @param {number} [options.prepareTimeout=1500] Max time for prepare() in ms
 * @param {object} [options.intentPatterns] Custom intent detection patterns
 * @param {function} [options.toolExecutor] Async function (toolName, args) => result
 */
 constructor(deps = {}, options = {}) {
 super();

 this._cache = deps.cache || null;
 this._patternLearner = deps.patternLearner || null;
 this._sceneStore = deps.sceneStore || null;
 this._threadManager = deps.threadManager || null;
 this._memoryManager = deps.memoryManager || null;

 this._prepareTimeout = options.prepareTimeout || PREPARE_TIMEOUT_MS;
 this._toolExecutor = options.toolExecutor || null;

 // Intent detection registry
 this._intentPatterns = { ...DEFAULT_INTENT_PATTERNS };
 if (options.intentPatterns) {
 Object.assign(this._intentPatterns, options.intentPatterns);
 }

 // Prepared context (populated by prepare())
 this._preparedContext = {
 highConfidenceSections: [],
 mediumConfidenceSections: [],
 rawContext: {},
 preparedAt: null,
 };
 }

 // -----------------------------------------------------------------------
 // Public API
 // -----------------------------------------------------------------------

 /**
 * Prepare context for an LLM call. Called BEFORE each LLM call.
 *
 * Flow:
 * 1. Detect intent from user message
 * 2. Look up known patterns for this intent
 * 3. Execute prefetched tools (read-only, idempotent) in parallel
 * 4. Check prefetch cache for valid results
 * 5. Attach thread context from thread manager
 * 6. Attach scene manifest from scene store
 * 7. Emit 'aci:context-ready' event
 *
 * @param {string} userMessage The user's current message
 * @param {object} [options]
 * @param {function} [options.toolExecutor] Override tool executor for this call
 * @param {string[]} [options.forceIntents] Skip detection, use these intents
 * @returns {Promise<object>} The assembled context
 */
 async prepare(userMessage, options = {}) {
 const startTs = Date.now();
 const context = {
 highConfidenceSections: [],
 mediumConfidenceSections: [],
 rawContext: {},
 preparedAt: startTs,
 elapsed: 0,
 };

 try {
 // ------- Step 1: Detect intent(s) -------
 const toolExecutor = options.toolExecutor || this._toolExecutor;
 const detectedIntents = options.forceIntents
 ? this._getIntentsByNames(options.forceIntents)
 : this._detectIntents(userMessage);

 const prefetchPromises = [];
 const cacheLookups = [];

 // ------- Step 1b: Semantic Memory Prefetch (ACI Phase 1) -------
 try {
 // Use the memory manager for keyword-based retrieval
 // The LLM call will also do its own memory injection later
 // ACI's role here is to PRE-WARM memory so it's already there
 var memory = this._memoryManager;
 if (memory && userMessage && userMessage.length > 5) {
 // Extract keywords from message for fast FTS lookup
 var words = userMessage.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ').split(/\s+/).filter(Boolean);
 var searchTerms = words.slice(0, 5).join(' ');
 if (searchTerms.length > 2) {
 var memResult = null;
 if (typeof memory.search === 'function') {
 memResult = await memory.search(searchTerms, { limit: 5 });
 } else if (typeof memory.searchMemories === 'function') {
 memResult = await memory.searchMemories(searchTerms, { limit: 5 });
 }
 if (memResult && memResult.length > 0) {
 var memSection = memResult.map(function(m) {
 var content = m.content || m.text || '';
 return ' - [' + (m.type || 'memory') + '] ' + content.slice(0, 150);
 }).join('\n');
 context.highConfidenceSections.push('[ACI 预取记忆]\n' + memSection);
 }
 }
 }
 } catch (e) {
   /* memory prefetch non-critical */
   console.warn('[injector.js] 空 catch 补日志:', e && e.message);
 }
 // ------- Step 2 & 3: Look up patterns and prefetch tools -------
 for (const intent of detectedIntents) {
 const { name, confidence, tags } = intent;

 // Check prefetch cache for tags
 if (tags && tags.length > 0 && this._cache) {
 cacheLookups.push({ intent: name, confidence, tags });
 }

 // Look up pattern learner
 if (this._patternLearner) {
 const pattern = this._patternLearner.getPattern(name);
 if (pattern && toolExecutor) {
 // Execute prefetch tools in parallel
 for (const toolName of pattern.chain) {
 prefetchPromises.push(
 this._executePrefetchTool(toolName, name, confidence, toolExecutor)
 );
 }
 }
 }
 }

 // ------- Step 4: Execute prefetch tools (parallel, with timeout) -------
 let prefetchResults = [];
 if (prefetchPromises.length > 0) {
 try {
 const timeoutMs = Math.max(0, this._prepareTimeout - (Date.now() - startTs));
 prefetchResults = await this._raceWithTimeout(
 Promise.allSettled(prefetchPromises),
 timeoutMs
 );
 } catch {
 // Timeout — proceed with what we have
 console.warn('[aci-injector] prefetch tools timed out, proceeding with partial results');
 }
 }

 // ------- Step 4b: Check prefetch cache -------
 const cachedEntries = [];
 for (const lookup of cacheLookups) {
 if (this._cache) {
 try {
 const entries = this._cache.getByTags(lookup.tags);
 for (const entry of entries) {
 cachedEntries.push({
 intent: lookup.intent,
 confidence: lookup.confidence,
 key: entry.key,
 data: entry.data,
 source: entry.source,
 fetchedAt: entry.fetchedAt,
 });
 }
 } catch (e) {
 console.warn('[aci-injector] cache lookup error, continuing:', e.message);
 }
 }
 }

 // ------- Step 5: Attach thread context -------
 let threadContext = null;
 if (this._threadManager) {
 try {
 threadContext = this._getThreadContext();
 } catch {
 console.warn('[aci-injector] thread context error, continuing');
 }
 }

 // ------- Step 6: Attach scene manifest -------
 let sceneManifest = null;
 if (this._sceneStore) {
 try {
 sceneManifest = this._sceneStore.getManifest();
 } catch {
 console.warn('[aci-injector] scene manifest error, continuing');
 }
 }

 // ------- Build confidence-gated sections -------
 // 暴露给 context-builder 用，便于注入工具链预判信息
 context.rawContext.detectedIntents = detectedIntents;
 context.rawContext.intent = detectedIntents.length > 0 ? detectedIntents[0] : null;
 this._buildSections(context, { cachedEntries, prefetchResults, threadContext, sceneManifest });

 } catch (err) {
 console.warn('[aci-injector] prepare error:', err.message);
 }

 context.elapsed = Date.now() - startTs;
 this._preparedContext = context;

 // ── 消费 UI 上行的 intents（：manifest 是背景状态，intent 是触发器）──
 if (this._sceneStore && typeof this._sceneStore.consumePendingIntents === 'function') {
 try {
 const intents = this._sceneStore.consumePendingIntents();
 if (intents && intents.length > 0) {
 const intentText = intents.map(i =>
 ` - surface=${i.surface}, intent=${i.name}, data=${JSON.stringify(i.data || {}).slice(0, 120)}`
 ).join('\n');
 context.highConfidenceSections.push(
 `[Recent User Intents (UI → Agent)]\n${intentText}`
 );
 }
 } catch (e) {

   // 静默：intents 不可用不影响主流程

   console.warn('[injector.js] 空 catch 补日志:', e && e.message);
 }
 }

 this.emit('aci:context-ready', context);
 return context;
 }

 /**
 * Get the last prepared context.
 *
 * @returns {object}
 */
 getContext() {
 return this._preparedContext;
 }

 /**
 * Get sections with confidence > 0.85 — suitable for direct system prompt injection.
 *
 * @returns {string[]}
 */
 getHighConfidenceSections() {
 return this._preparedContext.highConfidenceSections || [];
 }

 /**
 * Get sections with confidence 0.5-0.85 — suitable for "may need" hint format.
 *
 * @returns {string[]}
 */
 getMediumConfidenceSections() {
 return this._preparedContext.mediumConfidenceSections || [];
 }

 /**
 * Register or update an intent detection pattern.
 *
 * @param {string} name Intent name
 * @param {object} pattern { keywords: string[], confidence: number, tags: string[] }
 */
 registerIntentPattern(name, pattern) {
 if (!name || !pattern || !Array.isArray(pattern.keywords)) {
 console.warn('[aci-injector] registerIntentPattern: invalid arguments');
 return;
 }
 this._intentPatterns[name] = {
 keywords: pattern.keywords,
 confidence: typeof pattern.confidence === 'number' ? pattern.confidence : 0.8,
 tags: Array.isArray(pattern.tags) ? pattern.tags : [],
 };
 }

 /**
 * Remove an intent pattern.
 *
 * @param {string} name
 * @returns {boolean}
 */
 removeIntentPattern(name) {
 if (DEFAULT_INTENT_PATTERNS[name]) {
 console.warn('[aci-injector] cannot remove built-in intent pattern:', name);
 return false;
 }
 return delete this._intentPatterns[name];
 }

 /**
 * Get injector diagnostics.
 *
 * @returns {object}
 */
 getDiagnostics() {
 return {
 patterns: Object.keys(this._intentPatterns).length,
 hasCache: !!this._cache,
 hasPatternLearner: !!this._patternLearner,
 hasSceneStore: !!this._sceneStore,
 hasThreadManager: !!this._threadManager,
 hasToolExecutor: !!this._toolExecutor,
 lastPreparedAt: this._preparedContext.preparedAt,
 lastElapsed: this._preparedContext.elapsed,
 highConfidenceCount: this._preparedContext.highConfidenceSections.length,
 mediumConfidenceCount: this._preparedContext.mediumConfidenceSections.length,
 };
 }

 // -----------------------------------------------------------------------
 // Internal: Intent Detection
 // -----------------------------------------------------------------------

 /**
 * Detect matching intents from user message.
 *
 * @param {string} message
 * @returns {Array<{ name: string, confidence: number, tags: string[] }>}
 */
 _detectIntents(message) {
 if (!message) return [];

 const lowerMsg = message.toLowerCase();
 const matches = [];

 for (const [name, pattern] of Object.entries(this._intentPatterns)) {
 const matchCount = pattern.keywords.filter(kw => lowerMsg.includes(kw.toLowerCase())).length;
 if (matchCount > 0) {
 // Scale confidence by match ratio
 const ratio = matchCount / pattern.keywords.length;
 const confidence = Math.min(pattern.confidence, 0.5 + ratio * 0.5);
 matches.push({ name, confidence, tags: pattern.tags });
 }
 }

 // Sort by confidence descending
 matches.sort((a, b) => b.confidence - a.confidence);

 // Take top 3 at most
 return matches.slice(0, 3);
 }

 /**
 * Get intents by explicit name (force mode).
 *
 * @param {string[]} names
 * @returns {Array<{ name: string, confidence: number, tags: string[] }>}
 */
 _getIntentsByNames(names) {
 const results = [];
 for (const name of names) {
 const pattern = this._intentPatterns[name];
 if (pattern) {
 results.push({ name, confidence: 1.0, tags: pattern.tags });
 }
 }
 return results;
 }

 // -----------------------------------------------------------------------
 // Internal: Prefetch Tool Execution
 // -----------------------------------------------------------------------

 /**
 * Execute a single prefetch tool and cache the result.
 *
 * @param {string} toolName
 * @param {string} intentName
 * @param {number} confidence
 * @param {function} toolExecutor
 * @returns {Promise<object|null>}
 */
 async _executePrefetchTool(toolName, intentName, confidence, toolExecutor) {
 try {
 // Check cache first
 const cacheKey = `prefetch:${intentName}:${toolName}`;
 if (this._cache) {
 const cached = this._cache.get(cacheKey);
 if (cached) {
 return {
 tool: toolName,
 intent: intentName,
 confidence,
 data: cached.data,
 source: cached.source,
 cached: true,
 };
 }
 }

 // Execute tool
 const result = await toolExecutor(toolName, { intent: intentName });
 const section = {
 tool: toolName,
 intent: intentName,
 confidence,
 data: result,
 source: `prefetch:${intentName}`,
 cached: false,
 };

 // Store in cache
 if (this._cache && result !== null && result !== undefined) {
 this._cache.set(cacheKey, result, {
 ttlMs: 5 * 60 * 1000, // 5 min TTL for prefetched data
 tags: [intentName, toolName],
 source: `prefetch:${intentName}`,
 });
 }

 return section;
 } catch {
 console.warn('[aci-injector] prefetch tool execution error:', toolName);
 return null;
 }
 }

 // -----------------------------------------------------------------------
 // Internal: Section Building
 // -----------------------------------------------------------------------

 /**
 * Build the confidence-gated context sections.
 *
 * @param {object} context Mutable context object
 * @param {object} sources
 */
 _buildSections(context, sources) {
 const { cachedEntries, prefetchResults, threadContext, sceneManifest } = sources;

 // Process prefetch results (from tool execution)
 for (const result of prefetchResults) {
 if (!result || !result.value) continue;
 const section = result.value;
 if (!section) continue;

 const text = this._formatSection(section);
 if (section.confidence > HIGH_CONFIDENCE_THRESHOLD) {
 context.highConfidenceSections.push(text);
 } else if (section.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
 context.mediumConfidenceSections.push(text);
 }
 }

 // Process cached entries
 for (const entry of cachedEntries) {
 const text = `[Prefetched: ${entry.source || entry.key}]\n${JSON.stringify(entry.data, null, 2)}`;
 if (entry.confidence > HIGH_CONFIDENCE_THRESHOLD) {
 context.highConfidenceSections.push(text);
 } else if (entry.confidence >= MEDIUM_CONFIDENCE_THRESHOLD) {
 context.mediumConfidenceSections.push(text);
 }
 }

 // Thread context (high confidence if available)
 if (threadContext) {
 context.highConfidenceSections.push(
 `[Active Thread Context]\n${threadContext}`
 );
 }

 // Scene manifest (medium confidence) — 紧凑文本格式（）
 if (sceneManifest) {
 const manifestText = this._formatManifest(sceneManifest);
 if (manifestText) {
 context.mediumConfidenceSections.push(
 `[Current Scene — what is on the screen right now]\n${manifestText}\n` +
 `Use these ids when calling SceneSet(id, …) to update or remove a surface.`
 );
 }
 }
 }

 /**
 * 格式化 scene manifest 为紧凑文本（）
 * 只给 id + kind + 一行摘要 + 重要性，节省 token。
 * @param {{rev:number, manifest:Array<{id:string,kind:string,dataSummary:string,intent:string}>}} sceneManifest
 * @returns {string}
 */
 _formatManifest(sceneManifest) {
 if (!sceneManifest || !Array.isArray(sceneManifest.manifest)) return '';
 if (sceneManifest.manifest.length === 0) return '(empty)';
 return sceneManifest.manifest.map(s => {
 // intent 短码: confront=C, inform=I, ambient=A
 const intentTag = s.intent === 'confront' ? 'C' : s.intent === 'ambient' ? 'A' : 'I';
 return ` - ${s.id} (${s.kind}/${intentTag}) 「${s.dataSummary}」`;
 }).join('\n');
 }

 /**
 * Format a prefetch tool result into a text section.
 *
 * @param {object} section
 * @returns {string}
 */
 _formatSection(section) {
 const dataStr = typeof section.data === 'string'
 ? section.data
 : JSON.stringify(section.data, null, 2);
 return `[Prefetch: ${section.intent} / ${section.tool}]\n${dataStr}`;
 }

 // -----------------------------------------------------------------------
 // Internal: Thread Context
 // -----------------------------------------------------------------------

 /**
 * Get thread context string from the thread manager.
 *
 * @returns {string|null}
 */
 _getThreadContext() {
 if (!this._threadManager) return null;

 // Prefer getThreadContext if available (from threads/index.js)
 if (typeof this._threadManager.getThreadContext === 'function') {
 return this._threadManager.getThreadContext();
 }

 // Fallback: use getAllThreads or listThreads
 if (typeof this._threadManager.getAllThreads === 'function') {
 return this._threadManager.getAllThreads();
 }

 if (typeof this._threadManager.listThreads === 'function') {
 const threads = this._threadManager.listThreads();
 return JSON.stringify(threads, null, 2);
 }

 return null;
 }

 // -----------------------------------------------------------------------
 // Internal: Timeout helper
 // -----------------------------------------------------------------------

 /**
 * Race a promise against a timeout.
 *
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @returns {Promise<*>}
 */
 _raceWithTimeout(promise, timeoutMs) {
 if (timeoutMs <= 0) {
 return Promise.reject(new Error('timeout'));
 }

 let timer;
 const timeout = new Promise((_, reject) => {
 timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
 });

 return Promise.race([promise, timeout]).finally(() => {
 if (timer) clearTimeout(timer);
 });
 }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance = null;

/**
 * Get or create the global ACIInjector singleton.
 *
 * @param {object} [deps] Dependencies passed on first creation only
 * @param {object} [options] Options passed on first creation only
 * @returns {ACIInjector}
 */
function getACIInjector(deps, options) {
 if (!_instance) {
 _instance = new ACIInjector(deps || {}, options || {});
 }
 return _instance;
}

/**
 * Check if the singleton has been created (without creating it).
 * @returns {boolean}
 */
function hasACIInjector() {
 return _instance !== null;
}

module.exports = { ACIInjector, getACIInjector, hasACIInjector };
