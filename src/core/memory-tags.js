const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TAGS = {
  important: { emoji: '⭐', color: '#FFD700', description: '重要信息' },
  preference: { emoji: '❤️', color: '#FF69B4', description: '用户偏好' },
  project: { emoji: '📁', color: '#4169E1', description: '项目相关' },
  person: { emoji: '👤', color: '#32CD32', description: '人物信息' },
  location: { emoji: '📍', color: '#FF6347', description: '地点信息' },
  date: { emoji: '📅', color: '#9370DB', description: '日期时间' },
  task: { emoji: '✅', color: '#20B2AA', description: '任务待办' },
  idea: { emoji: '💡', color: '#FFA500', description: '想法灵感' }
};

class MemoryTags {
  constructor(configDir) {
    this.configDir = configDir;
    this.tagsPath = path.join(configDir, 'memory-tags.json');
    this.tags = this.loadTags();
  }
  
  loadTags() {
    if (fs.existsSync(this.tagsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.tagsPath, 'utf-8'));
        return {
          ...DEFAULT_TAGS,
          ...data.customTags
        };
      } catch (e) {
        console.error('加载记忆标签失败:', e.message);
      }
    }
    return { ...DEFAULT_TAGS };
  }
  
  saveTags() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    
    const customTags = {};
    Object.keys(this.tags).forEach(key => {
      if (!DEFAULT_TAGS[key]) {
        customTags[key] = this.tags[key];
      }
    });
    
    fs.writeFileSync(this.tagsPath, JSON.stringify({ customTags }, null, 2));
  }
  
  addTag(id, tag) {
    if (this.tags[id]) {
      return { success: false, message: '标签已存在' };
    }
    
    this.tags[id] = {
      emoji: tag.emoji || '🏷️',
      color: tag.color || '#808080',
      description: tag.description || ''
    };
    
    this.saveTags();
    return { success: true, tag: this.tags[id] };
  }
  
  updateTag(id, updates) {
    if (!this.tags[id]) {
      return { success: false, message: '标签不存在' };
    }
    
    this.tags[id] = {
      ...this.tags[id],
      ...updates
    };
    
    this.saveTags();
    return { success: true, tag: this.tags[id] };
  }
  
  removeTag(id) {
    if (!this.tags[id]) {
      return { success: false, message: '标签不存在' };
    }
    
    if (DEFAULT_TAGS[id]) {
      return { success: false, message: '不能删除默认标签' };
    }
    
    delete this.tags[id];
    this.saveTags();
    return { success: true };
  }
  
  getTag(id) {
    return this.tags[id] || null;
  }
  
  getAllTags() {
    return this.tags;
  }
  
  getTagList() {
    return Object.entries(this.tags).map(([id, tag]) => ({
      id,
      ...tag,
      isDefault: !!DEFAULT_TAGS[id]
    }));
  }
}

class MemoryEntry {
  constructor(configDir) {
    this.configDir = configDir;
    this.entriesPath = path.join(configDir, 'memory-entries.json');
    this.entries = this.loadEntries();
  }
  
  loadEntries() {
    if (fs.existsSync(this.entriesPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.entriesPath, 'utf-8'));
      } catch (e) {
        console.error('加载记忆条目失败:', e.message);
      }
    }
    return [];
  }
  
  saveEntries() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
    fs.writeFileSync(this.entriesPath, JSON.stringify(this.entries, null, 2));
  }
  
  addEntry(content, tags = [], metadata = {}) {
    const entry = {
      id: `mem_${Date.now()}_${crypto.randomBytes(5).toString("hex").slice(0, 9)}`,
      content,
      tags: Array.isArray(tags) ? tags : [tags],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: metadata.source || 'chat',
      importance: metadata.importance || 0,
      ...metadata
    };
    
    this.entries.unshift(entry);
    this.saveEntries();
    
    return { success: true, entry };
  }
  
  updateEntry(id, updates) {
    const index = this.entries.findIndex(e => e.id === id);
    if (index === -1) {
      return { success: false, message: '条目不存在' };
    }
    
    this.entries[index] = {
      ...this.entries[index],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    this.saveEntries();
    return { success: true, entry: this.entries[index] };
  }
  
  removeEntry(id) {
    const index = this.entries.findIndex(e => e.id === id);
    if (index === -1) {
      return { success: false, message: '条目不存在' };
    }
    
    this.entries.splice(index, 1);
    this.saveEntries();
    return { success: true };
  }
  
  getEntry(id) {
    return this.entries.find(e => e.id === id) || null;
  }
  
  getEntriesByTag(tagId) {
    return this.entries.filter(e => e.tags.includes(tagId));
  }
  
  searchEntries(query) {
    const lowerQuery = query.toLowerCase();
    return this.entries.filter(e => 
      e.content.toLowerCase().includes(lowerQuery) ||
      e.tags.some(t => t.toLowerCase().includes(lowerQuery))
    );
  }
  
  getRecentEntries(limit = 20) {
    return this.entries.slice(0, limit);
  }
  
  getImportantEntries(threshold = 5) {
    return this.entries.filter(e => e.importance >= threshold);
  }
}

module.exports = {
  MemoryTags,
  MemoryEntry,
  DEFAULT_TAGS
};
