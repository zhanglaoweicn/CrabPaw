const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const api = require('./api');
const { LarkEventServer, LARK_EVENT_TYPES } = require('./event-server');
const { LarkGroupRouter, LARK_CHAT_TYPES, LARK_GROUP_MESSAGE_POLICIES } = require('./group-router');
const { TokenManager } = require('./token-manager');

const pendingConfirmations = new Map();

function createChannel(config) {
  const { appId, appSecret, verificationToken, encryptKey, botOpenId, botName, groupPolicy, eventPort } = config.lark || {};

  // Read credentials fresh every call — bypass CredentialManager cache
  function _getCreds() {
    try {
      const dataDir = path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
      const cfgDir = process.env.CRABPAW_DATA_DIR || dataDir;
      const configPath = path.join(cfgDir, 'config.json');
      const apiKeysPath = path.join(cfgDir, '.api_keys.json');
      let cfg = {};
      if (fs.existsSync(configPath)) {
        try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) { console.warn('[lark] failed to parse config.json:', e.message); }
      }
      const lark = cfg.lark || {};
      let appSecret = process.env.LARK_APP_SECRET || lark.appSecret || null;
      // Masked value (contains ***) or too short to be real — treat as missing
      if (appSecret && (appSecret.includes('***') || appSecret.length < 10)) appSecret = null;
      if (!appSecret && fs.existsSync(apiKeysPath)) {
        try {
          const apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
          if (apiKeys.lark_appSecret || apiKeys.lark_app_secret) {
            const { decryptApiKey } = require('../../core/secure-storage');
            const enc = apiKeys.lark_appSecret || apiKeys.lark_app_secret;
            appSecret = decryptApiKey(enc) || null;
          }
        } catch (e) { console.warn('[lark] failed to parse .api_keys.json:', e.message); }
      }
      return {
        appId: process.env.LARK_APP_ID || lark.appId || null,
        appSecret: appSecret,
      };
    } catch (e) { console.warn('[lark] _getCreds failed:', e.message); return { appId: appId || null, appSecret: appSecret || null }; }
  }

  const tokenManager = new TokenManager();
  if (appId && appSecret) {
    tokenManager.registerApp(appId, appSecret);
  }

  const groupRouter = new LarkGroupRouter({
    botOpenId: botOpenId || '',
    botName: botName || '',
    groupPolicy: groupPolicy || LARK_GROUP_MESSAGE_POLICIES.MENTION_ONLY,
  });

  const eventServer = new LarkEventServer({
    appId: appId || '',
    appSecret: appSecret || '',
    verificationToken: verificationToken || '',
    encryptKey: encryptKey || '',
    port: eventPort || 38770,
  });

  // 2026-09-06 加固: channel 继承 EventEmitter——此前是普通对象字面量,
  // startEventServer 里 channel.emit('message') 会抛 TypeError（第一条消息即断）
  const channel = Object.assign(new EventEmitter(), {
    name: 'lark',
    type: 'channel',

    tokenManager,
    groupRouter,
    eventServer,

    async send(userId, content) {
      const c = _getCreds();
      if (!c.appId || !c.appSecret) throw new Error('飞书未配置');
      return api.sendMessage(c.appId, c.appSecret, userId, content);
    },

    async sendCard(userId, options) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.sendInteractiveCard(_c.appId, _c.appSecret, userId, options);
    },

    // 2026-09-06: 本地文件发送（filegen 产物回推/SendLarkFile 依赖）
    async sendFile(userId, filePath) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      const fileKey = await api.uploadFile(_c.appId, _c.appSecret, filePath);
      return api.sendFileMessage(_c.appId, _c.appSecret, userId, fileKey);
    },

    async sendTyping(userId, message) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.sendTypingStatus(_c.appId, _c.appSecret, userId, message);
    },

    async updateCard(messageId, card) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.updateCard(_c.appId, _c.appSecret, messageId, card);
    },

    parsePayload(data) {
      return api.parseWebhookPayload(data);
    },

    async addReaction(messageId, emoji) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.addReaction(_c.appId, _c.appSecret, messageId, emoji);
    },

    async removeReaction(messageId, reactionId) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.removeReaction(_c.appId, _c.appSecret, messageId, reactionId);
    },

    async sendMarkdown(userId, options) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.sendMarkdownCard(_c.appId, _c.appSecret, userId, options);
    },

    async sendDocCard(userId, options) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.sendDocCard(_c.appId, _c.appSecret, userId, options);
    },

    async sendCalendarCard(userId, options) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.sendCalendarCard(_c.appId, _c.appSecret, userId, options);
    },

    async sendTaskCard(userId, options) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.sendTaskCard(_c.appId, _c.appSecret, userId, options);
    },

    async sendSmart(userId, content, metadata = {}) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }

      if (metadata.docUrl) {
        return api.sendDocCard(_c.appId, _c.appSecret, userId, {
          title: metadata.title,
          docUrl: metadata.docUrl,
          docType: metadata.docType || 'docx',
          description: metadata.description
        });
      }

      if (metadata.calendarEvent) {
        return api.sendCalendarCard(_c.appId, _c.appSecret, userId, metadata.calendarEvent);
      }

      if (metadata.task) {
        return api.sendTaskCard(_c.appId, _c.appSecret, userId, metadata.task);
      }

      return api.sendMessage(_c.appId, _c.appSecret, userId, content);
    },

    routeGroupMessage(event) {
      return groupRouter.route(event);
    },

    startEventServer() {
      // 2026-09-06 加固: ①幂等（重复启动不再叠加监听器/重复 listen）；
      // ②channel 侧订阅 error（event-server 此前 emit('error') 无订阅者会 throw）
      if (this._eventServerStarted) return;
      this._eventServerStarted = true;
      eventServer.on('error', (err) => {
        console.warn('[lark-channel] event-server 错误:', err.message || err);
      });
      eventServer.on('message', (event) => {
        try { channel.emit('message', event); } catch (e) { console.error('[lark-channel] message 处理失败:', e.message); }
      });
      eventServer.on('card_action', (event) => {
        try { channel.emit('card_action', event); } catch (e) { console.error('[lark-channel] card_action 处理失败:', e.message); }
      });
      eventServer.on('bot_joined_group', (event) => {
        channel.emit('bot_joined_group', event);
      });
      eventServer.on('bot_left_group', (event) => {
        channel.emit('bot_left_group', event);
      });
      eventServer.on('bot_menu_action', (event) => {
        channel.emit('bot_menu_action', event);
      });
      eventServer.start();
    },

    stopEventServer() {
      eventServer.stop();
    },

    async getToken() {
      return tokenManager.getAccessToken(appId);
    },

    getEventServerStats() {
      return eventServer.getStats();
    },

    getGroupRouterStats() {
      return groupRouter.getStats();
    },

    getTokenManagerStats() {
      return tokenManager.getStats();
    },

    addConfirmation(taskId, task, userId) {
      pendingConfirmations.set(taskId, {
        task,
        userId,
        createdAt: Date.now(),
        status: 'pending'
      });

      setTimeout(() => {
        if (pendingConfirmations.has(taskId) &&
            pendingConfirmations.get(taskId).status === 'pending') {
          pendingConfirmations.delete(taskId);
          console.log(`⏰ 确认超时: ${taskId}`);
        }
      }, 5 * 60 * 1000);
    },

    getConfirmation(taskId) {
      return pendingConfirmations.get(taskId);
    },

    confirm(taskId, userId) {
      const pending = pendingConfirmations.get(taskId);

      if (!pending) {
        return { success: false, message: '确认请求已过期' };
      }

      if (pending.userId !== userId) {
        return { success: false, message: '无权操作' };
      }

      if (pending.status !== 'pending') {
        return { success: false, message: '已处理' };
      }

      pendingConfirmations.delete(taskId);
      return { success: true, task: pending.task };
    },

    isConfigured() {
      const c = _getCreds();
      return !!(c.appId && c.appSecret);
    },

    async downloadFile(fileKey, savePath, messageId) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.downloadFile(_c.appId, _c.appSecret, fileKey, savePath, messageId);
    },

    async downloadImage(imageKey, savePath, messageId) {
      const _c = _getCreds(); if (!_c.appId || !_c.appSecret) {
        throw new Error('飞书未配置');
      }
      return api.downloadImage(_c.appId, _c.appSecret, imageKey, savePath, messageId);
    },

    destroy() {
      eventServer.stop();
      tokenManager.destroy();
    },
  });

  return channel;
}

module.exports = {
  createChannel,
  api,
  LarkEventServer,
  LARK_EVENT_TYPES,
  LarkGroupRouter,
  LARK_CHAT_TYPES,
  LARK_GROUP_MESSAGE_POLICIES,
  TokenManager,
};
