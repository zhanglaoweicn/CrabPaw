const crypto = require('crypto');
const { EventEmitter } = require('events');

const FACET_CLASSES = {
  IDENTITY: 'identity',
  VETO: 'veto',
  TOOLING: 'tooling',
  GOAL: 'goal',
  STYLE: 'style',
  CHANNEL: 'channel',
};

const FACET_CLASS_META = {
  [FACET_CLASSES.IDENTITY]: {
    description: '用户身份信息（姓名、角色、组织等）',
    halfLifeSeconds: 90 * 86400,
    weight: 1.2,
    examples: ['name', 'role', 'organization', 'timezone', 'language'],
  },
  [FACET_CLASSES.VETO]: {
    description: '用户明确禁止或偏好的行为',
    halfLifeSeconds: 60 * 86400,
    weight: 1.5,
    examples: ['no_auto_commit', 'prefer_concise', 'no_emoji'],
  },
  [FACET_CLASSES.TOOLING]: {
    description: '工具使用偏好和配置',
    halfLifeSeconds: 30 * 86400,
    weight: 1.0,
    examples: ['preferred_editor', 'test_framework', 'package_manager'],
  },
  [FACET_CLASSES.GOAL]: {
    description: '用户当前目标和项目方向',
    halfLifeSeconds: 14 * 86400,
    weight: 1.1,
    examples: ['current_project', 'learning_topic', 'deadline'],
  },
  [FACET_CLASSES.STYLE]: {
    description: '交互风格偏好',
    halfLifeSeconds: 14 * 86400,
    weight: 0.9,
    examples: ['response_length', 'formality', 'detail_level', 'code_style'],
  },
  [FACET_CLASSES.CHANNEL]: {
    description: '通道特定偏好',
    halfLifeSeconds: 21 * 86400,
    weight: 0.8,
    examples: ['wecom_notification', 'slack_thread_reply', 'email_digest'],
  },
};

const CUE_FAMILIES = {
  EXPLICIT: 'explicit',
  BEHAVIORAL: 'behavioral',
  HEURISTIC: 'heuristic',
};

const CUE_WEIGHTS = {
  [CUE_FAMILIES.EXPLICIT]: 1.0,
  [CUE_FAMILIES.BEHAVIORAL]: 0.6,
  [CUE_FAMILIES.HEURISTIC]: 0.3,
};

const FACET_STATES = {
  DROPPED: 'dropped',
  CANDIDATE: 'candidate',
  PROVISIONAL: 'provisional',
  ACTIVE: 'active',
  FORGOTTEN: 'forgotten',
};

const TAU_PROMOTE = 1.5;
const TAU_PROVISIONAL = 0.7;
const TAU_EVICT = 0.4;
const TAU_DROP = 0.15;

const TRANSITIONS = {
  [FACET_STATES.DROPPED]: {
    next: FACET_STATES.CANDIDATE,
    condition: (score) => score >= TAU_EVICT,
  },
  [FACET_STATES.CANDIDATE]: {
    promote: FACET_STATES.PROVISIONAL,
    promoteCondition: (score) => score >= TAU_PROVISIONAL,
    demote: FACET_STATES.DROPPED,
    demoteCondition: (score) => score < TAU_DROP,
  },
  [FACET_STATES.PROVISIONAL]: {
    promote: FACET_STATES.ACTIVE,
    promoteCondition: (score) => score >= TAU_PROMOTE,
    demote: FACET_STATES.CANDIDATE,
    demoteCondition: (score) => score < TAU_EVICT,
  },
  [FACET_STATES.ACTIVE]: {
    demote: FACET_STATES.PROVISIONAL,
    demoteCondition: (score) => score < TAU_PROVISIONAL,
  },
  [FACET_STATES.FORGOTTEN]: {
    terminal: true,
  },
};

class LearningCandidate {
  constructor(opts) {
    this.id = opts.id || `cand_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.facetClass = opts.facetClass || FACET_CLASSES.STYLE;
    this.key = opts.key || '';
    this.value = opts.value || '';
    this.cueFamily = opts.cueFamily || CUE_FAMILIES.BEHAVIORAL;
    this.evidenceCount = opts.evidenceCount || 1;
    this.stabilityScore = 0;
    this.state = opts.state || FACET_STATES.CANDIDATE;
    this.hasExplicit = opts.hasExplicit || false;
    this.lastSeenAt = opts.lastSeenAt || Date.now() / 1000;
    this.namespace = opts.namespace || 'global';
    this.metadata = opts.metadata || {};
    this.createdAt = opts.createdAt || Date.now() / 1000;
    this.updatedAt = opts.updatedAt || Date.now() / 1000;
  }

  toStoreInput() {
    return {
      id: this.id,
      facet_class: this.facetClass,
      key: this.key,
      value: this.value,
      cue_family: this.cueFamily,
      evidence_count: this.evidenceCount,
      stability_score: this.stabilityScore,
      state: this.state,
      has_explicit: this.hasExplicit,
      last_seen_at: this.lastSeenAt,
      namespace: this.namespace,
      metadata: this.metadata,
    };
  }

  static fromStoreRow(row) {
    return new LearningCandidate({
      id: row.id,
      facetClass: row.facet_class,
      key: row.key,
      value: row.value,
      cueFamily: row.cue_family,
      evidenceCount: row.evidence_count,
      stabilityScore: row.stability_score,
      state: row.state,
      hasExplicit: row.has_explicit === 1,
      lastSeenAt: row.last_seen_at,
      namespace: row.namespace,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

class StabilityDetector extends EventEmitter {
  constructor(config = {}) {
    super();
    this._store = config.store || null;
    this._tauPromote = config.tauPromote || TAU_PROMOTE;
    this._tauProvisional = config.tauProvisional || TAU_PROVISIONAL;
    this._tauEvict = config.tauEvict || TAU_EVICT;
    this._tauDrop = config.tauDrop || TAU_DROP;
    this._classMeta = { ...FACET_CLASS_META, ...(config.classMeta || {}) };
    this._cueWeights = { ...CUE_WEIGHTS, ...(config.cueWeights || {}) };
    this._rebuildInterval = config.rebuildInterval || 300000;
    this._rebuildTimer = null;
  }

  setStore(store) {
    this._store = store;
  }

  start() {
    if (this._rebuildTimer) return;
    this._rebuildTimer = setInterval(() => this.rebuild(), this._rebuildInterval);
    if (this._rebuildTimer.unref) this._rebuildTimer.unref();
  }

  stop() {
    if (this._rebuildTimer) {
      clearInterval(this._rebuildTimer);
      this._rebuildTimer = null;
    }
  }

  computeStability(candidate, now = Date.now() / 1000) {
    const classMeta = this._classMeta[candidate.facetClass] || this._classMeta[FACET_CLASSES.STYLE];
    const halfLife = classMeta.halfLifeSeconds;
    const classWeight = classMeta.weight;

    const dt = Math.max(0, now - candidate.lastSeenAt);
    const recency = Math.exp(-dt / halfLife);

    const cueWeight = this._cueWeights[candidate.cueFamily] || 0.5;

    const evidenceFactor = Math.sqrt(candidate.evidenceCount);

    let base = cueWeight * evidenceFactor * recency * classWeight;

    if (candidate.hasExplicit) {
      base *= 1.2;
    }

    return base;
  }

  evaluateTransition(candidate, now = Date.now() / 1000) {
    const score = this.computeStability(candidate, now);
    candidate.stabilityScore = score;

    if (candidate.state === FACET_STATES.FORGOTTEN) {
      return { transition: 'none', newState: FACET_STATES.FORGOTTEN, score };
    }

    const stateConfig = TRANSITIONS[candidate.state];
    if (!stateConfig) return { transition: 'none', newState: candidate.state, score };

    if (stateConfig.terminal) {
      return { transition: 'none', newState: candidate.state, score };
    }

    if (stateConfig.promote && stateConfig.promoteCondition && stateConfig.promoteCondition(score)) {
      return { transition: 'promote', newState: stateConfig.promote, score };
    }

    if (stateConfig.demote && stateConfig.demoteCondition && stateConfig.demoteCondition(score)) {
      return { transition: 'demote', newState: stateConfig.demote, score };
    }

    return { transition: 'none', newState: candidate.state, score };
  }

  processCandidate(candidate, now = Date.now() / 1000) {
    const result = this.evaluateTransition(candidate, now);

    if (result.transition !== 'none') {
      const oldState = candidate.state;
      candidate.state = result.newState;
      candidate.updatedAt = now;

      this.emit('facet:transition', {
        id: candidate.id,
        facetClass: candidate.facetClass,
        key: candidate.key,
        fromState: oldState,
        toState: result.newState,
        transition: result.transition,
        score: result.score,
      });

      if (this._store) {
        this._store.updateFacetState(candidate.id, result.newState, result.score);
      }
    }

    return result;
  }

  addEvidence(facetClass, key, value, opts = {}) {
    if (!this._store) return null;

    const namespace = opts.namespace || 'global';
    const cueFamily = opts.cueFamily || CUE_FAMILIES.BEHAVIORAL;
    const isExplicit = opts.explicit || false;

    const existing = this._store.findFacetByKey(facetClass, key, namespace);

    if (existing) {
      const candidate = LearningCandidate.fromStoreRow(existing);

      if (isExplicit && !candidate.hasExplicit) {
        candidate.hasExplicit = true;
      }

      if (value && value !== candidate.value) {
        candidate.value = value;
      }

      candidate.evidenceCount++;
      candidate.lastSeenAt = Date.now() / 1000;
      candidate.cueFamily = this._upgradeCueFamily(candidate.cueFamily, cueFamily);

      // 返回值仅用于调用方展示;addEvidence 的副作用在 processCandidate 内部
      // (updateFacetState/upsertFacet),无需消费——与 L311 new-candidate 分支一致
      this.processCandidate(candidate);

      this._store.upsertFacet(candidate.toStoreInput());

      this.emit('evidence:added', {
        id: candidate.id,
        facetClass,
        key,
        evidenceCount: candidate.evidenceCount,
        state: candidate.state,
        score: candidate.stabilityScore,
      });

      return candidate;
    }

    const candidate = new LearningCandidate({
      facetClass,
      key,
      value,
      cueFamily,
      hasExplicit: isExplicit,
      namespace,
    });

    this.processCandidate(candidate);

    this._store.upsertFacet(candidate.toStoreInput());

    this.emit('candidate:created', {
      id: candidate.id,
      facetClass,
      key,
      value,
      cueFamily,
    });

    return candidate;
  }

  markForgotten(facetClass, key, namespace = 'global') {
    if (!this._store) return;

    const existing = this._store.findFacetByKey(facetClass, key, namespace);
    if (!existing) return;

    this._store.updateFacetState(existing.id, FACET_STATES.FORGOTTEN, existing.stability_score);

    this.emit('facet:forgotten', { id: existing.id, facetClass, key });
  }

  rebuild() {
    if (!this._store) return;

    const now = Date.now() / 1000;
    const allFacets = this._store.getFacets();

    let promoted = 0;
    let demoted = 0;
    let evicted = 0;

    for (const row of allFacets) {
      const candidate = LearningCandidate.fromStoreRow(row);
      const result = this.processCandidate(candidate, now);

      if (result.transition === 'promote') promoted++;
      else if (result.transition === 'demote') demoted++;
    }

    this.emit('rebuild:completed', { promoted, demoted, evicted, total: allFacets.length });
  }

  getActiveProfile(namespace = 'global') {
    if (!this._store) return {};

    const facets = this._store.getActiveFacets(namespace);
    const profile = {};

    for (const f of facets) {
      const cls = f.facet_class;
      if (!profile[cls]) profile[cls] = [];
      profile[cls].push({
        key: f.key,
        value: f.value,
        state: f.state,
        stability: f.stability_score,
        evidence: f.evidence_count,
      });
    }

    return profile;
  }

  renderProfileMarkdown(namespace = 'global') {
    if (!this._store) return '';
    return this._store.renderFacetsAsMarkdown(namespace);
  }

  _upgradeCueFamily(current, newCue) {
    const order = [CUE_FAMILIES.HEURISTIC, CUE_FAMILIES.BEHAVIORAL, CUE_FAMILIES.EXPLICIT];
    const currentIdx = order.indexOf(current);
    const newIdx = order.indexOf(newCue);
    return newIdx > currentIdx ? newCue : current;
  }
}

module.exports = {
  StabilityDetector,
  LearningCandidate,
  FACET_CLASSES,
  FACET_CLASS_META,
  CUE_FAMILIES,
  CUE_WEIGHTS,
  FACET_STATES,
  TRANSITIONS,
  TAU_PROMOTE,
  TAU_PROVISIONAL,
  TAU_EVICT,
  TAU_DROP,
};
