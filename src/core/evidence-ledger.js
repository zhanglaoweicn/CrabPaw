/**
 * EvidenceLedger — 长任务证据/接力账本（2026-09-18 LoopX P1）
 *
 * 背景：恢复链路此前逐能力重造——filegen v2 状态机、Remotion 续跑、断线补投各自
 * 实现各自的"记到哪了/怎么接着来"。本模块抽出共享的轻量"证据+接力"记录格式，
 * 建在既有 CheckpointStore 之上（原子写 + 损坏降级，不重造存储）。
 *
 * 统一记录 schema（借 LoopX evidence + handoff 原语）：
 *   {
 *     v: 1, kind, id,
 *     status: 'running' | 'blocked',        // 只收可恢复态；终态由调用方 clear()
 *     step: 'collect',                       // 死在哪一步（调用方语义）
 *     summary: '标题/一句话',                 // 接力者靠它认出任务
 *     evidence: { ...紧凑 facts },           // 够认任务、不够重建全量上下文
 *     blocker: '为何停',                      // blocked 必带（LoopX：等待必须具体）
 *     nextTodo: '接着干什么',                 // handoff：接力者照此继续，无需原上下文
 *     createdAt, updatedAt
 *   }
 *
 * 目录约定：DATA_DIR/checkpoints/ev_<kind>_<id>.json（ev_ 前缀与 plan_/bg_tasks_ 隔离）
 *
 * 测试隔离：显式 dir 或 CRABPAW_DATA_DIR → 真实 IO；NODE_ENV=test 且两者皆无 →
 * 内存态（存量测试零污染、零写盘）。
 */
const path = require('path');
const { CheckpointStore } = require('./checkpoint-store');
const { getDataDir } = require('./config');

const KEY_PREFIX = 'ev_';
const RECORD_VERSION = 1;
// stale 判定：running 记录超过此时长未更新 → 视为"进程被强杀的现场"（listResumable 标 stale）
const DEFAULT_STALE_MS = 30 * 60 * 1000;
// 兜底清理：任何记录超过此时长未更新 → sweep 可删（防废弃证据永久堆积）
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function memoryStore() {
  const map = new Map();
  return {
    saveCheckpoint: (key, data) => { map.set(key, JSON.parse(JSON.stringify(data))); return true; },
    loadCheckpoint: (key) => map.get(key) || null,
    deleteCheckpoint: (key) => map.delete(key),
    listCheckpoints: (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

function _requireStr(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[evidence-ledger] ${name} 必须为非空字符串`);
  }
  return value.trim();
}

/**
 * @param {{ dir?: string }} opts 显式目录（测试/隔离用）；缺省按环境解析（见文件头）
 */
function createLedger(opts = {}) {
  let dir = opts.dir || null;
  if (!dir) {
    if (process.env.CRABPAW_DATA_DIR) {
      dir = path.join(process.env.CRABPAW_DATA_DIR, 'checkpoints');
    } else if (process.env.NODE_ENV === 'test') {
      dir = null; // 内存态
    } else {
      dir = path.join(getDataDir(), 'checkpoints');
    }
  }
  const store = dir ? new CheckpointStore({ dir }) : memoryStore();

  const keyOf = (kind, id) => `${KEY_PREFIX}${String(kind)}_${String(id)}`;

  /** upsert 记录（blocked 必带 blocker——LoopX"等待必须具体"不变量） */
  function record(req) {
    if (!req || typeof req !== 'object') throw new Error('[evidence-ledger] record 需要 req 对象');
    const kind = _requireStr(req.kind, 'kind');
    const id = _requireStr(req.id, 'id');
    const status = req.status === 'blocked' ? 'blocked' : 'running';
    if (status === 'blocked' && !(typeof req.blocker === 'string' && req.blocker.trim())) {
      throw new Error(`[evidence-ledger] blocked 记录必须带 blocker（${kind}/${id}）`);
    }
    if (req.evidence !== undefined && (typeof req.evidence !== 'object' || req.evidence === null)) {
      throw new Error(`[evidence-ledger] evidence 必须为对象（${kind}/${id}）`);
    }
    const key = keyOf(kind, id);
    const prev = store.loadCheckpoint(key);
    const now = Date.now();
    const rec = {
      v: RECORD_VERSION,
      kind, id, status,
      step: req.step || undefined,
      summary: req.summary || undefined,
      evidence: req.evidence || undefined,
      blocker: status === 'blocked' ? req.blocker : undefined,
      nextTodo: req.nextTodo || undefined,
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
    };
    store.saveCheckpoint(key, rec);
    return rec;
  }

  function get(kind, id) {
    return store.loadCheckpoint(keyOf(kind, id));
  }

  function clear(kind, id) {
    return store.deleteCheckpoint(keyOf(kind, id));
  }

  /**
   * 可恢复清单：status ∈ running|blocked，按 updatedAt 降序。
   * running 超过 staleMs 未更新 → stale:true（进程被强杀现场的标记）。
   */
  function listResumable({ kinds, staleMs } = {}) {
    const staleLimit = Number.isFinite(staleMs) ? staleMs : DEFAULT_STALE_MS;
    const kindSet = Array.isArray(kinds) && kinds.length ? new Set(kinds) : null;
    const out = [];
    for (const key of store.listCheckpoints(KEY_PREFIX)) {
      const rec = store.loadCheckpoint(key);
      if (!rec || typeof rec !== 'object') continue;
      if (rec.status !== 'running' && rec.status !== 'blocked') continue;
      if (kindSet && !kindSet.has(rec.kind)) continue;
      const age = Date.now() - (rec.updatedAt || 0);
      out.push({ ...rec, stale: rec.status === 'running' && age > staleLimit });
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  /** 兜底清理：删除超过 maxAgeMs 未更新的记录（防废弃证据永久堆积） */
  function sweep(maxAgeMs) {
    const limit = Number.isFinite(maxAgeMs) ? maxAgeMs : DEFAULT_MAX_AGE_MS;
    let removed = 0;
    for (const key of store.listCheckpoints(KEY_PREFIX)) {
      const rec = store.loadCheckpoint(key);
      if (rec && Date.now() - (rec.updatedAt || 0) > limit) {
        store.deleteCheckpoint(key);
        removed++;
      }
    }
    return removed;
  }

  return { record, get, listResumable, clear, sweep };
}

module.exports = { createLedger, KEY_PREFIX, DEFAULT_STALE_MS, DEFAULT_MAX_AGE_MS };
