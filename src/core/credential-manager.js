/**
 * CredentialManager - 凭据管理集中化
 *
 * 统一管理所有通道凭据的读取、解密和环境变量回退。
 * 消除 Electron 主进程、桥接器、server.js 中的重复凭据处理逻辑。
 */

const fs = require('fs');
const path = require('path');
const { encryptApiKey, decryptApiKey, isEncrypted } = require('./secure-storage');

class CredentialManager {
  constructor(dataDir) {
    this._dataDir = dataDir || this._detectDataDir();
    this._configCache = null;
    this._apiKeysCache = null;
    this._secretsCache = null;
  }

  _detectDataDir() {
    if (process.env.CRABPAW_DATA_DIR) return process.env.CRABPAW_DATA_DIR;
    return path.join(__dirname, '..', '..', 'data', '.crabpaw');
  }

  _getConfig() {
    if (this._configCache) return this._configCache;
    const configPath = path.join(this._dataDir, 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        this._configCache = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      }
    } catch (e) {
      /* 读取失败 */
      console.warn('[credential-manager.js] 空 catch 补日志:', e && e.message);
    }

    this._configCache = this._configCache || {};
    return this._configCache;
  }

  _getApiKeys() {
    if (this._apiKeysCache) return this._apiKeysCache;
    const apiKeysPath = path.join(this._dataDir, '.api_keys.json');
    try {
      if (fs.existsSync(apiKeysPath)) {
        this._apiKeysCache = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }
    } catch (e) {
      /* 读取失败 */
      console.warn('[credential-manager.js] 空 catch 补日志:', e && e.message);
    }

    this._apiKeysCache = this._apiKeysCache || {};
    return this._apiKeysCache;
  }

  /**
   * 解密一个可能是脱敏值/加密值/明文值的凭据
   * 优先级：环境变量 > config.json 明文 > .api_keys.json 解密
   */
  _resolveCredential(configValue, apiKeyKey, envKey) {
    // 1. 环境变量最高优先
    if (envKey && process.env[envKey]) {
      const envVal = process.env[envKey];
      // 环境变量中的值不应该是脱敏值
      if (!/\*{2,}/.test(envVal) && envVal.length >= 10) {
        return envVal;
      }
    }

    // 2. config.json 中的值
    if (configValue) {
      // 明文值（长度足够且不含星号）
      if (!/\*{2,}/.test(configValue) && configValue.length >= 10 && !isEncrypted(configValue)) {
        return configValue;
      }
      // 加密值
      if (isEncrypted(configValue)) {
        const decrypted = decryptApiKey(configValue);
        if (decrypted) return decrypted;
      }
    }

    // 3. .api_keys.json 解密
    if (apiKeyKey) {
      const apiKeys = this._getApiKeys();
      const encrypted = apiKeys[apiKeyKey];
      if (encrypted) {
        const decrypted = decryptApiKey(encrypted);
        if (decrypted) return decrypted;
      }
    }

    return null;
  }

  /**
   * 获取企业微信凭据
   * @returns {{ botId: string|null, secret: string|null, corpId: string|null, contactsSecret: string|null, approvalSecret: string|null, customerSecret: string|null }}
   */
  getWecomCredentials() {
    const config = this._getConfig();
    const wecom = config.wecom || {};

    return {
      botId: wecom.botId || process.env.WECOM_BOT_ID || null,
      secret: this._resolveCredential(wecom.secret, 'wecom_secret', 'WECOM_SECRET'),
      corpId: wecom.corpId || process.env.WECOM_CORP_ID || null,
      contactsSecret: this._resolveCredential(wecom.contactsSecret, 'wecom_contacts_secret', 'WECOM_CONTACTS_SECRET'),
      approvalSecret: this._resolveCredential(wecom.approvalSecret, 'wecom_approval_secret', 'WECOM_APPROVAL_SECRET'),
      customerSecret: this._resolveCredential(wecom.customerSecret, 'wecom_customer_secret', 'WECOM_CUSTOMER_SECRET'),
    };
  }

  /**
   * 获取飞书凭据
   * @returns {{ appId: string|null, appSecret: string|null, verificationToken: string|null, encryptKey: string|null, botOpenId: string|null }}
   */
  getLarkCredentials() {
    const config = this._getConfig();
    const lark = config.lark || {};

    return {
      appId: lark.appId || process.env.LARK_APP_ID || null,
      appSecret: this._resolveCredential(lark.appSecret, 'lark_app_secret', 'LARK_APP_SECRET'),
      verificationToken: lark.verificationToken || process.env.LARK_VERIFICATION_TOKEN || null,
      encryptKey: lark.encryptKey || process.env.LARK_ENCRYPT_KEY || null,
      botOpenId: lark.botOpenId || process.env.LARK_BOT_OPEN_ID || null,
    };
  }

  /**
   * 获取 API Token
   */
  getApiToken() {
    const tokenPath = path.join(this._dataDir, '.api_token');
    try {
      if (fs.existsSync(tokenPath)) {
        return fs.readFileSync(tokenPath, 'utf-8').trim();
      }
    } catch (e) {
      /* 读取失败 */
      console.warn('[credential-manager.js] 空 catch 补日志:', e && e.message);
    }

    return '';
  }

  /**
   * 检查企业微信是否已配置（有 botId 和 secret）
   */
  isWecomConfigured() {
    const creds = this.getWecomCredentials();
    return !!(creds.botId && creds.secret);
  }

  /**
   * 检查飞书是否已配置（有 appId 和 appSecret）
   */
  isLarkConfigured() {
    const creds = this.getLarkCredentials();
    return !!(creds.appId && creds.appSecret);
  }

  /**
   * 获取当前聊天通道配置（支持多通道并行）
   * @returns {string[]} 通道标识数组，如 ['wecom', 'lark'] 或 ['none']
   */
  getChatChannel() {
    const config = this._getConfig();
    const channel = config.chatChannel || 'none';
    return Array.isArray(channel) ? channel : [channel];
  }

  /**
   * 检查是否启用了指定通道
   * @param {string} ch 通道标识，如 'wecom'、'lark'
   * @returns {boolean}
   */
  hasChannel(ch) {
    return this.getChatChannel().includes(ch);
  }

  /**
   * 清除缓存（配置变更后调用）
   */
  invalidateCache() {
    this._configCache = null;
    this._apiKeysCache = null;
  }

  // ─── 通用加密存储（2026-08-21 审计 P1-1: 供 db-connections 等场景存敏感值）───
  _getSecrets() {
    if (this._secretsCache) return this._secretsCache;
    const secretsPath = path.join(this._dataDir, 'secrets.json');
    try {
      if (fs.existsSync(secretsPath)) {
        this._secretsCache = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
      }
    } catch (e) {
      console.warn('[credential-manager] secrets.json 读取失败:', e && e.message);
    }
    this._secretsCache = this._secretsCache || {};
    return this._secretsCache;
  }

  _saveSecrets() {
    const secretsPath = path.join(this._dataDir, 'secrets.json');
    try {
      fs.mkdirSync(this._dataDir, { recursive: true });
      fs.writeFileSync(secretsPath, JSON.stringify(this._secretsCache, null, 2), 'utf8');
    } catch (e) {
      console.error('[credential-manager] secrets.json 写入失败:', e && e.message);
    }
  }

  /** 加密存储敏感值；值永不明文落盘 */
  setSecret(key, value) {
    if (!key || value === undefined || value === null) return;
    const secrets = this._getSecrets();
    secrets[key] = encryptApiKey(String(value));
    this._saveSecrets();
  }

  /** 读取解密后的敏感值；不存在返回 null；兼容历史明文值（直接返回） */
  getSecret(key) {
    const raw = this._getSecrets()[key];
    if (raw === undefined || raw === null) return null;
    if (isEncrypted(raw)) return decryptApiKey(raw) || null;
    return raw;
  }

  /** 删除敏感值；不存在时静默成功 */
  deleteSecret(key) {
    const secrets = this._getSecrets();
    if (key in secrets) {
      delete secrets[key];
      this._saveSecrets();
    }
  }
}

/**
 * 检查 chatChannel 配置是否包含指定通道（兼容字符串和数组）
 * @param {string|string[]} chatChannel - 通道配置
 * @param {string} ch - 要检查的通道标识
 * @returns {boolean}
 */
function isChannelEnabled(chatChannel, ch) {
  if (Array.isArray(chatChannel)) return chatChannel.includes(ch);
  return chatChannel === ch;
}

// 单例
let _instance = null;

function getCredentialManager(dataDir) {
  if (!_instance) {
    _instance = new CredentialManager(dataDir);
  }
  return _instance;
}

module.exports = { CredentialManager, getCredentialManager, isChannelEnabled };
