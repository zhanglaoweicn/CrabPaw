const EventEmitter = require('events');

const TOKEN_MIN = 10;
const TOKEN_RAMP_LOW = 30;
const TOKEN_RAMP_HIGH = 3000;
const TOKEN_MAX = 8000;

const MIN_TOTAL_WORDS = 5;

const DEFAULT_DROP_THRESHOLD = 0.3;
const DEFAULT_DEFINITE_KEEP = 0.85;
const DEFAULT_DEFINITE_DROP = 0.15;

const INTERACTION_TAG_SENT = 'sent';
const INTERACTION_TAG_REPLY = 'reply';
const INTERACTION_TAG_DM = 'dm';
const INTERACTION_TAG_MENTION = 'mention';

const SOURCE_KIND_WEIGHTS = {
  email: 0.8,
  document: 0.9,
  chat: 0.5,
  tool: 0.6,
  session: 0.7,
  user: 0.85,
};

const PROVIDER_WEIGHTS = {
  gmail: 0.8,
  other_email: 0.7,
  whatsapp: 0.75,
  telegram: 0.6,
  discord: 0.5,
  notion: 0.75,
  drive_docs: 0.6,
  meeting_notes: 0.85,
  slack: 0.55,
  github: 0.7,
  terminal: 0.65,
};

class ScoreSignals {
  constructor(opts = {}) {
    this.tokenCount = opts.tokenCount || 0;
    this.uniqueWords = opts.uniqueWords || 0;
    this.metadataWeight = opts.metadataWeight || 0;
    this.sourceWeight = opts.sourceWeight || 0;
    this.interaction = opts.interaction || 0;
    this.entityDensity = opts.entityDensity || 0;
    this.llmImportance = opts.llmImportance || 0;
  }

  toJSON() {
    return {
      tokenCount: this.tokenCount,
      uniqueWords: this.uniqueWords,
      metadataWeight: this.metadataWeight,
      sourceWeight: this.sourceWeight,
      interaction: this.interaction,
      entityDensity: this.entityDensity,
      llmImportance: this.llmImportance,
    };
  }
}

class SignalWeights {
  constructor(opts = {}) {
    this.tokenCount = opts.tokenCount ?? 1.0;
    this.uniqueWords = opts.uniqueWords ?? 1.0;
    this.metadataWeight = opts.metadataWeight ?? 1.5;
    this.sourceWeight = opts.sourceWeight ?? 1.5;
    this.interaction = opts.interaction ?? 3.0;
    this.entityDensity = opts.entityDensity ?? 1.0;
    this.llmImportance = opts.llmImportance ?? 0.0;
  }

  static withLLM() {
    return new SignalWeights({ llmImportance: 2.0 });
  }
}

class ScoreResult {
  constructor(opts = {}) {
    this.chunkId = opts.chunkId || '';
    this.total = opts.total || 0;
    this.signals = opts.signals || new ScoreSignals();
    this.kept = opts.kept ?? false;
    this.dropReason = opts.dropReason || null;
    this.extractedEntities = opts.extractedEntities || [];
    this.canonicalEntities = opts.canonicalEntities || [];
  }
}

class ScoringConfig {
  constructor(opts = {}) {
    this.weights = opts.weights || new SignalWeights(opts.weightsOpts);
    this.dropThreshold = opts.dropThreshold ?? DEFAULT_DROP_THRESHOLD;
    this.definiteKeepThreshold = opts.definiteKeepThreshold ?? DEFAULT_DEFINITE_KEEP;
    this.definiteDropThreshold = opts.definiteDropThreshold ?? DEFAULT_DEFINITE_DROP;
    this.llmExtractor = opts.llmExtractor || null;
    this.entityExtractor = opts.entityExtractor || null;
  }
}

function scoreTokenCount(tokenCount) {
  if (tokenCount < TOKEN_MIN) return 0.0;
  if (tokenCount <= TOKEN_RAMP_LOW) {
    return (tokenCount - TOKEN_MIN) / (TOKEN_RAMP_LOW - TOKEN_MIN);
  }
  if (tokenCount <= TOKEN_RAMP_HIGH) return 1.0;
  if (tokenCount <= TOKEN_MAX) {
    const t = (tokenCount - TOKEN_RAMP_HIGH) / (TOKEN_MAX - TOKEN_RAMP_HIGH);
    return 1.0 - 0.5 * t;
  }
  return 0.5;
}

function scoreUniqueWords(text) {
  if (!text || typeof text !== 'string') return 0.5;

  let total = 0;
  const uniq = new Set();

  for (const raw of text.split(/\s+/)) {
    const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
    if (!w) continue;
    total++;
    uniq.add(w);
  }

  if (total < MIN_TOTAL_WORDS) return 0.5;

  const ratio = uniq.size / total;
  if (ratio <= 0.3) return 0.0;
  if (ratio >= 0.7) return 1.0;
  return (ratio - 0.3) / 0.4;
}

function scoreMetadataWeight(metadata) {
  const kind = metadata?.sourceKind || metadata?.source_kind || 'chat';
  return SOURCE_KIND_WEIGHTS[kind] ?? 0.5;
}

function scoreSourceWeight(metadata) {
  const tags = metadata?.tags || [];
  for (const tag of tags) {
    if (tag.startsWith('provider:')) {
      const provider = tag.slice('provider:'.length);
      const key = provider.toLowerCase().replace(/-/g, '_');
      if (key in PROVIDER_WEIGHTS) return PROVIDER_WEIGHTS[key];
    }
  }
  const kind = metadata?.sourceKind || metadata?.source_kind || 'chat';
  return SOURCE_KIND_WEIGHTS[kind] ?? 0.5;
}

function scoreInteraction(metadata) {
  const tags = metadata?.tags || [];
  let anyTag = false;
  let total = 0.0;

  for (const t of tags) {
    switch (t) {
      case INTERACTION_TAG_SENT:
        total += 0.6;
        anyTag = true;
        break;
      case INTERACTION_TAG_REPLY:
        total += 0.5;
        anyTag = true;
        break;
      case INTERACTION_TAG_DM:
        total += 0.3;
        anyTag = true;
        break;
      case INTERACTION_TAG_MENTION:
        total += 0.2;
        anyTag = true;
        break;
    }
  }

  if (!anyTag) return 0.5;
  return Math.min(total, 1.0);
}

function scoreEntityDensity(tokenCount, entityCount) {
  if (tokenCount === 0) return 0.0;
  const unique = (entityCount || 0);
  const perToken = unique / tokenCount;
  return Math.min(perToken / 0.01, 1.0);
}

function computeSignals(metadata, content, tokenCount, extractedEntities) {
  return new ScoreSignals({
    tokenCount: scoreTokenCount(tokenCount),
    uniqueWords: scoreUniqueWords(content),
    metadataWeight: scoreMetadataWeight(metadata),
    sourceWeight: scoreSourceWeight(metadata),
    interaction: scoreInteraction(metadata),
    entityDensity: scoreEntityDensity(tokenCount, extractedEntities?.length || 0),
    llmImportance: 0.0,
  });
}

function combine(signals, weights) {
  const totalWeight =
    weights.tokenCount +
    weights.uniqueWords +
    weights.metadataWeight +
    weights.sourceWeight +
    weights.interaction +
    weights.entityDensity +
    weights.llmImportance;
  if (totalWeight <= 0) return 0.0;

  const weighted =
    signals.tokenCount * weights.tokenCount +
    signals.uniqueWords * weights.uniqueWords +
    signals.metadataWeight * weights.metadataWeight +
    signals.sourceWeight * weights.sourceWeight +
    signals.interaction * weights.interaction +
    signals.entityDensity * weights.entityDensity +
    signals.llmImportance * weights.llmImportance;

  return Math.max(0, Math.min(1, weighted / totalWeight));
}

function combineCheapOnly(signals, weights) {
  const totalWeight =
    weights.tokenCount +
    weights.uniqueWords +
    weights.metadataWeight +
    weights.sourceWeight +
    weights.interaction +
    weights.entityDensity;
  if (totalWeight <= 0) return 0.0;

  const weighted =
    signals.tokenCount * weights.tokenCount +
    signals.uniqueWords * weights.uniqueWords +
    signals.metadataWeight * weights.metadataWeight +
    signals.sourceWeight * weights.sourceWeight +
    signals.interaction * weights.interaction +
    signals.entityDensity * weights.entityDensity;

  return Math.max(0, Math.min(1, weighted / totalWeight));
}

function approxTokenCount(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function scoreChunk(chunk, config) {
  const cfg = config || new ScoringConfig();
  const content = chunk.content || '';
  const metadata = chunk.metadata || {};
  const tokenCount = chunk.tokenCount || approxTokenCount(content);

  let extractedEntities = [];
  if (cfg.entityExtractor && typeof cfg.entityExtractor.extract === 'function') {
    try {
      extractedEntities = cfg.entityExtractor.extract(content) || [];
    } catch (e) {
      /* 忽略错误 */
      console.warn('[scoring.js] 空 catch 补日志:', e && e.message);
    }

  }

  const signals = computeSignals(metadata, content, tokenCount, extractedEntities);
  const cheapTotal = combineCheapOnly(signals, cfg.weights);

  const inBand =
    cheapTotal > cfg.definiteDropThreshold &&
    cheapTotal < cfg.definiteKeepThreshold;

  let llmConsulted = false;
  if (inBand && cfg.llmExtractor) {
      try {
      const llmResult = cfg.llmExtractor(content);
      if (llmResult && llmResult.importance !== undefined) {
      signals.llmImportance = Math.max(0, Math.min(1, llmResult.importance));
      if (llmResult.entities) {
      extractedEntities = extractedEntities.concat(llmResult.entities);
      }
      llmConsulted = true;
      }
      } catch (e) {
        /* 忽略错误 */
        console.warn('[scoring.js] 空 catch 补日志:', e && e.message);
      }

  }

  const total = llmConsulted
    ? combine(signals, cfg.weights)
    : combineCheapOnly(signals, cfg.weights);

  const tinyEntityFree =
    tokenCount < TOKEN_MIN && extractedEntities.length === 0;
  const kept = !tinyEntityFree && total >= cfg.dropThreshold;

  let dropReason = null;
  if (!kept) {
    if (tinyEntityFree) {
      dropReason = `token_count ${tokenCount} < minimum ${TOKEN_MIN} and no entities extracted`;
    } else {
      dropReason = `total ${total.toFixed(3)} < threshold ${cfg.dropThreshold.toFixed(3)}`;
    }
  }

  return new ScoreResult({
    chunkId: chunk.id || '',
    total,
    signals,
    kept,
    dropReason,
    extractedEntities,
  });
}

function scoreChunks(chunks, config) {
  if (!Array.isArray(chunks)) return [];
  const cfg = config || new ScoringConfig();
  return chunks.map((chunk) => scoreChunk(chunk, cfg));
}

function scoreChunksFast(chunks, config) {
  const cfg = new ScoringConfig({
    ...(config || {}),
    llmExtractor: null,
  });
  return scoreChunks(chunks, cfg);
}

class ScoringPipeline extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = new ScoringConfig(config);
    this._stats = {
      total: 0,
      admitted: 0,
      dropped: 0,
      llmConsulted: 0,
    };
  }

  score(chunk) {
    const result = scoreChunk(chunk, this.config);
    this._stats.total++;
    if (result.kept) {
      this._stats.admitted++;
    } else {
      this._stats.dropped++;
    }
    this.emit('scored', result);
    return result;
  }

  scoreBatch(chunks) {
    return chunks.map((chunk) => this.score(chunk));
  }

  getStats() {
    return { ...this._stats };
  }

  resetStats() {
    this._stats = { total: 0, admitted: 0, dropped: 0, llmConsulted: 0 };
  }
}

class TrustFeedbackCollector {
  constructor(trustManager) {
    this.trustManager = trustManager;
    this.pendingFeedback = new Map();
    this.flushTimer = null;
    this.flushInterval = 5000;
  }

  queueFeedback(factId, feedback) {
    this.pendingFeedback.set(factId, feedback);
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush();
      this.flushTimer = null;
    }, this.flushInterval);
  }

  flush() {
    const feedback = new Map(this.pendingFeedback);
    this.pendingFeedback.clear();
    return feedback;
  }

  getPendingCount() {
    return this.pendingFeedback.size;
  }
}

const { TrustScoreManager } = require('./trust-score');

module.exports = {

  ScoreSignals,
  SignalWeights,
  ScoreResult,
  ScoringConfig,
  ScoringPipeline,
  scoreTokenCount,
  scoreUniqueWords,
  scoreMetadataWeight,
  scoreSourceWeight,
  scoreInteraction,
  scoreEntityDensity,
  computeSignals,
  combine,
  combineCheapOnly,
  approxTokenCount,
  scoreChunk,
  scoreChunks,
  scoreChunksFast,
  TOKEN_MIN,
  TOKEN_RAMP_LOW,
  TOKEN_RAMP_HIGH,
  TOKEN_MAX,
  MIN_TOTAL_WORDS,
  DEFAULT_DROP_THRESHOLD,
  DEFAULT_DEFINITE_KEEP,
  DEFAULT_DEFINITE_DROP,
  SOURCE_KIND_WEIGHTS,
  PROVIDER_WEIGHTS,
  TrustScoreManager,
  TrustFeedbackCollector,

};


