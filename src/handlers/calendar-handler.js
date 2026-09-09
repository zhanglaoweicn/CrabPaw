const { readJsonBody, sendError, sendJson } = require('./http-utils');
const { createEventService, CalendarEvent, toISO8601 } = require('../schedule');
const { parseNaturalEvent } = require('../schedule/utils/natural-datetime');
const config = require('../core/config');
const { broadcastEvent } = require('../core/sse-broadcast');
// eslint-disable-next-line no-unused-vars
const { DEFAULT_HOST } = require('../constants/product');

let scheduleService = null;

/** 日程数据变更广播(日程卡片 SSE 订阅 schedule:updated 自动刷新;失败不阻断主流程) */
function notifyScheduleChanged(action, event) {
  try {
    broadcastEvent('schedule:updated', {
      action,
      event: event ? { id: event.id, title: event.title } : null,
    });
  } catch (e) {
    console.warn(`📅 广播 schedule:updated 失败(${action}):`, e?.message || e);
  }
}

function getScheduleService() {
  if (!scheduleService) {
    const appConfig = config.loadConfig();
    const chatChannelRaw = appConfig.chatChannel || 'none';
    const channels = Array.isArray(chatChannelRaw) ? chatChannelRaw : [chatChannelRaw];
    
    const enableLark = channels.includes('lark');
    const enableWeCom = channels.includes('wecom');
    
    console.log(`📅 日程服务适配器配置: Lark=${enableLark}, WeCom=${enableWeCom}`);
    
    scheduleService = createEventService({
      enableLark,
      enableWeCom,
      syncEnabled: true,
      defaultAdapter: channels[0]
    });
  }
  return scheduleService;
}

async function handleCalendarList(req, res, _ctx) {
  const service = getScheduleService();
  const url = new URL(req.url, 'http://localhost');
  const start = url.searchParams.get('start');
  const end = url.searchParams.get('end');

  try {
    let events = [];
    
    if (start && end) {
      const startISO = toISO8601(start, '00:00');
      const endISO = toISO8601(end, '23:59');
      
      events = service.getByDateRange(startISO, endISO, { expandRecurring: true });
      
      const adapter = service.adapters.get('lark');
      if (adapter) {
        const externalResult = await adapter.list({ startISO, endISO });
        
        if (externalResult.success && externalResult.events) {
          const localExternalIds = new Set(
            events
              .filter(e => e.externalId)
              .map(e => e.externalId)
          );
          
          for (const extEvent of externalResult.events) {
            if (!localExternalIds.has(extEvent.id)) {
              events.push(CalendarEvent.fromJSON(extEvent));
            }
          }
        }
      }
    } else {
      events = service.getAll();
    }

    events.sort((a, b) => {
      const aTime = new Date(a.startTime).getTime();
      const bTime = new Date(b.startTime).getTime();
      return aTime - bTime;
    });

    sendJson(res, 200, { success: true, events: events.map(e => e.toJSON()) });
  } catch (error) {
    console.error('❌ 查询日程失败:', error.message);
    sendError(res, 500, error.message);
  }
}

async function handleCalendarCreate(req, res, _ctx) {
  try {
    const data = await readJsonBody(req);
    const { title, date, time, duration, description, location, color, reminders } = data;

    if (!title || !date) {
      return sendError(res, 400, '标题和日期不能为空');
    }

    const service = getScheduleService();
    
    const startTime = toISO8601(date, time || '09:00');
    const durationMinutes = duration || 60;
    // 显式计算 endTime，因为 CalendarEvent 构造函数不读取 duration 字段
    const parsedStart = new Date(startTime);
    const endTime = new Date(parsedStart.getTime() + durationMinutes * 60000).toISOString();

    const eventData = {
      title,
      startTime,
      endTime,
      description: description || '',
      location: location || '',
      color: color || 'blue',
      reminders: reminders || [],
      duration: durationMinutes,
    };

    const event = new CalendarEvent(eventData);
    const createdEvent = await service.create(event);

    if (!createdEvent) {
      return sendError(res, 500, '创建日程失败');
    }

    console.log('📅 日程已创建:', title, date, time);
    notifyScheduleChanged('create', createdEvent);

    sendJson(res, 200, {
      success: true,
      event: createdEvent.toJSON()
    });
  } catch (err) {
    console.error('❌ 创建日程失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarUpdate(req, res, _ctx) {
  try {
    const data = await readJsonBody(req);
    const { id, ...updates } = data;

    if (!id) {
      return sendError(res, 400, '日程ID不能为空');
    }

    const service = getScheduleService();

    // 将 date/time 转为 startTime（2026-08-19 修复：只改 time 不带 date 时
    // 旧逻辑静默丢弃 time——改单字段被忽略。date 缺失时沿用现有事件日期。）
    if (updates.date || updates.time) {
      if (!updates.date) {
        const existing = service.getById(id);
        if (!existing) return sendError(res, 404, '日程不存在');
        updates.date = (existing.toJSON && existing.toJSON().date) || '';
        if (!updates.date) return sendError(res, 400, '现有日程缺少日期信息');
        // 只改时间时携带原时长——否则 service 不会重算 endTime,
        // endTime 停留旧值导致时长归零(2026-08-19 冒烟实锤)
        if (updates.duration === undefined && updates.endTime === undefined) {
          updates.duration = (typeof existing.getDuration === 'function' && existing.getDuration()) || 0;
        }
      }
      updates.startTime = toISO8601(updates.date, updates.time || '09:00');
      delete updates.date;
      delete updates.time;
    }

    const updatedEvent = await service.update(id, updates);

    if (!updatedEvent) {
      return sendError(res, 404, '日程不存在');
    }

    console.log('日程已更新', id);
    notifyScheduleChanged('update', updatedEvent);

    sendJson(res, 200, {
      success: true,
      event: updatedEvent.toJSON()
    });
  } catch (err) {
    console.error('更新日程失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarDelete(req, res, _ctx) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id');

    if (!id) {
      return sendError(res, 400, '日程ID不能为空');
    }

    const service = getScheduleService();
    const deletedEvent = await service.delete(id);

    if (!deletedEvent) {
      return sendError(res, 404, '日程不存在');
    }

    console.log('📅 日程已删除:', deletedEvent.title);
    notifyScheduleChanged('delete', deletedEvent);

    sendJson(res, 200, {
      success: true,
      deleted: deletedEvent.toJSON()
    });
  } catch (err) {
    console.error('❌ 删除日程失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarSearch(req, res, _ctx) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('q');

    if (!query) {
      return sendError(res, 400, '搜索关键词不能为空');
    }

    const service = getScheduleService();
    const events = service.search(query);

    sendJson(res, 200, { 
      success: true, 
      events: events.map(e => e.toJSON()),
      count: events.length
    });
  } catch (err) {
    console.error('❌ 搜索日程失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarStats(req, res, _ctx) {
  try {
    const service = getScheduleService();
    const stats = service.getStats();

    sendJson(res, 200, { 
      success: true, 
      stats 
    });
  } catch (err) {
    console.error('❌ 获取日程统计失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarExport(req, res, _ctx) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const format = url.searchParams.get('format') || 'json';

    const service = getScheduleService();
    const exported = service.export(format);

    res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/calendar');
    res.setHeader('Content-Disposition', `attachment; filename="schedule.${format === 'json' ? 'json' : 'ics'}"`);
    // 2026-08-14 数据链审计 B9: Node http.ServerResponse 无 res.send(Express API)
    // → 必然 TypeError 500。改用 res.end 发送导出内容(export 恒返回字符串)。
    res.end(exported);
  } catch (err) {
    console.error('❌ 导出日程失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarStatus(req, res, _ctx) {
  try {
    const service = getScheduleService();
    const adapters = {};
    
    for (const [name, adapter] of service.adapters) {
      adapters[name] = {
        enabled: adapter.isEnabled ? adapter.isEnabled() : true,
        status: adapter.getStatusMessage ? adapter.getStatusMessage() : { enabled: true, message: '已启用' }
      };
    }

    sendJson(res, 200, { 
      success: true, 
      adapters,
      syncEnabled: service.syncEnabled,
      defaultAdapter: service.defaultAdapter
    });
  } catch (err) {
    console.error('❌ 获取日程状态失败:', err.message);
    sendError(res, 500, err.message);
  }
}

async function handleCalendarParse(req, res, _ctx) {
  try {
    const data = await readJsonBody(req);
    const text = (data && (data.text || data.description)) || '';
    // R3: 歧义诚实化——识别不出日期时明确标记（success 保持 true，前端仍可拿默认表单预填）
    const parsed = parseNaturalEvent(text);
    if (parsed.ambiguous) {
      sendJson(res, 200, { success: true, event: parsed, ambiguous: true, error: '未能识别出日期，请在表单中手动选择' });
    } else {
      sendJson(res, 200, { success: true, event: parsed });
    }
  } catch (err) {
    console.error('❌ 解析日程失败:', err.message);
    sendError(res, 500, err.message);
  }
}

module.exports = {
  handleCalendarList,
  handleCalendarCreate,
  handleCalendarUpdate,
  handleCalendarDelete,
  handleCalendarSearch,
  handleCalendarStats,
  handleCalendarExport,
  handleCalendarStatus,
  handleCalendarParse,
  getScheduleService,
  addEvent: async function(eventData) {
    const service = getScheduleService();
    const event = new CalendarEvent({
      title: eventData.title,
      startTime: toISO8601(eventData.date, eventData.time || '09:00'),
      description: eventData.description || '',
      location: eventData.location || '',
      color: eventData.color || 'blue',
      duration: eventData.duration || 60,
      reminders: eventData.reminders || []
    });
    const created = await service.create(event);
    notifyScheduleChanged('create', created);
    return created;
  }
};
