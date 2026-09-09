'use strict';

/**
 * software-jobs.js — 软件安装后台 job 管理器
 *
 * 设计参考 10.5 install_software 思路:
 * - winget/choco/scoop 后台安装
 * - 每个 job 跟踪状态: queued → running → succeeded/failed/cancelled
 * - 通过 EventEmitter 广播进度
 * - 支持按用户/jobsId 查找
 * - 历史保留最近 200 条
 */

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

// ---------------------------------------------------------------------------
// SoftwareJob — 单个安装 job
// ---------------------------------------------------------------------------

const JOB_STATUS = {
 QUEUED: 'queued',
 RUNNING: 'running',
 SUCCEEDED: 'succeeded',
 FAILED: 'failed',
 CANCELLED: 'cancelled',
};

class SoftwareJob {
 /**
 * @param {object} options
 * @param {string} options.manager winget/choco/scoop
 * @param {string} options.action install/uninstall
 * @param {string} options.packageId
 * @param {string} [options.packageName]
 * @param {string} [options.userId]
 * @param {string} [options.sessionId]
 */
 constructor(options) {
 this.id = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
 this.manager = options.manager;
 this.action = options.action || 'install';
 this.packageId = options.packageId;
 this.packageName = options.packageName || options.packageId;
 this.userId = options.userId || 'system';
 this.sessionId = options.sessionId || null;

 this.status = JOB_STATUS.QUEUED;
 this.progress = 0; // 0-100
 this.message = '等待开始...';
 this.stdout = '';
 this.stderr = '';
 this.exitCode = null;
 this.startedAt = null;
 this.finishedAt = null;
 this.error = null;
 this.sceneCardId = null; // 关联的 scene 卡片 ID
 }

 toJSON() {
 return {
 id: this.id,
 manager: this.manager,
 action: this.action,
 packageId: this.packageId,
 packageName: this.packageName,
 userId: this.userId,
 sessionId: this.sessionId,
 status: this.status,
 progress: this.progress,
 message: this.message,
 exitCode: this.exitCode,
 startedAt: this.startedAt,
 finishedAt: this.finishedAt,
 error: this.error,
 durationMs: this.startedAt && this.finishedAt
 ? this.finishedAt - this.startedAt
 : (this.startedAt ? Date.now() - this.startedAt : 0),
 };
 }
}

// ---------------------------------------------------------------------------
// SoftwareJobManager — 全局单例
// ---------------------------------------------------------------------------

class SoftwareJobManager extends EventEmitter {
 constructor(options = {}) {
 super();
 this._jobs = new Map(); // id -> SoftwareJob
 this._historyLimit = options.historyLimit || 200;
 this._maxConcurrent = options.maxConcurrent || 2;
 this._activeCount = 0;
 this._queue = [];
 }

 /**
 * 创建并入队一个 job
 * @returns {SoftwareJob}
 */
 create(options) {
 const job = new SoftwareJob(options);
 this._jobs.set(job.id, job);
 this._enqueue(job);
 return job;
 }

 _enqueue(job) {
 this._queue.push(job);
 this._tryStart();
 this.emit('queued', job.toJSON());
 }

 _tryStart() {
 while (this._activeCount < this._maxConcurrent && this._queue.length > 0) {
 const job = this._queue.shift();
 this._startJob(job);
 }
 }

 _startJob(job) {
 this._activeCount++;
 job.status = JOB_STATUS.RUNNING;
 job.startedAt = Date.now();
 job.message = '正在启动安装进程...';
 job.progress = 5;
 this.emit('started', job.toJSON());

 // 异步执行
 setImmediate(() => this._runJob(job));
 }

 /**
 * 子类或外部执行器调用：实际执行
 * 默认使用 wingetInstaller 的 executeInstall
 */
 async _runJob(job) {
 try {
 const { runInstall } = require('./winget-installer');
 await runInstall(job, (eventType, payload) => {
 // 进度回调
 if (eventType === 'progress') {
 job.progress = Math.max(job.progress, payload.progress || 0);
 job.message = payload.message || job.message;
 job.stdout += (payload.stdout || '') + '\n';
 job.stderr += (payload.stderr || '') + '\n';
 this.emit('progress', job.toJSON());
 } else if (eventType === 'log') {
 if (payload.stream === 'stderr') {
 job.stderr += (payload.data || '') + '\n';
 } else {
 job.stdout += (payload.data || '') + '\n';
 }
 } else if (eventType === 'message') {
 job.message = payload.message || job.message;
 this.emit('progress', job.toJSON());
 }
 });
 job.status = JOB_STATUS.SUCCEEDED;
 job.progress = 100;
 job.message = '安装完成';
 job.finishedAt = Date.now();
 job.exitCode = 0;
 this.emit('succeeded', job.toJSON());
 } catch (e) {
 job.status = JOB_STATUS.FAILED;
 job.message = `安装失败: ${e.message}`;
 job.finishedAt = Date.now();
 job.error = e.message;
 job.exitCode = e.exitCode || 1;
 this.emit('failed', job.toJSON());
 } finally {
 this._activeCount--;
 this._tryStart();
 this._evict();
 }
 }

 _evict() {
 if (this._jobs.size <= this._historyLimit) return;
 // 删除最早完成的 jobs
 const finished = Array.from(this._jobs.values())
 .filter(j => j.finishedAt)
 .sort((a, b) => a.finishedAt - b.finishedAt);
 const toRemove = this._jobs.size - this._historyLimit;
 for (let i = 0; i < toRemove && i < finished.length; i++) {
 this._jobs.delete(finished[i].id);
 }
 }

 /**
 * 取消一个 job（仅能取消 queued 状态）
 * @returns {boolean}
 */
 cancel(jobId) {
 const job = this._jobs.get(jobId);
 if (!job) return false;
 if (job.status === JOB_STATUS.QUEUED) {
 this._queue = this._queue.filter(j => j.id !== jobId);
 job.status = JOB_STATUS.CANCELLED;
 job.message = '已取消';
 job.finishedAt = Date.now();
 this.emit('cancelled', job.toJSON());
 this._evict();
 return true;
 }
 return false; // 运行中的 job 需要终止子进程
 }

 get(jobId) {
 return this._jobs.get(jobId) || null;
 }

 list(filter = {}) {
 let jobs = Array.from(this._jobs.values());
 if (filter.userId) jobs = jobs.filter(j => j.userId === filter.userId);
 if (filter.status) jobs = jobs.filter(j => j.status === filter.status);
 if (filter.manager) jobs = jobs.filter(j => j.manager === filter.manager);
 return jobs.map(j => j.toJSON()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
 }

 getStats() {
 const all = Array.from(this._jobs.values());
 const byStatus = {};
 for (const j of all) {
 byStatus[j.status] = (byStatus[j.status] || 0) + 1;
 }
 return {
 total: all.length,
 active: this._activeCount,
 queued: this._queue.length,
 byStatus,
 };
 }
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

let _instance = null;

function getSoftwareJobManager() {
 if (!_instance) {
 _instance = new SoftwareJobManager();
 console.log('[software-jobs] 管理器已初始化');
 }
 return _instance;
}

module.exports = {
 SoftwareJob,
 SoftwareJobManager,
 JOB_STATUS,
 getSoftwareJobManager,
};
