/**
 * Webhook Notification Manager — Webhook 通知管理器
 *
 * 参考 Hindsight 的 Webhook 机制：
 * - 事件驱动的 Webhook 通知
 * - HMAC-SHA256 签名验证
 * - 指数退避重试
 * - 可配置的事件订阅过滤
 *
 * 使用方式：
 *   const { getWebhookManager } = require('./webhook-manager');
 *   const wh = getWebhookManager();
 *   wh.initialize();
 *   wh.register('https://example.com/hook', { events: ['skill_evolve', 'skill_degradation'] });
 *   wh.notify('skill_evolve', { skillName: 'test', type: 'FIX' });
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { DATA_DIR } = require('./config');

const WEBHOOK_DIR = path.join(DATA_DIR, 'webhooks');
const WEBHOOKS_FILE = path.join(WEBHOOK_DIR, 'webhooks.json');
const DELIVERY_LOG_FILE = path.join(WEBHOOK_DIR, 'delivery-log.json');

const DEFAULT_CONFIG = {
  maxRetries: 3,
  initialRetryDelayMs: 1000,
  maxRetryDelayMs: 60000,
  retryMultiplier: 2,
  requestTimeoutMs: 10000,
  maxDeliveryLog: 200,
  maxWebhooks: 20,
  signatureSecret: null, // 可选：用于 HMAC-SHA256 签名
};

class WebhookDelivery {
  constructor(data = {}) {
    this.id = data.id || `del_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.webhookId = data.webhookId || '';
    this.event = data.event || '';
    this.payload = data.payload || {};
    this.status = data.status || 'pending'; // pending / delivered / failed
    this.attempts = data.attempts || 0;
    this.lastAttemptAt = data.lastAttemptAt || null;
    this.lastError = data.lastError || null;
    this.createdAt = data.createdAt || Date.now();
    this.deliveredAt = data.deliveredAt || null;
  }

  toJSON() {
    return {
      id: this.id,
      webhookId: this.webhookId,
      event: this.event,
      payload: this.payload,
      status: this.status,
      attempts: this.attempts,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
      createdAt: this.createdAt,
      deliveredAt: this.deliveredAt,
    };
  }
}

class WebhookRegistration {
  constructor(data = {}) {
    this.id = data.id || `wh_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.url = data.url || '';
    this.events = data.events || ['*']; // 订阅的事件类型，* 表示全部
    this.secret = data.secret || null;   // 该 hook 的签名密钥
    this.active = data.active !== false;
    this.createdAt = data.createdAt || Date.now();
    this.lastDeliveryAt = data.lastDeliveryAt || null;
    this.failureCount = data.failureCount || 0;
    this.successCount = data.successCount || 0;
    this.headers = data.headers || {};   // 自定义请求头
  }

  matchesEvent(event) {
    if (!this.active) return false;
    if (this.events.includes('*')) return true;
    return this.events.includes(event);
  }

  toJSON() {
    return {
      id: this.id,
      url: this.url,
      events: this.events,
      active: this.active,
      createdAt: this.createdAt,
      lastDeliveryAt: this.lastDeliveryAt,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }
}

class WebhookManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._webhooks = new Map();
    this._deliveryLog = [];
    this._retryQueue = [];
    this._retryTimer = null;
    this._initialized = false;
  }

  initialize() {
    if (!fs.existsSync(WEBHOOK_DIR)) {
      fs.mkdirSync(WEBHOOK_DIR, { recursive: true });
    }
    this._loadData();
    this._startRetryProcessor();
    this._initialized = true;
    console.log(`[WebhookManager] 初始化完成, ${this._webhooks.size} 个 Webhook`);
  }

  shutdown() {
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    this._saveData();
    this._initialized = false;
  }

  /**
   * 注册 Webhook
   */
  register(url, opts = {}) {
    if (this._webhooks.size >= this.config.maxWebhooks) {
      throw new Error(`Webhook 数量已达上限 ${this.config.maxWebhooks}`);
    }

    // 验证 URL
    try {
      const parsedUrl = new URL(url);
      // 只允许 http 和 https 协议，防止 SSRF
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error(`不支持的协议: ${parsedUrl.protocol}`);
      }
    } catch (e) {
      throw new Error(`无效的 Webhook URL: ${e.message}`);
    }

    const webhook = new WebhookRegistration({
      url,
      events: opts.events || ['*'],
      secret: opts.secret || null,
      active: opts.active !== false,
      headers: opts.headers || {},
    });

    this._webhooks.set(webhook.id, webhook);
    this._saveData();

    this.emit('webhook:registered', { id: webhook.id, url });
    return webhook.toJSON();
  }

  /**
   * 注销 Webhook
   */
  unregister(webhookId) {
    const webhook = this._webhooks.get(webhookId);
    if (!webhook) return false;

    this._webhooks.delete(webhookId);
    this._saveData();
    this.emit('webhook:unregistered', { id: webhookId });
    return true;
  }

  /**
   * 发送事件通知到所有匹配的 Webhook
   */
  notify(event, payload = {}) {
    if (!this._initialized) return;

    const notification = {
      event,
      payload,
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    };

    for (const webhook of this._webhooks.values()) {
      if (!webhook.matchesEvent(event)) continue;

      const delivery = new WebhookDelivery({
        webhookId: webhook.id,
        event,
        payload: notification,
      });

      this._deliver(webhook, delivery);
    }
  }

  /**
   * 获取所有 Webhook
   */
  listWebhooks() {
    return Array.from(this._webhooks.values()).map(w => w.toJSON());
  }

  /**
   * 获取投递日志
   */
  getDeliveryLog(opts = {}) {
    const { limit = 50, webhookId, event, status } = opts;
    let logs = this._deliveryLog;

    if (webhookId) logs = logs.filter(l => l.webhookId === webhookId);
    if (event) logs = logs.filter(l => l.event === event);
    if (status) logs = logs.filter(l => l.status === status);

    return logs.slice(-limit);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    let totalDelivered = 0;
    let totalFailed = 0;

    for (const wh of this._webhooks.values()) {
      totalDelivered += wh.successCount;
      totalFailed += wh.failureCount;
    }

    return {
      totalWebhooks: this._webhooks.size,
      activeWebhooks: Array.from(this._webhooks.values()).filter(w => w.active).length,
      totalDelivered,
      totalFailed,
      pendingRetries: this._retryQueue.length,
    };
  }

  // ===== 内部方法 =====

  async _deliver(webhook, delivery) {
    delivery.attempts++;
    delivery.lastAttemptAt = Date.now();

    try {
      const body = JSON.stringify(delivery.payload);
      const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': delivery.event,
        'X-Webhook-Delivery': delivery.id,
        'X-Webhook-Timestamp': delivery.payload.timestamp || new Date().toISOString(),
        ...webhook.headers,
      };

      // HMAC-SHA256 签名
      const secret = webhook.secret || this.config.signatureSecret;
      if (secret) {
        const signature = crypto
          .createHmac('sha256', secret)
          .update(body)
          .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      await this._httpPost(webhook.url, body, headers);

      delivery.status = 'delivered';
      delivery.deliveredAt = Date.now();
      webhook.successCount++;
      webhook.lastDeliveryAt = Date.now();

      this.emit('webhook:delivered', { deliveryId: delivery.id, webhookId: webhook.id });
    } catch (e) {
      delivery.lastError = e.message;

      if (delivery.attempts < this.config.maxRetries) {
        // 加入重试队列（指数退避）
        this._retryQueue.push({ webhook, delivery });
        this.emit('webhook:retry', { deliveryId: delivery.id, attempt: delivery.attempts });
      } else {
        delivery.status = 'failed';
        webhook.failureCount++;
        this.emit('webhook:failed', { deliveryId: delivery.id, error: e.message });
      }
    }

    this._logDelivery(delivery);
    this._saveData();
  }

  _httpPost(url, body, headers) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: this.config.requestTimeoutMs,
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode });
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      req.write(body);
      req.end();
    });
  }

  _startRetryProcessor() {
    this._retryTimer = setInterval(() => {
      this._processRetries();
    }, 5000);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  async _processRetries() {
    if (this._retryQueue.length === 0) return;

    const batch = this._retryQueue.splice(0, 5); // 每次最多处理5个

    for (const { webhook, delivery } of batch) {
      // 指数退避延迟
      const delay = Math.min(
        this.config.initialRetryDelayMs * Math.pow(this.config.retryMultiplier, delivery.attempts - 1),
        this.config.maxRetryDelayMs
      );

      const elapsed = Date.now() - (delivery.lastAttemptAt || 0);
      if (elapsed < delay) {
        this._retryQueue.push({ webhook, delivery }); // 放回队列
        continue;
      }

      await this._deliver(webhook, delivery);
    }
  }

  _logDelivery(delivery) {
    this._deliveryLog.push(delivery.toJSON());
    if (this._deliveryLog.length > this.config.maxDeliveryLog) {
      this._deliveryLog = this._deliveryLog.slice(-this.config.maxDeliveryLog);
    }
  }

  _loadData() {
    try {
      if (fs.existsSync(WEBHOOKS_FILE)) {
        const data = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf-8'));
        for (const whData of data) {
          const wh = new WebhookRegistration(whData);
          this._webhooks.set(wh.id, wh);
        }
      }
    } catch (e) {
      console.warn('[WebhookManager] 加载 Webhook 数据失败:', e.message);
    }

    try {
      if (fs.existsSync(DELIVERY_LOG_FILE)) {
        this._deliveryLog = JSON.parse(fs.readFileSync(DELIVERY_LOG_FILE, 'utf-8'));
      }
    } catch {
      this._deliveryLog = [];
    }
  }

  _saveData() {
    try {
      if (!fs.existsSync(WEBHOOK_DIR)) {
        fs.mkdirSync(WEBHOOK_DIR, { recursive: true });
      }

      const whData = Array.from(this._webhooks.values()).map(w => w.toJSON());
      fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(whData, null, 2), 'utf-8');

      fs.writeFileSync(DELIVERY_LOG_FILE, JSON.stringify(this._deliveryLog, null, 2), 'utf-8');
    } catch (e) {
      console.error('[WebhookManager] 保存数据失败:', e.message);
    }
  }
}

// 单例
let _instance = null;

function getWebhookManager(config) {
  if (!_instance) {
    _instance = new WebhookManager(config);
  }
  return _instance;
}

module.exports = {
  WebhookManager,
  WebhookRegistration,
  WebhookDelivery,
  getWebhookManager,
};
