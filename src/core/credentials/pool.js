/**
 * Credential Pool - 多凭证故障转移系统
 * 
 * 策略:
 * - fill_first: 填充优先 (优先使用活跃凭证)
 * - round_robin: 轮询 (均匀分布)
 * - random: 随机选择
 * - least_used: 最少使用 (负载均衡)
 * 
 * 特性:
 * - 多凭证故障转移
 * - 疲劳检测
 * - 自动刷新
 * - 速率限制
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteFile, atomicReadJSON } = require('../atomic-write');
const { CREDENTIAL_STATUS, TERMINAL_AUTH_REASONS, isTokenExpiring } = require('./oauth');
const { CRABPAW_HOME } = require('../path-utils');
const { encrypt, decrypt, isEncrypted } = require('../secure-storage');

const STRATEGIES = {
  FILL_FIRST: 'fill_first',
  ROUND_ROBIN: 'round_robin',
  RANDOM: 'random',
  LEAST_USED: 'least_used'
};

const DEFAULT_CONFIG = {
  strategy: STRATEGIES.FILL_FIRST,
  maxFailures: 3,
  cooldownMinutes: 5,
  refreshThresholdMs: 5 * 60 * 1000,
  maxRequestsPerMinute: 60,
  healthCheckIntervalMs: 60000
};

class Credential {
  constructor(data) {
    this.id = data.id || crypto.randomUUID();
    this.provider = data.provider || 'unknown';
    this.type = data.type || 'api_key';
    this.key = data.key || '';
    this.secret = data.secret || '';
    this.baseUrl = data.baseUrl || '';
    this.metadata = data.metadata || {};
    
    this.usageCount = 0;
    this.failureCount = 0;
    this.lastUsed = null;
    this.lastFailure = null;
    this.isHealthy = true;
    this.createdAt = Date.now();
    this.refreshedAt = null;
    this.expiresAt = data.expiresAt || null;
    
    this._requestTimestamps = [];
  }
  
  canUse(config = DEFAULT_CONFIG) {
    if (this.metadata?.status === CREDENTIAL_STATUS.DEAD) {
      return false;
    }

    if (!this.isHealthy) {
      return false;
    }
    
    if (this.failureCount >= config.maxFailures) {
      const cooldownMs = config.cooldownMinutes * 60 * 1000;
      if (this.lastFailure && Date.now() - this.lastFailure < cooldownMs) {
        return false;
      }
    }
    
    if (this.expiresAt && Date.now() > this.expiresAt) {
      return false;
    }

    if (this.type === 'oauth' && this.metadata?.accessToken) {
      if (isTokenExpiring(this.metadata.accessToken)) {
        return false;
      }
    }
    
    return true;
  }
  
  recordUsage() {
    this.usageCount++;
    this.lastUsed = Date.now();
    this._requestTimestamps.push(Date.now());
    this._cleanupTimestamps();
  }
  
  recordFailure() {
    this.failureCount++;
    this.lastFailure = Date.now();
    
    if (this.failureCount >= DEFAULT_CONFIG.maxFailures) {
      this.isHealthy = false;
    }
  }
  
  recordSuccess() {
    this.failureCount = 0;
    this.isHealthy = true;
    if (this.metadata?.status === CREDENTIAL_STATUS.EXHAUSTED) {
      this.metadata.status = CREDENTIAL_STATUS.OK;
    }
  }

  markDead(reason) {
    this.metadata = this.metadata || {};
    this.metadata.status = CREDENTIAL_STATUS.DEAD;
    this.metadata.deadReason = reason;
    this.isHealthy = false;
  }
  
  getRequestsInLastMinute() {
    this._cleanupTimestamps();
    return this._requestTimestamps.length;
  }
  
  isRateLimited(config = DEFAULT_CONFIG) {
    return this.getRequestsInLastMinute() >= config.maxRequestsPerMinute;
  }
  
  _cleanupTimestamps() {
    const oneMinuteAgo = Date.now() - 60000;
    this._requestTimestamps = this._requestTimestamps.filter(t => t > oneMinuteAgo);
  }
  
  toJSON() {
    return {
      id: this.id,
      provider: this.provider,
      type: this.type,
      key: this.key ? '***' + this.key.slice(-4) : '',
      baseUrl: this.baseUrl,
      metadata: this.metadata,
      usageCount: this.usageCount,
      failureCount: this.failureCount,
      lastUsed: this.lastUsed,
      lastFailure: this.lastFailure,
      isHealthy: this.isHealthy,
      createdAt: this.createdAt,
      refreshedAt: this.refreshedAt,
      expiresAt: this.expiresAt
    };
  }
}

class CredentialPool {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.credentials = new Map();
    this._roundRobinIndex = 0;
    this._dataPath = config.dataPath || path.join(CRABPAW_HOME, 'credentials.json');
    
    this._loadCredentials();
  }
  
  addCredential(data) {
    const cred = new Credential(data);
    this.credentials.set(cred.id, cred);
    this._saveCredentials();
    return cred;
  }
  
  removeCredential(id) {
    const removed = this.credentials.delete(id);
    if (removed) {
      this._saveCredentials();
    }
    return removed;
  }
  
  getCredential(id) {
    return this.credentials.get(id);
  }
  
  selectCredential(provider = null) {
    const available = this._getAvailableCredentials(provider);
    
    if (available.length === 0) {
      return null;
    }
    
    let selected;
    
    switch (this.config.strategy) {
      case STRATEGIES.FILL_FIRST:
        selected = this._selectFillFirst(available);
        break;
      case STRATEGIES.ROUND_ROBIN:
        selected = this._selectRoundRobin(available);
        break;
      case STRATEGIES.RANDOM:
        selected = this._selectRandom(available);
        break;
      case STRATEGIES.LEAST_USED:
        selected = this._selectLeastUsed(available);
        break;
      default:
        selected = available[0];
    }
    
    if (selected) {
      selected.recordUsage();
    }
    
    return selected;
  }
  
  _getAvailableCredentials(provider = null) {
    const available = [];
    
    for (const cred of this.credentials.values()) {
      if (!cred.canUse(this.config)) {
        continue;
      }
      
      if (cred.isRateLimited(this.config)) {
        continue;
      }
      
      if (provider && cred.provider !== provider) {
        continue;
      }
      
      available.push(cred);
    }
    
    return available;
  }
  
  _selectFillFirst(credentials) {
    return credentials.sort((a, b) => {
      if (!a.lastUsed) return -1;
      if (!b.lastUsed) return 1;
      return b.lastUsed - a.lastUsed;
    })[0];
  }
  
  _selectRoundRobin(credentials) {
    const selected = credentials[this._roundRobinIndex % credentials.length];
    this._roundRobinIndex++;
    return selected;
  }
  
  _selectRandom(credentials) {
    const index = Math.floor(Math.random() * credentials.length);
    return credentials[index];
  }
  
  _selectLeastUsed(credentials) {
    return credentials.sort((a, b) => a.usageCount - b.usageCount)[0];
  }
  
  reportSuccess(credentialId) {
    const cred = this.credentials.get(credentialId);
    if (cred) {
      cred.recordSuccess();
      this._saveCredentials();
    }
  }
  
  reportFailure(credentialId) {
    const cred = this.credentials.get(credentialId);
    if (cred) {
      cred.recordFailure();
      this._saveCredentials();
    }
  }

  reportAuthFailure(credentialId, reason) {
    const cred = this.credentials.get(credentialId);
    if (!cred) return;

    const terminalReason = this._mapToTerminalReason(reason);
    if (terminalReason) {
      cred.markDead(terminalReason);
    } else {
      cred.recordFailure();
    }
    this._saveCredentials();
  }

  _mapToTerminalReason(reason) {
    if (TERMINAL_AUTH_REASONS.has(reason)) return reason;

    const ERROR_TO_TERMINAL = {
      'content_policy_blocked': 'content_policy_permanent_ban',
      'provider_policy_blocked': 'provider_policy_permanent_ban',
      'auth_permanent': 'api_key_revoked',
      'billing': 'billing_inactive',
      'model_not_found': 'subscription_expired',
    };

    return ERROR_TO_TERMINAL[reason] || null;
  }
  
  refreshCredential(credentialId, newData) {
    const cred = this.credentials.get(credentialId);
    if (!cred) return null;
    
    if (newData.key) cred.key = newData.key;
    if (newData.secret) cred.secret = newData.secret;
    if (newData.baseUrl) cred.baseUrl = newData.baseUrl;
    if (newData.expiresAt) cred.expiresAt = newData.expiresAt;
    if (newData.metadata) cred.metadata = { ...cred.metadata, ...newData.metadata };
    
    cred.refreshedAt = Date.now();
    cred.isHealthy = true;
    cred.failureCount = 0;
    
    this._saveCredentials();
    return cred;
  }
  
  getStats() {
    const stats = {
      total: this.credentials.size,
      healthy: 0,
      unhealthy: 0,
      byProvider: {},
      strategy: this.config.strategy
    };
    
    for (const cred of this.credentials.values()) {
      if (cred.isHealthy) {
        stats.healthy++;
      } else {
        stats.unhealthy++;
      }
      
      if (!stats.byProvider[cred.provider]) {
        stats.byProvider[cred.provider] = {
          total: 0,
          healthy: 0,
          totalUsage: 0
        };
      }
      
      stats.byProvider[cred.provider].total++;
      if (cred.isHealthy) {
        stats.byProvider[cred.provider].healthy++;
      }
      stats.byProvider[cred.provider].totalUsage += cred.usageCount;
    }
    
    return stats;
  }
  
  listCredentials() {
    return Array.from(this.credentials.values()).map(c => c.toJSON());
  }
  
  setStrategy(strategy) {
    if (Object.values(STRATEGIES).includes(strategy)) {
      this.config.strategy = strategy;
      return true;
    }
    return false;
  }
  
  healthCheck() {
    const now = Date.now();
    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    
    for (const cred of this.credentials.values()) {
      if (!cred.isHealthy && cred.lastFailure) {
        if (now - cred.lastFailure > cooldownMs) {
          cred.isHealthy = true;
          cred.failureCount = 0;
        }
      }
      
      if (cred.expiresAt && now > cred.expiresAt) {
        cred.isHealthy = false;
      }
    }
    
    this._saveCredentials();
  }
  
  _loadCredentials() {
    const data = atomicReadJSON(this._dataPath);
    if (!data || !Array.isArray(data.credentials)) return;

    for (const credData of data.credentials) {
      // 解密敏感字段
      if (credData.key && isEncrypted(credData.key)) {
        credData.key = decrypt(credData.key);
      }
      if (credData.secret && isEncrypted(credData.secret)) {
        credData.secret = decrypt(credData.secret);
      }
      
      const cred = new Credential(credData);
      cred.usageCount = credData.usageCount || 0;
      cred.failureCount = credData.failureCount || 0;
      cred.lastUsed = credData.lastUsed || null;
      cred.lastFailure = credData.lastFailure || null;
      cred.isHealthy = credData.isHealthy !== false;
      if (credData.metadata?.status === CREDENTIAL_STATUS.DEAD) {
        cred.isHealthy = false;
      }
      this.credentials.set(cred.id, cred);
    }
  }
  
  _saveCredentials() {
    try {
      const dir = path.dirname(this._dataPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data = {
        version: 1,
        savedAt: Date.now(),
        credentials: Array.from(this.credentials.values()).map(c => ({
          id: c.id,
          provider: c.provider,
          type: c.type,
          // 加密敏感字段
          key: c.key ? encrypt(c.key) : c.key,
          secret: c.secret ? encrypt(c.secret) : c.secret,
          baseUrl: c.baseUrl,
          metadata: c.metadata,
          usageCount: c.usageCount,
          failureCount: c.failureCount,
          lastUsed: c.lastUsed,
          lastFailure: c.lastFailure,
          isHealthy: c.isHealthy,
          createdAt: c.createdAt,
          refreshedAt: c.refreshedAt,
          expiresAt: c.expiresAt
        }))
      };
      
      atomicWriteFile(this._dataPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save credentials:', err.message);
    }
  }

  selectCredentialWithFailover(provider = null, excludeIds = []) {
    const available = this._getAvailableCredentials(provider).filter(
      c => !excludeIds.includes(c.id)
    );

    if (available.length === 0) {
      const unhealthy = Array.from(this.credentials.values()).filter(
        c => c.provider === (provider || c.provider) && !c.isHealthy
      );
      if (unhealthy.length > 0) {
        const leastFailed = unhealthy.sort((a, b) => a.failureCount - b.failureCount)[0];
        leastFailed.isHealthy = true;
        leastFailed.failureCount = 0;
        this._saveCredentials();
        return leastFailed;
      }
      return null;
    }

    return this.selectCredential(provider);
  }

  batchAddCredentials(credentialsData) {
    const added = [];
    for (const data of credentialsData) {
      const cred = this.addCredential(data);
      added.push(cred);
    }
    return added;
  }

  batchReportSuccess(credentialIds) {
    for (const id of credentialIds) {
      this.reportSuccess(id);
    }
  }

  batchReportFailure(credentialIds) {
    for (const id of credentialIds) {
      this.reportFailure(id);
    }
  }

  startHealthCheck(intervalMs) {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
    }
    const interval = intervalMs || this.config.healthCheckIntervalMs;
    this._healthCheckTimer = setInterval(() => {
      this.healthCheck();
    }, interval);
  }

  stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  getCredentialsByProvider(provider) {
    return Array.from(this.credentials.values()).filter(c => c.provider === provider);
  }

  getHealthyCredentials(provider = null) {
    return Array.from(this.credentials.values()).filter(
      c => c.isHealthy && (!provider || c.provider === provider)
    );
  }

  rotateCredential(currentId, provider) {
    const current = this.credentials.get(currentId);
    if (!current) return this.selectCredential(provider);

    const alternatives = this._getAvailableCredentials(provider).filter(
      c => c.id !== currentId
    );

    if (alternatives.length === 0) return null;

    const next = this._selectLeastUsed(alternatives);
    if (next) next.recordUsage();
    return next;
  }
}

module.exports = {
  CredentialPool,
  Credential,
  STRATEGIES,
  DEFAULT_CONFIG
};
