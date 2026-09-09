const { DataSourceAdapter, DATA_SOURCE_TYPES } = require('./base-adapter');
const wecomApi = require('../channels/wecom/index');

class WeComMessageDataSource extends DataSourceAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      name: 'wecom-message',
      type: DATA_SOURCE_TYPES.MESSAGE,
      platform: 'wecom',
    });
    this._corpId = opts.corpId || '';
    this._agentId = opts.agentId || '';
    this._secret = opts.secret || '';
    this._accessToken = null;
    this._tokenExpireTime = 0;
    this._messageBuffer = [];
    this._bufferSize = opts.bufferSize || 1000;
    this._webhookHandler = null;
  }

  get isConfigured() {
    return !!(this._corpId && this._secret);
  }

  async connect() {
    if (!this.isConfigured) {
      throw new Error('企业微信消息源未配置: 需要 corpId 和 secret');
    }
    await this._getAccessToken();
    this.emit('connected');
  }

  async disconnect() {
    this._accessToken = null;
    this._tokenExpireTime = 0;
    this.stopSync();
    this.emit('disconnected');
  }

  handleWebhookMessage(data) {
    const parsed = wecomApi.api.parseCallbackPayload(data);
    const normalized = this.normalize(parsed);

    this._messageBuffer.push(normalized);
    if (this._messageBuffer.length > this._bufferSize) {
      this._messageBuffer = this._messageBuffer.slice(-this._bufferSize);
    }

    this.emit('message', normalized);

    if (this._memoryTree) {
      this._memoryTree.appendLeaf(normalized.content, {
        tokenCount: this._estimateTokens(normalized.content),
        entities: normalized.entities || [],
        topics: normalized.topics || [],
        sourceType: this.type,
        sourcePlatform: this.platform,
        sourceId: normalized.id,
        timestamp: normalized.timestamp,
        metadata: normalized.metadata || {},
      });
    }

    if (this._onData) {
      this._onData(normalized);
    }

    return normalized;
  }

  async fetch(options = {}) {
    const limit = options.limit || this._bufferSize;
    const since = options.since || 0;

    if (this._messageBuffer.length > 0) {
      return this._messageBuffer
        .filter(m => m.timestamp >= since)
        .slice(-limit);
    }

    return [];
  }

  normalize(rawMsg) {
    const fromUserId = rawMsg.fromUserId || '';
    const fromUserName = rawMsg.fromUserName || '';
    const fromDisplay = fromUserName || fromUserId || '';
    const content = rawMsg.content || '';
    const msgType = rawMsg.msgType || 'text';
    const chatId = rawMsg.chatId || '';
    const chatType = rawMsg.chatType || 'single';
    const msgId = rawMsg.msgId || `wecom_${Date.now()}`;
    const timestamp = rawMsg.timestamp || Date.now();

    let displayContent = content;
    if (msgType === 'image') {
      displayContent = `[图片] ${content}`;
    } else if (msgType === 'file') {
      displayContent = `[文件] ${content}`;
    } else if (msgType === 'voice') {
      displayContent = `[语音] ${content}`;
    } else if (msgType === 'video') {
      displayContent = `[视频] ${content}`;
    } else if (msgType === 'location') {
      displayContent = `[位置] ${content}`;
    }

    const prefix = chatType === 'group'
      ? `[企业微信群消息] 来自: ${fromDisplay} (群: ${chatId})`
      : `[企业微信消息] 来自: ${fromDisplay}`;

    const normalizedContent = `${prefix}\n${displayContent}`;

    return {
      id: `wecom_msg_${msgId}`,
      content: normalizedContent,
      timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime(),
      entities: this._extractEntities(fromUserId, chatId, content),
      topics: this._extractTopics(content, chatType),
      metadata: {
        msgId,
        fromUserId: rawMsg.fromUserId || '',
        fromUserName: rawMsg.fromUserName || '',
        chatId,
        chatType,
        msgType,
        files: rawMsg.files || [],
        rawBody: rawMsg.rawBody || null,
      },
    };
  }

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpireTime) {
      return this._accessToken;
    }

    const https = require('https');
    return new Promise((resolve, reject) => {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this._corpId}&corpsecret=${this._secret}`;
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.errcode === 0 && result.access_token) {
              this._accessToken = result.access_token;
              this._tokenExpireTime = Date.now() + (result.expires_in - 300) * 1000;
              resolve(this._accessToken);
            } else {
              reject(new Error(result.errmsg || '获取access_token失败'));
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  _extractEntities(fromUserId, chatId, _content) {
    const entities = [];
    if (fromUserId) {
      entities.push({ type: 'person', name: fromUserId, source: 'wecom_from' });
    }
    if (chatId) {
      entities.push({ type: 'group', name: chatId, source: 'wecom_chat' });
    }
    return entities;
  }

  _extractTopics(content, chatType) {
    const topics = [];
    if (chatType) topics.push(`wecom_${chatType}`);
    return topics;
  }
}

module.exports = { WeComMessageDataSource };
