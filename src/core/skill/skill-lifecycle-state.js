/**
 * Skill Lifecycle — 技能生命周期状态机
 *
 * ⚠️ 2026-08-18 决策(双 SkillLifecycleManager 并存, **评估后不合并**):
 *   本文件(状态机 active/stale/archived, 由 evolution/index.js:29,105 构造并注入
 *   skill-curator, 数据文件 data/.crabpaw/evolution/lifecycle.json)与
 *   src/core/skill-lifecycle.js(JSON 持久化单例 getSkillLifecycleManager(),
 *   评分链 recordSkillUsage/recordSkillGenerated, 数据文件 skill-lifecycle.json)
 *   是两个职责独立的系统: 状态机(老化驱动) vs 使用统计(评分/归档驱动),
 *   API 与数据格式均不同(register/markUsed/evaluate vs
 *   recordSkillUsage/archiveUnusedSkills), 消费方互不读取对方文件。
 *   合并是架构重构而非缺陷修复(双方各自工作正常, 无用户可感知问题),
 *   需同步改造 7 个消费方 + 数据迁移, 收益仅是认知简化 →
 *   **决定不合并**。若未来出现双写不一致/单点故障, 再以统一状态模型
 *   (state + usageCount 合并为单文件单管理器)立项重构。
 *
 * 实现技能的完整生命周期管理：
 *
 *   active ──(30天未使用)──> stale ──(90天未使用)──> archived
 *     ▲                                                   │
 *     └────────────────(恢复)─────────────────────────────┘
 *
 *   pinned = true → 跳过所有自动转换
 *
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// 状态定义
// ============================================================

const LIFECYCLE_STATES = {
  ACTIVE: 'active',       // 正常使用中
  STALE: 'stale',         // 不活跃，降低加载优先级
  ARCHIVED: 'archived',   // 已归档，移至 .archive/ 目录
};

// ============================================================
// 配置默认值
// ============================================================

const DEFAULT_CONFIG = {
  staleAfterDays: 30,       // 多少天未使用 → stale
  archiveAfterDays: 90,     // 多少天未使用 → archived
  minUsageForActive: 3,     // 最少使用次数才评估
  checkIntervalHours: 168,  // 7 天检查一次
};

// ============================================================
// SkillLifecycleManager
// ============================================================

class SkillLifecycleManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    /** @type {Map<string, object>} skillName → lifecycle record */
    this._records = new Map();
    /** @type {Set<string>} 已被 pinned 的技能 */
    this._pinned = new Set();
    /** @type {string|null} 数据文件路径 */
    this._dataPath = config.dataPath || null;
    this._initialized = false;
  }

  /**
   * 事件订阅占位——2026-08-18 补: register() 对已存在记录调用 this.emit('state:changed'),
   * 此前类中无 emit 方法 → 二次 register 同一技能即 TypeError。演化侧尚未订阅,占位保留。
   */
  emit() {}

  /**
   * 初始化并加载持久化数据
   * @param {string} dataPath - 数据文件路径
   */
  initialize(dataPath) {
    if (this._initialized) return;
    this._dataPath = dataPath || this._dataPath;
    this._load();
    this._initialized = true;
    console.log('[SkillLifecycle] 初始化完成');
  }

  // ============================================================
  // 核心操作
  // ============================================================

  /**
   * 注册一个新技能（或更新已有技能的最后使用时间）
   * @param {string} skillName
   * @param {string} provenance - 'foreground' | 'background_review' | 'bundled' | 'hub_installed'
   */
  register(skillName, provenance = 'foreground') {
    const existing = this._records.get(skillName);
    const now = new Date().toISOString();

    if (existing) {
      existing.lastUsedAt = now;
      existing.usageCount = (existing.usageCount || 0) + 1;

      // 使用可以使 archived → active（恢复）
      if (existing.state === LIFECYCLE_STATES.ARCHIVED) {
        existing.state = LIFECYCLE_STATES.ACTIVE;
        existing.stateChangedAt = now;
        this.emit('state:changed', {
          skill: skillName,
          from: LIFECYCLE_STATES.ARCHIVED,
          to: LIFECYCLE_STATES.ACTIVE,
        });
      }
    } else {
      this._records.set(skillName, {
        name: skillName,
        state: LIFECYCLE_STATES.ACTIVE,
        createdAt: now,
        lastUsedAt: now,
        stateChangedAt: now,
        usageCount: 1,
        provenance,
      });
    }

    this._save();
  }

  /**
   * 记录技能被使用（在技能执行时调用）
   */
  markUsed(skillName) {
    const record = this._records.get(skillName);
    if (!record) return;

    record.lastUsedAt = new Date().toISOString();
    record.usageCount = (record.usageCount || 0) + 1;

    // 如果在 stale 状态被使用，恢复为 active
    if (record.state === LIFECYCLE_STATES.STALE) {
      record.state = LIFECYCLE_STATES.ACTIVE;
      record.stateChangedAt = new Date().toISOString();
    }
  }

  /**
   * Pin 一个技能（永远不自动归档）
   */
  pin(skillName) {
    this._pinned.add(skillName);
    this._save();
  }

  /**
   * Unpin 一个技能
   */
  unpin(skillName) {
    this._pinned.delete(skillName);
    this._save();
  }

  /**
   * 检查是否被 pinned
   */
  isPinned(skillName) {
    return this._pinned.has(skillName);
  }

  // ============================================================
  // 状态评估（由 Curator 定期调用）
  // ============================================================

  /**
   * 评估所有技能的生命周期状态，执行状态转移
   * @returns {{ transitions: Array, summary: string }}
   */
  evaluate() {
    const now = Date.now();
    const transitions = [];

    for (const [name, record] of this._records) {
      // Pinned 技能跳过
      if (this._pinned.has(name)) continue;

      // 仅操作 agent-created 和 bundled 技能
      if (record.provenance === 'foreground') continue;

      const lastUsed = new Date(record.lastUsedAt).getTime();
      const daysSinceUsed = (now - lastUsed) / (1000 * 60 * 60 * 24);

      let newState = null;

      if (record.state === LIFECYCLE_STATES.ACTIVE && daysSinceUsed >= this.config.staleAfterDays) {
        newState = LIFECYCLE_STATES.STALE;
      } else if (record.state === LIFECYCLE_STATES.STALE && daysSinceUsed >= this.config.archiveAfterDays) {
        newState = LIFECYCLE_STATES.ARCHIVED;
      }

      if (newState) {
        const oldState = record.state;
        record.state = newState;
        record.stateChangedAt = new Date().toISOString();
        transitions.push({
          skill: name,
          from: oldState,
          to: newState,
          daysSinceUsed: Math.round(daysSinceUsed),
        });
      }
    }

    if (transitions.length > 0) {
      this._save();
    }

    return {
      transitions,
      summary: transitions.length > 0
        ? `${transitions.length} skills transitioned: ${transitions.map(t => `${t.skill}: ${t.from}→${t.to}`).join(', ')}`
        : 'No state transitions',
    };
  }

  // ============================================================
  // 查询
  // ============================================================

  /** 获取技能当前状态 */
  getState(skillName) {
    const record = this._records.get(skillName);
    return record ? record.state : null;
  }

  /** 获取完整记录 */
  getRecord(skillName) {
    return this._records.get(skillName) || null;
  }

  /** 获取所有 active 技能 */
  getActiveSkills() {
    const active = [];
    for (const [name, record] of this._records) {
      if (record.state === LIFECYCLE_STATES.ACTIVE) {
        active.push(name);
      }
    }
    return active;
  }

  /** 获取所有 stale 技能 */
  getStaleSkills() {
    const stale = [];
    for (const [name, record] of this._records) {
      if (record.state === LIFECYCLE_STATES.STALE) {
        stale.push(name);
      }
    }
    return stale;
  }

  /** 获取统计信息 */
  getStats() {
    const stats = {
      total: this._records.size,
      active: 0,
      stale: 0,
      archived: 0,
      pinned: this._pinned.size,
    };

    for (const [, record] of this._records) {
      if (record.state === LIFECYCLE_STATES.ACTIVE) stats.active++;
      else if (record.state === LIFECYCLE_STATES.STALE) stats.stale++;
      else if (record.state === LIFECYCLE_STATES.ARCHIVED) stats.archived++;
    }

    return stats;
  }

  // ============================================================
  // 持久化
  // ============================================================

  _load() {
    if (!this._dataPath) return;
    try {
      if (fs.existsSync(this._dataPath)) {
        const data = JSON.parse(fs.readFileSync(this._dataPath, 'utf-8'));
        if (data.records) {
          this._records = new Map(Object.entries(data.records));
        }
        if (data.pinned) {
          this._pinned = new Set(data.pinned);
        }
      }
    } catch (err) {
      console.warn('[SkillLifecycle] 加载数据失败:', err.message);
    }
  }

  _save() {
    if (!this._dataPath) return;
    try {
      const dir = path.dirname(this._dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        records: Object.fromEntries(this._records),
        pinned: [...this._pinned],
        savedAt: new Date().toISOString(),
      };

      const tmpPath = this._dataPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._dataPath);
    } catch (err) {
      console.warn('[SkillLifecycle] 保存数据失败:', err.message);
    }
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  LIFECYCLE_STATES,
  SkillLifecycleManager,
};
