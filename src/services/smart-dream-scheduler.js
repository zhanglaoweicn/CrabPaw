/**
 * Smart Dream Scheduler Service
 * 
 * 智能梦境调度器
 * 根据系统状态智能决定何时触发梦境
 */

const EventEmitter = require('events');

class SmartDreamScheduler extends EventEmitter {
  constructor(config = {}) {
    super();

    this.strategies = {
      idle: {
        priority: 1,
        minIdleTime: config.idleMinTime || 5 * 60 * 1000,
        enabled: config.enableIdleStrategy !== false,
      },
      memory_pressure: {
        priority: 2,
        threshold: config.memoryThreshold || 0.8,
        enabled: config.enableMemoryStrategy !== false,
      },
      session_complete: {
        priority: 3,
        minSessions: config.minSessions || 3,
        enabled: config.enableSessionStrategy !== false,
      },
      scheduled: {
        priority: 4,
        interval: config.scheduledInterval || 24 * 60 * 60 * 1000,
        enabled: config.enableScheduledStrategy !== false,
      },
      token_budget: {
        priority: 5,
        threshold: config.tokenThreshold || 100000,
        enabled: config.enableTokenStrategy !== false,
      },
    };

    this.lastDream = 0;
    this.dreamHistory = [];
    this.cooldownPeriod = config.cooldownPeriod || 60 * 60 * 1000;
    this.maxHistorySize = config.maxHistorySize || 100;
  }

  shouldDream(context = {}) {
    const now = Date.now();

    if (now - this.lastDream < this.cooldownPeriod) {
      return null;
    }

    const scores = [];

    if (this.strategies.idle.enabled && context.idleTime > this.strategies.idle.minIdleTime) {
      scores.push({
        strategy: 'idle',
        score: this.strategies.idle.priority * 10,
        reason: `系统空闲 ${Math.round(context.idleTime / 60000)} 分钟`,
        details: {
          idleTime: context.idleTime,
          threshold: this.strategies.idle.minIdleTime,
        },
      });
    }

    if (this.strategies.memory_pressure.enabled && context.memoryUsage > this.strategies.memory_pressure.threshold) {
      const pressure = context.memoryUsage - this.strategies.memory_pressure.threshold;
      scores.push({
        strategy: 'memory_pressure',
        score: this.strategies.memory_pressure.priority * 10 + pressure * 100,
        reason: `内存使用率 ${Math.round(context.memoryUsage * 100)}%`,
        details: {
          memoryUsage: context.memoryUsage,
          threshold: this.strategies.memory_pressure.threshold,
        },
      });
    }

    if (this.strategies.session_complete.enabled && context.completedSessions >= this.strategies.session_complete.minSessions) {
      scores.push({
        strategy: 'session_complete',
        score: this.strategies.session_complete.priority * 10 + context.completedSessions,
        reason: `已完成 ${context.completedSessions} 个会话`,
        details: {
          completedSessions: context.completedSessions,
          threshold: this.strategies.session_complete.minSessions,
        },
      });
    }

    if (this.strategies.scheduled.enabled && now - this.lastDream > this.strategies.scheduled.interval) {
      scores.push({
        strategy: 'scheduled',
        score: this.strategies.scheduled.priority * 10,
        reason: '距离上次梦境已超过配置间隔',
        details: {
          timeSinceLastDream: now - this.lastDream,
          interval: this.strategies.scheduled.interval,
        },
      });
    }

    if (this.strategies.token_budget.enabled && context.tokensUsed > this.strategies.token_budget.threshold) {
      scores.push({
        strategy: 'token_budget',
        score: this.strategies.token_budget.priority * 10,
        reason: `Token 使用量 ${context.tokensUsed} 超过阈值`,
        details: {
          tokensUsed: context.tokensUsed,
          threshold: this.strategies.token_budget.threshold,
        },
      });
    }

    if (scores.length === 0) {
      return null;
    }

    const best = scores.sort((a, b) => b.score - a.score)[0];
    
    return {
      shouldDream: true,
      strategy: best.strategy,
      reason: best.reason,
      priority: best.score,
      details: best.details,
      allScores: scores,
    };
  }

  recordDream(result) {
    const record = {
      timestamp: Date.now(),
      strategy: result.strategy,
      duration: result.duration || 0,
      memoriesProcessed: result.memoriesProcessed || 0,
      tokensSaved: result.tokensSaved || 0,
      success: result.success !== false,
      error: result.error || null,
    };

    this.dreamHistory.push(record);
    this.lastDream = Date.now();

    if (this.dreamHistory.length > this.maxHistorySize) {
      this.dreamHistory = this.dreamHistory.slice(-this.maxHistorySize);
    }

    this.emit('dream:recorded', record);
  }

  getOptimalDreamWindow() {
    if (this.dreamHistory.length < 5) {
      return {
        optimalHour: 3,
        confidence: 0,
        reason: 'insufficient_data',
      };
    }

    const hourlyStats = new Array(24).fill(0).map(() => ({ count: 0, tokens: 0 }));

    for (const dream of this.dreamHistory) {
      const hour = new Date(dream.timestamp).getHours();
      hourlyStats[hour].count++;
      hourlyStats[hour].tokens += dream.tokensSaved || 0;
    }

    let maxScore = 0;
    let optimalHour = 3;

    for (let hour = 0; hour < 24; hour++) {
      const score = hourlyStats[hour].tokens + hourlyStats[hour].count * 100;
      if (score > maxScore) {
        maxScore = score;
        optimalHour = hour;
      }
    }

    const totalDreams = this.dreamHistory.length;
    const dreamsAtOptimal = hourlyStats[optimalHour].count;

    return {
      optimalHour,
      confidence: dreamsAtOptimal / totalDreams,
      hourlyStats: hourlyStats.map((h, i) => ({
        hour: i,
        count: h.count,
        avgTokens: h.count > 0 ? h.tokens / h.count : 0,
      })),
    };
  }

  getStrategyStats() {
    const stats = {};

    for (const strategy of Object.keys(this.strategies)) {
      const dreams = this.dreamHistory.filter(d => d.strategy === strategy);
      
      stats[strategy] = {
        enabled: this.strategies[strategy].enabled,
        priority: this.strategies[strategy].priority,
        totalDreams: dreams.length,
        successRate: dreams.length > 0
          ? dreams.filter(d => d.success).length / dreams.length
          : 0,
        avgDuration: dreams.length > 0
          ? dreams.reduce((sum, d) => sum + d.duration, 0) / dreams.length
          : 0,
        avgTokensSaved: dreams.length > 0
          ? dreams.reduce((sum, d) => sum + d.tokensSaved, 0) / dreams.length
          : 0,
      };
    }

    return stats;
  }

  getStats() {
    const successful = this.dreamHistory.filter(d => d.success);
    
    return {
      totalDreams: this.dreamHistory.length,
      successfulDreams: successful.length,
      successRate: this.dreamHistory.length > 0
        ? successful.length / this.dreamHistory.length
        : 0,
      lastDreamTime: this.lastDream,
      timeSinceLastDream: Date.now() - this.lastDream,
      totalTokensSaved: successful.reduce((sum, d) => sum + d.tokensSaved, 0),
      avgDuration: successful.length > 0
        ? successful.reduce((sum, d) => sum + d.duration, 0) / successful.length
        : 0,
      strategies: this.getStrategyStats(),
      optimalWindow: this.getOptimalDreamWindow(),
    };
  }

  updateStrategy(strategyName, updates) {
    if (this.strategies[strategyName]) {
      this.strategies[strategyName] = {
        ...this.strategies[strategyName],
        ...updates,
      };
      this.emit('strategy:updated', { strategy: strategyName, updates });
    }
  }

  enableStrategy(strategyName) {
    this.updateStrategy(strategyName, { enabled: true });
  }

  disableStrategy(strategyName) {
    this.updateStrategy(strategyName, { enabled: false });
  }

  clear() {
    this.dreamHistory = [];
    this.lastDream = 0;
    this.emit('cleared');
  }

  export() {
    return {
      strategies: this.strategies,
      dreamHistory: this.dreamHistory,
      lastDream: this.lastDream,
    };
  }

  import(data) {
    if (data?.strategies) {
      this.strategies = { ...this.strategies, ...data.strategies };
    }
    if (data?.dreamHistory) {
      this.dreamHistory = data.dreamHistory;
    }
    if (data?.lastDream) {
      this.lastDream = data.lastDream;
    }
  }
}

const smartDreamScheduler = new SmartDreamScheduler();

module.exports = {
  SmartDreamScheduler,
  smartDreamScheduler,
};
