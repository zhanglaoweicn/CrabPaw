/**
 * UserWhitelist - 用户授权白名单
 * 
 * 支持飞书用户白名单验证
 * 可配置允许所有用户或仅允许特定用户
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');

class UserWhitelist {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      allowAll: config.allowAll || false,
      users: config.users || [],
      platforms: config.platforms || ['lark', 'feishu', 'telegram', 'discord'],
      adminUsers: config.adminUsers || [],
      ...config
    };
    
    this._whitelistFile = null;
    this._stats = {
      checks: 0,
      authorized: 0,
      denied: 0,
      adminAccess: 0
    };
  }

  async load() {
    this._whitelistFile = path.join(DATA_DIR, 'security', 'user-whitelist.json');
    
    if (fs.existsSync(this._whitelistFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this._whitelistFile, 'utf-8'));
        this.config.users = data.users || this.config.users;
        this.config.adminUsers = data.adminUsers || this.config.adminUsers;
        this.config.allowAll = data.allowAll ?? this.config.allowAll;
        console.log(`📋 用户白名单已加载: ${this.config.users.length} 个用户`);
      } catch (e) {
        console.warn('加载用户白名单失败:', e.message);
      }
    }
  }

  async save() {
    if (!this._whitelistFile) return;
    
    const dir = path.dirname(this._whitelistFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const data = {
      users: this.config.users,
      adminUsers: this.config.adminUsers,
      allowAll: this.config.allowAll,
      updatedAt: new Date().toISOString()
    };
    
    fs.writeFileSync(this._whitelistFile, JSON.stringify(data, null, 2));
  }

  async check(userId, platform = 'lark') {
    this._stats.checks++;
    
    if (!this.config.enabled) {
      this._stats.authorized++;
      return { authorized: true, reason: '用户授权未启用' };
    }
    
    // GUI 平台自动授权
    if (platform === 'gui') {
      this._stats.authorized++;
      return { authorized: true, reason: 'GUI 平台自动授权' };
    }
    
    if (this.config.allowAll) {
      this._stats.authorized++;
      return { authorized: true, reason: '允许所有用户访问' };
    }
    
    if (!this.config.platforms.includes(platform)) {
      this._stats.denied++;
      return { authorized: false, reason: `平台 ${platform} 未授权` };
    }
    
    const normalizedId = this._normalizeUserId(userId, platform);
    
    if (this.config.adminUsers.includes(normalizedId)) {
      this._stats.authorized++;
      this._stats.adminAccess++;
      return { authorized: true, reason: '管理员用户', isAdmin: true };
    }
    
    if (this.config.users.includes(normalizedId)) {
      this._stats.authorized++;
      return { authorized: true, reason: '用户在白名单中' };
    }
    
    if (this.config.users.some(u => {
      const normalizedU = this._normalizeUserId(u, platform);
      return normalizedId === normalizedU;
    })) {
      this._stats.authorized++;
      return { authorized: true, reason: '用户匹配白名单' };
    }
    
    this._stats.denied++;
    return { authorized: false, reason: '用户不在白名单中' };
  }

  _normalizeUserId(userId, platform) {
    if (platform === 'lark' || platform === 'feishu') {
      return userId.replace(/^ou_/, '').toLowerCase();
    }
    return userId.toLowerCase();
  }

  addUser(userId, platform = 'lark') {
    const normalizedId = this._normalizeUserId(userId, platform);
    if (!this.config.users.includes(normalizedId)) {
      this.config.users.push(normalizedId);
      this.save();
    }
  }

  removeUser(userId, platform = 'lark') {
    const normalizedId = this._normalizeUserId(userId, platform);
    const idx = this.config.users.indexOf(normalizedId);
    if (idx >= 0) {
      this.config.users.splice(idx, 1);
      this.save();
    }
  }

  addAdminUser(userId, platform = 'lark') {
    const normalizedId = this._normalizeUserId(userId, platform);
    if (!this.config.adminUsers.includes(normalizedId)) {
      this.config.adminUsers.push(normalizedId);
      this.save();
    }
  }

  removeAdminUser(userId, platform = 'lark') {
    const normalizedId = this._normalizeUserId(userId, platform);
    const idx = this.config.adminUsers.indexOf(normalizedId);
    if (idx >= 0) {
      this.config.adminUsers.splice(idx, 1);
      this.save();
    }
  }

  setAllowAll(allowAll) {
    this.config.allowAll = allowAll;
    this.save();
  }

  getUsers() {
    return {
      users: this.config.users,
      adminUsers: this.config.adminUsers,
      allowAll: this.config.allowAll,
      count: this.config.users.length,
      adminCount: this.config.adminUsers.length
    };
  }

  getStats() {
    return { ...this._stats };
  }

  enable() {
    this.config.enabled = true;
  }

  disable() {
    this.config.enabled = false;
  }
}

module.exports = UserWhitelist;
