/**
 * 技能推荐系统 - 基于上下文、用户画像、使用模式的智能推荐
 * 
 * 核心能力：
 * 1. 上下文感知推荐 - 根据当前对话上下文推荐技能
 * 2. 用户画像推荐 - 根据用户偏好和工作习惯推荐
 * 3. 协同过滤推荐 - 基于相似用户的使用模式
 * 4. 时序推荐 - 根据时间模式推荐（工作日/周末/时段）
 * 5. 序列推荐 - 根据技能使用序列推荐下一个技能
 */

const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

const RECOMMENDER_PATH = path.join(config.DATA_DIR, 'skill-recommender.json');

// 推荐来源权重
const SOURCE_WEIGHTS = {
  context: 0.35,      // 上下文匹配
  userProfile: 0.25,  // 用户画像
  usagePattern: 0.20, // 使用模式
  timePattern: 0.10,  // 时间模式
  sequence: 0.10      // 序列模式
};

class SkillRecommender {
  constructor() {
    this.data = null;
  }

  async init() {
    try {
      const raw = await fs.readFile(RECOMMENDER_PATH, 'utf-8');
      this.data = JSON.parse(raw);
    } catch {
      this.data = {
        // 技能使用统计
        usageStats: {},
        // 用户-技能关联矩阵
        userSkillMatrix: {},
        // 技能序列模式
        sequencePatterns: {},
        // 时间使用模式
        timePatterns: {},
        // 技能分类
        categories: {},
        // 推荐历史
        recommendationHistory: [],
        // 统计
        stats: { totalRecommendations: 0, accepted: 0, acceptanceRate: 0 }
      };
      await this.saveData();
    }
    console.log('🎯 技能推荐系统已初始化');
  }

  /**
   * Store skill registry reference for skill-name lookups.
   * Called by skill-system.js during initialization.
   */
  setSkillRegistry(registry) {
    this.registry = registry;
  }

  async saveData() {
    await fs.writeFile(RECOMMENDER_PATH, JSON.stringify(this.data, null, 2));
  }

  /**
   * 获取推荐技能
   */
  async recommend(context = {}, limit = 5) {
    const candidates = new Map();

    // 1. 上下文感知推荐
    const contextRecs = this.recommendByContext(context);
    this.mergeRecommendations(candidates, contextRecs, SOURCE_WEIGHTS.context);

    // 2. 用户画像推荐
    const profileRecs = this.recommendByUserProfile(context.userId);
    this.mergeRecommendations(candidates, profileRecs, SOURCE_WEIGHTS.userProfile);

    // 3. 使用模式推荐
    const patternRecs = this.recommendByUsagePattern(context.userId);
    this.mergeRecommendations(candidates, patternRecs, SOURCE_WEIGHTS.usagePattern);

    // 4. 时间模式推荐
    const timeRecs = this.recommendByTimePattern(context.userId);
    this.mergeRecommendations(candidates, timeRecs, SOURCE_WEIGHTS.timePattern);

    // 5. 序列模式推荐
    const seqRecs = this.recommendBySequence(context.lastSkill);
    this.mergeRecommendations(candidates, seqRecs, SOURCE_WEIGHTS.sequence);

    // 排序并返回
    const sorted = Array.from(candidates.entries())
      .map(([skillId, score]) => ({
        skillId,
        score: Math.min(score, 1),
        reasons: this.getRecommendationReasons(skillId, context)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // 记录推荐历史
    this.data.recommendationHistory.push({
      context: { ...context, messageCount: context.messages?.length },
      recommendations: sorted.map(r => r.skillId),
      timestamp: new Date().toISOString()
    });

    // 保留最近 100 条
    if (this.data.recommendationHistory.length > 100) {
      this.data.recommendationHistory = this.data.recommendationHistory.slice(-100);
    }

    this.data.stats.totalRecommendations++;
    await this.saveData();

    return sorted;
  }

  /**
   * 上下文感知推荐
   */
  recommendByContext(context) {
    const recs = {};
    if (!context.messages || context.messages.length === 0) return recs;

    // 分析最近的对话内容
    const recentMessages = context.messages.slice(-5);
    const keywords = this.extractKeywords(recentMessages);

    // 匹配技能关键词
    for (const [skillId, stats] of Object.entries(this.data.usageStats)) {
      const skillKeywords = stats.keywords || [];
      const matchCount = keywords.filter(kw => skillKeywords.includes(kw)).length;
      if (matchCount > 0) {
        recs[skillId] = matchCount / Math.max(keywords.length, 1);
      }
    }

    return recs;
  }

  /**
   * 用户画像推荐
   */
  recommendByUserProfile(userId) {
    const recs = {};
    if (!userId) return recs;

    const userSkills = this.data.userSkillMatrix[userId] || {};
    // 推荐用户常用但最近未使用的技能
    for (const [skillId, count] of Object.entries(userSkills)) {
      const stats = this.data.usageStats[skillId];
      const lastUsed = stats?.lastUsed ? Date.now() - new Date(stats.lastUsed).getTime() : Infinity;
      // 越常用且越久未使用，推荐分越高
      const frequencyScore = Math.min(count / 10, 1);
      const recencyScore = Math.min(lastUsed / (7 * 24 * 60 * 60 * 1000), 1);
      recs[skillId] = frequencyScore * 0.6 + recencyScore * 0.4;
    }

    return recs;
  }

  /**
   * 使用模式推荐
   */
  recommendByUsagePattern(userId) {
    const recs = {};
    // 基于全局热门技能推荐
    const sortedSkills = Object.entries(this.data.usageStats)
      .sort(([, a], [, b]) => (b.totalUses || 0) - (a.totalUses || 0))
      .slice(0, 10);

    const maxUses = sortedSkills[0]?.[1]?.totalUses || 1;
    for (const [skillId, stats] of sortedSkills) {
      // 排除用户已经非常熟悉的技能
      const userCount = this.data.userSkillMatrix[userId]?.[skillId] || 0;
      if (userCount < 5) {
        recs[skillId] = (stats.totalUses || 0) / maxUses * 0.5;
      }
    }

    return recs;
  }

  /**
   * 时间模式推荐
   */
  recommendByTimePattern(_userId) {
    const recs = {};
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    const timeKey = `${dayOfWeek}_${hour}`;
    const timeSkills = this.data.timePatterns[timeKey] || {};

    for (const [skillId, count] of Object.entries(timeSkills)) {
      recs[skillId] = Math.min(count / 5, 1);
    }

    return recs;
  }

  /**
   * 序列模式推荐
   */
  recommendBySequence(lastSkill) {
    const recs = {};
    if (!lastSkill) return recs;

    const nextSkills = this.data.sequencePatterns[lastSkill] || {};
    const totalNext = Object.values(nextSkills).reduce((s, c) => s + c, 0);

    for (const [skillId, count] of Object.entries(nextSkills)) {
      recs[skillId] = count / Math.max(totalNext, 1);
    }

    return recs;
  }

  /**
   * 合并推荐结果
   */
  mergeRecommendations(candidates, recs, weight) {
    for (const [skillId, score] of Object.entries(recs)) {
      const current = candidates.get(skillId) || 0;
      candidates.set(skillId, current + score * weight);
    }
  }

  /**
   * 提取关键词
   */
  extractKeywords(messages) {
    const text = messages.map(m => m.content || '').join(' ');
    // 简单分词（中文按字符，英文按空格）
    const words = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}/g) || [];
    // 去除停用词
    const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这']);
    return [...new Set(words.filter(w => !stopWords.has(w)))];
  }

  /**
   * 获取推荐原因
   */
  getRecommendationReasons(skillId, context) {
    const reasons = [];
    const stats = this.data.usageStats[skillId];

    if (stats?.totalUses > 10) reasons.push('高频使用技能');
    if (stats?.avgRating > 4) reasons.push('高评分技能');
    if (context.userId && this.data.userSkillMatrix[context.userId]?.[skillId]) {
      reasons.push('您常用的技能');
    }
    if (reasons.length === 0) reasons.push('可能适合当前场景');

    return reasons;
  }

  /**
   * 记录技能使用
   */
  async recordSkillUsage(skillId, userId, context = {}) {
    // 更新技能统计
    if (!this.data.usageStats[skillId]) {
      this.data.usageStats[skillId] = { totalUses: 0, keywords: [], lastUsed: null, avgRating: 0 };
    }
    this.data.usageStats[skillId].totalUses++;
    this.data.usageStats[skillId].lastUsed = new Date().toISOString();

    // 更新用户-技能矩阵
    if (userId) {
      if (!this.data.userSkillMatrix[userId]) this.data.userSkillMatrix[userId] = {};
      this.data.userSkillMatrix[userId][skillId] = (this.data.userSkillMatrix[userId][skillId] || 0) + 1;
    }

    // 更新序列模式
    if (context.lastSkill) {
      if (!this.data.sequencePatterns[context.lastSkill]) this.data.sequencePatterns[context.lastSkill] = {};
      this.data.sequencePatterns[context.lastSkill][skillId] = 
        (this.data.sequencePatterns[context.lastSkill][skillId] || 0) + 1;
    }

    // 更新时间模式
    const now = new Date();
    const timeKey = `${now.getDay()}_${now.getHours()}`;
    if (!this.data.timePatterns[timeKey]) this.data.timePatterns[timeKey] = {};
    this.data.timePatterns[timeKey][skillId] = (this.data.timePatterns[timeKey][skillId] || 0) + 1;

    // 更新技能关键词
    if (context.keywords) {
      const existing = new Set(this.data.usageStats[skillId].keywords);
      context.keywords.forEach(kw => existing.add(kw));
      this.data.usageStats[skillId].keywords = [...existing].slice(0, 20);
    }

    await this.saveData();
  }

  /**
   * 记录推荐接受
   */
  async recordAcceptance(skillId, accepted) {
    if (accepted) {
      this.data.stats.accepted++;
    }
    this.data.stats.acceptanceRate = this.data.stats.accepted / Math.max(this.data.stats.totalRecommendations, 1);
    await this.saveData();
  }

  /**
   * 获取推荐统计
   */
  getStats() {
    return {
      ...this.data.stats,
      totalSkills: Object.keys(this.data.usageStats).length,
      totalUsers: Object.keys(this.data.userSkillMatrix).length,
      sequencePatterns: Object.keys(this.data.sequencePatterns).length
    };
  }
}

let recommender = null;
async function getSkillRecommender() {
  if (!recommender) {
    recommender = new SkillRecommender();
    await recommender.init();
  }
  return recommender;
}

module.exports = { SkillRecommender, getSkillRecommender };
