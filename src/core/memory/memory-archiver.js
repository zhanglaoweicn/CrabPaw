/**
 * Memory Archiver - 冷层记忆归档系统
 * 
 * 三层记忆架构：
 * - 热层 (Hot): MEMORY.md - 高频访问，最近使用
 * - 温层 (Warm): warm/ - 中频访问，近期归档
 * - 冷层 (Cold): cold/ - 低频访问，长期存储
 * 
 * 功能：
 * - 自动识别低频记忆
 * - 分层归档管理
 * - 支持从冷存储恢复
 * - 定期清理过期记忆
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { getCrabPawSubDir } = require('../path-utils');

const MEMORY_LAYERS = {
  HOT: 'hot',
  WARM: 'warm',
  COLD: 'cold',
};

const ARCHIVE_CONFIG = {
  warmThreshold: 30 * 24 * 60 * 60 * 1000, // 30天未访问
  coldThreshold: 90 * 24 * 60 * 60 * 1000, // 90天未访问
  deleteThreshold: 365 * 24 * 60 * 60 * 1000, // 1年未访问
  maxHotMemories: 50,
  maxWarmMemories: 200,
  minAccessCount: 2,
  archiveInterval: 24 * 60 * 60 * 1000, // 每天检查一次
  // 软删除配置：过期记忆移入 .trash/ 目录，7天后物理清除
  trashRetentionDays: 7,
};

/** Module-level promise chain for serializing MEMORY.md access */
let _memoryFileLock = Promise.resolve();

/**
 * Execute fn under a module-level file lock, serializing all MEMORY.md access.
 * Uses a promise-chain pattern: each caller awaits the previous one, then
 * replaces the tail so the next caller waits.
 */
async function _withMemoryFileLock(fn) {
  const prev = _memoryFileLock;
  let release;
  _memoryFileLock = new Promise(resolve => { release = resolve; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

class MemoryArchiver extends EventEmitter {
  constructor(memoryDir, config = {}) {
    super();
    this.memoryDir = memoryDir || getCrabPawSubDir('memory');
    this.config = { ...ARCHIVE_CONFIG, ...config };

    this.hotDir = this.memoryDir;
    this.warmDir = path.join(this.memoryDir, 'warm');
    this.coldDir = path.join(this.memoryDir, 'cold');
    this.trashDir = path.join(this.memoryDir, '.trash');

    this.memoryFile = path.join(this.hotDir, 'MEMORY.md');
    this.indexFile = path.join(this.memoryDir, 'archive-index.json');
    this.trashIndexFile = path.join(this.trashDir, 'trash-index.json');

    this._ensureDirs();
    this._index = this._loadIndex();
    this._accessLog = this._loadAccessLog();
    this._accessDirty = false;
    this._accessFlushTimer = null;
    this._startAccessFlushTimer();
  }

  _startAccessFlushTimer() {
    this._accessFlushTimer = setInterval(() => {
      if (this._accessDirty) {
        this._saveAccessLog();
        this._accessDirty = false;
      }
    }, 30000);
    if (this._accessFlushTimer.unref) {
      this._accessFlushTimer.unref();
    }
  }

  stopAccessFlushTimer() {
    if (this._accessFlushTimer) {
      clearInterval(this._accessFlushTimer);
      this._accessFlushTimer = null;
    }
    if (this._accessDirty) {
      this._saveAccessLog();
      this._accessDirty = false;
    }
  }

  _ensureDirs() {
    [this.warmDir, this.coldDir, this.trashDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  _loadIndex() {
    if (fs.existsSync(this.indexFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
      } catch (e) {
        return { hot: [], warm: [], cold: [] };
      }
    }
    return { hot: [], warm: [], cold: [] };
  }

  _saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this._index, null, 2));
  }

  _loadAccessLog() {
    const logPath = path.join(this.memoryDir, 'access-log.json');
    if (fs.existsSync(logPath)) {
      try {
        return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      } catch (e) {
        return {};
      }
    }
    return {};
  }

  _saveAccessLog() {
    const logPath = path.join(this.memoryDir, 'access-log.json');
    fs.writeFileSync(logPath, JSON.stringify(this._accessLog, null, 2));
  }

  recordAccess(memoryId) {
    if (!this._accessLog[memoryId]) {
      this._accessLog[memoryId] = {
        firstAccess: Date.now(),
        accessCount: 0,
        lastAccess: Date.now(),
      };
    }

    this._accessLog[memoryId].accessCount++;
    this._accessLog[memoryId].lastAccess = Date.now();

    this._accessDirty = true;
  }

  getMemoryLayer(memoryId) {
    for (const [layer, ids] of Object.entries(this._index)) {
      if (ids.includes(memoryId)) {
        return layer;
      }
    }
    return null;
  }

  getAccessStats(memoryId) {
    return this._accessLog[memoryId] || null;
  }

  async scanHotMemories() {
    return _withMemoryFileLock(() => {
      const memories = [];

      if (!fs.existsSync(this.memoryFile)) {
        return memories;
      }

      const content = fs.readFileSync(this.memoryFile, 'utf-8');
      const sections = this._parseMemoryFile(content);

      for (const section of sections) {
        const stats = this.getAccessStats(section.id);
        memories.push({
          id: section.id,
          title: section.title,
          type: section.type,
          layer: MEMORY_LAYERS.HOT,
          content: section.content,
          created: section.created,
          updated: section.updated,
          accessStats: stats,
          lastAccess: stats?.lastAccess || section.updated,
          accessCount: stats?.accessCount || 0,
        });
      }

      return memories;
    });
  }

  _parseMemoryFile(content) {
    const memories = [];
    const lines = content.split('\n');
    let currentMemory = null;
    let inFrontmatter = false;
    let frontmatterLines = [];
    let contentLines = [];

    for (const line of lines) {
      if (line === '---') {
        if (!inFrontmatter && !currentMemory) {
          inFrontmatter = true;
          frontmatterLines = [];
        } else if (inFrontmatter) {
          inFrontmatter = false;
          currentMemory = this._parseFrontmatter(frontmatterLines);
          contentLines = [];
        } else if (currentMemory) {
          currentMemory.content = contentLines.join('\n').trim();
          memories.push(currentMemory);
          currentMemory = null;
        }
      } else if (inFrontmatter) {
        frontmatterLines.push(line);
      } else if (currentMemory) {
        contentLines.push(line);
      }
    }

    if (currentMemory) {
      currentMemory.content = contentLines.join('\n').trim();
      memories.push(currentMemory);
    }

    return memories;
  }

  _parseFrontmatter(lines) {
    const memory = {
      id: `mem_${Date.now()}`,
      type: 'general',
      title: '',
      created: Date.now(),
      updated: Date.now(),
    };

    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      switch (key) {
        case 'id':
          memory.id = value;
          break;
        case 'type':
          memory.type = value;
          break;
        case 'title':
          memory.title = value;
          break;
        case 'created':
          memory.created = parseInt(value) || Date.now();
          break;
        case 'updated':
          memory.updated = parseInt(value) || Date.now();
          break;
      }
    }

    return memory;
  }

  async identifyArchiveCandidates() {
    const candidates = {
      toWarm: [],
      toCold: [],
      toDelete: [],
    };

    const hotMemories = await this.scanHotMemories();
    const now = Date.now();

    for (const memory of hotMemories) {
      const age = now - memory.lastAccess;
      const accessCount = memory.accessCount;

      if (age > this.config.deleteThreshold && accessCount < this.config.minAccessCount) {
        candidates.toDelete.push(memory);
      } else if (age > this.config.coldThreshold) {
        candidates.toCold.push(memory);
      } else if (age > this.config.warmThreshold || accessCount < this.config.minAccessCount) {
        candidates.toWarm.push(memory);
      }
    }

    if (hotMemories.length > this.config.maxHotMemories) {
      const excess = hotMemories.length - this.config.maxHotMemories;
      const sortedByAccess = [...hotMemories]
        .filter(m => !candidates.toWarm.includes(m) && !candidates.toCold.includes(m))
        .sort((a, b) => a.accessCount - b.accessCount || a.lastAccess - b.lastAccess);

      for (let i = 0; i < Math.min(excess, sortedByAccess.length); i++) {
        candidates.toWarm.push(sortedByAccess[i]);
      }
    }

    return candidates;
  }

  async archiveToWarm(memoryId) {
    const hotMemories = await this.scanHotMemories();
    const memory = hotMemories.find(m => m.id === memoryId);

    if (!memory) {
      return { success: false, error: 'Memory not found in hot layer' };
    }

    const warmPath = path.join(this.warmDir, `${memoryId}.md`);
    const content = this._formatMemoryFile([memory]);
    fs.writeFileSync(warmPath, content);

    this._index.warm.push(memoryId);
    this._index.hot = this._index.hot.filter(id => id !== memoryId);
    this._saveIndex();

    await this._removeFromHotLayer(memoryId);

    this.emit('archived', { memoryId, from: 'hot', to: 'warm' });
    console.log(`📦 归档到温层: ${memoryId}`);

    return { success: true, layer: 'warm' };
  }

  async archiveToCold(memoryId, fromLayer = 'warm') {
    let memory;

    if (fromLayer === 'hot') {
      const hotMemories = await this.scanHotMemories();
      memory = hotMemories.find(m => m.id === memoryId);
    } else if (fromLayer === 'warm') {
      memory = await this._loadFromWarm(memoryId);
    }

    if (!memory) {
      return { success: false, error: 'Memory not found' };
    }

    const coldPath = path.join(this.coldDir, `${memoryId}.md`);
    const content = this._formatMemoryFile([memory]);

    const compressed = this._compressContent(content);
    fs.writeFileSync(coldPath, compressed);

    this._index.cold.push(memoryId);
    this._index[fromLayer] = this._index[fromLayer].filter(id => id !== memoryId);
    this._saveIndex();

    if (fromLayer === 'hot') {
      await this._removeFromHotLayer(memoryId);
    } else if (fromLayer === 'warm') {
      const warmPath = path.join(this.warmDir, `${memoryId}.md`);
      if (fs.existsSync(warmPath)) {
        fs.unlinkSync(warmPath);
      }
    }

    this.emit('archived', { memoryId, from: fromLayer, to: 'cold' });
    console.log(`❄️ 归档到冷层: ${memoryId}`);

    return { success: true, layer: 'cold' };
  }

  async restoreFromArchive(memoryId, targetLayer = 'hot') {
    let memory;
    let sourceLayer;

    memory = await this._loadFromWarm(memoryId);
    if (memory) {
      sourceLayer = 'warm';
    } else {
      memory = await this._loadFromCold(memoryId);
      if (memory) {
        sourceLayer = 'cold';
      }
    }

    if (!memory) {
      return { success: false, error: 'Memory not found in archive' };
    }

    if (targetLayer === 'hot') {
      await this._addToHotLayer(memory);
    } else if (targetLayer === 'warm') {
      const warmPath = path.join(this.warmDir, `${memoryId}.md`);
      fs.writeFileSync(warmPath, this._formatMemoryFile([memory]));
    }

    this._index[sourceLayer] = this._index[sourceLayer].filter(id => id !== memoryId);
    this._index[targetLayer].push(memoryId);
    this._saveIndex();

    if (sourceLayer === 'warm') {
      const warmPath = path.join(this.warmDir, `${memoryId}.md`);
      if (fs.existsSync(warmPath)) {
        fs.unlinkSync(warmPath);
      }
    } else if (sourceLayer === 'cold') {
      const coldPath = path.join(this.coldDir, `${memoryId}.md`);
      if (fs.existsSync(coldPath)) {
        fs.unlinkSync(coldPath);
      }
    }

    this.recordAccess(memoryId);

    this.emit('restored', { memoryId, from: sourceLayer, to: targetLayer });
    console.log(`🔄 恢复记忆: ${memoryId} (${sourceLayer} -> ${targetLayer})`);

    return { success: true, memory, sourceLayer, targetLayer };
  }

  async _loadFromWarm(memoryId) {
    const warmPath = path.join(this.warmDir, `${memoryId}.md`);
    if (!fs.existsSync(warmPath)) {
      return null;
    }

    const content = fs.readFileSync(warmPath, 'utf-8');
    const memories = this._parseMemoryFile(content);
    return memories[0] || null;
  }

  async _loadFromCold(memoryId) {
    const coldPath = path.join(this.coldDir, `${memoryId}.md`);
    if (!fs.existsSync(coldPath)) {
      return null;
    }

    let content = fs.readFileSync(coldPath, 'utf-8');
    content = this._decompressContent(content);

    const memories = this._parseMemoryFile(content);
    return memories[0] || null;
  }

  async _removeFromHotLayer(memoryId) {
    return _withMemoryFileLock(() => {
      if (!fs.existsSync(this.memoryFile)) {
        return;
      }

      const content = fs.readFileSync(this.memoryFile, 'utf-8');
      const memories = this._parseMemoryFile(content);
      const filtered = memories.filter(m => m.id !== memoryId);

      if (filtered.length < memories.length) {
        const newContent = this._formatMemoryFile(filtered);
        fs.writeFileSync(this.memoryFile, newContent);
      }
    });
  }

  async _addToHotLayer(memory) {
    return _withMemoryFileLock(() => {
      let memories = [];

      if (fs.existsSync(this.memoryFile)) {
        const content = fs.readFileSync(this.memoryFile, 'utf-8');
        memories = this._parseMemoryFile(content);
      }

      const existingIndex = memories.findIndex(m => m.id === memory.id);
      if (existingIndex >= 0) {
        memories[existingIndex] = memory;
      } else {
        memories.unshift(memory);
      }

      const newContent = this._formatMemoryFile(memories);
      fs.writeFileSync(this.memoryFile, newContent);
    });
  }

  _formatMemoryFile(memories) {
    const lines = ['# 📓 CrabPaw 记忆索引', '', '---', ''];

    for (const memory of memories) {
      lines.push('---');
      lines.push(`id: ${memory.id}`);
      lines.push(`type: ${memory.type}`);
      lines.push(`title: ${memory.title}`);
      lines.push(`created: ${memory.created}`);
      lines.push(`updated: ${memory.updated}`);
      lines.push('---');
      lines.push('');
      lines.push(memory.content || '');
      lines.push('');
    }

    return lines.join('\n');
  }

  _compressContent(content) {
    const marker = '\x00COMPRESSED\x00';
    const compressed = content
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^(#{1,6})\s+/gm, `$1${marker}`)
      .replace(/^(\s*[-*+])\s+/gm, `$1${marker}`);
    return compressed;
  }

  _decompressContent(content) {
    const marker = '\x00COMPRESSED\x00';
    return content.split(marker).join(' ');
  }

  async runArchiveCycle() {
    console.log('🔄 开始记忆归档周期...');

    const candidates = await this.identifyArchiveCandidates();
    const results = {
      toWarm: [],
      toCold: [],
      toDelete: [],
      errors: [],
    };

    for (const memory of candidates.toWarm) {
      try {
        const result = await this.archiveToWarm(memory.id);
        if (result.success) {
          results.toWarm.push(memory.id);
        }
      } catch (e) {
        results.errors.push({ memoryId: memory.id, error: e.message });
      }
    }

    for (const memory of candidates.toCold) {
      try {
        const result = await this.archiveToCold(memory.id, 'hot');
        if (result.success) {
          results.toCold.push(memory.id);
        }
      } catch (e) {
        results.errors.push({ memoryId: memory.id, error: e.message });
      }
    }

    for (const memory of candidates.toDelete) {
      try {
        // 软删除：移入 .trash/ 目录而非物理删除
        await this._softDelete(memory);
        results.toDelete.push(memory.id);
      } catch (e) {
        results.errors.push({ memoryId: memory.id, error: e.message });
      }
    }

    this._saveIndex();
    this._saveAccessLog();

    // 清理回收站中已过期的记忆
    const purgedFromTrash = this.purgeExpiredTrash();

    console.log(`✅ 归档完成: 温层 ${results.toWarm.length}, 冷层 ${results.toCold.length}, 删除 ${results.toDelete.length}, 回收站清除 ${purgedFromTrash}`);

    this.emit('archive:complete', results);
    return results;
  }

  getArchiveStats() {
    return {
      hot: {
        count: this._index.hot.length,
        max: this.config.maxHotMemories,
      },
      warm: {
        count: this._index.warm.length,
        max: this.config.maxWarmMemories,
      },
      cold: {
        count: this._index.cold.length,
      },
      totalAccessLog: Object.keys(this._accessLog).length,
    };
  }

  async searchArchives(query, layers = ['hot', 'warm', 'cold']) {
    const results = [];

    if (layers.includes('hot')) {
      const hotMemories = await this.scanHotMemories();
      for (const memory of hotMemories) {
        if (this._matchesQuery(memory, query)) {
          results.push({ ...memory, layer: 'hot' });
        }
      }
    }

    if (layers.includes('warm')) {
      for (const memoryId of this._index.warm) {
        const memory = await this._loadFromWarm(memoryId);
        if (memory && this._matchesQuery(memory, query)) {
          results.push({ ...memory, layer: 'warm' });
        }
      }
    }

    if (layers.includes('cold')) {
      for (const memoryId of this._index.cold) {
        const memory = await this._loadFromCold(memoryId);
        if (memory && this._matchesQuery(memory, query)) {
          results.push({ ...memory, layer: 'cold' });
        }
      }
    }

    return results;
  }

  _matchesQuery(memory, query) {
    const queryLower = query.toLowerCase();
    return (
      memory.title?.toLowerCase().includes(queryLower) ||
      memory.content?.toLowerCase().includes(queryLower) ||
      memory.type?.toLowerCase().includes(queryLower)
    );
  }

  // ========== 软删除 & 回收站 ==========

  /**
   * 软删除：将记忆移入 .trash/ 目录，保留 trashRetentionDays 天后物理清除
   */
  async _softDelete(memory) {
    const trashPath = path.join(this.trashDir, `${memory.id}.md`);
    const content = this._formatMemoryFile([memory]);
    fs.writeFileSync(trashPath, content, 'utf-8');

    // 记录到回收站索引
    const trashIndex = this._loadTrashIndex();
    trashIndex[memory.id] = {
      id: memory.id,
      title: memory.title || '',
      type: memory.type || 'general',
      originalLayer: memory.layer || 'hot',
      deletedAt: Date.now(),
      expiresAt: Date.now() + this.config.trashRetentionDays * 86400000,
    };
    this._saveTrashIndex(trashIndex);

    // 从原始层移除
    await this._removeFromHotLayer(memory.id);
    this._index.hot = this._index.hot.filter(id => id !== memory.id);

    this.emit('soft_deleted', { memoryId: memory.id, trashPath });
    console.log(`🗑️ 软删除记忆: ${memory.id} → .trash/ (${this.config.trashRetentionDays}天后物理清除)`);
  }

  /**
   * 加载回收站索引
   */
  _loadTrashIndex() {
    if (fs.existsSync(this.trashIndexFile)) {
      try {
        return JSON.parse(fs.readFileSync(this.trashIndexFile, 'utf-8'));
      } catch {
        return {};
      }
    }
    return {};
  }

  /**
   * 保存回收站索引
   */
  _saveTrashIndex(index) {
    if (!fs.existsSync(this.trashDir)) {
      fs.mkdirSync(this.trashDir, { recursive: true });
    }
    fs.writeFileSync(this.trashIndexFile, JSON.stringify(index, null, 2), 'utf-8');
  }

  /**
   * 列出回收站中的记忆
   */
  listTrash() {
    const trashIndex = this._loadTrashIndex();
    return Object.values(trashIndex).map(entry => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      originalLayer: entry.originalLayer,
      deletedAt: entry.deletedAt,
      expiresAt: entry.expiresAt,
      remainingDays: Math.max(0, ((entry.expiresAt - Date.now()) / 86400000).toFixed(1)),
    }));
  }

  /**
   * 从回收站恢复记忆
   */
  async restoreFromTrash(memoryId, targetLayer = 'hot') {
    const trashIndex = this._loadTrashIndex();
    const entry = trashIndex[memoryId];
    if (!entry) {
      return { success: false, error: 'Memory not found in trash' };
    }

    const trashPath = path.join(this.trashDir, `${memoryId}.md`);
    if (!fs.existsSync(trashPath)) {
      // 索引存在但文件已丢失，清理索引
      delete trashIndex[memoryId];
      this._saveTrashIndex(trashIndex);
      return { success: false, error: 'Trash file missing' };
    }

    const content = fs.readFileSync(trashPath, 'utf-8');
    const memories = this._parseMemoryFile(content);
    const memory = memories[0];

    if (!memory) {
      return { success: false, error: 'Failed to parse trash file' };
    }

    // 恢复到目标层
    if (targetLayer === 'hot') {
      await this._addToHotLayer(memory);
    } else if (targetLayer === 'warm') {
      const warmPath = path.join(this.warmDir, `${memoryId}.md`);
      fs.writeFileSync(warmPath, this._formatMemoryFile([memory]));
    }

    // 更新索引
    this._index[targetLayer].push(memoryId);
    this._saveIndex();

    // 从回收站移除
    delete trashIndex[memoryId];
    this._saveTrashIndex(trashIndex);
    fs.unlinkSync(trashPath);

    // 恢复访问记录
    this.recordAccess(memoryId);

    this.emit('restored_from_trash', { memoryId, to: targetLayer });
    console.log(`♻️ 从回收站恢复记忆: ${memoryId} → ${targetLayer}`);

    return { success: true, memory, targetLayer };
  }

  /**
   * 清理回收站中已过期的记忆（物理删除）
   */
  purgeExpiredTrash() {
    const trashIndex = this._loadTrashIndex();
    const now = Date.now();
    let purged = 0;

    for (const [memoryId, entry] of Object.entries(trashIndex)) {
      if (now >= entry.expiresAt) {
        const trashPath = path.join(this.trashDir, `${memoryId}.md`);
        if (fs.existsSync(trashPath)) {
          fs.unlinkSync(trashPath);
        }
        delete trashIndex[memoryId];
        purged++;
      }
    }

    if (purged > 0) {
      this._saveTrashIndex(trashIndex);
      console.log(`🗑️ 回收站清理: 物理删除 ${purged} 条过期记忆`);
    }

    this.emit('trash_purged', { purged });
    return purged;
  }
}

module.exports = {
  MemoryArchiver,
  MEMORY_LAYERS,
  ARCHIVE_CONFIG,
};
