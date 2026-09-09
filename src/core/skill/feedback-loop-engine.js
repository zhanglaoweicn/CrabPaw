/**
 * FeedbackLoopEngine - Skill feedback loop & auto-improvement engine
 * Provides continuous learning from skill execution results.
 *
 * Features:
 * - Records and analyzes execution feedback
 * - Detects performance degradation patterns
 * - Persists feedback data to JSON file
 * - Emits events via EventBus for other subsystems
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const LOOP_STATE = {
  IDLE: "idle",
  COLLECTING: "collecting",
  ANALYZING: "analyzing",
  APPLYING: "applying",
  REVIEWING: "reviewing",
};

const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback-loop', 'feedback.json');
const DEGRADATION_THRESHOLD = 0.15; // 15% decline triggers degradation detection
const MIN_ENTRIES_FOR_ANALYSIS = 5;

class FeedbackLoopEngine {
  constructor(config = {}) {
    this.config = config;
    this.state = LOOP_STATE.IDLE;
    this.feedbackEntries = [];
    this.loopCount = 0;
    this._feedbackPath = config.feedbackPath || FEEDBACK_FILE;
    this._load();
  }

  async initialize() {
    this.state = LOOP_STATE.IDLE;
    this._load();
    return this;
  }

  recordFeedback(executionResult) {
    const entry = {
      timestamp: Date.now(),
      ...executionResult,
    };
    this.feedbackEntries.push(entry);
    this._save();
    this._emitEvent('feedback:recorded', entry);
    return this;
  }

  /**
   * Basic analysis of feedback entries:
   * - Count patterns in success/failure by skill
   * - Detect degradation (recent success rate vs historical)
   * - Identify most error-prone skills
   */
  analyzeFeedback(options = {}) {
    const since = options.since || 0;
    const relevant = since > 0
      ? this.feedbackEntries.filter(e => e.timestamp >= since)
      : this.feedbackEntries;

    if (relevant.length < MIN_ENTRIES_FOR_ANALYSIS) {
      return { analyzed: false, reason: 'insufficient data', count: relevant.length };
    }

    // Group by skill name
    const bySkill = {};
    for (const entry of relevant) {
      const skill = entry.skillName || entry.skillId || 'unknown';
      if (!bySkill[skill]) {
        bySkill[skill] = { total: 0, success: 0, failures: 0, errors: [], executionTimes: [] };
      }
      bySkill[skill].total++;
      if (entry.success || entry.passed) {
        bySkill[skill].success++;
      } else {
        bySkill[skill].failures++;
        if (entry.error) bySkill[skill].errors.push(entry.error);
      }
      if (entry.executionTimeMs || entry.executionTime) {
        bySkill[skill].executionTimes.push(entry.executionTimeMs || entry.executionTime);
      }
    }

    // Calculate stats per skill
    const skillStats = {};
    for (const [skill, stats] of Object.entries(bySkill)) {
      const avgTime = stats.executionTimes.length > 0
        ? stats.executionTimes.reduce((a, b) => a + b, 0) / stats.executionTimes.length
        : 0;
      skillStats[skill] = {
        total: stats.total,
        successRate: stats.total > 0 ? stats.success / stats.total : 0,
        failureCount: stats.failures,
        commonErrors: this._topErrors(stats.errors, 3),
        avgExecutionTimeMs: Math.round(avgTime),
      };
    }

    // Detect degradation: compare recent half vs older half
    const degradation = this._detectDegradation(relevant);

    const analysis = {
      analyzed: true,
      totalEntries: relevant.length,
      timeRange: {
        from: relevant[0]?.timestamp,
        to: relevant[relevant.length - 1]?.timestamp,
      },
      bySkill: skillStats,
      degradation,
      overallSuccessRate: relevant.length > 0
        ? relevant.filter(e => e.success || e.passed).length / relevant.length
        : 0,
    };

    this._emitEvent('feedback:analyzed', analysis);
    return analysis;
  }

  /**
   * Detect degradation by comparing recent half vs older half of entries
   */
  _detectDegradation(entries) {
    if (entries.length < MIN_ENTRIES_FOR_ANALYSIS * 2) return null;

    const mid = Math.floor(entries.length / 2);
    const older = entries.slice(0, mid);
    const recent = entries.slice(mid);

    const olderSuccess = older.filter(e => e.success || e.passed).length / older.length;
    const recentSuccess = recent.filter(e => e.success || e.passed).length / recent.length;

    const decline = olderSuccess - recentSuccess;
    if (decline > DEGRADATION_THRESHOLD) {
      return {
        detected: true,
        olderSuccessRate: olderSuccess,
        recentSuccessRate: recentSuccess,
        decline: decline,
        olderCount: older.length,
        recentCount: recent.length,
        message: `Success rate declined by ${(decline * 100).toFixed(1)}% (from ${(olderSuccess * 100).toFixed(1)}% to ${(recentSuccess * 100).toFixed(1)}%)`,
      };
    }

    return { detected: false, decline };
  }

  _topErrors(errors, limit) {
    const counts = {};
    for (const err of errors) {
      const key = typeof err === 'string' ? err.slice(0, 120) : String(err);
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([err, count]) => ({ error: err, count }));
  }

  async triggerLoop() {
    this.loopCount++;
    this.state = LOOP_STATE.COLLECTING;
    const analysis = this.analyzeFeedback();
    this.state = LOOP_STATE.ANALYZING;

    const result = {
      loopCount: this.loopCount,
      entries: this.feedbackEntries.length,
      analysis,
    };

    this._emitEvent('feedback:loop', result);
    return result;
  }

  getState() {
    return { state: this.state, loopCount: this.loopCount, entries: this.feedbackEntries.length };
  }

  getFeedbackHistory(options = {}) {
    const { limit = 100, skillName, since } = options;
    let entries = this.feedbackEntries;
    if (skillName) entries = entries.filter(e => (e.skillName || e.skillId) === skillName);
    if (since) entries = entries.filter(e => e.timestamp >= since);
    return entries.slice(-limit);
  }

  async shutdown() {
    this.state = LOOP_STATE.IDLE;
    this._save();
  }

  _load() {
    try {
      if (fs.existsSync(this._feedbackPath)) {
        const raw = fs.readFileSync(this._feedbackPath, 'utf-8');
        const data = JSON.parse(raw);
        this.feedbackEntries = data.entries || [];
        this.loopCount = data.loopCount || 0;
      }
    } catch (e) {
      console.warn('[FeedbackLoopEngine] load failed (first run?):', e.message);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this._feedbackPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: 1,
        loopCount: this.loopCount,
        updatedAt: new Date().toISOString(),
        entries: this.feedbackEntries.slice(-500), // keep last 500
      };
      const tmpFile = this._feedbackPath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this._feedbackPath);
    } catch (e) {
      console.error('[FeedbackLoopEngine] save failed:', e.message);
    }
  }

  _emitEvent(eventType, payload) {
    try {
      const { getEventBus } = require('../events');
      const bus = getEventBus();
      if (bus) {
        bus.publish('feedback', eventType, { engine: 'feedback-loop', ...payload });
      }
    } catch (e) {

      // EventBus not available — non-critical

      console.warn('[feedback-loop-engine.js] 空 catch 补日志:', e && e.message);
    }

  }
}

let _instance = null;
function getFeedbackLoopEngine(config) {
  if (!_instance) {
    _instance = new FeedbackLoopEngine(config);
  }
  return _instance;
}

module.exports = { FeedbackLoopEngine, getFeedbackLoopEngine, LOOP_STATE };
