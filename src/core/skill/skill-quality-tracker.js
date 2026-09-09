/**
 * Skill Quality Tracker — 技能质量追踪器
 *
 * 参考 OpenSpace ToolQualityManager 设计，为 CrabPaw 提供：
 * - 执行成功率/失败率追踪（滑动窗口）
 * - 连续失败检测与惩罚因子计算
 * - LLM 语义质量评估注入
 * - 质量感知排序（penalty 融入技能选择）
 *
 * 存储采用 SQLite WAL 模式，与现有 history-sqlite 兼容。
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../config');

const DB_PATH = path.join(DATA_DIR, 'skill-quality.db');

const MAX_RECENT_EXECUTIONS = 100;
const PENALTY_THRESHOLD = 0.4;
const MIN_CALLS_FOR_PENALTY = 3;

class SkillQualityTracker {
  constructor(config = {}) {
    this.dbPath = config.dbPath || DB_PATH;
    this.maxRecent = config.maxRecent || MAX_RECENT_EXECUTIONS;
    this.penaltyThreshold = config.penaltyThreshold || PENALTY_THRESHOLD;
    this.minCallsForPenalty = config.minCallsForPenalty || MIN_CALLS_FOR_PENALTY;
    this._records = new Map();
    this._globalExecutionCount = 0;
    this._dirty = false;
    this._saveTimer = null;
    this._db = null;
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this._db = new Database(this.dbPath);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');

      this._db.exec(`
        CREATE TABLE IF NOT EXISTS quality_records (
          skill_key TEXT PRIMARY KEY,
          skill_name TEXT NOT NULL,
          total_calls INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          total_execution_time_ms REAL DEFAULT 0,
          recent_executions TEXT DEFAULT '[]',
          llm_flagged_count INTEGER DEFAULT 0,
          description_hash TEXT,
          first_seen TEXT DEFAULT (datetime('now')),
          last_updated TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS global_stats (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          execution_count INTEGER DEFAULT 0
        );

        INSERT OR IGNORE INTO global_stats (id, execution_count) VALUES (1, 0);
      `);

      // 迁移：添加 provenance 列（如果不存在）
      try {
        this._db.exec(`ALTER TABLE quality_records ADD COLUMN provenance TEXT DEFAULT 'unknown'`);
      } catch (e) { console.warn('[skill-quality-tracker] ALTER TABLE migration failed (column may already exist):', e.message); }

      this._loadFromDB();
      this._initialized = true;

      // 定期保存脏数据
      this._saveTimer = setInterval(() => {
        if (this._dirty) this._flush();
      }, 30000);

      console.log(`[QualityTracker] 初始化完成, ${this._records.size} 条记录, 全局执行 ${this._globalExecutionCount} 次`);
    } catch (e) {
      console.error('[QualityTracker] 初始化失败:', e.message);
      // 降级为纯内存模式
      this._db = null;
      this._initialized = true;
    }
  }

  _loadFromDB() {
    if (!this._db) return;

    const rows = this._db.prepare('SELECT * FROM quality_records').all();
    for (const row of rows) {
      const recent = JSON.parse(row.recent_executions || '[]');
      this._records.set(row.skill_key, {
        skillKey: row.skill_key,
        skillName: row.skill_name,
        totalCalls: row.total_calls,
        successCount: row.success_count,
        totalExecutionTimeMs: row.total_execution_time_ms,
        recentExecutions: recent,
        llmFlaggedCount: row.llm_flagged_count,
        descriptionHash: row.description_hash,
        firstSeen: row.first_seen,
        lastUpdated: row.last_updated,
        provenance: row.provenance || 'unknown',
      });
    }

    const stats = this._db.prepare('SELECT execution_count FROM global_stats WHERE id = 1').get();
    this._globalExecutionCount = stats ? stats.execution_count : 0;
  }

  _flush() {
    if (!this._db) return;

    try {
      const upsert = this._db.prepare(`
        INSERT INTO quality_records (skill_key, skill_name, total_calls, success_count,
          total_execution_time_ms, recent_executions, llm_flagged_count,
          description_hash, provenance, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(skill_key) DO UPDATE SET
          total_calls = excluded.total_calls,
          success_count = excluded.success_count,
          total_execution_time_ms = excluded.total_execution_time_ms,
          recent_executions = excluded.recent_executions,
          llm_flagged_count = excluded.llm_flagged_count,
          description_hash = excluded.description_hash,
          provenance = excluded.provenance,
          last_updated = datetime('now')
      `);

      const updateGlobal = this._db.prepare(
        'UPDATE global_stats SET execution_count = ? WHERE id = 1'
      );

      const batch = this._db.transaction(() => {
        for (const record of this._records.values()) {
          upsert.run(
            record.skillKey,
            record.skillName,
            record.totalCalls,
            record.successCount,
            record.totalExecutionTimeMs,
            JSON.stringify(record.recentExecutions.slice(-this.maxRecent)),
            record.llmFlaggedCount,
            record.descriptionHash,
            record.provenance || 'unknown'
          );
        }
        updateGlobal.run(this._globalExecutionCount);
      });

      batch();
      this._dirty = false;
    } catch (e) {
      console.error('[QualityTracker] flush 失败:', e.message);
    }
  }

  /**
   * 记录一次技能执行
   */
  recordExecution(skillName, { success, durationMs, error = null, context = {} }) {
    const key = this._makeKey(skillName);
    let record = this._records.get(key);

    if (!record) {
      record = {
        skillKey: key,
        skillName,
        totalCalls: 0,
        successCount: 0,
        totalExecutionTimeMs: 0,
        recentExecutions: [],
        llmFlaggedCount: 0,
        descriptionHash: null,
        firstSeen: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        provenance: context.provenance || 'unknown',
      };
      this._records.set(key, record);
    }

    record.totalCalls++;
    record.totalExecutionTimeMs += durationMs || 0;
    if (success) record.successCount++;

    record.recentExecutions.push({
      ts: Date.now(),
      success,
      durationMs: durationMs || 0,
      error: error ? String(error).substring(0, 500) : null,
      context: context.taskType || null,
    });

    // 滑动窗口裁剪
    if (record.recentExecutions.length > this.maxRecent) {
      record.recentExecutions = record.recentExecutions.slice(-this.maxRecent);
    }

    record.lastUpdated = new Date().toISOString();
    this._globalExecutionCount++;
    this._dirty = true;

    return record;
  }

  /**
   * 注入 LLM 语义评估（不增加 totalCalls，仅补充 recentExecutions）
   * 参考 OpenSpace add_llm_issue() 设计
   */
  addLLMFlag(skillName, description) {
    const key = this._makeKey(skillName);
    const record = this._records.get(key);
    if (!record) return;

    record.llmFlaggedCount++;
    record.recentExecutions.push({
      ts: Date.now(),
      success: false,
      durationMs: 0,
      error: `[LLM] ${String(description).substring(0, 500)}`,
      context: null,
    });

    if (record.recentExecutions.length > this.maxRecent) {
      record.recentExecutions = record.recentExecutions.slice(-this.maxRecent);
    }

    record.lastUpdated = new Date().toISOString();
    this._dirty = true;
  }

  /**
   * 计算惩罚因子（0.2 ~ 1.0）
   * 参考 OpenSpace ToolQualityRecord.penalty 设计
   */
  getPenalty(skillName) {
    const key = this._makeKey(skillName);
    const record = this._records.get(key);
    if (!record || record.totalCalls < this.minCallsForPenalty) return 1.0;

    const recentRate = this._getRecentSuccessRate(record);
    if (recentRate >= this.penaltyThreshold) return 1.0;

    let penalty = 0.3 + (recentRate / this.penaltyThreshold) * 0.7;

    // 连续失败加重惩罚
    const consec = this._getConsecutiveFailures(record);
    if (consec >= 3) {
      penalty -= Math.min(0.3, (consec - 2) * 0.1);
    }

    return Math.max(0.2, Math.min(1.0, penalty));
  }

  /**
   * 获取技能质量报告
   */
  getQualityReport(skillName) {
    const key = this._makeKey(skillName);
    const record = this._records.get(key);
    if (!record) return null;

    return {
      skillName,
      totalCalls: record.totalCalls,
      successCount: record.successCount,
      successRate: record.totalCalls > 0
        ? record.successCount / record.totalCalls : 0,
      recentSuccessRate: this._getRecentSuccessRate(record),
      avgExecutionTimeMs: record.totalCalls > 0
        ? record.totalExecutionTimeMs / record.totalCalls : 0,
      consecutiveFailures: this._getConsecutiveFailures(record),
      penalty: this.getPenalty(skillName),
      llmFlaggedCount: record.llmFlaggedCount,
      provenance: record.provenance || 'unknown',
      lastUpdated: record.lastUpdated,
    };
  }

  /**
   * 设置技能来源（builtin/hub/user/agent）
   */
  setProvenance(skillName, provenance) {
    const key = this._makeKey(skillName);
    const record = this._records.get(key);
    if (record) {
      record.provenance = provenance;
      this._dirty = true;
    }
  }

  /**
   * 获取所有技能的质量摘要（用于排序）
   */
  getAllPenalties() {
    const result = {};
    // eslint-disable-next-line no-unused-vars
    for (const [key, record] of this._records) {
      result[record.skillName] = this.getPenalty(record.skillName);
    }
    return result;
  }

  /**
   * 检测退化技能（成功率低于阈值且调用次数足够）
   */
  detectDegradedSkills(threshold = 0.4, minCalls = 5) {
    const degraded = [];
    for (const record of this._records.values()) {
      if (record.totalCalls < minCalls) continue;
      const rate = this._getRecentSuccessRate(record);
      if (rate < threshold) {
        degraded.push({
          skillName: record.skillName,
          successRate: rate,
          totalCalls: record.totalCalls,
          consecutiveFailures: this._getConsecutiveFailures(record),
          penalty: this.getPenalty(record.skillName),
        });
      }
    }
    return degraded.sort((a, b) => a.successRate - b.successRate);
  }

  /**
   * 质量感知排序：将 penalty 融入技能分数
   */
  adjustRanking(skillScores) {
    // skillScores: { skillName: baseScore }
    const adjusted = {};
    for (const [name, score] of Object.entries(skillScores)) {
      const penalty = this.getPenalty(name);
      adjusted[name] = score * penalty;
    }
    return adjusted;
  }

  /**
   * 便捷方法：获取技能统计（供外部模块调用）
   */
  getStats(skillName) {
    return this.getQualityReport(skillName);
  }

  /**
   * 便捷方法：记录执行结果（简化调用签名）
   */
  record(skillName, success, meta = {}) {
    return this.recordExecution(skillName, {
      success,
      durationMs: meta.executionTimeMs || 0,
      error: meta.error || null,
      context: meta.context || {},
    });
  }

  _getRecentSuccessRate(record) {
    if (!record.recentExecutions.length) {
      return record.totalCalls > 0
        ? record.successCount / record.totalCalls : 0;
    }
    const successes = record.recentExecutions.filter(e => e.success).length;
    return successes / record.recentExecutions.length;
  }

  _getConsecutiveFailures(record) {
    let count = 0;
    for (let i = record.recentExecutions.length - 1; i >= 0; i--) {
      if (!record.recentExecutions[i].success) count++;
      else break;
    }
    return count;
  }

  _makeKey(skillName) {
    return `skill:${skillName}`;
  }

  shutdown() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    this._flush();
    if (this._db) {
      try {
        this._db.pragma('wal_checkpoint(TRUNCATE)');
        this._db.close();
      } catch (e) { console.warn('[skill-quality-tracker] Failed to close database:', e.message); }
      this._db = null;
    }
  }
}

// 单例
let _instance = null;

function getQualityTracker() {
  if (!_instance) {
    _instance = new SkillQualityTracker();
    _instance.initialize();
  }
  return _instance;
}

module.exports = { SkillQualityTracker, getQualityTracker };
