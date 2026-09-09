/**
 * Policy Limits Service
 * 
 * 策略限制管理服务
 * 借鉴 Claude Code 的 policyLimits/index.ts 实现
 */

const { EventEmitter } = require('events');
const { readFile, writeFile, mkdir } = require('fs/promises');
const { join } = require('path');

class PolicyLimitsService extends EventEmitter {
  constructor() {
    super();
    this.initialized = false;
    this.cache = null;
    this.config = {
      enabled: true,
      cacheFile: 'policy-limits.json',
      fetchInterval: 3600000,
      maxRetries: 5,
    };
    this.pollingTimer = null;
    this.restrictions = {};
  }

  async initialize(config = {}) {
    if (this.initialized) {
      return;
    }

    this.config = { ...this.config, ...config };
    
    if (this.config.configDir) {
      this.cachePath = join(this.config.configDir, this.config.cacheFile);
      await mkdir(this.config.configDir, { recursive: true });
      await this.loadCache();
    }

    if (this.config.fetchInterval > 0) {
      this.pollingTimer = setInterval(() => {
        this.fetchRestrictions();
      }, this.config.fetchInterval);
    }

    this.initialized = true;
    this.emit('initialized');
  }

  async shutdown() {
    if (!this.initialized) {
      return;
    }

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    await this.saveCache();
    this.initialized = false;
    this.emit('shutdown');
  }

  async loadCache() {
    if (!this.cachePath) {
      return;
    }

    try {
      const data = await readFile(this.cachePath, 'utf8');
      this.cache = JSON.parse(data);
      this.restrictions = this.cache.restrictions || {};
      this.emit('cache:loaded');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('error', error);
      }
    }
  }

  async saveCache() {
    if (!this.cachePath) {
      return;
    }

    try {
      const data = JSON.stringify({
        restrictions: this.restrictions,
        timestamp: Date.now(),
      }, null, 2);
      await writeFile(this.cachePath, data, 'utf8');
      this.emit('cache:saved');
    } catch (error) {
      this.emit('error', error);
    }
  }

  async fetchRestrictions() {
    if (!this.config.enabled) {
      return;
    }

    try {
      this.emit('fetch:start');
      
      if (this.config.fetchFunction) {
        const result = await this.config.fetchFunction();
        this.restrictions = result.restrictions || {};
        await this.saveCache();
        this.emit('fetch:success', this.restrictions);
      }
    } catch (error) {
      this.emit('fetch:error', error);
    }
  }

  isRestricted(feature) {
    return this.restrictions[feature] === true;
  }

  getRestrictions() {
    return { ...this.restrictions };
  }

  setRestrictions(restrictions) {
    this.restrictions = { ...restrictions };
    this.emit('restrictions:updated', this.restrictions);
  }

  getStats() {
    return {
      initialized: this.initialized,
      enabled: this.config.enabled,
      hasCache: !!this.cache,
      restrictionCount: Object.keys(this.restrictions).length,
    };
  }
}

const policyLimitsService = new PolicyLimitsService();

module.exports = {
  PolicyLimitsService,
  policyLimitsService,
};
