const HOLIDAYS_ZH = {
  '01-01': '元旦',
  '02-14': '情人节',
  '03-08': '妇女节',
  '03-12': '植树节',
  '04-01': '愚人节',
  '04-05': '清明节',
  '05-01': '劳动节',
  '05-04': '青年节',
  '06-01': '儿童节',
  '07-01': '建党节',
  '08-01': '建军节',
  '09-10': '教师节',
  '10-01': '国庆节',
  '10-31': '万圣节',
  '11-11': '双十一',
  '12-24': '平安夜',
  '12-25': '圣诞节',
};

const LUNAR_HOLIDAYS = [
  { name: '春节', month: 1, day: 1, durationDays: 7 },
  { name: '元宵节', month: 1, day: 15, durationDays: 1 },
  { name: '端午节', month: 5, day: 5, durationDays: 1 },
  { name: '七夕节', month: 7, day: 7, durationDays: 1 },
  { name: '中秋节', month: 8, day: 15, durationDays: 1 },
  { name: '重阳节', month: 9, day: 9, durationDays: 1 },
  { name: '腊八节', month: 12, day: 8, durationDays: 1 },
  { name: '除夕', month: 12, day: 30, durationDays: 1 },
];

const WORK_SCHEDULES = {
  weekday: { start: '09:00', end: '18:00', name: '工作日' },
  weekend: { start: null, end: null, name: '周末' },
};

class TimeAwarenessSystem {
  constructor() {
    this._timezone = 'Asia/Shanghai';
    this._customEvents = new Map();
    this._reminders = new Map();
  }

  setTimezone(tz) {
    this._timezone = tz;
  }

  now() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: this._timezone }));
  }

  getTimeContext() {
    const now = this.now();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const weekday = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();

    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const weekdayName = weekdayNames[weekday];

    const isWeekend = weekday === 0 || weekday === 6;
    const isWorkday = !isWeekend;

    const dateKey = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const holiday = HOLIDAYS_ZH[dateKey];

    let timeOfDay;
    if (hour >= 5 && hour < 9) timeOfDay = '清晨';
    else if (hour >= 9 && hour < 12) timeOfDay = '上午';
    else if (hour >= 12 && hour < 14) timeOfDay = '中午';
    else if (hour >= 14 && hour < 18) timeOfDay = '下午';
    else if (hour >= 18 && hour < 21) timeOfDay = '傍晚';
    else timeOfDay = '深夜';

    let greeting;
    if (hour >= 5 && hour < 9) greeting = '早上好';
    else if (hour >= 9 && hour < 12) greeting = '上午好';
    else if (hour >= 12 && hour < 14) greeting = '中午好';
    else if (hour >= 14 && hour < 18) greeting = '下午好';
    else if (hour >= 18 && hour < 21) greeting = '晚上好';
    else greeting = '夜深了';

    const isWorkingHour = isWorkday && hour >= 9 && hour < 18;

    const relativeDay = this._getRelativeDay(now);

    return {
      year, month, day, weekday, weekdayName,
      hour, minute,
      isWeekend, isWorkday, isWorkingHour,
      timeOfDay, greeting,
      holiday,
      relativeDay,
      formatted: `${year}年${month}月${day}日 星期${weekdayName}`,
      formattedShort: `${month}月${day}日`,
      formattedTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }

  _getRelativeDay(now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    return {
      today: this._formatDate(today),
      tomorrow: this._formatDate(tomorrow),
      yesterday: this._formatDate(yesterday),
    };
  }

  _formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  buildTimePrompt() {
    const ctx = this.getTimeContext();
    const parts = [];

    parts.push(`[当前时间: ${ctx.formatted} ${ctx.formattedTime}]`);
    parts.push(`[时段: ${ctx.timeOfDay}]`);

    if (ctx.holiday) {
      parts.push(`[节日: ${ctx.holiday}]`);
    }

    if (ctx.isWeekend) {
      parts.push('[今天是周末]');
    }

    if (ctx.isWorkingHour) {
      parts.push('[当前为工作时间]');
    } else if (ctx.isWorkday && !ctx.isWorkingHour) {
      if (ctx.hour < 9) {
        parts.push('[工作日上班前]');
      } else {
        parts.push('[工作日下班后]');
      }
    }

    const customEvents = this._getActiveCustomEvents();
    if (customEvents.length > 0) {
      parts.push(`[自定义事件: ${customEvents.map(e => e.name).join(', ')}]`);
    }

    return parts.join('\n');
  }

  addCustomEvent(name, dateStr, durationDays = 1) {
    this._customEvents.set(name, {
      name,
      date: dateStr,
      durationDays,
    });
  }

  removeCustomEvent(name) {
    this._customEvents.delete(name);
  }

  _getActiveCustomEvents() {
    const today = this._formatDate(this.now());
    const active = [];
    // eslint-disable-next-line no-unused-vars
    for (const [name, event] of this._customEvents) {
      const eventDate = new Date(event.date);
      const todayDate = new Date(today);
      const diffDays = Math.floor((todayDate - eventDate) / (1000 * 60 * 60 * 24));
      if (diffDays >= 0 && diffDays < event.durationDays) {
        active.push({ ...event, dayOfEvent: diffDays + 1 });
      }
    }
    return active;
  }

  addReminder(name, dateTimeStr, message) {
    this._reminders.set(name, {
      name,
      dateTime: new Date(dateTimeStr),
      message,
      triggered: false,
    });
  }

  removeReminder(name) {
    this._reminders.delete(name);
  }

  checkReminders() {
    const now = this.now();
    const triggered = [];
    // eslint-disable-next-line no-unused-vars
    for (const [name, reminder] of this._reminders) {
      if (!reminder.triggered && now >= reminder.dateTime) {
        reminder.triggered = true;
        triggered.push(reminder);
      }
    }
    return triggered;
  }

  getUpcomingReminders(limit = 5) {
    const now = this.now();
    const upcoming = [];
    // eslint-disable-next-line no-unused-vars
    for (const [name, reminder] of this._reminders) {
      if (!reminder.triggered && reminder.dateTime > now) {
        upcoming.push(reminder);
      }
    }
    upcoming.sort((a, b) => a.dateTime - b.dateTime);
    return upcoming.slice(0, limit);
  }

  shouldRespectQuietHours() {
    const ctx = this.getTimeContext();
    return ctx.hour >= 22 || ctx.hour < 7;
  }

  getResponseStyleHint() {
    const ctx = this.getTimeContext();
    if (ctx.hour >= 22 || ctx.hour < 7) {
      return '深夜时段，回复应简洁，避免主动推送非紧急信息';
    }
    if (ctx.isWorkingHour) {
      return '工作时间，回复应高效专业';
    }
    if (ctx.isWeekend) {
      return '周末时段，回复可以更轻松友好';
    }
    return '';
  }
}

const globalTimeAwareness = new TimeAwarenessSystem();

module.exports = {
  TimeAwarenessSystem,
  globalTimeAwareness,
  HOLIDAYS_ZH,
  LUNAR_HOLIDAYS,
  WORK_SCHEDULES,
};
