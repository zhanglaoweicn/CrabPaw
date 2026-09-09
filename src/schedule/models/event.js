const crypto = require('crypto');
const RECURRENCE_TYPES = {
  NONE: 'none',
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
  CUSTOM: 'custom'
};

const EVENT_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed'
};

const EVENT_PRIORITY = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  URGENT: 'urgent'
};

const REMINDER_TYPES = {
  NONE: 'none',
  AT_TIME: 'at_time',
  MINUTES_BEFORE: 'minutes_before',
  HOURS_BEFORE: 'hours_before',
  DAYS_BEFORE: 'days_before'
};

class CalendarEvent {
  constructor(data = {}) {
    this.id = data.id || this.generateId();
    this.title = data.title || '';
    this.description = data.description || '';
    this.location = data.location || '';

    this.startTime = data.startTime || null;
    this.endTime = data.endTime || null;
    this.isAllDay = data.isAllDay || false;
    this.timezone = data.timezone || 'Asia/Shanghai';

    this.status = data.status || EVENT_STATUS.CONFIRMED;
    this.priority = data.priority || EVENT_PRIORITY.NORMAL;
    this.color = data.color || 'blue';

    this.recurrence = this.parseRecurrence(data.recurrence);
    this.reminders = this.parseReminders(data.reminders);
    this.attendees = this.parseAttendees(data.attendees);

    this.tags = data.tags || [];
    this.metadata = data.metadata || {};

    this.source = data.source || 'local';
    this.externalId = data.externalId || null;
    this.externalData = data.externalData || null;

    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  generateId() {
    return `evt_${Date.now()}_${crypto.randomBytes(5).toString("hex").slice(0, 10)}`;
  }

  parseRecurrence(recurrence) {
    if (!recurrence) {
      return { type: RECURRENCE_TYPES.NONE };
    }

    return {
      type: recurrence.type || RECURRENCE_TYPES.NONE,
      interval: recurrence.interval || 1,
      endDate: recurrence.endDate || null,
      endAfter: recurrence.endAfter || null,
      daysOfWeek: recurrence.daysOfWeek || [],
      daysOfMonth: recurrence.daysOfMonth || [],
      monthsOfYear: recurrence.monthsOfYear || [],
      exceptions: recurrence.exceptions || []
    };
  }

  parseReminders(reminders) {
    if (!reminders || !Array.isArray(reminders)) {
      return [];
    }

    return reminders.map(r => ({
      type: r.type || REMINDER_TYPES.MINUTES_BEFORE,
      value: r.value || 15,
      enabled: r.enabled !== false
    }));
  }

  parseAttendees(attendees) {
    if (!attendees || !Array.isArray(attendees)) {
      return [];
    }

    return attendees.map(a => ({
      id: a.id || '',
      name: a.name || '',
      email: a.email || '',
      status: a.status || 'pending'
    }));
  }

  toISO8601(date, time) {
    if (!date) return null;
    const timePart = time || '00:00';
    return `${date}T${timePart}:00+08:00`;
  }

  getStartISO() {
    if (!this.startTime) return null;
    if (typeof this.startTime === 'string' && this.startTime.includes('T')) {
      return this.startTime;
    }
    return this.toISO8601(this.startTime, '09:00');
  }

  getEndISO() {
    if (!this.endTime) return null;
    if (typeof this.endTime === 'string' && this.endTime.includes('T')) {
      return this.endTime;
    }
    return this.toISO8601(this.endTime, '10:00');
  }

  getDuration() {
    if (!this.startTime || !this.endTime) return 0;

    const start = new Date(this.startTime);
    const end = new Date(this.endTime);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;

    return Math.round((end - start) / 60000);
  }

  isRecurring() {
    return this.recurrence && this.recurrence.type !== RECURRENCE_TYPES.NONE;
  }

  hasReminder() {
    return this.reminders && this.reminders.length > 0;
  }

  hasAttendees() {
    return this.attendees && this.attendees.length > 0;
  }

  isExternal() {
    return this.source !== 'local' && this.externalId;
  }

  toJSON() {
    const parsedStart = this.startTime ? this.parseTime(this.startTime) : null;
    const parsedEnd = this.endTime ? this.parseTime(this.endTime) : null;

    return {
      id: this.id,
      title: this.title,
      description: this.description,
      location: this.location,
      startTime: this.startTime,
      endTime: this.endTime,
      date: parsedStart ? parsedStart.date : '',
      time: parsedStart ? parsedStart.time : '',
      duration: parsedStart && parsedEnd ? this.calculateDuration(parsedStart.datetime, parsedEnd.datetime) : 0,
      isAllDay: this.isAllDay,
      timezone: this.timezone,
      status: this.status,
      priority: this.priority,
      color: this.color,
      recurrence: this.recurrence,
      reminders: this.reminders,
      attendees: this.attendees,
      tags: this.tags,
      metadata: this.metadata,
      source: this.source === 'lark' ? 'feishu' : this.source,
      feishuEventId: this.source === 'lark' ? this.externalId : undefined,
      externalId: this.externalId,
      externalData: this.externalData,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    };
  }

  parseTime(isoStr) {
    if (!isoStr) return null;
    try {
      const date = new Date(isoStr);
      if (isNaN(date.getTime())) return null;

      const y = date.getFullYear();
      const mo = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const h = String(date.getHours()).padStart(2, '0');
      const min = String(date.getMinutes()).padStart(2, '0');

      return {
        date: `${y}-${mo}-${d}`,
        time: `${h}:${min}`,
        datetime: date
      };
    } catch {
      return null;
    }
  }

  calculateDuration(start, end) {
    if (!start || !end) return 0;
    return Math.round((end - start) / 60000);
  }

  static fromJSON(json) {
    return new CalendarEvent(json);
  }

  clone() {
    return CalendarEvent.fromJSON(this.toJSON());
  }

  update(data) {
    const updated = this.clone();
    Object.keys(data).forEach(key => {
      if (key in updated) {
        updated[key] = data[key];
      }
    });
    updated.updatedAt = new Date().toISOString();
    return updated;
  }
}

module.exports = {
  CalendarEvent,
  RECURRENCE_TYPES,
  EVENT_STATUS,
  EVENT_PRIORITY,
  REMINDER_TYPES
};
