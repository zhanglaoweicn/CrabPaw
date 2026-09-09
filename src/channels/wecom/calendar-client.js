const https = require('https');
const config = require('../../core/config');

class WeComCalendarClient {
  constructor(options = {}) {
    this.corpId = options.corpId || '';
    this.agentId = options.agentId || '';
    this.secret = options.secret || '';
    this.accessToken = null;
    this.tokenExpireTime = 0;
    this._checkConfiguration();
  }

  _checkConfiguration() {
    const appConfig = config.loadConfig();
    const wecomConfig = appConfig.wecom || {};
    const chatChannelRaw = appConfig.chatChannel || 'none';
    const channels = Array.isArray(chatChannelRaw) ? chatChannelRaw : [chatChannelRaw];
    
    this.corpId = wecomConfig.corpId || process.env.WECOM_CORP_ID || '';
    this.agentId = wecomConfig.agentId || process.env.WECOM_AGENT_ID || '';
    
    this.isConfigured = channels.includes('wecom') && 
                         this.corpId && 
                         this.corpId.trim() !== '' &&
                         wecomConfig.secret && 
                         wecomConfig.secret.trim() !== '';
    
    if (!this.isConfigured) {
      const missing = [];
      if (!channels.includes('wecom')) missing.push('chatChannel未包含wecom');
      if (!this.corpId) missing.push('corpId(企业ID)');
      if (!wecomConfig.secret) missing.push('secret');
      console.log(`⚠️ 企业微信通道未配置完整，日历同步功能已禁用。缺少: ${missing.join(', ')}`);
    }
    
    return this.isConfigured;
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

  async getAccessToken() {
    if (!this.isConfigured) {
      throw new Error('企业微信未配置');
    }
    // 2026-09-06: 收口到 token-broker 单飞管理
    const appConfig = config.loadConfig();
    const wecomConfig = appConfig.wecom || {};
    const { getWecomToken } = require('./token-broker');
    return getWecomToken(this.corpId || wecomConfig.corpId, wecomConfig.secret, 'calendar');
  }

  async createCalendar(data) {
    if (!this._checkConfiguration()) {
      return { success: false, error: '企业微信未配置' };
    }

    try {
      const token = await this.getAccessToken();
      
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          calendar: {
            readonly: 0,
            set_as_main: 1,
            is_public: 0,
            ...data
          }
        });

        const req = https.request({
          hostname: 'qyapi.weixin.qq.com',
          path: `/cgi-bin/oa/calendar/add?access_token=${token}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.errcode === 0) {
                resolve({ success: true, cal_id: result.cal_id });
              } else {
                resolve({ success: false, error: result.errmsg });
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async createSchedule(calendarId, scheduleData) {
    if (!this._checkConfiguration()) {
      return { success: false, error: '企业微信未配置' };
    }

    try {
      const token = await this.getAccessToken();
      
      const startTime = Math.floor(new Date(scheduleData.startTime).getTime() / 1000);
      const endTime = Math.floor(new Date(scheduleData.endTime).getTime() / 1000);
      
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          schedule: {
            organizer: scheduleData.organizer || '',
            start_time: startTime,
            end_time: endTime,
            summary: scheduleData.summary || scheduleData.title,
            description: scheduleData.description || '',
            location: scheduleData.location || '',
            reminders: scheduleData.reminders || [{
              remind_time: 3600
            }],
            ...scheduleData
          },
          cal_id: calendarId
        });

        const req = https.request({
          hostname: 'qyapi.weixin.qq.com',
          path: `/cgi-bin/oa/schedule/add?access_token=${token}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.errcode === 0) {
                resolve({ success: true, schedule_id: result.schedule_id });
              } else {
                resolve({ success: false, error: result.errmsg });
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getScheduleList(calendarId, offset = 0, limit = 100) {
    if (!this._checkConfiguration()) {
      return { success: false, error: '企业微信未配置', schedules: [] };
    }

    try {
      const token = await this.getAccessToken();
      
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          cal_id: calendarId,
          offset: offset,
          limit: limit
        });

        const req = https.request({
          hostname: 'qyapi.weixin.qq.com',
          path: `/cgi-bin/oa/schedule/get_by_calendar?access_token=${token}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.errcode === 0) {
                resolve({ 
                  success: true, 
                  schedules: result.schedule_list || [],
                  has_more: offset + limit < result.total_count
                });
              } else {
                resolve({ success: false, error: result.errmsg, schedules: [] });
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      return { success: false, error: error.message, schedules: [] };
    }
  }

  async updateSchedule(scheduleId, scheduleData) {
    if (!this._checkConfiguration()) {
      return { success: false, error: '企业微信未配置' };
    }

    try {
      const token = await this.getAccessToken();
      
      const startTime = scheduleData.startTime ? Math.floor(new Date(scheduleData.startTime).getTime() / 1000) : undefined;
      const endTime = scheduleData.endTime ? Math.floor(new Date(scheduleData.endTime).getTime() / 1000) : undefined;
      
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          schedule: {
            schedule_id: scheduleId,
            ...(startTime && { start_time: startTime }),
            ...(endTime && { end_time: endTime }),
            ...(scheduleData.summary && { summary: scheduleData.summary }),
            ...(scheduleData.description && { description: scheduleData.description }),
            ...(scheduleData.location && { location: scheduleData.location })
          }
        });

        const req = https.request({
          hostname: 'qyapi.weixin.qq.com',
          path: `/cgi-bin/oa/schedule/update?access_token=${token}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.errcode === 0) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: result.errmsg });
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteSchedule(scheduleId) {
    if (!this._checkConfiguration()) {
      return { success: false, error: '企业微信未配置' };
    }

    try {
      const token = await this.getAccessToken();
      
      return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
          schedule_id: scheduleId
        });

        const req = https.request({
          hostname: 'qyapi.weixin.qq.com',
          path: `/cgi-bin/oa/schedule/del?access_token=${token}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.errcode === 0) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: result.errmsg });
              }
            } catch (e) {
              reject(e);
            }
          });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
      });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = { WeComCalendarClient };
