/**
 * Trust Score System
 * 
 * 记忆信任评分机制 — 根据来源、新鲜度、交叉验证计算可信度。
 * 实现记忆质量的动态评估
 * 
 * 核心机制：
 * - 初始信任分数：default_trust (默认 0.5)
 * - helpful 反馈：+0.05
 * - unhelpful 反馈：-0.10
 * - 访问计数：每次检索 +1
 * - 时间衰减：可选的半衰期衰减
 */

const EventEmitter = require('events');

const TRUST_CONSTANTS = {
  HELPFUL_DELTA: 0.05,
  UNHELPFUL_DELTA: -0.10,
  TRUST_MIN: 0.0,
  TRUST_MAX: 1.0,
  DEFAULT_TRUST: 0.5,
  HIGH_CONFIDENCE_THRESHOLD: 0.8,
  LOW_CONFIDENCE_THRESHOLD: 0.3,
};

function clampTrust(value) {
  return Math.max(
    TRUST_CONSTANTS.TRUST_MIN,
    Math.min(TRUST_CONSTANTS.TRUST_MAX, value)
  );
}

class TrustScoreManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      defaultTrust: config.defaultTrust || TRUST_CONSTANTS.DEFAULT_TRUST,
      helpfulDelta: config.helpfulDelta || TRUST_CONSTANTS.HELPFUL_DELTA,
      unhelpfulDelta: config.unhelpfulDelta || TRUST_CONSTANTS.UNHELPFUL_DELTA,
      temporalDecayHalfLife: config.temporalDecayHalfLife || 0,
      accessBoost: config.accessBoost || 0.01,
      maxAccessBoost: config.maxAccessBoost || 0.2,
    };
  }

  initializeFact(fact, initialConfidence = null) {
    const trust = initialConfidence !== null
      ? clampTrust(initialConfidence)
      : this.config.defaultTrust;

    return {
      ...fact,
      trustScore: trust,
      helpfulCount: 0,
      unhelpfulCount: 0,
      retrievalCount: 0,
      lastAccessedAt: Date.now(),
      trustHistory: [{
        timestamp: Date.now(),
        action: 'init',
        value: trust,
      }],
    };
  }

  recordFeedback(fact, feedback) {
    const delta = feedback === 'helpful'
      ? this.config.helpfulDelta
      : this.config.unhelpfulDelta;

    const newTrust = clampTrust(fact.trustScore + delta);

    const updatedFact = {
      ...fact,
      trustScore: newTrust,
      helpfulCount: fact.helpfulCount + (feedback === 'helpful' ? 1 : 0),
      unhelpfulCount: fact.unhelpfulCount + (feedback === 'unhelpful' ? 1 : 0),
      trustHistory: [
        ...(fact.trustHistory || []),
        {
          timestamp: Date.now(),
          action: feedback,
          delta,
          value: newTrust,
        },
      ],
    };

    this.emit('feedback:recorded', {
      factId: fact.id,
      feedback,
      oldTrust: fact.trustScore,
      newTrust,
    });

    return updatedFact;
  }

  recordRetrieval(fact) {
    const accessBoost = Math.min(
      this.config.accessBoost,
      this.config.maxAccessBoost - (fact.accessBoost || 0)
    );

    const updatedFact = {
      ...fact,
      retrievalCount: (fact.retrievalCount || 0) + 1,
      lastAccessedAt: Date.now(),
      accessBoost: (fact.accessBoost || 0) + accessBoost,
      trustScore: clampTrust(fact.trustScore + accessBoost),
    };

    this.emit('retrieval:recorded', {
      factId: fact.id,
      retrievalCount: updatedFact.retrievalCount,
      trustScore: updatedFact.trustScore,
    });

    return updatedFact;
  }

  applyTemporalDecay(fact) {
    if (this.config.temporalDecayHalfLife <= 0) {
      return fact;
    }

    const ageMs = Date.now() - (fact.lastAccessedAt || fact.createdAt || Date.now());
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    const decayFactor = Math.pow(0.5, ageDays / this.config.temporalDecayHalfLife);

    const baseTrust = fact.trustScore - (fact.accessBoost || 0);
    const decayedTrust = baseTrust * decayFactor + (fact.accessBoost || 0);

    return {
      ...fact,
      trustScore: clampTrust(decayedTrust),
      decayApplied: true,
      decayFactor,
    };
  }

  getTrustLevel(trustScore) {
    if (trustScore >= TRUST_CONSTANTS.HIGH_CONFIDENCE_THRESHOLD) {
      return 'high';
    }
    if (trustScore >= TRUST_CONSTANTS.LOW_CONFIDENCE_THRESHOLD) {
      return 'medium';
    }
    return 'low';
  }

  calculateEffectiveTrust(fact) {
    let trust = fact.trustScore || this.config.defaultTrust;

    if (this.config.temporalDecayHalfLife > 0) {
      const ageMs = Date.now() - (fact.lastAccessedAt || fact.createdAt || Date.now());
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      const decayFactor = Math.pow(0.5, ageDays / this.config.temporalDecayHalfLife);
      trust *= decayFactor;
    }

    const feedbackRatio = fact.helpfulCount + fact.unhelpfulCount > 0
      ? fact.helpfulCount / (fact.helpfulCount + fact.unhelpfulCount)
      : 0.5;

    const feedbackBoost = (feedbackRatio - 0.5) * 0.2;
    trust = clampTrust(trust + feedbackBoost);

    return trust;
  }

  getStats(fact) {
    return {
      trustScore: fact.trustScore,
      trustLevel: this.getTrustLevel(fact.trustScore),
      effectiveTrust: this.calculateEffectiveTrust(fact),
      helpfulCount: fact.helpfulCount || 0,
      unhelpfulCount: fact.unhelpfulCount || 0,
      retrievalCount: fact.retrievalCount || 0,
      feedbackRatio: fact.helpfulCount + fact.unhelpfulCount > 0
        ? fact.helpfulCount / (fact.helpfulCount + fact.unhelpfulCount)
        : null,
      historyLength: (fact.trustHistory || []).length,
    };
  }

  batchUpdate(facts, updates) {
    return facts.map(fact => {
      const update = updates.find(u => u.id === fact.id);
      if (!update) return fact;

      let updated = { ...fact };

      if (update.feedback) {
        updated = this.recordFeedback(updated, update.feedback);
      }

      if (update.retrieved) {
        updated = this.recordRetrieval(updated);
      }

      return updated;
    });
  }

  filterByTrust(facts, minTrust = TRUST_CONSTANTS.LOW_CONFIDENCE_THRESHOLD) {
    return facts.filter(fact => {
      const effectiveTrust = this.calculateEffectiveTrust(fact);
      return effectiveTrust >= minTrust;
    });
  }

  rankByTrust(facts) {
    return facts
      .map(fact => ({
        ...fact,
        effectiveTrust: this.calculateEffectiveTrust(fact),
      }))
      .sort((a, b) => b.effectiveTrust - a.effectiveTrust);
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

module.exports = {
  TrustScoreManager,
  TrustFeedbackCollector,
  TRUST_CONSTANTS,
  clampTrust,
};
