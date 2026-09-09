const crypto = require('crypto');
/**
 * Rollback Manager — 进化回滚管理器
 *
 * 为 CrabPaw 进化体系提供完整的回滚能力，补全进化闭环：
 *   验证失败 → 回滚决策 → 执行回滚 → 回滚后验证 → 记录审计日志
 *
 * 回滚策略：
 *   1. SKILL: 回滚 SKILL.md 到上一版本（基于 SkillVersionStore）
 *   2. CONFIG: 回滚配置参数到上一值（基于参数快照）
 *   3. PROMPT: 回滚系统提示词到上一版本（基于提示词快照）
 *
 * 安全约束：
 *   - 回滚操作本身不可回滚（避免无限递归）
 *   - 回滚后进入冷却期（5分钟内不再进化）
 *   - 连续回滚3次触发进化暂停
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

const ROLLBACK_DIR = path.join(DATA_DIR, 'rollback');
const ROLLBACK_LOG_FILE = path.join(ROLLBACK_DIR, 'rollback-log.json');
const ROLLBACK_COOLDOWN_MS = 5 * 60 * 1000;       // 回滚后冷却期 5 分钟
const MAX_CONSECUTIVE_ROLLBACKS = 3;                 // 连续回滚上限
const CONSECUTIVE_WINDOW_MS = 60 * 60 * 1000;       // 连续回滚判定窗口 1 小时

const ROLLBACK_TARGET_TYPES = {
  SKILL: 'skill',
  CONFIG: 'config',
  PROMPT: 'prompt',
};

class RollbackRecord {
  constructor(data = {}) {
    this.id = `rb_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.targetType = data.targetType || ROLLBACK_TARGET_TYPES.SKILL;
    this.targetName = data.targetName || '';
    this.reason = data.reason || '';
    this.triggeredBy = data.triggeredBy || 'validation_failure';
    this.fromVersion = data.fromVersion || null;
    this.toVersion = data.toVersion || null;
    this.success = false;
    this.timestamp = Date.now();
    this.error = null;
  }

  toJSON() {
    return {
      id: this.id,
      targetType: this.targetType,
      targetName: this.targetName,
      reason: this.reason,
      triggeredBy: this.triggeredBy,
      fromVersion: this.fromVersion,
      toVersion: this.toVersion,
      success: this.success,
      timestamp: this.timestamp,
      error: this.error,
    };
  }
}

class RollbackManager extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      cooldownMs: config.cooldownMs || ROLLBACK_COOLDOWN_MS,
      maxConsecutive: config.maxConsecutive || MAX_CONSECUTIVE_ROLLBACKS,
      consecutiveWindowMs: config.consecutiveWindowMs || CONSECUTIVE_WINDOW_MS,
      ...config,
    };

    // 依赖注入
    this._versionStore = config.versionStore || null;
    this._skillEvolver = config.skillEvolver || null;

    // 回滚日志
    this._log = [];

    // 冷却期追踪：targetName → 冷却结束时间
    this._cooldowns = new Map();

    // 进化暂停标记
    this._evolutionPaused = false;
    this._pauseReason = null;

    this._initialized = false;
  }

  /**
   * 初始化
   */
  initialize() {
    if (this._initialized) return;

    if (!fs.existsSync(ROLLBACK_DIR)) {
      fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
    }

    this._loadLog();
    this._initialized = true;

    console.log('[RollbackManager] 初始化完成, 历史回滚 ' + this._log.length + ' 条');
  }

  /**
   * 注入依赖
   */
  setVersionStore(store) {
    this._versionStore = store;
  }

  setSkillEvolver(evolver) {
    this._skillEvolver = evolver;
  }

  // ========== 核心回滚接口 ==========

  /**
   * 执行回滚（EvolutionValidator 调用入口）
   *
   * @param {string} skillName - 技能名
   * @param {object} evolutionRecord - 进化记录
   * @param {object} validationResult - 验证结果
   * @returns {RollbackRecord}
   */
  async rollback(skillName, evolutionRecord, validationResult = {}) {
    if (!this._initialized) this.initialize();

    const record = new RollbackRecord({
      targetType: ROLLBACK_TARGET_TYPES.SKILL,
      targetName: skillName,
      reason: validationResult.reason || 'validation_failure',
      triggeredBy: validationResult.action === 'rollback' ? 'auto_validation' : 'manual',
      fromVersion: evolutionRecord.newVersion || null,
      toVersion: evolutionRecord.parentVersion || null,
    });

    // 检查冷却期
    if (this._isInCooldown(skillName)) {
      record.error = 'target_in_cooldown';
      record.success = false;
      this._log.push(record.toJSON());
      this._saveLog();
      this.emit('rollback:skipped', { skillName, reason: 'cooldown' });
      return record;
    }

    // 检查连续回滚
    if (this._isConsecutiveRollbackLimitReached(skillName)) {
      this._pauseEvolution('consecutive_rollback_limit');
      record.error = 'consecutive_rollback_limit';
      record.success = false;
      this._log.push(record.toJSON());
      this._saveLog();
      this.emit('rollback:paused', { skillName, reason: 'consecutive_limit' });
      return record;
    }

    // 执行回滚
    try {
      const rolledBack = await this._executeSkillRollback(skillName, evolutionRecord);
      if (rolledBack) {
        record.success = true;

        // 设置冷却期
        this._cooldowns.set(skillName, Date.now() + this.config.cooldownMs);

        this.emit('rollback:success', {
          skillName,
          fromVersion: record.fromVersion,
          toVersion: record.toVersion,
        });

        console.log(`[RollbackManager] ${skillName} 回滚成功`);
      } else {
        record.success = false;
        record.error = 'rollback_execution_failed';

        this.emit('rollback:failed', { skillName });
        console.error(`[RollbackManager] ${skillName} 回滚执行失败`);
      }
    } catch (e) {
      record.success = false;
      record.error = e.message;
      console.error(`[RollbackManager] ${skillName} 回滚异常:`, e.message);
    }

    this._log.push(record.toJSON());
    this._trimLog();
    this._saveLog();

    return record;
  }

  /**
   * 回滚配置参数
   */
  async rollbackConfig(paramKey, previousValue, reason = '') {
    if (!this._initialized) this.initialize();

    const record = new RollbackRecord({
      targetType: ROLLBACK_TARGET_TYPES.CONFIG,
      targetName: paramKey,
      reason: reason || 'config_degradation',
    });

    try {
      record.fromVersion = String(this._getCurrentConfigValue(paramKey));
      record.toVersion = String(previousValue);

      // 实际回滚由 AdaptiveTuner 执行
      this.emit('rollback:config', { paramKey, previousValue });
      record.success = true;

      console.log(`[RollbackManager] 配置回滚: ${paramKey} → ${previousValue}`);
    } catch (e) {
      record.success = false;
      record.error = e.message;
    }

    this._log.push(record.toJSON());
    this._saveLog();
    return record;
  }

  // ========== 状态查询 ==========

  /**
   * 是否在冷却期
   */
  isEvolutionAllowed(skillName) {
    if (this._evolutionPaused) return false;
    if (skillName && this._isInCooldown(skillName)) return false;
    return true;
  }

  /**
   * 进化是否暂停
   */
  get isPaused() {
    return this._evolutionPaused;
  }

  get pauseReason() {
    return this._pauseReason;
  }

  /**
   * 恢复进化
   */
  resumeEvolution() {
    this._evolutionPaused = false;
    this._pauseReason = null;
    this.emit('evolution:resumed');
    console.log('[RollbackManager] 进化已恢复');
  }

  /**
   * 获取回滚统计
   */
  getStats() {
    const total = this._log.length;
    const successful = this._log.filter(r => r.success).length;
    const byTarget = {};

    for (const r of this._log) {
      const key = `${r.targetType}:${r.targetName}`;
      if (!byTarget[key]) byTarget[key] = { total: 0, success: 0 };
      byTarget[key].total++;
      if (r.success) byTarget[key].success++;
    }

    return {
      total,
      successful,
      failed: total - successful,
      successRate: total > 0 ? successful / total : 0,
      byTarget,
      isPaused: this._evolutionPaused,
      pauseReason: this._pauseReason,
    };
  }

  // ========== 内部方法 ==========

  /**
   * 执行技能回滚
   */
  async _executeSkillRollback(skillName, evolutionRecord) {
    // 策略1：通过 VersionStore 回滚（优先）
    if (this._versionStore) {
      try {
        const currentVersion = this._versionStore.getCurrentVersion(skillName);
        if (currentVersion) {
          // 获取父版本
          const lineage = this._versionStore.getLineage(skillName);
          if (lineage.length >= 2) {
            const parentVersion = lineage[1]; // lineage[0] 是当前版本
            const rolledBack = await this._versionStore.rollback(skillName, parentVersion.skill_id);
            if (rolledBack) return true;
          }
        }
      } catch (e) {
        console.warn('[RollbackManager] VersionStore 回滚失败，尝试直接文件回滚:', e.message);
      }
    }

    // 策略2：通过 SkillEvolver 的内部回滚方法
    if (this._skillEvolver && typeof this._skillEvolver._rollbackEvolution === 'function') {
      try {
        return await this._skillEvolver._rollbackEvolution(skillName, evolutionRecord);
      } catch (e) {
        console.warn('[RollbackManager] SkillEvolver 回滚失败:', e.message);
      }
    }

    // 策略3：从版本快照直接恢复文件
    if (this._versionStore) {
      try {
        const currentVersion = this._versionStore.getCurrentVersion(skillName);
        if (currentVersion) {
          const lineage = this._versionStore.getLineage(skillName);
          if (lineage.length >= 2) {
            const parentVersion = lineage[1];
            const snapshot = this._versionStore.getSnapshot(parentVersion.skill_id);
            if (snapshot) {
              // 查找技能文件路径
              const skillDir = this._findSkillDir(skillName);
              if (skillDir) {
                const skillMdPath = path.join(skillDir, 'SKILL.md');
                if (fs.existsSync(skillMdPath)) {
                  fs.writeFileSync(skillMdPath, snapshot, 'utf-8');
                  console.log(`[RollbackManager] ${skillName} 通过快照回滚成功`);
                  return true;
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[RollbackManager] 快照回滚失败:', e.message);
      }
    }

    return false;
  }

  /**
   * 查找技能目录
   */
  _findSkillDir(skillName) {
    const { SKILLS_DIR, GLOBAL_SKILLS_DIR } = require('../config');
    const candidates = [
      path.join(SKILLS_DIR, skillName),
      path.join(GLOBAL_SKILLS_DIR, skillName),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    return null;
  }

  /**
   * 获取当前配置值（占位，由 AdaptiveTuner 注入）
   */
  _getCurrentConfigValue(_paramKey) {
    return undefined;
  }

  /**
   * 检查冷却期
   */
  _isInCooldown(skillName) {
    const cooldownEnd = this._cooldowns.get(skillName);
    if (!cooldownEnd) return false;
    if (Date.now() >= cooldownEnd) {
      this._cooldowns.delete(skillName);
      return false;
    }
    return true;
  }

  /**
   * 检查连续回滚是否达到上限
   */
  _isConsecutiveRollbackLimitReached(skillName) {
    const now = Date.now();
    const recentRollbacks = this._log.filter(r =>
      r.targetName === skillName &&
      r.success &&
      now - r.timestamp < this.config.consecutiveWindowMs
    );
    return recentRollbacks.length >= this.config.maxConsecutive;
  }

  /**
   * 暂停进化
   */
  _pauseEvolution(reason) {
    this._evolutionPaused = true;
    this._pauseReason = reason;
    this.emit('evolution:paused', { reason });
    console.warn(`[RollbackManager] 进化已暂停: ${reason}`);
  }

  _trimLog() {
    if (this._log.length > 200) {
      this._log = this._log.slice(-200);
    }
  }

  _loadLog() {
    try {
      if (fs.existsSync(ROLLBACK_LOG_FILE)) {
        this._log = JSON.parse(fs.readFileSync(ROLLBACK_LOG_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('[RollbackManager] 回滚日志加载失败，使用空日志:', e.message);
      this._log = [];
    }
  }

  _saveLog() {
    try {
      if (!fs.existsSync(ROLLBACK_DIR)) {
        fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
      }
      fs.writeFileSync(ROLLBACK_LOG_FILE, JSON.stringify(this._log, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[rollback-manager] persist failed:', e.message);
    }
  }
}

// 单例
let _instance = null;

function getRollbackManager(config = {}) {
  if (!_instance) {
    _instance = new RollbackManager(config);
  }
  return _instance;
}

module.exports = {
  RollbackManager,
  getRollbackManager,
  ROLLBACK_TARGET_TYPES,
  RollbackRecord,
};
