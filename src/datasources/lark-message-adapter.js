const { DataSourceAdapter, DATA_SOURCE_TYPES } = require('./base-adapter');
const larkApi = require('../channels/lark/api');

class LarkMessageDataSource extends DataSourceAdapter {
  constructor(opts = {}) {
    super({
      ...opts,
      name: 'lark-message',
      type: DATA_SOURCE_TYPES.MESSAGE,
      platform: 'lark',
    });
    this._appId = opts.appId || '';
    this._appSecret = opts.appSecret || '';
    this._messageBuffer = [];
    this._bufferSize = opts.bufferSize || 1000;
  }

  get isConfigured() {
    return !!(this._appId && this._appSecret);
  }

  async connect() {
    if (!this.isConfigured) {
      throw new Error('飞书消息源未配置: 需要 appId 和 appSecret');
    }
    this.emit('connected');
  }

  async disconnect() {
    this.stopSync();
    this.emit('disconnected');
  }

  handleWebhookMessage(data) {
    const parsed = larkApi.parseWebhookPayload(data);
    const normalized = this.normalize({
      ...parsed,
      rawPayload: data,
    });

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
    const senderId = rawMsg.senderId || '';
    const content = rawMsg.content || '';
    const msgType = rawMsg.msgType || 'text';
    const messageId = rawMsg.messageId || `lark_${Date.now()}`;
    const files = rawMsg.files || [];

    let displayContent = content;
    if (msgType === 'image') {
      displayContent = `[图片] ${content}`;
    } else if (msgType === 'file') {
      displayContent = `[文件] ${content}`;
    } else if (msgType === 'audio') {
      displayContent = `[语音] ${content}`;
    } else if (msgType === 'media') {
      displayContent = `[媒体] ${content}`;
    }

    const normalizedContent = `[飞书消息] 来自: ${senderId}\n${displayContent}`;

    return {
      id: `lark_msg_${messageId}`,
      content: normalizedContent,
      timestamp: Date.now(),
      entities: this._extractEntities(senderId, content),
      topics: this._extractTopics(content, msgType),
      metadata: {
        messageId,
        senderId,
        msgType,
        files: files.map(f => ({
          type: f.type || '',
          fileKey: f.fileKey || '',
          fileName: f.fileName || '',
        })),
        eventType: rawMsg.rawPayload?.header?.event_type || '',
      },
    };
  }

  _extractEntities(senderId, content) {
    const entities = [];
    if (senderId) {
      entities.push({ type: 'person', name: senderId, source: 'lark_sender' });
    }
    const ouIdRegex = /ou_[a-zA-Z0-9]+/g;
    const ouIds = (content || '').match(ouIdRegex) || [];
    for (const ouId of ouIds) {
      entities.push({ type: 'lark_user', name: ouId, source: 'lark_content' });
    }
    return entities;
  }

  _extractTopics(content, msgType) {
    const topics = [];
    if (msgType) topics.push(`lark_${msgType}`);
    return topics;
  }
}

module.exports = { LarkMessageDataSource };
