/**
 * Pairing System - 安全配对授权系统
 * 
 * 安全特性:
 * - 8 字符代码 (32 字母表，无歧义字符)
 * - 1 小时过期
 * - 每平台最多 3 个待处理
 * - 速率限制 (10 分钟/用户)
 * - 5 次失败后锁定 1 小时
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getCrabPawSubDir } = require('../path-utils');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_EXPIRY_MS = 60 * 60 * 1000;
const MAX_PENDING_PER_PLATFORM = 3;
const RATE_LIMIT_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 60 * 1000;

class PairingSystem {
  constructor(config = {}) {
    this.dataPath = config.dataPath || getCrabPawSubDir('pairing');
    
    this.pendingCodes = new Map();
    this.authorizedUsers = new Map();
    this.rateLimits = new Map();
    this.failedAttempts = new Map();
    this.lockouts = new Map();
    this._cleanupTimer = null;
    
    this._loadData();
    this._startCleanup();
  }
  
  generateCode(platform, userId, userName = '') {
    this._cleanup();
    
    if (this._isLockedOut(platform)) {
      return { success: false, error: 'LOCKED_OUT', message: '平台已被锁定，请稍后重试' };
    }
    
    if (this._isRateLimited(platform, userId)) {
      return { success: false, error: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' };
    }
    
    const platformPending = this._getPendingByPlatform(platform);
    if (platformPending.length >= MAX_PENDING_PER_PLATFORM) {
      return { success: false, error: 'MAX_PENDING', message: '待处理请求已达上限' };
    }
    
    const code = this._generateSecureCode();
    
    const codeData = {
      code,
      platform,
      userId,
      userName,
      createdAt: Date.now(),
      expiresAt: Date.now() + CODE_EXPIRY_MS
    };
    
    this.pendingCodes.set(code, codeData);
    this._recordRateLimit(platform, userId);
    this._saveData();
    
    return {
      success: true,
      code,
      expiresAt: codeData.expiresAt,
      expiresIn: CODE_EXPIRY_MS / 1000
    };
  }
  
  verifyCode(code, platform) {
    this._cleanup();
    
    if (this._isLockedOut(platform)) {
      return { success: false, error: 'LOCKED_OUT', message: '平台已被锁定' };
    }
    
    const codeData = this.pendingCodes.get(code);
    
    if (!codeData) {
      this._recordFailedAttempt(platform);
      return { success: false, error: 'INVALID_CODE', message: '无效的配对码' };
    }
    
    if (codeData.platform !== platform) {
      this._recordFailedAttempt(platform);
      return { success: false, error: 'PLATFORM_MISMATCH', message: '平台不匹配' };
    }
    
    if (Date.now() > codeData.expiresAt) {
      this.pendingCodes.delete(code);
      this._saveData();
      return { success: false, error: 'EXPIRED', message: '配对码已过期' };
    }
    
    this.pendingCodes.delete(code);
    this._clearFailedAttempts(platform);
    
    const authData = {
      userId: codeData.userId,
      userName: codeData.userName,
      platform: codeData.platform,
      authorizedAt: Date.now(),
      token: this._generateToken()
    };
    
    const authKey = `${platform}:${codeData.userId}`;
    this.authorizedUsers.set(authKey, authData);
    this._saveData();
    
    return {
      success: true,
      userId: codeData.userId,
      userName: codeData.userName,
      token: authData.token
    };
  }
  
  isAuthorized(platform, userId) {
    const authKey = `${platform}:${userId}`;
    return this.authorizedUsers.has(authKey);
  }
  
  getAuthorization(platform, userId) {
    const authKey = `${platform}:${userId}`;
    return this.authorizedUsers.get(authKey) || null;
  }
  
  revokeAuthorization(platform, userId) {
    const authKey = `${platform}:${userId}`;
    const revoked = this.authorizedUsers.delete(authKey);
    if (revoked) {
      this._saveData();
    }
    return revoked;
  }
  
  listAuthorizations(platform = null) {
    const result = [];
    
    // eslint-disable-next-line no-unused-vars -- key 未使用，仅遍历 auth
    for (const [key, auth] of this.authorizedUsers) {
      if (!platform || auth.platform === platform) {
        result.push({
          platform: auth.platform,
          userId: auth.userId,
          userName: auth.userName,
          authorizedAt: auth.authorizedAt
        });
      }
    }
    
    return result;
  }
  
  listPendingCodes(platform = null) {
    const result = [];
    
    for (const [code, data] of this.pendingCodes) {
      if (!platform || data.platform === platform) {
        result.push({
          code,
          platform: data.platform,
          userId: data.userId,
          userName: data.userName,
          createdAt: data.createdAt,
          expiresAt: data.expiresAt
        });
      }
    }
    
    return result;
  }
  
  _generateSecureCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += ALPHABET[bytes[i] % ALPHABET.length];
    }
    
    return code;
  }
  
  _generateToken() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  _isLockedOut(platform) {
    const lockoutKey = platform;
    const lockout = this.lockouts.get(lockoutKey);
    
    if (!lockout) return false;
    
    if (Date.now() > lockout.expiresAt) {
      this.lockouts.delete(lockoutKey);
      return false;
    }
    
    return true;
  }
  
  _isRateLimited(platform, userId) {
    const rateKey = `${platform}:${userId}`;
    const lastRequest = this.rateLimits.get(rateKey);
    
    if (!lastRequest) return false;
    
    return Date.now() - lastRequest < RATE_LIMIT_MS;
  }
  
  _recordRateLimit(platform, userId) {
    const rateKey = `${platform}:${userId}`;
    this.rateLimits.set(rateKey, Date.now());
  }
  
  _recordFailedAttempt(platform) {
    const attemptKey = platform;
    const attempts = this.failedAttempts.get(attemptKey) || { count: 0, lastAttempt: 0 };
    
    attempts.count++;
    attempts.lastAttempt = Date.now();
    this.failedAttempts.set(attemptKey, attempts);
    
    if (attempts.count >= MAX_FAILED_ATTEMPTS) {
      this.lockouts.set(platform, {
        expiresAt: Date.now() + LOCKOUT_MS,
        reason: 'too_many_failures'
      });
    }
    
    this._saveData();
  }
  
  _clearFailedAttempts(platform) {
    this.failedAttempts.delete(platform);
    this.lockouts.delete(platform);
  }
  
  _getPendingByPlatform(platform) {
    const result = [];

    // eslint-disable-next-line no-unused-vars -- code 未使用，仅遍历 data
    for (const [code, data] of this.pendingCodes) {
      if (data.platform === platform) {
        result.push(data);
      }
    }
    
    return result;
  }
  
  _cleanup() {
    const now = Date.now();
    
    for (const [code, data] of this.pendingCodes) {
      if (now > data.expiresAt) {
        this.pendingCodes.delete(code);
      }
    }
    
    for (const [key, timestamp] of this.rateLimits) {
      if (now - timestamp > RATE_LIMIT_MS) {
        this.rateLimits.delete(key);
      }
    }
    
    for (const [key, lockout] of this.lockouts) {
      if (now > lockout.expiresAt) {
        this.lockouts.delete(key);
        this.failedAttempts.delete(key);
      }
    }
  }
  
  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      this._cleanup();
      this._saveData();
    }, 60000);
    // 常驻轮询保留（配对码过期清理），unref 避免阻塞进程退出，stop() 供显式清理
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
    // 进程退出兜底清理
    process.on('exit', () => this.stop());
  }

  /**
   * 停止清理轮询（进程退出/关闭时调用）
   */
  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
  
  _loadData() {
    try {
      const pendingPath = path.join(this.dataPath, 'pending.json');
      const authPath = path.join(this.dataPath, 'authorized.json');
      
      if (fs.existsSync(pendingPath)) {
        const data = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        for (const [code, codeData] of Object.entries(data)) {
          this.pendingCodes.set(code, codeData);
        }
      }
      
      if (fs.existsSync(authPath)) {
        const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        for (const [key, authData] of Object.entries(data)) {
          this.authorizedUsers.set(key, authData);
        }
      }
    } catch (err) {
      console.error('Failed to load pairing data:', err.message);
    }
  }
  
  _saveData() {
    try {
      if (!fs.existsSync(this.dataPath)) {
        fs.mkdirSync(this.dataPath, { recursive: true });
      }
      
      const pendingPath = path.join(this.dataPath, 'pending.json');
      const authPath = path.join(this.dataPath, 'authorized.json');
      
      const pendingObj = {};
      for (const [code, data] of this.pendingCodes) {
        pendingObj[code] = data;
      }
      
      const authObj = {};
      for (const [key, data] of this.authorizedUsers) {
        authObj[key] = data;
      }
      
      fs.writeFileSync(pendingPath, JSON.stringify(pendingObj, null, 2));
      fs.writeFileSync(authPath, JSON.stringify(authObj, null, 2));
    } catch (err) {
      console.error('Failed to save pairing data:', err.message);
    }
  }
}

module.exports = {
  PairingSystem,
  ALPHABET,
  CODE_LENGTH,
  CODE_EXPIRY_MS,
  MAX_PENDING_PER_PLATFORM,
  RATE_LIMIT_MS,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MS
};
