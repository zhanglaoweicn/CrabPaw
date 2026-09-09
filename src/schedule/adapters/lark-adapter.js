const { exec } = require('child_process');
const { BaseScheduleAdapter } = require('./base-adapter');
const { toISO8601, addMinutes, localDateISO } = require('../utils/time-utils');
const config = require('../../core/config');

class LarkScheduleAdapter extends BaseScheduleAdapter {
  constructor(options = {}) {
    super({ ...options, name: 'lark' });
    this.cache = new Map();
    this.cacheTTL = 10 * 60 * 1000;
    this.failureCache = new Map();
    this.failureCacheTTL = 30 * 1000;
    this._checkConfiguration();
  }

  _checkConfiguration() {
    const appConfig = config.loadConfig();
    const larkConfig = appConfig.lark || {};
    const chatChannelRaw = appConfig.chatChannel || 'none';
    const channels = Array.isArray(chatChannelRaw) ? chatChannelRaw : [chatChannelRaw];
    
    this.isConfigured = channels.includes('lark') && 
                         larkConfig.appId && 
                         larkConfig.appId.trim() !== '' &&
                         larkConfig.appSecret && 
                         larkConfig.appSecret.trim() !== '';
    
    if (!this.isConfigured) {
    console.log('⚠️ 飞书通道未配置，日历同步功能已禁用');
    }
  }

  isEnabled() {
    return this.isConfigured;
  }

  getStatusMessage() {
    if (this.isConfigured) {
      return { enabled: true, message: '飞书日历同步已启用' };
    }
    return { 
      enabled: false, 
      message: '飞书通道未配置，日历同步功能已禁用。请在 config.json 中配置 lark.appId 和 lark.appSecret，并将 chatChannel 设置为包含 "lark"' 
    };
  }

  async runLarkCLI(args) {
    return new Promise((resolve, reject) => {
      // 2026-08-19 发行审计 W2: 补剥 \r\n(换行可另起命令)与 %(cmd 变量扩展符)。
      // 当前 4 处调用均为内部日历同步硬编码参数, 无 LLM/用户输入直连, 属纵深防御。
      const safeArgs = typeof args === 'string' ? args.replace(/[`$\\;|&<>()\r\n%]/g, '') : '';
      
      // 优先使用本地安装的?@larksuite/cli
      const path = require('path');
      const fs = require('fs');
      const baseDir = path.join(__dirname, '..', '..', '..', '..');
      const localLarkCli = path.join(baseDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
      
      let fullCommand;
      if (fs.existsSync(localLarkCli)) {
        fullCommand = `"${process.execPath}" "${localLarkCli}" ${safeArgs}`;
      } else {
        fullCommand = `lark-cli ${safeArgs}`;
      }
      
      const timeout = setTimeout(() => {
        reject(new Error('Lark CLI 超时'));
      }, this.timeout);

      exec(fullCommand, {
        maxBuffer: 1024 * 1024 * 10,
        shell: true,
        windowsHide: true,
        env: { ...process.env }
      }, (error, stdout, stderr) => {
        clearTimeout(timeout);

        if (error) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed) {
              resolve(parsed);
              return;
            }
          } catch (e) {
            console.warn('[LarkAdapter] failed to parse stdout as JSON on error path:', e.message);
          }

          reject(new Error(stderr || error.message));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ raw: stdout.trim() });
        }
      });
    });
  }

  escapeShellArg(str) {
    if (typeof str !== 'string') str = String(str);
    return `"${str.replace(/"/g, '\\"')}"`;
  }

  async create(event) {
    if (!this.isConfigured) {
      console.log('⚠️ 飞书通道未配置，跳过飞书日历同步');
      return {
        success: false,
        error: '飞书通道未配置，日历同步功能已禁用',
        skipSync: true
      };
    }

    return this.withRetry(async () => {
      const startISO = this.getStartISO(event);
      const endISO = this.getEndISO(event);

      let args = `calendar +create --summary ${this.escapeShellArg(event.title)} --start ${this.escapeShellArg(startISO)} --end ${this.escapeShellArg(endISO)}`;

      if (event.description) {
        args += ` --description ${this.escapeShellArg(event.description)}`;
      }

      if (event.location) {
        args += ` --location ${this.escapeShellArg(event.location)}`;
      }

      console.log('✅📅 创建飞书日程:', event.title);

      const result = await this.runLarkCLI(args);

      if (result.ok && result.data?.event_id) {
        console.log('✅?飞书日程创建成功:', result.data.event_id);
        return {
          success: true,
          externalId: result.data.event_id,
          data: result.data
        };
      }

      const errorMsg = result.error?.message || result.msg || '创建失败';
      console.warn('⚠️ 飞书日程创建失败:', errorMsg);

      return {
        success: false,
        error: errorMsg
      };
    }, 'create');
  }

  async update(externalId, event) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '飞书通道未配置，日历同步功能已禁用',
        skipSync: true
      };
    }

    return this.withRetry(async () => {
      const startISO = this.getStartISO(event);
      const endISO = this.getEndISO(event);

      let args = `calendar +update --event-id ${this.escapeShellArg(externalId)} --summary ${this.escapeShellArg(event.title)} --start ${this.escapeShellArg(startISO)} --end ${this.escapeShellArg(endISO)}`;

      if (event.description) {
        args += ` --description ${this.escapeShellArg(event.description)}`;
      }

      console.log('✅📅 更新飞书日程:', externalId);

      const result = await this.runLarkCLI(args);

      if (result.ok) {
        console.log('✅?飞书日程更新成功:', externalId);
        return { success: true };
      }

      return {
        success: false,
        error: result.error?.message || result.msg || '更新失败'
      };
    }, 'update');
  }

  async delete(externalId) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '飞书通道未配置，日历同步功能已禁用',
        skipSync: true
      };
    }

    return this.withRetry(async () => {
      const args = `calendar +delete --event-id ${this.escapeShellArg(externalId)}`;

      console.log('✅📅 删除飞书日程:', externalId);

      const result = await this.runLarkCLI(args);

      if (result.ok) {
        console.log('✅?飞书日程删除成功:', externalId);
        return { success: true };
      }

      return {
        success: false,
        error: result.error?.message || result.msg || '删除失败'
      };
    }, 'delete');
  }

  async get(externalId) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '飞书通道未配置，日历同步功能已禁用'
      };
    }

    return this.withRetry(async () => {
      const args = `calendar +get --event-id ${this.escapeShellArg(externalId)}`;

      const result = await this.runLarkCLI(args);

      if (result.ok && result.data) {
        return {
          success: true,
          event: this.transformToLocal(result.data)
        };
      }

      return {
        success: false,
        error: result.error?.message || result.msg || '获取失败'
      };
    }, 'get');
  }

  async list(options = {}) {
    if (!this.isConfigured) {
      return {
        success: false,
        error: '飞书通道未配置，日历同步功能已禁用',
        events: []
      };
    }

    return this.withRetry(async () => {
      const startISO = options.startISO || toISO8601(options.startDate || localDateISO(), '00:00');
      const endISO = options.endISO || toISO8601(options.endDate || localDateISO(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)), '23:59');

      const cacheKey = `${startISO}_${endISO}`;
      // success cache (10min)
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.ts < this.cacheTTL) {
        return { success: true, events: cached.events };
      }
      // failure cache (30s) - avoid retry within 30s after failure
      const failed = this.failureCache.get(cacheKey);
      if (failed && Date.now() - failed.ts < this.failureCacheTTL) {
        return { success: false, error: failed.error, events: [] };
      }
      // periodic cache cleanup
      const now_ts = Date.now();
      for (const [k, v] of this.cache) { if (now_ts - v.ts > this.cacheTTL) this.cache.delete(k); }
      for (const [k, v] of this.failureCache) { if (now_ts - v.ts > this.failureCacheTTL) this.failureCache.delete(k); }

      const args = `calendar +agenda --start ${this.escapeShellArg(startISO)} --end ${this.escapeShellArg(endISO)} --format json`;

      const result = await this.runLarkCLI(args);

      if (result.ok && Array.isArray(result.data)) {
        const events = result.data.map(evt => this.transformToLocal(evt));
        this.cache.set(cacheKey, { events, ts: Date.now() });
        return { success: true, events };
      }

      const errMsg = result.error?.message || result.msg || "获取列表失败";
      this.failureCache.set(cacheKey, { error: errMsg, ts: Date.now() });
      return { success: false, error: errMsg, events: [] };
    }, 'list');
  }

  async checkConnection() {
    try {
      const result = await this.runLarkCLI('auth status');
      return {
        connected: result.ok && result.identity,
        identity: result.identity,
        userName: result.userName
      };
    } catch (error) {
      return {
        connected: false,
        reason: error.message
      };
    }
  }

  getStartISO(event) {
    if (typeof event.startTime === 'string' && event.startTime.includes('T')) {
      return event.startTime;
    }
    return toISO8601(event.startTime, event.startTimeTime || '09:00');
  }

  getEndISO(event) {
    if (event.endTime && typeof event.endTime === 'string' && event.endTime.includes('T')) {
      return event.endTime;
    }

    const startISO = this.getStartISO(event);
    const duration = event.getDuration ? event.getDuration() : 60;

    return addMinutes(startISO, duration);
  }

  transformToLocal(externalEvent) {
    return {
      id: externalEvent.event_id || `lark_${Date.now()}`,
      title: externalEvent.summary || '（无标题）',
      description: externalEvent.description || '',
      location: externalEvent.location || '',
      startTime: externalEvent.start_time?.datetime || null,
      endTime: externalEvent.end_time?.datetime || null,
      status: externalEvent.status || 'confirmed',
      color: 'green',
      source: 'lark',
      externalId: externalEvent.event_id,
      createdAt: externalEvent.create_time || new Date().toISOString(),
      updatedAt: externalEvent.update_time || new Date().toISOString()
    };
  }

  transformToExternal(localEvent) {
    return {
      summary: localEvent.title,
      description: localEvent.description,
      location: localEvent.location,
      start_time: {
        datetime: this.getStartISO(localEvent)
      },
      end_time: {
        datetime: this.getEndISO(localEvent)
      }
    };
  }

  clearCache() {
    this.cache.clear();
  }
}

module.exports = { LarkScheduleAdapter };
