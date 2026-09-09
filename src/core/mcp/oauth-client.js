/**
 * MCP OAuth 2.1 PKCE 客户端
 *
 * - 支持 Authorization Code + PKCE 流程
 * - 自动发现 OAuth 元数据 (RFC 8414)
 * - Token 持久化和自动刷新
 * - 动态客户端注册 (RFC 7591)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');


// 2026-08-01: token 目录与 MCP 配置统一到 DATA_DIR（此前在 os.homedir()/.crabpaw，
// 与 mcp-servers.json 的 data/.crabpaw 分属两处，迁移/备份时易遗漏）
const { DATA_DIR } = require('../config');
const TOKEN_STORE_DIR = path.join(DATA_DIR, 'oauth-tokens');

function ensureTokenStoreDir() {
  if (!fs.existsSync(TOKEN_STORE_DIR)) {
    // 2026-08-01: token 目录仅当前用户可读写（含访问/刷新 token 的敏感数据）
    fs.mkdirSync(TOKEN_STORE_DIR, { recursive: true, mode: 0o700 });
  }
}

// ─── PKCE 工具函数 ───

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── OAuth 元数据发现 ───

/**
 * 发现 OAuth 元数据 (RFC 8414)
 * 从服务器 URL 推断元数据端点
 */
async function discoverOAuthMetadata(serverUrl) {
  const url = new URL(serverUrl);

  // 尝试常见的元数据端点
  const metadataUrls = [
    `${url.origin}/.well-known/oauth-authorization-server`,
    `${url.origin}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
  ];

  for (const metadataUrl of metadataUrls) {
    try {
      const resp = await fetch(metadataUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        const metadata = await resp.json();
        return {
          issuer: metadata.issuer,
          authorizationEndpoint: metadata.authorization_endpoint,
          tokenEndpoint: metadata.token_endpoint,
          registrationEndpoint: metadata.registration_endpoint,
          scopesSupported: metadata.scopes_supported || [],
          codeChallengeMethodsSupported: metadata.code_challenge_methods_supported || ['S256'],
          grantTypesSupported: metadata.grant_types_supported || ['authorization_code'],
        };
      }
    } catch (e) {
      // 继续尝试下一个端点
      console.debug('[mcp-oauth] 元数据端点尝试失败:', e?.message || e);
    }
  }

  return null;
}

// ─── 动态客户端注册 (RFC 7591) ───

/**
 * 动态注册 OAuth 客户端
 */
async function registerClient(registrationEndpoint, redirectUri) {
  const resp = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'CrabPaw MCP Client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none', // 公共客户端
      response_types: ['code'],
    }),
  });

  if (!resp.ok) {
    throw new Error(`客户端注册失败: HTTP ${resp.status}`);
  }

  return await resp.json();
}

// ─── Token 管理 ───

class OAuthTokenManager {
  constructor() {
    ensureTokenStoreDir();
  }

  /**
   * 保存 token
   */
  saveToken(serverId, tokenData) {
    const filePath = path.join(TOKEN_STORE_DIR, `${serverId}.json`);
    const data = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_type: tokenData.token_type || 'Bearer',
      expires_at: tokenData.expires_in
        ? Date.now() + tokenData.expires_in * 1000
        : null,
      scope: tokenData.scope,
      savedAt: new Date().toISOString(),
    };
    // 2026-08-01: token 文件仅 owner 可读写（Windows 下 mode 位尽力而为）
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return data;
  }

  /**
   * 加载 token
   */
  loadToken(serverId) {
    const filePath = path.join(TOKEN_STORE_DIR, `${serverId}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.warn(`[mcp-oauth] token 文件损坏或不可读 (${serverId}):`, e?.message || e);
      return null;
    }
  }

  /**
   * 删除 token
   */
  deleteToken(serverId) {
    const filePath = path.join(TOKEN_STORE_DIR, `${serverId}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * 检查 token 是否过期
   */
  isTokenExpired(tokenData) {
    if (!tokenData || !tokenData.expires_at) return false;
    // 提前 60 秒认为过期
    return Date.now() > tokenData.expires_at - 60000;
  }

  /**
   * 刷新 token
   */
  async refreshToken(serverId, tokenEndpoint, refreshToken) {
    const resp = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Token 刷新失败: HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return this.saveToken(serverId, data);
  }

  /**
   * 获取有效的 access token（自动刷新）
   */
  async getValidToken(serverId, tokenEndpoint) {
    const token = this.loadToken(serverId);
    if (!token) return null;

    if (this.isTokenExpired(token)) {
      if (token.refresh_token) {
        try {
          return await this.refreshToken(serverId, tokenEndpoint, token.refresh_token);
        } catch (e) {
          console.warn(`⚠️ Token 刷新失败: ${e.message}`);
          this.deleteToken(serverId);
          return null;
        }
      }
      return null;
    }

    return token;
  }
}

// ─── OAuth 授权流程 ───

class MCPOAuthClient {
  constructor() {
    this.tokenManager = new OAuthTokenManager();
    this._pendingAuth = new Map(); // state → { verifier, metadata, serverId }
  }

  /**
   * 启动 OAuth 授权流程
   * 返回授权 URL，用户需要在浏览器中打开
   */
  async startAuth(serverId, serverUrl, config = {}) {
    // 1. 发现 OAuth 元数据
    const metadata = config.oauthMetadata || await discoverOAuthMetadata(serverUrl);
    if (!metadata) {
      throw new Error('无法发现 OAuth 元数据。请手动配置 oauth.authorizationEndpoint 和 oauth.tokenEndpoint。');
    }

    const redirectUri = config.redirectUri || 'http://127.0.0.1:9877/oauth/callback';
    let clientId = config.clientId;

    // 2. 动态客户端注册（如果没有 clientId）
    if (!clientId && metadata.registrationEndpoint) {
      try {
        const registration = await registerClient(metadata.registrationEndpoint, redirectUri);
        clientId = registration.client_id;
      } catch (e) {
        throw new Error(`动态客户端注册失败: ${e.message}`);
      }
    }

    if (!clientId) {
      throw new Error('缺少 client_id，且服务器不支持动态注册');
    }

    // 3. 生成 PKCE 参数
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    // 4. 构建授权 URL
    const authUrl = new URL(metadata.authorizationEndpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    if (config.scope) {
      authUrl.searchParams.set('scope', config.scope);
    }

    // 5. 保存待处理状态
    this._pendingAuth.set(state, {
      codeVerifier,
      clientId,
      redirectUri,
      tokenEndpoint: metadata.tokenEndpoint,
      serverId,
    });

    return {
      authUrl: authUrl.toString(),
      state,
      message: `请在浏览器中打开以下链接完成授权:\n${authUrl.toString()}`,
    };
  }

  /**
   * 处理 OAuth 回调
   */
  async handleCallback(state, code) {
    const pending = this._pendingAuth.get(state);
    if (!pending) {
      throw new Error('无效的 OAuth state，可能已过期');
    }

    this._pendingAuth.delete(state);

    // 交换 code → token
    const resp = await fetch(pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.codeVerifier,
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Token 交换失败: HTTP ${resp.status} - ${errorText}`);
    }

    const tokenData = await resp.json();
    const saved = this.tokenManager.saveToken(pending.serverId, tokenData);

    return {
      success: true,
      serverId: pending.serverId,
      tokenType: saved.token_type,
      expiresIn: saved.expires_at ? Math.round((saved.expires_at - Date.now()) / 1000) : null,
    };
  }

  /**
   * 获取已认证的 access token
   */
  async getAccessToken(serverId, serverUrl) {
    // 尝试从存储加载
    const metadata = await discoverOAuthMetadata(serverUrl).catch((e) => {
      console.debug('[mcp-oauth] 元数据发现失败(继续用本地 token):', e?.message || e);
      return null;
    });
    const tokenEndpoint = metadata?.tokenEndpoint;

    const token = await this.tokenManager.getValidToken(serverId, tokenEndpoint);
    if (!token) return null;

    return token.access_token;
  }

  /**
   * 检查服务器是否已认证
   */
  isAuthenticated(serverId) {
    const token = this.tokenManager.loadToken(serverId);
    return !!token && !this.tokenManager.isTokenExpired(token);
  }

  /**
   * 撤销认证
   */
  revokeAuth(serverId) {
    this.tokenManager.deleteToken(serverId);
    return true;
  }
}

// 单例
let _oauthClient = null;

function getOAuthClient() {
  if (!_oauthClient) {
    _oauthClient = new MCPOAuthClient();
  }
  return _oauthClient;
}

module.exports = {
  MCPOAuthClient,
  OAuthTokenManager,
  getOAuthClient,
  discoverOAuthMetadata,
  generateCodeVerifier,
  generateCodeChallenge,
};
