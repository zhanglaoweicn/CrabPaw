const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const LARK_EVENT_TYPES = {
  URL_VERIFICATION: 'url_verification',
  MESSAGE_RECEIVE: 'im.message.receive_v1',
  MESSAGE_READ: 'im.message.message_read_v1',
  MESSAGE_REACTION: 'im.message.reaction.created_v1',
  CARD_ACTION: 'card.action.trigger',
  BOT_JOIN_GROUP: 'im.chat.member.bot.added_v1',
  BOT_LEAVE_GROUP: 'im.chat.member.bot.deleted_v1',
  ADD_BOT: 'application.bot.menu_v6',
};

class LarkEventServer extends EventEmitter {
  constructor(config = {}) {
    super();
    this._appId = config.appId || '';
    this._appSecret = config.appSecret || '';
    this._verificationToken = config.verificationToken || '';
    this._encryptKey = config.encryptKey || '';
    this._port = config.port || 38770;
    this._server = null;
    this._running = false;
    this._stats = {
      totalEvents: 0,
      urlVerified: 0,
      messagesReceived: 0,
      errors: 0,
    };
  }

  start() {
    if (this._running) return;

    this._server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        this._handleRequest(req, res);
      } else {
        res.writeHead(405);
        res.end('Method Not Allowed');
      }
    });

    this._server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // 2026-09-06: 只记日志、不再 emit('error')——channel 侧无订阅者时
        // EventEmitter 会直接 throw，经 uncaughtException 处理器杀掉主服务
        console.warn(`⚠️ 飞书事件服务端口 ${this._port} 已被占用（可能已有实例在运行）`);
        this._server = null;
        return;
      }
      console.error('❌ 飞书事件服务错误:', err.message);
    });

    this._server.listen(this._port, () => {
      this._running = true;
      console.log(`✅ 飞书事件订阅服务启动，监听端口 ${this._port}`);
      this.emit('started', { port: this._port });
    });
  }

  stop() {
    if (this._server) {
      try { this._server.close(() => {}); } catch (e) { console.warn('[event-server] close 失败:', e.message); }
      this._server = null;
    }
    this._running = false;
    this.emit('stopped');
  }

  async _handleRequest(req, res) {
    const body = await this._readBody(req);

    try {
      let data = JSON.parse(body);

      if (this._encryptKey && data.encrypt) {
        data = this._decryptEvent(data.encrypt);
      }

      // 2026-08-07 (S2 安全): 飞书事件订阅服务此前零验签——任何来源可伪造事件
      // 注入消息流水线。现校验事件体 token == 配置的 verificationToken：
      // - url_verification / v1 事件: token 在顶层；v2 事件: header.token
      // - 未配置 verificationToken 时安全降级：拒绝（401），不跳过校验
      // TODO(security): encrypt_key 解密后（_decryptEvent 为内部简化实现，
      // 飞书规范为 AES-256-CBC key=encryptKey, iv=前16字节），应在解密结果上
      // 继续校验 token——当前对无法解密的加密回调一律 401。
      const bodyToken = String(data && (data.token || (data.header && data.header.token)) || '');
      if (!this._verificationToken || !bodyToken) {
        this._stats.errors++;
        console.warn(`❌ 飞书事件 token 校验失败（verificationToken 未配置或事件缺 token），已拒绝`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: -1, msg: 'Invalid verification token' }));
        return;
      }
      if (!this._safeTokenEqual(bodyToken, this._verificationToken)) {
        this._stats.errors++;
        console.warn('❌ 飞书事件 token 不匹配（可能为伪造请求），已拒绝');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: -1, msg: 'Invalid verification token' }));
        return;
      }

      if (data.type === LARK_EVENT_TYPES.URL_VERIFICATION) {
        this._stats.urlVerified++;
        const challenge = data.challenge || '';
        const response = {
          challenge,
          token: data.token || '',
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        console.log('✅ 飞书URL验证通过');
        this.emit('url_verified', { challenge });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));

      const eventType = data.header?.event_type || data.event_type || '';
      const eventId = data.header?.event_id || data.event_id || '';
      const appId = data.header?.app_id || data.app_id || '';
      const tenantKey = data.header?.tenant_key || '';

      this._stats.totalEvents++;

      const event = {
        eventType,
        eventId,
        appId,
        tenantKey,
        data: data.event || data,
        header: data.header || {},
        rawBody: data,
        receivedAt: Date.now(),
      };

      if (eventType === LARK_EVENT_TYPES.MESSAGE_RECEIVE) {
        this._stats.messagesReceived++;
        this._handleMessageEvent(event);
      } else if (eventType === LARK_EVENT_TYPES.CARD_ACTION) {
        this._handleCardAction(event);
      } else if (eventType === LARK_EVENT_TYPES.BOT_JOIN_GROUP) {
        this.emit('bot_joined_group', event);
      } else if (eventType === LARK_EVENT_TYPES.BOT_LEAVE_GROUP) {
        this.emit('bot_left_group', event);
      } else if (eventType === LARK_EVENT_TYPES.ADD_BOT) {
        this.emit('bot_menu_action', event);
      } else {
        this.emit('event', event);
      }
    } catch (e) {
      this._stats.errors++;
      console.error('❌ 飞书事件处理失败:', e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: -1, msg: e.message }));
      this.emit('error', e);
    }
  }

  _handleMessageEvent(event) {
    const msgData = event.data || {};
    const sender = msgData.sender || {};
    const message = msgData.message || {};

    const chatType = message.chat_type || 'p2p';
    const chatId = message.chat_id || '';
    const msgType = message.message_type || 'text';
    const msgId = message.message_id || '';
    const content = message.content || '';

    const parsedEvent = {
      eventType: event.eventType,
      eventId: event.eventId,
      msgType,
      msgId,
      chatId,
      chatType,
      content: this._parseMessageContent(msgType, content),
      fromUserId: sender.sender_id?.open_id || sender.sender_id?.user_id || '',
      fromUserName: sender.sender_id?.name || '',
      rawBody: event.rawBody,
      timestamp: Date.now(),
    };

    this.emit('message', parsedEvent);
  }

  _handleCardAction(event) {
    const action = event.data || {};
    this.emit('card_action', {
      eventType: event.eventType,
      eventId: event.eventId,
      action: action.action || {},
      openId: action.open_id || action.operator?.open_id || '',
      chatId: action.chat_id || '',
      messageId: action.message_id || '',
      rawBody: event.rawBody,
      timestamp: Date.now(),
    });
  }

  _parseMessageContent(msgType, contentStr) {
    if (!contentStr) return '';

    try {
      const parsed = JSON.parse(contentStr);

      switch (msgType) {
        case 'text':
          return parsed.text || '';
        case 'post':
          return this._extractPostContent(parsed);
        case 'image':
          return parsed.text || '[图片]';
        case 'file':
          return parsed.text || '[文件]';
        case 'audio':
          return '[语音消息]';
        default:
          return contentStr;
      }
    } catch (e) {
      return contentStr;
    }
  }

  _extractPostContent(postData) {
    const content = postData.content || [];
    const parts = [];

    for (const line of content) {
      for (const element of line) {
        if (element.tag === 'text') {
          parts.push(element.text || '');
        } else if (element.tag === 'at') {
          parts.push(element.user_id ? `@${element.user_id}` : '@所有人');
        } else if (element.tag === 'a') {
          parts.push(element.text || element.href || '');
        }
      }
      parts.push('\n');
    }

    return parts.join('').trim();
  }

  _safeTokenEqual(a, b) {
    const A = String(a || '');
    const B = String(b || '');
    if (A.length !== B.length || A.length === 0) return false;
    return crypto.timingSafeEqual(Buffer.from(A), Buffer.from(B));
  }

  _decryptEvent(encryptStr) {
    const key = crypto.createHash('sha256').update(this._encryptKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, key);

    let decrypted = decipher.update(encryptStr, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  getStats() {
    return { ...this._stats, running: this._running, port: this._port };
  }
}

LarkEventServer.LARK_EVENT_TYPES = LARK_EVENT_TYPES;

module.exports = { LarkEventServer, LARK_EVENT_TYPES };
