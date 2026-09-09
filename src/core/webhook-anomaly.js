const crypto = require('crypto');
const { EventEmitter } = require('events');

class WebhookAnomalyTracker extends EventEmitter {
  constructor() {
    super();
    this._anomalies = [];
    this._maxAnomalies = 1000;
    this._dedupWindow = 60000;
    this._dedupMap = new Map();
  }

  track({ type, platform, detail, eventId, headers }) {
    const now = Date.now();
    const dedupKey = `${type}:${platform}:${eventId || ''}`;
    const lastTime = this._dedupMap.get(dedupKey);
    if (lastTime && (now - lastTime) < this._dedupWindow) {
      return null;
    }
    this._dedupMap.get(dedupKey);
    this._dedupMap.set(dedupKey, now);
    const anomaly = {
      id: `anom_${now}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
      type,
      platform,
      detail: detail || '',
      eventId: eventId || '',
      timestamp: now,
      headers: headers ? Object.fromEntries(
        Object.entries(headers).filter(([k]) => !k.toLowerCase().startsWith('x-forwarded'))
      ) : {},
    };
    this._anomalies.push(anomaly);
    if (this._anomalies.length > this._maxAnomalies) {
      this._anomalies = this._anomalies.slice(-this._maxAnomalies);
    }
    this.emit('anomaly', anomaly);
    if (type === 'signature_failure') {
      this.emit('security', anomaly);
    }
    return anomaly;
  }

  trackDuplicate({ platform, eventId, delayMs }) {
    return this.track({
      type: 'duplicate_event',
      platform,
      detail: `重复事件 ${eventId}，延迟 ${delayMs}ms`,
      eventId,
    });
  }

  trackDelayed({ platform, eventId, delayMs }) {
    return this.track({
      type: 'delayed_event',
      platform,
      detail: `延迟事件 ${eventId}，延迟 ${delayMs}ms`,
      eventId,
    });
  }

  // eslint-disable-next-line no-unused-vars
  trackSignatureFailure({ platform, eventId, expected, actual }) {
    return this.track({
      type: 'signature_failure',
      platform,
      detail: `签名验证失败 ${eventId}`,
      eventId,
    });
  }

  trackRateLimited({ platform, eventId }) {
    return this.track({
      type: 'rate_limited',
      platform,
      detail: `Webhook 速率限制 ${eventId}`,
      eventId,
    });
  }

  getRecent(count) {
    count = count || 50;
    return this._anomalies.slice(-count);
  }

  getByType(type) {
    return this._anomalies.filter(a => a.type === type);
  }

  getByPlatform(platform) {
    return this._anomalies.filter(a => a.platform === platform);
  }

  getStats() {
    const byType = {};
    const byPlatform = {};
    for (const a of this._anomalies) {
      byType[a.type] = (byType[a.type] || 0) + 1;
      byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1;
    }
    return {
      total: this._anomalies.length,
      byType,
      byPlatform,
      lastAnomaly: this._anomalies[this._anomalies.length - 1] || null,
    };
  }

  clear() {
    this._anomalies = [];
    this._dedupMap.clear();
  }
}

let _instance = null;

function getWebhookAnomalyTracker() {
  if (!_instance) {
    _instance = new WebhookAnomalyTracker();
  }
  return _instance;
}

module.exports = {
  WebhookAnomalyTracker,
  getWebhookAnomalyTracker,
};
