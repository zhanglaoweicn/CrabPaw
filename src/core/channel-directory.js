const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('./config');

const DIRECTORY_PATH = path.join(DATA_DIR, 'channel_directory.json');
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ENTRIES_PER_PLATFORM = 500;

class ChannelDirectory extends EventEmitter {
  constructor(config = {}) {
    super();
    this._path = config.path || DIRECTORY_PATH;
    this._refreshIntervalMs = config.refreshIntervalMs || REFRESH_INTERVAL_MS;
    this._maxEntries = config.maxEntriesPerPlatform || MAX_ENTRIES_PER_PLATFORM;
    this._directory = null;
    this._timer = null;
    this._adapters = null;
    this._sessionStore = null;
  }

  start(adapters, sessionStore) {
    this._adapters = adapters || {};
    this._sessionStore = sessionStore || null;
    this._load();
    this._refresh();
    this._timer = setInterval(() => this._refresh(), this._refreshIntervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  get directory() {
    return this._directory;
  }

  resolve(query, platform) {
    if (!this._directory) return null;
    const normalized = query.replace(/^#/, '').trim().toLowerCase();
    if (!normalized) return null;

    const platforms = platform
      ? { [platform]: this._directory.platforms?.[platform] }
      : this._directory.platforms || {};

    for (const [platName, channels] of Object.entries(platforms)) {
      if (!Array.isArray(channels)) continue;
      for (const ch of channels) {
        const name = (ch.name || '').toLowerCase();
        const id = String(ch.id || '');
        if (name === normalized || id === normalized) {
          return { platform: platName, id: ch.id, name: ch.name, type: ch.type || 'channel' };
        }
      }
    }

    for (const [platName, channels] of Object.entries(platforms)) {
      if (!Array.isArray(channels)) continue;
      for (const ch of channels) {
        const name = (ch.name || '').toLowerCase();
        if (name.includes(normalized)) {
          return { platform: platName, id: ch.id, name: ch.name, type: ch.type || 'channel' };
        }
      }
    }

    return null;
  }

  list(platform) {
    if (!this._directory) return [];
    if (platform) {
      return this._directory.platforms?.[platform] || [];
    }
    const all = [];
    for (const [platName, channels] of Object.entries(this._directory.platforms || {})) {
      if (!Array.isArray(channels)) continue;
      for (const ch of channels) {
        all.push({ ...ch, platform: platName });
      }
    }
    return all;
  }

  search(query, platform) {
    if (!this._directory) return [];
    const normalized = query.replace(/^#/, '').trim().toLowerCase();
    if (!normalized) return this.list(platform);

    const results = [];
    const platforms = platform
      ? { [platform]: this._directory.platforms?.[platform] }
      : this._directory.platforms || {};

    for (const [platName, channels] of Object.entries(platforms)) {
      if (!Array.isArray(channels)) continue;
      for (const ch of channels) {
        const name = (ch.name || '').toLowerCase();
        if (name.includes(normalized)) {
          results.push({ ...ch, platform: platName });
        }
      }
    }
    return results;
  }

  async _refresh() {
    const platforms = {};

    if (this._adapters && typeof this._adapters === 'object') {
      for (const [platName, adapter] of Object.entries(this._adapters)) {
        try {
          const channels = await this._buildFromAdapter(platName, adapter);
          if (channels.length > 0) {
            platforms[platName] = channels.slice(0, this._maxEntries);
          }
        } catch { console.warn('[channel-directory] 刷新频道列表时适配器失败'); }
      }
    }

    const sessionChannels = this._buildFromSessions();
    for (const [platName, channels] of Object.entries(sessionChannels)) {
      if (!platforms[platName]) {
        platforms[platName] = channels.slice(0, this._maxEntries);
      } else {
        const existingIds = new Set(platforms[platName].map(c => String(c.id)));
        for (const ch of channels) {
          if (!existingIds.has(String(ch.id))) {
            platforms[platName].push(ch);
          }
        }
        platforms[platName] = platforms[platName].slice(0, this._maxEntries);
      }
    }

    this._directory = {
      updated_at: new Date().toISOString(),
      platforms,
    };

    this._save();
    this.emit('refreshed', this._directory);
  }

  async _buildFromAdapter(platformName, adapter) {
    const channels = [];

    if (adapter && typeof adapter.listChannels === 'function') {
      try {
        const result = await adapter.listChannels();
        if (Array.isArray(result)) {
          for (const ch of result) {
            channels.push({
              id: String(ch.id || ch.channel_id || ch.chat_id || ''),
              name: String(ch.name || ch.title || ch.username || ''),
              type: ch.type || 'channel',
            });
          }
        }
      } catch { console.warn('[channel-directory] listChannels 失败'); }
    }

    if (adapter && typeof adapter.listGroups === 'function') {
      try {
        const result = await adapter.listGroups();
        if (Array.isArray(result)) {
          for (const ch of result) {
            channels.push({
              id: String(ch.id || ch.group_id || ch.chat_id || ''),
              name: String(ch.name || ch.title || ''),
              type: ch.type || 'group',
            });
          }
        }
      } catch { console.warn('[channel-directory] listGroups 失败'); }
    }

    if (adapter && typeof adapter.listContacts === 'function') {
      try {
        const result = await adapter.listContacts();
        if (Array.isArray(result)) {
          for (const ch of result) {
            channels.push({
              id: String(ch.id || ch.user_id || ch.chat_id || ''),
              name: String(ch.name || ch.username || ch.display_name || ''),
              type: ch.type || 'dm',
            });
          }
        }
      } catch { console.warn('[channel-directory] listContacts 失败'); }
    }

    return channels;
  }

  _buildFromSessions() {
    const platforms = {};

    if (this._sessionStore && typeof this._sessionStore.getAll === 'function') {
      try {
        const sessions = this._sessionStore.getAll();
        for (const session of sessions) {
          const platName = session.platform || 'unknown';
          if (!platforms[platName]) platforms[platName] = [];

          const chatId = session.chatId || session.chat_id;
          if (!chatId) continue;

          const existing = platforms[platName].find(c => String(c.id) === String(chatId));
          if (!existing) {
            platforms[platName].push({
              id: String(chatId),
              name: session.chatName || session.chat_name || session.title || String(chatId),
              type: session.chatType || session.chat_type || 'channel',
            });
          }
        }
      } catch { console.warn('[channel-directory] 从 sessionStore 构建频道列表失败'); }
    }

    const historyPath = path.join(DATA_DIR, 'sessions', 'sessions.json');
    if (fs.existsSync(historyPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
        for (const session of Object.values(index)) {
          const platName = session.platform || 'unknown';
          if (!platforms[platName]) platforms[platName] = [];

          const chatId = session.chatId || session.chat_id;
          if (!chatId) continue;

          const existing = platforms[platName].find(c => String(c.id) === String(chatId));
          if (!existing) {
            platforms[platName].push({
              id: String(chatId),
              name: session.chatName || session.chat_name || session.title || String(chatId),
              type: session.chatType || session.chat_type || 'channel',
            });
          }
        }
      } catch { console.warn('[channel-directory] 从 sessions.json 构建频道列表失败'); }
    }

    return platforms;
  }

  _load() {
    if (!fs.existsSync(this._path)) return;
    try {
      this._directory = JSON.parse(fs.readFileSync(this._path, 'utf-8'));
    } catch {
      this._directory = null;
    }
  }

  _save() {
    try {
      const dir = path.dirname(this._path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = this._path + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(this._directory, null, 2), 'utf-8');
      fs.renameSync(tmp, this._path);
    } catch (e) {
      this.emit('error', e);
    }
  }
}

let _instance = null;

function getChannelDirectory(config) {
  if (!_instance) {
    _instance = new ChannelDirectory(config);
  }
  return _instance;
}

module.exports = {
  ChannelDirectory,
  getChannelDirectory,
};
