/**
 * VoiceSessionManager — 服务端语音会话生命周期（I-3 最小恢复）
 *
 * 一体机场景下语音编排不能依赖前端进程存活：
 * 服务端持有会话状态机（单向推进），前端崩溃后 recoverStaleSessions 检测并回收。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const STATE_ORDER = ['idle', 'listening', 'thinking', 'speaking', 'ended'];

class VoiceSessionManager {
  constructor({ storageFile = path.join(config.DATA_DIR, 'voice-sessions.json') } = {}) {
    this._storageFile = storageFile;
    this._sessions = this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._storageFile)) return {};
      return JSON.parse(fs.readFileSync(this._storageFile, 'utf8')) || {};
    } catch (e) {
      console.error('[voice-session] 读取失败:', e.message || e);
      return {};
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this._storageFile), { recursive: true });
      fs.writeFileSync(this._storageFile, JSON.stringify(this._sessions, null, 2), 'utf8');
    } catch (e) {
      console.error('[voice-session] 持久化失败:', e.message || e);
    }
  }

  startSession({ userId }) {
    const sessionId = `vs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._sessions[sessionId] = { sessionId, userId, status: 'idle', startedAt: Date.now(), updatedAt: Date.now() };
    this._persist();
    return sessionId;
  }

  /** 单向状态推进：回退返回 false */
  updateState(sessionId, nextStatus) {
    const s = this._sessions[sessionId];
    if (!s) return false;
    const cur = STATE_ORDER.indexOf(s.status);
    const next = STATE_ORDER.indexOf(nextStatus);
    if (next === -1 || next < cur) return false;
    s.status = nextStatus;
    s.updatedAt = Date.now();
    this._persist();
    return true;
  }

  /** 返回会话快照；已结束的会话返回 null */
  getState(sessionId) {
    const s = this._sessions[sessionId];
    if (!s || s.status === 'ended') return null;
    return { ...s };
  }

  endSession(sessionId) {
    const s = this._sessions[sessionId];
    if (!s) return false;
    s.status = 'ended';
    s.endedAt = Date.now();
    this._persist();
    return true;
  }

  listActiveSessions() {
    return Object.values(this._sessions).filter((s) => s.status !== 'ended');
  }

  /** 回收陈旧会话（前端崩溃/超时）——返回被回收的 sessionId 列表 */
  recoverStaleSessions({ maxAgeMs = 10 * 60 * 1000 } = {}) {
    const now = Date.now();
    const stale = [];
    for (const [id, s] of Object.entries(this._sessions)) {
      if (s.status !== 'ended' && now - s.updatedAt > maxAgeMs) {
        s.status = 'ended';
        s.endedAt = now;
        s.recovered = true;
        stale.push(id);
      }
    }
    if (stale.length) this._persist();
    return stale;
  }
}

module.exports = { VoiceSessionManager };
