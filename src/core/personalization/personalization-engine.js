/**
 * Personalization Engine — extracts and applies user preferences
 *
 * Inspired by OpenHarness personalization/: extractor + rules + session_hook.
 * Extracts: language, tone, formatting style, verbosity, tool preferences
 * from user messages and conversation history. Feeds into system prompt.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Extraction rules: [field, pattern, extractFn]
const EXTRACTION_RULES = [
  {
    field: 'language',
    patterns: [/用中文|中文回答|简体中文|Chinese/i],
    extract: () => 'zh-CN',
  },
  {
    field: 'language',
    patterns: [/in english|english please/i],
    extract: () => 'en',
  },
  {
    field: 'tone',
    patterns: [/简洁|简短|brief|concise|succinct/i],
    extract: () => 'concise',
  },
  {
    field: 'tone',
    patterns: [/详细|detailed|comprehensive|thorough/i],
    extract: () => 'comprehensive',
  },
  {
    field: 'format',
    patterns: [/markdown|md格式|用markdown/i],
    extract: () => 'markdown',
  },
  {
    field: 'format',
    patterns: [/表格|table format|tabular/i],
    extract: () => 'tabular',
  },
  {
    field: 'verbosity',
    patterns: [/一句话|one sentence|短一点|short/i],
    extract: () => 'minimal',
  },
  {
    field: 'verbosity',
    patterns: [/详细点|more detail|elaborate/i],
    extract: () => 'verbose',
  },
  {
    field: 'codeStyle',
    patterns: [/ES6|import.*from/i],
    extract: () => 'esm',
  },
  {
    field: 'codeStyle',
    patterns: [/require|commonjs/i],
    extract: () => 'cjs',
  },
];

const DEFAULT_PROFILE = {
  language: null,
  tone: null,
  format: null,
  verbosity: null,
  codeStyle: null,
  preferredTools: [],
  expertise: [],
  name: null,
  lastUpdated: null,
};

class PersonalizationEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._profile = { ...DEFAULT_PROFILE, ...opts.initialProfile };
    this._history = [];
    this._maxHistoryLength = 200;
    this._storePath = opts.storePath || path.join(opts.dataDir || '.', 'personalization.json');
    this._sessionCount = 0;
    this.setMaxListeners(20);
    this._load();
  }

  /**
   * Analyze a user message and update profile.
   * Returns extracted preferences.
   */
  // eslint-disable-next-line no-unused-vars
  analyze(userMessage, opts = {}) {
    if (!userMessage) return {};
    const extracted = {};

    for (const rule of EXTRACTION_RULES) {
      for (const pat of rule.patterns) {
        if (pat.test(userMessage)) {
          extracted[rule.field] = rule.extract(userMessage);
          break;
        }
      }
    }

    if (Object.keys(extracted).length > 0) {
      this._profile = { ...this._profile, ...extracted, lastUpdated: new Date().toISOString() };
      this._history.push({ time: new Date().toISOString(), source: 'message', extracted });
      if (this._history.length > this._maxHistoryLength) this._history.shift();

      this.emit('profile_updated', { field: Object.keys(extracted), profile: this._profile });
      this._save();
    }

    return extracted;
  }

  /**
   * Analyze conversation turn (message + response) for implicit preferences.
   */
  analyzeTurn(userMessage, assistantResponse) {
    const implicit = {};
    // Detect if user accepted/continued with a certain style
    if (assistantResponse && assistantResponse.includes('```') && userMessage && !userMessage.includes('no code')) {
      implicit.preferredTools = ['code_execution'];
    }
    if (userMessage && /^(好的|ok|继续|go on|yes)/i.test(userMessage.trim())) {
      implicit.continuationApproval = true;
    }

    if (Object.keys(implicit).length > 0) {
      this._profile = {
        ...this._profile,
        preferredTools: [...new Set([...this._profile.preferredTools, ...(implicit.preferredTools || [])])],
        lastUpdated: new Date().toISOString(),
      };
      this.emit('implicit_preference', implicit);
      this._save();
    }
    return implicit;
  }

  /**
   * Generate a personalization prompt fragment for the system prompt.
   */
  toPromptFragment() {
    const p = this._profile;
    const lines = [];

    if (p.name) lines.push(`### User Profile\nName: ${p.name}`);
    if (p.language) lines.push(`Language: ${p.language}`);
    if (p.tone) lines.push(`Tone: ${p.tone}`);
    if (p.format) lines.push(`Format: ${p.format}`);
    if (p.verbosity) lines.push(`Verbosity: ${p.verbosity}`);
    if (p.codeStyle) lines.push(`Code style: ${p.codeStyle}`);
    if (p.preferredTools.length > 0) lines.push(`Preferred tools: ${p.preferredTools.join(', ')}`);

    if (lines.length === 0) return '';

    // Add guidance
    if (p.tone === 'concise') lines.push('Keep responses brief and direct.');
    if (p.tone === 'comprehensive') lines.push('Provide thorough explanations with examples.');
    if (p.verbosity === 'minimal') lines.push('Use minimal words. Prefer one-line answers.');
    if (p.format === 'markdown') lines.push('Use Markdown formatting when appropriate.');

    return lines.join('\n');
  }

  /**
   * Set user identity explicitly.
   */
  setIdentity(name, opts = {}) {
    this._profile.name = name;
    this._profile.expertise = opts.expertise || [];
    this._profile.lastUpdated = new Date().toISOString();
    this._save();
    this.emit('identity_set', { name, expertise: this._profile.expertise });
  }

  /**
   * Record session interaction for long-term learning.
   */
  recordSession(sessionData) {
    this._sessionCount++;
    this._history.push({
      time: new Date().toISOString(),
      source: 'session',
      data: sessionData,
    });
    if (this._history.length > this._maxHistoryLength) this._history.shift();
    this._save();
  }

  getProfile() { return { ...this._profile }; }
  getHistory(limit) { return this._history.slice(-(limit || 20)); }
  getSessionCount() { return this._sessionCount; }

  reset() {
    this._profile = { ...DEFAULT_PROFILE };
    this._history = [];
    this._save();
  }

  _save() {
    try {
      const dir = path.dirname(this._storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._storePath, JSON.stringify({
        profile: this._profile,
        sessionCount: this._sessionCount,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) {
      console.warn('[personalization] Failed to save profile:', e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(this._storePath)) {
        const data = JSON.parse(fs.readFileSync(this._storePath, 'utf8'));
        if (data.profile) this._profile = { ...DEFAULT_PROFILE, ...data.profile };
        if (data.sessionCount) this._sessionCount = data.sessionCount;
      }
    } catch (e) {
      console.warn('[personalization] Failed to load profile:', e.message);
    }
  }
}

let _globalEngine = null;
function getPersonalizationEngine(opts) {
  if (!_globalEngine) {
    _globalEngine = new PersonalizationEngine(opts);
  }
  return _globalEngine;
}

module.exports = { PersonalizationEngine, getPersonalizationEngine, EXTRACTION_RULES, DEFAULT_PROFILE };
