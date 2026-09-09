/**
 * Memory Decay Engine v2 — Ebbinghaus Forgetting Curve (YourMemory 启发)
 *
 * 升级点:
 *   1. 分类半衰期 — 不同类型的记忆衰减速度不同
 *   2. 重要性因子 — 重要的记忆慢忘
 *   3. 回忆次数加成 — 被多次检索的记忆更抗遗忘
 *   4. 活跃天数 — 只在"被使用的天数"上衰减，假期不遗忘
 *
 * 公式: strength = clamp(importance × e^(-λ × activeDays) × (1 + recallCount × 0.2), 0, 1)
 *   λ = ln(2) / halfLife  (衰减速率)
 *   半衰期按类别: strategy(38d) > fact(24d) > preference(30d) > assumption(19d) > ephemeral(11d)
 */


const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars -- require 解构的 getDecayRate/getImportanceWeight 暂未使用（保留分类器导出对齐）
const { getDecayRate, getImportanceWeight } = require('./sector-classifier');

// ── 类别半衰期（天）─────────────────────────────────────────
const CATEGORY_HALF_LIVES = {
  strategy: 38,      // 长期策略，慢忘
  preference: 30,    // 用户偏好，慢忘
  fact: 24,          // 事实信息，正常
  project: 20,       // 项目信息，正常
  assumption: 19,    // 假设，较快忘
  correction: 25,    // 修正反馈，较慢忘
  ephemeral: 11,     // 临时信息，快忘
  insight: 14,       // 洞察，中等
  feedback: 25,      // 反馈，较慢忘
  note: 30,          // 笔记，慢忘
  default: 24,       // 默认
};

const SECTOR_TO_CATEGORY = {
  semantic: 'fact',
  episodic: 'ephemeral',
  procedural: 'strategy',
  emotional: 'ephemeral',
  reflective: 'insight',
};

const MIN_TRUST_THRESHOLD = 0.05;
const PRUNE_THRESHOLD = 0.02;
const DECAY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6小时

class MemoryDecayEngine extends EventEmitter {
  constructor(memoryManager, config = {}) {
    super();
    this.memoryManager = memoryManager;
    this.config = {
      categoryHalfLives: { ...CATEGORY_HALF_LIVES, ...config.categoryHalfLives },
      minTrustThreshold: config.minTrustThreshold || MIN_TRUST_THRESHOLD,
      pruneThreshold: config.pruneThreshold || PRUNE_THRESHOLD,
      decayCheckIntervalMs: config.decayCheckIntervalMs || DECAY_CHECK_INTERVAL_MS,
      ...config,
    };
    this._decayTimer = null;
    this._reinforcementLog = new Map();
    this._decayStats = {
      totalDecayed: 0, totalReinforced: 0, totalConsolidated: 0, totalPruned: 0,
      lastDecayRun: null, totalCycles: 0,
    };
  }

  start() {
    if (this._decayTimer) return;
    this._runDecayCycle().catch(e => {
      console.warn('[memory-decay] 首次运行失败:', e.message);
    });
    this._decayTimer = setInterval(() => {
      this._runDecayCycle().catch(e => {
        console.warn('[memory-decay] 周期失败:', e.message);
      });
    }, this.config.decayCheckIntervalMs);
    if (this._decayTimer.unref) this._decayTimer.unref();
  }

  stop() {
    if (this._decayTimer) { clearInterval(this._decayTimer); this._decayTimer = null; }
  }

  /**
   * Ebbinghaus 遗忘曲线核心计算
   * @param {number} importance — 重要性 0-1
   * @param {number} activeDays — 活跃天数
   * @param {number} recallCount — 被检索次数
   * @param {string} category — 记忆类别
   * @returns {number} 遗忘后的强度 0-1
   */
  calculateStrength(importance, activeDays, recallCount, category = 'default') {
    const halfLife = this.config.categoryHalfLives[category] || this.config.categoryHalfLives.default;
    const lambda = Math.log(2) / halfLife; // 衰减速率
    const decayPart = Math.exp(-lambda * activeDays);
    const recallBoost = 1 + Math.min(recallCount, 20) * 0.2; // 最多 5x 加成
    const rawStrength = importance * decayPart * recallBoost;
    return Math.max(0, Math.min(1, rawStrength));
  }

  /**
   * 计算活跃天数（只在有访问记录的日期上计数）
   */
  _calculateActiveDays(accessTimestamps, createdAt) {
    if (!accessTimestamps || accessTimestamps.length === 0) {
      // 无访问记录，按创建时间计算自然天数
      return Math.max(0, (Date.now() - createdAt) / (24 * 60 * 60 * 1000));
    }
    // 统计去重的活跃天数
    const uniqueDays = new Set(
      accessTimestamps.map(ts => Math.floor(ts / (24 * 60 * 60 * 1000)))
    );
    return uniqueDays.size;
  }

  async _runDecayCycle() {
    const now = Date.now();
    const results = { decayed: 0, reinforced: 0, consolidated: 0, pruned: 0, errors: [] };
    const em = this.memoryManager.enhancedMemory;
    if (!em) return results;

    try {
      const memory = await em.hybridManager.getMemory();
      const facts = memory.facts || [];
      if (facts.length === 0) return results;

      for (let i = 0; i < facts.length; i++) {
        const fact = facts[i];
        try {
          const importance = fact.trustScore || fact.importance || 0.5;
          const accessTimestamps = fact.accessTimestamps || [];
          if (fact.lastAccessedAt && !accessTimestamps.length) {
            accessTimestamps.push(fact.lastAccessedAt);
          }
          const activeDays = this._calculateActiveDays(accessTimestamps, fact.createdAt || now);
          const recallCount = fact.recallCount || fact.accessCount || 0;
          const sector = fact.sector || 'semantic';
          const category = fact.category || fact.type || SECTOR_TO_CATEGORY[sector] || 'default';
          const oldStrength = fact.strength || importance;

          const newStrength = this.calculateStrength(importance, activeDays, recallCount, category);

          facts[i] = {
            ...fact,
            strength: newStrength,
            trustScore: newStrength, // 向后兼容
            lastDecayedAt: now,
            activeDays,
          };

          const delta = oldStrength - newStrength;
          if (delta > 0.01) results.decayed++;
          if (newStrength <= this.config.pruneThreshold) {
            facts[i].pruned = true;
            facts[i].prunedAt = now;
            results.pruned++;
          }
        } catch (e) {
          results.errors.push({ factId: fact.id, error: e.message });
        }
      }

      // ── 软删除: 标记为 historical，不真删 (Martian-Engineering 启发) ──
      let prunedCount = 0;
      const updatedFacts = facts.map(f => {
        if (f.pruned) {
          prunedCount++;
          // 不删除，标记为 historical + 记录修剪时间
          return { ...f, pruned: true, status: 'historical', archivedAt: now, prunedAt: undefined };
        }
        return f;
      });

      if (prunedCount > 0) {
        await em.hybridManager.updateMemory(undefined, { facts: updatedFacts });
      }

      this._decayStats.totalDecayed += results.decayed;
      this._decayStats.totalPruned += prunedCount;
      this._decayStats.lastDecayRun = now;
      this._decayStats.totalCycles++;

      if (results.decayed > 0 || prunedCount > 0) {
        console.log(`[memory-decay] 周期完成: ${results.decayed} 衰减, ${prunedCount} 归档为historical (${updatedFacts.length} 保留)`);
      }

      this.emit('decay:complete', results);
    } catch (e) {
      this.emit('decay:error', { error: e.message });
    }
    return results;
  }

  async reinforce(factId, feedbackType = 'positive') {
    const em = this.memoryManager.enhancedMemory;
    if (!em) return null;
    try {
      const fact = await em.getFact(factId);
      if (!fact) return null;
      const boostMap = { positive: 0.15, access: 0.05, negative: -0.30 };
      const boost = boostMap[feedbackType] || 0;
      const newStrength = Math.max(0, Math.min(1, (fact.strength || fact.trustScore || 0.5) + boost));
      const now = Date.now();
      const accessTimestamps = [...(fact.accessTimestamps || []), now];
      const recallCount = (fact.recallCount || fact.accessCount || 0) + 1;
      await em.updateFact(factId, {
        trustScore: newStrength, strength: newStrength,
        lastAccessedAt: now, accessTimestamps, recallCount,
      });
      this._decayStats.totalReinforced++;
      this.emit('memory:reinforced', { factId, feedbackType, newStrength });
      return { factId, newStrength };
    } catch (e) { return null; }
  }

  async reinforceByAccess(factIds) {
    const results = [];
    for (const id of factIds) {
      try {
        const r = await this.reinforce(id, 'access');
        if (r) results.push(r);
      } catch (e) {
        /* skip */
        console.warn('[memory-decay.js] 空 catch 补日志:', e && e.message);
      }

    }
    return results;
  }

  getStats() {
    return { ...this._decayStats, config: { categories: Object.keys(this.config.categoryHalfLives) } };
  }

  getHealthReport() {
    const s = this._decayStats;
    const total = s.totalDecayed + s.totalConsolidated + s.totalReinforced;
    const decayRatio = total > 0 ? s.totalDecayed / total : 0;
    return {
      status: decayRatio > 0.5 ? 'degraded' : decayRatio > 0.3 ? 'warning' : 'healthy',
      decayRatio, prunedTotal: s.totalPruned,
      recommendations: decayRatio > 0.5
        ? ['衰减率偏高，建议增加记忆访问频率或检查类别半衰期配置']
        : [],
    };
  }
}

module.exports = { MemoryDecayEngine, CATEGORY_HALF_LIVES };
