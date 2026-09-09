// eslint-disable-next-line no-unused-vars
const { CalendarEvent, EVENT_STATUS, RECURRENCE_TYPES } = require('../models/event');
const { LocalScheduleStorage } = require('../storage/local-storage');
const { RecurrenceEngine } = require('../utils/recurrence');
// eslint-disable-next-line no-unused-vars
const { toISO8601, parseISO8601, getDurationMinutes, localDateISO } = require('../utils/time-utils');

class EventService {
  constructor(options = {}) {
    this.storage = options.storage || new LocalScheduleStorage(options.storageOptions);
    this.recurrenceEngine = new RecurrenceEngine();
    this.adapters = new Map();
    this.syncEnabled = options.syncEnabled !== false;
    this.defaultAdapter = options.defaultAdapter || null;
    this.recentlyCreated = new Map(); // 防重复创建：记录最近创建的日程
  }

  registerAdapter(name, adapter) {
    this.adapters.set(name, adapter);
    console.log(`📅 已注册日程适配器 ${name}`);
  }

  unregisterAdapter(name) {
    this.adapters.delete(name);
    console.log(`📅 已注销日程适配器 ${name}`);
  }

  async create(data, options = {}) {
    const event = data instanceof CalendarEvent ? data : new CalendarEvent(data);

    if (!event.title || !event.title.trim()) {
      throw new Error('日程标题不能为空');
    }

    if (!event.startTime) {
      throw new Error('日程开始时间不能为空');
    }

    if (!event.endTime) {
      const duration = data.duration || 60;
      const startISO = typeof event.startTime === 'string' && event.startTime.includes('T')
        ? event.startTime
        : toISO8601(event.startTime, '09:00');
      event.endTime = this.addDuration(startISO, duration);
    }

    // 防重复创建：检查 10 秒内是否已创建相同日程
    const dedupeKey = `${event.title}|${event.startTime}|${event.endTime}|${event.color || ""}|${(event.description || "").slice(0, 40)}`;
    const recentEvent = this.recentlyCreated.get(dedupeKey);
    if (recentEvent && Date.now() - recentEvent.timestamp < 10000) {
      console.log('⚠️ 跳过重复创建日程:', event.title, event.startTime);
      return recentEvent.event;
    }

    const savedEvent = this.storage.add(event);
    if (!savedEvent) {
      throw new Error('保存日程失败');
    }

    // 记录最近创建的日程
    this.recentlyCreated.set(dedupeKey, { event: savedEvent, timestamp: Date.now() });

    // 清理过期的记录（保留最近1分钟的）
    const now = Date.now();
    for (const [key, value] of this.recentlyCreated.entries()) {
      if (now - value.timestamp > 60000) {
        this.recentlyCreated.delete(key);
      }
    }

    console.log('📅 本地日程已创建', savedEvent.title, savedEvent.startTime);

    if (this.syncEnabled && !options.localOnly) {
      await this.syncToExternal(savedEvent, options);
    }

    return savedEvent;
  }

  async update(id, updates, options = {}) {
    const existing = this.storage.getById(id);
    if (!existing) {
      throw new Error('日程不存在');
    }

    // duration 更新时自动重新计算 endTime
    if (updates.duration !== undefined && !updates.endTime) {
      const startTime = updates.startTime || existing.startTime;
      if (startTime) {
        updates.endTime = this.addDuration(startTime, updates.duration);
      }
    }

    const updated = this.storage.update(id, updates);
    if (!updated) {
      throw new Error('更新日程失败');
    }

    console.log('📅 日程已更新', updated.title);

    if (this.syncEnabled && !options.localOnly && existing.externalId) {
      await this.syncUpdateToExternal(updated, options);
    }

    return updated;
  }

  async delete(id, options = {}) {
    const event = this.storage.getById(id);
    if (!event) {
      throw new Error('日程不存在');
    }

    if (this.syncEnabled && !options.localOnly && event.externalId) {
      await this.syncDeleteToExternal(event, options);
    }

    const deleted = this.storage.delete(id);
    if (!deleted) {
      throw new Error('删除日程失败');
    }

    console.log('📅 日程已删除', event.title);
    return deleted;
  }

  getById(id) {
    return this.storage.getById(id);
  }

  getByDate(date, options = {}) {
    let events = this.storage.getByDate(date);

    if (options.expandRecurring) {
      events = this.expandRecurringEvents(events, date, date);
    }

    return this.sortEvents(events);
  }

  getByDateRange(startDate, endDate, options = {}) {
    let events = this.storage.getByDateRange(startDate, endDate);

    if (options.expandRecurring) {
      events = this.expandRecurringEvents(events, startDate, endDate);
    }

    return this.sortEvents(events);
  }

  getAll(options = {}) {
    let events = this.storage.getAll();

    if (options.expandRecurring && options.startDate && options.endDate) {
      events = this.expandRecurringEvents(events, options.startDate, options.endDate);
    }

    return this.sortEvents(events);
  }

  search(query) {
    return this.storage.search(query);
  }

  expandRecurringEvents(events, startDate, endDate) {
    const expanded = [];

    for (const event of events) {
      if (event.isRecurring()) {
        const occurrences = this.recurrenceEngine.getOccurrencesInRange(event, startDate, endDate);
        expanded.push(...occurrences);
      } else {
        expanded.push(event);
      }
    }

    return expanded;
  }

  sortEvents(events) {
    return events.sort((a, b) => {
      const aTime = new Date(a.startTime).getTime();
      const bTime = new Date(b.startTime).getTime();
      return aTime - bTime;
    });
  }

  addDuration(isoStr, minutes) {
    const parsed = parseISO8601(isoStr);
    if (!parsed) return null;

    const newDate = new Date(parsed.datetime.getTime() + minutes * 60000);
    const y = newDate.getFullYear();
    const mo = String(newDate.getMonth() + 1).padStart(2, '0');
    const d = String(newDate.getDate()).padStart(2, '0');
    const h = String(newDate.getHours()).padStart(2, '0');
    const min = String(newDate.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${d}T${h}:${min}:00+08:00`;
  }

  detectConflicts(event, options = {}) {
    const startDate = typeof event.startTime === 'string'
      ? event.startTime.substring(0, 10)
      : localDateISO(new Date(event.startTime));

    const sameDayEvents = this.getByDate(startDate);
    const conflicts = [];

    const eventStart = new Date(event.startTime).getTime();
    const eventEnd = new Date(event.endTime).getTime();

    for (const existing of sameDayEvents) {
      if (options.excludeId && existing.id === options.excludeId) {
        continue;
      }

      const existingStart = new Date(existing.startTime).getTime();
      const existingEnd = new Date(existing.endTime).getTime();

      if (eventStart < existingEnd && eventEnd > existingStart) {
        conflicts.push(existing);
      }
    }

    return conflicts;
  }

  async syncToExternal(event, options = {}) {
    const adapterName = options.adapter || this.defaultAdapter;
    
    if (!adapterName) {
      return { synced: false, reason: '未指定外部适配器' };
    }

    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      console.warn(`⚠️ 适配器 ${adapterName} 未注册`);
      return { synced: false, reason: '适配器未注册' };
    }

    try {
      const result = await adapter.create(event);
      
      if (result.success && result.externalId) {
        this.storage.update(event.id, {
          externalId: result.externalId,
          source: adapterName,
          externalData: result.data
        });
        
        console.log(`📅 已同步到 ${adapterName}:`, result.externalId);
        return { synced: true, externalId: result.externalId };
      }

      return { synced: false, reason: result.error };
    } catch (error) {
      console.error(`同步到 ${adapterName} 失败:`, error.message);
      return { synced: false, reason: error.message, error };
    }
  }

  async syncUpdateToExternal(event, options = {}) {
    const adapterName = options.adapter || event.source || this.defaultAdapter;
    
    if (!adapterName || !event.externalId) {
      return { synced: false, reason: '缺少外部信息' };
    }

    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      return { synced: false, reason: '适配器未注册' };
    }

    try {
      const result = await adapter.update(event.externalId, event);
      
      if (result.success) {
        console.log(`📅 已更新 ${adapterName} 日程:`, event.externalId);
        return { synced: true };
      }

      return { synced: false, reason: result.error };
    } catch (error) {
      console.error(`同步更新 ${adapterName} 日程失败:`, error.message);
      return { synced: false, reason: error.message, error };
    }
  }

  async syncDeleteToExternal(event, options = {}) {
    const adapterName = options.adapter || event.source || this.defaultAdapter;
    
    if (!adapterName || !event.externalId) {
      return { synced: false, reason: '缺少外部信息' };
    }

    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      return { synced: false, reason: '适配器未注册' };
    }

    try {
      const result = await adapter.delete(event.externalId);
      
      if (result.success) {
        console.log(`📅 已删除 ${adapterName} 日程:`, event.externalId);
        return { synced: true };
      }

      return { synced: false, reason: result.error };
    } catch (error) {
      console.error(`同步删除 ${adapterName} 日程失败:`, error.message);
      return { synced: false, reason: error.message, error };
    }
  }

  async fetchFromExternal(adapterName, options = {}) {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new Error(`适配器 ${adapterName} 未注册`);
    }

    try {
      const result = await adapter.list(options);
      
      if (result.success && result.events) {
        const imported = this.importExternalEvents(result.events, adapterName);
        return { success: true, count: imported, events: result.events };
      }

      return { success: false, error: result.error };
    } catch (error) {
      console.error(`从 ${adapterName} 获取日程失败:`, error.message);
      return { success: false, error: error.message };
    }
  }

  importExternalEvents(events, source) {
    let imported = 0;

    for (const externalEvent of events) {
      const existing = this.storage.getById(externalEvent.id);
      
      if (!existing) {
        const event = new CalendarEvent({
          ...externalEvent,
          source,
          externalId: externalEvent.id
        });
        
        if (this.storage.add(event)) {
          imported++;
        }
      }
    }

    console.log(`📅 从 ${source} 导入了 ${imported} 个日程`);
    return imported;
  }

  getStats() {
    const events = this.storage.getAll();
    
    return {
      total: events.length,
      recurring: events.filter(e => e.isRecurring()).length,
      withReminders: events.filter(e => e.hasReminder()).length,
      withAttendees: events.filter(e => e.hasAttendees()).length,
      external: events.filter(e => e.isExternal()).length,
      byStatus: this.groupBy(events, 'status'),
      byPriority: this.groupBy(events, 'priority'),
      bySource: this.groupBy(events, 'source')
    };
  }

  groupBy(events, field) {
    const groups = {};
    for (const event of events) {
      const value = event[field] || 'unknown';
      groups[value] = (groups[value] || 0) + 1;
    }
    return groups;
  }

  export(format = 'json') {
    return this.storage.export(format);
  }

  async import(data, format = 'json') {
    return this.storage.import(data, format);
  }
}

module.exports = { EventService };
