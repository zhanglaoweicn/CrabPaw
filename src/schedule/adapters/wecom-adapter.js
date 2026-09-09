const { BaseScheduleAdapter } = require('./base-adapter');
const { WeComCalendarClient } = require('../../channels/wecom/calendar-client');
// eslint-disable-next-line no-unused-vars
const { toISO8601 } = require('../utils/time-utils');
const config = require('../../core/config');

class WeComScheduleAdapter extends BaseScheduleAdapter {
  constructor(options = {}) {
    super({ ...options, name: 'wecom' });
    
    const appConfig = config.loadConfig();
    const wecomConfig = appConfig.wecom || {};
    
    this.calendarClient = new WeComCalendarClient({
      corpId: wecomConfig.corpId || process.env.WECOM_CORP_ID,
      agentId: wecomConfig.agentId || process.env.WECOM_AGENT_ID,
      secret: wecomConfig.secret
    });
    this.defaultCalendarId = options.defaultCalendarId || null;
    this._checkConfiguration();
  }

  _checkConfiguration() {
    const appConfig = config.loadConfig();
    const wecomConfig = appConfig.wecom || {};
    const chatChannelRaw = appConfig.chatChannel || 'none';
    const channels = Array.isArray(chatChannelRaw) ? chatChannelRaw : [chatChannelRaw];
    
    const corpId = wecomConfig.corpId || process.env.WECOM_CORP_ID || '';
    
    this.isConfigured = channels.includes('wecom') && 
                         corpId && 
                         corpId.trim() !== '' &&
                         wecomConfig.secret && 
                         wecomConfig.secret.trim() !== '';
    
    if (!this.isConfigured) {
      const missing = [];
      if (!channels.includes('wecom')) missing.push('chatChannel未包含wecom');
      if (!corpId) missing.push('corpId(企业ID)');
      if (!wecomConfig.secret) missing.push('secret');
      console.log(`⚠️ 企业微信通道未配置完整，日历同步功能已禁用。缺少: ${missing.join(', ')}`);
    }
  }

  isEnabled() {
    return this.isConfigured;
  }

  getStatusMessage() {
    if (this.isConfigured) {
      return { enabled: true, message: '企业微信日历同步已启用' };
    }
    
    const appConfig = config.loadConfig();
    const wecomConfig = appConfig.wecom || {};
    const chatChannelRaw = appConfig.chatChannel || 'none';
    const channels = Array.isArray(chatChannelRaw) ? chatChannelRaw : [chatChannelRaw];
    
    const missing = [];
    if (!channels.includes('wecom')) missing.push('chatChannel需包含"wecom"');
    if (!wecomConfig.corpId && !process.env.WECOM_CORP_ID) missing.push('corpId(企业ID)');
    if (!wecomConfig.secret) missing.push('secret');
    
    return { 
      enabled: false, 
      message: `企业微信日历同步未启用。缺少配置: ${missing.join(', ')}。请在 config.json 中配置 wecom.corpId 和 wecom.secret` 
    };
  }

  async ensureDefaultCalendar() {
    if (this.defaultCalendarId) {
      return this.defaultCalendarId;
    }

    if (!this.isConfigured) {
      return null;
    }

    try {
      const result = await this.calendarClient.createCalendar({
        summary: 'CrabPaw 日程',
        color: '#3b82f6',
        description: 'CrabPaw 助手自动创建的日历'
      });

      if (result.success && result.cal_id) {
        this.defaultCalendarId = result.cal_id;
        console.log('✅ 创建企业微信默认日历:', result.cal_id);
        return result.cal_id;
      }
    } catch (error) {
      console.error('❌ 创建企业微信日历失败:', error.message);
    }

    return null;
  }

  async create(event) {
    if (!this.isConfigured) {
      console.log('⚠️ 企业微信通道未配置，跳过企业微信日历同步');
      return {
        success: false,
        error: '企业微信通道未配置，日历同步功能已禁用',
        skipSync: true
      };
    }

    return this.withRetry(async () => {
      try {
        const calendarId = await this.ensureDefaultCalendar();
        if (!calendarId) {
          return {
            success: false,
            error: '无法创建或获取日历'
          };
        }

        const result = await this.calendarClient.createSchedule(calendarId, {
          summary: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
          description: event.description,
          location: event.location,
          reminders: event.reminders && event.reminders.length > 0 
            ? event.reminders.map(r => ({
                remind_time: r.type === 'minutes_before' ? r.value * 60 : r.value
              }))
            : [{ remind_time: 1800 }]
        });

        if (result.success && result.schedule_id) {
          console.log('✅ 企业微信日程创建成功:', result.schedule_id);
          return {
            success: true,
            externalId: result.schedule_id,
            data: result
          };
        }

        return {
          success: false,
          error: result.error || '创建失败'
        };
      } catch (error) {
        console.error('❌ 企业微信日程创建失败:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }, 'create');
  }

  async update(externalId, event) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '企业微信通道未配置，日历同步功能已禁用',
        skipSync: true
      };
    }

    return this.withRetry(async () => {
      try {
        const result = await this.calendarClient.updateSchedule(externalId, {
          summary: event.title,
          startTime: event.startTime,
          endTime: event.endTime,
          description: event.description,
          location: event.location
        });

        if (result.success) {
          console.log('✅ 企业微信日程更新成功:', externalId);
          return { success: true };
        }

        return {
          success: false,
          error: result.error || '更新失败'
        };
      } catch (error) {
        console.error('❌ 企业微信日程更新失败:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }, 'update');
  }

  async delete(externalId) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '企业微信通道未配置，日历同步功能已禁用',
        skipSync: true
      };
    }

    return this.withRetry(async () => {
      try {
        const result = await this.calendarClient.deleteSchedule(externalId);

        if (result.success) {
          console.log('✅ 企业微信日程删除成功:', externalId);
          return { success: true };
        }

        return {
          success: false,
          error: result.error || '删除失败'
        };
      } catch (error) {
        console.error('❌ 企业微信日程删除失败:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }, 'delete');
  }

  async get(externalId) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '企业微信通道未配置，日历同步功能已禁用'
      };
    }

    return this.withRetry(async () => {
      try {
        if (!this.defaultCalendarId) {
          return {
            success: false,
            error: '未找到默认日历'
          };
        }

        const result = await this.calendarClient.getScheduleList(this.defaultCalendarId);
        
        if (result.success && result.schedules) {
          const schedule = result.schedules.find(s => s.schedule_id === externalId);
          if (schedule) {
            return {
              success: true,
              event: this.transformToLocal(schedule)
            };
          }
        }

        return {
          success: false,
          error: '日程不存在'
        };
      } catch (error) {
        console.error('❌ 获取企业微信日程失败:', error.message);
        return {
          success: false,
          error: error.message
        };
      }
    }, 'get');
  }

  // eslint-disable-next-line no-unused-vars
  async list(options = {}) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '企业微信通道未配置，日历同步功能已禁用',
        events: []
      };
    }

    return this.withRetry(async () => {
      try {
        const calendarId = this.defaultCalendarId || await this.ensureDefaultCalendar();
        if (!calendarId) {
          return {
            success: false,
            error: '无法获取日历',
            events: []
          };
        }

        const result = await this.calendarClient.getScheduleList(calendarId);
        
        if (result.success && result.schedules) {
          const events = result.schedules.map(s => this.transformToLocal(s));
          return { success: true, events };
        }

        return {
          success: false,
          error: result.error || '获取列表失败',
          events: []
        };
      } catch (error) {
        console.error('❌ 获取企业微信日程列表失败:', error.message);
        return {
          success: false,
          error: error.message,
          events: []
        };
      }
    }, 'list');
  }

  async checkConnection() {
    if (!this.isConfigured) {
      return {
        connected: false,
        reason: '企业微信通道未配置'
      };
    }

    try {
      const token = await this.calendarClient.getAccessToken();
      return {
        connected: !!token,
        reason: token ? null : '获取访问令牌失败'
      };
    } catch (error) {
      return {
        connected: false,
        reason: error.message
      };
    }
  }

  transformToLocal(externalEvent) {
    const startTime = externalEvent.start_time 
      ? new Date(externalEvent.start_time * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')
      : null;
    const endTime = externalEvent.end_time 
      ? new Date(externalEvent.end_time * 1000).toISOString().replace(/\.\d{3}Z$/, '+08:00')
      : null;

    return {
      id: externalEvent.schedule_id || `wecom_${Date.now()}`,
      title: externalEvent.summary || '（无标题）',
      description: externalEvent.description || '',
      location: externalEvent.location || '',
      startTime,
      endTime,
      status: 'confirmed',
      color: 'blue',
      source: 'wecom',
      externalId: externalEvent.schedule_id,
      createdAt: externalEvent.create_time 
        ? new Date(externalEvent.create_time * 1000).toISOString()
        : new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  transformToExternal(localEvent) {
    return {
      summary: localEvent.title,
      description: localEvent.description,
      location: localEvent.location,
      startTime: localEvent.startTime,
      endTime: localEvent.endTime,
      reminders: localEvent.reminders
    };
  }
}

module.exports = { WeComScheduleAdapter };
