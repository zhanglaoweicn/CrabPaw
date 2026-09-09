const fs = require('fs');
const path = require('path');
const { CalendarEvent } = require('../models/event');
const { localDateISO } = require('../utils/time-utils');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('../../core/config');
const DEFAULT_STORAGE_PATH = path.join(DATA_DIR, 'schedule.json');

class LocalScheduleStorage {
  constructor(options = {}) {
    this.storagePath = options.storagePath || DEFAULT_STORAGE_PATH;
    this.cache = null;
    this.cacheTime = 0;
    this.cacheTTL = options.cacheTTL || 5000;
  }

  ensureStorage() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    if (!fs.existsSync(this.storagePath)) {
      const initialData = { events: [], metadata: { version: '1.0', lastUpdated: new Date().toISOString() } };
      fs.writeFileSync(this.storagePath, JSON.stringify(initialData, null, 2), 'utf8');
      this.cache = initialData;
      this.cacheTime = Date.now();
    }
  }

  read() {
    const now = Date.now();
    if (this.cache && (now - this.cacheTime) < this.cacheTTL) {
      return this.cache;
    }

    this.ensureStorage();
    
    try {
      const content = fs.readFileSync(this.storagePath, 'utf8');
      const data = JSON.parse(content);
      this.cache = data;
      this.cacheTime = now;
      return data;
    } catch (error) {
      console.error('❌ 读取日程存储失败:', error.message);
      return { events: [], metadata: { version: '1.0' } };
    }
  }

  write(data) {
    this.ensureStorage();
    
    try {
      data.metadata = data.metadata || {};
      data.metadata.lastUpdated = new Date().toISOString();
      data.metadata.version = data.metadata.version || '1.0';
      
      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
      this.cache = data;
      this.cacheTime = Date.now();
      return true;
    } catch (error) {
      console.error('❌ 写入日程存储失败:', error.message);
      return false;
    }
  }

  getAll() {
    const data = this.read();
    return (data.events || []).map(e => CalendarEvent.fromJSON(e));
  }

  getById(id) {
    const events = this.getAll();
    return events.find(e => e.id === id) || null;
  }

  getByDate(date) {
    const events = this.getAll();
    return events.filter(e => {
      if (!e.startTime) return false;
      const eventDate = typeof e.startTime === 'string' 
        ? e.startTime.substring(0, 10) 
        : localDateISO(new Date(e.startTime));
      return eventDate === date;
    });
  }

  getByDateRange(startDate, endDate) {
    const events = this.getAll();
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    return events.filter(e => {
      if (!e.startTime) return false;
      const eventStart = new Date(e.startTime);
      return eventStart >= start && eventStart <= end;
    });
  }

  add(event) {
    const data = this.read();
    const newEvent = event instanceof CalendarEvent ? event : CalendarEvent.fromJSON(event);
    
    data.events = data.events || [];
    data.events.push(newEvent.toJSON());
    
    return this.write(data) ? newEvent : null;
  }

  update(id, updates) {
    const data = this.read();
    const index = (data.events || []).findIndex(e => e.id === id);
    
    if (index === -1) return null;
    
    const existingEvent = CalendarEvent.fromJSON(data.events[index]);
    const updatedEvent = existingEvent.update(updates);
    
    data.events[index] = updatedEvent.toJSON();
    
    return this.write(data) ? updatedEvent : null;
  }

  delete(id) {
    const data = this.read();
    const index = (data.events || []).findIndex(e => e.id === id);
    
    if (index === -1) return false;
    
    const deleted = data.events.splice(index, 1)[0];
    
    return this.write(data) ? CalendarEvent.fromJSON(deleted) : false;
  }

  search(query) {
    const events = this.getAll();
    const lowerQuery = query.toLowerCase();
    
    return events.filter(e => 
      e.title.toLowerCase().includes(lowerQuery) ||
      (e.description && e.description.toLowerCase().includes(lowerQuery)) ||
      (e.location && e.location.toLowerCase().includes(lowerQuery)) ||
      (e.tags && e.tags.some(t => t.toLowerCase().includes(lowerQuery)))
    );
  }

  count() {
    const data = this.read();
    return (data.events || []).length;
  }

  clear() {
    return this.write({ events: [], metadata: { version: '1.0' } });
  }

  export(format = 'json') {
    const data = this.read();
    
    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }
    
    if (format === 'ics') {
      return this.toICS(data.events);
    }
    
    return data;
  }

  toICS(events) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//CrabPaw//Schedule//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Shanghai',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0800',
      'TZOFFSETTO:+0800',
      'TZNAME:CST',
      'END:STANDARD',
      'END:VTIMEZONE'
    ];
    
    for (const event of events) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${event.id}@crabpaw`);
      lines.push(`DTSTAMP:${this.formatICSDate(event.createdAt)}`);
      lines.push(`DTSTART;TZID=Asia/Shanghai:${this.formatICSDate(event.startTime)}`);
      lines.push(`DTEND;TZID=Asia/Shanghai:${this.formatICSDate(event.endTime)}`);
      lines.push(`SUMMARY:${event.title}`);
      if (event.description) {
        lines.push(`DESCRIPTION:${event.description}`);
      }
      if (event.location) {
        lines.push(`LOCATION:${event.location}`);
      }
      lines.push('END:VEVENT');
    }
    
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  formatICSDate(dateStr) {
    if (!dateStr) return '';
    // startTime 约定带 +08:00 锚定(toISO8601)——直接取墙钟分量, 服务器时区无关;
    // 旧 toISOString 是 UTC, 导出的 .ics 在其他客户端错 8 小时
    const m = String(dateStr).match(/^(d{4})-(d{2})-(d{2})[Ts](d{2}):(d{2})(?::(d{2}))?/);
    if (m) {
      return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6] || '00'}`;
    }
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  import(data, format = 'json') {
    try {
      let events = [];
      
      if (format === 'json') {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        events = parsed.events || [];
      }
      
      const existing = this.read();
      const existingIds = new Set((existing.events || []).map(e => e.id));
      
      const newEvents = events.filter(e => !existingIds.has(e.id));
      
      existing.events = [...(existing.events || []), ...newEvents];
      
      return this.write(existing) ? newEvents.length : 0;
    } catch (error) {
      console.error('❌ 导入日程失败:', error.message);
      return 0;
    }
  }
}

module.exports = { LocalScheduleStorage };
