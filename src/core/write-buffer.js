const fs = require('fs');
const path = require('path');

class WriteBuffer {
  constructor(filePath, { flushIntervalMs = 5000, maxBufferSize = 50 } = {}) {
    this._filePath = filePath;
    this._flushIntervalMs = flushIntervalMs;
    this._maxBufferSize = maxBufferSize;
    this._buffer = [];
    this._dirty = false;
    this._timer = null;
    this._currentData = null;
    this._writeCount = 0;
  }

  write(data) {
    this._currentData = data;
    this._dirty = true;
    this._writeCount++;

    if (this._writeCount >= this._maxBufferSize) {
      this.flush();
      return;
    }

    if (!this._timer) {
      this._timer = setTimeout(() => {
        this._timer = null;
        this.flush();
      }, this._flushIntervalMs);
      if (this._timer.unref) this._timer.unref();
    }
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    if (!this._dirty || this._currentData === null) return;

    try {
      const dir = path.dirname(this._filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this._filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._currentData, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._filePath);
      this._dirty = false;
      this._writeCount = 0;
    } catch (e) {
      console.error(`WriteBuffer flush 失败 (${this._filePath}):`, e.message);
    }
  }

  read() {
    try {
      if (fs.existsSync(this._filePath)) {
        return JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
      }
    } catch (e) {
      console.error(`WriteBuffer read 失败 (${this._filePath}):`, e.message);
    }
    return null;
  }

  destroy() {
    this.flush();
  }
}

const PRIORITY_HIGH = 0;
const PRIORITY_NORMAL = 1;
const PRIORITY_LOW = 2;

class HighFrequencyWriteBuffer {
  constructor(filePath, opts = {}) {
    this._filePath = filePath;
    this._flushIntervalMs = opts.flushIntervalMs || 2000;
    this._maxBatchSize = opts.maxBatchSize || 100;
    this._maxMemoryBytes = opts.maxMemoryBytes || 10 * 1024 * 1024;
    this._backpressureThreshold = opts.backpressureThreshold || 500;
    this._queues = {
      [PRIORITY_HIGH]: [],
      [PRIORITY_NORMAL]: [],
      [PRIORITY_LOW]: [],
    };
    this._currentData = null;
    this._dirty = false;
    this._timer = null;
    this._totalEnqueued = 0;
    this._totalFlushed = 0;
    this._estimatedBytes = 0;
    this._flushing = false;
    this._mergeFn = opts.mergeFn || null;
    this._onBackpressure = opts.onBackpressure || null;
  }

  enqueue(data, priority = PRIORITY_NORMAL) {
    const entry = { data, priority, enqueuedAt: Date.now(), size: this._estimateSize(data) };

    this._queues[priority].push(entry);
    this._totalEnqueued++;
    this._estimatedBytes += entry.size;

    if (this._estimatedBytes >= this._maxMemoryBytes || this._totalEnqueued >= this._backpressureThreshold) {
      if (this._onBackpressure) {
        this._onBackpressure({
          enqueued: this._totalEnqueued,
          estimatedBytes: this._estimatedBytes,
          threshold: this._backpressureThreshold,
        });
      }
      this._flushNow();
      return;
    }

    this._scheduleFlush();
  }

  write(data) {
    this._currentData = data;
    this._dirty = true;
    this._scheduleFlush();
  }

  forceFlush() {
    this._flushNow();
  }

  flush() {
    this._flushNow();
  }

  read() {
    try {
      if (fs.existsSync(this._filePath)) {
        return JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
      }
    } catch (e) {
      console.error(`HighFrequencyWriteBuffer read 失败 (${this._filePath}):`, e.message);
    }
    return null;
  }

  destroy() {
    this._flushNow();
  }

  getStats() {
    return {
      filePath: this._filePath,
      enqueued: this._totalEnqueued,
      flushed: this._totalFlushed,
      pendingHigh: this._queues[PRIORITY_HIGH].length,
      pendingNormal: this._queues[PRIORITY_NORMAL].length,
      pendingLow: this._queues[PRIORITY_LOW].length,
      estimatedBytes: this._estimatedBytes,
      dirty: this._dirty,
    };
  }

  _scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flushNow();
    }, this._flushIntervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  _flushNow() {
    if (this._flushing) return;
    this._flushing = true;

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    const batch = this._drainQueues();

    try {
      let dataToWrite = this._currentData;

      if (batch.length > 0) {
        if (this._mergeFn) {
          dataToWrite = this._mergeFn(dataToWrite, batch);
        } else {
          dataToWrite = this._mergeBatchDefault(dataToWrite, batch);
        }
        this._totalFlushed += batch.length;
      }

      if (dataToWrite !== null && (this._dirty || batch.length > 0)) {
        const dir = path.dirname(this._filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = this._filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(dataToWrite, null, 2), 'utf-8');
        fs.renameSync(tmpPath, this._filePath);
        this._currentData = dataToWrite;
        this._dirty = false;
      }
    } catch (e) {
      console.error(`HighFrequencyWriteBuffer flush 失败 (${this._filePath}):`, e.message);
    } finally {
      this._flushing = false;
    }
  }

  _drainQueues() {
    const batch = [];

    for (const priority of [PRIORITY_HIGH, PRIORITY_NORMAL, PRIORITY_LOW]) {
      const queue = this._queues[priority];
      while (queue.length > 0 && batch.length < this._maxBatchSize) {
        const entry = queue.shift();
        batch.push(entry.data);
        this._estimatedBytes -= entry.size;
      }
    }

    this._totalEnqueued -= batch.length;
    return batch;
  }

  _mergeBatchDefault(currentData, batch) {
    if (!currentData) return batch.length === 1 ? batch[0] : batch;
    if (Array.isArray(currentData)) return [...currentData, ...batch];
    if (typeof currentData === 'object') {
      return { ...currentData, _batch: batch, _batchAt: Date.now() };
    }
    return currentData;
  }

  _estimateSize(data) {
    try {
      return JSON.stringify(data).length * 2;
    } catch {
      return 1024;
    }
  }
}

class WriteBufferManager {
  constructor() {
    this._buffers = new Map();
    this._hfBuffers = new Map();
  }

  getBuffer(filePath, options) {
    if (!this._buffers.has(filePath)) {
      this._buffers.set(filePath, new WriteBuffer(filePath, options));
    }
    return this._buffers.get(filePath);
  }

  getHighFrequencyBuffer(filePath, options) {
    if (!this._hfBuffers.has(filePath)) {
      this._hfBuffers.set(filePath, new HighFrequencyWriteBuffer(filePath, options));
    }
    return this._hfBuffers.get(filePath);
  }

  flushAll() {
    for (const buffer of this._buffers.values()) {
      buffer.flush();
    }
    for (const buffer of this._hfBuffers.values()) {
      buffer.flush();
    }
  }

  destroyAll() {
    for (const buffer of this._buffers.values()) {
      buffer.destroy();
    }
    for (const buffer of this._hfBuffers.values()) {
      buffer.destroy();
    }
    this._buffers.clear();
    this._hfBuffers.clear();
  }

  getStats() {
    const stats = {
      normalBuffers: this._buffers.size,
      hfBuffers: this._hfBuffers.size,
      hfDetails: {},
    };
    for (const [path, buf] of this._hfBuffers) {
      stats.hfDetails[path] = buf.getStats();
    }
    return stats;
  }
}

const globalWriteBufferManager = new WriteBufferManager();

module.exports = {
  WriteBuffer,
  HighFrequencyWriteBuffer,
  WriteBufferManager,
  globalWriteBufferManager,
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  PRIORITY_LOW,
};
