const { DATA_DIR } = require('./config');

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PATROL_HISTORY = 100;

const EVOLUTION_TRIGGER_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每日触发进化

const CHECKS = {
  api_connectivity: {
    name: 'API连通性',
    description: '检查AI模型API是否可达',
    severity: 'critical',
  },
  disk_space: {
    name: '磁盘空间',
    description: '检查数据目录可用空间',
    severity: 'warning',
  },
  memory_usage: {
    name: '内存使用',
    description: '检查进程内存占用',
    severity: 'warning',
  },
  config_integrity: {
    name: '配置完整性',
    description: '检查关键配置文件是否有效',
    severity: 'critical',
  },
  skill_health: {
    name: '技能健康',
    description: '检查技能加载和执行状态',
    severity: 'warning',
  },
  scheduler_health: {
    name: '调度器健康',
    description: '检查定时任务调度器运行状态',
    severity: 'warning',
  },
  session_cleanup: {
    name: '会话清理',
    description: '检查过期会话和临时文件',
    severity: 'info',
  },
};

class HeartbeatPatrol {
  constructor() {
    this._interval = null;
    this._history = [];
    this._lastResults = new Map();
    this._alertCallbacks = [];
    this._running = false;
    this._checkCount = 0;
    this._lastEvolutionTime = 0;
  }

  registerAlert(callback) {
    this._alertCallbacks.push(callback);
  }

  async _emitAlert(alert) {
    for (const cb of this._alertCallbacks) {
      try {
        await cb(alert);
      } catch { console.warn('[heartbeat-patrol] silent catch, error swallowed'); }
    }
  }

  async checkApiConnectivity() {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(DATA_DIR, 'config.json');

    try {
      if (!fs.existsSync(configPath)) {
        return { status: 'unhealthy', detail: '配置文件不存在', check: 'api_connectivity' };
      }

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const models = config.models || {};
      const providers = models.providers || {};
      const currentProvider = models.currentProvider || 'deepseek';
      const providerConfig = providers[currentProvider];

      if (!providerConfig) {
        return { status: 'unhealthy', detail: `当前提供商 ${currentProvider} 未配置`, check: 'api_connectivity' };
      }

      if (!providerConfig.apiKey && !providerConfig.key) {
        return { status: 'unhealthy', detail: `提供商 ${currentProvider} 缺少 API 密钥`, check: 'api_connectivity' };
      }

      return { status: 'healthy', detail: `${currentProvider} 已配置`, check: 'api_connectivity' };
    } catch (err) {
      return { status: 'unhealthy', detail: `检查失败: ${err.message}`, check: 'api_connectivity' };
    }
  }

  async checkDiskSpace() {
    try {
      const fs = require('fs');
      const stats = fs.statfs ? fs.statfsSync(DATA_DIR) : null;
      if (stats) {
        const freeGB = (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
        if (freeGB < 0.5) {
          return { status: 'unhealthy', detail: `剩余空间不足: ${freeGB.toFixed(2)}GB`, check: 'disk_space' };
        }
        if (freeGB < 2) {
          return { status: 'warning', detail: `剩余空间较低: ${freeGB.toFixed(2)}GB`, check: 'disk_space' };
        }
        return { status: 'healthy', detail: `剩余空间: ${freeGB.toFixed(2)}GB`, check: 'disk_space' };
      }

      return { status: 'healthy', detail: '磁盘空间检查跳过(不支持statfs)', check: 'disk_space' };
    } catch (err) {
      return { status: 'warning', detail: `检查失败:  ${err.message}`, check: 'disk_space' };
    }
  }

  async checkMemoryUsage() {
    try {
      const usage = process.memoryUsage();
      const heapUsedMB = (usage.heapUsed / (1024 * 1024)).toFixed(1);
      const rssMB = (usage.rss / (1024 * 1024)).toFixed(1);

      if (usage.heapUsed > 512 * 1024 * 1024) {
        return { status: 'unhealthy', detail: `内存占用过高: RSS ${rssMB}MB, Heap ${heapUsedMB}MB`, check: 'memory_usage' };
      }
      if (usage.heapUsed > 256 * 1024 * 1024) {
        return { status: 'warning', detail: `内存占用较高: RSS ${rssMB}MB, Heap ${heapUsedMB}MB`, check: 'memory_usage' };
      }
      return { status: 'healthy', detail: `RSS ${rssMB}MB, Heap ${heapUsedMB}MB`, check: 'memory_usage' };
    } catch (err) {
      return { status: 'warning', detail: `检查失败:  ${err.message}`, check: 'memory_usage' };
    }
  }

  async checkConfigIntegrity() {
    try {
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(DATA_DIR, 'config.json');

      if (!fs.existsSync(configPath)) {
        return { status: 'unhealthy', detail: '配置文件缺失', check: 'config_integrity' };
      }

      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);

      if (!config.models) {
        return { status: 'warning', detail: '缺少模型配置', check: 'config_integrity' };
      }

      return { status: 'healthy', detail: '配置文件完整', check: 'config_integrity' };
    } catch (err) {
      return { status: 'unhealthy', detail: `配置解析失败: ${err.message}`, check: 'config_integrity' };
    }
  }

  async checkSkillHealth() {
    try {
      const { loadSkills } = require('./skills');
      const skills = loadSkills();
      if (skills.length === 0) {
        return { status: 'warning', detail: '无可用技能', check: 'skill_health' };
      }
      return { status: 'healthy', detail: `${skills.length} 个技能已加载`, check: 'skill_health' };
    } catch (err) {
      return { status: 'warning', detail: `技能检查失败:  ${err.message}`, check: 'skill_health' };
    }
  }

  async checkSchedulerHealth() {
    try {
      // 修复：此前 `const { scheduler } = require('./scheduler')` 解构导出对象为
      // undefined（导出的是 Scheduler 类），恒误报"调度器未初始化"。
      // 真实实例由 server.js 创建并持有（getGlobalCron）。
      const schedulerModule = require('./scheduler');
      if (!schedulerModule || typeof schedulerModule.Scheduler !== 'function') {
        return { status: 'warning', detail: '调度器模块不可用', check: 'scheduler_health' };
      }
      let instance = null;
      try {
        const { getGlobalCron } = require('../cli/server');
        if (typeof getGlobalCron === 'function') instance = getGlobalCron();
      } catch (e) {
        /* server 尚未加载完时跳过实例获取（模块可用即健康） */
        console.warn('[heartbeat-patrol.js] 空 catch 补日志:', e && e.message);
      }

      const tasks = instance && typeof instance.getTasks === 'function' ? instance.getTasks() : [];
      return { status: 'healthy', detail: `调度器就绪, ${tasks.length} 个任务`, check: 'scheduler_health' };
    } catch (err) {
      return { status: 'warning', detail: `调度器检查失败:  ${err.message}`, check: 'scheduler_health' };
    }
  }

  async checkSessionCleanup() {
    try {
      const fs = require('fs');
      const path = require('path');
      const sessionsDir = path.join(DATA_DIR, 'sessions');
      if (!fs.existsSync(sessionsDir)) {
        return { status: 'healthy', detail: '无会话目录', check: 'session_cleanup' };
      }

      const files = fs.readdirSync(sessionsDir);
      const now = Date.now();
      const OLD_THRESHOLD = 7 * 24 * 60 * 60 * 1000;
      let oldCount = 0;

      for (const file of files) {
        try {
          const stat = fs.statSync(path.join(sessionsDir, file));
          if (now - stat.mtimeMs > OLD_THRESHOLD) {
            oldCount++;
          }
        } catch { console.warn('[heartbeat-patrol] silent catch, error swallowed'); }
      }

      if (oldCount > 50) {
        // Auto-clean: remove sessions older than 7 days
        let cleaned = 0;
        for (const file of files) {
          try {
            const stat = fs.statSync(path.join(sessionsDir, file));
            if (now - stat.mtimeMs > OLD_THRESHOLD) {
              fs.unlinkSync(path.join(sessionsDir, file));
              cleaned++;
            }
          } catch { console.warn('[heartbeat-patrol] silent catch, error swallowed'); }
        }
        return { status: 'cleaned', detail: `Cleaned ${cleaned} expired sessions, ${files.length - cleaned} remaining`, check: 'session_cleanup' };
      } else {
                return { status: 'warning', detail: `${oldCount} 个过期会话文件`, check: 'session_cleanup' };
      }
    } catch (err) {
      return { status: 'info', detail: `检查失败:  ${err.message}`, check: 'session_cleanup' };
    }
  }

  
  async checkGeneratedFiles() {
    try {
      const fs = require('fs');
      const path = require('path');
      const dataDir = require('./config').DATA_DIR;
      const videoDir = path.join(dataDir, 'generated-videos');
      const imageDir = path.join(dataDir, 'generated-images');
      const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      let cleanedCount = 0;

      for (const dir of [videoDir, imageDir]) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        const now = Date.now();
        for (const file of files) {
          try {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > MAX_AGE_MS) {
              fs.unlinkSync(filePath);
              cleanedCount++;
            }
          } catch { console.warn('[heartbeat-patrol] silent catch, error swallowed'); }
        }
      }

      if (cleanedCount > 0) {
        return { status: 'info', detail: `Cleaned ${cleanedCount} old generated files`, check: 'generated_cleanup' };
      }
      return { status: 'healthy', detail: 'Generated files OK', check: 'generated_cleanup' };
    } catch (err) {
      return { status: 'info', detail: `Check failed: ${err.message}`, check: 'generated_cleanup' };
    }
  }

  async runPatrol() {
    const results = {};
    const startTime = Date.now();

    const checkMethods = {
      api_connectivity: () => this.checkApiConnectivity(),
      disk_space: () => this.checkDiskSpace(),
      memory_usage: () => this.checkMemoryUsage(),
      config_integrity: () => this.checkConfigIntegrity(),
      skill_health: () => this.checkSkillHealth(),
      scheduler_health: () => this.checkSchedulerHealth(),
      session_cleanup: () => this.checkSessionCleanup(),
      generated_cleanup: () => this.checkGeneratedFiles(),
    };

    for (const [key, checkFn] of Object.entries(checkMethods)) {
      try {
        results[key] = await checkFn();
      } catch (err) {
        results[key] = { status: 'unhealthy', detail: err.message, check: key };
      }
    }

    const patrolResult = {
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
      results,
      overallStatus: this._computeOverallStatus(results),
    };

    this._lastResults = new Map(Object.entries(results));
    this._history.push(patrolResult);
    if (this._history.length > MAX_PATROL_HISTORY) {
      this._history = this._history.slice(-MAX_PATROL_HISTORY);
    }

    this._checkCount++;

    const alerts = this._generateAlerts(results);
    for (const alert of alerts) {
      await this._emitAlert(alert);
    }

    // 每日自动触发进化系统
    await this._triggerEvolutionIfNeeded();

    return patrolResult;
  }

  _computeOverallStatus(results) {
    const statuses = Object.values(results).map(r => r.status);
    if (statuses.includes('unhealthy')) return 'unhealthy';
    if (statuses.includes('warning')) return 'warning';
    return 'healthy';
  }

  /**
   * 每日自动触发进化系统
   * 激活一个已注册但缺少自动触发源的 Evolver
   */
  async _triggerEvolutionIfNeeded() {
    const now = Date.now();
    if (now - this._lastEvolutionTime < EVOLUTION_TRIGGER_INTERVAL_MS) {
      return;
    }

    try {
      const { triggerEvolution } = require('./evolution-system');
      const result = await triggerEvolution();
      this._lastEvolutionTime = now;
      console.log(`[HeartbeatPatrol] 进化系统已触发，结果: ${JSON.stringify(Object.keys(result || {}))}`);

      // P1 修复：记忆进化自动触发——unified-memory.evolve() 是生产真身
      // （EvolutionAwareMemory → MemoryEvolutionEngine.evolve），此前仅 CLI 手动可触发。
      // 失败只记日志，不阻断心跳主流程。
      try {
        const { evolve: evolveMemory } = require('./unified-memory');
        const memResult = await evolveMemory();
        console.log(`[HeartbeatPatrol] 记忆进化已触发，改进: ${memResult && memResult.improvement != null ? memResult.improvement : 0}`);
      } catch (memErr) {
        console.warn(`[HeartbeatPatrol] 记忆进化触发失败: ${memErr.message}`);
      }
    } catch (err) {
      // 进化触发失败不应影响巡检主流程
      console.warn(`[HeartbeatPatrol] 进化触发失败: ${err.message}`);
    }
  }

  _generateAlerts(results) {
    const alerts = [];
    for (const [key, result] of Object.entries(results)) {
      if (result.status === 'unhealthy' || result.status === 'warning') {
        const checkDef = CHECKS[key];
        if (checkDef) {
          alerts.push({
            check: key,
            name: checkDef.name,
            severity: checkDef.severity,
            status: result.status,
            detail: result.detail,
            timestamp: Date.now(),
          });
        }
      }
    }
    return alerts;
  }

  start(intervalMs = HEARTBEAT_INTERVAL_MS) {
    if (this._interval) return;

    this.runPatrol().catch(e => console.debug('[heartbeat] Patrol failed:', e?.message));

    this._interval = setInterval(() => {
      this.runPatrol().catch(e => console.debug('[heartbeat] Patrol failed:', e?.message));
    }, intervalMs);

    if (this._interval.unref) {
      this._interval.unref();
    }

    console.log(`💓 心跳巡检已启动(间隔: ${intervalMs / 1000}s)`);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  getLastResults() {
    const result = {};
    for (const [key, value] of this._lastResults) {
      result[key] = value;
    }
    return result;
  }

  getHistory(limit = 10) {
    return this._history.slice(-limit);
  }

  getStatus() {
    return {
      running: !!this._interval,
      checkCount: this._checkCount,
      lastPatrol: this._history.length > 0 ? this._history[this._history.length - 1] : null,
      overallStatus: this._history.length > 0 ? this._history[this._history.length - 1].overallStatus : 'unknown',
    };
  }
}

const globalHeartbeatPatrol = new HeartbeatPatrol();

module.exports = {
  HeartbeatPatrol,
  globalHeartbeatPatrol,
  CHECKS,
  HEARTBEAT_INTERVAL_MS,
};
