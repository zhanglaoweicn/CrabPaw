const { DataSourceAdapter, DATA_SOURCE_TYPES } = require('./base-adapter');

class LarkCalendarDataSource extends DataSourceAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      name: 'lark-calendar',
      type: DATA_SOURCE_TYPES.CALENDAR,
      platform: 'lark',
    });
    this._appId = opts.appId || '';
    this._appSecret = opts.appSecret || '';
    this._syncDays = opts.syncDays || 7;
    this._eventBuffer = [];
    this._bufferSize = opts.bufferSize || 500;
    this._accessToken = null;
    this._tokenExpireTime = 0;
  }

  get isConfigured() {
    return !!(this._appId && this._appSecret);
  }

  async connect() {
    if (!this.isConfigured) {
      throw new Error('飞书日历源未配置: 需要 appId 和 appSecret');
    }
    await this._getAccessToken();
    this.emit('connected');
  }

  async disconnect() {
    this._accessToken = null;
    this._tokenExpireTime = 0;
    this.stopSync();
    this.emit('disconnected');
  }

  async fetch(options = {}) {
    if (!this.isConfigured) {
      return [];
    }

    try {
      const token = await this._getAccessToken();
      const syncDays = options.syncDays || this._syncDays;
      const now = new Date();
      const startTime = options.startTime || now.toISOString();
      const endTime = options.endTime || new Date(now.getTime() + syncDays * 24 * 60 * 60 * 1000).toISOString();

      const startUnix = Math.floor(new Date(startTime).getTime() / 1000);
      const endUnix = Math.floor(new Date(endTime).getTime() / 1000);

      const url = `https://open.feishu.cn/open-apis/calendar/v4/calendars/primary/events?start_time=${startUnix}&end_time=${endUnix}&page_size=${options.limit || 50}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.code === 0 && result.data && result.data.items) {
        return result.data.items;
      }

      return [];
    } catch (e) {
      this.emit('error', { phase: 'fetch', error: e.message });
      return [];
    }
  }

  normalize(rawEvent) {
    const summary = rawEvent.summary || rawEvent.title || '(无标题)';
    const description = rawEvent.description || '';
    const location = rawEvent.location || {};
    const locationName = typeof location === 'string' ? location : (location.name || '');
    const organizer = rawEvent.organizer || {};
    const organizerName = typeof organizer === 'string' ? organizer : (organizer.display_name || organizer.user_id || '');

    const startTime = rawEvent.start_time || {};
    const endTime = rawEvent.end_time || {};

    const startTs = startTime.timestamp
      ? parseInt(startTime.timestamp) * 1000
      : (startTime.unix ? parseInt(startTime.unix) * 1000 : Date.now());
    const endTs = endTime.timestamp
      ? parseInt(endTime.timestamp) * 1000
      : (endTime.unix ? parseInt(endTime.unix) * 1000 : Date.now());

    const startISO = new Date(startTs).toISOString();
    const endISO = new Date(endTs).toISOString();

    const eventId = rawEvent.event_id || rawEvent.id || `lark_cal_${Date.now()}`;

    let content = `[飞书日历] ${summary}`;
    content += `\n时间: ${startISO} ~ ${endISO}`;
    if (locationName) {
      content += `\n地点: ${locationName}`;
    }
    if (organizerName) {
      content += `\n组织者: ${organizerName}`;
    }
    if (description) {
      content += `\n\n${description}`;
    }

    return {
      id: `lark_cal_${eventId}`,
      content,
      timestamp: startTs,
      entities: this._extractEntities(organizerName, summary, locationName),
      topics: this._extractTopics(summary, locationName),
      metadata: {
        eventId,
        summary,
        startTime: startISO,
        endTime: endISO,
        location: locationName,
        organizer: organizerName,
        color: rawEvent.color || -1,
        reminders: rawEvent.reminders || [],
        attendees: rawEvent.attendees || [],
        visibility: rawEvent.visibility || '',
        status: rawEvent.status || '',
      },
    };
  }

  handleCalendarEvent(eventData) {
    const normalized = this.normalize(eventData);

    this._eventBuffer.push(normalized);
    if (this._eventBuffer.length > this._bufferSize) {
      this._eventBuffer = this._eventBuffer.slice(-this._bufferSize);
    }

    this.emit('calendar:event', normalized);

    if (this._memoryTree) {
      this._memoryTree.appendLeaf(normalized.content, {
        tokenCount: this._estimateTokens(normalized.content),
        entities: normalized.entities || [],
        topics: normalized.topics || [],
        sourceType: this.type,
        sourcePlatform: this.platform,
        sourceId: normalized.id,
        timestamp: normalized.timestamp,
        metadata: normalized.metadata || {},
      });
    }

    if (this._onData) {
      this._onData(normalized);
    }

    return normalized;
  }

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpireTime) {
      return this._accessToken;
    }

    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this._appId,
        app_secret: this._appSecret,
      }),
    });

    const data = await response.json();

    if (data.tenant_access_token) {
      this._accessToken = data.tenant_access_token;
      this._tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
      return this._accessToken;
    }

    throw new Error(data.msg || '获取飞书access_token失败');
  }

  _extractEntities(organizer, summary, location) {
    const entities = [];
    if (organizer) {
      entities.push({ type: 'person', name: organizer, source: 'lark_calendar_organizer' });
    }
    if (location) {
      entities.push({ type: 'location', name: location, source: 'lark_calendar_location' });
    }
    return entities;
  }

  _extractTopics(summary, _location) {
    const topics = [];
    if (summary) topics.push(summary.slice(0, 50));
    return topics;
  }
}

module.exports = { LarkCalendarDataSource };
