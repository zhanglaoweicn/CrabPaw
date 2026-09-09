/**
 * HRR (Holographic Reduced Representation) Vector Engine
 * 
 * Holographic Reduced Representation 引擎 — 基于全息向量的记忆绑定与检索。
 * 实现语义级别的记忆检索
 * 
 * 核心原理：
 * - 将文本编码为高维向量（默认 1024 维）
 * - 使用相位编码而非传统的 embedding
 * - 支持向量叠加（superposition）实现组合表示
 * - 通过向量相似度实现语义检索
 */



const DEFAULT_DIM = 1024;
const PHASE_BINS = 16;
const MAX_TOKEN_VECTORS = 10000;

class HRREngine {
  constructor(config = {}) {
    this.dim = config.dim || DEFAULT_DIM;
    this.phaseBins = config.phaseBins || PHASE_BINS;
    this._tokenVectors = new Map();
    this._maxTokenVectors = config.maxTokenVectors || MAX_TOKEN_VECTORS;
    this._seed = config.seed || 42;
    this._rng = this._createSeededRNG(this._seed);
  }

  _createSeededRNG(seed) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  }

  _generateRandomPhaseVector() {
    const phases = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      phases[i] = Math.floor(this._rng() * this.phaseBins) / this.phaseBins * 2 * Math.PI;
    }
    return phases;
  }

  _getTokenVector(token) {
    if (this._tokenVectors.has(token)) {
      return this._tokenVectors.get(token);
    }

    if (this._tokenVectors.size >= this._maxTokenVectors) {
      const firstKey = this._tokenVectors.keys().next().value;
      this._tokenVectors.delete(firstKey);
    }

    const vec = this._generateRandomPhaseVector();
    this._tokenVectors.set(token, vec);
    return vec;
  }

  tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const tokens = [];
    const words = normalized.split(/\s+/);
    
    for (const word of words) {
      if (word.length < 2) continue;
      tokens.push(word);
      
      if (/[\u4e00-\u9fff]/.test(word)) {
        for (let i = 0; i < word.length - 1; i++) {
          tokens.push(word.slice(i, i + 2));
        }
      }
    }
    
    return [...new Set(tokens)];
  }

  encodeText(text) {
    const tokens = this.tokenize(text);
    if (tokens.length === 0) {
      return new Float32Array(this.dim);
    }

    const sum = new Float32Array(this.dim);
    
    for (const token of tokens) {
      const vec = this._getTokenVector(token);
      for (let i = 0; i < this.dim; i++) {
        sum[i] += Math.cos(vec[i]) + Math.sin(vec[i]);
      }
    }

    for (let i = 0; i < this.dim; i++) {
      sum[i] = Math.atan2(sum[i], tokens.length);
    }

    return sum;
  }

  encodeTextToBytes(text) {
    const phases = this.encodeText(text);
    return this.phasesToBytes(phases);
  }

  phasesToBytes(phases) {
    const buffer = Buffer.alloc(phases.length * 4);
    for (let i = 0; i < phases.length; i++) {
      buffer.writeFloatLE(phases[i], i * 4);
    }
    return buffer;
  }

  bytesToPhases(buffer) {
    const phases = new Float32Array(buffer.length / 4);
    for (let i = 0; i < phases.length; i++) {
      phases[i] = buffer.readFloatLE(i * 4);
    }
    return phases;
  }

  similarity(vec1, vec2) {
    if (vec1.length !== vec2.length) {
      throw new Error('Vector dimensions must match');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      const cos1 = Math.cos(vec1[i]);
      const sin1 = Math.sin(vec1[i]);
      const cos2 = Math.cos(vec2[i]);
      const sin2 = Math.sin(vec2[i]);

      dotProduct += cos1 * cos2 + sin1 * sin2;
      norm1 += cos1 * cos1 + sin1 * sin1;
      norm2 += cos2 * cos2 + sin2 * sin2;
    }

    if (norm1 === 0 || norm2 === 0) return 0;

    return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }

  superposition(vectors, weights = null) {
    if (vectors.length === 0) {
      return new Float32Array(this.dim);
    }

    const result = new Float32Array(this.dim);
    const defaultWeights = vectors.map(() => 1);

    for (let i = 0; i < vectors.length; i++) {
      const weight = weights ? weights[i] : defaultWeights[i];
      const vec = vectors[i];

      for (let j = 0; j < this.dim; j++) {
        result[j] += weight * (Math.cos(vec[j]) + Math.sin(vec[j]));
      }
    }

    const totalWeight = weights ? weights.reduce((a, b) => a + b, 0) : vectors.length;
    for (let j = 0; j < this.dim; j++) {
      result[j] = Math.atan2(result[j], totalWeight);
    }

    return result;
  }

  bind(vec1, vec2) {
    const result = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      result[i] = vec1[i] + vec2[i];
      while (result[i] > Math.PI) result[i] -= 2 * Math.PI;
      while (result[i] < -Math.PI) result[i] += 2 * Math.PI;
    }
    return result;
  }

  unbind(bound, vec2) {
    const result = new Float32Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      result[i] = bound[i] - vec2[i];
      while (result[i] > Math.PI) result[i] -= 2 * Math.PI;
      while (result[i] < -Math.PI) result[i] += 2 * Math.PI;
    }
    return result;
  }
}

class FTSIndex {
  constructor(config = {}) {
    this.tokenizer = config.tokenizer || 'unicode61';
    this._index = new Map();
    this._docCount = 0;
  }

  addDocument(id, text) {
    if (!text || typeof text !== 'string') return;
    const tokens = this._tokenize(text);
    for (const token of tokens) {
      if (!this._index.has(token)) {
        this._index.set(token, new Map());
      }
      const postings = this._index.get(token);
      postings.set(id, (postings.get(id) || 0) + 1);
    }
    this._docCount++;
  }

  removeDocument(id) {
    for (const [, postings] of this._index) {
      postings.delete(id);
    }
    this._docCount = Math.max(0, this._docCount - 1);
  }

  search(query, options = {}) {
    const limit = options.limit || 20;
    const tokens = this._tokenize(query);
    if (tokens.length === 0) return [];

    const scores = new Map();
    for (const token of tokens) {
      const postings = this._index.get(token);
      if (!postings) continue;
      for (const [id, tf] of postings) {
        const idf = Math.log((this._docCount + 1) / (postings.size + 1)) + 1;
        scores.set(id, (scores.get(id) || 0) + tf * idf);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, ftsRank: score }))
      .sort((a, b) => b.ftsRank - a.ftsRank)
      .slice(0, limit);
  }

  _tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const tokens = [];
    const words = normalized.split(/\s+/);
    for (const word of words) {
      if (word.length < 2) continue;
      tokens.push(word);
      if (/[\u4e00-\u9fff]/.test(word)) {
        for (let i = 0; i < word.length - 1; i++) {
          tokens.push(word.slice(i, i + 2));
        }
      }
    }
    return [...new Set(tokens)];
  }

  getStats() {
    return {
      docCount: this._docCount,
      vocabSize: this._index.size,
    };
  }
}

class MemorySyncPolicy {
  constructor(config = {}) {
    this.onSessionStart = config.onSessionStart !== false;
    this.onSearch = config.onSearch !== false;
    this.watch = config.watch || false;
    this.watchDebounceMs = config.watchDebounceMs || 1500;
    this.intervalMinutes = config.intervalMinutes || 60;
    this.embeddingBatchTimeoutSeconds = config.embeddingBatchTimeoutSeconds || 120;
    this.sessionDeltaBytes = config.sessionDeltaBytes || 100_000;
    this.sessionDeltaMessages = config.sessionDeltaMessages || 50;
    this.postCompactionForce = config.postCompactionForce || false;
  }

  shouldSyncOnSessionStart(_session) {
    if (!this.onSessionStart) return false;
    return true;
  }

  shouldSyncOnSearch(_session) {
    if (!this.onSearch) return false;
    return true;
  }

  shouldSyncOnInterval(lastSyncMs) {
    const elapsed = Date.now() - (lastSyncMs || 0);
    return elapsed >= this.intervalMinutes * 60 * 1000;
  }

  shouldSyncOnSessionDelta(session) {
    if (!session) return false;
    const deltaBytes = session.deltaBytes || 0;
    const deltaMessages = session.deltaMessages || 0;
    return deltaBytes >= this.sessionDeltaBytes || deltaMessages >= this.sessionDeltaMessages;
  }
}

class HybridRetriever {
  constructor(store, config = {}) {
    this.store = store;
    this.hrrEngine = new HRREngine(config.hrr);
    this.ftsIndex = new FTSIndex({ tokenizer: config.ftsTokenizer || 'unicode61' });
    this.syncPolicy = new MemorySyncPolicy(config.sync || {});

    this.weights = {
      fts: config.ftsWeight || 0.3,
      jaccard: config.jaccardWeight || 0.2,
      hrr: config.hrrWeight || 0.5,
    };

    this.temporalDecayHalfLife = config.temporalDecayHalfLife || 30;
    this.minTrust = config.minTrust || 0.3;
    this.mmrEnabled = config.mmrEnabled !== false;
    this.mmrLambda = config.mmrLambda || 0.7;
    this.candidateMultiplier = config.candidateMultiplier || 4;
  }

  tokenize(text) {
    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2)
    );
  }

  jaccardSimilarity(set1, set2) {
    if (set1.size === 0 || set2.size === 0) return 0;
    
    let intersection = 0;
    for (const item of set1) {
      if (set2.has(item)) intersection++;
    }
    
    const union = set1.size + set2.size - intersection;
    return intersection / union;
  }

  calculateTemporalDecay(createdAtMs) {
    if (this.temporalDecayHalfLife <= 0) return 1;
    
    const ageDays = (Date.now() - createdAtMs) / (24 * 60 * 60 * 1000);
    return Math.pow(0.5, ageDays / this.temporalDecayHalfLife);
  }

  async search(query, options = {}) {
    const limit = options.limit || 10;
    const category = options.category || null;
    const minTrust = options.minTrust || this.minTrust;

    let candidates = [];
    if (typeof this.store.searchFacts === 'function') {
      candidates = await this.store.searchFacts(query, {
        limit: limit * this.candidateMultiplier,
        category,
        minTrust,
      });
    } else if (typeof this.store.search === 'function') {
      candidates = await this.store.search(query, {
        limit: limit * this.candidateMultiplier,
        category,
        minTrust,
      });
    } else if (this.store.facts) {
      candidates = this.store.facts;
    }

    if (candidates.length === 0) return [];

    const ftsResults = this.ftsIndex.search(query, { limit: limit * this.candidateMultiplier });
    const ftsMap = new Map(ftsResults.map(r => [r.id, r.ftsRank]));

    const queryTokens = this.tokenize(query);
    const queryVec = this.hrrEngine.encodeText(query);

    const scored = [];

    for (const fact of candidates) {
      const contentTokens = this.tokenize(fact.content || '');
      const tagTokens = this.tokenize(fact.tags || '');
      const allTokens = new Set([...contentTokens, ...tagTokens]);

      const jaccard = this.jaccardSimilarity(queryTokens, allTokens);
      const ftsScore = ftsMap.get(fact.id) || fact.ftsRank || 0;

      let hrrSim = 0.5;
      if (fact.hrrVector) {
        try {
          const factVec = this.hrrEngine.bytesToPhases(fact.hrrVector);
          hrrSim = (this.hrrEngine.similarity(queryVec, factVec) + 1) / 2;
        } catch (e) {
          hrrSim = 0.5;
        }
      }

      const relevance =
        this.weights.fts * ftsScore +
        this.weights.jaccard * jaccard +
        this.weights.hrr * hrrSim;

      let score = relevance * (fact.trustScore || 0.5);

      const temporalDecay = this.calculateTemporalDecay(fact.createdAt || Date.now());
      score *= temporalDecay;

      scored.push({
        ...fact,
        score,
        breakdown: {
          fts: ftsScore,
          jaccard,
          hrr: hrrSim,
          relevance,
          trust: fact.trustScore || 0.5,
          temporalDecay,
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);

    if (this.mmrEnabled && scored.length > limit) {
      return this._mmrRerank(scored, queryVec, limit);
    }

    return scored.slice(0, limit);
  }

  _mmrRerank(candidates, queryVec, limit) {
    const selected = [];
    const remaining = [...candidates];
    const selectedVectors = [];

    if (remaining.length === 0) return selected;
    selected.push(remaining.shift());
    if (selected[0].hrrVector) {
      try {
        selectedVectors.push(this.hrrEngine.bytesToPhases(selected[0].hrrVector));
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    while (selected.length < limit && remaining.length > 0) {
      let bestIdx = 0;
      let bestMmr = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const relevance = candidate.score;

        let maxSim = 0;
        if (candidate.hrrVector && selectedVectors.length > 0) {
          try {
            const candVec = this.hrrEngine.bytesToPhases(candidate.hrrVector);
            for (const selVec of selectedVectors) {
              const sim = (this.hrrEngine.similarity(candVec, selVec) + 1) / 2;
              maxSim = Math.max(maxSim, sim);
            }
          } catch { console.debug("best-effort: operation failed, continuing"); }
        }

        const mmr = this.mmrLambda * relevance - (1 - this.mmrLambda) * maxSim;
        if (mmr > bestMmr) {
          bestMmr = mmr;
          bestIdx = i;
        }
      }

      const chosen = remaining.splice(bestIdx, 1)[0];
      selected.push(chosen);
      if (chosen.hrrVector) {
        try {
          selectedVectors.push(this.hrrEngine.bytesToPhases(chosen.hrrVector));
        } catch { console.debug("best-effort: operation failed, continuing"); }
      }
    }

    return selected;
  }

  async probe(entity, options = {}) {
    if (typeof this.store.getFactsByEntity === 'function') {
      return await this.store.getFactsByEntity(entity, options);
    }
    return [];
  }

  async reason(entities, options = {}) {
    if (entities.length < 2) {
      return [];
    }

    const getFactsFn = this.store.getFactsByEntity || this.store.getFactsForEntity;
    if (typeof getFactsFn !== 'function') {
      return [];
    }

    const entityFacts = await Promise.all(
      entities.map(e => getFactsFn.call(this.store, e, options))
    );

    const factCounts = new Map();
    for (const facts of entityFacts) {
      for (const fact of facts) {
        factCounts.set(fact.id, (factCounts.get(fact.id) || 0) + 1);
      }
    }

    const connectedFacts = [];
    for (const [id, count] of factCounts) {
      if (count >= 2) {
        const fact = entityFacts.flat().find(f => f.id === id);
        if (fact) {
          connectedFacts.push({
            ...fact,
            entityCount: count,
          });
        }
      }
    }

    connectedFacts.sort((a, b) => b.entityCount - a.entityCount);

    return connectedFacts.slice(0, options.limit || 10);
  }

  async findContradictions(options = {}) {
    let facts = [];
    if (typeof this.store.getAllFacts === 'function') {
      facts = await this.store.getAllFacts();
    } else if (typeof this.store.searchFacts === 'function') {
      facts = await this.store.searchFacts('', { limit: 1000 });
    } else if (this.store.facts) {
      facts = this.store.facts;
    }
    const contradictions = [];

    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const vec1 = facts[i].hrrVector
          ? this.hrrEngine.bytesToPhases(facts[i].hrrVector)
          : this.hrrEngine.encodeText(facts[i].content);
        const vec2 = facts[j].hrrVector
          ? this.hrrEngine.bytesToPhases(facts[j].hrrVector)
          : this.hrrEngine.encodeText(facts[j].content);

        const sim = this.hrrEngine.similarity(vec1, vec2);

        if (sim > 0.8 && facts[i].category !== facts[j].category) {
          contradictions.push({
            fact1: facts[i],
            fact2: facts[j],
            similarity: sim,
          });
        }
      }
    }

    return contradictions.slice(0, options.limit || 10);
  }
}

module.exports = {
  HRREngine,
  HybridRetriever,
  FTSIndex,
  MemorySyncPolicy,
  DEFAULT_DIM,
  PHASE_BINS,
};
