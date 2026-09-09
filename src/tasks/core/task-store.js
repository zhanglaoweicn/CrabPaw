const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
const DB_PATH = path.join(DATA_DIR, 'tasks.db');

let db = null;
let SQL = null;

const TABLE_SCHEMAS = {
  tasks: `
    CREATE TABLE IF NOT EXISTS tasks (
      taskId TEXT PRIMARY KEY,
      ownerKey TEXT NOT NULL,
      scopeKind TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'pending',
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      progress INTEGER DEFAULT 0,
      progressSummary TEXT,
      error TEXT,
      terminalSummary TEXT,
      parentFlowId TEXT,
      runtime TEXT,
      runId TEXT,
      sessionKey TEXT,
      createdAt INTEGER NOT NULL,
      startedAt INTEGER,
      endedAt INTEGER,
      lastEventAt INTEGER,
      cleanupAfter INTEGER,
      metadata TEXT
    );
  `,
  task_flows: `
    CREATE TABLE IF NOT EXISTS task_flows (
      flowId TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      ownerKey TEXT NOT NULL,
      sessionKey TEXT,
      parentFlowId TEXT,
      createdAt INTEGER NOT NULL,
      endedAt INTEGER,
      metadata TEXT
    );
  `,
  task_events: `
    CREATE TABLE IF NOT EXISTS task_events (
      eventId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT,
      createdAt INTEGER NOT NULL,
      FOREIGN KEY (taskId) REFERENCES tasks(taskId) ON DELETE CASCADE
    );
  `,
  task_checkpoints: `
    CREATE TABLE IF NOT EXISTS task_checkpoints (
      checkpointId TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      progress INTEGER NOT NULL,
      checkpoint TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (taskId) REFERENCES tasks(taskId) ON DELETE CASCADE
    );
  `
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_tasks_ownerKey ON tasks(ownerKey);',
  'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);',
  'CREATE INDEX IF NOT EXISTS idx_tasks_sessionKey ON tasks(sessionKey);',
  'CREATE INDEX IF NOT EXISTS idx_tasks_parentFlowId ON tasks(parentFlowId);',
  'CREATE INDEX IF NOT EXISTS idx_tasks_runId ON tasks(runId);',
  'CREATE INDEX IF NOT EXISTS idx_tasks_cleanupAfter ON tasks(cleanupAfter);',
  'CREATE INDEX IF NOT EXISTS idx_task_events_taskId ON task_events(taskId);',
  'CREATE INDEX IF NOT EXISTS idx_task_checkpoints_taskId ON task_checkpoints(taskId);'
];

async function initialize() {
  if (db) return db;

  SQL = await initSqlJs();
  
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  for (const schema of Object.values(TABLE_SCHEMAS)) {
    db.run(schema);
  }

  for (const indexSql of INDEXES) {
    db.run(indexSql);
  }

  saveToFile();
  
  console.log('✅ 任务数据库已初始化:', DB_PATH);
  return db;
}

function saveToFile() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function close() {
  if (db) {
    saveToFile();
    db.close();
    db = null;
  }
}

function generateId() {
  return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function generateFlowId() {
  return `flow_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function generateEventId() {
  return `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class TaskStore {
  constructor() {
    this.initialized = false;
  }

  async ensureInit() {
    if (!this.initialized) {
      await initialize();
      this.initialized = true;
    }
  }

  async createTask(params) {
    await this.ensureInit();
    
    const taskId = params.taskId || generateId();
    const now = Date.now();
    
    const stmt = db.prepare(`
      INSERT INTO tasks (
        taskId, ownerKey, scopeKind, status, content, priority,
        progress, progressSummary, error, terminalSummary,
        parentFlowId, runtime, runId, sessionKey,
        createdAt, startedAt, endedAt, lastEventAt, cleanupAfter, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.bind([
      taskId,
      params.ownerKey || 'default',
      params.scopeKind || 'session',
      params.status || 'pending',
      params.content || '',
      params.priority || 'medium',
      params.progress || 0,
      params.progressSummary || null,
      params.error || null,
      params.terminalSummary || null,
      params.parentFlowId || null,
      params.runtime || null,
      params.runId || null,
      params.sessionKey || null,
      now,
      params.startedAt || null,
      params.endedAt || null,
      now,
      params.cleanupAfter || null,
      params.metadata ? JSON.stringify(params.metadata) : null
    ]);

    stmt.step();
    stmt.free();
    
    saveToFile();
    
    return this.getTaskById(taskId);
  }

  async getTaskById(taskId) {
    await this.ensureInit();
    
    const stmt = db.prepare('SELECT * FROM tasks WHERE taskId = ?');
    stmt.bind([taskId]);
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return this._parseTask(row);
    }
    
    stmt.free();
    return null;
  }

  async updateTask(taskId, updates) {
    await this.ensureInit();
    
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'taskId' || key === 'createdAt') continue;
      
      if (key === 'metadata' && value) {
        fields.push(`${key} = ?`);
        values.push(JSON.stringify(value));
      } else {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    
    if (fields.length === 0) return null;
    
    fields.push('lastEventAt = ?');
    values.push(Date.now());
    
    values.push(taskId);
    
    const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE taskId = ?`;
    db.run(sql, values);
    
    saveToFile();
    
    return this.getTaskById(taskId);
  }

  async deleteTask(taskId) {
    await this.ensureInit();
    
    db.run('DELETE FROM task_events WHERE taskId = ?', [taskId]);
    db.run('DELETE FROM task_checkpoints WHERE taskId = ?', [taskId]);
    db.run('DELETE FROM tasks WHERE taskId = ?', [taskId]);
    
    saveToFile();
    
    return true;
  }

  async listTasks(filters = {}) {
    await this.ensureInit();
    
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params = [];
    
    if (filters.ownerKey) {
      sql += ' AND ownerKey = ?';
      params.push(filters.ownerKey);
    }
    
    if (filters.status) {
      if (Array.isArray(filters.status)) {
        sql += ` AND status IN (${filters.status.map(() => '?').join(',')})`;
        params.push(...filters.status);
      } else {
        sql += ' AND status = ?';
        params.push(filters.status);
      }
    }
    
    if (filters.sessionKey) {
      sql += ' AND sessionKey = ?';
      params.push(filters.sessionKey);
    }
    
    if (filters.parentFlowId) {
      sql += ' AND parentFlowId = ?';
      params.push(filters.parentFlowId);
    }
    
    sql += ' ORDER BY createdAt DESC';
    
    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
    }
    
    const stmt = db.prepare(sql);
    stmt.bind(params);
    
    const tasks = [];
    while (stmt.step()) {
      tasks.push(this._parseTask(stmt.getAsObject()));
    }
    stmt.free();
    
    return tasks;
  }

  async addCheckpoint(taskId, progress, checkpoint) {
    await this.ensureInit();
    
    const checkpointId = generateEventId();
    const now = Date.now();
    
    db.run(
      'INSERT INTO task_checkpoints (checkpointId, taskId, progress, checkpoint, timestamp) VALUES (?, ?, ?, ?, ?)',
      [checkpointId, taskId, progress, checkpoint, now]
    );
    
    saveToFile();
    
    return { checkpointId, taskId, progress, checkpoint, timestamp: now };
  }

  async getCheckpoints(taskId) {
    await this.ensureInit();
    
    const stmt = db.prepare('SELECT * FROM task_checkpoints WHERE taskId = ? ORDER BY timestamp ASC');
    stmt.bind([taskId]);
    
    const checkpoints = [];
    while (stmt.step()) {
      checkpoints.push(stmt.getAsObject());
    }
    stmt.free();
    
    return checkpoints;
  }

  async addEvent(taskId, kind, payload) {
    await this.ensureInit();
    
    const eventId = generateEventId();
    const now = Date.now();
    
    db.run(
      'INSERT INTO task_events (eventId, taskId, kind, payload, createdAt) VALUES (?, ?, ?, ?, ?)',
      [eventId, taskId, kind, payload ? JSON.stringify(payload) : null, now]
    );
    
    saveToFile();
    
    return { eventId, taskId, kind, payload, createdAt: now };
  }

  async getEvents(taskId, limit = 100) {
    await this.ensureInit();
    
    const stmt = db.prepare('SELECT * FROM task_events WHERE taskId = ? ORDER BY createdAt DESC LIMIT ?');
    stmt.bind([taskId, limit]);
    
    const events = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (row.payload) {
        try {
          row.payload = JSON.parse(row.payload);
        } catch (e) {

          // keep as string

          console.warn('[task-store.js] 空 catch 补日志:', e && e.message);
        }

      }
      events.push(row);
    }
    stmt.free();
    
    return events;
  }

  async cleanupExpiredTasks() {
    await this.ensureInit();
    
    const now = Date.now();
    
    const stmt = db.prepare('SELECT taskId FROM tasks WHERE cleanupAfter IS NOT NULL AND cleanupAfter <= ?');
    stmt.bind([now]);
    
    const expiredIds = [];
    while (stmt.step()) {
      expiredIds.push(stmt.getAsObject().taskId);
    }
    stmt.free();
    
    for (const taskId of expiredIds) {
      await this.deleteTask(taskId);
    }
    
    if (expiredIds.length > 0) {
      console.log(`🧹 清理了 ${expiredIds.length} 个过期任务`);
    }
    
    return expiredIds.length;
  }

  async getStats() {
    await this.ensureInit();
    
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as inProgress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM tasks
    `);
    
    stmt.bind([]);
    
    let stats = { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 };
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stats = {
        total: row.total || 0,
        pending: row.pending || 0,
        inProgress: row.inProgress || 0,
        completed: row.completed || 0,
        failed: row.failed || 0,
        cancelled: row.cancelled || 0
      };
    }
    stmt.free();
    
    return stats;
  }

  _parseTask(row) {
    if (!row) return null;
    
    const task = { ...row };
    
    if (task.metadata && typeof task.metadata === 'string') {
      try {
        task.metadata = JSON.parse(task.metadata);
      } catch (e) {
        task.metadata = {};
      }
    }
    
    return task;
  }
}

class TaskFlowStore {
  constructor() {
    this.initialized = false;
  }

  async ensureInit() {
    if (!this.initialized) {
      await initialize();
      this.initialized = true;
    }
  }

  async createFlow(params) {
    await this.ensureInit();
    
    const flowId = params.flowId || generateFlowId();
    const now = Date.now();
    
    db.run(
      'INSERT INTO task_flows (flowId, status, ownerKey, sessionKey, parentFlowId, createdAt, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        flowId,
        params.status || 'pending',
        params.ownerKey || 'default',
        params.sessionKey || null,
        params.parentFlowId || null,
        now,
        params.metadata ? JSON.stringify(params.metadata) : null
      ]
    );
    
    saveToFile();
    
    return this.getFlowById(flowId);
  }

  async getFlowById(flowId) {
    await this.ensureInit();
    
    const stmt = db.prepare('SELECT * FROM task_flows WHERE flowId = ?');
    stmt.bind([flowId]);
    
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      
      if (row.metadata && typeof row.metadata === 'string') {
        try {
          row.metadata = JSON.parse(row.metadata);
        } catch (e) {
          row.metadata = {};
        }
      }
      
      return row;
    }
    
    stmt.free();
    return null;
  }

  async updateFlow(flowId, updates) {
    await this.ensureInit();
    
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'flowId' || key === 'createdAt') continue;
      
      if (key === 'metadata' && value) {
        fields.push(`${key} = ?`);
        values.push(JSON.stringify(value));
      } else {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    
    if (fields.length === 0) return null;
    
    values.push(flowId);
    
    const sql = `UPDATE task_flows SET ${fields.join(', ')} WHERE flowId = ?`;
    db.run(sql, values);
    
    saveToFile();
    
    return this.getFlowById(flowId);
  }

  async deleteFlow(flowId) {
    await this.ensureInit();
    
    db.run('DELETE FROM task_flows WHERE flowId = ?', [flowId]);
    
    saveToFile();
    
    return true;
  }

  async listFlows(filters = {}) {
    await this.ensureInit();
    
    let sql = 'SELECT * FROM task_flows WHERE 1=1';
    const params = [];
    
    if (filters.ownerKey) {
      sql += ' AND ownerKey = ?';
      params.push(filters.ownerKey);
    }
    
    if (filters.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    
    sql += ' ORDER BY createdAt DESC';
    
    const stmt = db.prepare(sql);
    stmt.bind(params);
    
    const flows = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (row.metadata && typeof row.metadata === 'string') {
        try {
          row.metadata = JSON.parse(row.metadata);
        } catch (e) {
          row.metadata = {};
        }
      }
      flows.push(row);
    }
    stmt.free();
    
    return flows;
  }
}

const taskStore = new TaskStore();
const taskFlowStore = new TaskFlowStore();

module.exports = {
  initialize,
  close,
  saveToFile,
  TaskStore,
  TaskFlowStore,
  taskStore,
  taskFlowStore,
  generateId,
  generateFlowId
};
