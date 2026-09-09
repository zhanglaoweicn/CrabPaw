const { CalendarEvent, RECURRENCE_TYPES, EVENT_STATUS, EVENT_PRIORITY, REMINDER_TYPES } = require('./models/event');
const { LocalScheduleStorage } = require('./storage/local-storage');
const { EventService } = require('./services/event-service');
const { BaseScheduleAdapter } = require('./adapters/base-adapter');
const { LarkScheduleAdapter } = require('./adapters/lark-adapter');
const { WeComScheduleAdapter } = require('./adapters/wecom-adapter');
const { RecurrenceEngine } = require('./utils/recurrence');
const { toISO8601, parseISO8601, addMinutes, addDays, addMonths, addYears, getDurationMinutes, formatDuration, isToday, isTomorrow, isThisWeek, getRelativeTime, parseNaturalTime } = require('./utils/time-utils');

let defaultEventService = null;

function createEventService(options = {}) {
  const service = new EventService(options);

  if (options.enableLark !== false) {
    const larkAdapter = new LarkScheduleAdapter({
      timeout: options.larkTimeout || 30000,
      retryCount: options.larkRetryCount || 3
    });
    service.registerAdapter('lark', larkAdapter);
  }

  if (options.enableWeCom) {
    const wecomAdapter = new WeComScheduleAdapter({
      wecomClient: options.wecomClient,
      timeout: options.wecomTimeout || 30000
    });
    service.registerAdapter('wecom', wecomAdapter);
  }

  return service;
}

function getDefaultEventService() {
  if (!defaultEventService) {
    defaultEventService = createEventService();
  }
  return defaultEventService;
}

function setDefaultEventService(service) {
  defaultEventService = service;
}

async function createEvent(data, options = {}) {
  const service = getDefaultEventService();
  return service.create(data, options);
}

async function updateEvent(id, updates, options = {}) {
  const service = getDefaultEventService();
  return service.update(id, updates, options);
}

async function deleteEvent(id, options = {}) {
  const service = getDefaultEventService();
  return service.delete(id, options);
}

function getEvent(id) {
  const service = getDefaultEventService();
  return service.getById(id);
}

function getEventsByDate(date, options = {}) {
  const service = getDefaultEventService();
  return service.getByDate(date, options);
}

function getEventsByDateRange(startDate, endDate, options = {}) {
  const service = getDefaultEventService();
  return service.getByDateRange(startDate, endDate, options);
}

function searchEvents(query) {
  const service = getDefaultEventService();
  return service.search(query);
}

module.exports = {
  CalendarEvent,
  RECURRENCE_TYPES,
  EVENT_STATUS,
  EVENT_PRIORITY,
  REMINDER_TYPES,
  
  LocalScheduleStorage,
  EventService,
  
  BaseScheduleAdapter,
  LarkScheduleAdapter,
  WeComScheduleAdapter,
  
  RecurrenceEngine,
  
  toISO8601,
  parseISO8601,
  addMinutes,
  addDays,
  addMonths,
  addYears,
  getDurationMinutes,
  formatDuration,
  isToday,
  isTomorrow,
  isThisWeek,
  getRelativeTime,
  parseNaturalTime,
  
  createEventService,
  getDefaultEventService,
  setDefaultEventService,
  
  createEvent,
  updateEvent,
  deleteEvent,
  getEvent,
  getEventsByDate,
  getEventsByDateRange,
  searchEvents
};
