const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const { getCrabPawSubDir } = require('../core/path-utils');
const {
  TASKFLOW_SYNC_MODE,
  TASKFLOW_STATUS,
  TASKFLOW_NOTIFY_POLICY,
  TASKFLOW_APPROVAL_STATUS
} = require('./taskflow-types');

class TaskFlowStore {
  constructor(dbPath) {
    this.dbPath = dbPath || this._getDefaultDbPath();
    this.db = null;
    this.initialized = false;
    this._schemaVersion = 2;
  }

  _getDefaultDbPath() {
    return path.join(getCrabPawSubDir(), 'taskflow.db');
  }

  async initialize() {
    if (this.initialized) return;

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          console.error('❌ TaskFlow Store 初始化失败:', err.message);
          reject(err);
        } else {
          this._createTables();
          this._enableWAL();
          this._runMigrations();
          this.initialized = true;
          console.log(`✅ TaskFlow Store 初始化完成: ${this.dbPath}`);
          resolve();
        }
      });
    });
  }

  _createTables() {
    const createFlowTable = `
      CREATE TABLE IF NOT EXISTS task_flows (
        flow_id TEXT PRIMARY KEY,
        sync_mode TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        controller_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        notify_policy TEXT NOT NULL,
        goal TEXT NOT NULL,
        current_step TEXT,
        blocked_task_id TEXT,
        blocked_summary TEXT,
        state_json TEXT,
        wait_json TEXT,
        cancel_requested_at INTEGER,
        trigger_type TEXT,
        trigger_config TEXT,
        error_category TEXT,
        error_strategy TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER
      )
    `;

    const createTaskTable = `
      CREATE TABLE IF NOT EXISTS flow_tasks (
        task_id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        error_category TEXT,
        error_severity TEXT,
        retry_count INTEGER DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (flow_id) REFERENCES task_flows(flow_id)
      )
    `;

    const createHistoryTable = `
      CREATE TABLE IF NOT EXISTS flow_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flow_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (flow_id) REFERENCES task_flows(flow_id)
      )
    `;

    const createApprovalTable = `
      CREATE TABLE IF NOT EXISTS flow_approvals (
        approval_id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        message TEXT,
        status TEXT NOT NULL,
        resume_token TEXT,
        approver TEXT,
        metadata TEXT,
        result TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (flow_id) REFERENCES task_flows(flow_id)
      )
    `;

    const createSchemaVersionTable = `
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `;

    const createIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_flows_status ON task_flows(status)',
      'CREATE INDEX IF NOT EXISTS idx_flows_owner ON task_flows(owner_key)',
      'CREATE INDEX IF NOT EXISTS idx_flows_created ON task_flows(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_flows_trigger ON task_flows(trigger_type)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_flow ON flow_tasks(flow_id)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_status ON flow_tasks(status)',
      'CREATE INDEX IF NOT EXISTS idx_history_flow ON flow_history(flow_id)',
      'CREATE INDEX IF NOT EXISTS idx_approvals_flow ON flow_approvals(flow_id)',
      'CREATE INDEX IF NOT EXISTS idx_approvals_status ON flow_approvals(status)',
      'CREATE INDEX IF NOT EXISTS idx_approvals_expires ON flow_approvals(expires_at)'
    ];

    this.db.serialize(() => {
      this.db.run(createSchemaVersionTable);
      this.db.run(createFlowTable);
      this.db.run(createTaskTable);
      this.db.run(createHistoryTable);
      this.db.run(createApprovalTable);
      createIndexes.forEach(sql => this.db.run(sql));
    });
  }

  _runMigrations() {
    this.db.serialize(() => {
      this.db.get(
        'SELECT MAX(version) as current FROM schema_version',
        [],
        (err, row) => {
          const currentVersion = row?.current || 0;

          if (currentVersion < 2) {
            this._migrateV1toV2();
          }

          this.db.run(
            'INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)',
            [this._schemaVersion, Date.now()]
          );
        }
      );
    });
  }

  _migrateV1toV2() {
    const migrations = [
      "ALTER TABLE task_flows ADD COLUMN trigger_type TEXT",
      "ALTER TABLE task_flows ADD COLUMN trigger_config TEXT",
      "ALTER TABLE task_flows ADD COLUMN error_category TEXT",
      "ALTER TABLE task_flows ADD COLUMN error_strategy TEXT",
      "ALTER TABLE flow_tasks ADD COLUMN error_category TEXT",
      "ALTER TABLE flow_tasks ADD COLUMN error_severity TEXT",
      "ALTER TABLE flow_tasks ADD COLUMN retry_count INTEGER DEFAULT 0"
    ];

    let hasError = false;
    for (const sql of migrations) {
      this.db.run(sql, (err) => {
        if (err) {
          if (err.message.includes('duplicate column name')) {
            // 列已存在，正常情况，跳过
          } else {
            console.error('❌ 迁移错误:', sql, err.message);
            hasError = true;
          }
        }
      });
    }

    if (hasError) {
      console.warn('⚠️ 数据库迁移 V1→V2 部分失败，请检查数据库完整性');
    } else {
      console.log('📦 数据库迁移 V1→V2 完成');
    }
  }

  _enableWAL() {
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA cache_size = -64000');
    this.db.run('PRAGMA temp_store = MEMORY');
  }

  async saveFlow(flow) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO task_flows
        (flow_id, sync_mode, owner_key, controller_id, revision, status,
         notify_policy, goal, current_step, blocked_task_id, blocked_summary,
         state_json, wait_json, cancel_requested_at,
         trigger_type, trigger_config, error_category, error_strategy,
         created_at, updated_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        flow.flowId,
        flow.syncMode || TASKFLOW_SYNC_MODE.MANAGED,
        flow.ownerKey || 'default',
        flow.controllerId || null,
        flow.revision || 0,
        flow.status || TASKFLOW_STATUS.QUEUED,
        flow.notifyPolicy || TASKFLOW_NOTIFY_POLICY.ON_FAILURE,
        flow.goal || '',
        flow.currentStep || null,
        flow.blockedTaskId || null,
        flow.blockedSummary || null,
        flow.stateJson ? JSON.stringify(flow.stateJson) : null,
        flow.waitJson ? JSON.stringify(flow.waitJson) : null,
        flow.cancelRequestedAt || null,
        flow.triggerType || null,
        flow.triggerConfig ? JSON.stringify(flow.triggerConfig) : null,
        flow.errorCategory || null,
        flow.errorStrategy || null,
        flow.createdAt || Date.now(),
        flow.updatedAt || Date.now(),
        flow.endedAt || null,
        (err) => {
          if (err) {
            console.error('❌ 保存 TaskFlow 失败:', err.message);
            reject(err);
          } else {
            resolve();
          }
        }
      );

      stmt.finalize();
    });
  }

  async casUpdateFlow(flowId, updates, expectedRevision) {
    await this._ensureInitialized();

    const setClauses = [];
    const params = [];

    for (const [key, value] of Object.entries(updates)) {
      const colName = this._camelToSnake(key);
      setClauses.push(`${colName} = ?`);
      if (typeof value === 'object' && value !== null) {
        params.push(JSON.stringify(value));
      } else {
        params.push(value);
      }
    }

    setClauses.push('revision = revision + 1');
    setClauses.push('updated_at = ?');
    params.push(Date.now());

    params.push(flowId);
    params.push(expectedRevision);

    const sql = `UPDATE task_flows SET ${setClauses.join(', ')} WHERE flow_id = ? AND revision = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ applied: this.changes > 0, changes: this.changes });
        }
      });
    });
  }

  _camelToSnake(str) {
    const map = {
      syncMode: 'sync_mode',
      ownerKey: 'owner_key',
      controllerId: 'controller_id',
      notifyPolicy: 'notify_policy',
      currentStep: 'current_step',
      blockedTaskId: 'blocked_task_id',
      blockedSummary: 'blocked_summary',
      stateJson: 'state_json',
      waitJson: 'wait_json',
      cancelRequestedAt: 'cancel_requested_at',
      triggerType: 'trigger_type',
      triggerConfig: 'trigger_config',
      errorCategory: 'error_category',
      errorStrategy: 'error_strategy',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      endedAt: 'ended_at'
    };
    return map[str] || str;
  }

  async getFlow(flowId) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM task_flows WHERE flow_id = ?',
        [flowId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? this._rowToFlow(row) : null);
          }
        }
      );
    });
  }

  async listFlows(filter = {}) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      let sql = 'SELECT * FROM task_flows';
      const conditions = [];
      const params = [];

      if (filter.status) {
        if (Array.isArray(filter.status)) {
          conditions.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
          params.push(...filter.status);
        } else {
          conditions.push('status = ?');
          params.push(filter.status);
        }
      }

      if (filter.ownerKey) {
        conditions.push('owner_key = ?');
        params.push(filter.ownerKey);
      }

      if (filter.syncMode) {
        conditions.push('sync_mode = ?');
        params.push(filter.syncMode);
      }

      if (filter.triggerType) {
        conditions.push('trigger_type = ?');
        params.push(filter.triggerType);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY created_at DESC';

      if (filter.limit) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
      }

      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => this._rowToFlow(row)));
        }
      });
    });
  }

  async deleteFlow(flowId) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');

        this.db.run('DELETE FROM flow_tasks WHERE flow_id = ?', [flowId], (err) => {
          if (err) {
            this.db.run('ROLLBACK', () => reject(err));
            return;
          }
        });

        this.db.run('DELETE FROM flow_history WHERE flow_id = ?', [flowId], (err) => {
          if (err) {
            this.db.run('ROLLBACK', () => reject(err));
            return;
          }
        });

        this.db.run('DELETE FROM flow_approvals WHERE flow_id = ?', [flowId], (err) => {
          if (err) {
            this.db.run('ROLLBACK', () => reject(err));
            return;
          }
        });

        this.db.run('DELETE FROM task_flows WHERE flow_id = ?', [flowId], (err) => {
          if (err) {
            this.db.run('ROLLBACK', () => reject(err));
            return;
          }
          this.db.run('COMMIT', (commitErr) => {
            if (commitErr) reject(commitErr);
            else resolve();
          });
        });
      });
    });
  }

  async saveTask(task) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO flow_tasks
        (task_id, flow_id, step_id, status, result, error,
         error_category, error_severity, retry_count,
         started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        task.taskId,
        task.flowId,
        task.stepId,
        task.status,
        task.result ? JSON.stringify(task.result) : null,
        task.error || null,
        task.errorCategory || null,
        task.errorSeverity || null,
        task.retryCount || 0,
        task.startedAt || null,
        task.completedAt || null,
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );

      stmt.finalize();
    });
  }

  async getTasksByFlow(flowId) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM flow_tasks WHERE flow_id = ? ORDER BY started_at',
        [flowId],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows.map(row => this._rowToTask(row)));
          }
        }
      );
    });
  }

  async saveApproval(approval) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO flow_approvals
        (approval_id, flow_id, step_id, message, status, resume_token,
         approver, metadata, result, created_at, expires_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        approval.approvalId,
        approval.flowId,
        approval.stepId,
        approval.message || null,
        approval.status,
        approval.resumeToken || null,
        approval.approver || null,
        approval.metadata ? JSON.stringify(approval.metadata) : null,
        approval.result || null,
        approval.createdAt,
        approval.expiresAt,
        approval.resolvedAt || null,
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );

      stmt.finalize();
    });
  }

  async getApproval(approvalId) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM flow_approvals WHERE approval_id = ?',
        [approvalId],
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row ? this._rowToApproval(row) : null);
          }
        }
      );
    });
  }

  async loadPendingApprovals() {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      this.db.all(
        "SELECT * FROM flow_approvals WHERE status = ? AND expires_at > ?",
        [TASKFLOW_APPROVAL_STATUS.PENDING, Date.now()],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows.map(row => this._rowToApproval(row)));
          }
        }
      );
    });
  }

  async addHistory(flowId, eventType, eventData = null) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT INTO flow_history (flow_id, event_type, event_data, created_at)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run(
        flowId,
        eventType,
        eventData ? JSON.stringify(eventData) : null,
        Date.now(),
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );

      stmt.finalize();
    });
  }

  async getHistory(flowId, limit = 100) {
    await this._ensureInitialized();

    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM flow_history WHERE flow_id = ? ORDER BY created_at DESC LIMIT ?',
        [flowId, limit],
        (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows.map(row => ({
              id: row.id,
              flowId: row.flow_id,
              eventType: row.event_type,
              eventData: row.event_data ? JSON.parse(row.event_data) : null,
              createdAt: row.created_at
            })));
          }
        }
      );
    });
  }

  _dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getStats() {
    await this._ensureInitialized();

    const [
      totalFlowsRow,
      activeFlowsRow,
      blockedFlowsRow,
      lostFlowsRow,
      totalTasksRow,
      pendingApprovalsRow
    ] = await Promise.all([
      this._dbGet('SELECT COUNT(*) as count FROM task_flows'),
      this._dbGet('SELECT COUNT(*) as count FROM task_flows WHERE status IN (?, ?)', [TASKFLOW_STATUS.RUNNING, TASKFLOW_STATUS.QUEUED]),
      this._dbGet('SELECT COUNT(*) as count FROM task_flows WHERE status = ?', [TASKFLOW_STATUS.BLOCKED]),
      this._dbGet('SELECT COUNT(*) as count FROM task_flows WHERE status = ?', [TASKFLOW_STATUS.LOST]),
      this._dbGet('SELECT COUNT(*) as count FROM flow_tasks'),
      this._dbGet('SELECT COUNT(*) as count FROM flow_approvals WHERE status = ?', [TASKFLOW_APPROVAL_STATUS.PENDING])
    ]);

    return {
      totalFlows: totalFlowsRow.count,
      activeFlows: activeFlowsRow.count,
      blockedFlows: blockedFlowsRow.count,
      lostFlows: lostFlowsRow.count,
      totalTasks: totalTasksRow.count,
      pendingApprovals: pendingApprovalsRow.count
    };
  }

  async cleanOldHistory(daysToKeep = 30) {
    await this._ensureInitialized();

    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(
          'DELETE FROM flow_history WHERE created_at < ?',
          [cutoffTime],
          (err) => {
            if (err) { reject(err); return; }
          }
        );
        this.db.run(
          "DELETE FROM flow_approvals WHERE status IN (?, ?) AND resolved_at < ?",
          [TASKFLOW_APPROVAL_STATUS.APPROVED, TASKFLOW_APPROVAL_STATUS.REJECTED, cutoffTime],
          (err) => {
            if (err) { reject(err); return; }
          }
        );
        this.db.run(
          "DELETE FROM flow_approvals WHERE status = ? AND expires_at < ?",
          [TASKFLOW_APPROVAL_STATUS.EXPIRED, Date.now()],
          (err) => {
            if (err) { reject(err); return; }
            resolve();
          }
        );
      });
    });
  }

  _rowToFlow(row) {
    return {
      flowId: row.flow_id,
      syncMode: row.sync_mode,
      ownerKey: row.owner_key,
      controllerId: row.controller_id,
      revision: row.revision,
      status: row.status,
      notifyPolicy: row.notify_policy,
      goal: row.goal,
      currentStep: row.current_step,
      blockedTaskId: row.blocked_task_id,
      blockedSummary: row.blocked_summary,
      stateJson: row.state_json ? JSON.parse(row.state_json) : null,
      waitJson: row.wait_json ? JSON.parse(row.wait_json) : null,
      cancelRequestedAt: row.cancel_requested_at,
      triggerType: row.trigger_type || null,
      triggerConfig: row.trigger_config ? JSON.parse(row.trigger_config) : null,
      errorCategory: row.error_category || null,
      errorStrategy: row.error_strategy || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at
    };
  }

  _rowToTask(row) {
    return {
      taskId: row.task_id,
      flowId: row.flow_id,
      stepId: row.step_id,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      errorCategory: row.error_category || null,
      errorSeverity: row.error_severity || null,
      retryCount: row.retry_count || 0,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  }

  _rowToApproval(row) {
    return {
      approvalId: row.approval_id,
      flowId: row.flow_id,
      stepId: row.step_id,
      message: row.message,
      status: row.status,
      resumeToken: row.resume_token,
      approver: row.approver,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      result: row.result,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at
    };
  }

  async _ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close(() => {
          this.initialized = false;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

let storeInstance = null;

function getTaskFlowStore() {
  if (!storeInstance) {
    storeInstance = new TaskFlowStore();
  }
  return storeInstance;
}

module.exports = {
  TaskFlowStore,
  getTaskFlowStore
};
