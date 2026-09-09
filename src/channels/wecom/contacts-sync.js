const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_FILE_NAME = 'wecom-contacts-cache.json';

class ContactsSync extends EventEmitter {
  constructor(config = {}) {
    super();
    this._corpId = config.corpId || '';
    this._contactsSecret = config.contactsSecret || '';
    this._accessToken = '';
    this._tokenExpireTime = 0;
    this._departments = new Map();
    this._users = new Map();
    this._syncTimer = null;
    this._dataDir = config.dataDir || '';
    this._lastSyncTime = 0;
    this._stats = {
      totalSyncs: 0,
      lastSyncStatus: 'never',
      departmentCount: 0,
      userCount: 0,
    };
  }

  async _getAccessToken() {
    if (!this._corpId || !this._contactsSecret) {
      throw new Error('企业微信通讯录配置不完整 (corpId/contactsSecret)');
    }
    // 2026-09-06: 收口到 token-broker 单飞管理
    const { getWecomToken } = require('./token-broker');
    return getWecomToken(this._corpId, this._contactsSecret, 'contacts');
  }

  async startAutoSync() {
    if (this._syncTimer) return;

    try {
      await this.fullSync();
    } catch (e) {
      console.error('❌ 初始通讯录同步失败:', e.message);
    }

    this._syncTimer = setInterval(async () => {
      try {
        await this.fullSync();
      } catch (e) {
        console.error('❌ 定时通讯录同步失败:', e.message);
        this._stats.lastSyncStatus = 'error';
      }
    }, SYNC_INTERVAL_MS);

    console.log('📋 通讯录自动同步已启动');
  }

  stopAutoSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  async fullSync() {
    const token = await this._getAccessToken();

    await this._syncDepartments(token);
    await this._syncAllUsers(token);

    this._lastSyncTime = Date.now();
    this._stats.totalSyncs++;
    this._stats.lastSyncStatus = 'success';
    this._stats.departmentCount = this._departments.size;
    this._stats.userCount = this._users.size;

    this._saveCache();
    this.emit('sync_complete', {
      departments: this._departments.size,
      users: this._users.size,
      timestamp: this._lastSyncTime,
    });

    console.log(`📋 通讯录同步完成: ${this._departments.size} 个部门, ${this._users.size} 个用户`);
  }

  async _syncDepartments(token) {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/department/list?access_token=${token}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.errcode !== 0) {
      throw new Error(`获取部门列表失败: ${data.errmsg}`);
    }

    const departments = data.department || [];
    this._departments.clear();

    for (const dept of departments) {
      this._departments.set(dept.id, {
        id: dept.id,
        name: dept.name,
        parentId: dept.parentid,
        order: dept.order,
      });
    }
  }

  async _syncAllUsers(token) {
    const rootDeptId = 1;
    await this._syncDepartmentUsers(token, rootDeptId);
  }

  async _syncDepartmentUsers(token, deptId) {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/user/list?access_token=${token}&department_id=${deptId}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.errcode !== 0) {
      if (data.errcode === 60011) {
        return;
      }
      throw new Error(`获取部门用户失败(dept=${deptId}): ${data.errmsg}`);
    }

    const users = data.userlist || [];
    for (const user of users) {
      this._users.set(user.userid, {
        userId: user.userid,
        name: user.name,
        department: user.department || [],
        position: user.position || '',
        mobile: user.mobile || '',
        email: user.email || '',
        status: user.status,
        avatar: user.avatar || '',
      });
    }
  }

  getUserName(userId) {
    const user = this._users.get(userId);
    return user ? user.name : userId;
  }

  getUser(userId) {
    return this._users.get(userId) || null;
  }

  getDepartmentName(deptId) {
    const dept = this._departments.get(deptId);
    return dept ? dept.name : `部门${deptId}`;
  }

  searchUsers(query) {
    const q = query.toLowerCase();
    const results = [];

    // eslint-disable-next-line no-unused-vars
    for (const [userId, user] of this._users) {
      if (
        user.name.toLowerCase().includes(q) ||
        user.userId.toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q) ||
        user.mobile.includes(q) ||
        user.position.toLowerCase().includes(q)
      ) {
        results.push(user);
      }
    }

    return results;
  }

  getDepartmentUsers(deptId) {
    const users = [];
    // eslint-disable-next-line no-unused-vars
    for (const [userId, user] of this._users) {
      if (user.department.includes(deptId)) {
        users.push(user);
      }
    }
    return users;
  }

  getDepartmentTree() {
    const roots = [];
    const children = new Map();

    // eslint-disable-next-line no-unused-vars
    for (const [id, dept] of this._departments) {
      if (!dept.parentId || dept.parentId === 0) {
        roots.push({ ...dept, children: [] });
      } else {
        if (!children.has(dept.parentId)) {
          children.set(dept.parentId, []);
        }
        children.get(dept.parentId).push({ ...dept, children: [] });
      }
    }

    function buildTree(nodes) {
      for (const node of nodes) {
        const kids = children.get(node.id) || [];
        node.children = buildTree(kids);
      }
      return nodes;
    }

    return buildTree(roots);
  }

  _saveCache() {
    if (!this._dataDir) return;

    try {
      const cachePath = path.join(this._dataDir, CACHE_FILE_NAME);
      const cache = {
        lastSyncTime: this._lastSyncTime,
        departments: Array.from(this._departments.entries()),
        users: Array.from(this._users.entries()),
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
    } catch (e) {
      console.error('❌ 通讯录缓存保存失败:', e.message);
    }
  }

  loadCache() {
    if (!this._dataDir) return false;

    try {
      const cachePath = path.join(this._dataDir, CACHE_FILE_NAME);
      if (!fs.existsSync(cachePath)) return false;

      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      this._lastSyncTime = cache.lastSyncTime || 0;
      this._departments = new Map(cache.departments || []);
      this._users = new Map(cache.users || []);
      this._stats.departmentCount = this._departments.size;
      this._stats.userCount = this._users.size;
      this._stats.lastSyncStatus = 'loaded_from_cache';

      console.log(`📋 通讯录缓存已加载: ${this._departments.size} 个部门, ${this._users.size} 个用户`);
      return true;
    } catch (e) {
      console.error('❌ 通讯录缓存加载失败:', e.message);
      return false;
    }
  }

  getStats() {
    return {
      ...this._stats,
      lastSyncTime: this._lastSyncTime ? new Date(this._lastSyncTime).toLocaleString('zh-CN') : '从未同步',
    };
  }
}

module.exports = { ContactsSync };
