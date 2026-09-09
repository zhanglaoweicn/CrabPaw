const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { getSkillLifecycleManager } = require('./skill-lifecycle');

const SCORES_FILE = path.join(DATA_DIR, 'skill-scores.json');
const HISTORY_FILE = path.join(DATA_DIR, 'skill-score-history.json');

const SCORING_WEIGHTS = {
  usageFrequency: 0.25,
  successRate: 0.30,
  userFeedback: 0.20,
  executionTime: 0.10,
  errorRate: 0.15
};

const QUALITY_TIERS = {
  EXCELLENT: { min: 0.85, label: '优秀', color: '#22c55e' },
  GOOD: { min: 0.70, label: '良好', color: '#3b82f6' },
  AVERAGE: { min: 0.50, label: '一般', color: '#eab308' },
  POOR: { min: 0.30, label: '较差', color: '#f97316' },
  CRITICAL: { min: 0, label: '需改进', color: '#ef4444' }
};

class SkillScoringSystem {
  constructor(config = {}) {
    this.config = config;
    this.lifecycleManager = getSkillLifecycleManager();
    this.scores = new Map();
    this.history = [];
    this.maxHistorySize = config.maxHistorySize || 1000;
    this.decayFactor = config.decayFactor || 0.95;
    this.minUsageForScoring = config.minUsageForScoring || 3;
    this.lastCalculation = 0;
    this.calculationInterval = config.calculationInterval || 300000;
    
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(SCORES_FILE)) {
        const data = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8'));
        for (const [skill, score] of Object.entries(data)) {
          this.scores.set(skill, score);
        }
      }
      
      if (fs.existsSync(HISTORY_FILE)) {
        this.history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('加载技能评分数据失败:', e.message);
    }
  }

  save() {
    try {
      const dir = path.dirname(SCORES_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const scoresObj = {};
      for (const [skill, score] of this.scores) {
        scoresObj[skill] = score;
      }
      
      fs.writeFileSync(SCORES_FILE, JSON.stringify(scoresObj, null, 2));
      
      const trimmedHistory = this.history.slice(-this.maxHistorySize);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmedHistory, null, 2));
    } catch (e) {
      console.warn('保存技能评分数据失败:', e.message);
    }
  }

  calculateSkillScore(skillName) {
    const detail = this.lifecycleManager.getSkillDetail(skillName);
    
    if (!detail) {
      return this.getDefaultScore();
    }

    const usageCount = detail.usageCount || 0;
    
    if (usageCount < this.minUsageForScoring) {
      return this.getDefaultScore();
    }

    const successRate = this.calculateSuccessRate(detail);
    const frequencyScore = this.calculateFrequencyScore(usageCount);
    const feedbackScore = detail.userFeedback || 0.5;
    const timeScore = this.calculateTimeScore(detail.avgExecutionTime);
    const errorScore = this.calculateErrorScore(detail.errorCount || 0, usageCount);

    const weightedScore = 
      SCORING_WEIGHTS.usageFrequency * frequencyScore +
      SCORING_WEIGHTS.successRate * successRate +
      SCORING_WEIGHTS.userFeedback * feedbackScore +
      SCORING_WEIGHTS.executionTime * timeScore +
      SCORING_WEIGHTS.errorRate * errorScore;

    return Math.max(0, Math.min(1, weightedScore));
  }

  calculateSuccessRate(detail) {
    const usageCount = detail.usageCount || 0;
    const successCount = detail.successCount || 0;
    
    if (usageCount === 0) return 0.5;
    
    return successCount / usageCount;
  }

  calculateFrequencyScore(usageCount) {
    if (usageCount === 0) return 0.3;
    if (usageCount < 5) return 0.4;
    if (usageCount < 20) return 0.5;
    if (usageCount < 50) return 0.6;
    if (usageCount < 100) return 0.7;
    if (usageCount < 200) return 0.8;
    return 0.9;
  }

  calculateTimeScore(avgTime) {
    if (!avgTime) return 0.5;
    
    if (avgTime < 1000) return 1.0;
    if (avgTime < 3000) return 0.9;
    if (avgTime < 5000) return 0.8;
    if (avgTime < 10000) return 0.7;
    if (avgTime < 30000) return 0.6;
    if (avgTime < 60000) return 0.5;
    return 0.3;
  }

  calculateErrorScore(errorCount, usageCount) {
    if (usageCount === 0) return 0.5;
    
    const errorRate = errorCount / usageCount;
    
    if (errorRate === 0) return 1.0;
    if (errorRate < 0.05) return 0.9;
    if (errorRate < 0.1) return 0.8;
    if (errorRate < 0.2) return 0.6;
    if (errorRate < 0.3) return 0.4;
    return 0.2;
  }

  getDefaultScore() {
    return 0.5;
  }

  updateAllScores(skillRegistry) {
    const now = Date.now();
    
    if (now - this.lastCalculation < this.calculationInterval) {
      return;
    }
    
    this.lastCalculation = now;

    const previousScores = new Map(this.scores);
    
    for (const skillName of Object.keys(skillRegistry)) {
      const newScore = this.calculateSkillScore(skillName);
      const oldScore = previousScores.get(skillName);
      
      if (oldScore !== undefined) {
        const decayedScore = oldScore * this.decayFactor + newScore * (1 - this.decayFactor);
        this.scores.set(skillName, decayedScore);
      } else {
        this.scores.set(skillName, newScore);
      }
    }

    this.recordHistory();
    this.save();
  }

  recordHistory() {
    const snapshot = {
      timestamp: Date.now(),
      scores: {}
    };

    const topSkills = Array.from(this.scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    for (const [skill, score] of topSkills) {
      snapshot.scores[skill] = score;
    }

    this.history.push(snapshot);
    
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }
  }

  getScore(skillName) {
    return this.scores.get(skillName) || this.getDefaultScore();
  }

  getQualityTier(score) {
    for (const [tier, config] of Object.entries(QUALITY_TIERS)) {
      if (score >= config.min) {
        return { tier, ...config };
      }
    }
    return { tier: 'CRITICAL', ...QUALITY_TIERS.CRITICAL };
  }

  getSkillQualityInfo(skillName) {
    const score = this.getScore(skillName);
    const tier = this.getQualityTier(score);
    
    return {
      skillName,
      score,
      tier: tier.tier,
      label: tier.label,
      color: tier.color
    };
  }

  getTopSkills(limit = 10) {
    return Array.from(this.scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([skill, score]) => ({
        skill,
        score,
        ...this.getQualityTier(score)
      }));
  }

  getBottomSkills(limit = 10) {
    return Array.from(this.scores.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([skill, score]) => ({
        skill,
        score,
        ...this.getQualityTier(score)
      }));
  }

  getScoreDistribution() {
    const distribution = {
      excellent: 0,
      good: 0,
      average: 0,
      poor: 0,
      critical: 0
    };

    for (const score of this.scores.values()) {
      const tier = this.getQualityTier(score);
      distribution[tier.tier.toLowerCase()]++;
    }

    return distribution;
  }

  getTrend(skillName, days = 7) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    
    const relevantHistory = this.history
      .filter(h => h.timestamp >= cutoff && h.scores[skillName] !== undefined)
      .map(h => ({
        timestamp: h.timestamp,
        score: h.scores[skillName]
      }));

    if (relevantHistory.length < 2) {
      return { trend: 'stable', change: 0 };
    }

    const first = relevantHistory[0].score;
    const last = relevantHistory[relevantHistory.length - 1].score;
    const change = last - first;

    let trend;
    if (change > 0.1) trend = 'improving';
    else if (change < -0.1) trend = 'declining';
    else trend = 'stable';

    return { trend, change, history: relevantHistory };
  }

  recordUserFeedback(skillName, feedback) {
    const detail = this.lifecycleManager.getSkillDetail(skillName);
    
    if (detail) {
      // 2026-08-18 P2: SkillLifecycleManager 无 updateSkillDetail 方法,原调用即 TypeError。
      // 降级: getSkillDetail 返回的是管理器内部记录的活引用,直接写回 userFeedback,
      // 下次 recordSkillUsage → _saveLifecycle 时一并持久化。
      detail.userFeedback = feedback;
    }

    const currentScore = this.getScore(skillName);
    const adjustedScore = currentScore * 0.7 + feedback * 0.3;
    this.scores.set(skillName, adjustedScore);
    
    this.save();
  }

  getRecommendations() {
    const recommendations = [];
    const bottomSkills = this.getBottomSkills(5);

    for (const { skill, score, tier } of bottomSkills) {
      if (tier === 'CRITICAL' || tier === 'POOR') {
        recommendations.push({
          skill,
          currentScore: score,
          action: 'review',
          reason: `技能评分较低 (${score.toFixed(2)})，建议审查或移除`
        });
      }
    }

    const distribution = this.getScoreDistribution();
    
    if (distribution.critical > 3) {
      recommendations.push({
        action: 'cleanup',
        reason: `${distribution.critical} 个技能评分过低，建议批量清理`
      });
    }

    return recommendations;
  }

  getStats() {
    const scores = Array.from(this.scores.values());
    
    return {
      totalSkills: this.scores.size,
      averageScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      distribution: this.getScoreDistribution(),
      topSkills: this.getTopSkills(5),
      bottomSkills: this.getBottomSkills(5),
      recommendations: this.getRecommendations()
    };
  }
}

const globalScoringSystem = new SkillScoringSystem();

module.exports = {
  SkillScoringSystem,
  globalScoringSystem,
  SCORING_WEIGHTS,
  QUALITY_TIERS
};
