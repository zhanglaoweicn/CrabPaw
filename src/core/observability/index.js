const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DATA_DIR } = require('../config');

const LOG_LEVELS = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
};

const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const FLUSH_INTERVAL_MS = 5000;

class StructuredLogger extends EventEmitter {
  constructor(config = {}) {
    super();
    this._level = config.level ?? LOG_LEVELS.INFO;
    this._module = config.module || 'core';
    this._logDir = config.logDir || LOG_DIR;
    this._maxFileSize = config.maxFileSize || MAX_LOG_FILE_SIZE;
    this._maxFiles = config.maxFiles || MAX_LOG_FILES;
    this._consoleEnabled = config.consoleEnabled !== false;
    this._fileEnabled = config.fileEnabled !== false;
    this._structuredConsole = config.structuredConsole || false;
    this._buffer = [];
    this._flushTimer = null;
    this._currentFile = null;
    this._currentSize = 0;
    this._hostname = os.hostname();
    this._pid = process.pid;
    this._startTime = Date.now();

    this._counters = {
      trace: 0, debug: 0, info: 0, warn: 0, error: 0, fatal: 0,
    };

    if (this._fileEnabled) {
      this._ensureLogDir();
      this._rotateIfNeeded();
      this._flushTimer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
      if (this._flushTimer.unref) this._flushTimer.unref();
    }
  }

  _ensureLogDir() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  _rotateIfNeeded() {
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `crabpaw-${dateStr}.log`;
    const filePath = path.join(this._logDir, filename);

    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      this._currentSize = stat.size;
      if (stat.size >= this._maxFileSize) {
        const rotatedName = `crabpaw-${dateStr}-${Date.now()}.log`;
        fs.renameSync(filePath, path.join(this._logDir, rotatedName));
        this._currentSize = 0;
        this._cleanupOldFiles();
      }
    }

    this._currentFile = filePath;
  }

  _cleanupOldFiles() {
    try {
      const files = fs.readdirSync(this._logDir)
        .filter(f => f.startsWith('crabpaw-') && f.endsWith('.log'))
        .map(f => ({ name: f, path: path.join(this._logDir, f), mtime: fs.statSync(path.join(this._logDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);

      for (let i = this._maxFiles; i < files.length; i++) {
        fs.unlinkSync(files[i].path);
      }
    } catch (e) { console.warn('[observability] log rotation failed:', e.message); }
  }

  trace(message, data = {}) {
    this._log(LOG_LEVELS.TRACE, message, data);
  }

  debug(message, data = {}) {
    this._log(LOG_LEVELS.DEBUG, message, data);
  }

  info(message, data = {}) {
    this._log(LOG_LEVELS.INFO, message, data);
  }

  warn(message, data = {}) {
    this._log(LOG_LEVELS.WARN, message, data);
  }

  error(message, data = {}) {
    this._log(LOG_LEVELS.ERROR, message, data);
  }

  fatal(message, data = {}) {
    this._log(LOG_LEVELS.FATAL, message, data);
  }

  child(module) {
    const childLogger = new StructuredLogger({
      level: this._level,
      module: `${this._module}:${module}`,
      logDir: this._logDir,
      maxFileSize: this._maxFileSize,
      maxFiles: this._maxFiles,
      consoleEnabled: this._consoleEnabled,
      fileEnabled: this._fileEnabled,
      structuredConsole: this._structuredConsole,
    });
    childLogger._currentFile = this._currentFile;
    childLogger._currentSize = this._currentSize;
    return childLogger;
  }

  _log(level, message, data) {
    if (level < this._level) return;

    this._counters[LEVEL_NAMES[level].toLowerCase()]++;

    const entry = {
      timestamp: new Date().toISOString(),
      level: LEVEL_NAMES[level],
      module: this._module,
      message,
      hostname: this._hostname,
      pid: this._pid,
      uptime: ((Date.now() - this._startTime) / 1000).toFixed(1) + 's',
    };

    if (Object.keys(data).length > 0) {
      entry.data = data;
    }

    if (data.error instanceof Error) {
      entry.error = {
        name: data.error.name,
        message: data.error.message,
        stack: data.error.stack,
      };
      delete entry.data.error;
    }

    if (this._consoleEnabled) {
      this._consoleOutput(entry);
    }

    if (this._fileEnabled) {
      this._buffer.push(JSON.stringify(entry) + '\n');
      if (this._buffer.length >= 100) {
        this._flush();
      }
    }

    // 2026-08-15 P0 修复: 不得 emit 裸 'error'——Node EventEmitter 在无 error
    // 监听器时会把 entry 当未捕获异常抛出(实测 cloud-asr 火山引擎超时路径
    // log.error 直接砸出 ERR_UNHANDLED_ERROR 崩溃)。改用 log: 前缀命名空间,
    // 全库无订阅者(已 grep 证实), 事件语义不变。
    if (level >= LOG_LEVELS.ERROR) {
      this.emit('log:error', entry);
    } else if (level >= LOG_LEVELS.WARN) {
      this.emit('log:warning', entry);
    }
  }

  _consoleOutput(entry) {
    if (this._structuredConsole) {
      console.log(JSON.stringify(entry));
      return;
    }

    const levelColor = {
      TRACE: '\x1b[90m',
      DEBUG: '\x1b[36m',
      INFO: '\x1b[32m',
      WARN: '\x1b[33m',
      ERROR: '\x1b[31m',
      FATAL: '\x1b[35m\x1b[1m',
    };

    const reset = '\x1b[0m';
    const color = levelColor[entry.level] || '';
    const moduleTag = entry.module ? `[${entry.module}]` : '';
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    const errorStr = entry.error ? ` ERROR: ${entry.error.message}` : '';

    console.log(`${color}${entry.level}${reset} ${entry.timestamp.slice(11, 19)} ${moduleTag} ${entry.message}${dataStr}${errorStr}`);
  }

  _flush() {
    if (!this._fileEnabled || this._buffer.length === 0) return;

    const content = this._buffer.join('');
    this._buffer = [];

    try {
      fs.appendFileSync(this._currentFile, content);
      this._currentSize += Buffer.byteLength(content, 'utf-8');

      if (this._currentSize >= this._maxFileSize) {
        this._rotateIfNeeded();
      }
    } catch (e) { console.warn('[observability] flush failed:', e.message); }
  }

  close() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    this._flush();
  }

  getStats() {
    return {
      level: LEVEL_NAMES[this._level],
      module: this._module,
      counters: { ...this._counters },
      bufferSize: this._buffer.length,
      currentFile: this._currentFile,
      currentSize: this._currentSize,
    };
  }

  setLevel(level) {
    if (typeof level === 'string') {
      this._level = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
    } else {
      this._level = level;
    }
  }
}

class MetricsCollector extends EventEmitter {
  constructor(config = {}) {
    super();
    this._counters = new Map();
    this._gauges = new Map();
    this._histograms = new Map();
    this._timers = new Map();
    this._logger = config.logger || null;
    this._exportInterval = config.exportInterval || 60000;
    this._exportTimer = null;
  }

  increment(name, value = 1, tags = {}) {
    const key = this._metricKey(name, tags);
    this._counters.set(key, (this._counters.get(key) || 0) + value);
  }

  decrement(name, value = 1, tags = {}) {
    this.increment(name, -value, tags);
  }

  gauge(name, value, tags = {}) {
    const key = this._metricKey(name, tags);
    this._gauges.set(key, value);
  }

  histogram(name, value, tags = {}) {
    const key = this._metricKey(name, tags);
    if (!this._histograms.has(key)) {
      this._histograms.set(key, { values: [], count: 0, sum: 0, min: Infinity, max: -Infinity });
    }
    const h = this._histograms.get(key);
    h.values.push(value);
    h.count++;
    h.sum += value;
    h.min = Math.min(h.min, value);
    h.max = Math.max(h.max, value);
    if (h.values.length > 1000) h.values = h.values.slice(-500);
  }

  startTimer(name, tags = {}) {
    const key = this._metricKey(name, tags);
    this._timers.set(key, Date.now());
    return () => {
      const start = this._timers.get(key);
      if (start) {
        const duration = Date.now() - start;
        this.histogram(name, duration, tags);
        this._timers.delete(key);
        return duration;
      }
      return 0;
    };
  }

  getCounter(name, tags = {}) {
    return this._counters.get(this._metricKey(name, tags)) || 0;
  }

  getGauge(name, tags = {}) {
    return this._gauges.get(this._metricKey(name, tags)) || 0;
  }

  getHistogram(name, tags = {}) {
    const key = this._metricKey(name, tags);
    const h = this._histograms.get(key);
    if (!h) return null;

    const sorted = [...h.values].sort((a, b) => a - b);
    return {
      count: h.count,
      sum: h.sum,
      avg: h.count > 0 ? h.sum / h.count : 0,
      min: h.min === Infinity ? 0 : h.min,
      max: h.max === -Infinity ? 0 : h.max,
      p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
      p90: sorted[Math.floor(sorted.length * 0.9)] || 0,
      p99: sorted[Math.floor(sorted.length * 0.99)] || 0,
    };
  }

  getAllMetrics() {
    const result = {
      counters: Object.fromEntries(this._counters),
      gauges: Object.fromEntries(this._gauges),
      histograms: {},
    };

    // eslint-disable-next-line no-unused-vars
    for (const [key, h] of this._histograms) {
      result.histograms[key] = this.getHistogram(key);
    }

    return result;
  }

  reset() {
    this._counters.clear();
    this._gauges.clear();
    this._histograms.clear();
    this._timers.clear();
  }

  _metricKey(name, tags) {
    const tagStr = Object.entries(tags).sort().map(([k, v]) => `${k}=${v}`).join(',');
    return tagStr ? `${name}{${tagStr}}` : name;
  }
}

class HealthChecker extends EventEmitter {
  constructor(config = {}) {
    super();
    this._checks = new Map();
    this._results = new Map();
    this._logger = config.logger || null;
    this._checkInterval = config.checkInterval || 30000;
    this._checkTimer = null;
  }

  registerCheck(name, checkFn, config = {}) {
    this._checks.set(name, {
      fn: checkFn,
      critical: config.critical || false,
      timeout: config.timeout || 5000,
      lastResult: null,
      lastCheck: 0,
    });
  }

  unregisterCheck(name) {
    this._checks.delete(name);
    this._results.delete(name);
  }

  async runCheck(name) {
    const check = this._checks.get(name);
    if (!check) return { status: 'unknown', error: 'Check not found' };

    try {
      const result = await Promise.race([
        check.fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), check.timeout)
        ),
      ]);

      check.lastResult = { status: 'healthy', ...result, timestamp: Date.now() };
      check.lastCheck = Date.now();
      this._results.set(name, check.lastResult);

      return check.lastResult;
    } catch (e) {
      check.lastResult = { status: 'unhealthy', error: e.message, timestamp: Date.now() };
      check.lastCheck = Date.now();
      this._results.set(name, check.lastResult);

      this.emit('check:unhealthy', { name, error: e.message, critical: check.critical });
      return check.lastResult;
    }
  }

  async runAllChecks() {
    const results = {};
    for (const name of this._checks.keys()) {
      results[name] = await this.runCheck(name);
    }

    const overall = Object.values(results).every(r => r.status === 'healthy')
      ? 'healthy'
      : 'degraded';

    const criticalFailures = Object.entries(results)
      .filter(([name, r]) => r.status !== 'healthy' && this._checks.get(name)?.critical)
      .map(([name]) => name);

    return {
      status: criticalFailures.length > 0 ? 'critical' : overall,
      checks: results,
      criticalFailures,
      timestamp: Date.now(),
    };
  }

  start() {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(async () => {
      const result = await this.runAllChecks();
      this.emit('health:checked', result);
    }, this._checkInterval);
    if (this._checkTimer.unref) this._checkTimer.unref();
  }

  stop() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  getResults() {
    return Object.fromEntries(this._results);
  }
}

let _loggerInstance = null;
let _metricsInstance = null;
let _healthInstance = null;

function getLogger(config) {
  if (!_loggerInstance) {
    _loggerInstance = new StructuredLogger(config);
  }
  return _loggerInstance;
}

function getMetricsCollector(config) {
  if (!_metricsInstance) {
    _metricsInstance = new MetricsCollector(config);
  }
  return _metricsInstance;
}

function getHealthChecker(config) {
  if (!_healthInstance) {
    _healthInstance = new HealthChecker(config);
  }
  return _healthInstance;
}

module.exports = {
  StructuredLogger,
  MetricsCollector,
  HealthChecker,
  LOG_LEVELS,
  LEVEL_NAMES,
  getLogger,
  getMetricsCollector,
  getHealthChecker,
};
