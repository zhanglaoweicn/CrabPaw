const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const fs = require('fs');
const path = require('path');
const { redactText } = require('./secret-redactor');

const ANNOUNCEMENTS_DIR = path.join(DATA_DIR, 'announcements');
const MAX_ANNOUNCEMENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

class ConsoleSanitizer {
  constructor() {
    this._redactedCount = 0;
  }

  sanitize(message) {
    if (typeof message !== 'string') return message;
    const result = redactText(message, { force: true });
    if (result !== message) this._redactedCount++;
    return result;
  }

  sanitizeObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    const sanitized = Array.isArray(obj) ? [] : {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        sanitized[key] = this.sanitize(value);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  getStats() {
    return { redactedCount: this._redactedCount };
  }
}

class AnnouncementManager {
  constructor() {
    this._ensureDir();
    this._cache = null;
    this._cacheTime = 0;
  }

  _ensureDir() {
    if (!fs.existsSync(ANNOUNCEMENTS_DIR)) {
      fs.mkdirSync(ANNOUNCEMENTS_DIR, { recursive: true });
    }
  }

  _loadAnnouncements() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < 60000) {
      return this._cache;
    }

    this._ensureDir();
    const announcements = [];
    const files = fs.readdirSync(ANNOUNCEMENTS_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ANNOUNCEMENTS_DIR, file), 'utf-8'));
        if (data.expiresAt && data.expiresAt < now) {
          fs.unlinkSync(path.join(ANNOUNCEMENTS_DIR, file));
          continue;
        }
        announcements.push(data);
      } catch { console.warn('[console-safety] 加载公告文件失败'); }
    }

    announcements.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this._cache = announcements;
    this._cacheTime = now;
    return announcements;
  }

  publish(announcement) {
    this._ensureDir();
    const id = announcement.id || `ann_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;

    const existing = this._loadAnnouncements().find(a => a.id === id);
    if (existing) {
      return { id, published: false, reason: 'idempotent_duplicate' };
    }

    const record = {
      id,
      title: announcement.title || '',
      content: announcement.content || '',
      priority: announcement.priority || 0,
      channel: announcement.channel || 'all',
      createdAt: Date.now(),
      expiresAt: announcement.expiresAt || Date.now() + MAX_ANNOUNCEMENT_AGE_MS,
      shownTo: [],
    };

    fs.writeFileSync(
      path.join(ANNOUNCEMENTS_DIR, `${id}.json`),
      JSON.stringify(record, null, 2),
      'utf-8'
    );

    this._cache = null;
    return { id, published: true };
  }

  getPending(userId, channel = 'all') {
    const announcements = this._loadAnnouncements();
    return announcements.filter(a => {
      if (a.channel !== 'all' && a.channel !== channel) return false;
      if (a.shownTo && a.shownTo.includes(userId)) return false;
      return true;
    });
  }

  markShown(announcementId, userId) {
    const filePath = path.join(ANNOUNCEMENTS_DIR, `${announcementId}.json`);
    if (!fs.existsSync(filePath)) return false;

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!data.shownTo) data.shownTo = [];
      if (!data.shownTo.includes(userId)) {
        data.shownTo.push(userId);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      }
      this._cache = null;
      return true;
    } catch {
      return false;
    }
  }

  retract(announcementId) {
    const filePath = path.join(ANNOUNCEMENTS_DIR, `${announcementId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      this._cache = null;
      return true;
    }
    return false;
  }

  cleanup() {
    this._ensureDir();
    const now = Date.now();
    const files = fs.readdirSync(ANNOUNCEMENTS_DIR).filter(f => f.endsWith('.json'));
    let cleaned = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ANNOUNCEMENTS_DIR, file), 'utf-8'));
        if (data.expiresAt && data.expiresAt < now) {
          fs.unlinkSync(path.join(ANNOUNCEMENTS_DIR, file));
          cleaned++;
        }
      } catch {
        try {
          fs.unlinkSync(path.join(ANNOUNCEMENTS_DIR, file));
          cleaned++;
        } catch { console.warn('[console-safety] 清理过期公告时删除文件失败'); }
      }
    }

    this._cache = null;
    return cleaned;
  }
}

class AgentDeleteSafety {
  constructor() {
    this._protectedPaths = new Set();
    this._deleteLog = [];
    this._maxLogSize = 200;
    this._addDefaultProtected();
  }

  _addDefaultProtected() {
    const defaultProtected = [
      path.join(DATA_DIR, 'config.json'),
      path.join(DATA_DIR, '.api_keys.json'),
      path.join(DATA_DIR, 'schedules.json'),
    ];

    for (const p of defaultProtected) {
      this._protectedPaths.add(path.resolve(p));
    }
  }

  protect(filePath) {
    this._protectedPaths.add(path.resolve(filePath));
  }

  unprotect(filePath) {
    this._protectedPaths.delete(path.resolve(filePath));
  }

  isProtected(filePath) {
    const resolved = path.resolve(filePath);
    for (const protectedPath of this._protectedPaths) {
      if (resolved === protectedPath || resolved.startsWith(protectedPath + path.sep)) {
        return true;
      }
    }
    return false;
  }

  validateDelete(filePath) {
    if (this.isProtected(filePath)) {
      return {
        allowed: false,
        reason: `路径 ${filePath} 受保护，禁止删除`,
        path: filePath,
      };
    }

    const resolved = path.resolve(filePath);
    if (resolved === path.resolve('/') || resolved === path.resolve('C:\\')) {
      return {
        allowed: false,
        reason: '禁止删除根目录',
        path: filePath,
      };
    }

    if (resolved.startsWith(DATA_DIR) && resolved === path.resolve(DATA_DIR)) {
      return {
        allowed: false,
        reason: '禁止删除数据目录',
        path: filePath,
      };
    }

    return { allowed: true, path: filePath };
  }

  logDelete(filePath, success, error = null) {
    this._deleteLog.push({
      path: filePath,
      success,
      error,
      timestamp: Date.now(),
    });
    if (this._deleteLog.length > this._maxLogSize) {
      this._deleteLog = this._deleteLog.slice(-this._maxLogSize / 2);
    }
  }

  getDeleteLog(limit = 20) {
    return this._deleteLog.slice(-limit);
  }

  getProtectedPaths() {
    return [...this._protectedPaths];
  }
}

const globalConsoleSanitizer = new ConsoleSanitizer();
const globalAnnouncementManager = new AnnouncementManager();
const globalAgentDeleteSafety = new AgentDeleteSafety();

setInterval(() => {
  globalAnnouncementManager.cleanup();
}, 24 * 60 * 60 * 1000).unref?.();

module.exports = {
  ConsoleSanitizer,
  AnnouncementManager,
  AgentDeleteSafety,
  globalConsoleSanitizer,
  globalAnnouncementManager,
  globalAgentDeleteSafety,
};
