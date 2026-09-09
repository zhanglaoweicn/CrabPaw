/**
 * RunStore — Run 生命周期注册表 + 终态快照(B1/B2, Runtime差距分析实施)
 *
 * 两层职责:
 * 1. 活跃 Run 注册表(runId 级): startRun/markRunStatus/requestCancel/finishRunRecord——
 *    每次状态迁移原子落盘(checkpoints/runrec_<runId>.json),支持:
 *    - run 级取消(POST /api/request/cancel 带 runId)
 *    - waiting_approval 状态(审批挂起期间可观测)
 *    - 断连解耦标记 detached(连接断开 ≠ run 终止)
 *    - 崩溃恢复: 进程重启后首次实例化时,所有 running/waiting_approval 的
 *      持久记录判为 interrupted 并同步恢复横幅(原 run_<userId> 键)——
 *      此前运行中状态完全不落盘,崩溃即丢失。
 * 2. 终态横幅快照(向后兼容): save/load/clear 维持 P2-2/P2-4 原契约
 *    (键 run_<userId>,GUI 恢复横幅数据源),save 额外接受 cancelled 状态。
 *
 * 存储: CheckpointStore(原子 tmp+rename 写),与 background-task-manager/taskflow
 * 同 DATA_DIR/checkpoints 目录。
 */

const path = require('path');
const { DATA_DIR } = require('./config');
const { CheckpointStore } = require('./checkpoint-store');

// 横幅快照合法终态(GUI 恢复横幅只关心这三类+取消)
const RUN_STATUSES = new Set(['finished', 'error', 'interrupted', 'cancelled']);
// 活跃注册表的全量状态集
const RUN_RECORD_STATUSES = new Set([
  'running', 'waiting_approval', 'finished', 'error', 'interrupted', 'cancelled',
]);
const ACTIVE_RECORD_STATUSES = new Set(['running', 'waiting_approval']);

const MAX_FINISHED_RECORDS = 50;

class RunStore {
  constructor(options = {}) {
    this._store = options.store || new CheckpointStore({
      dir: options.dir || path.join(DATA_DIR, 'checkpoints'),
    });
    // runId -> record(活跃 run 内存索引; 每次迁移同步落盘)
    this._active = new Map();
    this._recovered = false;
  }

  _recordKey(runId) {
    return `runrec_${runId}`;
  }

  /**
   * 登记一次新 run(runId 即 roundId,保持与 AG-UI/轨迹单标识)
   * @param {{runId: string, userId: string, conversationId?: string|null, message?: string}} run
   */
  startRun(run = {}) {
    const { runId, userId } = run;
    if (!runId || !userId) return null;
    const record = {
      runId,
      userId,
      conversationId: run.conversationId || null,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      cancelRequested: false,
      detached: false,
      usage: null,
    };
    this._active.set(runId, record);
    this._persistRecord(record);
    return record;
  }

  /**
   * 迁移 run 状态(running ↔ waiting_approval 等非终态; 终态请走 finishRunRecord)
   * @returns {object|null} 更新后的记录
   */
  markRunStatus(runId, status, patch = {}) {
    if (!runId || !RUN_RECORD_STATUSES.has(status)) return null;
    const record = this._active.get(runId) || this._loadRecord(runId);
    if (!record) return null;
    if (ACTIVE_RECORD_STATUSES.has(status)) this._active.set(runId, record);
    record.status = status;
    record.updatedAt = Date.now();
    if (patch && typeof patch === 'object') {
      if (patch.approval !== undefined) record.approval = patch.approval;
      if (patch.usage !== undefined) record.usage = patch.usage;
      if (patch.error !== undefined) record.error = String(patch.error).slice(0, 1000);
    }
    this._persistRecord(record);
    return record;
  }

  /** 断连解耦: 客户端连接断开但 run 继续执行(B4 disconnect=continue 策略) */
  markRunDetached(runId) {
    if (!runId) return null;
    const record = this._active.get(runId) || this._loadRecord(runId);
    if (!record) return null;
    record.detached = true;
    record.updatedAt = Date.now();
    this._active.set(runId, record);
    this._persistRecord(record);
    return record;
  }

  /**
   * 请求取消 run(停止按钮/取消 API)——置位 cancelRequested,由
   * globalRequestInterrupt.abort 完成实际 LLM 流中止
   */
  requestCancel(runId) {
    if (!runId) return null;
    const record = this._active.get(runId) || this._loadRecord(runId);
    if (!record || !ACTIVE_RECORD_STATUSES.has(record.status)) return null;
    record.cancelRequested = true;
    record.updatedAt = Date.now();
    this._active.set(runId, record);
    this._persistRecord(record);
    return record;
  }

  /**
   * 写入 run 终态并移出活跃索引
   * @param {string} runId
   * @param {'finished'|'error'|'interrupted'|'cancelled'} status
   * @param {{usage?: object, error?: string, digest?: string, lastContent?: string, conversationId?: string}} patch
   */
  finishRunRecord(runId, status, patch = {}) {
    if (!runId || !RUN_STATUSES.has(status)) return null;
    const record = this._active.get(runId) || this._loadRecord(runId);
    if (!record) return null;
    record.status = status;
    record.finishedAt = Date.now();
    record.updatedAt = record.finishedAt;
    if (patch && typeof patch === 'object') {
      if (patch.usage !== undefined) record.usage = patch.usage;
      if (patch.error !== undefined) record.error = String(patch.error).slice(0, 1000);
      if (patch.digest !== undefined) record.digest = patch.digest;
      if (patch.lastContent !== undefined) record.lastContent = String(patch.lastContent).slice(0, 500);
      if (patch.conversationId) record.conversationId = patch.conversationId;
    }
    this._active.delete(runId);
    this._persistRecord(record);
    this._pruneFinishedRecords();
    return record;
  }

  getRunRecord(runId) {
    if (!runId) return null;
    return this._active.get(runId) || this._loadRecord(runId);
  }

  /** 指定用户当前活跃 run(单用户单活跃; 多活跃时返回最近启动的) */
  getActiveRunByUser(userId) {
    if (!userId) return null;
    let best = null;
    for (const record of this._active.values()) {
      if (record.userId !== userId) continue;
      if (!best || record.startedAt > best.startedAt) best = record;
    }
    return best;
  }

  /**
   * 指定用户的全部活跃 run(按启动时间升序)
   * P0-3(Runtime优化轮): 并发闸门用——断连解耦后同用户可能短暂并存多个 run。
   */
  listActiveRunsByUser(userId) {
    if (!userId) return [];
    return [...this._active.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * 崩溃恢复: 扫描持久化 runrec_*,凡仍处于 running/waiting_approval 的记录
   * 判为 interrupted(进程重启 = 执行中断),同步刷新恢复横幅。仅在首次
   * 实例化时执行一次。
   */
  recoverInterruptedOnBoot() {
    if (this._recovered) return [];
    this._recovered = true;
    const recovered = [];
    try {
      const keys = this._store.listCheckpoints ? this._store.listCheckpoints('runrec_') : [];
      for (const key of keys || []) {
        const record = this._store.loadCheckpoint(key);
        if (!record || !ACTIVE_RECORD_STATUSES.has(record.status)) continue;
        record.status = 'interrupted';
        record.updatedAt = Date.now();
        record.recoveredAt = record.updatedAt;
        record.error = record.error || '服务重启导致运行中断';
        this._store.saveCheckpoint(key, record);
        recovered.push(record);
        // 同步恢复横幅(用户重启后能看到"上次对话中断")
        if (record.userId) {
          this.save(record.userId, {
            roundId: record.runId,
            conversationId: record.conversationId,
            status: 'interrupted',
            ts: record.updatedAt,
            lastContent: record.lastContent || '',
          });
        }
      }
    } catch (e) {
      console.warn('[run-store] 崩溃恢复扫描失败(忽略):', e?.message || e);
    }
    if (recovered.length > 0) {
      console.warn(`[run-store] 崩溃恢复: ${recovered.length} 个未完成 run 已标记 interrupted`);
    }
    return recovered;
  }

  /** 持久化单条 run 记录(失败不抛——记录是可观测性数据,不阻塞主流程) */
  _persistRecord(record) {
    try {
      this._store.saveCheckpoint(this._recordKey(record.runId), record);
    } catch (e) {
      console.warn('[run-store] run 记录落盘失败(忽略):', e?.message || e);
    }
  }

  _loadRecord(runId) {
    try {
      return this._store.loadCheckpoint(this._recordKey(runId)) || null;
    } catch (e) {
      return null;
    }
  }

  /** 清理历史终态记录,防 checkpoints 目录无限增长 */
  _pruneFinishedRecords() {
    try {
      const keys = this._store.listCheckpoints ? this._store.listCheckpoints('runrec_') : [];
      if (!keys || keys.length <= MAX_FINISHED_RECORDS) return;
      const finished = [];
      for (const key of keys) {
        const record = this._store.loadCheckpoint(key);
        if (record && !ACTIVE_RECORD_STATUSES.has(record.status) && record.finishedAt) {
          finished.push({ key, finishedAt: record.finishedAt });
        }
      }
      finished.sort((a, b) => a.finishedAt - b.finishedAt);
      const excess = finished.slice(0, finished.length - MAX_FINISHED_RECORDS);
      for (const item of excess) {
        this._store.deleteCheckpoint(item.key);
      }
    } catch (e) {
      console.warn('[run-store] 历史记录清理失败(忽略):', e?.message || e);
    }
  }

  /**
   * 写入运行终态横幅快照(向后兼容原契约)
   * @param {string} userId
   * @param {object} run { roundId, conversationId, status, ts, digest, messageCount, lastContent }
   * @returns {boolean}
   */
  save(userId, run = {}) {
    if (!userId) return false;
    if (!RUN_STATUSES.has(run.status)) return false;
    if (!run.roundId) return false;
    try {
      const snapshot = {
        roundId: run.roundId,
        userId,
        conversationId: run.conversationId || null,
        status: run.status,
        ts: run.ts || Date.now(),
        digest: typeof run.digest === 'string' ? run.digest.slice(0, 1000) : '',
        messageCount: Number.isFinite(run.messageCount) ? run.messageCount : null,
        lastContent: typeof run.lastContent === 'string' ? run.lastContent.slice(0, 500) : '',
        // 2026-08-14 GUI 全量修复 P1: AG-UI interrupt outcome 快照(审批等中断原因,
        // 供恢复横幅/审计复用; 截断 ≤10 条防撑爆 checkpoint)
        outcome: Array.isArray(run.outcome) ? run.outcome.slice(0, 10) : undefined,
      };
      this._store.saveCheckpoint(`run_${userId}`, snapshot);
      return true;
    } catch (e) {
      console.error('[run-store] 保存失败:', e?.message || e);
      return false;
    }
  }

  /**
   * 读取 userId 最近的运行快照(不存在/损坏 → null)
   * @param {string} userId
   * @returns {object|null}
   */
  load(userId) {
    if (!userId) return null;
    try {
      return this._store.loadCheckpoint(`run_${userId}`) || null;
    } catch (e) {
      console.warn('[run-store] 读取失败(降级 null):', e?.message || e);
      return null;
    }
  }

  clear(userId) {
    if (!userId) return;
    try {
      this._store.deleteCheckpoint(`run_${userId}`);
    } catch (e) {
      console.warn('[run-store] 清理失败:', e?.message || e);
    }
  }
}

let _instance = null;

function getRunStore(options) {
  if (!_instance) {
    _instance = new RunStore(options);
    // 首次实例化即做崩溃恢复扫描(幂等,无未完成记录时零成本)
    try { _instance.recoverInterruptedOnBoot(); } catch (e) {
      console.warn('[run-store] 崩溃恢复失败(忽略):', e?.message || e);
    }
  }
  return _instance;
}

module.exports = { RunStore, getRunStore, RUN_STATUSES, RUN_RECORD_STATUSES, ACTIVE_RECORD_STATUSES };
