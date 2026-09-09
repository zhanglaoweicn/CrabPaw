/**
 * Analytics Service - lightweight local persistence
 */
const fs = require('fs');
const path = require('path');

class AnalyticsService {
  constructor() {
    this._initialized = false;
    this._logDir = null;
    this._sessionId = null;
    this._eventCount = 0;
  }

  async initialize({ logDir, sessionId } = {}) {
    this._logDir = logDir;
    this._sessionId = sessionId || Date.now().toString();
    if (this._logDir && !fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
    this._initialized = true;
  }

  track(event, data = {}) {
    if (!this._initialized) return;
    this._eventCount++;
    try {
      const logFile = path.join(this._logDir, 'analytics.jsonl');
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: this._sessionId,
        event,
        ...data,
      }) + '\n';
      fs.appendFileSync(logFile, line, 'utf-8');
    } catch (_) {
      /* ignore */
      console.warn('[analytics.js] 空 catch 补日志:', _ && _.message);
    }

  }

  getEventCount() { return this._eventCount; }
  shutdown() { this._initialized = false; }
}

const analyticsService = new AnalyticsService();
module.exports = { analyticsService, AnalyticsService };
