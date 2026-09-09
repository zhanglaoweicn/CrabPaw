const { EventEmitter } = require('events');

const TOKEN_EXPIRE_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_AHEAD_MS = 10 * 60 * 1000;

class TokenManager extends EventEmitter {
  // eslint-disable-next-line no-unused-vars -- 构造函数参数 config 暂未使用（预留给外部配置注入）
  constructor(config = {}) {
    super();
    this._tokens = new Map();
    this._configs = new Map();
    this._refreshTimers = new Map();
    this._stats = {
      tokensIssued: 0,
      refreshCount: 0,
      errors: 0,
    };
  }

  registerApp(appId, appSecret, options = {}) {
    this._configs.set(appId, {
      appId,
      appSecret,
      tenantKey: options.tenantKey || '',
      autoRefresh: options.autoRefresh !== false,
    });

    this._tokens.set(appId, {
      accessToken: '',
      expireTime: 0,
      refreshToken: '',
      lastRefreshTime: 0,
    });
  }

  removeApp(appId) {
    this._configs.delete(appId);
    this._tokens.delete(appId);

    const timer = this._refreshTimers.get(appId);
    if (timer) {
      clearTimeout(timer);
      this._refreshTimers.delete(appId);
    }
  }

  async getAccessToken(appId) {
    const tokenEntry = this._tokens.get(appId);
    if (!tokenEntry) {
      throw new Error(`未注册的飞书应用: ${appId}`);
    }

    if (tokenEntry.accessToken && tokenEntry.expireTime > Date.now() + TOKEN_EXPIRE_BUFFER_MS) {
      return tokenEntry.accessToken;
    }

    return this._refreshToken(appId);
  }

  async _refreshToken(appId) {
    const config = this._configs.get(appId);
    if (!config) {
      throw new Error(`未注册的飞书应用: ${appId}`);
    }

    try {
      const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
      const body = {
        app_id: config.appId,
        app_secret: config.appSecret,
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await resp.json();

      if (data.code !== 0) {
        throw new Error(`获取飞书token失败(${appId}): ${data.msg}`);
      }

      const tokenEntry = this._tokens.get(appId);
      tokenEntry.accessToken = data.tenant_access_token;
      tokenEntry.expireTime = Date.now() + (data.expire - 300) * 1000;
      tokenEntry.lastRefreshTime = Date.now();

      this._stats.tokensIssued++;
      this._stats.refreshCount++;

      this.emit('token_refreshed', { appId, expireTime: tokenEntry.expireTime });

      if (config.autoRefresh) {
        this._scheduleRefresh(appId, data.expire * 1000 - REFRESH_AHEAD_MS);
      }

      return tokenEntry.accessToken;
    } catch (e) {
      this._stats.errors++;
      this.emit('token_error', { appId, error: e.message });
      throw e;
    }
  }

  _scheduleRefresh(appId, delayMs) {
    const existing = this._refreshTimers.get(appId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(async () => {
      try {
        await this._refreshToken(appId);
      } catch (e) {
        console.error(`❌ 飞书token自动刷新失败(${appId}):`, e.message);
        this._scheduleRefresh(appId, 60000);
      }
    }, Math.max(delayMs, 60000));

    this._refreshTimers.set(appId, timer);
  }

  getTokenInfo(appId) {
    const entry = this._tokens.get(appId);
    if (!entry) return null;

    return {
      appId,
      hasToken: !!entry.accessToken,
      expireTime: entry.expireTime,
      isExpired: entry.expireTime <= Date.now(),
      lastRefreshTime: entry.lastRefreshTime,
    };
  }

  getAllTokenInfo() {
    const result = [];
    for (const appId of this._tokens.keys()) {
      result.push(this.getTokenInfo(appId));
    }
    return result;
  }

  async refreshAll() {
    const results = [];
    for (const appId of this._configs.keys()) {
      try {
        const token = await this._refreshToken(appId);
        results.push({ appId, success: true, token: token.substring(0, 10) + '...' });
      } catch (e) {
        results.push({ appId, success: false, error: e.message });
      }
    }
    return results;
  }

  destroy() {
    for (const timer of this._refreshTimers.values()) {
      clearTimeout(timer);
    }
    this._refreshTimers.clear();
    this._tokens.clear();
    this._configs.clear();
  }

  getStats() {
    return {
      ...this._stats,
      registeredApps: this._configs.size,
      activeTokens: Array.from(this._tokens.values()).filter(t => t.accessToken && t.expireTime > Date.now()).length,
    };
  }
}

module.exports = { TokenManager };
