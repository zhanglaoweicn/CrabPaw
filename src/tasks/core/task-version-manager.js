const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class TaskVersionManager {
  constructor() {
    this.versionHistory = new Map();
    this.maxVersionsPerTask = 20;
    this.versionStoragePath = null;
  }
  
  init(storagePath) {
    this.versionStoragePath = storagePath || this.getDefaultStoragePath();
    
    if (!fs.existsSync(this.versionStoragePath)) {
      fs.mkdirSync(this.versionStoragePath, { recursive: true });
    }
    
    this.loadVersionHistory();
    console.log('📦 任务版本管理器已初始化');
  }
  
  getDefaultStoragePath() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    return path.join(dataDir, 'task-versions');
  }
  
  loadVersionHistory() {
    const historyFile = path.join(this.versionStoragePath, 'version-history.json');
    
    if (fs.existsSync(historyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        
        for (const [taskId, versions] of Object.entries(data)) {
          this.versionHistory.set(taskId, versions);
        }
        
        console.log(`📦 已加载 ${this.versionHistory.size} 个任务的版本历史`);
      } catch (e) {
        console.error('加载版本历史失败:', e.message);
      }
    }
  }
  
  saveVersionHistory() {
    if (!this.versionStoragePath) return;
    
    const historyFile = path.join(this.versionStoragePath, 'version-history.json');
    const data = Object.fromEntries(this.versionHistory);
    
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2), 'utf-8');
  }
  
  createVersion(task, options = {}) {
    const { userId = 'system', reason = '', changes = [] } = options;
    
    const version = {
      versionId: this.generateVersionId(),
      taskId: task.id,
      taskName: task.name,
      config: this.deepClone(task),
      checksum: this.calculateChecksum(task),
      createdAt: Date.now(),
      createdBy: userId,
      reason,
      changes,
      metadata: {
        action: task.action,
        cron: task.cron,
        enabled: task.enabled,
        skill: task.skill
      }
    };
    
    if (!this.versionHistory.has(task.id)) {
      this.versionHistory.set(task.id, []);
    }
    
    const versions = this.versionHistory.get(task.id);
    versions.unshift(version);
    
    if (versions.length > this.maxVersionsPerTask) {
      const removedVersions = versions.splice(this.maxVersionsPerTask);
      this.cleanupVersionFiles(removedVersions);
    }
    
    this.saveVersionFile(version);
    this.saveVersionHistory();
    
    console.log(`📦 创建任务版本: ${task.name} (${version.versionId})`);
    
    return version;
  }
  
  generateVersionId() {
    return `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
  
  calculateChecksum(task) {
    const content = JSON.stringify({
      name: task.name,
      cron: task.cron,
      action: task.action,
      skill: task.skill,
      params: task.params,
      enabled: task.enabled
    });
    
    return crypto.createHash('md5').update(content).digest('hex');
  }
  
  deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  
  saveVersionFile(version) {
    if (!this.versionStoragePath) return;
    
    const taskDir = path.join(this.versionStoragePath, version.taskId);
    
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }
    
    const versionFile = path.join(taskDir, `${version.versionId}.json`);
    fs.writeFileSync(versionFile, JSON.stringify(version, null, 2), 'utf-8');
  }
  
  cleanupVersionFiles(versions) {
    for (const version of versions) {
      const versionFile = path.join(
        this.versionStoragePath,
        version.taskId,
        `${version.versionId}.json`
      );
      
      if (fs.existsSync(versionFile)) {
        fs.unlinkSync(versionFile);
      }
    }
  }
  
  getVersion(taskId, versionId) {
    const versions = this.versionHistory.get(taskId);
    if (!versions) return null;
    
    return versions.find(v => v.versionId === versionId) || null;
  }
  
  listVersions(taskId, limit = 20) {
    const versions = this.versionHistory.get(taskId);
    if (!versions) return [];
    
    return versions.slice(0, limit).map(v => ({
      versionId: v.versionId,
      taskName: v.taskName,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      reason: v.reason,
      changes: v.changes,
      checksum: v.checksum
    }));
  }
  
  restoreVersion(taskId, versionId) {
    const version = this.getVersion(taskId, versionId);
    
    if (!version) {
      return {
        success: false,
        error: '版本不存在'
      };
    }
    
    const restoredConfig = this.deepClone(version.config);
    restoredConfig.restoredFrom = versionId;
    restoredConfig.restoredAt = Date.now();
    
    console.log(`📦 恢复任务版本: ${version.taskName} (${versionId})`);
    
    return {
      success: true,
      config: restoredConfig,
      version: {
        versionId: version.versionId,
        createdAt: version.createdAt,
        createdBy: version.createdBy
      }
    };
  }
  
  compareVersions(taskId, versionId1, versionId2) {
    const version1 = this.getVersion(taskId, versionId1);
    const version2 = this.getVersion(taskId, versionId2);
    
    if (!version1 || !version2) {
      return {
        success: false,
        error: '一个或多个版本不存在'
      };
    }
    
    const diff = this.calculateDiff(version1.config, version2.config);
    
    return {
      success: true,
      version1: {
        versionId: version1.versionId,
        createdAt: version1.createdAt
      },
      version2: {
        versionId: version2.versionId,
        createdAt: version2.createdAt
      },
      diff
    };
  }
  
  calculateDiff(config1, config2) {
    const diff = [];
    const allKeys = new Set([...Object.keys(config1), ...Object.keys(config2)]);
    
    for (const key of allKeys) {
      const val1 = config1[key];
      const val2 = config2[key];
      
      if (JSON.stringify(val1) !== JSON.stringify(val2)) {
        diff.push({
          field: key,
          oldValue: val1,
          newValue: val2
        });
      }
    }
    
    return diff;
  }
  
  deleteVersion(taskId, versionId) {
    const versions = this.versionHistory.get(taskId);
    if (!versions) return false;
    
    const index = versions.findIndex(v => v.versionId === versionId);
    if (index === -1) return false;
    
    const [removed] = versions.splice(index, 1);
    
    const versionFile = path.join(
      this.versionStoragePath,
      taskId,
      `${versionId}.json`
    );
    
    if (fs.existsSync(versionFile)) {
      fs.unlinkSync(versionFile);
    }
    
    this.saveVersionHistory();
    
    console.log(`🗑️ 删除任务版本: ${removed.taskName} (${versionId})`);
    
    return true;
  }
  
  deleteAllVersions(taskId) {
    const versions = this.versionHistory.get(taskId);
    if (!versions) return 0;
    
    this.cleanupVersionFiles(versions);
    this.versionHistory.delete(taskId);
    this.saveVersionHistory();
    
    console.log(`🗑️ 删除任务所有版本: ${taskId}`);
    
    return versions.length;
  }
  
  getVersionStatistics(taskId) {
    const versions = this.versionHistory.get(taskId);
    if (!versions) {
      return {
        total: 0,
        oldestVersion: null,
        newestVersion: null
      };
    }
    
    return {
      total: versions.length,
      oldestVersion: versions[versions.length - 1]?.createdAt || null,
      newestVersion: versions[0]?.createdAt || null
    };
  }
  
  exportVersions(taskId) {
    const versions = this.versionHistory.get(taskId);
    if (!versions) return null;
    
    return {
      taskId,
      exportedAt: Date.now(),
      versions: versions.map(v => ({
        ...v,
        config: v.config
      }))
    };
  }
  
  importVersions(taskId, versionsData) {
    if (!this.versionHistory.has(taskId)) {
      this.versionHistory.set(taskId, []);
    }
    
    const existingVersions = this.versionHistory.get(taskId);
    const existingIds = new Set(existingVersions.map(v => v.versionId));
    
    let imported = 0;
    
    for (const versionData of versionsData) {
      if (!existingIds.has(versionData.versionId)) {
        existingVersions.push(versionData);
        this.saveVersionFile(versionData);
        imported++;
      }
    }
    
    existingVersions.sort((a, b) => b.createdAt - a.createdAt);
    
    if (existingVersions.length > this.maxVersionsPerTask) {
      const removed = existingVersions.splice(this.maxVersionsPerTask);
      this.cleanupVersionFiles(removed);
    }
    
    this.saveVersionHistory();
    
    return imported;
  }
}

let instance = null;

function getTaskVersionManager() {
  if (!instance) {
    instance = new TaskVersionManager();
  }
  return instance;
}

module.exports = {
  TaskVersionManager,
  getTaskVersionManager
};
