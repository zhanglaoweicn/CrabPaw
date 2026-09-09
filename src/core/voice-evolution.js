/**
 * 语音回复进化体系
 * 
 * 核心目标：
 * 1. 类人化 — 语音播放不是照本宣科，而是像朋友聊天一样自然
 * 2. 进化能力 — 基于用户反馈和自动评估，持续提升"类人话"效果
 * 
 * 进化闭环：
 *   原始回复 → 缓存查询 → 场景识别 → 策略选择 → 提炼 → 评分 → 反馈 → 策略调整
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DATA_DIR = config.DATA_DIR;

const EVOLUTION_DATA_PATH = path.join(DATA_DIR, 'voice-evolution.json');
const CACHE_DATA_PATH = path.join(DATA_DIR, 'voice-cache.json');

// ─── 场景识别规则 ───────────────────────────────────────────────

const SCENE_RULES = [
  { id: 'weather',     keywords: ['天气','温度','下雨','晴','阴','风','湿度','气温','雪','雾'], label: '天气' },
  { id: 'time',        keywords: ['几点','时间','日期','星期','今天','明天','昨天','上午','下午','晚上','凌晨'], label: '时间' },
  { id: 'technical',   keywords: ['代码','错误','配置','安装','编译','部署','调试','API','接口','数据库','服务器','报错','异常','bug'], label: '技术' },
  { id: 'task',        keywords: ['执行','完成','成功','失败','任务','进度','状态','结果','运行','处理中'], label: '任务' },
  { id: 'search',      keywords: ['搜索','查找','找到','查询','检索','结果如下','以下是'], label: '搜索' },
  { id: 'explanation', keywords: ['是什么','为什么','怎么','如何','原理','原因','解释','说明','区别','比较'], label: '解释' },
  { id: 'greeting',    keywords: ['你好','早上好','晚上好','嗨','hello','hi','在吗'], label: '问候' },
  { id: 'creative',    keywords: ['写','生成','创作','帮我','起草','编','设计','构思'], label: '创作' },
  { id: 'data',        keywords: ['数据','统计','报表','图表','分析','趋势','对比','排名'], label: '数据' },
  { id: 'notification',keywords: ['提醒','通知','消息','待办','日程','会议','截止'], label: '通知' },
];

// ─── 默认数据结构 ───────────────────────────────────────────────

const DEFAULT_EVOLUTION_DATA = {
  excellentExamples: [],
  failedExamples: [],
  userPreferences: {
    toneStyle: 'friendly',
    lengthPreference: 'medium',
    emotionLevel: 'high',
    useTransitionWords: true,
    useModalParticles: true
  },
  evolutionStats: {
    totalRefinements: 0,
    averageRating: 0,
    improvementRate: 0,
    lastUpdated: null,
    autoEvolutionsRun: 0
  },
  sceneStrategies: {
    weather:     { template: 'weather-friendly',    rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    time:        { template: 'time-friendly',       rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    technical:   { template: 'technical-clear',      rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    task:        { template: 'task-concise',         rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    search:      { template: 'search-summary',       rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    explanation: { template: 'explanation-simple',    rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    greeting:    { template: 'greeting-warm',         rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    creative:    { template: 'creative-encouraging',  rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    data:        { template: 'data-highlight',        rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    notification:{ template: 'notification-brief',     rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] },
    casual:      { template: 'casual-natural',        rating: 0, usage: 0, avgRefinedLength: 0, bestPractices: [] }
  }
};

const DEFAULT_CACHE_DATA = {
  refinements: {},
  lastCleaned: null,
  stats: {
    totalCacheHits: 0,
    totalCacheMisses: 0,
    averageHitRate: 0
  }
};

// ─── 数据持久化 ─────────────────────────────────────────────────

function loadEvolutionData() {
  try {
    if (fs.existsSync(EVOLUTION_DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(EVOLUTION_DATA_PATH, 'utf-8'));
      return {
        ...DEFAULT_EVOLUTION_DATA,
        ...data,
        userPreferences: { ...DEFAULT_EVOLUTION_DATA.userPreferences, ...data.userPreferences },
        evolutionStats: { ...DEFAULT_EVOLUTION_DATA.evolutionStats, ...data.evolutionStats },
        sceneStrategies: { ...DEFAULT_EVOLUTION_DATA.sceneStrategies, ...data.sceneStrategies }
      };
    }
    return JSON.parse(JSON.stringify(DEFAULT_EVOLUTION_DATA));
  } catch (err) {
    console.error('[VoiceEvolution] 加载进化数据失败:', err);
    return JSON.parse(JSON.stringify(DEFAULT_EVOLUTION_DATA));
  }
}

function saveEvolutionData(data) {
  try {
    const dir = path.dirname(EVOLUTION_DATA_PATH);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(EVOLUTION_DATA_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[VoiceEvolution] 保存进化数据失败:', err);
  }
}

function loadCacheData() {
  try {
    if (fs.existsSync(CACHE_DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(CACHE_DATA_PATH, 'utf-8'));
      return { ...DEFAULT_CACHE_DATA, ...data, stats: { ...DEFAULT_CACHE_DATA.stats, ...data.stats } };
    }
    return JSON.parse(JSON.stringify(DEFAULT_CACHE_DATA));
  } catch (err) {
    console.error('[VoiceEvolution] 加载缓存数据失败:', err);
    return JSON.parse(JSON.stringify(DEFAULT_CACHE_DATA));
  }
}

function saveCacheData(data) {
  try {
    const dir = path.dirname(CACHE_DATA_PATH);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(CACHE_DATA_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[VoiceEvolution] 保存缓存数据失败:', err);
  }
}

// ─── 场景识别（增强版） ─────────────────────────────────────────

function recognizeScene(text) {
  const lowerText = text.toLowerCase();
  let bestScene = 'casual';
  let bestScore = 0;

  for (const rule of SCENE_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (lowerText.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestScene = rule.id;
    }
  }

  return bestScene;
}

// ─── 缓存管理 ───────────────────────────────────────────────────

function generateCacheKey(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getCachedRefinement(originalText) {
  const cacheData = loadCacheData();
  const cacheKey = generateCacheKey(originalText);

  if (cacheData.refinements[cacheKey]) {
    const cached = cacheData.refinements[cacheKey];
    const maxAge = 24 * 60 * 60 * 1000;

    if (Date.now() - cached.timestamp < maxAge) {
        cacheData.stats.totalCacheHits++;
        // V26 fix: 除零保护
        const total = cacheData.stats.totalCacheHits + cacheData.stats.totalCacheMisses;
        cacheData.stats.averageHitRate = total > 0 ? cacheData.stats.totalCacheHits / total : 0;
      saveCacheData(cacheData);
      console.log('[VoiceEvolution] 缓存命中');
      return cached.refined;
    }
  }

  cacheData.stats.totalCacheMisses++;
  // V26 fix: 除零保护（同上）
  const total2 = cacheData.stats.totalCacheHits + cacheData.stats.totalCacheMisses;
  cacheData.stats.averageHitRate = total2 > 0 ? cacheData.stats.totalCacheHits / total2 : 0;
  saveCacheData(cacheData);

  return null;
}

function saveCachedRefinement(originalText, refinedText, rating = 0) {
  const cacheData = loadCacheData();
  const cacheKey = generateCacheKey(originalText);

  cacheData.refinements[cacheKey] = {
    original: originalText.substring(0, 200),
    refined: refinedText,
    timestamp: Date.now(),
    rating,
    usage: (cacheData.refinements[cacheKey]?.usage || 0) + 1
  };

  // 清理过期缓存（保留最近 2000 条）
  const entries = Object.entries(cacheData.refinements);
  if (entries.length > 2000) {
    entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
    cacheData.refinements = Object.fromEntries(entries.slice(0, 2000));
    cacheData.lastCleaned = Date.now();
  }

  saveCacheData(cacheData);
}

// ─── 进化核心：示例管理与评分 ───────────────────────────────────

function addExcellentExample(original, refined, rating, category = null) {
  const evolutionData = loadEvolutionData();

  if (evolutionData.excellentExamples.length >= 200) {
    evolutionData.excellentExamples.sort((a, b) => b.rating - a.rating);
    evolutionData.excellentExamples = evolutionData.excellentExamples.slice(0, 199);
  }

  const scene = category || recognizeScene(original);

  evolutionData.excellentExamples.push({
    original: original.substring(0, 500),
    refined,
    rating,
    category: scene,
    timestamp: Date.now()
  });

  // 更新统计
  evolutionData.evolutionStats.totalRefinements++;
  const totalRating = evolutionData.excellentExamples.reduce((sum, ex) => sum + ex.rating, 0);
  evolutionData.evolutionStats.averageRating = totalRating / evolutionData.excellentExamples.length;
  evolutionData.evolutionStats.lastUpdated = Date.now();

  // 更新场景策略
  if (evolutionData.sceneStrategies[scene]) {
    const strategy = evolutionData.sceneStrategies[scene];
    strategy.usage++;
    strategy.rating = (strategy.rating * 0.85) + (rating * 0.15);
    strategy.avgRefinedLength = strategy.avgRefinedLength === 0
      ? refined.length
      : (strategy.avgRefinedLength * 0.85) + (refined.length * 0.15);

    // 记录该场景的高分最佳实践
    if (rating >= 4) {
      if (!strategy.bestPractices) strategy.bestPractices = [];
      strategy.bestPractices.push({
        original: original.substring(0, 100),
        refined: refined.substring(0, 200),
        rating
      });
      // 只保留前 10 个最佳实践
      strategy.bestPractices.sort((a, b) => b.rating - a.rating);
      strategy.bestPractices = strategy.bestPractices.slice(0, 10);
    }
  }

  saveEvolutionData(evolutionData);
  console.log(`[VoiceEvolution] 优秀示例已添加 (场景:${scene}, 评分:${rating}, 均分:${evolutionData.evolutionStats.averageRating.toFixed(2)})`);
}

function addFailedExample(original, refined, reason = '') {
  const evolutionData = loadEvolutionData();

  if (evolutionData.failedExamples.length >= 100) {
    evolutionData.failedExamples.shift();
  }

  evolutionData.failedExamples.push({
    original: original.substring(0, 500),
    refined,
    reason,
    category: recognizeScene(original),
    timestamp: Date.now()
  });

  evolutionData.evolutionStats.lastUpdated = Date.now();
  saveEvolutionData(evolutionData);
  console.log('[VoiceEvolution] 失败示例已添加');
}

// ─── 自动评估：基于规则给提炼结果打分 ───────────────────────────

function autoEvaluateRefinement(original, refined) {
  let score = 3; // 基础分

  // 1. 长度优化（提炼后应更短）
  if (refined.length < original.length * 0.7) score += 0.5;
  if (refined.length < original.length * 0.5) score += 0.3;

  // 2. 包含语气词（呢、呀、哦、吧、嘛）→ 更类人
  const modalParticles = (refined.match(/[呢呀哦吧嘛哈嗯]/g) || []).length;
  if (modalParticles >= 1 && modalParticles <= 3) score += 0.3;

  // 3. 包含自然过渡词
  const transitions = ['对了','不过','其实','话说','顺便','看起来','好像','说实话'];
  if (transitions.some(t => refined.includes(t))) score += 0.3;

  // 4. 不包含技术标记（代码、表格、链接）
  if (!/[`|<>{}[\]]/.test(refined)) score += 0.3;
  if (!/```|http|https|www/.test(refined)) score += 0.2;

  // 5. 不照本宣科（与原文差异度）
  if (refined !== original.substring(0, refined.length)) score += 0.4;

  // 6. 长度适中（50-150字最佳）
  if (refined.length >= 50 && refined.length <= 150) score += 0.3;

  return Math.min(5, Math.max(1, score));
}

// ─── 进化核心：动态策略生成 ─────────────────────────────────────

function getDynamicRefinementStrategy(originalText) {
  const evolutionData = loadEvolutionData();
  const scene = recognizeScene(originalText);
  const sceneStrategy = evolutionData.sceneStrategies[scene] || {};

  const strategy = {
    toneStyle: evolutionData.userPreferences.toneStyle,
    lengthPreference: evolutionData.userPreferences.lengthPreference,
    emotionLevel: evolutionData.userPreferences.emotionLevel,
    useTransitionWords: evolutionData.userPreferences.useTransitionWords,
    useModalParticles: evolutionData.userPreferences.useModalParticles,
    scene,
    template: sceneStrategy.template || 'default',
    confidence: 'low',
    suggestedLength: 100,
    bestPractices: []
  };

  // 基于进化数据调整策略
  const sceneExamples = evolutionData.excellentExamples.filter(ex => ex.category === scene);

  if (sceneExamples.length >= 5) {
    const avgRating = sceneExamples.reduce((sum, ex) => sum + ex.rating, 0) / sceneExamples.length;
    strategy.confidence = avgRating >= 4.0 ? 'high' : 'medium';
    strategy.suggestedLength = sceneExamples.reduce((sum, ex) => sum + ex.refined.length, 0) / sceneExamples.length;

    // 提供最佳实践作为提炼参考
    if (sceneStrategy.bestPractices && sceneStrategy.bestPractices.length > 0) {
      strategy.bestPractices = sceneStrategy.bestPractices.slice(0, 3);
    }
  }

  // 全局进化：如果整体评分提升，调整默认策略
  if (evolutionData.evolutionStats.averageRating >= 4.0) {
    strategy.emotionLevel = 'high';
  } else if (evolutionData.evolutionStats.averageRating < 3.0 && strategy.emotionLevel === 'high') {
    strategy.emotionLevel = 'medium';
  }

  return strategy;
}

// ─── 进化核心：自动进化（定期运行） ─────────────────────────────

function runAutoEvolution() {
  const evolutionData = loadEvolutionData();
  let improvements = 0;

  // 1. 基于高分示例调整场景策略
  for (const [scene, strategy] of Object.entries(evolutionData.sceneStrategies)) {
    const sceneExamples = evolutionData.excellentExamples.filter(ex => ex.category === scene);
    const failedExamples = evolutionData.failedExamples.filter(ex => ex.category === scene);

    // 如果高分示例多，提升该场景的信心
    if (sceneExamples.length >= 5) {
      const avgRating = sceneExamples.reduce((sum, ex) => sum + ex.rating, 0) / sceneExamples.length;
      if (avgRating > strategy.rating + 0.5) {
        strategy.rating = (strategy.rating + avgRating) / 2;
        improvements++;
      }
    }

    // 如果失败示例多，降低该场景的评分并调整模板
    if (failedExamples.length > 3) {
      const recentFailed = failedExamples.slice(-3);
      const commonReasons = recentFailed.map(f => f.reason).filter(Boolean);
      if (commonReasons.length > 0) {
        // 标记需要调整
        strategy.rating = Math.max(0, strategy.rating - 0.2);
        improvements++;
      }
    }
  }

  // 2. 基于进化趋势调整用户偏好
  if (evolutionData.excellentExamples.length >= 20) {
    const recentGood = evolutionData.excellentExamples.slice(-20);
    const avgRefinedLength = recentGood.reduce((sum, ex) => sum + ex.refined.length, 0) / recentGood.length;

    if (avgRefinedLength < 80) {
      evolutionData.userPreferences.lengthPreference = 'short';
      improvements++;
    } else if (avgRefinedLength > 150) {
      evolutionData.userPreferences.lengthPreference = 'long';
      improvements++;
    } else {
      evolutionData.userPreferences.lengthPreference = 'medium';
    }

    // 检查高分示例是否倾向于使用语气词
    const withModalParticles = recentGood.filter(ex => /[呢呀哦吧嘛]/.test(ex.refined));
    evolutionData.userPreferences.useModalParticles = withModalParticles.length > recentGood.length * 0.5;
  }

  // 3. 清理过时数据
  const now = Date.now();
  const maxAge = 30 * 24 * 60 * 60 * 1000; // 30天
  evolutionData.excellentExamples = evolutionData.excellentExamples.filter(
    ex => now - ex.timestamp < maxAge
  );
  evolutionData.failedExamples = evolutionData.failedExamples.filter(
    ex => now - ex.timestamp < maxAge
  );

  // 4. 更新进化统计
  evolutionData.evolutionStats.autoEvolutionsRun++;
  evolutionData.evolutionStats.improvementRate = improvements > 0
    ? (evolutionData.evolutionStats.improvementRate * 0.9) + (improvements * 0.1)
    : evolutionData.evolutionStats.improvementRate * 0.95;
  evolutionData.evolutionStats.lastUpdated = now;

  saveEvolutionData(evolutionData);
  console.log(`[VoiceEvolution] 自动进化完成: ${improvements} 项改进, 累计进化 ${evolutionData.evolutionStats.autoEvolutionsRun} 次`);

  return { improvements, totalEvolutions: evolutionData.evolutionStats.autoEvolutionsRun };
}

// ─── 用户偏好 ───────────────────────────────────────────────────

function updateUserPreferences(preferences) {
  const evolutionData = loadEvolutionData();
  evolutionData.userPreferences = { ...evolutionData.userPreferences, ...preferences };
  evolutionData.evolutionStats.lastUpdated = Date.now();
  saveEvolutionData(evolutionData);
  console.log('[VoiceEvolution] 用户偏好已更新');
}

// ─── 统计与缓存清理 ─────────────────────────────────────────────

function getEvolutionStats() {
  const evolutionData = loadEvolutionData();
  const cacheData = loadCacheData();
  return {
    evolution: evolutionData.evolutionStats,
    cache: cacheData.stats,
    excellentExamplesCount: evolutionData.excellentExamples.length,
    failedExamplesCount: evolutionData.failedExamples.length,
    userPreferences: evolutionData.userPreferences,
    sceneStrategies: evolutionData.sceneStrategies
  };
}

function cleanExpiredCache() {
  const cacheData = loadCacheData();
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  let cleaned = 0;
  const valid = {};

  for (const [key, value] of Object.entries(cacheData.refinements)) {
    if (now - value.timestamp < maxAge) {
      valid[key] = value;
    } else {
      cleaned++;
    }
  }

  cacheData.refinements = valid;
  cacheData.lastCleaned = now;
  saveCacheData(cacheData);
  console.log(`[VoiceEvolution] 清理了 ${cleaned} 条过期缓存`);
  return cleaned;
}

/**
 * 语音回复文本解析：缓存优先的提炼查询
 * @param {string} text 原始回复文本
 * @param {{allowRefine?: boolean}} opts allowRefine=false 时强制返回原文
 * @returns {string} 用于 TTS 合成的文本
 */
function resolveRefinedText(text, opts = {}) {
  if (!text || opts.allowRefine === false) return text;
  try {
    const cached = getCachedRefinement(text);
    if (cached && String(cached).trim().length > 0) {
      return cached;
    }
  } catch (err) {
    console.warn('[VoiceEvolution] 提炼查询失败，使用原文:', err.message);
  }
  return text;
}

module.exports = {
  loadEvolutionData,
  saveEvolutionData,
  loadCacheData,
  saveCacheData,
  generateCacheKey,
  recognizeScene,
  getCachedRefinement,
  saveCachedRefinement,
  addExcellentExample,
  addFailedExample,
  updateUserPreferences,
  getDynamicRefinementStrategy,
  getEvolutionStats,
  cleanExpiredCache,
  autoEvaluateRefinement,
  runAutoEvolution,
  resolveRefinedText,
};
