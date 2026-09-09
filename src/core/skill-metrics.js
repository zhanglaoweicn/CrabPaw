/**
 * @deprecated 此模块已废弃，请使用 core/skill/skill-evolver.js 替代
 *
 * 迁移映射：
 *   SkillEvolution    → SkillEvolver (core/skill/skill-evolver.js)
 *   TrajectoryRecorder → ExecutionAnalyzer (core/skill/execution-analyzer.js)
 *   SkillScorer       → SkillQualityTracker (core/skill/skill-quality-tracker.js)
 *   SkillOptimizer    → FeedbackLoopEngine (core/skill/feedback-loop-engine.js)
 *
 * 本文件保留仅为向后兼容，新代码请勿引用
 */

const fs = require('fs');
const path = require('path');

// eslint-disable-next-line no-unused-vars -- require 解构的 SKILLS_DIR 暂未使用（本文件仅作向后兼容）
const { SKILLS_DIR, DATA_DIR } = require('./config');
const { SkillScoringSystem } = require('./skill-scoring');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const TRAJECTORY_FILE = path.join(DATA_DIR, 'skill-trajectory.json');
const SCORES_FILE = path.join(DATA_DIR, 'skill-scores.json');
const PATTERNS_FILE = path.join(DATA_DIR, 'skill-patterns.json');

class TrajectoryRecorder {
  constructor() {
    this.trajectory = this.loadTrajectory();
  }

  loadTrajectory() {
    try {
      if (fs.existsSync(TRAJECTORY_FILE)) {
        return JSON.parse(fs.readFileSync(TRAJECTORY_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('加载轨迹记录失败:', e.message);
    }
    return { events: [], skillUsage: {}, successPatterns: [] };
  }

  saveTrajectory() {
    try {
      const dir = path.dirname(TRAJECTORY_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TRAJECTORY_FILE, JSON.stringify(this.trajectory, null, 2), 'utf-8');
    } catch (e) {
      console.error('保存轨迹记录失败:', e.message);
    }
  }

  recordSkillCall(skillName, params, context, result) {
    const event = {
      timestamp: Date.now(),
      skillName,
      params: params || {},
      context: this.sanitizeContext(context),
      success: result?.success !== false,
      duration: result?.duration || 0,
      outputLength: result?.output?.length || 0,
      error: result?.error || null
    };

    this.trajectory.events.push(event);

    if (!this.trajectory.skillUsage[skillName]) {
      this.trajectory.skillUsage[skillName] = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalDuration: 0,
        lastUsed: null,
        avgDuration: 0
      };
    }

    const usage = this.trajectory.skillUsage[skillName];
    usage.calls++;
    usage.totalDuration += event.duration;
    usage.avgDuration = usage.totalDuration / usage.calls;
    usage.lastUsed = event.timestamp;

    if (event.success) {
      usage.successes++;
      this.recordSuccessPattern(skillName, params, context);
    } else {
      usage.failures++;
    }

    this.saveTrajectory();
    return event;
  }

  sanitizeContext(context) {
    if (!context) return {};
    const sanitized = {};
    const allowed = ['message', 'taskType', 'userId', 'timeOfDay'];
    for (const key of allowed) {
      if (context[key]) sanitized[key] = String(context[key]).substring(0, 100);
    }
    return sanitized;
  }

  recordSuccessPattern(skillName, params, context) {
    const pattern = {
      skillName,
      params: params || {},
      context: this.sanitizeContext(context),
      successRate: this.getSkillSuccessRate(skillName),
      timestamp: Date.now()
    };

    const existing = this.trajectory.successPatterns.findIndex(
      p => p.skillName === skillName && JSON.stringify(p.params) === JSON.stringify(params)
    );

    if (existing >= 0) {
      this.trajectory.successPatterns[existing] = pattern;
    } else {
      this.trajectory.successPatterns.push(pattern);
      if (this.trajectory.successPatterns.length > 100) {
        this.trajectory.successPatterns = this.trajectory.successPatterns.slice(-100);
      }
    }
  }

  getSkillSuccessRate(skillName) {
    const usage = this.trajectory.skillUsage[skillName];
    if (!usage || usage.calls === 0) return 0;
    return usage.successes / usage.calls;
  }

  getSkillStats(skillName) {
    return this.trajectory.skillUsage[skillName] || {
      calls: 0,
      successes: 0,
      failures: 0,
      avgDuration: 0,
      lastUsed: null
    };
  }

  getTopSkills(limit = 10) {
    return Object.entries(this.trajectory.skillUsage)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);
  }

  getRecommendedSkills(context) {
    // eslint-disable-next-line no-unused-vars -- message 结果未消费（含 .toLowerCase() 调用，保留原式计算意图）
    const message = (context?.message || '').toLowerCase();
    const recommendations = [];

    for (const [skillName, stats] of Object.entries(this.trajectory.skillUsage)) {
      const successRate = stats.successes / (stats.calls || 1);
      const recency = stats.lastUsed ? (Date.now() - stats.lastUsed) / (7 * 24 * 60 * 60 * 1000) : 999;
      const score = successRate * 0.6 + Math.max(0, 1 - recency) * 0.4;

      recommendations.push({
        skillName,
        score,
        successRate,
        calls: stats.calls,
        avgDuration: stats.avgDuration
      });
    }

    return recommendations
      .filter(r => r.successRate >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  exportTrajectory() {
    return this.trajectory;
  }
}

class SkillScorer {
  constructor(trajectory) {
    this.trajectory = trajectory;
    this.scores = this.loadScores();
    this._unifiedScorer = new SkillScoringSystem();
  }

  loadScores() {
    try {
      if (fs.existsSync(SCORES_FILE)) {
        return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('加载技能评分失败:', e.message);
    }
    return { skills: {}, evolutionHistory: [] };
  }

  saveScores() {
    try {
      const dir = path.dirname(SCORES_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(SCORES_FILE, JSON.stringify(this.scores, null, 2), 'utf-8');
    } catch (e) {
      console.error('保存技能评分失败:', e.message);
    }
  }

  scoreSkill(skillName) {
    const stats = this.trajectory.getSkillStats(skillName);
    const patterns = this.trajectory.trajectory.successPatterns.filter(p => p.skillName === skillName);

    const successRate = stats.calls > 0 ? stats.successes / stats.calls : 0;
    const usageScore = Math.min(stats.calls / 50, 1);
    const recencyScore = stats.lastUsed ? Math.exp(-(Date.now() - stats.lastUsed) / (30 * 24 * 60 * 60 * 1000)) : 0;
    const speedScore = stats.avgDuration > 0 ? Math.max(0, 1 - stats.avgDuration / 60000) : 0.5;

    let unifiedScore = null;
    try {
      unifiedScore = this._unifiedScorer.calculateSkillScore(skillName, {
        successRate,
        usageCount: stats.calls,
        avgDuration: stats.avgDuration,
      });
    } catch (e) {
      /* 忽略错误 */
      console.warn('[skill-metrics.js] 空 catch 补日志:', e && e.message);
    }


    const baseScore = unifiedScore
      ? unifiedScore.overall
      : (
          successRate * 0.35 +
          usageScore * 0.20 +
          recencyScore * 0.15 +
          speedScore * 0.10 +
          patterns.length * 0.20
        );

    const confidence = Math.min(stats.calls / 20, 1);

    const score = {
      overall: Math.round(baseScore * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      breakdown: {
        successRate: Math.round(successRate * 100) / 100,
        usageScore: Math.round(usageScore * 100) / 100,
        recencyScore: Math.round(recencyScore * 100) / 100,
        speedScore: Math.round(speedScore * 100) / 100,
        patternCount: patterns.length
      },
      lastUpdated: Date.now()
    };

    this.scores.skills[skillName] = score;
    this.saveScores();

    return score;
  }

  getScore(skillName) {
    return this.scores.skills[skillName] || { overall: 0, confidence: 0, breakdown: {} };
  }

  getLeaderboard() {
    const skills = Object.keys(this.scores.skills);
    if (skills.length === 0) return [];

    return skills
      .map(name => ({
        name,
        ...this.getScore(name)
      }))
      .sort((a, b) => b.overall - a.overall);
  }

  recordEvolution(skillName, oldScore, newScore, reason) {
    this.scores.evolutionHistory.push({
      skillName,
      oldScore,
      newScore,
      reason,
      timestamp: Date.now()
    });

    if (this.scores.evolutionHistory.length > 200) {
      this.scores.evolutionHistory = this.scores.evolutionHistory.slice(-200);
    }

    this.saveScores();
  }
}

class SkillOptimizer {
  constructor(trajectory, scorer) {
    this.trajectory = trajectory;
    this.scorer = scorer;
    this.patterns = this.loadPatterns();
  }

  loadPatterns() {
    try {
      if (fs.existsSync(PATTERNS_FILE)) {
        return JSON.parse(fs.readFileSync(PATTERNS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('加载优化模式失败:', e.message);
    }
    return { optimizations: [], suggestions: [] };
  }

  savePatterns() {
    try {
      const dir = path.dirname(PATTERNS_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(PATTERNS_FILE, JSON.stringify(this.patterns, null, 2), 'utf-8');
    } catch (e) {
      console.error('保存优化模式失败:', e.message);
    }
  }

  analyzeForOptimization(skillName) {
    const stats = this.trajectory.getSkillStats(skillName);
    const score = this.scorer.getScore(skillName);
    const suggestions = [];

    if (stats.calls < 5) {
      suggestions.push({
        type: 'insufficient_data',
        priority: 'low',
        message: `技能 ${skillName} 调用次数不足 (${stats.calls})，需要更多使用数据`
      });
    }

    if (stats.avgDuration > 30000 && stats.calls > 3) {
      suggestions.push({
        type: 'slow_performance',
        priority: 'medium',
        message: `技能 ${skillName} 平均执行时间过长 (${Math.round(stats.avgDuration / 1000)}s)，建议优化`
      });
    }

    const successRate = stats.calls > 0 ? stats.successes / stats.calls : 0;
    if (successRate < 0.5 && stats.calls >= 5) {
      suggestions.push({
        type: 'low_success_rate',
        priority: 'high',
        message: `技能 ${skillName} 成功率较低 (${Math.round(successRate * 100)}%)，建议检查参数或提示词`
      });
    }

    if (score.confidence > 0.7 && score.overall < 0.6) {
      suggestions.push({
        type: 'potential_deprecation',
        priority: 'medium',
        message: `技能 ${skillName} 评分持续偏低，可能需要重构或停用`
      });
    }

    return {
      skillName,
      stats,
      score,
      suggestions,
      readyForEvolution: suggestions.filter(s => s.priority === 'high').length === 0 && stats.calls >= 10
    };
  }

  getOptimizationSuggestions() {
    const allSkills = Object.keys(this.trajectory.trajectory.skillUsage);
    const suggestions = [];

    for (const skillName of allSkills) {
      const analysis = this.analyzeForOptimization(skillName);
      suggestions.push(...analysis.suggestions.map(s => ({ ...s, skillName })));
    }

    return suggestions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  recordOptimization(skillName, optimization) {
    this.patterns.optimizations.push({
      skillName,
      ...optimization,
      timestamp: Date.now()
    });

    if (this.patterns.optimizations.length > 100) {
      this.patterns.optimizations = this.patterns.optimizations.slice(-100);
    }

    this.savePatterns();
  }
}

class SkillEvolution {
  constructor() {
    this.trajectory = new TrajectoryRecorder();
    this.scorer = new SkillScorer(this.trajectory);
    this.optimizer = new SkillOptimizer(this.trajectory, this.scorer);
  }

  record(skillName, params, context, result) {
    return this.trajectory.recordSkillCall(skillName, params, context, result);
  }

  score(skillName) {
    return this.scorer.scoreSkill(skillName);
  }

  getScore(skillName) {
    return this.scorer.getScore(skillName);
  }

  getLeaderboard() {
    return this.scorer.getLeaderboard();
  }

  getRecommendations(context) {
    return this.trajectory.getRecommendedSkills(context);
  }

  analyze(skillName) {
    return this.optimizer.analyzeForOptimization(skillName);
  }

  getSuggestions() {
    return this.optimizer.getOptimizationSuggestions();
  }

  getStats() {
    return {
      totalEvents: this.trajectory.trajectory.events.length,
      trackedSkills: Object.keys(this.trajectory.trajectory.skillUsage).length,
      topSkills: this.trajectory.getTopSkills(5),
      scoreLeaderboard: this.scorer.getLeaderboard().slice(0, 5),
      suggestions: this.optimizer.getOptimizationSuggestions().slice(0, 5)
    };
  }

  export() {
    return {
      trajectory: this.trajectory.exportTrajectory(),
      scores: this.scorer.scores,
      patterns: this.patterns,
      stats: this.getStats()
    };
  }
}

let evolutionInstance = null;

function getSkillEvolution() {
  if (!evolutionInstance) {
    evolutionInstance = new SkillEvolution();
  }
  return evolutionInstance;
}

class SkillSnapshot {
  constructor(skills, prompt, limits) {
    this.skills = skills.map(s => ({
      name: s.name,
      description: s.description || '',
      filePath: s.filePath || '',
      baseDir: s.baseDir || '',
      source: s.source || 'workspace',
      exposure: s.exposure || {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
      invocation: s.invocation || { disableModelInvocation: false },
    }));
    this.prompt = prompt || '';
    this.limits = limits || {};
    this.createdAt = Date.now();
    this.skillCount = this.skills.length;
  }

  static fromJSON(data) {
    if (!data) return null;
    const snapshot = Object.create(SkillSnapshot.prototype);
    Object.assign(snapshot, data);
    return snapshot;
  }

  toJSON() {
    return {
      skills: this.skills,
      prompt: this.prompt,
      limits: this.limits,
      createdAt: this.createdAt,
      skillCount: this.skillCount,
    };
  }
}

class SkillVisibilityPolicy {
  constructor() {
    this._hiddenSkills = new Set();
    this._disabledSkills = new Set();
    this._ownerOnlySkills = new Set();
  }

  applyVisibility(skills, context) {
    const senderIsOwner = context?.senderIsOwner ?? true;
    const skillFilter = context?.skillFilter || null;

    let filtered = skills.filter(skill => {
      if (this._hiddenSkills.has(skill.name)) return false;
      if (this._disabledSkills.has(skill.name)) return false;
      if (skill.invocation?.disableModelInvocation) return false;
      if (skill.exposure?.includeInAvailableSkillsPrompt === false) return false;
      return true;
    });

    if (skillFilter && Array.isArray(skillFilter) && skillFilter.length > 0) {
      const normalized = skillFilter.map(n => n.toLowerCase());
      filtered = filtered.filter(s => normalized.includes(s.name.toLowerCase()));
    }

    if (!senderIsOwner) {
      filtered = filtered.filter(s => {
        if (this._ownerOnlySkills.has(s.name)) return false;
        if (s.ownerOnly) return false;
        return true;
      });
    }

    return filtered;
  }

  hideSkill(name) { this._hiddenSkills.add(name); }
  showSkill(name) { this._hiddenSkills.delete(name); }
  disableSkill(name) { this._disabledSkills.add(name); }
  enableSkill(name) { this._disabledSkills.delete(name); }
  setOwnerOnly(name) { this._ownerOnlySkills.add(name); }
  unsetOwnerOnly(name) { this._ownerOnlySkills.delete(name); }
}

class SkillFilterPipeline {
  constructor() {
    this._filters = [];
  }

  addFilter(filterFn) {
    if (typeof filterFn === 'function') {
      this._filters.push(filterFn);
    }
    return this;
  }

  apply(skills, context) {
    let result = skills;
    for (const filter of this._filters) {
      result = filter(result, context);
      if (!Array.isArray(result)) return [];
    }
    return result;
  }

  reset() {
    this._filters = [];
  }
}

module.exports = {
  SkillEvolution,
  TrajectoryRecorder,
  SkillScorer,
  SkillOptimizer,
  getSkillEvolution,
  SkillSnapshot,
  SkillVisibilityPolicy,
  SkillFilterPipeline,
};