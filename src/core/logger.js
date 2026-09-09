const fs = require('fs');
const path = require('path');
const { getCorrelationId } = require('./correlation-id');

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  VERBOSE: 4
};

class Logger {
  constructor(options = {}) {
    this.level = options.level || (process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG');
    this.logFile = options.logFile || path.join(process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', 'data', '.crabpaw'), 'crabpaw.log');
    this.enableConsole = options.enableConsole !== false;
    this.enableFile = options.enableFile !== false;
    this.prefix = options.prefix || 'CrabPaw';
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.logBuffer = [];
    this.flushInterval = null;
    
    if (this.enableFile) {
      this._ensureLogDir();
      this._startFlushInterval();
    }
    
    process.on('exit', () => this._flush());
    process.on('SIGINT', () => this._flush());
    process.on('SIGTERM', () => this._flush());
  }

  _ensureLogDir() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const cid = getCorrelationId();
    const cidPart = cid ? ` [cid:${cid}]` : '';
    const prefix = `[${timestamp}] [${level}] [${this.prefix}]${cidPart}`;
    const formattedMessage = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
    
    let logLine = `${prefix} ${formattedMessage}`;
    
    if (Object.keys(meta).length > 0) {
      logLine += ` | ${JSON.stringify(meta)}`;
    }
    
    return logLine;
  }

  _write(level, message, meta = {}) {
    if (!this._shouldLog(level)) return;

    const formattedMessage = this._formatMessage(level, message, meta);
    
    if (this.enableConsole) {
      const consoleMethod = level === 'ERROR' ? 'error' : 
                           level === 'WARN' ? 'warn' : 
                           level === 'DEBUG' ? 'debug' : 'log';
      try { console[consoleMethod](formattedMessage); } catch (_) {
        /* pipe broken, swallow */
        console.warn('[logger.js] 空 catch 补日志:', _ && _.message);
      }

    }
    
    if (this.enableFile) {
      this.logBuffer.push(formattedMessage + '\n');
      
      if (this.logBuffer.length >= 10) {
        this._flush();
      }
    }
  }

  _flush() {
    if (this.logBuffer.length === 0) return;
    
    try {
      const content = this.logBuffer.join('');
      fs.appendFileSync(this.logFile, content, 'utf-8');
      this.logBuffer = [];
      
      this._rotateIfNeeded();
    } catch (error) {
      console.error('Failed to flush logs:', error.message);
    }
  }

  _rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.logFile)) return;
      
      const stats = fs.statSync(this.logFile);
      if (stats.size > this.maxFileSize) {
        // 轮换：.1 -> .2, .2 -> .3, ... 最多保留5个备份
        for (let i = 5; i >= 1; i--) {
          const oldPath = `${this.logFile}.${i}`;
          if (fs.existsSync(oldPath)) {
            if (i === 5) {
              fs.unlinkSync(oldPath);
            } else {
              fs.renameSync(oldPath, `${this.logFile}.${i + 1}`);
            }
          }
        }
        
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch (error) {
      console.error('Log rotation failed:', error.message);
    }
  }

  _startFlushInterval() {
    this.flushInterval = setInterval(() => this._flush(), 5000);
    this.flushInterval.unref();
  }

  error(message, meta = {}) {
    this._write('ERROR', message, meta);
  }

  warn(message, meta = {}) {
    this._write('WARN', message, meta);
  }

  info(message, meta = {}) {
    this._write('INFO', message, meta);
  }

  debug(message, meta = {}) {
    this._write('DEBUG', message, meta);
  }

  verbose(message, meta = {}) {
    this._write('VERBOSE', message, meta);
  }

  child(childPrefix) {
    return new Logger({
      level: this.level,
      logFile: this.logFile,
      enableConsole: this.enableConsole,
      enableFile: this.enableFile,
      prefix: `${this.prefix}:${childPrefix}`
    });
  }

  destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    this._flush();
  }
}

let defaultLogger = null;

function getLogger(prefix) {
  if (!defaultLogger) {
    defaultLogger = new Logger({ prefix: 'CrabPaw' });
  }
  
  return prefix ? defaultLogger.child(prefix) : defaultLogger;
}

function configureLogger(options) {
  if (defaultLogger) {
    defaultLogger.destroy();
  }
  defaultLogger = new Logger(options);
}

module.exports = {
  Logger,
  getLogger,
  configureLogger,
  LOG_LEVELS
};
