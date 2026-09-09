const crypto = require('crypto');
const EventEmitter = require('events');

const RUN_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout'
};

const MULTITASK_STRATEGY = {
  REJECT: 'reject',
  INTERRUPT: 'interrupt',
  ROLLBACK: 'rollback',
  PARALLEL: 'parallel'
};

class ResourceLock {
  constructor(resourceId, timeout = 30000) {
    this.resourceId = resourceId;
    this.timeout = timeout;
    this.acquiredAt = null;
    this.acquiredBy = null;
    this._released = false;
    this._timer = null;
  }

  acquire(runId) {
    return new Promise((resolve, reject) => {
      this.acquiredAt = Date.now();
      this.acquiredBy = runId;
      
      this._timer = setTimeout(() => {
        if (!this._released) {
          reject(new Error(`锁超时: ${this.resourceId}`));
        }
      }, this.timeout);
      
      resolve();
    });
  }

  release() {
    this._released = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.acquiredBy = null;
  }

  isExpired() {
    return this.acquiredAt && (Date.now() - this.acquiredAt > this.timeout);
  }
}

class RunRecord {
  constructor(runId, threadId, task, options = {}) {
    this.runId = runId;
    this.threadId = threadId;
    this.task = task;
    this.status = RUN_STATUS.PENDING;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.result = null;
    this.error = null;
    this.abortController = new AbortController();
    this.resourceId = options.resourceId || threadId;
    this.priority = options.priority || 0;
    this.timeout = options.timeout || 60000;
  }

  start() {
    this.status = RUN_STATUS.RUNNING;
    this.startedAt = Date.now();
  }

  complete(result) {
    this.status = RUN_STATUS.COMPLETED;
    this.result = result;
    this.completedAt = Date.now();
  }

  fail(error) {
    this.status = RUN_STATUS.FAILED;
    this.error = error;
    this.completedAt = Date.now();
  }

  cancel(reason = '用户取消') {
    this.status = RUN_STATUS.CANCELLED;
    this.error = new Error(reason);
    this.completedAt = Date.now();
    this.abortController.abort(reason);
  }

  markTimedOut() {
    this.status = RUN_STATUS.TIMEOUT;
    this.error = new Error(`任务执行超时 (${this.timeout}ms)`);
    this.completedAt = Date.now();
    this.abortController.abort('超时');
  }

  getDuration() {
    if (!this.startedAt) return 0;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }

  isTerminal() {
    return [RUN_STATUS.COMPLETED, RUN_STATUS.FAILED, RUN_STATUS.CANCELLED, RUN_STATUS.TIMEOUT].includes(this.status);
  }
}

class RunManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this._runs = new Map();
    this._locks = new Map();
    this._queue = [];
    this._processing = false;
    this._maxConcurrent = options.maxConcurrent || 5;
    this._lockTimeout = options.lockTimeout || 30000;
    this._cleanupInterval = options.cleanupInterval || 60000;
    this._cleanupTimer = null;
  }

  start() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._cleanup(), this._cleanupInterval);
  }

  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._runs.forEach(run => {
      if (run.status === RUN_STATUS.RUNNING) {
        run.cancel('RunManager 停止');
      }
    });
  }

  async acquireLock(resourceId, runId, timeout) {
    const lockTimeout = timeout || this._lockTimeout;
    
    const existingLock = this._locks.get(resourceId);
    if (existingLock && !existingLock._released && !existingLock.isExpired()) {
      return {
        acquired: false,
        reason: `资源 ${resourceId} 已被 ${existingLock.acquiredBy} 锁定`
      };
    }
    
    if (existingLock) {
      existingLock.release();
      this._locks.delete(resourceId);
    }
    
    const lock = new ResourceLock(resourceId, lockTimeout);
    await lock.acquire(runId);
    this._locks.set(resourceId, lock);
    
    return { acquired: true, lock };
  }

  releaseLock(resourceId) {
    const lock = this._locks.get(resourceId);
    if (lock) {
      lock.release();
      this._locks.delete(resourceId);
    }
  }

  async createOrReject(threadId, task, options = {}) {
    const strategy = options.multitaskStrategy || MULTITASK_STRATEGY.REJECT;
    const resourceId = options.resourceId || threadId;
    
    const inflight = this.getInflightRuns(threadId);
    
    if (inflight.length > 0) {
      switch (strategy) {
        case MULTITASK_STRATEGY.REJECT:
          throw new ConflictError(`线程 ${threadId} 已有正在执行的任务`);
        
        case MULTITASK_STRATEGY.INTERRUPT:
          for (const run of inflight) {
            run.cancel('新任务启动，中断旧任务');
            this.emit('run:interrupted', run);
          }
          break;
        
        case MULTITASK_STRATEGY.ROLLBACK:
          for (const run of inflight) {
            run.cancel('新任务启动，回滚旧任务');
            this.emit('run:rollback', run);
          }
          break;
        
        case MULTITASK_STRATEGY.PARALLEL:
          break;
      }
    }
    
    const runId = this._generateRunId();
    const run = new RunRecord(runId, threadId, task, { ...options, resourceId });
    this._runs.set(runId, run);
    this.emit('run:created', run);
    
    return run;
  }

  async execute(threadId, task, options = {}) {
    const run = await this.createOrReject(threadId, task, options);
    const resourceId = run.resourceId;
    
    const lockResult = await this.acquireLock(resourceId, run.runId, run.timeout);
    if (!lockResult.acquired) {
      run.fail(new Error(lockResult.reason));
      return run;
    }
    
    const signal = run.abortController.signal;
    let timeoutId = null;
    
    try {
      run.start();
      this.emit('run:started', run);
      
      const executePromise = Promise.resolve().then(() => {
        if (signal.aborted) {
          throw new Error('任务已取消');
        }
        return task(signal);
      });
      
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          run.markTimedOut();
          reject(new Error(`任务执行超时 (${run.timeout}ms)`));
        }, run.timeout);
      });
      
      const result = await Promise.race([executePromise, timeoutPromise]);
      
      clearTimeout(timeoutId);
      run.complete(result);
      this.emit('run:completed', run);
      
      return run;
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (run.status !== RUN_STATUS.CANCELLED && run.status !== RUN_STATUS.TIMEOUT) {
        run.fail(error);
      }
      this.emit('run:failed', run);
      
      return run;
      
    } finally {
      this.releaseLock(resourceId);
    }
  }

  async enqueue(threadId, task, options = {}) {
    const run = await this.createOrReject(threadId, task, {
      ...options,
      multitaskStrategy: MULTITASK_STRATEGY.PARALLEL
    });
    
    this._queue.push(run);
    this._queue.sort((a, b) => b.priority - a.priority);
    
    this._processQueue();
    
    return run;
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;
    
    while (this._queue.length > 0) {
      const runningCount = Array.from(this._runs.values())
        .filter(r => r.status === RUN_STATUS.RUNNING).length;
      
      if (runningCount >= this._maxConcurrent) {
        break;
      }
      
      const run = this._queue.shift();
      if (run.status !== RUN_STATUS.PENDING) continue;
      
      this.execute(run.threadId, run.task, {
        resourceId: run.resourceId,
        timeout: run.timeout,
        multitaskStrategy: MULTITASK_STRATEGY.PARALLEL
      });
    }
    
    this._processing = false;
  }

  cancel(runId, reason = '用户取消') {
    const run = this._runs.get(runId);
    if (run && !run.isTerminal()) {
      run.cancel(reason);
      this.releaseLock(run.resourceId);
      this.emit('run:cancelled', run);
      return true;
    }
    return false;
  }

  cancelByThread(threadId, reason = '用户取消') {
    const runs = this.getRunsByThread(threadId);
    let cancelled = 0;
    for (const run of runs) {
      if (this.cancel(run.runId, reason)) {
        cancelled++;
      }
    }
    return cancelled;
  }

  getRun(runId) {
    return this._runs.get(runId);
  }

  getRunsByThread(threadId) {
    return Array.from(this._runs.values()).filter(r => r.threadId === threadId);
  }

  getInflightRuns(threadId) {
    return this.getRunsByThread(threadId).filter(r => r.status === RUN_STATUS.RUNNING);
  }

  getStats() {
    const runs = Array.from(this._runs.values());
    return {
      total: runs.length,
      pending: runs.filter(r => r.status === RUN_STATUS.PENDING).length,
      running: runs.filter(r => r.status === RUN_STATUS.RUNNING).length,
      completed: runs.filter(r => r.status === RUN_STATUS.COMPLETED).length,
      failed: runs.filter(r => r.status === RUN_STATUS.FAILED).length,
      cancelled: runs.filter(r => r.status === RUN_STATUS.CANCELLED).length,
      queued: this._queue.length,
      locks: this._locks.size
    };
  }

  _cleanup() {
    const maxAge = 3600000;
    const now = Date.now();
    
    for (const [runId, run] of this._runs) {
      if (run.isTerminal() && (now - run.completedAt > maxAge)) {
        this._runs.delete(runId);
      }
    }
    
    for (const [resourceId, lock] of this._locks) {
      if (lock._released || lock.isExpired()) {
        this._locks.delete(resourceId);
      }
    }
  }

  _generateRunId() {
    return `run_${Date.now()}_${crypto.randomBytes(5).toString("hex").slice(0, 9)}`;
  }
}

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

const globalRunManager = new RunManager();

module.exports = {
  RunManager,
  RunRecord,
  ResourceLock,
  ConflictError,
  TimeoutError,
  RUN_STATUS,
  MULTITASK_STRATEGY,
  globalRunManager
};
