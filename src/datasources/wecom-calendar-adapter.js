const { DataSourceAdapter, DATA_SOURCE_TYPES } = require('./base-adapter');
const { WeComCalendarClient } = require('../channels/wecom/calendar-client');

class WeComCalendarDataSource extends DataSourceAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      name: 'wecom-calendar',
      type: DATA_SOURCE_TYPES.CALENDAR,
      platform: 'wecom',
    });
    this._calendarClient = new WeComCalendarClient({
      corpId: opts.corpId || '',
      agentId: opts.agentId || '',
      secret: opts.secret || '',
    });
    this._calendarId = opts.calendarId || null;
    this._syncDays = opts.syncDays || 7;
    this._eventBuffer = [];
    this._bufferSize = opts.bufferSize || 500;
  }

  get isConfigured() {
    return this._calendarClient.isEnabled();
  }

  async connect() {
    if (!this.isConfigured) {
      throw new Error('企业微信日历源未配置: 需要 corpId 和 secret');
    }
    await this._calendarClient.getAccessToken();
    this.emit('connected');
  }

  async disconnect() {
    this.stopSync();
    this.emit('disconnected');
  }

  async fetch(options = {}) {
    if (!this.isConfigured) {
      return [];
    }

    const calendarId = options.calendarId || this._calendarId;
    if (!calendarId) {
      return this._eventBuffer.length > 0
        ? this._eventBuffer.slice(-options.limit || this._bufferSize)
        : [];
    }

    try {
      const result = await this._calendarClient.getScheduleList(
        calendarId,
        options.offset || 0,
        options.limit || 100
      );

      if (result.success && result.schedules) {
        return result.schedules;
      }
      return [];
    } catch (e) {
      this.emit('error', { phase: 'fetch', error: e.message });
      return [];
    }
  }

  normalize(rawSchedule) {
    const schedule = rawSchedule.schedule || rawSchedule;
    const summary = schedule.summary || schedule.title || '(无标题)';
    const description = schedule.description || '';
    const location = schedule.location || '';
    const organizer = schedule.organizer || '';

    const startTime = schedule.start_time
      ? new Date(schedule.start_time * 1000).toISOString()
      : '';
    const endTime = schedule.end_time
      ? new Date(schedule.end_time * 1000).toISOString()
      : '';

    const scheduleId = schedule.schedule_id || schedule.id || `wecom_cal_${Date.now()}`;

    let content = `[企业微信日历] ${summary}`;
    if (startTime && endTime) {
      content += `\n时间: ${startTime} ~ ${endTime}`;
    }
    if (location) {
      content += `\n地点: ${location}`;
    }
    if (organizer) {
      content += `\n组织者: ${organizer}`;
    }
    if (description) {
      content += `\n\n${description}`;
    }

    return {
      id: `wecom_cal_${scheduleId}`,
      content,
      timestamp: startTime ? new Date(startTime).getTime() : Date.now(),
      entities: this._extractEntities(organizer, summary, location),
      topics: this._extractTopics(summary, location),
      metadata: {
        scheduleId,
        summary,
        startTime,
        endTime,
        location,
        organizer,
        reminders: schedule.reminders || [],
        attendees: schedule.attendees || [],
        calId: schedule.cal_id || '',
        status: schedule.status || '',
      },
    };
  }

  handleScheduleEvent(scheduleData) {
    const normalized = this.normalize(scheduleData);

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

  _extractEntities(organizer, summary, location) {
    const entities = [];
    if (organizer) {
      entities.push({ type: 'person', name: organizer, source: 'wecom_calendar_organizer' });
    }
    if (location) {
      entities.push({ type: 'location', name: location, source: 'wecom_calendar_location' });
    }
    return entities;
  }

  _extractTopics(summary, _location) {
    const topics = [];
    if (summary) topics.push(summary.slice(0, 50));
    return topics;
  }
}

module.exports = { WeComCalendarDataSource };
