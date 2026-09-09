const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./config');
const { createCacheStats } = require('./caching/cache-stats');

const CACHE_DIR = path.join(DATA_DIR, 'personalization');
const PROFILE_FILE = path.join(CACHE_DIR, 'profile.json');
const CANDIDATES_FILE = path.join(CACHE_DIR, 'candidates.json');
const REFLECTION_FILE = path.join(CACHE_DIR, 'reflections.json');

const MAX_PROFILE_FACETS = 30;
const MAX_CANDIDATES = 50;
const MAX_REFLECTIONS = 20;
const CANDIDATE_PROMOTION_THRESHOLD = 5;
const FACET_DECAY_FACTOR = 0.95;
const FACET_DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;

class PersonalizationCache extends EventEmitter {
  // eslint-disable-next-line no-unused-vars
  constructor(config = {}) {
    super();
    this._profile = this._loadProfile();
    this._candidates = this._loadCandidates();
    this._reflections = this._loadReflections();
    this._lastDecay = Date.now();
    this._stats = createCacheStats('personalization');
  }

  getProfile() {
    this._stats.hit();
    return { ...this._profile };
  }

  getCandidates() {
    this._stats.hit();
    return [...this._candidates];
  }

  getReflections() {
    this._stats.hit();
    return [...this._reflections];
  }

  recordInteraction(context = {}) {
    this._applyDecay();

    const facets = this._extractInteractionFacets(context);

    for (const facet of facets) {
      this._addCandidate(facet);
    }

    if (context.outcome) {
      this._updateOutcomeFacets(context.outcome);
    }

    this._checkPromotions();
    this._saveAll();

    this.emit('interaction_recorded', { facets, candidateCount: this._candidates.length });
  }

  runReflection(interactionHistory = []) {
    if (!interactionHistory || interactionHistory.length === 0) return null;

    const recentInteractions = interactionHistory.slice(-20);
    const patterns = this._detectPatterns(recentInteractions);

    const reflection = {
      id: `ref_${Date.now()}`,
      timestamp: new Date().toISOString(),
      patterns,
      facetSnapshot: this._profile.facets.slice(0, 10),
      candidateSnapshot: this._candidates.slice(0, 5),
      insights: this._generateReflectionInsights(patterns),
    };

    this._reflections.push(reflection);
    if (this._reflections.length > MAX_REFLECTIONS) {
      this._reflections = this._reflections.slice(-MAX_REFLECTIONS);
    }

    this._applyReflectionToProfile(reflection);
    this._saveAll();

    this.emit('reflection_completed', reflection);
    return reflection;
  }

  getPersonalizationContext() {
    // 如果没有任何画像数据，记- ?miss；否则记- ?hit
    if (!this._profile.facets || this._profile.facets.length === 0) {
      this._stats.miss();
    } else {
      this._stats.hit();
    }

    const topFacets = this._profile.facets
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    const recentReflections = this._reflections.slice(-3);

    return {
      facets: topFacets,
      preferences: this._profile.preferences || {},
      recentInsights: recentReflections.flatMap(r => r.insights || []),
      stability: this._computeOverallStability(),
    };
  }

  setPreference(key, value) {
    if (!this._profile.preferences) {
      this._profile.preferences = {};
    }
    this._profile.preferences[key] = value;
    this._saveAll();
    this.emit('preference_set', { key, value });
  }

  getPreference(key, defaultValue = null) {
    return this._profile.preferences?.[key] ?? defaultValue;
  }

  _extractInteractionFacets(context) {
    const facets = [];

    if (context.skillUsed) facets.push(`skill:${context.skillUsed}`);
    if (context.taskType) facets.push(`task:${context.taskType}`);
    if (context.domain) facets.push(`domain:${context.domain}`);
    if (context.complexity) facets.push(`complexity:${context.complexity}`);
    if (context.model) facets.push(`model:${context.model}`);
    if (context.tools) {
      for (const tool of context.tools) {
        facets.push(`tool:${tool}`);
      }
    }
    if (context.errorType) facets.push(`error:${context.errorType}`);
    if (context.duration) {
      const bucket = context.duration < 5000 ? 'fast' : context.duration < 30000 ? 'medium' : 'slow';
      facets.push(`speed:${bucket}`);
    }

    return facets;
  }

  _addCandidate(facetName) {
    const existing = this._candidates.find(c => c.name === facetName);
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = new Date().toISOString();
    } else if (this._candidates.length < MAX_CANDIDATES) {
      this._candidates.push({
        name: facetName,
        occurrences: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      });
    }
  }

  _checkPromotions() {
    const toPromote = this._candidates.filter(
      c => c.occurrences >= CANDIDATE_PROMOTION_THRESHOLD
    );

    for (const candidate of toPromote) {
      const existingFacet = this._profile.facets.find(f => f.name === candidate.name);
      if (existingFacet) {
        existingFacet.score = Math.min(1, existingFacet.score + 0.1);
        existingFacet.lastReinforced = new Date().toISOString();
      } else if (this._profile.facets.length < MAX_PROFILE_FACETS) {
        this._profile.facets.push({
          name: candidate.name,
          score: 0.5,
          firstSeen: candidate.firstSeen,
          lastReinforced: new Date().toISOString(),
          promotedAt: new Date().toISOString(),
        });
      }
      this._candidates = this._candidates.filter(c => c.name !== candidate.name);
    }
  }

  _updateOutcomeFacets(outcome) {
    if (!outcome.success) {
      const errorFacet = this._profile.facets.find(f => f.name === `error:${outcome.errorType}`);
      if (errorFacet) {
        errorFacet.score = Math.max(0.1, errorFacet.score - 0.05);
      }
    } else {
      const skillFacet = this._profile.facets.find(f => f.name === `skill:${outcome.skill}`);
      if (skillFacet) {
        skillFacet.score = Math.min(1, skillFacet.score + 0.05);
      }
    }
  }

  _applyDecay() {
    const now = Date.now();
    if (now - this._lastDecay < FACET_DECAY_INTERVAL_MS) return;

    for (const facet of this._profile.facets) {
      facet.score *= FACET_DECAY_FACTOR;
    }

    this._profile.facets = this._profile.facets.filter(f => f.score > 0.05);
    this._lastDecay = now;
  }

  _detectPatterns(interactions) {
    const patterns = [];
    const skillSequences = [];
    const timeBuckets = {};

    for (let i = 0; i < interactions.length; i++) {
      const interaction = interactions[i];

      if (interaction.skillUsed) {
        skillSequences.push(interaction.skillUsed);
      }

      if (interaction.timestamp) {
        const hour = new Date(interaction.timestamp).getHours();
        const period = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
        timeBuckets[period] = (timeBuckets[period] || 0) + 1;
      }
    }

    if (skillSequences.length >= 2) {
      const pairs = {};
      for (let i = 1; i < skillSequences.length; i++) {
        const pair = `${skillSequences[i - 1]}- ?{skillSequences[i]}`;
        pairs[pair] = (pairs[pair] || 0) + 1;
      }
      for (const [pair, count] of Object.entries(pairs)) {
        if (count >= 2) {
          patterns.push({ type: 'skill_sequence', pattern: pair, count });
        }
      }
    }

    const peakPeriod = Object.entries(timeBuckets).sort((a, b) => b[1] - a[1])[0];
    if (peakPeriod) {
      patterns.push({ type: 'time_preference', pattern: peakPeriod[0], count: peakPeriod[1] });
    }

    return patterns;
  }

  _generateReflectionInsights(patterns) {
    const insights = [];

    for (const pattern of patterns) {
      if (pattern.type === 'skill_sequence') {
        insights.push(`Frequent skill chain detected: ${pattern.pattern} (${pattern.count} times)`);
      } else if (pattern.type === 'time_preference') {
        insights.push(`Peak activity during ${pattern.pattern} (${pattern.count} interactions)`);
      }
    }

    const topFacets = this._profile.facets.sort((a, b) => b.score - a.score).slice(0, 3);
    for (const facet of topFacets) {
      insights.push(`Strong preference: ${facet.name} (score: ${facet.score.toFixed(2)})`);
    }

    return insights;
  }

  _applyReflectionToProfile(reflection) {
    for (const pattern of reflection.patterns) {
      if (pattern.type === 'skill_sequence') {
        const [from, to] = pattern.pattern.split('->');
        this.setPreference(`chain:${from}`, to);
      } else if (pattern.type === 'time_preference') {
        this.setPreference('peak_time', pattern.pattern);
      }
    }
  }

  _computeOverallStability() {
    if (this._profile.facets.length === 0) return 0;
    const avgScore = this._profile.facets.reduce((sum, f) => sum + f.score, 0) / this._profile.facets.length;
    const facetCount = Math.min(1, this._profile.facets.length / 10);
    return avgScore * 0.7 + facetCount * 0.3;
  }

  _loadProfile() {
    try {
      if (fs.existsSync(PROFILE_FILE)) {
        return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf-8'));
      }
    } catch { console.warn('[personalization-cache] silent catch, error swallowed'); }
    return { facets: [], preferences: {}, createdAt: new Date().toISOString() };
  }

  _loadCandidates() {
    try {
      if (fs.existsSync(CANDIDATES_FILE)) {
        return JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf-8'));
      }
    } catch { console.warn('[personalization-cache] silent catch, error swallowed'); }
    return [];
  }

  _loadReflections() {
    try {
      if (fs.existsSync(REFLECTION_FILE)) {
        return JSON.parse(fs.readFileSync(REFLECTION_FILE, 'utf-8'));
      }
    } catch { console.warn('[personalization-cache] silent catch, error swallowed'); }
    return [];
  }

  _saveAll() {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    try {
      const tmpP = PROFILE_FILE + '.tmp.' + Date.now();
      fs.writeFileSync(tmpP, JSON.stringify(this._profile, null, 2), 'utf-8');
      fs.renameSync(tmpP, PROFILE_FILE);
    } catch { console.warn('[personalization-cache] silent catch, error swallowed'); }
    try {
      const tmpC = CANDIDATES_FILE + '.tmp.' + Date.now();
      fs.writeFileSync(tmpC, JSON.stringify(this._candidates, null, 2), 'utf-8');
      fs.renameSync(tmpC, CANDIDATES_FILE);
    } catch { console.warn('[personalization-cache] silent catch, error swallowed'); }
    try {
      const tmpR = REFLECTION_FILE + '.tmp.' + Date.now();
      fs.writeFileSync(tmpR, JSON.stringify(this._reflections, null, 2), 'utf-8');
      fs.renameSync(tmpR, REFLECTION_FILE);
    } catch { console.warn('[personalization-cache] silent catch, error swallowed'); }
  }

  getStats() {
    return this._stats.getStats({
      profileFacets: this._profile.facets?.length || 0,
      candidatesCount: this._candidates.length,
      reflectionsCount: this._reflections.length,
    });
  }

  resetStats() {
    this._stats.resetStats();
  }
}

let _instance = null;

function getPersonalizationCache(config) {
  if (!_instance) {
    _instance = new PersonalizationCache(config);
  }
  return _instance;
}

module.exports = { PersonalizationCache, getPersonalizationCache };
