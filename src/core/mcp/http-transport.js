/**
 * MCP 传输层 — HTTP 传输
 *
 * 连接远程 MCP 服务器，通过 HTTP POST 通信
 */

const { EventEmitter } = require('events');

class HttpTransport extends EventEmitter {
  constructor(config) {
    super();
    this.url = config.url;
    this.headers = config.headers || {};
    this.timeout = config.timeout || 30000;
    this.connectTimeout = config.connectTimeout || 10000;
    this.oauth = config.oauth || null; // OAuth 配置
    this.serverId = config.serverId || null; // 用于 OAuth token 查找

    this._requestId = 0;
    this._connected = false;
    this._sessionId = null;
  }

  async connect() {
    if (!this.url) {
      throw new Error('MCP HTTP: 未配置服务器 URL');
    }

    try {
      // 尝试 initialize 握手
      const result = await this.sendRequest('initialize', {
        clientInfo: {
          name: 'CrabPaw MCP Client',
          version: '1.0.0',
        },
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      });

      this._sessionId = result.sessionId || null;
      this._connected = true;
      this.emit('connected');

      // 发送 initialized 通知
      this.sendNotification('notifications/initialized', {});

      return result;
    } catch (e) {
      this._connected = false;
      throw new Error(`MCP HTTP 连接失败: ${e.message}`);
    }
  }

  async disconnect() {
    this._connected = false;
    this._sessionId = null;
    this.emit('disconnected');
  }

  async sendRequest(method, params = {}) {
    const id = ++this._requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = {
        'Content-Type': 'application/json',
        // MCP Streamable HTTP 规范：服务端按 Accept 决定 JSON 或 SSE 响应
        // 缺此头时 AIGoHotel 等实现直接 400（2026-08-21 实测）
        'Accept': 'application/json, text/event-stream',
        ...this.headers,
      };

      // OAuth Bearer Token 注入
      if (this.oauth && this.serverId) {
        try {
          const { getOAuthClient } = require('./oauth-client');
          const oauthClient = getOAuthClient();
          const accessToken = await oauthClient.getAccessToken(this.serverId, this.url);
          if (accessToken) {
            headers['Authorization'] = `Bearer ${accessToken}`;
          }
        } catch (e) {
          // 2026-08-01: OAuth 失败改为告警（此前静默，请求无 auth 头继续但无从排查）
          console.warn(`[mcp-http] OAuth token 获取失败 (${this.serverId}): ${e.message}`);
        }
      }

      if (this._sessionId) {
        headers['Mcp-Session-Id'] = this._sessionId;
      }

      const resp = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const data = await resp.json();

      // 保存 session ID
      const sessionHeader = resp.headers.get('Mcp-Session-Id');
      if (sessionHeader) {
        this._sessionId = sessionHeader;
      }

      if (data.error) {
        throw new Error(data.error.message || 'MCP Error');
      }

      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 发送通知（不期望响应）
   */
  async sendNotification(method, params = {}) {
    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...this.headers,
      };

      if (this._sessionId) {
        headers['Mcp-Session-Id'] = this._sessionId;
      }

      await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification),
      });
    } catch (e) {
      // 通知不关心响应，但失败需留痕
      console.debug('[mcp-http] 通知发送失败:', e?.message || e);
    }
  }

  get isConnected() {
    return this._connected;
  }
}

module.exports = { HttpTransport };
