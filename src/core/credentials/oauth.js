const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');

const CREDENTIAL_STATUS = {
  OK: 'ok',
  EXHAUSTED: 'exhausted',
  DEAD: 'dead',
};

const TERMINAL_AUTH_REASONS = new Set([
  'token_invalidated',
  'token_revoked',
  'invalid_token',
  'invalid_grant',
  'unauthorized_client',
  'refresh_token_reused',
  'account_suspended',
  'account_deactivated',
  'billing_inactive',
  'subscription_expired',
  'api_key_revoked',
  'api_key_disabled',
  'quota_permanently_exceeded',
  'content_policy_permanent_ban',
  'provider_policy_permanent_ban',
]);

const PROVIDER_REGISTRY = {
  openai: {
    authorizeUrl: 'https://auth.openai.com/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid offline_access',
    clientIdEnv: 'OPENAI_CLIENT_ID',
  },
  anthropic: {
    authorizeUrl: 'https://console.anthropic.com/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/oauth/token',
    scope: 'openid offline_access',
    clientIdEnv: 'ANTHROPIC_CLIENT_ID',
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    clientIdEnv: 'GOOGLE_CLIENT_ID',
  },
};

const REFRESH_SKEW_SECONDS = 300;

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function decodeJWTClaims(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function isTokenExpiring(token, skewSeconds = REFRESH_SKEW_SECONDS) {
  const claims = decodeJWTClaims(token);
  if (!claims || !claims.exp) return true;
  return Date.now() / 1000 > claims.exp - skewSeconds;
}

class OAuthPKCEFlow extends EventEmitter {
  constructor(config = {}) {
    super();
    this.provider = config.provider || 'openai';
    this.clientId = config.clientId || process.env[PROVIDER_REGISTRY[this.provider]?.clientIdEnv] || '';
    this.redirectPort = config.redirectPort || 8400;
    this._server = null;
    this._state = null;
    this._codeVerifier = null;
  }

  async startFlow() {
    const providerConfig = PROVIDER_REGISTRY[this.provider];
    if (!providerConfig) {
      throw new Error(`Unknown OAuth provider: ${this.provider}`);
    }
    if (!this.clientId) {
      throw new Error(`No client ID configured for ${this.provider}`);
    }

    this._codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(this._codeVerifier);
    this._state = generateState();

    // eslint-disable-next-line no-unused-vars
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: `http://localhost:${this.redirectPort}/callback`,
      scope: providerConfig.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: this._state,
    });

    const code = await this._waitForCallback();

    const tokens = await this._exchangeCode(code);

    this.emit('tokens', tokens);
    return tokens;
  }

  _waitForCallback() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._cleanup();
        reject(new Error('OAuth flow timed out (120s)'));
      }, 120000);

      this._server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${this.redirectPort}`);

        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>Authorization denied</h1><p>${error}</p>`);
          clearTimeout(timeout);
          this._cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (state !== this._state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Invalid state</h1>');
          clearTimeout(timeout);
          this._cleanup();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization successful!</h1><p>You can close this tab.</p>');
        clearTimeout(timeout);
        this._cleanup();
        resolve(code);
      });

      this._server.listen(this.redirectPort, () => {
        this.emit('listening', { port: this.redirectPort });
      });

      this._server.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async _exchangeCode(code) {
    const providerConfig = PROVIDER_REGISTRY[this.provider];
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      redirect_uri: `http://localhost:${this.redirectPort}/callback`,
      code_verifier: this._codeVerifier,
    });

    const response = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    return response.json();
  }

  async refreshToken(refreshToken) {
    const providerConfig = PROVIDER_REGISTRY[this.provider];
    if (!providerConfig) {
      throw new Error(`Unknown OAuth provider: ${this.provider}`);
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });

    const response = await fetch(providerConfig.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      const errorData = JSON.parse(text).error || '';
      if (TERMINAL_AUTH_REASONS.has(errorData)) {
        return { status: CREDENTIAL_STATUS.DEAD, reason: errorData };
      }
      throw new Error(`Token refresh failed (${response.status}): ${text}`);
    }

    const tokens = await response.json();
    return { status: CREDENTIAL_STATUS.OK, tokens };
  }

  _cleanup() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  getAuthorizeUrl() {
    const providerConfig = PROVIDER_REGISTRY[this.provider];
    if (!providerConfig || !this._codeVerifier) return null;

    const codeChallenge = generateCodeChallenge(this._codeVerifier);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: `http://localhost:${this.redirectPort}/callback`,
      scope: providerConfig.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: this._state,
    });

    return `${providerConfig.authorizeUrl}?${params.toString()}`;
  }
}

class TokenRefreshManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._pool = config.pool || null;
    this._checkIntervalMs = config.checkIntervalMs || 60000;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._checkAndRefresh(), this._checkIntervalMs);
    this._checkAndRefresh();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _checkAndRefresh() {
    if (!this._pool) return;

    for (const cred of this._pool.credentials.values()) {
      if (cred.type !== 'oauth') continue;
      if (cred.metadata?.status === CREDENTIAL_STATUS.DEAD) continue;

      const accessToken = cred.metadata?.accessToken;
      const refreshToken = cred.metadata?.refreshToken;

      if (!accessToken || !refreshToken) continue;

      if (isTokenExpiring(accessToken)) {
        try {
          const flow = new OAuthPKCEFlow({ provider: cred.provider });
          const result = await flow.refreshToken(refreshToken);

          if (result.status === CREDENTIAL_STATUS.DEAD) {
            cred.metadata.status = CREDENTIAL_STATUS.DEAD;
            cred.isHealthy = false;
            this.emit('credential_dead', { id: cred.id, reason: result.reason });
            this._pool._saveCredentials();
            continue;
          }

          cred.metadata.accessToken = result.tokens.access_token;
          if (result.tokens.refresh_token) {
            cred.metadata.refreshToken = result.tokens.refresh_token;
          }
          cred.refreshedAt = Date.now();
          cred.isHealthy = true;
          cred.failureCount = 0;
          this.emit('token_refreshed', { id: cred.id });
          this._pool._saveCredentials();
        } catch (err) {
          this.emit('refresh_failed', { id: cred.id, error: err.message });
        }
      }
    }
  }
}

module.exports = {
  OAuthPKCEFlow,
  TokenRefreshManager,
  CREDENTIAL_STATUS,
  TERMINAL_AUTH_REASONS,
  PROVIDER_REGISTRY,
  generateCodeVerifier,
  generateCodeChallenge,
  decodeJWTClaims,
  isTokenExpiring,
};
