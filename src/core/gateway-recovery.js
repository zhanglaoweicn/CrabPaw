const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const RECOVERY_DIR = path.join(DATA_DIR, 'recovery');
const MAX_RECOVERY_AGE_MS = 30 * 60 * 1000;

class GatewayRecoveryManager {
  constructor(config = {}) {
    this.recoveryDir = config.recoveryDir || RECOVERY_DIR;
    this.maxAgeMs = config.maxAgeMs || MAX_RECOVERY_AGE_MS;
    this._activeSessions = new Map();
    this._saveTimer = null;
    this._dirty = false;
  }

  _getStateFile() {
    return path.join(this.recoveryDir, 'active-sessions.json');
  }

  _ensureDir() {
    if (!fs.existsSync(this.recoveryDir)) {
      fs.mkdirSync(this.recoveryDir, { recursive: true });
    }
  }

  registerSession(sessionId, metadata = {}) {
    this._activeSessions.set(sessionId, {
      sessionId,
      platform: metadata.platform || 'unknown',
      chatId: metadata.chatId || '',
      startedAt: metadata.startedAt || Date.now(),
      lastActivityAt: Date.now(),
      messageCount: metadata.messageCount || 0,
      hasGoal: metadata.hasGoal || false,
      goalState: metadata.goalState || null,
    });
    this._dirty = true;
    this._scheduleSave();
  }

  updateSession(sessionId, updates = {}) {
    const session = this._activeSessions.get(sessionId);
    if (!session) return;
    Object.assign(session, updates, { lastActivityAt: Date.now() });
    this._dirty = true;
    this._scheduleSave();
  }

  unregisterSession(sessionId) {
    this._activeSessions.delete(sessionId);
    this._dirty = true;
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 2000);
  }

  _save() {
    this._ensureDir();
    const data = {
      savedAt: Date.now(),
      pid: process.pid,
      sessions: [...this._activeSessions.entries()].map(([_id, s]) => s),
    };

    try {
      const stateFile = this._getStateFile();
      const tmp = stateFile + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, stateFile);
      this._dirty = false;
    } catch (e) {
      console.warn('[GatewayRecovery] 保存失败:', e.message);
    }
  }

  recoverSessions() {
    this._ensureDir();
    const stateFile = this._getStateFile();
    if (!fs.existsSync(stateFile)) return [];

    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      const now = Date.now();

      if (now - data.savedAt > this.maxAgeMs) {
        try { fs.unlinkSync(stateFile); } catch (e) { console.warn('[gateway-recovery] failed to unlink stale state file:', e.message); }
        return [];
      }

      if (data.pid === process.pid) {
        return [];
      }

      const recovered = [];
      for (const session of data.sessions || []) {
        if (now - session.lastActivityAt < this.maxAgeMs) {
          recovered.push(session);
        }
      }

      return recovered;
    } catch {
      return [];
    }
  }

  async restoreSessions(restoreFn) {
    const sessions = this.recoverSessions();
    const results = [];

    for (const session of sessions) {
      try {
        const restored = await restoreFn(session);
        if (restored) {
          this.registerSession(session.sessionId, session);
          results.push({ sessionId: session.sessionId, status: 'restored' });
        } else {
          results.push({ sessionId: session.sessionId, status: 'skipped' });
        }
      } catch (e) {
        results.push({ sessionId: session.sessionId, status: 'failed', error: e.message });
      }
    }

    this._save();
    return results;
  }

  cleanRecoveryFile() {
    try {
      const stateFile = this._getStateFile();
      if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
      }
    } catch { console.warn('[gateway-recovery] 清理恢复文件失败'); }
  }

  shutdown() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      this._save();
    }
  }

  getStats() {
    return {
      activeSessions: this._activeSessions.size,
      dirty: this._dirty,
      hasRecoveryFile: fs.existsSync(this._getStateFile()),
    };
  }
}

let _instance = null;

function getGatewayRecoveryManager(config) {
  if (!_instance) {
    _instance = new GatewayRecoveryManager(config);
  }
  return _instance;
}

module.exports = { GatewayRecoveryManager, getGatewayRecoveryManager };
