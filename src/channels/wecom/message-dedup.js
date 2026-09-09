const { EventEmitter } = require('events');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

class MessageDeduplicator extends EventEmitter {
  constructor(config = {}) {
    super();
    this._ttl = config.ttl || DEFAULT_TTL_MS;
    this._maxEntries = config.maxEntries || DEFAULT_MAX_ENTRIES;
    this._seen = new Map();
    this._cleanupTimer = null;
    this._stats = {
      totalChecked: 0,
      duplicatesFound: 0,
      uniquePassed: 0,
    };
  }

  start() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  _makeKey(event) {
    const msgId = event.msgId || event.msg_id || '';
    const chatId = event.chatId || event.chat_id || '';
    const fromUserId = event.fromUserId || event.from_user_id || '';

    if (msgId) {
      return `mid:${msgId}`;
    }

    const content = (event.content || '').substring(0, 200);
    const timestamp = event.timestamp || Date.now();
    const minuteBucket = Math.floor(timestamp / 60000);

    return `ck:${chatId}:${fromUserId}:${minuteBucket}:${this._hashContent(content)}`;
  }

  _hashContent(content) {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  check(event) {
    this._stats.totalChecked++;

    const key = this._makeKey(event);
    const now = Date.now();

    if (this._seen.has(key)) {
      const entry = this._seen.get(key);
      if (now - entry.timestamp < this._ttl) {
        this._stats.duplicatesFound++;
        this.emit('duplicate', { key, event, firstSeen: entry.timestamp });
        return {
          isDuplicate: true,
          key,
          firstSeen: entry.timestamp,
          age: now - entry.timestamp,
        };
      }
    }

    if (this._seen.size >= this._maxEntries) {
      this._evictOldest();
    }

    this._seen.set(key, {
      timestamp: now,
      msgId: event.msgId || event.msg_id || '',
      chatId: event.chatId || event.chat_id || '',
    });

    this._stats.uniquePassed++;
    return { isDuplicate: false, key };
  }

  isDuplicate(event) {
    return this.check(event).isDuplicate;
  }

  markSeen(event) {
    const key = this._makeKey(event);
    this._seen.set(key, {
      timestamp: Date.now(),
      msgId: event.msgId || event.msg_id || '',
      chatId: event.chatId || event.chat_id || '',
    });
  }

  _cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this._seen) {
      if (now - entry.timestamp > this._ttl) {
        this._seen.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this.emit('cleanup', { removed, remaining: this._seen.size });
    }
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this._seen) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._seen.delete(oldestKey);
    }
  }

  getStats() {
    return {
      ...this._stats,
      cacheSize: this._seen.size,
      ttlMs: this._ttl,
    };
  }

  reset() {
    this._seen.clear();
    this._stats = {
      totalChecked: 0,
      duplicatesFound: 0,
      uniquePassed: 0,
    };
  }
}

module.exports = { MessageDeduplicator };
