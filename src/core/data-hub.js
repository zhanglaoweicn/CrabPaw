/**
 * DataHub - 统一数据管理入口
 *
 * 解决问题：
 * - 30+ 个独立 JSON/DB 文件散落在 data/.crabpaw/ 目录
 * - 各模块独立管理数据路径，缺少统一生命周期
 * - 启动时无法统一初始化，关闭时无法统一清理
 *
 * 职责：
 * 1. 统一数据目录管理
 * 2. 统一初始化/关闭生命周期
 * 3. 数据健康检查
 * 4. 数据备份/恢复
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const DATA_HUB_DIR = DATA_DIR;

// 数据域定义
const DATA_DOMAINS = {
  memory: {
    dir: 'memory',
    description: '记忆系统数据',
    files: ['memory.db', 'MEMORY.md'],
  },
  tasks: {
    dir: 'tasks',
    description: '任务系统数据',
    files: ['execution-history.db', 'task-store.db'],
  },
  skills: {
    dir: 'skills',
    description: '技能系统数据',
    files: ['skill-quality.db', 'skill-versions.db'],
  },
  evolution: {
    dir: 'evolution',
    description: '进化系统数据',
    files: ['evolution-state.json', 'validation'],
  },
  perception: {
    dir: 'perception',
    description: '感知系统数据',
    files: ['metrics.db'],
  },
  security: {
    dir: 'security',
    description: '安全系统数据',
    files: ['audit-log.db'],
  },
  kanban: {
    dir: 'kanban',
    description: '看板数据',
    files: ['kanban.db'],
  },
  goals: {
    dir: 'goals',
    description: '目标管理数据',
    files: [],
  },
  history: {
    dir: 'history',
    description: '对话历史数据',
    files: ['history.db'],
  },
  config: {
    dir: 'config',
    description: '配置数据',
    files: ['assistant.json', 'user.json'],
  },
  cache: {
    dir: 'cache',
    description: '缓存数据（可安全删除）',
    files: [],
    ephemeral: true,
  },
};

class DataHub {
  constructor() {
    this._initialized = false;
    this._databases = new Map(); // 打开的数据库连接
    this._initCallbacks = [];   // 初始化回调
    this._closeCallbacks = [];  // 关闭回调
  }

  /**
   * 注册初始化回调
   */
  onInit(callback) {
    this._initCallbacks.push(callback);
  }

  /**
   * 注册关闭回调
   */
  onClose(callback) {
    this._closeCallbacks.push(callback);
  }

  /**
   * 注册数据库连接（统一生命周期管理）
   */
  registerDatabase(name, db) {
    this._databases.set(name, db);
  }

  /**
   * 获取数据库连接
   */
  getDatabase(name) {
    return this._databases.get(name);
  }

  /**
   * 初始化所有数据目录
   */
  initialize() {
    if (this._initialized) return;

    // 确保根目录存在
    if (!fs.existsSync(DATA_HUB_DIR)) {
      fs.mkdirSync(DATA_HUB_DIR, { recursive: true });
    }

    // 确保各数据域目录存在
    // eslint-disable-next-line no-unused-vars
    for (const [domain, config] of Object.entries(DATA_DOMAINS)) {
      const domainPath = path.join(DATA_HUB_DIR, config.dir);
      if (!fs.existsSync(domainPath)) {
        fs.mkdirSync(domainPath, { recursive: true });
      }
    }

    // 执行注册的初始化回调
    for (const callback of this._initCallbacks) {
      try {
        callback();
      } catch (err) {
        console.warn(`[DataHub] 初始化回调失败:`, err.message);
      }
    }

    this._initialized = true;
    console.log('[DataHub] 数据目录已初始化');
  }

  /**
   * 关闭所有数据库连接
   */
  close() {
    // 执行注册的关闭回调
    for (const callback of this._closeCallbacks) {
      try {
        callback();
      } catch (err) {
        console.warn(`[DataHub] 关闭回调失败:`, err.message);
      }
    }

    // 关闭所有数据库连接
    for (const [name, db] of this._databases) {
      try {
        if (db && typeof db.close === 'function') {
          db.close();
          console.log(`[DataHub] 已关闭数据库: ${name}`);
        }
      } catch (err) {
        console.warn(`[DataHub] 关闭数据库 ${name} 失败:`, err.message);
      }
    }
    this._databases.clear();
    this._initialized = false;
  }

  /**
   * 获取数据域路径
   */
  getDomainPath(domain) {
    const config = DATA_DOMAINS[domain];
    if (!config) {
      throw new Error(`未知数据域: ${domain}`);
    }
    return path.join(DATA_HUB_DIR, config.dir);
  }

  /**
   * 获取数据域中的文件路径
   */
  getFilePath(domain, filename) {
    return path.join(this.getDomainPath(domain), filename);
  }

  /**
   * 数据健康检查
   */
  healthCheck() {
    const results = {
      healthy: true,
      domains: {},
      totalSize: 0,
    };

    for (const [domain, config] of Object.entries(DATA_DOMAINS)) {
      const domainPath = path.join(DATA_HUB_DIR, config.dir);
      const domainResult = {
        exists: fs.existsSync(domainPath),
        size: 0,
        files: [],
      };

      if (domainResult.exists) {
        try {
          const files = fs.readdirSync(domainPath);
          for (const file of files) {
            const filePath = path.join(domainPath, file);
            const stat = fs.statSync(filePath);
            domainResult.size += stat.size;
            domainResult.files.push({
              name: file,
              size: stat.size,
              modified: stat.mtime,
            });
          }
        } catch (err) {
          domainResult.error = err.message;
          results.healthy = false;
        }
      } else if (!config.ephemeral) {
        domainResult.error = '目录不存在';
        results.healthy = false;
      }

      results.domains[domain] = domainResult;
      results.totalSize += domainResult.size;
    }

    return results;
  }

  /**
   * 清理临时/缓存数据
   */
  cleanCache() {
    let cleaned = 0;
    for (const [domain, config] of Object.entries(DATA_DOMAINS)) {
      if (config.ephemeral) {
        const domainPath = path.join(DATA_HUB_DIR, config.dir);
        if (fs.existsSync(domainPath)) {
          try {
            const files = fs.readdirSync(domainPath);
            for (const file of files) {
              fs.unlinkSync(path.join(domainPath, file));
              cleaned++;
            }
          } catch (err) {
            console.warn(`[DataHub] 清理缓存 ${domain} 失败:`, err.message);
          }
        }
      }
    }
    console.log(`[DataHub] 已清理 ${cleaned} 个缓存文件`);
    return cleaned;
  }

  /**
   * 获取数据统计摘要
   */
  getStats() {
    const health = this.healthCheck();
    return {
      totalDomains: Object.keys(DATA_DOMAINS).length,
      totalSize: health.totalSize,
      totalSizeMB: (health.totalSize / 1024 / 1024).toFixed(2),
      openDatabases: this._databases.size,
      healthy: health.healthy,
      domainSummary: Object.fromEntries(
        Object.entries(health.domains).map(([k, v]) => [k, {
          sizeMB: (v.size / 1024 / 1024).toFixed(2),
          fileCount: v.files.length,
          exists: v.exists,
        }])
      ),
    };
  }
}

// 单例
const dataHub = new DataHub();

module.exports = {
  DataHub,
  dataHub,
  DATA_DOMAINS,
  DATA_HUB_DIR,
};
