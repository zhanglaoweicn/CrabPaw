const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { CompactionEngine, CompactionPlanner } = require('./two-phase-compaction');

const DEGRADATION_LEVELS = {
  NONE: 'none',
  LIGHT: 'light',
  MODERATE: 'moderate',
  HEAVY: 'heavy',
  BLOCKED: 'blocked',
};

const DEGRADATION_ACTIONS = {
  [DEGRADATION_LEVELS.NONE]: {
    maxTokensPerRequest: Infinity,
    allowStreaming: true,
    allowExpensiveModels: true,
    allowToolCalls: true,
    allowMemorySearch: true,
    contextWindowSize: 1.0,
  },
  [DEGRADATION_LEVELS.LIGHT]: {
    maxTokensPerRequest: 8000,
    allowStreaming: true,
    allowExpensiveModels: true,
    allowToolCalls: true,
    allowMemorySearch: true,
    contextWindowSize: 0.85,
  },
  [DEGRADATION_LEVELS.MODERATE]: {
    maxTokensPerRequest: 4000,
    allowStreaming: true,
    allowExpensiveModels: false,
    allowToolCalls: true,
    allowMemorySearch: true,
    contextWindowSize: 0.7,
  },
  [DEGRADATION_LEVELS.HEAVY]: {
    maxTokensPerRequest: 2000,
    allowStreaming: false,
    allowExpensiveModels: false,
    allowToolCalls: false,
    allowMemorySearch: true,
    contextWindowSize: 0.5,
  },
  [DEGRADATION_LEVELS.BLOCKED]: {
    maxTokensPerRequest: 0,
    allowStreaming: false,
    allowExpensiveModels: false,
    allowToolCalls: false,
    allowMemorySearch: false,
    contextWindowSize: 0,
  },
};

const EXPENSIVE_MODELS = [
  'deepseek-reasoner',
  'qwen-max', 'qwen-plus',
  'glm-4-plus',
  'doubao-1.5-pro-128k',
  'abab7-chat-preview',
];

const CHEAP_MODELS = [
  'deepseek-chat', 'deepseek-v3',
  'qwen-turbo', 'glm-4-flash', 'glm-4',
  'doubao-1.5-lite-32k', 'doubao-pro-32k',
  'abab6.5s-chat',
];

const BUDGET_PERIODS = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  PER_SESSION: 'per_session',
};

class BudgetEnforcer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._persistencePath = config.persistencePath || null;
    this.config = {
      dailyLimit: config.dailyLimit ?? 50,
      monthlyLimit: config.monthlyLimit ?? 1000,
      perSessionLimit: config.perSessionLimit ?? 200,
      perUserDailyLimit: config.perUserDailyLimit ?? 30,
      perRequestTokenLimit: config.perRequestTokenLimit ?? 128000,
      warningThreshold: config.warningThreshold ?? 0.8,
      criticalThreshold: config.criticalThreshold ?? 0.95,
      hardBlockThreshold: config.hardBlockThreshold ?? 1.0,
      autoDowngradeModels: config.autoDowngradeModels !== false,
      advisoryMode: config.advisoryMode === true,
    };

    this._spending = {
      daily: { amount: 0, date: this._todayKey(), tokens: 0, requests: 0 },
      monthly: { amount: 0, month: this._monthKey(), tokens: 0, requests: 0 },
      session: { amount: 0, tokens: 0, requests: 0, startedAt: Date.now() },
      perUser: new Map(),
    };

    this._currentDegradation = DEGRADATION_LEVELS.NONE;
    this._blocked = false;
    this._blockReason = null;
    this._alertHistory = [];
    this._categoryUsage = {}; // { categoryName: { date, count } }

    this._loadPersistedState();
  }

  _loadPersistedState() {
    const p = this._persistencePath;
    if (!p) return;
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const saved = JSON.parse(raw);
        if (saved && typeof saved === 'object') {
          if (saved._spending) {
            const perUserRaw = saved._spending.perUser || [];
            this._spending = {
              ...saved._spending,
              perUser: new Map(perUserRaw),
            };
          }
          if (saved._categoryUsage) {
            this._categoryUsage = saved._categoryUsage;
          }
          if (saved._alertHistory) {
            this._alertHistory = saved._alertHistory;
          }
        }
      }
    } catch (e) {
      console.warn('[budget] Failed to load persisted state:', e.message);
    }
  }

  _savePersistedState() {
    const p = this._persistencePath;
    if (!p) return;
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        _spending: {
          ...this._spending,
          perUser: Array.from(this._spending.perUser.entries()),
        },
        _categoryUsage: this._categoryUsage,
        _alertHistory: this._alertHistory.slice(-100),
      };
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[budget] Failed to persist state:', e.message);
    }
  }

  _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  _monthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  _resetIfNeeded() {
    const today = this._todayKey();
    if (this._spending.daily.date !== today) {
      this._spending.daily = { amount: 0, date: today, tokens: 0, requests: 0 };
      // Reset all category counters on day change
      for (const cat of Object.keys(this._categoryUsage)) {
        this._categoryUsage[cat] = { date: today, count: 0 };
      }
      this._recalculateDegradation();
    }
    const month = this._monthKey();
    if (this._spending.monthly.month !== month) {
      this._spending.monthly = { amount: 0, month, tokens: 0, requests: 0 };
      this._recalculateDegradation();
    }
  }

  checkRequest(options = {}) {
    this._resetIfNeeded();

    const { model, estimatedTokens, userId, category } = options;
    const actions = DEGRADATION_ACTIONS[this._currentDegradation];
    const warnings = [];

    // Collect all advisory info first (never blocks in advisory mode)
    if (this.config.advisoryMode) {
      const advisory = { allowed: true, degradation: this._currentDegradation, actions, advisoryBudget: { warnings, degraded: this._currentDegradation !== DEGRADATION_LEVELS.NONE } };

      if (this._blocked) {
        warnings.push({ type: 'blocked', message: `预算已耗尽: ${this._blockReason}`, detail: this.getStatus() });
      }

      if (category && CATEGORY_BUDGETS[category]) {
        const budget = CATEGORY_BUDGETS[category];
        const catUsage = this._categoryUsage[category] || { date: this._todayKey(), count: 0 };
        if (catUsage.date !== this._todayKey()) {
          catUsage.date = this._todayKey();
          catUsage.count = 0;
        }
        if (catUsage.count >= budget.dailyLimit) {
          warnings.push({ type: 'category_budget_exceeded', message: `分类 "${category}" 今日预算已用完 (${catUsage.count}/${budget.dailyLimit})`, detail: { category, used: catUsage.count, limit: budget.dailyLimit } });
        }
        this._categoryUsage[category] = catUsage;
      }

      if (estimatedTokens && actions.maxTokensPerRequest !== Infinity && estimatedTokens > actions.maxTokensPerRequest) {
        warnings.push({ type: 'token_limit', message: `预估 token (${estimatedTokens}) 超过当前限制 (${actions.maxTokensPerRequest})`, detail: { estimated: estimatedTokens, limit: actions.maxTokensPerRequest } });
      }

      if (!actions.allowExpensiveModels && model && this._isExpensiveModel(model)) {
        const cheap = this._findCheapAlternative(model);
        warnings.push({ type: 'model_downgrade', message: `模型 "${model}" 在当前预算级别下建议替换为 "${cheap}"`, suggestedModel: cheap, originalModel: model });
      }

      if (!actions.allowToolCalls && options.requiresToolCall) {
        warnings.push({ type: 'tool_calls_blocked', message: '当前预算级别不支持工具调用', detail: { degradation: this._currentDegradation } });
      }

      if (userId) {
        const userSpend = this._spending.perUser.get(userId) || { amount: 0, date: this._todayKey(), tokens: 0 };
        if (userSpend.amount >= this.config.perUserDailyLimit) {
          warnings.push({ type: 'user_limit_exceeded', message: `用户 ${userId} 今日预算已用完 (${userSpend.amount}/${this.config.perUserDailyLimit})`, detail: { userId, used: userSpend.amount, limit: this.config.perUserDailyLimit } });
        }
      }

      return advisory;
    }

    // Normal enforcement mode (existing behavior)
    if (this._blocked) {
      return {
        allowed: false,
        reason: this._blockReason,
        degradation: this._currentDegradation,
        actions: DEGRADATION_ACTIONS[this._currentDegradation],
      };
    }

    // Category-level budget enforcement (CATEGORY_BUDGETS)
    if (category && CATEGORY_BUDGETS[category]) {
      const budget = CATEGORY_BUDGETS[category];
      const catUsage = this._categoryUsage[category] || { date: this._todayKey(), count: 0 };
      if (catUsage.date !== this._todayKey()) {
        catUsage.date = this._todayKey();
        catUsage.count = 0;
      }
      if (catUsage.count >= budget.dailyLimit) {
        return {
          allowed: false,
          reason: `category_budget_exceeded: ${category} (${catUsage.count}/${budget.dailyLimit})`,
          degradation: this._currentDegradation,
          actions,
        };
      }
      this._categoryUsage[category] = catUsage;
    }

    if (estimatedTokens && actions.maxTokensPerRequest !== Infinity) {
      if (estimatedTokens > actions.maxTokensPerRequest) {
        return {
          allowed: false,
          reason: `token_limit_exceeded: ${estimatedTokens} > ${actions.maxTokensPerRequest}`,
          degradation: this._currentDegradation,
          actions,
        };
      }
    }

    if (!actions.allowExpensiveModels && model && this._isExpensiveModel(model)) {
      if (this.config.autoDowngradeModels) {
        const cheap = this._findCheapAlternative(model);
        return {
          allowed: true,
          degraded: true,
          originalModel: model,
          suggestedModel: cheap,
          reason: 'model_downgraded_due_to_budget',
          degradation: this._currentDegradation,
          actions,
        };
      }
      return {
        allowed: false,
        reason: `expensive_model_blocked: ${model}`,
        degradation: this._currentDegradation,
        actions,
      };
    }

    if (!actions.allowToolCalls && options.requiresToolCall) {
      return {
        allowed: false,
        reason: 'tool_calls_blocked_by_budget',
        degradation: this._currentDegradation,
        actions,
      };
    }

    if (userId) {
      const userSpend = this._spending.perUser.get(userId) || { amount: 0, date: this._todayKey(), tokens: 0 };
      if (userSpend.date !== this._todayKey()) {
        this._spending.perUser.set(userId, { amount: 0, date: this._todayKey(), tokens: 0 });
      }
      if (userSpend.amount >= this.config.perUserDailyLimit) {
        return {
          allowed: false,
          reason: `user_daily_limit_exceeded: ${userId}`,
          degradation: this._currentDegradation,
          actions,
        };
      }
    }

    return {
      allowed: true,
      degradation: this._currentDegradation,
      actions,
    };
  }

  recordUsage(provider, model, usage, cost, userId, options = {}) {
    this._resetIfNeeded();

    const promptTokens = usage?.promptTokens || usage?.prompt_tokens || 0;
    const completionTokens = usage?.completionTokens || usage?.completion_tokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const amount = cost?.total || cost || 0;
    const category = options.category || null;

    this._spending.daily.amount += amount;
    this._spending.daily.tokens += totalTokens;
    this._spending.daily.requests++;

    // Track category-level usage if specified
    if (category && CATEGORY_BUDGETS[category]) {
      if (!this._categoryUsage[category] || this._categoryUsage[category].date !== this._todayKey()) {
        this._categoryUsage[category] = { date: this._todayKey(), count: 0 };
      }
      this._categoryUsage[category].count++;
    }

    this._spending.monthly.amount += amount;
    this._spending.monthly.tokens += totalTokens;
    this._spending.monthly.requests++;

    this._spending.session.amount += amount;
    this._spending.session.tokens += totalTokens;
    this._spending.session.requests++;

    if (userId) {
      const userSpend = this._spending.perUser.get(userId) || { amount: 0, date: this._todayKey(), tokens: 0 };
      userSpend.amount += amount;
      userSpend.tokens += totalTokens;
      this._spending.perUser.set(userId, userSpend);
    }

    this._checkThresholds();
    this._savePersistedState();
    this.emit('usage:recorded', {
      provider, model, tokens: totalTokens, amount, userId,
      dailyTotal: this._spending.daily.amount,
      monthlyTotal: this._spending.monthly.amount,
    });
  }

  _checkThresholds() {
    const dailyRatio = this.config.dailyLimit !== Infinity
      ? this._spending.daily.amount / this.config.dailyLimit
      : 0;
    const monthlyRatio = this.config.monthlyLimit !== Infinity
      ? this._spending.monthly.amount / this.config.monthlyLimit
      : 0;
    const sessionRatio = this.config.perSessionLimit !== Infinity
      ? this._spending.session.amount / this.config.perSessionLimit
      : 0;

    const maxRatio = Math.max(dailyRatio, monthlyRatio, sessionRatio);

    const prevDegradation = this._currentDegradation;

    if (maxRatio >= this.config.hardBlockThreshold) {
      this._currentDegradation = DEGRADATION_LEVELS.BLOCKED;
      this._blocked = true;
      this._blockReason = `budget_exhausted: ratio=${maxRatio.toFixed(2)}`;
      this._emitAlert('critical', `预算已耗尽，请求被阻止`, { ratio: maxRatio, daily: dailyRatio, monthly: monthlyRatio });
    } else if (maxRatio >= this.config.criticalThreshold) {
      this._currentDegradation = DEGRADATION_LEVELS.HEAVY;
      this._emitAlert('critical', `预算接近耗尽，进入重度降级`, { ratio: maxRatio });
      this._triggerAutoCompaction('critical', maxRatio);
    } else if (maxRatio >= this.config.warningThreshold) {
      this._currentDegradation = DEGRADATION_LEVELS.MODERATE;
      this._emitAlert('warning', `预算使用超过 ${Math.round(maxRatio * 100)}%，进入中度降级`, { ratio: maxRatio });
      this._triggerAutoCompaction('warning', maxRatio);
    } else if (maxRatio >= this.config.warningThreshold * 0.6) {
      this._currentDegradation = DEGRADATION_LEVELS.LIGHT;
    } else {
      this._currentDegradation = DEGRADATION_LEVELS.NONE;
      this._blocked = false;
      this._blockReason = null;
    }

    if (prevDegradation !== this._currentDegradation) {
      this.emit('degradation:changed', {
        from: prevDegradation,
        to: this._currentDegradation,
        actions: DEGRADATION_ACTIONS[this._currentDegradation],
      });
    }
  }

  /**
   * Auto-compaction trigger when budget thresholds are approached
   * Uses CompactionEngine from two-phase-compaction module
   */
  _triggerAutoCompaction(level, ratio) {
    try {
      if (!this._compactionEngine) {
        const planner = new CompactionPlanner();
        this._compactionEngine = new CompactionEngine({ planner });
      }
      
      this._compactionEngine.on('compaction:complete', (info) => {
        this.emit('compaction:completed', info);
      });
      
      this._compactionEngine.on('compaction:error', (err) => {
        console.debug('[Budget] Compaction error:', err.message);
      });

      const context = {
        totalTokens: this._spending.session.tokens,
        messageCount: this._spending.session.requests,
        sessionAgeMs: Date.now() - (this._spending.session.startedAt || Date.now()),
        budgetLevel: level,
        budgetRatio: ratio,
      };

      const plan = this._compactionEngine.planner.shouldCompact(context);
      if (plan.needed) {
        console.warn(`[Budget] Auto-compaction triggered at ${level} level (${(ratio * 100).toFixed(1)}% budget used), phase=${plan.phase}`);
        this.emit('compaction:triggered', { level, ratio, plan });
      }
    } catch (e) {
      console.debug('[Budget] Auto-compaction failed:', e.message);
    }
  }

  _recalculateDegradation() {
    this._blocked = false;
    this._blockReason = null;
    this._currentDegradation = DEGRADATION_LEVELS.NONE;
    this._checkThresholds();
  }

  _emitAlert(level, message, data) {
    const alert = { level, message, data, timestamp: Date.now() };
    this._alertHistory.push(alert);
    if (this._alertHistory.length > 200) {
      this._alertHistory = this._alertHistory.slice(-100);
    }
    this.emit('alert', alert);
  }

  _isExpensiveModel(model) {
    if (!model) return false;
    const lower = model.toLowerCase();
    return EXPENSIVE_MODELS.some(m => lower.includes(m.toLowerCase()));
  }

  _findCheapAlternative(model) {
    if (!model) return CHEAP_MODELS[0];
    const lower = model.toLowerCase();
    if (lower.includes('gpt-4.1')) return 'gpt-4.1-nano';
    if (lower.includes('gpt-4') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 'gpt-4o-mini';
    if (lower.includes('claude-opus') || lower.includes('claude-sonnet') || lower.includes('claude-fable')) return 'claude-haiku-4-5';
    if (lower.includes('claude')) return 'claude-3.5-haiku';
    if (lower.includes('deepseek')) return 'deepseek-chat';
    if (lower.includes('qwen')) return 'qwen-turbo';
    if (lower.includes('glm')) return 'glm-4-flash';
    if (lower.includes('gemini')) return 'gemini-2.5-flash';
    return CHEAP_MODELS[0];
  }

  getContextWindowScale() {
    return DEGRADATION_ACTIONS[this._currentDegradation].contextWindowSize;
  }

  getMaxTokensForRequest() {
    return DEGRADATION_ACTIONS[this._currentDegradation].maxTokensPerRequest;
  }

  isStreamingAllowed() {
    return DEGRADATION_ACTIONS[this._currentDegradation].allowStreaming;
  }

  areToolCallsAllowed() {
    return DEGRADATION_ACTIONS[this._currentDegradation].allowToolCalls;
  }

  getStatus() {
    this._resetIfNeeded();
    return {
      degradation: this._currentDegradation,
      blocked: this._blocked,
      blockReason: this._blockReason,
      daily: {
        spent: this._spending.daily.amount,
        limit: this.config.dailyLimit,
        ratio: this.config.dailyLimit !== Infinity ? this._spending.daily.amount / this.config.dailyLimit : 0,
        tokens: this._spending.daily.tokens,
        requests: this._spending.daily.requests,
      },
      monthly: {
        spent: this._spending.monthly.amount,
        limit: this.config.monthlyLimit,
        ratio: this.config.monthlyLimit !== Infinity ? this._spending.monthly.amount / this.config.monthlyLimit : 0,
        tokens: this._spending.monthly.tokens,
        requests: this._spending.monthly.requests,
      },
      session: {
        spent: this._spending.session.amount,
        limit: this.config.perSessionLimit,
        tokens: this._spending.session.tokens,
        requests: this._spending.session.requests,
      },
      userCount: this._spending.perUser.size,
      recentAlerts: this._alertHistory.slice(-5),
    };
  }

  getBudgetContext(format = 'short') {
    this._resetIfNeeded();
    const s = this._spending;
    const cfg = this.config;
    const dailyRatio = cfg.dailyLimit !== Infinity ? (s.daily.amount / cfg.dailyLimit * 100).toFixed(0) : 'N/A';
    const monthlyRatio = cfg.monthlyLimit !== Infinity ? (s.monthly.amount / cfg.monthlyLimit * 100).toFixed(0) : 'N/A';

    if (format === 'short') {
      return `预算: 今日 ${s.daily.amount}/${cfg.dailyLimit} (${dailyRatio}%), 本月 ${s.monthly.amount}/${cfg.monthlyLimit} (${monthlyRatio}%), 状态: ${this._currentDegradation}`;
    }

    if (format === 'prompt') {
      const lines = [
        '--- 预算上下文 ---',
        `当前预算级别: ${this._currentDegradation}`,
        `今日花费: ${s.daily.amount}/${cfg.dailyLimit} (${dailyRatio}%)`,
        `本月花费: ${s.monthly.amount}/${cfg.monthlyLimit} (${monthlyRatio}%)`,
        `本次会话: ${s.session.amount}/${cfg.perSessionLimit}`,
      ];
      if (!DEGRADATION_ACTIONS[this._currentDegradation].allowExpensiveModels) {
        lines.push('注意: 当前预算级别下应优先使用经济型号');
        lines.push(`可选经济型号: ${CHEAP_MODELS.slice(0, 4).join(', ')}`);
      }
      if (!DEGRADATION_ACTIONS[this._currentDegradation].allowToolCalls) {
        lines.push('注意: 当前预算级别下工具调用功能受限');
      }
      if (!DEGRADATION_ACTIONS[this._currentDegradation].allowStreaming) {
        lines.push('注意: 当前预算级别下流式输出已关闭');
      }
      lines.push('--- 预算上下文结束 ---');
      return lines.join('\n');
    }

    return this.getStatus();
  }

  getAdvisorySuggestion(options = {}) {
    const mode = this.config.advisoryMode;
    this.config.advisoryMode = false;
    const result = this.checkRequest(options);
    this.config.advisoryMode = mode;
    return {
      wouldAllow: result.allowed,
      wouldDegrade: result.degraded || false,
      wouldBlock: !result.allowed,
      reason: result.reason || null,
      suggestedModel: result.suggestedModel || null,
      currentDegradation: this._currentDegradation,
      usage: {
        daily: `${this._spending.daily.amount}/${this.config.dailyLimit}`,
        monthly: `${this._spending.monthly.amount}/${this.config.monthlyLimit}`,
        session: `${this._spending.session.amount}/${this.config.perSessionLimit}`,
      },
    };
  }

  resetSession() {
    this._spending.session = { amount: 0, tokens: 0, requests: 0, startedAt: Date.now() };
    this._recalculateDegradation();
  }

  forceDegradation(level) {
    const upperLevel = level.toUpperCase();
    if (!DEGRADATION_LEVELS[upperLevel]) return false;
    this._currentDegradation = DEGRADATION_LEVELS[upperLevel];
    if (this._currentDegradation === DEGRADATION_LEVELS.BLOCKED) {
      this._blocked = true;
      this._blockReason = 'forced_block';
    }
    this._savePersistedState();
    this.emit('degradation:forced', { level: this._currentDegradation });
    return true;
  }

  releaseBlock() {
    this._blocked = false;
    this._blockReason = null;
    this._recalculateDegradation();
    this._savePersistedState();
    this.emit('block:released');
  }
}

let _instance = null;

function getBudgetEnforcer(config) {
  if (!_instance) {
    _instance = new BudgetEnforcer(config);
  }
  return _instance;
}

// Category-level budgets for fine-grained cost control
const CATEGORY_BUDGETS = {
  // 2026-08-18: 30 → 60（voice_shell 重度使用 + 每次交互多轮工具循环, 30 次
  // 白天即耗尽, 实机晚上问天气被拦）。internal 分类: 只统计不拦截（dailyLimit
  // Infinity）——silent 内部任务(记忆提取/清理)与用户请求解耦, 不再抢用户配额。
  reasoning: { label: '推理/生成', dailyLimit: 60, color: '#ef4444' },
  // 2026-08-28 发布决策: 20 → 200——多轮工具循环(生成类/研究类任务单请求可达
  // 10-20 次调用)在 20/日下一次任务即触顶拦截; 200 支撑全天重度使用, 成本仍由
  // reasoning 类预算与模型侧费用兜底。
  tool_call: { label: '工具调用', dailyLimit: 200, color: '#f97316' },
  memory: { label: '记忆检索', dailyLimit: 15, color: '#eab308' },
  streaming: { label: '流式输出', dailyLimit: 5, color: '#22c55e' },
  tool_validation: { label: '工具契约校验', dailyLimit: 100, color: '#3b82f6' },
  observability: { label: '可观测', dailyLimit: 50, color: '#8b5cf6' },
  internal: { label: '内部任务', dailyLimit: Infinity, color: '#94a3b8' },
  // 2026-08-27 P1-3: 技能自进化激活——后台 review/curator/evolver LLM 调用统一
  // 走 BudgetedEvolutionClient 记账，20 次/日封顶（超限返回 null 优雅降级）。
  evolution: { label: '技能自进化', dailyLimit: 20, color: '#10b981' },
};

module.exports = {
  BudgetEnforcer,
  getBudgetEnforcer,
  DEGRADATION_LEVELS,
  DEGRADATION_ACTIONS,
  EXPENSIVE_MODELS,
  CHEAP_MODELS,
  BUDGET_PERIODS,
  CATEGORY_BUDGETS,
};
