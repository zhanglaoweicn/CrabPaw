const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./config');

const USAGE_FILE = path.join(DATA_DIR, 'usage-stats.json');

const DEFAULT_USAGE = {
  total: {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
    cacheSavings: 0
  },
  byProvider: {},
  byModel: {},
  byDay: {},
  // 按调用类型聚合：chat / vision / image / video / tts / asr
  byType: {
    chat:   { requests: 0, units: 0, estimatedCost: 0 },
    vision: { requests: 0, units: 0, estimatedCost: 0 },
    image:  { requests: 0, units: 0, estimatedCost: 0 },
    video:  { requests: 0, units: 0, estimatedCost: 0 },
    tts:    { requests: 0, units: 0, estimatedCost: 0 },
    asr:    { requests: 0, units: 0, estimatedCost: 0 },
  },
  lastUpdated: null
};

const CACHE_DISCOUNT_RATIO = 0.5;

const MODEL_PRICING = {
  'deepseek-chat': { prompt: 0.0001, completion: 0.0002, cache: 0.00001 },
  'deepseek-coder': { prompt: 0.0001, completion: 0.0002, cache: 0.00001 },
  'deepseek-reasoner': { prompt: 0.0004, completion: 0.0016, cache: 0.00004 },
  'deepseek-v3': { prompt: 0.0001, completion: 0.0002, cache: 0.00001 },
  'deepseek-r1': { prompt: 0.0004, completion: 0.0016, cache: 0.00004 },
  'glm-4': { prompt: 0.00014, completion: 0.00014, cache: 0.000007 },
  'glm-4-flash': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'glm-4-plus': { prompt: 0.00005, completion: 0.00005, cache: 0.0000025 },
  'glm-4-long': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'glm-4v': { prompt: 0.00005, completion: 0.00005, cache: 0.0000025 },
  // 2026-09-04 SLO 轮: GLM-5 系费率——官方定价页为 JS 渲染未能自动核对, 沿用
  // glm-4 同档量级保守估算(source: estimated, 用于 SLO 相对基线而非计费)。
  // 待人工核对 bigmodel.cn 定价后更新为精确值。
  'glm-5': { prompt: 0.00014, completion: 0.00014, cache: 0.000007 },
  'glm-5-air': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'glm-5-flash': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'glm-5.3-flash': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'glm-5.3': { prompt: 0.00014, completion: 0.00014, cache: 0.000007 },
  'qwen-turbo': { prompt: 0.0002, completion: 0.0006, cache: 0.00001 },
  'qwen-max': { prompt: 0.0004, completion: 0.0012, cache: 0.00002 },
  'qwen-plus': { prompt: 0.00008, completion: 0.0002, cache: 0.000004 },
  'qwen-long': { prompt: 0.00002, completion: 0.00006, cache: 0.000001 },
  'qwen-vl-max': { prompt: 0.0003, completion: 0.0006, cache: 0.000015 },
  'moonshot-v1-8k': { prompt: 0.00012, completion: 0.00012, cache: 0.000006 },
  'moonshot-v1-32k': { prompt: 0.00024, completion: 0.00024, cache: 0.000012 },
  'moonshot-v1-128k': { prompt: 0.00048, completion: 0.00048, cache: 0.000024 },
  'yi-lightning': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'yi-large': { prompt: 0.0003, completion: 0.0003, cache: 0.000015 },
  'yi-medium': { prompt: 0.00002, completion: 0.00002, cache: 0.000001 },
  'yi-vision': { prompt: 0.00006, completion: 0.00006, cache: 0.000003 },
  'baichuan4': { prompt: 0.00012, completion: 0.00012, cache: 0.000006 },
  'baichuan3-turbo': { prompt: 0.00002, completion: 0.00002, cache: 0.000001 },
  'abab6.5s-chat': { prompt: 0.00001, completion: 0.00001, cache: 0.0000005 },
  'abab6.5-chat': { prompt: 0.00003, completion: 0.00003, cache: 0.0000015 },
  'abab7-chat-preview': { prompt: 0.00005, completion: 0.00005, cache: 0.0000025 },
  'spark-v3.5': { prompt: 0.00018, completion: 0.00018, cache: 0.000009 },
  'spark-v4.0': { prompt: 0.00035, completion: 0.00035, cache: 0.0000175 },
  'doubao': { prompt: 0.00005, completion: 0.00005, cache: 0.0000025 },
  'doubao-pro': { prompt: 0.00003, completion: 0.00003, cache: 0.0000015 },
  'doubao-lite': { prompt: 0.000008, completion: 0.000008, cache: 0.0000004 },
  'default': { prompt: 0.0001, completion: 0.0001, cache: 0.000005 }
};

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
      const merged = { ...DEFAULT_USAGE, ...data };
      // 兼容旧版使用量文件：补齐缺失字段
      merged.total = { ...DEFAULT_USAGE.total, ...(data.total || {}) };
      merged.byType = { ...DEFAULT_USAGE.byType, ...(data.byType || {}) };
      return merged;
    }
  } catch (e) {
    console.error('加载用量统计失败:', e.message);
  }
  return { ...DEFAULT_USAGE };
}

function saveUsage(usage) {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    usage.lastUpdated = new Date().toISOString();
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
  } catch (e) {
    console.error('保存用量统计失败:', e.message);
  }
}

function calculateCost(model, promptTokens, completionTokens, cachedTokens = 0) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
  const nonCachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
  const promptCost = (nonCachedPromptTokens / 1000) * pricing.prompt;
  const completionCost = (completionTokens / 1000) * pricing.completion;
  const cacheCost = (cachedTokens / 1000) * (pricing.cache || pricing.prompt * CACHE_DISCOUNT_RATIO);
  const cacheSavings = (cachedTokens / 1000) * (pricing.prompt - (pricing.cache || pricing.prompt * CACHE_DISCOUNT_RATIO));
  return {
    total: promptCost + completionCost + cacheCost,
    promptCost,
    completionCost,
    cacheCost,
    cacheSavings: Math.max(0, cacheSavings),
  };
}

function normalizeUsageFields(usage, provider) {
  if (!usage || typeof usage !== 'object') {
    return { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;

  promptTokens =
    usage.prompt_tokens ??
    usage.input_tokens ??
    usage.prompt_n ??
    0;

  completionTokens =
    usage.completion_tokens ??
    usage.output_tokens ??
    (usage.completion_tokens_details?.reasoning_tokens
      ? (usage.completion_tokens ?? 0)
      : usage.predicted_n) ??
    0;

  cachedTokens =
    usage.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cache_creation_input_tokens ??
    0;

  if (provider === 'openai' && usage.prompt_tokens_details?.cached_tokens) {
    promptTokens = Math.max(0, (usage.prompt_tokens ?? 0) - usage.prompt_tokens_details.cached_tokens);
  }

  if (provider === 'anthropic' && usage.cache_read_input_tokens) {
    cachedTokens = usage.cache_read_input_tokens;
  }

  return { promptTokens, completionTokens, cachedTokens };
}

function recordUsage(provider, model, usage, options = {}) {
  const stats = loadUsage();

  const type = options.type || 'chat';
  const isMultimodal = type !== 'chat';

  // chat / vision 类型：API 返回- ?token，按 token 计费
  // 其他多模态类型（image/video/tts/asr）：没有 token，只记调用次数和单位（张/- ?字）
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let cost = 0;
  let cacheSavings = 0;
  let units = 0;

  if (!isMultimodal) {
    ({ promptTokens, completionTokens, cachedTokens } = normalizeUsageFields(usage, provider));
    const costResult = calculateCost(model, promptTokens, completionTokens, cachedTokens);
    cost = costResult.total;
    cacheSavings = costResult.cacheSavings;
  } else {
    // 多模态：- ?options 中读单位
    if (type === 'image') {
      units = Number(options.count || 1);
    } else if (type === 'video') {
      units = Number(options.durationSeconds || 0);
    } else if (type === 'tts') {
      // 优先- ?- ?统计；如只知字符数则退出?chars
      units = Number(options.durationSeconds || options.chars || options.units || 0);
    } else if (type === 'asr') {
      units = Number(options.durationSeconds || 0);
    } else if (type === 'vision') {
      // 视觉（走 chat 接口但希望单独分类）也用 token 统计
      ({ promptTokens, completionTokens, cachedTokens } = normalizeUsageFields(usage, provider));
      const costResult = calculateCost(model, promptTokens, completionTokens, cachedTokens);
      cost = costResult.total;
      cacheSavings = costResult.cacheSavings;
    }
  }

  const totalTokens = promptTokens + completionTokens;

  // - ?chat / vision 类型，units 也填- ?token 数，便于前端- ?- ?- ?- ?Token"统一展示
  if (type === 'chat' || type === 'vision') {
    units = totalTokens;
  }

  // 1. total
  stats.total.requests += 1;
  stats.total.promptTokens += promptTokens;
  stats.total.completionTokens += completionTokens;
  stats.total.cachedTokens = (stats.total.cachedTokens || 0) + cachedTokens;
  stats.total.totalTokens += totalTokens;
  stats.total.estimatedCost += cost;
  stats.total.cacheSavings = (stats.total.cacheSavings || 0) + cacheSavings;

  // 2. byType
  if (!stats.byType) {
    stats.byType = JSON.parse(JSON.stringify(DEFAULT_USAGE.byType));
  }
  const bt = stats.byType[type] || { requests: 0, units: 0, estimatedCost: 0 };
  bt.requests += 1;
  bt.units = (bt.units || 0) + units;
  bt.estimatedCost = (bt.estimatedCost || 0) + cost;
  stats.byType[type] = bt;

  // 3. byProvider
  if (!stats.byProvider[provider]) {
    stats.byProvider[provider] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      cacheSavings: 0
    };
  }
  stats.byProvider[provider].requests += 1;
  stats.byProvider[provider].promptTokens += promptTokens;
  stats.byProvider[provider].completionTokens += completionTokens;
  stats.byProvider[provider].cachedTokens = (stats.byProvider[provider].cachedTokens || 0) + cachedTokens;
  stats.byProvider[provider].totalTokens += totalTokens;
  stats.byProvider[provider].estimatedCost += cost;
  stats.byProvider[provider].cacheSavings = (stats.byProvider[provider].cacheSavings || 0) + cacheSavings;

  // 4. byModel（多模态用 type 前缀避免- ?chat 模型键冲突）
  const modelKey = isMultimodal ? `${type}:${provider}/${model}` : `${provider}/${model}`;
  if (!stats.byModel[modelKey]) {
    stats.byModel[modelKey] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      cacheSavings: 0
    };
  }
  stats.byModel[modelKey].requests += 1;
  stats.byModel[modelKey].promptTokens += promptTokens;
  stats.byModel[modelKey].completionTokens += completionTokens;
  stats.byModel[modelKey].cachedTokens = (stats.byModel[modelKey].cachedTokens || 0) + cachedTokens;
  stats.byModel[modelKey].totalTokens += totalTokens;
  stats.byModel[modelKey].estimatedCost += cost;
  stats.byModel[modelKey].cacheSavings = (stats.byModel[modelKey].cacheSavings || 0) + cacheSavings;

  // 5. byDay
  const today = new Date().toISOString().split('T')[0];
  if (!stats.byDay[today]) {
    stats.byDay[today] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      cacheSavings: 0
    };
  }
  stats.byDay[today].requests += 1;
  stats.byDay[today].promptTokens += promptTokens;
  stats.byDay[today].completionTokens += completionTokens;
  stats.byDay[today].cachedTokens = (stats.byDay[today].cachedTokens || 0) + cachedTokens;
  stats.byDay[today].totalTokens += totalTokens;
  stats.byDay[today].estimatedCost += cost;
  stats.byDay[today].cacheSavings = (stats.byDay[today].cacheSavings || 0) + cacheSavings;

  saveUsage(stats);

  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens,
    cost,
    cacheSavings,
    type,
    units,
  };
}

function getUsageStats() {
  return loadUsage();
}

function getTodayUsage() {
  const stats = loadUsage();
  const today = new Date().toISOString().split('T')[0];
  return stats.byDay[today] || {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCost: 0
  };
}

function getRecentUsage(days = 7) {
  const stats = loadUsage();
  const result = [];
  
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    
    result.push({
      date: dateStr,
      ...(stats.byDay[dateStr] || {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCost: 0
      })
    });
  }
  
  return result.reverse();
}

function resetUsage() {
  saveUsage({ ...DEFAULT_USAGE });
}

class UsageBudget {
  constructor(config = {}) {
    this.dailyBudget = config.dailyBudget || Infinity;
    this.monthlyBudget = config.monthlyBudget || Infinity;
    this.perUserBudget = config.perUserBudget || Infinity;
    this._userSpending = new Map();
    this._alertCallbacks = [];
  }

  onAlert(callback) {
    this._alertCallbacks.push(callback);
  }

  _emitAlert(level, message, data) {
    for (const cb of this._alertCallbacks) {
      try { cb({ level, message, data, timestamp: Date.now() }); } catch { console.warn('[usage-stats] silent catch, error swallowed'); }
    }
  }

  checkDailyBudget() {
    const today = getTodayUsage();
    if (today.estimatedCost >= this.dailyBudget) {
      this._emitAlert('critical', `日预算已耗尽: ¥${today.estimatedCost.toFixed(4)} / ¥${this.dailyBudget}`, today);
      return { allowed: false, reason: 'daily_budget_exhausted', spent: today.estimatedCost, budget: this.dailyBudget };
    }
    if (today.estimatedCost >= this.dailyBudget * 0.8) {
      this._emitAlert('warning', `日预算接近上- ? ¥${today.estimatedCost.toFixed(4)} / ¥${this.dailyBudget}`, today);
    }
    return { allowed: true, spent: today.estimatedCost, budget: this.dailyBudget };
  }

  checkMonthlyBudget() {
    const stats = loadUsage();
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let monthlyCost = 0;
    for (const [day, data] of Object.entries(stats.byDay)) {
      if (day.startsWith(monthKey)) {
        monthlyCost += data.estimatedCost || 0;
      }
    }
    if (monthlyCost >= this.monthlyBudget) {
      this._emitAlert('critical', `月预算已耗尽: ¥${monthlyCost.toFixed(4)} / ¥${this.monthlyBudget}`, { monthlyCost });
      return { allowed: false, reason: 'monthly_budget_exhausted', spent: monthlyCost, budget: this.monthlyBudget };
    }
    return { allowed: true, spent: monthlyCost, budget: this.monthlyBudget };
  }

  checkUserBudget(userId) {
    const spent = this._userSpending.get(userId) || 0;
    if (spent >= this.perUserBudget) {
      return { allowed: false, reason: 'user_budget_exhausted', spent, budget: this.perUserBudget };
    }
    return { allowed: true, spent, budget: this.perUserBudget };
  }

  recordUserSpending(userId, cost) {
    const current = this._userSpending.get(userId) || 0;
    this._userSpending.set(userId, current + cost);
  }

  resetDaily() {
    this._userSpending.clear();
  }

  isAllowed(userId) {
    const daily = this.checkDailyBudget();
    if (!daily.allowed) return false;
    const monthly = this.checkMonthlyBudget();
    if (!monthly.allowed) return false;
    if (userId) {
      const user = this.checkUserBudget(userId);
      if (!user.allowed) return false;
    }
    return true;
  }
}

class UsageReporter {
  constructor(config = {}) {
    this._history = [];
    this._maxHistory = config.maxHistory || 1000;
  }

  record(provider, model, usage, cost, userId) {
    const entry = {
      provider,
      model,
      promptTokens: usage?.prompt_tokens || usage?.input_tokens || 0,
      completionTokens: usage?.completion_tokens || usage?.output_tokens || 0,
      cost,
      userId: userId || 'default',
      timestamp: Date.now(),
    };
    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history = this._history.slice(-this._maxHistory / 2);
    }
    return entry;
  }

  getByUser(userId, limit = 50) {
    return this._history
      .filter(e => e.userId === userId)
      .slice(-limit);
  }

  getByModel(model, limit = 50) {
    return this._history
      .filter(e => e.model === model)
      .slice(-limit);
  }

  getByTimeRange(startMs, endMs) {
    return this._history.filter(e => e.timestamp >= startMs && e.timestamp <= endMs);
  }

  getTopModels(count = 10) {
    const modelCosts = {};
    for (const e of this._history) {
      if (!modelCosts[e.model]) modelCosts[e.model] = { cost: 0, requests: 0, tokens: 0 };
      modelCosts[e.model].cost += e.cost;
      modelCosts[e.model].requests++;
      modelCosts[e.model].tokens += e.promptTokens + e.completionTokens;
    }
    return Object.entries(modelCosts)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, count)
      .map(([model, data]) => ({ model, ...data }));
  }

  getTopUsers(count = 10) {
    const userCosts = {};
    for (const e of this._history) {
      if (!userCosts[e.userId]) userCosts[e.userId] = { cost: 0, requests: 0 };
      userCosts[e.userId].cost += e.cost;
      userCosts[e.userId].requests++;
    }
    return Object.entries(userCosts)
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, count)
      .map(([userId, data]) => ({ userId, ...data }));
  }

  getHourlyDistribution() {
    const hours = new Array(24).fill(0);
    for (const e of this._history) {
      const hour = new Date(e.timestamp).getHours();
      hours[hour]++;
    }
    return hours;
  }

  getHistory(limit = 100) {
    return this._history.slice(-limit);
  }
}

module.exports = {
  normalizeUsageFields,
  recordUsage,
  getUsageStats,
  getTodayUsage,
  getRecentUsage,
  resetUsage,
  calculateCost,
  MODEL_PRICING,
  UsageBudget,
  UsageReporter,
};
