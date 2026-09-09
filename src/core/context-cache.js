/**
 * Context Cache - 上下文缓存模块
 * 
 * 缓存不常变化的上下文数据，减少每次请求的重复计算
 */



const EventEmitter = require('events');
// eslint-disable-next-line no-unused-vars
const { GLOBAL_SKILLS_DIR, DATA_DIR } = require('./config');
const { createMultiCacheStats } = require('./caching/cache-stats');

class ContextCache extends EventEmitter {
  constructor() {
    super();
    this._skillsCache = null;
    this._skillsCacheTime = 0;
    this._skillsCacheTTL = 5 * 60 * 1000; // 5min：技能定义很少变化，配合目录监听自动失效，延长 TTL 提升命中率

    this._toolDefsCache = null;

    this._systemPromptCache = new Map(); // configHash -> { prompt, version, timestamp }
    this._systemPromptCacheTTL = 15 * 60 * 1000; // 15min：系统提示词稳定，延长 TTL 提升命中率

    this._historyCache = new Map(); // userId -> { messages, timestamp }
    this._historyCacheTTL = 60 * 1000; // 60s：历史记录变化频率中等，适度延长减少重复加载

    this._watchers = new Set();
    this._initialized = false;

    // 多分项命中率统计：skills / toolDefs / systemPrompt / layeredPrompt / history
    this._stats = createMultiCacheStats('context', [
      'skills', 'toolDefs', 'systemPrompt', 'layeredPrompt', 'history'
    ]);
  }

  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    this._watchSkillsDir();
    console.log('📦 上下文缓存已初始化');
  }

  _watchSkillsDir() {
    try {
      // 2026-08-01: 统一到 skill-hot-reload 的单一 watch 源。
      // 此前此处重复 fs.watch 且只监听 global 目录——builtin 技能（skills/）
      // 变更不会失效 ai.js 缓存。hot-reloader 已覆盖两个目录且有防抖，
      // onReload 回调可在 start() 前注册（回调数组模式）。
      const { getHotReloader } = require('./skill-hot-reload');
      const reloader = getHotReloader();
      if (reloader && typeof reloader.onReload === 'function') {
        reloader.onReload(() => {
          this.invalidateSkills();
          this.emit('skills-dir-changed');
        });
      }
    } catch (e) {
      console.warn('技能热重载订阅失败:', e.message);
    }
  }

  // 技能缓存
  invalidateSkills() {
    this._skillsCache = null;
    this._skillsCacheTime = 0;
  }

  getSkills(loadFn) {
    const now = Date.now();
    if (this._skillsCache && (now - this._skillsCacheTime) < this._skillsCacheTTL) {
      this._stats.hit('skills');
      return this._skillsCache;
    }
    this._stats.miss('skills');
    const skills = loadFn();
    this._skillsCache = skills;
    this._skillsCacheTime = now;
    return skills;
  }

  // 工具定义缓存（启动时加载一次）
  getToolDefinitions(loadFn) {
    if (!this._toolDefsCache) {
      this._stats.miss('toolDefs');
      this._toolDefsCache = loadFn();
    } else {
      this._stats.hit('toolDefs');
    }
    return this._toolDefsCache;
  }

  invalidateToolDefinitions() {
    this._toolDefsCache = null;
  }

  // 系统提示词缓存
  _hashConfig(config, options) {
    const key = JSON.stringify({
      agentName: config.agent?.name,
      agentPersonality: config.agent?.personality,
      currentProvider: config.models?.currentProvider,
      toolCount: options.toolNames?.length || 0,
      skillPromptLength: options.skillsPrompt?.length || 0,
      // P1-4: 技能清单按语境注入后每轮内容不同, 仅按长度会碰撞（不同语境同长度互相串缓存）
      skillPromptHead: String(options.skillsPrompt || '').slice(0, 48),
      memoryPromptLength: options.memoryPrompt?.length || 0,
      runtimeModel: options.runtimeInfo?.model || '',
      runtimeProvider: options.runtimeInfo?.provider || '',
      runtimeDate: options.runtimeInfo?.currentDate || '',
      runtimeTimeOfDay: options.runtimeInfo?.timeOfDay || ''
    });
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  getSystemPrompt(config, options, buildFn) {
    const cacheKey = this._hashConfig(config, options);
    const cached = this._systemPromptCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this._systemPromptCacheTTL) {
      this._stats.hit('systemPrompt');
      return cached.prompt;
    }
    this._stats.miss('systemPrompt');
    const prompt = buildFn();
    this._systemPromptCache.set(cacheKey, {
      prompt,
      timestamp: now
    });

    for (const [key, value] of this._systemPromptCache) {
      if ((now - value.timestamp) > this._systemPromptCacheTTL) {
        this._systemPromptCache.delete(key);
        this._stats.evict('systemPrompt');
      }
    }

    return prompt;
  }

  getLayeredSystemPrompt(config, options, buildFn) {
    const stableKey = 'stable_' + this._hashStableConfig(config, options);
    const contextKey = 'context_' + this._hashContextConfig(config, options);
    const now = Date.now();

    let stable = null;
    const stableCached = this._systemPromptCache.get(stableKey);
    if (stableCached && (now - stableCached.timestamp) < this._systemPromptCacheTTL * 12) {
      stable = stableCached.prompt;
      this._stats.hit('layeredPrompt');
    } else {
      this._stats.miss('layeredPrompt');
    }

    let context = null;
    const contextCached = this._systemPromptCache.get(contextKey);
    if (contextCached && (now - contextCached.timestamp) < this._systemPromptCacheTTL * 4) {
      context = contextCached.prompt;
    }

    const layered = buildFn({ cachedStable: stable, cachedContext: context });

    if (!stable || layered.stableHash !== stableCached?.hash) {
      this._systemPromptCache.set(stableKey, {
        prompt: layered.stable,
        hash: layered.stableHash,
        timestamp: now,
      });
    }

    if (!context || layered.contextHash !== contextCached?.hash) {
      this._systemPromptCache.set(contextKey, {
        prompt: layered.context,
        hash: layered.contextHash,
        timestamp: now,
      });
    }

    return layered;
  }

  _hashStableConfig(config, options) {
    const key = JSON.stringify({
      agentName: config.agent?.name,
      agentPersonality: config.agent?.personality,
      agentVibe: config.agent?.vibe,
      agentCreature: config.agent?.creature,
      agentSystemPrompt: config.agent?.systemPrompt,
      toolCount: options.toolNames?.length || 0,
      toolNames: (options.toolNames || []).sort().join(','),
    });
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  _hashContextConfig(config, options) {
    const key = JSON.stringify({
      userName: config.user?.name,
      userCallMe: config.user?.callMe,
      channel: Array.isArray(options.channel || config.chatChannel) ? (options.channel || config.chatChannel)[0] : (options.channel || config.chatChannel),
    });
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  invalidateSystemPrompt() {
    this._systemPromptCache.clear();
  }

  // 历史消息缓存
  async getHistory(userId, loadFn) {
    const cached = this._historyCache.get(userId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this._historyCacheTTL) {
      this._stats.hit('history');
      return cached.messages;
    }
    this._stats.miss('history');
    const messages = await loadFn();
    this._historyCache.set(userId, { messages, timestamp: Date.now() });

    return messages;
  }

  invalidateHistory(userId) {
    if (userId) {
      // 2026-08-13 P2-4: 前缀清理——会话恢复后缓存键复合为 userId:sessionId,
      // 必须清掉该 userId 的全部会话键,否则换会话后读到旧缓存(60s TTL 放大问题)
      this._historyCache.delete(userId);
      const prefix = userId + ':';
      for (const key of this._historyCache.keys()) {
        if (key.startsWith(prefix)) this._historyCache.delete(key);
      }
    } else {
      this._historyCache.clear();
    }
  }

  // 清理所有缓存
  clearAll() {
    this._skillsCache = null;
    this._toolDefsCache = null;
    this._systemPromptCache.clear();
    this._historyCache.clear();
  }

  // 获取缓存统计
  getStats() {
    return this._stats.getStats({
      skillsCached: !!this._skillsCache,
      toolDefsCached: !!this._toolDefsCache,
      systemPromptEntries: this._systemPromptCache.size,
      historyEntries: this._historyCache.size,
      skillsCacheTTL: this._skillsCacheTTL,
      systemPromptCacheTTL: this._systemPromptCacheTTL,
      historyCacheTTL: this._historyCacheTTL,
    });
  }

  resetStats() {
    this._stats.resetStats();
  }

  destroy() {
    for (const watcher of this._watchers) {
      watcher.close();
    }
    this._watchers.clear();
  }
}

const contextCache = new ContextCache();

module.exports = { ContextCache, contextCache };
