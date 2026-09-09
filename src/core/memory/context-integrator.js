const { EventEmitter } = require('events');

const MAX_CONTEXT_TOKENS = 4000;
const MAX_PREFETCH_RESULTS = 15;
const MAX_ENTITY_CONTEXT = 5;
const MAX_SESSION_CONTEXT = 8;

class ContextIntegrator extends EventEmitter {
  constructor(memoryManager, config = {}) {
    super();
    this.memoryManager = memoryManager;
    this.config = {
      maxContextTokens: config.maxContextTokens || MAX_CONTEXT_TOKENS,
      maxPrefetchResults: config.maxPrefetchResults || MAX_PREFETCH_RESULTS,
      maxEntityContext: config.maxEntityContext || MAX_ENTITY_CONTEXT,
      maxSessionContext: config.maxSessionContext || MAX_SESSION_CONTEXT,
      enablePrefetch: config.enablePrefetch !== false,
      enableEntityContext: config.enableEntityContext !== false,
      enableSessionContext: config.enableSessionContext !== false,
      enableUserModel: config.enableUserModel !== false,
    };
    this._prefetchCache = new Map();
    this._prefetchCacheTTL = 5 * 60 * 1000;
    this._turnCount = 0;
  }

  async prepareContext(userMessage, options = {}) {
    const context = {
      memories: [],
      entities: [],
      sessionHighlights: [],
      userPreferences: null,
      relatedFacts: [],
      prefetchResults: [],
    };

    const tokenBudget = this.config.maxContextTokens;
    let usedTokens = 0;

    const memoryResults = await this._fetchRelevantMemories(userMessage, options);
    for (const mem of memoryResults) {
      const tokens = this._estimateTokens(mem.content || '');
      if (usedTokens + tokens > tokenBudget * 0.4) break;
      context.memories.push(mem);
      usedTokens += tokens;
    }

    if (this.config.enableEntityContext) {
      const entityResults = await this._fetchEntityContext(userMessage, options);
      for (const entity of entityResults.slice(0, this.config.maxEntityContext)) {
        const tokens = this._estimateTokens(JSON.stringify(entity));
        if (usedTokens + tokens > tokenBudget * 0.2) break;
        context.entities.push(entity);
        usedTokens += tokens;
      }
    }

    if (this.config.enableSessionContext) {
      const sessionResults = await this._fetchSessionContext(userMessage, options);
      for (const session of sessionResults.slice(0, this.config.maxSessionContext)) {
        const tokens = this._estimateTokens(session.content || '');
        if (usedTokens + tokens > tokenBudget * 0.2) break;
        context.sessionHighlights.push(session);
        usedTokens += tokens;
      }
    }

    if (this.config.enableUserModel) {
      try {
        const userModel = this.memoryManager.enhancedMemory?.entityResolver;
        if (userModel && typeof userModel.getStats === 'function') {
          context.userPreferences = await this._fetchUserPreferences(options);
        }
      } catch (e) {

        // ignore

        console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
      }

    }

    if (this.config.enablePrefetch) {
      context.prefetchResults = await this._prefetchRelated(userMessage, options);
    }

    this._turnCount++;
    this.emit('context:prepared', {
      turnCount: this._turnCount,
      memoryCount: context.memories.length,
      entityCount: context.entities.length,
      sessionCount: context.sessionHighlights.length,
      usedTokens,
    });

    return context;
  }

  formatContextBlock(context) {
    const parts = [];

    if (context.memories.length > 0) {
      parts.push('## 相关记忆');
      for (const mem of context.memories) {
        const trust = mem.trustScore ? ` [信任:${(mem.trustScore * 100).toFixed(0)}%]` : '';
        const source = mem.source ? ` [${mem.source}]` : '';
        parts.push(`- **${mem.title || mem.content?.slice(0, 50)}**${trust}${source}`);
        if (mem.content && mem.content.length > 50) {
          parts.push(`  ${mem.content.slice(0, 200)}`);
        }
      }
      parts.push('');
    }

    if (context.entities.length > 0) {
      parts.push('## 相关实体');
      for (const entity of context.entities) {
        parts.push(`- **${entity.name}** (${entity.type || '未知'}): ${entity.factCount || 0} 条关联记忆`);
      }
      parts.push('');
    }

    if (context.sessionHighlights.length > 0) {
      parts.push('## 近期对话要点');
      for (const session of context.sessionHighlights) {
        parts.push(`- ${session.content?.slice(0, 150) || session.title}`);
      }
      parts.push('');
    }

    if (context.userPreferences) {
      parts.push('## 用户偏好');
      const prefs = context.userPreferences;
      if (prefs.summary) {
        parts.push(prefs.summary);
      } else {
        if (prefs.communicationStyle) {
          parts.push(`- 沟通风格: ${prefs.communicationStyle}`);
        }
        if (prefs.techLevel) {
          parts.push(`- 技术水平: ${prefs.techLevel}`);
        }
        if (prefs.preferredTopics?.length > 0) {
          parts.push(`- 关注领域: ${prefs.preferredTopics.join(', ')}`);
        }
      }
      parts.push('');
    }

    if (parts.length === 0) {
      return '';
    }

    return `<memory-context>\n${parts.join('\n')}\n</memory-context>`;
  }

  async _fetchRelevantMemories(userMessage, options = {}) {
    try {
      return await this.memoryManager.searchMemories(userMessage, this.config.maxPrefetchResults, {
        useEnhanced: true,
        ...options,
      });
    } catch (e) {
      return [];
    }
  }

  async _fetchEntityContext(userMessage, options = {}) {
    const em = this.memoryManager.enhancedMemory;
    if (!em || !em.entityExtractor) return [];

    try {
      const extractedEntities = em.entityExtractor.extractWithConfidence(userMessage);
      const entityContexts = [];

      for (const entity of extractedEntities) {
        try {
          const probeResult = await em.probeEntity(entity.name, options);
          if (probeResult.entity) {
            entityContexts.push({
              name: probeResult.entity.name,
              type: probeResult.entity.type,
              factCount: probeResult.facts?.length || 0,
              relatedFacts: probeResult.facts?.slice(0, 3) || [],
            });
          }
        } catch (e) {

          // skip entity

          console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
        }

      }

      return entityContexts;
    } catch (e) {
      return [];
    }
  }

  async _fetchSessionContext(userMessage, options = {}) {
    const results = [];

    try {
      const fts = this.memoryManager.ftsSearch;
      if (fts && typeof fts.searchSessions === 'function') {
        const sessionResults = await fts.searchSessions(userMessage, this.config.maxSessionContext);
        for (const sr of sessionResults) {
          results.push({
            sessionId: sr.sessionId,
            content: sr.content,
            role: sr.role,
            score: sr.score,
          });
        }
      }
    } catch (e) {

      // ignore

      console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
    }


    if (results.length === 0) {
      try {
      const recentContext = await this.memoryManager.getRecentContext(7, options.userId);
      if (recentContext && Array.isArray(recentContext)) {
      for (const ctx of recentContext.slice(0, this.config.maxSessionContext)) {
      results.push({
      sessionId: ctx.sessionId,
      content: ctx.summary || ctx.title || '',
      score: 0.3,
      });
      }
      }
      } catch (e) {
        // ignore
        console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
      }

    }

    return results;
  }

  // eslint-disable-next-line no-unused-vars
  async _fetchUserPreferences(options = {}) {
    try {
      // S4: 优先读 user_profile_facets(StabilityDetector 已写入真实偏好画像)。
      // 旧实现恒走占位 fallback(communicationStyle:'adaptive'/techLevel:'auto-detected'
      // 死数据),因为 memoryManager._userModel 从未赋值、EnhancedMemorySystem 无 userModel。
      const store = this.memoryManager?.unifiedStore;
      if (store && typeof store.getActiveFacets === 'function') {
        const facets = store.getActiveFacets('global');
        if (facets && facets.length > 0) {
          const preferredTopics = [];
          const communicationStyle = [];
          for (const f of facets) {
            if (f && f.value) {
              preferredTopics.push(String(f.value).slice(0, 60));
              if (f.facet_class === 'style') communicationStyle.push(String(f.value).slice(0, 60));
            }
          }
          return {
            summary: preferredTopics.length > 0 ? `用户偏好: ${preferredTopics.slice(0, 5).join('；')}` : '',
            communicationStyle: communicationStyle[0] || 'adaptive',
            techLevel: 'auto-detected',
            preferredTopics,
            facetCount: facets.length,
          };
        }
      }

      // 回退到基础偏好信息
      const em = this.memoryManager?.enhancedMemory;
      if (!em) return null;
      const stats = em.entityResolver?.getStats?.() || {};
      return {
        communicationStyle: 'adaptive',
        techLevel: 'auto-detected',
        preferredTopics: [],
        entityCount: stats.total || 0,
      };
    } catch (e) {
      return null;
    }
  }

  async _prefetchRelated(userMessage, options = {}) {
    const cacheKey = userMessage.slice(0, 100);
    const cached = this._prefetchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this._prefetchCacheTTL) {
      return cached.results;
    }

    const prefetchResults = [];

    try {
      const em = this.memoryManager.enhancedMemory;
      if (em && em.contextManager && typeof em.contextManager.prepareContext === 'function') {
        const ctxResult = await em.contextManager.prepareContext(userMessage, {
          maxResults: 5,
          ...options,
        });
        if (ctxResult && ctxResult.memories) {
          prefetchResults.push(...ctxResult.memories);
        }
      }
    } catch (e) {

      // ignore

      console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
    }


    this._prefetchCache.set(cacheKey, {
      results: prefetchResults,
      timestamp: Date.now(),
    });

    if (this._prefetchCache.size > 100) {
      const oldest = [...this._prefetchCache.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < 50; i++) {
        this._prefetchCache.delete(oldest[i][0]);
      }
    }

    return prefetchResults;
  }

  async onTurnComplete(userMessage, assistantMessage, options = {}) {
    try {
      const em = this.memoryManager.enhancedMemory;
      if (em && typeof em.updateFromConversation === 'function') {
        const messages = [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantMessage },
        ];
        await em.updateFromConversation(messages, options);
      }
    } catch (e) {

      // ignore

      console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
    }


    try {
      const fts = this.memoryManager.ftsSearch;
      if (fts && typeof fts.indexSessionMessage === 'function') {
        await fts.indexSessionMessage(options.sessionId || 'default', 'user', userMessage);
        await fts.indexSessionMessage(options.sessionId || 'default', 'assistant', assistantMessage);
      }
    } catch (e) {

      // ignore

      console.warn('[context-integrator.js] 空 catch 补日志:', e && e.message);
    }


    this.emit('turn:complete', {
      turnCount: this._turnCount,
      userMessageLength: userMessage.length,
      assistantMessageLength: assistantMessage.length,
    });
  }

  _estimateTokens(text) {
    if (!text) return 0;
    const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.ceil(cjkChars * 1.5 + otherChars / 4);
  }

  getStats() {
    return {
      turnCount: this._turnCount,
      prefetchCacheSize: this._prefetchCache.size,
      config: this.config,
    };
  }
}

module.exports = { ContextIntegrator };
