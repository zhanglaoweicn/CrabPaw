const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'bge-m3';
const DEFAULT_DIM = 1024;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BATCH_SIZE = 32;
const CACHE_MAX_ENTRIES = 5000;
const CACHE_TTL_MS = 3600000;

class EmbeddingProvider extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = config.name || 'base';
    this._initialized = false;
  }

  async initialize() {
    this._initialized = true;
  }

  async embed(_text) {
    throw new Error('embed() must be implemented');
  }

  async embedBatch(texts) {
    const results = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  get dimension() {
    return DEFAULT_DIM;
  }

  get isInitialized() {
    return this._initialized;
  }
}

class OllamaEmbeddingProvider extends EmbeddingProvider {
  constructor(config = {}) {
    super({ name: 'ollama' });
    this._baseUrl = config.baseUrl || DEFAULT_OLLAMA_URL;
    this._model = config.model || DEFAULT_OLLAMA_MODEL;
    this._dim = config.dim || DEFAULT_DIM;
    this._timeout = config.timeout || REQUEST_TIMEOUT_MS;
    this._cache = new Map();
    this._cacheMax = config.cacheMax || CACHE_MAX_ENTRIES;
    this._cacheTTL = config.cacheTTL || CACHE_TTL_MS;
    this._requestQueue = [];
    this._processing = false;
  }

  async initialize() {
    try {
      const response = await this._request(`${this._baseUrl}/api/tags`, 'GET');
      if (response && response.models) {
        const modelNames = response.models.map(m => m.name);
        const hasModel = modelNames.some(n => n.startsWith(this._model));
        if (!hasModel) {
          console.warn(`⚠️ Ollama 模型 ${this._model} 未找到，可用模型: ${modelNames.join(', ')}`);
        }
      }
      this._initialized = true;
      console.log(`✅ Ollama 嵌入提供者已初始化: ${this._baseUrl} (模型: ${this._model})`);
    } catch (e) {
      console.warn(`⚠️ Ollama 连接失败: ${e.message}，将使用降级模式`);
      this._initialized = false;
    }
  }

  async embed(text) {
    if (!text || text.trim().length === 0) return new Float32Array(this._dim);

    const cacheKey = this._hashText(text);
    const cached = this._cache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < this._cacheTTL) {
      return cached.embedding;
    }

    if (!this._initialized) {
      return this._fallbackEmbed(text);
    }

    try {
      const response = await this._request(`${this._baseUrl}/api/embed`, 'POST', {
        model: this._model,
        input: text,
      });

      const embedding = response.embeddings?.[0];
      if (embedding && Array.isArray(embedding)) {
        const result = new Float32Array(embedding);
        this._setCache(cacheKey, result);
        return result;
      }
    } catch (e) {
      console.warn(`⚠️ Ollama 嵌入失败: ${e.message}`);
    }

    return this._fallbackEmbed(text);
  }

  async embedBatch(texts) {
    if (!this._initialized) {
      return texts.map(t => this._fallbackEmbed(t));
    }

    const batches = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
    }

    const results = [];
    for (const batch of batches) {
      try {
        const response = await this._request(`${this._baseUrl}/api/embed`, 'POST', {
          model: this._model,
          input: batch,
        });

        if (response.embeddings && Array.isArray(response.embeddings)) {
          for (const emb of response.embeddings) {
            results.push(new Float32Array(emb));
          }
        } else {
          for (const text of batch) {
            results.push(this._fallbackEmbed(text));
          }
        }
      } catch (e) {
        for (const text of batch) {
          results.push(this._fallbackEmbed(text));
        }
      }
    }

    return results;
  }

  get dimension() {
    return this._dim;
  }

  _fallbackEmbed(text) {
    // 降级嵌入：使用确定性哈希生成伪向量
    // 注意：此向量不具备语义相似性，仅用于 FTS-only 降级模式
    // 相同文本总是生成相同向量，不同文本生成近似正交的向量
    const vec = new Float32Array(this._dim);
    const seed1 = this._deterministicHash(text, 0);
    const seed2 = this._deterministicHash(text, seed1);
    for (let i = 0; i < this._dim; i++) {
      vec[i] = Math.sin(seed1 * (i + 1) + seed2 * 0.001) * 0.5 +
               Math.cos(seed2 * (i + 1) + seed1 * 0.001) * 0.5;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  }

  _deterministicHash(str, seed) {
    let hash = seed ^ 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  _simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash;
  }

  _setCache(key, embedding) {
    if (this._cache.size >= this._cacheMax) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(key, { embedding, time: Date.now() });
  }

  _request(url, method, body) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: this._timeout,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

class VoyageEmbeddingProvider extends EmbeddingProvider {
  constructor(config = {}) {
    super({ name: 'voyage' });
    this._apiKey = config.apiKey || process.env.VOYAGE_API_KEY || '';
    this._model = config.model || 'voyage-3';
    this._dim = config.dim || 1024;
    this._baseUrl = config.baseUrl || 'https://api.voyageai.com/v1';
    this._timeout = config.timeout || REQUEST_TIMEOUT_MS;
    this._cache = new Map();
    this._cacheMax = config.cacheMax || CACHE_MAX_ENTRIES;
  }

  async initialize() {
    if (!this._apiKey) {
      console.warn('⚠️ Voyage API Key 未设置，将使用降级模式');
      this._initialized = false;
      return;
    }
    this._initialized = true;
    console.log(`✅ Voyage 嵌入提供者已初始化 (模型: ${this._model})`);
  }

  async embed(text) {
    if (!text || text.trim().length === 0) return new Float32Array(this._dim);
    if (!this._initialized) return this._fallbackEmbed(text);

    try {
      const response = await this._request(`${this._baseUrl}/embeddings`, 'POST', {
        model: this._model,
        input: [text],
        input_type: 'document',
      });

      const embedding = response.data?.[0]?.embedding;
      if (embedding && Array.isArray(embedding)) {
        return new Float32Array(embedding);
      }
    } catch (e) {
      console.warn(`⚠️ Voyage 嵌入失败: ${e.message}`);
    }

    return this._fallbackEmbed(text);
  }

  async embedBatch(texts) {
    if (!this._initialized) {
      return texts.map(t => this._fallbackEmbed(t));
    }

    const batches = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
    }

    const results = [];
    for (const batch of batches) {
      try {
        const response = await this._request(`${this._baseUrl}/embeddings`, 'POST', {
          model: this._model,
          input: batch,
          input_type: 'document',
        });

        if (response.data && Array.isArray(response.data)) {
          for (const item of response.data) {
            results.push(new Float32Array(item.embedding));
          }
        }
      } catch (e) {
        for (const text of batch) {
          results.push(this._fallbackEmbed(text));
        }
      }
    }
    return results;
  }

  get dimension() {
    return this._dim;
  }

  _fallbackEmbed(text) {
    // 降级嵌入：使用确定性哈希生成伪向量
    // 注意：此向量不具备语义相似性，仅用于 FTS-only 降级模式
    // 相同文本总是生成相同向量，不同文本生成近似正交的向量
    const vec = new Float32Array(this._dim);
    const seed1 = this._deterministicHash(text, 0);
    const seed2 = this._deterministicHash(text, seed1);
    for (let i = 0; i < this._dim; i++) {
      vec[i] = Math.sin(seed1 * (i + 1) + seed2 * 0.001) * 0.5 +
               Math.cos(seed2 * (i + 1) + seed1 * 0.001) * 0.5;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  }

  _deterministicHash(str, seed) {
    let hash = seed ^ 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash;
  }

  _request(url, method, body) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        timeout: this._timeout,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

/**
 * OpenAI 兼容 Embedding 降级提供者
 * 支持 OpenAI / Jina / 任何 OpenAI 兼容 API
 */
class OpenAICompatEmbeddingProvider extends EmbeddingProvider {
  constructor(config = {}) {
    super({ name: config.name || 'openai-compat' });
    this._apiKey = config.apiKey || '';
    this._baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this._model = config.model || 'text-embedding-3-small';
    this._dim = config.dim || 1536;
    this._timeout = config.timeout || REQUEST_TIMEOUT_MS;
    this._cache = new Map();
    this._cacheMax = config.cacheMax || CACHE_MAX_ENTRIES;
    this._cacheTTL = config.cacheTTL || CACHE_TTL_MS;
  }

  async initialize() {
    if (!this._apiKey) {
      console.warn(`⚠️ ${this.name} API Key 未设置，将使用降级模式`);
      this._initialized = false;
      return;
    }
    this._initialized = true;
    console.log(`✅ ${this.name} 嵌入提供者已初始化 (${this._baseUrl}, 模型: ${this._model})`);
  }

  async embed(text) {
    if (!text || text.trim().length === 0) return new Float32Array(this._dim);
    if (!this._initialized) return this._fallbackEmbed(text);

    const cacheKey = this._hashText(text);
    const cached = this._cache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < this._cacheTTL) {
      return cached.embedding;
    }

    try {
      const response = await this._request(`${this._baseUrl}/embeddings`, 'POST', {
        model: this._model,
        input: text,
      });

      const embedding = response.data?.[0]?.embedding;
      if (embedding && Array.isArray(embedding)) {
        const result = new Float32Array(embedding);
        this._setCache(cacheKey, result);
        return result;
      }
    } catch (e) {
      console.warn(`⚠️ ${this.name} 嵌入失败: ${e.message}`);
    }

    return this._fallbackEmbed(text);
  }

  async embedBatch(texts) {
    if (!this._initialized) {
      return texts.map(t => this._fallbackEmbed(t));
    }

    const batches = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
    }

    const results = [];
    for (const batch of batches) {
      try {
        const response = await this._request(`${this._baseUrl}/embeddings`, 'POST', {
          model: this._model,
          input: batch,
        });

        if (response.data && Array.isArray(response.data)) {
          for (const item of response.data) {
            results.push(new Float32Array(item.embedding));
          }
        }
      } catch (e) {
        for (const text of batch) {
          results.push(this._fallbackEmbed(text));
        }
      }
    }
    return results;
  }

  get dimension() { return this._dim; }

  _fallbackEmbed(text) {
    // 降级嵌入：使用确定性哈希生成伪向量
    // 注意：此向量不具备语义相似性，仅用于 FTS-only 降级模式
    // 相同文本总是生成相同向量，不同文本生成近似正交的向量
    const vec = new Float32Array(this._dim);
    const seed1 = this._deterministicHash(text, 0);
    const seed2 = this._deterministicHash(text, seed1);
    for (let i = 0; i < this._dim; i++) {
      vec[i] = Math.sin(seed1 * (i + 1) + seed2 * 0.001) * 0.5 +
               Math.cos(seed2 * (i + 1) + seed1 * 0.001) * 0.5;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }
    return vec;
  }

  _deterministicHash(str, seed) {
    let hash = seed ^ 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  _simpleHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return hash;
  }

  _setCache(key, embedding) {
    if (this._cache.size >= this._cacheMax) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
    this._cache.set(key, { embedding, time: Date.now() });
  }

  _request(url, method, body) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        timeout: this._timeout,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

class HybridEmbeddingRouter extends EventEmitter {
  constructor(config = {}) {
    super();
    this._providers = new Map();
    this._defaultProvider = config.defaultProvider || 'ollama';
    this._fallbackProvider = config.fallbackProvider || 'local';
    this._initialized = false;
  }

  registerProvider(name, provider) {
    if (!(provider instanceof EmbeddingProvider)) {
      throw new Error('Provider must extend EmbeddingProvider');
    }
    this._providers.set(name, provider);
    this.emit('provider:registered', { name });
  }

  async initialize() {
    for (const [name, provider] of this._providers) {
      try {
        await provider.initialize();
        this.emit('provider:initialized', { name });
      } catch (e) {
        this.emit('provider:init_error', { name, error: e.message });
      }
    }
    this._initialized = true;
  }

  async embed(text, providerName) {
    const name = providerName || this._defaultProvider;
    const provider = this._providers.get(name);

    if (provider && provider.isInitialized) {
      try {
        return await provider.embed(text);
      } catch (e) {
        this.emit('embed:error', { provider: name, error: e.message });
      }
    } else if (provider && !provider.isInitialized) {
      // 首次降级时发出显式警告
      if (!this._degradeWarned) {
        this._degradeWarned = new Set();
      }
      if (!this._degradeWarned.has(name)) {
        console.warn(`⚠️ 嵌入提供者 ${name} 未初始化，向量检索降级为 FTS-only 模式，搜索质量可能下降。请检查 Ollama 服务是否启动。`);
        this._degradeWarned.add(name);
      }
    }

    for (const [fallbackName, fallbackProvider] of this._providers) {
      if (fallbackName === name) continue;
      if (fallbackProvider.isInitialized) {
        try {
          return await fallbackProvider.embed(text);
        } catch { console.debug("best-effort: operation failed, continuing"); }
      }
    }

    return new Float32Array(1024);
  }

  async embedBatch(texts, providerName) {
    const name = providerName || this._defaultProvider;
    const provider = this._providers.get(name);

    if (provider && provider.isInitialized) {
      try {
        return await provider.embedBatch(texts);
      } catch (e) {
        this.emit('embed:error', { provider: name, error: e.message });
      }
    }

    for (const [fallbackName, fallbackProvider] of this._providers) {
      if (fallbackName === name) continue;
      if (fallbackProvider.isInitialized) {
        try {
          return await fallbackProvider.embedBatch(texts);
        } catch { console.debug("best-effort: operation failed, continuing"); }
      }
    }

    return texts.map(() => new Float32Array(1024));
  }

  get dimension() {
    const provider = this._providers.get(this._defaultProvider);
    return provider ? provider.dimension : DEFAULT_DIM;
  }

  getProvider(name) {
    return this._providers.get(name) || null;
  }

  listProviders() {
    return [...this._providers.entries()].map(([name, provider]) => ({
      name,
      initialized: provider.isInitialized,
      dimension: provider.dimension,
    }));
  }
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function embeddingToBuffer(embedding) {
  if (!embedding) return null;
  const f32 = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function bufferToEmbedding(buffer) {
  if (!buffer) return null;
  if (buffer instanceof Buffer) {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  }
  return new Float32Array(buffer);
}

let _routerInstance = null;

function getEmbeddingRouter(config) {
  if (!_routerInstance) {
    _routerInstance = new HybridEmbeddingRouter(config);

    // 第一优先级：Ollama 本地
    const ollamaProvider = new OllamaEmbeddingProvider({
      baseUrl: config?.ollamaUrl || DEFAULT_OLLAMA_URL,
      model: config?.ollamaModel || DEFAULT_OLLAMA_MODEL,
      dim: config?.dim || DEFAULT_DIM,
    });
    _routerInstance.registerProvider('ollama', ollamaProvider);

    // 第二优先级：Voyage AI
    if (config?.voyageApiKey || process.env.VOYAGE_API_KEY) {
      const voyageProvider = new VoyageEmbeddingProvider({
        apiKey: config?.voyageApiKey,
        model: config?.voyageModel || 'voyage-3',
        dim: config?.dim || DEFAULT_DIM,
      });
      _routerInstance.registerProvider('voyage', voyageProvider);
    }

    // 第三优先级：OpenAI 兼容 API（支持 OpenAI / Jina / 任何兼容端点）
    const openaiKey = config?.openaiApiKey || process.env.OPENAI_API_KEY || process.env.EMBEDDING_API_KEY;
    if (openaiKey) {
      const openaiProvider = new OpenAICompatEmbeddingProvider({
        name: config?.openaiProviderName || 'openai',
        apiKey: openaiKey,
        baseUrl: config?.openaiBaseUrl || 'https://api.openai.com/v1',
        model: config?.openaiModel || 'text-embedding-3-small',
        dim: config?.openaiDim || 1536,
      });
      _routerInstance.registerProvider('openai', openaiProvider);
    }

    // Jina Embeddings（独立注册，因为 API 格式略有不同）
    const jinaKey = config?.jinaApiKey || process.env.JINA_API_KEY;
    if (jinaKey) {
      const jinaProvider = new OpenAICompatEmbeddingProvider({
        name: 'jina',
        apiKey: jinaKey,
        baseUrl: 'https://api.jina.ai/v1',
        model: config?.jinaModel || 'jina-embeddings-v3',
        dim: config?.jinaDim || 1024,
      });
      _routerInstance.registerProvider('jina', jinaProvider);
    }
  }
  return _routerInstance;
}

module.exports = {
  EmbeddingProvider,
  OllamaEmbeddingProvider,
  VoyageEmbeddingProvider,
  OpenAICompatEmbeddingProvider,
  HybridEmbeddingRouter,
  getEmbeddingRouter,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
  DEFAULT_DIM,
  DEFAULT_OLLAMA_URL,
  DEFAULT_OLLAMA_MODEL,
};
