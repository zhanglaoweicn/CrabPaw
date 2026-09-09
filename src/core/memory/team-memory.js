const crypto = require('crypto');
/**
 * Team Memory System
 * 
 * 借鉴 Claude Code Haha 的团队记忆机制
 * 支持私有记忆与团队共享记忆
 * 
 * 核心功能：
 * - 私有记忆：仅用户可见
 * - 团队记忆：团队成员共享
 * - 记忆同步：自动同步团队记忆变更
 * - 权限控制：读写权限管理
 */

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs').promises;
const { DATA_DIR } = require('../config');

const MEMORY_SCOPES = {
  PRIVATE: 'private',
  TEAM: 'team',
};

const MEMORY_PERMISSIONS = {
  READ: 'read',
  WRITE: 'write',
  ADMIN: 'admin',
};

class TeamMemoryStore extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      teamDir: config.teamDir || path.join(DATA_DIR, 'team'),
      privateDir: config.privateDir || path.join(DATA_DIR, 'private'),
      maxTeamMemories: config.maxTeamMemories || 500,
      maxPrivateMemories: config.maxPrivateMemories || 200,
      syncInterval: config.syncInterval || 60000,
      ...config,
    };
    this._teamMemories = new Map();
    this._privateMemories = new Map();
    this._teamMembers = new Map();
    this._syncTimer = null;
  }

  async initialize() {
    await fs.mkdir(this.config.teamDir, { recursive: true });
    await fs.mkdir(this.config.privateDir, { recursive: true });
    
    await this._loadMemories();
    this._startSyncTimer();
    
    this.emit('store:initialized', {
      teamDir: this.config.teamDir,
      privateDir: this.config.privateDir,
    });
  }

  async _loadMemories() {
    try {
      const teamFiles = await fs.readdir(this.config.teamDir);
      for (const file of teamFiles) {
        if (file.endsWith('.json')) {
          try {
            const content = await fs.readFile(path.join(this.config.teamDir, file), 'utf-8');
            const memory = JSON.parse(content);
            this._teamMemories.set(memory.id, memory);
          } catch (e) {

            // Skip invalid files

            console.warn('[team-memory.js] 空 catch 补日志:', e && e.message);
          }

        }
      }

      const privateFiles = await fs.readdir(this.config.privateDir);
      for (const file of privateFiles) {
            if (file.endsWith('.json')) {
            try {
            const content = await fs.readFile(path.join(this.config.privateDir, file), 'utf-8');
            const memory = JSON.parse(content);
            this._privateMemories.set(memory.id, memory);
            } catch (e) {
              // Skip invalid files
              console.warn('[team-memory.js] 空 catch 补日志:', e && e.message);
            }
          }
      }
    } catch (e) {

      // Directories might not exist yet

      console.warn('[team-memory.js] 空 catch 补日志:', e && e.message);
    }

  }

  _startSyncTimer() {
    this._syncTimer = setInterval(() => {
      this.sync();
    }, this.config.syncInterval);
    this._syncTimer.unref();
  }

  stopSyncTimer() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  async sync() {
    await this._loadMemories();
    this.emit('memories:synced', {
      teamCount: this._teamMemories.size,
      privateCount: this._privateMemories.size,
    });
  }

  async addMemory(memory, scope = MEMORY_SCOPES.PRIVATE, userId = null) {
    const id = memory.id || `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
    
    const fullMemory = {
      ...memory,
      id,
      scope,
      createdBy: userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    };

    if (scope === MEMORY_SCOPES.TEAM) {
      if (this._teamMemories.size >= this.config.maxTeamMemories) {
        this._evictOldest(this._teamMemories);
      }
      this._teamMemories.set(id, fullMemory);
      await this._saveMemory(fullMemory, this.config.teamDir);
    } else {
      if (this._privateMemories.size >= this.config.maxPrivateMemories) {
        this._evictOldest(this._privateMemories);
      }
      this._privateMemories.set(id, fullMemory);
      await this._saveMemory(fullMemory, this.config.privateDir);
    }

    this.emit('memory:added', { id, scope, memory: fullMemory });
    return fullMemory;
  }

  async _saveMemory(memory, dir) {
    const filePath = path.join(dir, `${memory.id}.json`);
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(memory, null, 2));
    await fs.rename(tempPath, filePath);
  }

  _evictOldest(memories) {
    const sorted = Array.from(memories.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    
    const toRemove = sorted.slice(0, Math.floor(memories.size * 0.1));
    for (const [id] of toRemove) {
      memories.delete(id);
    }
  }

  async getMemory(id) {
    if (this._teamMemories.has(id)) {
      return this._teamMemories.get(id);
    }
    if (this._privateMemories.has(id)) {
      return this._privateMemories.get(id);
    }
    return null;
  }

  async updateMemory(id, updates, userId = null) {
    let memory = await this.getMemory(id);
    if (!memory) {
      throw new Error(`Memory ${id} not found`);
    }

    memory = {
      ...memory,
      ...updates,
      updatedBy: userId,
      updatedAt: Date.now(),
      version: (memory.version || 1) + 1,
    };

    if (memory.scope === MEMORY_SCOPES.TEAM) {
      this._teamMemories.set(id, memory);
      await this._saveMemory(memory, this.config.teamDir);
    } else {
      this._privateMemories.set(id, memory);
      await this._saveMemory(memory, this.config.privateDir);
    }

    this.emit('memory:updated', { id, memory });
    return memory;
  }

  async deleteMemory(id) {
    let scope = null;

    if (this._teamMemories.has(id)) {
      this._teamMemories.delete(id);
      scope = MEMORY_SCOPES.TEAM;
      await fs.unlink(path.join(this.config.teamDir, `${id}.json`)).catch((err) => {
        console.warn('⚠️ [team-memory] 删除团队记忆文件失败:', err.message);
      });
    } else if (this._privateMemories.has(id)) {
      this._privateMemories.delete(id);
      scope = MEMORY_SCOPES.PRIVATE;
      await fs.unlink(path.join(this.config.privateDir, `${id}.json`)).catch((err) => {
        console.warn('⚠️ [team-memory] 删除私有记忆文件失败:', err.message);
      });
    }

    if (scope) {
      this.emit('memory:deleted', { id, scope });
      return true;
    }
    return false;
  }

  getTeamMemories() {
    return Array.from(this._teamMemories.values());
  }

  getPrivateMemories() {
    return Array.from(this._privateMemories.values());
  }

  getAllMemories() {
    return [
      ...this.getTeamMemories(),
      ...this.getPrivateMemories(),
    ];
  }

  searchMemories(query, options = {}) {
    const scope = options.scope || null;
    const memories = scope === MEMORY_SCOPES.TEAM
      ? this.getTeamMemories()
      : scope === MEMORY_SCOPES.PRIVATE
        ? this.getPrivateMemories()
        : this.getAllMemories();

    const queryLower = query.toLowerCase();
    
    return memories
      .filter(m => {
        if (m.content?.toLowerCase().includes(queryLower)) return true;
        if (m.title?.toLowerCase().includes(queryLower)) return true;
        if (m.tags?.some(t => t.toLowerCase().includes(queryLower))) return true;
        return false;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getByCategory(category, scope = null) {
    const memories = scope === MEMORY_SCOPES.TEAM
      ? this.getTeamMemories()
      : scope === MEMORY_SCOPES.PRIVATE
        ? this.getPrivateMemories()
        : this.getAllMemories();

    return memories.filter(m => m.category === category);
  }

  getByTag(tag, scope = null) {
    const memories = scope === MEMORY_SCOPES.TEAM
      ? this.getTeamMemories()
      : scope === MEMORY_SCOPES.PRIVATE
        ? this.getPrivateMemories()
        : this.getAllMemories();

    return memories.filter(m => m.tags?.includes(tag));
  }
}

class TeamMemberManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this._members = new Map();
    this._teams = new Map();
  }

  async addMember(userId, teamId, permissions = [MEMORY_PERMISSIONS.READ]) {
    if (!this._teams.has(teamId)) {
      this._teams.set(teamId, new Set());
    }
    this._teams.get(teamId).add(userId);

    if (!this._members.has(userId)) {
      this._members.set(userId, new Map());
    }
    this._members.get(userId).set(teamId, {
      permissions,
      joinedAt: Date.now(),
    });

    this.emit('member:added', { userId, teamId, permissions });
  }

  async removeMember(userId, teamId) {
    if (this._teams.has(teamId)) {
      this._teams.get(teamId).delete(userId);
    }
    if (this._members.has(userId)) {
      this._members.get(userId).delete(teamId);
    }

    this.emit('member:removed', { userId, teamId });
  }

  getMemberTeams(userId) {
    const teams = this._members.get(userId);
    return teams ? Array.from(teams.keys()) : [];
  }

  getTeamMembers(teamId) {
    const members = this._teams.get(teamId);
    return members ? Array.from(members) : [];
  }

  hasPermission(userId, teamId, permission) {
    const teams = this._members.get(userId);
    if (!teams) return false;

    const membership = teams.get(teamId);
    if (!membership) return false;

    return membership.permissions.includes(permission) ||
           membership.permissions.includes(MEMORY_PERMISSIONS.ADMIN);
  }

  getStats() {
    return {
      totalMembers: this._members.size,
      totalTeams: this._teams.size,
      teams: Array.from(this._teams.entries()).map(([id, members]) => ({
        id,
        memberCount: members.size,
      })),
    };
  }
}

class TeamMemoryManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.store = new TeamMemoryStore(config.store);
    this.members = new TeamMemberManager(config.members);
    this.config = config;
  }

  async initialize() {
    await this.store.initialize();
    this.emit('manager:initialized');
  }

  async addMemory(memory, scope, userId, teamId = null) {
    if (scope === MEMORY_SCOPES.TEAM && teamId) {
      if (!this.members.hasPermission(userId, teamId, MEMORY_PERMISSIONS.WRITE)) {
        throw new Error('User does not have write permission for this team');
      }
      memory.teamId = teamId;
    }

    return await this.store.addMemory(memory, scope, userId);
  }

  // eslint-disable-next-line no-unused-vars
  async getMemoriesForUser(userId, options = {}) {
    const privateMemories = this.store.getPrivateMemories()
      .filter(m => m.createdBy === userId);

    const teamIds = this.members.getMemberTeams(userId);
    const teamMemories = this.store.getTeamMemories()
      .filter(m => teamIds.includes(m.teamId));

    return [...privateMemories, ...teamMemories]
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async searchForUser(userId, query, options = {}) {
    const memories = await this.getMemoriesForUser(userId, options);
    const queryLower = query.toLowerCase();

    return memories.filter(m => {
      if (m.content?.toLowerCase().includes(queryLower)) return true;
      if (m.title?.toLowerCase().includes(queryLower)) return true;
      if (m.tags?.some(t => t.toLowerCase().includes(queryLower))) return true;
      return false;
    });
  }

  async shareMemoryWithTeam(memoryId, teamId, userId) {
    const memory = await this.store.getMemory(memoryId);
    if (!memory) {
      throw new Error('Memory not found');
    }

    if (memory.createdBy !== userId) {
      throw new Error('Only the creator can share this memory');
    }

    if (!this.members.hasPermission(userId, teamId, MEMORY_PERMISSIONS.WRITE)) {
      throw new Error('User does not have write permission for this team');
    }

    const sharedMemory = {
      ...memory,
      id: `mem_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      scope: MEMORY_SCOPES.TEAM,
      teamId,
      sharedBy: userId,
      sharedAt: Date.now(),
      originalId: memory.id,
    };

    return await this.store.addMemory(sharedMemory, MEMORY_SCOPES.TEAM, userId);
  }

  getStats() {
    return {
      store: {
        teamCount: this.store._teamMemories.size,
        privateCount: this.store._privateMemories.size,
      },
      members: this.members.getStats(),
    };
  }
}

module.exports = {
  TeamMemoryStore,
  TeamMemberManager,
  TeamMemoryManager,
  MEMORY_SCOPES,
  MEMORY_PERMISSIONS,
};
