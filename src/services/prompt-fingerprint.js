/**
 * Prompt Fingerprint Service
 * 
 * 稳定系统提示指纹，提升提示词缓存命中率
 */

const crypto = require('crypto');

const DYNAMIC_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g,
  /session_\d+_[a-z0-9]+/g,
  /\d{13,}/g,
  /0x[a-fA-F0-9]{8,}/g,
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
];

const PLACEHOLDERS = {
  timestamp: '{{TIMESTAMP}}',
  sessionId: '{{SESSION_ID}}',
  timestampMs: '{{TIMESTAMP_MS}}',
  hex: '{{HEX}}',
  uuid: '{{UUID}}',
};

class PromptFingerprint {
  constructor(config = {}) {
    this.config = {
      maxCacheSize: config.maxCacheSize || 1000,
      cacheTTL: config.cacheTTL || 24 * 60 * 60 * 1000,
      ...config,
    };
    
    this.cache = new Map();
    this.lastFingerprint = null;
    this.stats = {
      hits: 0,
      misses: 0,
      totalTokensSaved: 0,
    };
  }

  computeFingerprint(systemPrompt, tools, context = {}) {
    const stable = {
      system: this._normalizeSystemPrompt(systemPrompt),
      toolsHash: this._hashTools(tools),
      contextHash: this._hashContext(context),
    };
    
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify(stable))
      .digest('hex')
      .slice(0, 16);
    
    this.lastFingerprint = fingerprint;
    return fingerprint;
  }

  _normalizeSystemPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') {
      return '';
    }

    let normalized = prompt;
    
    DYNAMIC_PATTERNS.forEach((pattern, index) => {
      const placeholder = Object.values(PLACEHOLDERS)[index];
      normalized = normalized.replace(pattern, placeholder);
    });

    return normalized
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  }

  _hashTools(tools) {
    if (!tools || !Array.isArray(tools)) {
      return 'no-tools';
    }

    const core = tools
      .map(t => ({
        name: t?.name || 'unknown',
        description: (t?.description || '').slice(0, 100),
        parametersType: t?.parameters?.type || 'object',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return crypto
      .createHash('md5')
      .update(JSON.stringify(core))
      .digest('hex')
      .slice(0, 8);
  }

  _hashContext(context) {
    const messages = context.messages || [];
    
    return {
      messageCount: messages.length,
      hasImages: messages.some(m => {
        const content = m?.content;
        if (Array.isArray(content)) {
          return content.some(c => c?.type === 'image');
        }
        return false;
      }),
      hasToolResults: messages.some(m => m?.role === 'tool'),
      userMessageCount: messages.filter(m => m?.role === 'user').length,
      assistantMessageCount: messages.filter(m => m?.role === 'assistant').length,
    };
  }

  isCacheHit(fingerprint) {
    const cached = this.cache.get(fingerprint);
    
    if (!cached) {
      this.stats.misses++;
      return false;
    }

    if (Date.now() - cached.timestamp > this.config.cacheTTL) {
      this.cache.delete(fingerprint);
      this.stats.misses++;
      return false;
    }

    this.stats.hits++;
    cached.hits++;
    return true;
  }

  recordCacheHit(fingerprint, tokens = 0) {
    const existing = this.cache.get(fingerprint);
    
    if (existing) {
      existing.tokens += tokens;
      existing.lastHit = Date.now();
    } else {
      if (this.cache.size >= this.config.maxCacheSize) {
        this._evictOldest();
      }
      
      this.cache.set(fingerprint, {
        timestamp: Date.now(),
        tokens,
        hits: 1,
        lastHit: Date.now(),
      });
    }

    this.stats.totalTokensSaved += tokens;
  }

  _evictOldest() {
    let oldest = null;
    let oldestTime = Infinity;

    for (const [key, value] of this.cache) {
      if (value.lastHit < oldestTime) {
        oldestTime = value.lastHit;
        oldest = key;
      }
    }

    if (oldest) {
      this.cache.delete(oldest);
    }
  }

  getCacheStats() {
    const entries = Array.from(this.cache.entries());
    
    return {
      totalEntries: this.cache.size,
      totalHits: this.stats.hits,
      totalMisses: this.stats.misses,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0,
      totalTokensSaved: this.stats.totalTokensSaved,
      topHits: entries
        .sort((a, b) => b[1].hits - a[1].hits)
        .slice(0, 5)
        .map(([fingerprint, data]) => ({
          fingerprint: fingerprint.slice(0, 8),
          hits: data.hits,
          tokens: data.tokens,
        })),
    };
  }

  clear() {
    this.cache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      totalTokensSaved: 0,
    };
  }

  export() {
    return {
      cache: Array.from(this.cache.entries()),
      stats: this.stats,
      config: this.config,
    };
  }

  import(data) {
    if (data?.cache) {
      this.cache = new Map(data.cache);
    }
    if (data?.stats) {
      this.stats = data.stats;
    }
  }
}

const promptFingerprint = new PromptFingerprint();

module.exports = {
  PromptFingerprint,
  promptFingerprint,
};
