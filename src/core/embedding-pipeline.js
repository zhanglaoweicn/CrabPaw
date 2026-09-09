/**
 * EmbeddingPipeline — 记忆向量化管线
 *
 * 目标：unified-store memories.embedding 字段填充（hybrid-search 向量路径激活）。
 * 设计：embedFn 可注入（测试）；默认实现读配置——embedding 端点未配置时返回 null（整体降级 TF-IDF，不阻塞记忆写入）。
 * 缓存：内存 Map + 磁盘 JSON（data/.crabpaw/embedding-cache.json，上限 5000 条）。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CACHE_FILE = path.join(config.DATA_DIR, 'embedding-cache.json');
const CACHE_MAX = 5000;

function defaultEmbedFn() {
  // 读配置：models.embedding 端点；未配置 → null（降级）
  return async (text) => {
    try {
      const cfg = config.loadConfig ? config.loadConfig() : null;
      const emb = cfg && cfg.models && cfg.models.embedding;
      if (!emb || !emb.apiKey) return null;
      const { getAuxiliaryClient } = require('./auxiliary-client');
      const resp = await getAuxiliaryClient().callLlm({
        taskType: 'embedding',
        messages: [{ role: 'user', content: text }],
        maxTokens: 128,
        temperature: 0,
        timeout: 15000,
      });
      const arr = resp && Array.isArray(resp.content) ? resp.content : null;
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch (e) {
      console.warn('[embedding] 生成失败:', e.message || e);
      return null;
    }
  };
}

class EmbeddingPipeline {
  constructor({ embedFn } = {}) {
    this._embedFn = embedFn || defaultEmbedFn();
    // 注入 embedFn 时（测试）跳过磁盘缓存加载，避免跨实例/跨运行的缓存交叉污染。
    // 默认构造（生产单例）加载磁盘缓存以实现 warm-start。
    this._cache = embedFn ? new Map() : this._loadCache();
  }

  _loadCache() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return new Map();
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return new Map(Object.entries(raw || {}));
    } catch (e) {
      console.warn('[embedding] 缓存读取失败:', e.message || e);
      return new Map();
    }
  }

  _saveCache() {
    try {
      if (this._cache.size === 0) return;
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      const entries = [...this._cache.entries()].slice(-CACHE_MAX);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)), 'utf8');
    } catch (e) {
      console.warn('[embedding] 缓存写入失败:', e.message || e);
    }
  }

  async getEmbedding(text) {
    if (!text || typeof text !== 'string') return null;
    const key = text.slice(0, 200);
    if (this._cache.has(key)) return this._cache.get(key);
    try {
      const v = await this._embedFn(text);
      if (Array.isArray(v) && v.length > 0) {
        this._cache.set(key, v);
        return v;
      }
      return null;
    } catch (e) {
      console.warn('[embedding] getEmbedding 失败:', e.message || e);
      return null;
    }
  }

  async batchEmbed(records, { concurrency = 3 } = {}) {
    const results = new Array(records.length).fill(null);
    let idx = 0;
    const worker = async () => {
      while (idx < records.length) {
        const i = idx++;
        const rec = records[i];
        if (!rec || typeof rec.text !== 'string') { results[i] = null; continue; }
        try {
          results[i] = await this.getEmbedding(rec.text);
        } catch (e) {
          console.warn('[embedding] batch 项失败:', e.message || e);
          results[i] = null;
        }
      }
    };
    const workers = [];
    for (let w = 0; w < Math.max(1, concurrency); w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  /** 将 embedding 写入 unified-store memories 表；向量为 null 时返回 false 不抛 */
  async embedMemory(memory) {
    try {
      if (!memory || !memory.id) return false;
      const text = memory.text || memory.content || '';
      const v = await this.getEmbedding(text);
      if (!v) return false;
      const { getUnifiedStore } = require('./memory/unified-store');
      if (getUnifiedStore && typeof getUnifiedStore().updateMemoryEmbedding === 'function') {
        return getUnifiedStore().updateMemoryEmbedding(memory.id, v);
      }
      // 降级：内存标记（无 unified-store 写入能力时记录日志）
      console.warn('[embedding] unified-store 无 updateMemoryEmbedding，跳过写入');
      return false;
    } catch (e) {
      console.error('[embedding] embedMemory 失败:', e.message || e);
      return false;
    }
  }
}

const globalEmbeddingPipeline = new EmbeddingPipeline();
function getEmbedding(text) { return globalEmbeddingPipeline.getEmbedding(text); }

// 进程退出时落盘（全局单例），实现跨进程重启的 warm-start 缓存。
// 不在每次 getEmbedding 时写盘以避免测试实例间磁盘缓存交叉污染。
try {
  const _saveGlobalCache = () => { globalEmbeddingPipeline._saveCache(); };
  process.on('exit', _saveGlobalCache);
  process.on('SIGINT', () => { _saveGlobalCache(); process.exit(0); });
  process.on('SIGTERM', () => { _saveGlobalCache(); process.exit(0); });
} catch (e) {
  /* 信号注册失败不影响主流程 */
  console.warn('[embedding-pipeline.js] 空 catch 补日志:', e && e.message);
}


module.exports = { EmbeddingPipeline, getEmbedding, globalEmbeddingPipeline };
