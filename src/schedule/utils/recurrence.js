const { RECURRENCE_TYPES } = require('../models/event');
const { parseISO8601, addDays, addMonths, addYears } = require('./time-utils');

class RecurrenceEngine {
  constructor() {
    this.maxOccurrences = 1000;
  }

  expand(event, options = {}) {
    if (!event.isRecurring()) {
      return [event];
    }

    // eslint-disable-next-line no-unused-vars
    const { startDate, endDate, maxOccurrences = 100 } = options;
    const occurrences = [];
    const recurrence = event.recurrence;

    let current = event.startTime;
    let count = 0;
    const maxCount = Math.min(maxOccurrences, this.maxOccurrences);

    while (count < maxCount) {
      if (endDate) {
        const currentDate = parseISO8601(current);
        const endDateParsed = parseISO8601(endDate);
        if (currentDate && endDateParsed && currentDate.datetime > endDateParsed.datetime) {
          break;
        }
      }

      if (recurrence.exceptions && recurrence.exceptions.length > 0) {
        const dateStr = current.substring(0, 10);
        if (!recurrence.exceptions.includes(dateStr)) {
          occurrences.push(this.createOccurrence(event, current));
        }
      } else {
        occurrences.push(this.createOccurrence(event, current));
      }

      if (recurrence.endAfter && occurrences.length >= recurrence.endAfter) {
        break;
      }

      if (recurrence.endDate) {
        const currentParsed = parseISO8601(current);
        const endParsed = parseISO8601(recurrence.endDate);
        if (currentParsed && endParsed && currentParsed.datetime > endParsed.datetime) {
          break;
        }
      }

      current = this.getNextOccurrence(current, recurrence);
      if (!current) break;

      count++;
    }

    return occurrences;
  }

  getNextOccurrence(currentISO, recurrence) {
    const interval = recurrence.interval || 1;

    switch (recurrence.type) {
      case RECURRENCE_TYPES.DAILY:
        return addDays(currentISO, interval);

      case RECURRENCE_TYPES.WEEKLY:
        if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
          return this.getNextWeekdayOccurrence(currentISO, recurrence.daysOfWeek, interval);
        }
        return addDays(currentISO, 7 * interval);

      case RECURRENCE_TYPES.MONTHLY:
        if (recurrence.daysOfMonth && recurrence.daysOfMonth.length > 0) {
          return this.getNextMonthDayOccurrence(currentISO, recurrence.daysOfMonth, interval);
        }
        return addMonths(currentISO, interval);

      case RECURRENCE_TYPES.YEARLY:
        return addYears(currentISO, interval);

      case RECURRENCE_TYPES.CUSTOM:
        return this.getNextCustomOccurrence(currentISO, recurrence);

      default:
        return null;
    }
  }

  getNextWeekdayOccurrence(currentISO, daysOfWeek, interval) {
    const current = parseISO8601(currentISO);
    if (!current) return null;

    const currentDay = current.datetime.getDay();
    const sortedDays = [...daysOfWeek].sort((a, b) => a - b);

    let nextDay = sortedDays.find(d => d > currentDay);
    
    if (nextDay === undefined) {
      nextDay = sortedDays[0];
      return addDays(currentISO, (7 - currentDay + nextDay) + (interval - 1) * 7);
    }

    return addDays(currentISO, nextDay - currentDay);
  }

  getNextMonthDayOccurrence(currentISO, daysOfMonth, interval) {
    const current = parseISO8601(currentISO);
    if (!current) return null;

    const currentDay = current.datetime.getDate();
    const sortedDays = [...daysOfMonth].sort((a, b) => a - b);

    let nextDay = sortedDays.find(d => d > currentDay);

    if (nextDay === undefined) {
      nextDay = sortedDays[0];
      const nextMonth = addMonths(currentISO, interval);
      const nextParsed = parseISO8601(nextMonth);
      if (nextParsed) {
        const result = new Date(nextParsed.datetime);
        result.setDate(Math.min(nextDay, this.getDaysInMonth(result)));
        return this._formatLocalISO(result);
      }
    }

    const result = new Date(current.datetime);
    result.setDate(Math.min(nextDay, this.getDaysInMonth(result)));
    return this._formatLocalISO(result);
  }

  _formatLocalISO(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${day}T${h}:${min}:00+08:00`;
  }

  // eslint-disable-next-line no-unused-vars
  getNextCustomOccurrence(_currentISO, recurrence) {
    return null;
  }

  getDaysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  createOccurrence(event, startTime) {
    const duration = event.getDuration();
    const endTime = duration > 0 
      ? this.addDuration(startTime, duration)
      : event.endTime;

    return event.clone({
      id: `${event.id}_${startTime.substring(0, 10)}`,
      startTime,
      endTime,
      recurrence: { type: RECURRENCE_TYPES.NONE },
      isOccurrence: true,
      originalEventId: event.id
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

  getUpcomingOccurrences(event, count = 5) {
    return this.expand(event, { maxOccurrences: count });
  }

  getOccurrencesInRange(event, startDate, endDate) {
    return this.expand(event, { startDate, endDate });
  }

  addException(event, date) {
    const exceptions = event.recurrence.exceptions || [];
    if (!exceptions.includes(date)) {
      exceptions.push(date);
    }
    
    return event.update({
      recurrence: {
        ...event.recurrence,
        exceptions
      }
    });
  }

  removeException(event, date) {
    const exceptions = (event.recurrence.exceptions || []).filter(d => d !== date);
    
    return event.update({
      recurrence: {
        ...event.recurrence,
        exceptions
      }
    });
  }

  validateRecurrence(recurrence) {
    if (!recurrence || !recurrence.type) {
      return { valid: false, error: '缺少重复类型' };
    }

    if (recurrence.type === RECURRENCE_TYPES.NONE) {
      return { valid: true };
    }

    if (recurrence.type === RECURRENCE_TYPES.WEEKLY) {
      if (!recurrence.daysOfWeek || recurrence.daysOfWeek.length === 0) {
        return { valid: false, error: '每周重复需要指定星期几' };
      }
    }

    if (recurrence.type === RECURRENCE_TYPES.MONTHLY) {
      if (!recurrence.daysOfMonth || recurrence.daysOfMonth.length === 0) {
        return { valid: false, error: '每月重复需要指定日期' };
      }
    }

    if (recurrence.endAfter && recurrence.endAfter <= 0) {
      return { valid: false, error: '重复次数必须大于0' };
    }

    if (recurrence.endDate) {
      const parsed = parseISO8601(recurrence.endDate);
      if (!parsed) {
        return { valid: false, error: '无效的结束日期' };
      }
    }

    return { valid: true };
  }

  getRecurrenceDescription(recurrence) {
    if (!recurrence || recurrence.type === RECURRENCE_TYPES.NONE) {
      return '不重复';
    }

    const interval = recurrence.interval || 1;
    let desc = '';

    switch (recurrence.type) {
      case RECURRENCE_TYPES.DAILY:
        desc = interval === 1 ? '每天' : `每${interval}天`;
        break;

      case RECURRENCE_TYPES.WEEKLY:
        if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
          const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
          const days = recurrence.daysOfWeek.map(d => dayNames[d]).join('、');
          desc = interval === 1 ? `每${days}` : `每${interval}周的${days}`;
        } else {
          desc = interval === 1 ? '每周' : `每${interval}周`;
        }
        break;

      case RECURRENCE_TYPES.MONTHLY:
        if (recurrence.daysOfMonth && recurrence.daysOfMonth.length > 0) {
          const days = recurrence.daysOfMonth.map(d => `${d}日`).join('、');
          desc = interval === 1 ? `每月${days}` : `每${interval}个月的${days}`;
        } else {
          desc = interval === 1 ? '每月' : `每${interval}个月`;
        }
        break;

      case RECURRENCE_TYPES.YEARLY:
        desc = interval === 1 ? '每年' : `每${interval}年`;
        break;

      default:
        desc = '自定义重复';
    }

    if (recurrence.endAfter) {
      desc += `，共${recurrence.endAfter}次`;
    } else if (recurrence.endDate) {
      desc += `，直到${recurrence.endDate}`;
    }

    return desc;
  }
}

module.exports = { RecurrenceEngine };
