const crypto = require('crypto');
/**
 * TaskExecutionHistory - 任务执行历史与 SQLite 持久化层
 *
 * 改进点：
 * - 使用 SQLite 持久化存储，确保重启后数据不丢失
 * - 内存缓存热数据，减少磁盘读取开销
 * - 自动清理过期记录
 * - 降级策略：当 SQLite 不可用时回退为纯内存模式
 */

const path = require('path');
const fs = require('fs');
const { sanitizeTaskError } = require('./task-sanitizer');

const TASK_STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out'
};

const MAX_HISTORY_PER_TASK = 100;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时清理一次
const MAX_AGE_DAYS = 90; // 保留 90 天

class TaskExecutionHistory {
  constructor() {
    this.executions = new Map(); // 内存缓存
    this._db = null;
    this._useSQLite = false;
    this._cleanupTimer = null;
  }

  /**
   * 初始化 SQLite 持久化
   */
  initialize(dataDir) {
    try {
      const Database = require('better-sqlite3');
      const dbDir = path.join(dataDir || require('../../core/config').DATA_DIR, 'tasks'); // 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      const dbPath = path.join(dbDir, 'execution-history.db');
      this._db = new Database(dbPath);
      this._db.pragma('journal_mode = WAL');
      this._db.pragma('synchronous = NORMAL');
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS execution_history (
          execution_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          started_at REAL NOT NULL,
          ended_at REAL,
          status TEXT NOT NULL DEFAULT 'running',
          result TEXT,
          error TEXT,
          duration REAL,
          triggered_by TEXT DEFAULT 'scheduler',
          metadata TEXT DEFAULT '{}',
          created_at REAL NOT NULL DEFAULT (strftime('%s','now') * 1000)
        );
        CREATE INDEX IF NOT EXISTS idx_eh_task_id ON execution_history(task_id);
        CREATE INDEX IF NOT EXISTS idx_eh_started_at ON execution_history(started_at);
        CREATE INDEX IF NOT EXISTS idx_eh_status ON execution_history(status);
      `);
      this._useSQLite = true;

      // 从 SQLite 加载热数据到内存缓存
      this._loadCache();

      // 加载最近记录
      this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);

      console.log('[TaskExecutionHistory] SQLite 持久化已初始化:', dbPath);
    } catch (err) {
      console.warn('[TaskExecutionHistory] SQLite 初始化失败，降级为纯内存模式:', err.message);
      this._useSQLite = false;
    }
  }

  /**
   * 从 SQLite 加载最近记录到内存缓存
   */
  _loadCache() {
    if (!this._useSQLite) return;
    try {
      const rows = this._db.prepare(`
        SELECT * FROM execution_history
        ORDER BY started_at DESC
        LIMIT ?
      `).all(MAX_HISTORY_PER_TASK * 50);
      for (const row of rows) {
        let history = this.executions.get(row.task_id);
        if (!history) {
          history = [];
          this.executions.set(row.task_id, history);
        }
        history.push({
          executionId: row.execution_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          status: row.status,
          result: row.result ? this._safeParseJSON(row.result) : null,
          error: row.error ? this._safeParseJSON(row.error) : null,
          duration: row.duration,
          triggeredBy: row.triggered_by,
          metadata: row.metadata ? this._safeParseJSON(row.metadata) : {},
        });
      }
      console.log(`[TaskExecutionHistory] 已加载 ${rows.length} 条历史记录到内存缓存`);
    } catch (err) {
      console.warn('[TaskExecutionHistory] 加载缓存失败:', err.message);
    }
  }

  /**
   * 记录执行
   */
  async recordExecution(taskId, execution) {
    const record = {
      executionId: `exec_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
      startedAt: execution.startedAt || Date.now(),
      endedAt: execution.endedAt || null,
      status: execution.status || TASK_STATUS.RUNNING,
      result: execution.result || null,
      error: execution.error ? sanitizeTaskError(execution.error) : null,
      duration: execution.duration || null,
      triggeredBy: execution.triggeredBy || 'scheduler',
      metadata: execution.metadata || {}
    };

    // 内存缓存
    const history = this.executions.get(taskId) || [];
    history.unshift(record);
    if (history.length > MAX_HISTORY_PER_TASK) {
      history.length = MAX_HISTORY_PER_TASK;
    }
    this.executions.set(taskId, history);

    // SQLite 持久化
    if (this._useSQLite) {
      try {
        this._db.prepare(`
          INSERT INTO execution_history (execution_id, task_id, started_at, ended_at, status, result, error, duration, triggered_by, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.executionId,
          taskId,
          record.startedAt,
          record.endedAt,
          record.status,
          JSON.stringify(record.result),
          record.error ? JSON.stringify(record.error) : null,
          record.duration,
          record.triggeredBy,
          JSON.stringify(record.metadata)
        );
      } catch (err) {
        console.warn('[TaskExecutionHistory] SQLite 写入失败:', err.message);
      }
    }

    return record;
  }

  /**
   * 更新执行记录状态（处理中途崩溃/失败的更新）
   */
  async updateExecution(taskId, executionId, updates) {
    // 更新内存缓存
    const history = this.executions.get(taskId);
    if (history) {
      const exec = history.find(e => e.executionId === executionId);
      if (exec) {
        Object.assign(exec, updates);
      }
    }

    // 更新 SQLite
    if (this._useSQLite) {
      try {
        const sets = [];
        const values = [];
        if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
        if (updates.endedAt !== undefined) { sets.push('ended_at = ?'); values.push(updates.endedAt); }
        if (updates.result !== undefined) { sets.push('result = ?'); values.push(JSON.stringify(updates.result)); }
        if (updates.error !== undefined) { sets.push('error = ?'); values.push(JSON.stringify(updates.error)); }
        if (updates.duration !== undefined) { sets.push('duration = ?'); values.push(updates.duration); }
        values.push(executionId);
        if (sets.length > 0) {
          this._db.prepare(`UPDATE execution_history SET ${sets.join(', ')} WHERE execution_id = ?`).run(...values);
        }
      } catch (err) {
        console.warn('[TaskExecutionHistory] SQLite 更新失败:', err.message);
      }
    }
  }

  async getHistory(taskId, limit = 20) {
    const history = this.executions.get(taskId);
    if (history && history.length > 0) {
      return history.slice(0, limit);
    }

    // 缓存未命中，从 SQLite 读取
    if (this._useSQLite) {
      try {
        const rows = this._db.prepare(`
          SELECT * FROM execution_history WHERE task_id = ?
          ORDER BY started_at DESC LIMIT ?
        `).all(taskId, limit);

        return rows.map(row => ({
          executionId: row.execution_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          status: row.status,
          result: row.result ? this._safeParseJSON(row.result) : null,
          error: row.error ? this._safeParseJSON(row.error) : null,
          duration: row.duration,
          triggeredBy: row.triggered_by,
          metadata: row.metadata ? this._safeParseJSON(row.metadata) : {},
        }));
      } catch (err) {
        console.warn('[TaskExecutionHistory] SQLite 读取失败:', err.message);
      }
    }

    return [];
  }

  async getAllHistory(limit = 100) {
    // 先查内存缓存
    const allHistory = [];
    for (const [taskId, history] of this.executions) {
      for (const exec of history) {
        allHistory.push({ ...exec, taskId });
      }
    }
    allHistory.sort((a, b) => b.startedAt - a.startedAt);
    if (allHistory.length >= limit) {
      return allHistory.slice(0, limit);
    }

    // 从 SQLite 查询
    if (this._useSQLite) {
      try {
        const rows = this._db.prepare(`
          SELECT * FROM execution_history
          ORDER BY started_at DESC LIMIT ?
        `).all(limit);

        return rows.map(row => ({
          executionId: row.execution_id,
          taskId: row.task_id,
          startedAt: row.started_at,
          endedAt: row.ended_at,
          status: row.status,
          result: row.result ? this._safeParseJSON(row.result) : null,
          error: row.error ? this._safeParseJSON(row.error) : null,
          duration: row.duration,
          triggeredBy: row.triggered_by,
          metadata: row.metadata ? this._safeParseJSON(row.metadata) : {},
        }));
      } catch (err) {
        console.warn('[TaskExecutionHistory] SQLite 读取失败:', err.message);
      }
    }

    return allHistory.slice(0, limit);
  }

  async clearHistory(taskId) {
    if (taskId) {
      this.executions.delete(taskId);
      if (this._useSQLite) {
        try {
          this._db.prepare('DELETE FROM execution_history WHERE task_id = ?').run(taskId);
        } catch (err) {
          console.warn('[TaskExecutionHistory] SQLite 更新失败:', err.message);
        }
      }
    } else {
      this.executions.clear();
      if (this._useSQLite) {
        try {
          this._db.prepare('DELETE FROM execution_history').run();
        } catch (err) {
          console.warn('[TaskExecutionHistory] SQLite 写入失败:', err.message);
        }
      }
    }
  }

  async getStats(taskId) {
    const history = this.executions.get(taskId) || [];

    const stats = {
      total: history.length,
      succeeded: history.filter(e => e.status === TASK_STATUS.SUCCEEDED).length,
      failed: history.filter(e => e.status === TASK_STATUS.FAILED).length,
      cancelled: history.filter(e => e.status === TASK_STATUS.CANCELLED).length,
      timedOut: history.filter(e => e.status === TASK_STATUS.TIMED_OUT).length,
      avgDuration: 0,
      lastExecution: history[0] || null
    };

    const durations = history
      .filter(e => e.duration && e.status === TASK_STATUS.SUCCEEDED)
      .map(e => e.duration);

    if (durations.length > 0) {
      stats.avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    }

    return stats;
  }

  /**
   * 清理过期记录
   */
  _cleanup() {
    if (!this._useSQLite) return;
    try {
      const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
      const result = this._db.prepare('DELETE FROM execution_history WHERE started_at < ?').run(cutoff);
      if (result.changes > 0) {
        console.log(`[TaskExecutionHistory] 已清理 ${result.changes} 条过期记录`);
      }
    } catch (err) {
      console.warn('[TaskExecutionHistory] 清理失败:', err.message);
    }
  }

  /**
   * 导出全量 JSON
   */
  _safeParseJSON(str) {
    if (!str) return null;
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._db) {
      this._db.close();
      this._db = null;
      this._useSQLite = false;
    }
  }
}

const taskExecutionHistory = new TaskExecutionHistory();

// 引入 TaskDependencyManager 模块
const { TaskDependencyManager } = require('./task-dependency-manager');
const taskDependencyManager = new TaskDependencyManager();

// 引入 TaskConditionManager 模块
const taskConditionManager = {
  _conditions: new Map(),
  setCondition(taskId, condition) {
    this._conditions.set(taskId, condition);
  },
  getCondition(taskId) {
    return this._conditions.get(taskId) || null;
  },
  async evaluateCondition(taskId, context) {
    if (!context) context = {};
    const condition = this._conditions.get(taskId);
    if (!condition) return { shouldRun: true, reason: 'no_condition' };
    const now = context.now || new Date();
    if (condition.type === 'weekday') {
      const day = now.getDay();
      const allowed = (condition.params && condition.params.days) ? condition.params.days : [1, 2, 3, 4, 5];
      const passed = allowed.includes(day === 0 ? 7 : day);
      return { shouldRun: passed, reason: passed ? 'weekday_match' : 'not_weekday', day: day };
    }
    if (condition.type === 'time_window') {
      const hour = now.getHours();
      const start = (condition.params && condition.params.startHour != null) ? condition.params.startHour : 0;
      const end = (condition.params && condition.params.endHour != null) ? condition.params.endHour : 24;
      const passed = hour >= start && hour < end;
      return { shouldRun: passed, reason: passed ? 'in_window' : 'outside_window', hour: hour, start: start, end: end };
    }
    return { shouldRun: true, reason: 'unknown_condition_type' };
  },
  removeCondition(taskId) {
    this._conditions.delete(taskId);
  },
  clear() {
    this._conditions.clear();
  }
};

module.exports = {
  TaskExecutionHistory,
  taskExecutionHistory,
  TASK_STATUS,
  taskDependencyManager,
  taskConditionManager
};