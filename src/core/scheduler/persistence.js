const fs = require('fs');
const path = require('path');

const DEFAULT_DB_PATH = 'cron-jobs.json';

class CronPersistence {
  constructor(config = {}) {
    this._dataDir = config.dataDir || '';
    this._dbPath = path.join(this._dataDir || '.', DEFAULT_DB_PATH);
    this._jobs = new Map();
    this._executionLog = [];
    this._maxLogEntries = config.maxLogEntries || 1000;
  }

  load() {
    try {
      if (!fs.existsSync(this._dbPath)) {
        return false;
      }

      const data = JSON.parse(fs.readFileSync(this._dbPath, 'utf-8'));

      if (data.jobs) {
        for (const job of data.jobs) {
          this._jobs.set(job.id, job);
        }
      }

      if (data.executionLog) {
        this._executionLog = data.executionLog.slice(-this._maxLogEntries);
      }

      console.log(`📋 Cron持久化数据已加载: ${this._jobs.size} 个任务, ${this._executionLog.length} 条日志`);
      return true;
    } catch (e) {
      console.error('❌ Cron持久化数据加载失败:', e.message);
      return false;
    }
  }

  save() {
    try {
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        jobs: Array.from(this._jobs.values()),
        executionLog: this._executionLog.slice(-this._maxLogEntries),
      };

      fs.writeFileSync(this._dbPath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (e) {
      console.error('❌ Cron持久化数据保存失败:', e.message);
      return false;
    }
  }

  saveJob(job) {
    this._jobs.set(job.id, {
      ...job,
      updatedAt: Date.now(),
    });
    this.save();
  }

  removeJob(jobId) {
    const deleted = this._jobs.delete(jobId);
    if (deleted) this.save();
    return deleted;
  }

  getJob(jobId) {
    return this._jobs.get(jobId) || null;
  }

  getAllJobs() {
    return Array.from(this._jobs.values());
  }

  getEnabledJobs() {
    return Array.from(this._jobs.values()).filter(j => j.enabled !== false);
  }

  addExecutionLog(entry) {
    this._executionLog.push({
      ...entry,
      timestamp: entry.timestamp || Date.now(),
    });

    if (this._executionLog.length > this._maxLogEntries) {
      this._executionLog = this._executionLog.slice(-this._maxLogEntries);
    }

    this.save();
  }

  getExecutionLog(jobId, limit = 50) {
    const logs = jobId
      ? this._executionLog.filter(l => l.jobId === jobId)
      : this._executionLog;
    return logs.slice(-limit);
  }

  getNextRunTime(jobId) {
    const job = this._jobs.get(jobId);
    if (!job || !job.enabled) return null;
    return job.nextRunTime || null;
  }

  updateNextRunTime(jobId, nextRunTime) {
    const job = this._jobs.get(jobId);
    if (job) {
      job.nextRunTime = nextRunTime;
      this.save();
    }
  }
}

module.exports = { CronPersistence };
