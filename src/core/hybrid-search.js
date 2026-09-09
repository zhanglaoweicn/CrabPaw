'use strict';

// ============================================================================
// Hybrid Memory Search Module
// ============================================================================
// Inspired by Grok Build's hybrid_search implementation.
// Combines FTS (Full-Text Search), vector similarity, temporal decay,
// source weighting, and MMR re-ranking for intelligent memory retrieval.
//
// This module is designed to work standalone without external DB dependencies.
// It operates on in-memory chunk arrays.
// ============================================================================

// ---------------------------------------------------------------------------
// Source Weight Configuration
// ---------------------------------------------------------------------------

const SourceWeight = Object.freeze({
  GLOBAL: 1.0,
  WORKSPACE: 0.8,
  SESSION: 0.6,
});

const DEFAULT_SOURCE_WEIGHTS = Object.freeze({
  global: SourceWeight.GLOBAL,
  workspace: SourceWeight.WORKSPACE,
  session: SourceWeight.SESSION,
});

// ---------------------------------------------------------------------------
// TemporalDecay
// ---------------------------------------------------------------------------

const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * Exponential temporal decay based on half-life.
 *
 * Formula: decayFactor = 2^(-ageDays / halfLifeDays)
 *
 * At age 0:     factor = 1.0
 * At halfLife:  factor = 0.5
 * At 2x halfLife: factor = 0.25
 */
class TemporalDecay {
  /**
   * @param {object} [options]
   * @param {number} [options.halfLifeDays=30] - Half-life in days.
   */
  constructor(options = {}) {
    this.halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    if (this.halfLifeDays <= 0) {
      throw new Error('[TemporalDecay] halfLifeDays must be positive');
    }
    // Precompute ln(2) / halfLifeDays for faster calculation.
    this._decayConstant = Math.log(2) / this.halfLifeDays;
  }

  /**
   * Compute decay factor for a given age in days.
   *
   * @param {number} ageDays - Age in days (>= 0).
   * @returns {number} Decay factor in [0, 1].
   */
  compute(ageDays) {
    if (ageDays <= 0) return 1.0;
    return Math.exp(-this._decayConstant * ageDays);
  }

  /**
   * Compute decay factor from a timestamp.
   *
   * @param {number|string|Date} timestamp - The creation/update timestamp.
   * @param {number} [now=Date.now()] - Current timestamp in milliseconds.
   * @returns {number} Decay factor in [0, 1].
   */
  fromTimestamp(timestamp, now = Date.now()) {
    if (!timestamp) return 0.5;
    const ts = typeof timestamp === 'string' || timestamp instanceof Date
      ? new Date(timestamp).getTime()
      : timestamp;
    if (isNaN(ts)) return 0.5;
    const ageMs = now - ts;
    if (ageMs < 0) return 1.0;
    const ageDays = ageMs / 86400000;
    return this.compute(ageDays);
  }

  /**
   * Apply temporal decay to an array of chunks.
   *
   * @param {Array<object>} chunks - Chunks with `updatedAt` or `createdAt` fields.
   * @param {number} [now=Date.now()] - Current timestamp in milliseconds.
   * @returns {Array<object>} Chunks with `_temporalScore` field added.
   */
  applyToChunks(chunks, now = Date.now()) {
    return chunks.map(chunk => {
      const ts = chunk.updatedAt || chunk.updated_at || chunk.createdAt || chunk.created_at || 0;
      const score = this.fromTimestamp(ts, now);
      return { ...chunk, _temporalScore: score };
    });
  }
}

// ---------------------------------------------------------------------------
// Simple TF-IDF (BM25 approximation) for Full-Text Search
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into lowercase terms.
 * Handles English words, Chinese characters, and alphanumeric tokens.
 *
 * @param {string} text - Input text.
 * @returns {string[]} Array of tokens.
 */
function tokenize(text) {
  if (!text) return [];
  const normalized = String(text).toLowerCase();
  const tokens = [];

  // Extract English words and numbers
  const englishTokens = normalized.match(/[a-z0-9]+/g);
  if (englishTokens) tokens.push(...englishTokens);

  // Extract individual Chinese characters (for CJK matching)
  const chineseChars = normalized.match(/[\u4e00-\u9fff]/g);
  if (chineseChars) tokens.push(...chineseChars);

  // Extract continuous Chinese segments (2-4 character phrases)
  const chineseSegments = normalized.match(/[\u4e00-\u9fff]{2,4}/g);
  if (chineseSegments) tokens.push(...chineseSegments);

  return tokens;
}

/**
 * Compute document frequency for IDF calculation.
 *
 * @param {Array<object>} chunks - Array of chunks with `content` or `text` fields.
 * @returns {Map<string, number>} Document frequency map.
 */
function computeDocumentFrequencies(chunks) {
  const df = new Map();
  for (const chunk of chunks) {
    const text = chunk.content || chunk.text || chunk.title || '';
    const tokens = new Set(tokenize(text));
    for (const token of tokens) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  return df;
}

/**
 * Compute TF-IDF scores for chunks against a query.
 *
 * @param {string} query - The search query.
 * @param {Array<object>} chunks - Array of chunks with text content.
 * @returns {Array<object>} Chunks with `_ftsScore` field added, sorted by score descending.
 */
function computeFtsScores(query, chunks) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || chunks.length === 0) {
    return chunks.map(c => ({ ...c, _ftsScore: 0 }));
  }

  const docFreq = computeDocumentFrequencies(chunks);
  const N = chunks.length;

  // Precompute IDF for each query token: log((N + 1) / (df + 1)) + 1
  const idfMap = new Map();
  for (const token of queryTokens) {
    const df = docFreq.get(token) || 0;
    idfMap.set(token, Math.log((N + 1) / (df + 1)) + 1);
  }

  const scored = chunks.map(chunk => {
    const text = (chunk.content || chunk.text || chunk.title || '').toLowerCase();
    const docTokens = tokenize(text);
    if (docTokens.length === 0) {
      return { ...chunk, _ftsScore: 0 };
    }

    // Compute TF for this document
    const tf = new Map();
    for (const token of docTokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    // Compute TF-IDF score: sum over query tokens of (tf * idf) / docLength
    let score = 0;
    const docLength = docTokens.length;
    for (const qToken of queryTokens) {
      const termFreq = tf.get(qToken) || 0;
      if (termFreq === 0) continue;
      const idf = idfMap.get(qToken) || 1;
      // BM25-like normalization: tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl/avgdl))
      // Simplified: tf * idf / docLength
      score += (termFreq * idf) / Math.max(docLength, 1);
    }

    // Normalize by query length
    score = score / queryTokens.length;

    return { ...chunk, _ftsScore: score };
  });

  return scored.sort((a, b) => b._ftsScore - a._ftsScore);
}

// ---------------------------------------------------------------------------
// Vector Similarity (Cosine Similarity)
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 *
 * @param {number[]} a - First vector.
 * @param {number[]} b - Second vector.
 * @returns {number} Cosine similarity in [-1, 1].
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compute vector similarity scores for chunks against a query embedding.
 *
 * @param {number[]} queryEmbedding - Query vector.
 * @param {Array<object>} chunks - Chunks with `embedding` field (pre-computed vectors).
 * @returns {Array<object>} Chunks with `_vectorScore` field added, sorted by score descending.
 */
function computeVectorScores(queryEmbedding, chunks) {
  if (!queryEmbedding || chunks.length === 0) {
    return chunks.map(c => ({ ...c, _vectorScore: 0 }));
  }

  const scored = chunks.map(chunk => {
    const embedding = chunk.embedding || chunk.vector;
    if (!embedding) {
      return { ...chunk, _vectorScore: 0 };
    }
    const similarity = cosineSimilarity(queryEmbedding, embedding);
    // Normalize to [0, 1] range (cosine can be negative, but for similarity we clamp)
    return { ...chunk, _vectorScore: Math.max(0, similarity) };
  });

  return scored.sort((a, b) => b._vectorScore - a._vectorScore);
}

// ---------------------------------------------------------------------------
// Source Weighting
// ---------------------------------------------------------------------------

/**
 * Apply source weights to chunks.
 *
 * @param {Array<object>} chunks - Chunks with `source` field.
 * @param {object} [weights=DEFAULT_SOURCE_WEIGHTS] - Weight mapping.
 * @returns {Array<object>} Chunks with `_sourceWeight` field added.
 */
function applySourceWeights(chunks, weights = DEFAULT_SOURCE_WEIGHTS) {
  return chunks.map(chunk => {
    const source = (chunk.source || 'session').toLowerCase();
    const weight = weights[source] ?? 0.5;
    return { ...chunk, _sourceWeight: weight };
  });
}

// ---------------------------------------------------------------------------
// MMR (Maximal Marginal Relevance) Re-Ranker
// ---------------------------------------------------------------------------

const DEFAULT_MMR_LAMBDA = 0.7;

/**
 * Diversity-aware re-ranking using the Maximal Marginal Relevance algorithm.
 *
 * MMR iteratively selects items that maximize relevance to the query
 * while minimizing similarity to already-selected items.
 *
 * Formula: MMR = argmax [lambda * sim(item, query) - (1 - lambda) * max_sim(item, selected)]
 */
class MMReranker {
  /**
   * @param {object} [options]
   * @param {number} [options.lambda=0.7] - Diversity vs relevance trade-off.
   *   1.0 = pure relevance, 0.0 = pure diversity.
   */
  constructor(options = {}) {
    this.lambda = options.lambda ?? DEFAULT_MMR_LAMBDA;
  }

  /**
   * Re-rank items using MMR for diversity.
   *
   * @param {Array<object>} items - Items to re-rank. Each should have `_ftsScore`,
   *   `_vectorScore`, or a combined `_relevanceScore` field, plus an `embedding`
   *   or `_text` field for similarity computation.
   * @param {number} [maxResults=20] - Maximum number of results to return.
   * @returns {Array<object>} Re-ranked items with `_mmrScore` field added.
   */
  reRank(items, maxResults = 20) {
    if (items.length <= maxResults) {
      return items.map(item => ({ ...item, _mmrScore: item._combinedScore || item._ftsScore || 0 }));
    }

    // Compute a combined relevance score for each item
    const scoredItems = items.map(item => {
      const relevance = item._combinedScore
        ?? item._relevanceScore
        ?? item._ftsScore
        ?? 0;
      return { ...item, _relevance: relevance };
    });

    // Start with the most relevant item
    const selected = [];
    const remaining = [...scoredItems];

    if (remaining.length === 0) return [];

    // Pick the first item (highest relevance)
    remaining.sort((a, b) => b._relevance - a._relevance);
    const first = remaining.shift();
    selected.push({ ...first, _mmrScore: first._relevance });

    // Iteratively pick items maximizing marginal relevance
    const lambda = this.lambda;

    while (selected.length < maxResults && remaining.length > 0) {
      let bestIdx = -1;
      let bestMMR = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const candidateEmb = candidate.embedding || candidate.vector;

        // Find max similarity to any selected item
        let maxSimToSelected = 0;

        if (candidateEmb) {
          // Use vector similarity if available
          for (const chosen of selected) {
            const chosenEmb = chosen.embedding || chosen.vector;
            if (chosenEmb) {
              const sim = cosineSimilarity(candidateEmb, chosenEmb);
              maxSimToSelected = Math.max(maxSimToSelected, sim);
            }
          }
        } else {
          // Fallback: use FTS score overlap as a proxy for similarity
          const candidateText = tokenize(candidate.content || candidate.text || '');
          if (candidateText.length > 0) {
            const candidateSet = new Set(candidateText);
            for (const chosen of selected) {
              const chosenText = tokenize(chosen.content || chosen.text || '');
              if (chosenText.length === 0) continue;
              const chosenSet = new Set(chosenText);
              // Jaccard similarity as a proxy
              const intersection = candidateText.filter(t => chosenSet.has(t)).length;
              const union = candidateSet.size + chosenSet.size - intersection;
              const sim = union > 0 ? intersection / union : 0;
              maxSimToSelected = Math.max(maxSimToSelected, sim);
            }
          }
        }

        // MMR formula
        const mmrScore = lambda * candidate._relevance - (1 - lambda) * maxSimToSelected;

        if (mmrScore > bestMMR) {
          bestMMR = mmrScore;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) break;

      const chosen = remaining.splice(bestIdx, 1)[0];
      selected.push({ ...chosen, _mmrScore: bestMMR });
    }

    return selected;
  }
}

// ---------------------------------------------------------------------------
// HybridSearchEngine
// ---------------------------------------------------------------------------

/**
 * Hybrid search engine combining multiple retrieval strategies.
 *
 * Features:
 * - TF-IDF based full-text search (FTS5 approximation)
 * - Cosine similarity vector search
 * - Temporal decay (exponential age-based scoring)
 * - Source weighting (global > workspace > session)
 * - MMR diversity re-ranking
 */
class HybridSearchEngine {
  /**
   * @param {object} [options]
   * @param {boolean}  [options.ftsEnabled=true]           - Enable FTS text search.
   * @param {boolean}  [options.vectorEnabled=true]        - Enable vector similarity search.
   * @param {boolean}  [options.temporalDecayEnabled=true]  - Enable temporal decay.
   * @param {boolean}  [options.mmrEnabled=true]            - Enable MMR re-ranking.
   * @param {number}   [options.halfLifeDays=30]            - Half-life for temporal decay (days).
   * @param {number}   [options.mmrLambda=0.7]              - MMR diversity vs relevance trade-off.
   * @param {number}   [options.minScore=0.0]              - Minimum combined score threshold.
   * @param {number}   [options.maxResults=20]              - Default maximum results.
   * @param {object}   [options.sourceWeights]              - Custom source weight mapping.
   */
  constructor(options = {}) {
    this._ftsEnabled = options.ftsEnabled !== false;
    this._vectorEnabled = options.vectorEnabled !== false;
    this._temporalDecayEnabled = options.temporalDecayEnabled !== false;
    this._mmrEnabled = options.mmrEnabled !== false;

    this._minScore = options.minScore ?? 0.0;
    this._maxResults = options.maxResults ?? 20;
    this._sourceWeights = { ...DEFAULT_SOURCE_WEIGHTS, ...(options.sourceWeights || {}) };

    this._temporalDecay = new TemporalDecay({ halfLifeDays: options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS });
    this._mmrRanker = new MMReranker({ lambda: options.mmrLambda ?? DEFAULT_MMR_LAMBDA });
  }

  /**
   * Execute hybrid search on a set of chunks.
   *
   * @param {string} query - The search query text.
   * @param {Array<object>} chunks - Array of chunks to search. Each chunk should have:
   *   - {string} id        - Unique identifier.
   *   - {string} content   - Text content.
   *   - {string} [source]  - Source type: 'global', 'workspace', or 'session'.
   *   - {number} [updatedAt] - Update timestamp (ms).
   *   - {number[]} [embedding] - Pre-computed embedding vector for vector search.
   * @param {object} [options]
   *   - {number}  [options.limit=20]      - Max results to return.
   *   - {number}  [options.minScore=0]   - Minimum score threshold.
   *   - {boolean} [options.fts]          - Override FTS enablement.
   *   - {boolean} [options.vector]      - Override vector enablement.
   *   - {boolean} [options.temporal]    - Override temporal decay enablement.
   *   - {boolean} [options.mmr]         - Override MMR enablement.
   *   {number[]}  [options.queryEmbedding] - Query embedding for vector search.
   * @returns {Array<object>} Sorted results with combined scores.
   */
  search(query, chunks, options = {}) {
    if (!query || !chunks || chunks.length === 0) {
      return [];
    }

    const limit = options.limit ?? this._maxResults;
    const minScore = options.minScore ?? this._minScore;
    const now = Date.now();

    // Work on shallow copies to avoid mutating input
    let workingChunks = chunks.map(c => ({ ...c }));

    // ---- Step 1: Full-Text Search (TF-IDF) ----
    const useFts = options.fts ?? this._ftsEnabled;
    if (useFts) {
      workingChunks = this._runFts(query, workingChunks);
    } else {
      workingChunks = workingChunks.map(c => ({ ...c, _ftsScore: 0 }));
    }

    // ---- Step 2: Vector Similarity ----
    const useVector = options.vector ?? this._vectorEnabled;
    if (useVector && options.queryEmbedding) {
      workingChunks = this._runVector(options.queryEmbedding, workingChunks);
    } else {
      workingChunks = workingChunks.map(c => ({ ...c, _vectorScore: c._vectorScore ?? 0 }));
    }

    // ---- Step 3: Temporal Decay ----
    const useTemporal = options.temporal ?? this._temporalDecayEnabled;
    if (useTemporal) {
      workingChunks = this._temporalDecay.applyToChunks(workingChunks, now);
    } else {
      workingChunks = workingChunks.map(c => ({ ...c, _temporalScore: 1.0 }));
    }

    // ---- Step 4: Source Weighting ----
    workingChunks = applySourceWeights(workingChunks, this._sourceWeights);

    // ---- Step 5: Combine Scores ----
    // Combined = (fts * 0.4 + vector * 0.4) * temporal * sourceWeight
    const scoredChunks = workingChunks.map(chunk => {
      const fts = chunk._ftsScore || 0;
      const vector = chunk._vectorScore || 0;
      const temporal = chunk._temporalScore ?? 1.0;
      const sourceW = chunk._sourceWeight ?? 0.5;

      const relevanceScore = fts * 0.4 + vector * 0.4;
      const combinedScore = relevanceScore * temporal * sourceW;

      return {
        ...chunk,
        _relevanceScore: relevanceScore,
        _combinedScore: combinedScore,
        scores: {
          fts,
          vector,
          temporal,
          sourceWeight: sourceW,
          combined: combinedScore,
        },
      };
    });

    // ---- Step 6: Filter by minimum score ----
    let results = scoredChunks
      .filter(c => c._combinedScore >= minScore);

    // ---- Step 7: MMR Re-Ranking (diversity) ----
    const useMmr = options.mmr ?? this._mmrEnabled;
    if (useMmr && results.length > limit) {
      results = this._mmrRanker.reRank(results, limit);
    } else {
      // Sort by combined score
      results.sort((a, b) => b._combinedScore - a._combinedScore);
      results = results.slice(0, limit);
    }

    return results;
  }

  /**
   * Run FTS scoring on chunks.
   * @private
   */
  _runFts(query, chunks) {
    const scored = computeFtsScores(query, chunks);
    return scored.map(c => ({ ...c, _ftsScore: c._ftsScore || 0 }));
  }

  /**
   * Run vector similarity scoring on chunks.
   * @private
   */
  _runVector(queryEmbedding, chunks) {
    const scored = computeVectorScores(queryEmbedding, chunks);
    return scored.map(c => ({ ...c, _vectorScore: c._vectorScore || 0 }));
  }

  /**
   * Get the current configuration.
   * @returns {object} Configuration snapshot.
   */
  getConfig() {
    return {
      ftsEnabled: this._ftsEnabled,
      vectorEnabled: this._vectorEnabled,
      temporalDecayEnabled: this._temporalDecayEnabled,
      mmrEnabled: this._mmrEnabled,
      halfLifeDays: this._temporalDecay.halfLifeDays,
      mmrLambda: this._mmrRanker.lambda,
      minScore: this._minScore,
      maxResults: this._maxResults,
      sourceWeights: { ...this._sourceWeights },
    };
  }

  /**
   * Update configuration options.
   * @param {object} options - Options to update.
   */
  configure(options = {}) {
    if (options.ftsEnabled !== undefined) this._ftsEnabled = options.ftsEnabled;
    if (options.vectorEnabled !== undefined) this._vectorEnabled = options.vectorEnabled;
    if (options.temporalDecayEnabled !== undefined) this._temporalDecayEnabled = options.temporalDecayEnabled;
    if (options.mmrEnabled !== undefined) this._mmrEnabled = options.mmrEnabled;
    if (options.halfLifeDays !== undefined) {
      this._temporalDecay = new TemporalDecay({ halfLifeDays: options.halfLifeDays });
    }
    if (options.mmrLambda !== undefined) {
      this._mmrRanker = new MMReranker({ lambda: options.mmrLambda });
    }
    if (options.minScore !== undefined) this._minScore = options.minScore;
    if (options.maxResults !== undefined) this._maxResults = options.maxResults;
    if (options.sourceWeights) {
      this._sourceWeights = { ...DEFAULT_SOURCE_WEIGHTS, ...options.sourceWeights };
    }
  }
}

// ---------------------------------------------------------------------------
// Module Exports
// ---------------------------------------------------------------------------

module.exports = {
  HybridSearchEngine,
  TemporalDecay,
  MMReranker,
  SourceWeight,
  // Also export utility functions for advanced usage
  cosineSimilarity,
  tokenize,
  computeFtsScores,
  computeVectorScores,
  applySourceWeights,
};