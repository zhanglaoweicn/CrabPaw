/**
 * Prompt Caching - 提示缓存系统
 *
 * 策略: system_and_3
 * - 系统提示 (稳定)
 * - 最近 3 条非系统消息 (滚动窗口)
 * - 减少 ~75% 输入 Token 成本
 *
 * 支持:
 * - OpenAI (gpt-4o, gpt-4.1, o3)
 * - Anthropic (Claude 3/4)
 * - DeepSeek (chat, reasoner)
 * - Google (Gemini 2.x)
 */

const { createCacheStats } = require('./cache-stats');

// 全局 LLM 服务端缓存统计（由 ai.js 调用 recordLLMCache 更新）
const _llmCacheStats = createCacheStats('llmPromptCache');

const PROVIDER_CONFIG = {
  openai: {
    supportsCaching: true,
    maxBreakpoints: 4,
    cacheField: 'cache_control',
    cacheValue: { type: 'ephemeral' },
    ttlSupport: false
  },
  anthropic: {
    supportsCaching: true,
    maxBreakpoints: 4,
    cacheField: 'cache_control',
    cacheValue: { type: 'ephemeral' },
    ttlSupport: true,
    ttlOptions: ['5m', '1h']
  },
  deepseek: {
    supportsCaching: true,
    maxBreakpoints: 2,
    cacheField: 'cache_control',
    cacheValue: { type: 'ephemeral' },
    ttlSupport: false
  },
  google: {
    supportsCaching: true,
    maxBreakpoints: 2,
    cacheField: 'cache_control',
    cacheValue: { type: 'ephemeral' },
    ttlSupport: false
  }
};

const DEFAULT_TTL = '1h'; // 默认使用 1h TTL，延长 LLM 服务端缓存寿命，提升跨请求命中率（Anthropic 支持 5m/1h）

function detectProvider(model, baseUrl) {
  const modelLower = (model || '').toLowerCase();
  const baseLower = (baseUrl || '').toLowerCase();
  
  if (baseLower.includes('anthropic') || modelLower.includes('claude')) {
    return 'anthropic';
  }
  if (baseLower.includes('deepseek') || modelLower.includes('deepseek')) {
    return 'deepseek';
  }
  if (baseLower.includes('google') || baseLower.includes('gemini') || modelLower.includes('gemini')) {
    return 'google';
  }
  if (baseLower.includes('openai') || modelLower.includes('gpt') || modelLower.includes('o1') || modelLower.includes('o3')) {
    return 'openai';
  }
  
  return 'openai';
}

function getProviderConfig(provider) {
  return PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.openai;
}

function applyCacheMarker(msg, cacheValue, provider, isNativeAnthropic = false) {
  const role = msg.role || '';
  const content = msg.content;
  
  if (role === 'tool') {
    if (isNativeAnthropic) {
      msg.cache_control = cacheValue;
    }
    return;
  }
  
  if (content === null || content === undefined || content === '') {
    msg.cache_control = cacheValue;
    return;
  }
  
  if (typeof content === 'string') {
    msg.content = [
      { type: 'text', text: content, cache_control: cacheValue }
    ];
    return;
  }
  
  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (typeof last === 'object' && last !== null) {
      last.cache_control = cacheValue;
    }
  }
}

function applyCacheControl(messages, options = {}) {
  const { 
    provider, 
    model, 
    baseUrl,
    ttl = DEFAULT_TTL,
    maxBreakpoints,
    nativeAnthropic = false 
  } = options;
  
  const detectedProvider = provider || detectProvider(model, baseUrl);
  const config = getProviderConfig(detectedProvider);
  
  if (!config.supportsCaching) {
    return { messages: [...messages], cached: false, breakpoints: 0 };
  }
  
  const result = messages.map(msg => ({ ...msg }));
  
  if (result.length === 0) {
    return { messages: result, cached: false, breakpoints: 0 };
  }
  
  let cacheValue = { ...config.cacheValue };
  
  if (config.ttlSupport && ttl === '1h') {
    cacheValue.ttl = '1h';
  }
  
  const breakpoints = Math.min(maxBreakpoints || config.maxBreakpoints, config.maxBreakpoints);
  let usedBreakpoints = 0;
  
  if (result[0].role === 'system') {
    applyCacheMarker(result[0], cacheValue, detectedProvider, nativeAnthropic);
    usedBreakpoints++;
  }
  
  const remaining = breakpoints - usedBreakpoints;
  const nonSystemIndices = [];
  
  for (let i = 0; i < result.length; i++) {
    if (result[i].role !== 'system') {
      nonSystemIndices.push(i);
    }
  }
  
  const recentNonSystem = nonSystemIndices.slice(-remaining);
  
  for (const idx of recentNonSystem) {
    applyCacheMarker(result[idx], cacheValue, detectedProvider, nativeAnthropic);
    usedBreakpoints++;
  }
  
  return {
    messages: result,
    cached: usedBreakpoints > 0,
    breakpoints: usedBreakpoints,
    provider: detectedProvider
  };
}

function estimateCacheSavings(messages, provider) {
  // eslint-disable-next-line no-unused-vars
  const config = getProviderConfig(provider);
  
  let cachedTokens = 0;
  let totalTokens = 0;
  
  for (const msg of messages) {
    const content = typeof msg.content === 'string' 
      ? msg.content 
      : JSON.stringify(msg.content || '');
    
    const tokens = Math.ceil(content.length / 4);
    totalTokens += tokens;
    
    if (msg.cache_control) {
      cachedTokens += tokens;
    }
  }
  
  const cacheReadRatio = 0.1;
  const savings = cachedTokens * (1 - cacheReadRatio);
  
  return {
    totalTokens,
    cachedTokens,
    savingsTokens: Math.floor(savings),
    savingsPercent: totalTokens > 0 ? ((savings / totalTokens) * 100).toFixed(1) : 0
  };
}

function optimizeCacheBreakpoints(messages, options = {}) {
  const { provider, model, baseUrl, strategy = 'system_and_3' } = options;

  const detectedProvider = provider || detectProvider(model, baseUrl);
  // eslint-disable-next-line no-unused-vars
  const config = getProviderConfig(detectedProvider);
  
  switch (strategy) {
    case 'system_only':
      return applyCacheControl(messages, { 
        ...options, 
        provider: detectedProvider, 
        maxBreakpoints: 1 
      });
      
    case 'system_and_1':
      return applyCacheControl(messages, { 
        ...options, 
        provider: detectedProvider, 
        maxBreakpoints: 2 
      });
      
    case 'system_and_3':
    default:
      return applyCacheControl(messages, { 
        ...options, 
        provider: detectedProvider, 
        maxBreakpoints: 4 
      });
  }
}

function getCacheStats(messages) {
  let systemCached = false;
  let messageBreakpoints = 0;
  let totalCachedContent = 0;

  for (const msg of messages) {
    if (msg.cache_control) {
      if (msg.role === 'system') {
        systemCached = true;
      } else {
        messageBreakpoints++;
      }

      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content || '');
      totalCachedContent += content.length;
    }
  }

  return {
    systemCached,
    messageBreakpoints,
    totalCachedContent,
    estimatedTokens: Math.ceil(totalCachedContent / 4)
  };
}

/**
 * 记录 LLM 服务端缓存命中（由 ai.js 在解析 LLM 响应时调用）
 * @param {number} hitTokens 命中缓存的 token 数（prompt_cache_hit_tokens）
 * @param {number} missTokens 未命中 token 数（prompt_cache_miss_tokens 或 prompt_cache_creation_tokens）
 */
function recordLLMCacheHit(hitTokens = 0, missTokens = 0) {
  _llmCacheStats.recordLLMCache(hitTokens, missTokens);
}

/**
 * 获取 LLM 服务端缓存统计
 */
function getLLMCacheStats() {
  return _llmCacheStats.getStats();
}

/**
 * 重置 LLM 服务端缓存统计
 */
function resetLLMCacheStats() {
  _llmCacheStats.resetStats();
}

module.exports = {
  applyCacheControl,
  optimizeCacheBreakpoints,
  estimateCacheSavings,
  getCacheStats,
  detectProvider,
  getProviderConfig,
  PROVIDER_CONFIG,
  DEFAULT_TTL,
  recordLLMCacheHit,
  getLLMCacheStats,
  resetLLMCacheStats,
};
