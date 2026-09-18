/**
 * ProactiveKernel — 主动发声统一判定原语 v2（2026-09-18 LoopX P0）
 *
 * 背景与盘点结论：此前"是否发声"的判定散在 4 个循环 + 1 个决策层，去重一个语义
 * 有 5 种实现（notify 内存 Map / risk _lastScan / scenario _lastEval / perception
 * cooldownMs / ack 哈希），intent 四档传了但决策层完全没用，无配额、无持久化。
 * 本模块把判定收敛为一条五连链（借鉴 LoopX 的 quota/gate/evidence 原语）：
 *
 *   ① gate    用户当日已确认同内容（ack）？→ gate（不播，不记账）
 *   ② quota   该 trigger 当日已播 ≥ cap？超 → deny（不记账）
 *   ③ dedup   滑动窗去重（窗内 → quiet；命中/记录都不记账）
 *   ④ intent  分档策略：confront 免静默；其余档静默时段一律入补播队列
 *   ⑤ speak   放行 → 由调用方广播后回填 spend() 记账
 *
 * 三条不变量（kernel.test.js 锚定，改动前先读懂）：
 *   I1 quiet 不计数 —— 静默入队/等待确认/去重拒绝/超配额一律不消耗配额，只有真播出才 spend
 *   I2 gate 是具体确认 —— 按 trigger+文本哈希存当日确认，数据一变哈希变 → 旧确认自然过期
 *   I3 判定状态单一真值落盘 —— statePath 启用后持久化，重启不去重清零、确认不丢失
 *
 * 双路径兼容：
 *   legacy（默认）—— notify() 兼容路径：无配额、intent 不参与分档、静默无豁免（v1 行为等价，
 *             12 条存量契约见 proactive.test.js）；dedup 滑动窗语义逐条保留。
 *   native —— 提案带 native:true 时启用（服务收编路径，step 2 起）：配额/分档/豁免生效。
 *
 * 持久化：statePath 未配置 = 纯内存（存量测试零污染）；配置后读写
 * proactive-kernel.json，并一次性迁移旧 proactive-ack.json（ack-store 委托本模块后兼容）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataDir } = require('../config');

const STATE_FILENAME = 'proactive-kernel.json';
const LEGACY_ACK_FILENAME = 'proactive-ack.json';
const DEDUP_CACHE_MAX = 500;   // 去重条目上限，超出触发过期清理（继承 v1 语义）
const SAVE_DEBOUNCE_MS = 5000; // 去重变更的落盘去抖；gate/counter 变更立即落盘

// intent 分档策略（native profile）——cap 为每 trigger 每日播报上限
const INTENT_POLICIES = {
  confront: { cap: 8, silentBypass: true },  // 催收/逾期级：静默时段也出（卡片承载，低打扰）
  inform:   { cap: 6, silentBypass: false },
  ambient:  { cap: 3, silentBypass: false },
  suggest:  { cap: 3, silentBypass: false },
};
const DEFAULT_CAP = 6;

const state = {
  config: { silentStart: 22, silentEnd: 8, dedupMs: 30 * 60 * 1000 },
  day: null,                    // 'YYYY-MM-DD'，跨天自动轮换计数
  counters: {},                 // { [trigger]: n }（仅当日）
  dedup: new Map(),             // keyHash → { ts, ms }（滑动窗）
  gates: {},                    // keyHash → { day, state: 'resolved', ackedAt }
  statePath: null,              // null = 纯内存
  loaded: false,
  saveTimer: null,
};

/* ─── 键与工具 ─── */
// 与旧 ack-store.ackKey 逐字节一致——旧 proactive-ack.json 迁移与哈希续用依赖这一点
function ackKey(trigger, text) {
  return crypto.createHash('sha1').update(`${trigger}|${String(text)}`).digest('hex').slice(0, 16);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function currentHour() {
  return new Date().getHours();
}

/** 静默时段判断（跨零点；start===end = 不启用） */
function isSilentHour() {
  const h = currentHour();
  const { silentStart, silentEnd } = state.config;
  if (silentStart === silentEnd) return false;
  if (silentStart < silentEnd) return h >= silentStart && h < silentEnd;
  return h >= silentStart || h < silentEnd;
}

/* ─── 持久化 ─── */
function _ensureDay() {
  const today = todayStr();
  if (state.day !== today) {
    state.day = today;
    state.counters = {}; // 配额按日轮换；dedup/gates 自带窗口/日期语义，不随日清
  }
}

function _load() {
  if (state.loaded || !state.statePath) return;
  state.loaded = true;
  state.day = todayStr();
  try {
    const parsed = JSON.parse(fs.readFileSync(state.statePath, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      state.day = typeof parsed.day === 'string' ? parsed.day : state.day;
      state.counters = parsed.counters && typeof parsed.counters === 'object' ? parsed.counters : {};
      state.gates = parsed.gates && typeof parsed.gates === 'object' ? parsed.gates : {};
      if (parsed.dedup && typeof parsed.dedup === 'object') {
        for (const [k, v] of Object.entries(parsed.dedup)) {
          if (v && Number.isFinite(v.ts)) state.dedup.set(k, v);
        }
      }
      _ensureDay();
    }
  } catch (e) {
    // 缺失/损坏 → 全新状态（判定降级为未确认/未去重：宁可多提醒，不可漏提醒）
    if (e.code !== 'ENOENT') console.warn('[proactive-kernel] 状态文件读取失败，降级为全新状态:', e.message);
    // 一次性迁移旧 ack-store 数据（同目录 proactive-ack.json，仅当日确认有效）
    try {
      const legacyPath = path.join(path.dirname(state.statePath), LEGACY_ACK_FILENAME);
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
      const today = todayStr();
      for (const [k, rec] of Object.entries(legacy || {})) {
        if (rec && rec.day === today) {
          state.gates[k] = { day: rec.day, state: 'resolved', ackedAt: rec.ackedAt || Date.now() };
        }
      }
      if (Object.keys(state.gates).length) {
        console.log('[proactive-kernel] 已迁移旧 proactive-ack.json 当日确认', Object.keys(state.gates).length, '条');
        _saveNow();
      }
    } catch (e2) {
      if (e2.code !== 'ENOENT') console.warn('[proactive-kernel] 旧确认文件迁移跳过:', e2.message);
    }
  }
}

function _saveNow() {
  if (!state.statePath || !state.loaded) return;
  try {
    const payload = {
      version: 1,
      day: state.day,
      counters: state.counters,
      gates: state.gates,
      dedup: Object.fromEntries(state.dedup),
    };
    fs.writeFileSync(state.statePath, JSON.stringify(payload));
  } catch (e) {
    console.warn('[proactive-kernel] 状态写盘失败(降级为内存态):', e.message);
  }
}

function _markDirty(core) {
  if (!state.statePath) return;
  if (core) {
    _saveNow(); // gate/counter 变更低频，立即落盘保 I3
    return;
  }
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    _saveNow();
  }, SAVE_DEBOUNCE_MS);
  if (state.saveTimer.unref) state.saveTimer.unref();
}

/** 去重缓存过期清理（超上限才扫，继承 v1 防每请求扫描） */
function _pruneDedup() {
  if (state.dedup.size <= DEDUP_CACHE_MAX) return;
  const now = Date.now();
  for (const [key, rec] of state.dedup) {
    if (now - rec.ts > rec.ms) state.dedup.delete(key);
  }
  let overflow = state.dedup.size - DEDUP_CACHE_MAX;
  for (const key of state.dedup.keys()) {
    if (overflow <= 0) break;
    state.dedup.delete(key);
    overflow--;
  }
}

/* ─── 判定原语 ─── */

/**
 * 配置（幂等，可重复调用）。statePath 一旦设定不可回退为 null（防先持久化后丢失）。
 * @param {{ silentStart?: number, silentEnd?: number, dedupMs?: number, statePath?: string|null }} opts
 */
function configure(opts = {}) {
  if (Number.isFinite(opts.silentStart)) state.config.silentStart = opts.silentStart;
  if (Number.isFinite(opts.silentEnd)) state.config.silentEnd = opts.silentEnd;
  if (Number.isFinite(opts.dedupMs)) state.config.dedupMs = opts.dedupMs;
  if (!state.statePath && typeof opts.statePath === 'string' && opts.statePath) {
    state.statePath = opts.statePath;
  }
}

function _capFor(intent) {
  const pol = INTENT_POLICIES[intent];
  return (pol && pol.cap) || DEFAULT_CAP;
}

/**
 * 五连判定。副作用仅限 dedup 时间戳（滑动窗语义）与日轮换。
 * @param {{ trigger: string, text: string, intent?: string, dedupMs?: number, cap?: number,
 *           native?: boolean }} req
 *   native=true 启用配额/gate 豁免分档（收编服务用）；缺省 legacy（v1 等价，无配额无豁免）
 * @returns {{ decision: 'speak'|'queued'|'quiet'|'gate'|'deny', reason?: string, keyHash: string }}
 */
function propose(req) {
  _load();
  _ensureDay();
  _pruneDedup(); // v1 语义：插入前清理（仅超 500 条才扫）
  if (!req || !req.trigger || !req.text) {
    return { decision: 'deny', reason: 'invalid_request', keyHash: '' };
  }
  const trigger = String(req.trigger);
  const text = String(req.text);
  const intent = req.intent || 'inform';
  const native = req.native === true;
  const keyHash = ackKey(trigger, text);

  // ② gate：当日已确认同内容 → 不播（不记账）。native/legacy 都查——
  // ack-store 已委托本模块，任何路径的确认都收敛到同一 gate 真值
  const gate = state.gates[keyHash];
  if (gate && gate.state === 'resolved' && gate.day === todayStr()) {
    return { decision: 'gate', reason: 'acked_today', keyHash };
  }

  // ① quota（仅 native）：超配额静默拒绝，不记账（I1）
  if (native) {
    const cap = Number.isFinite(req.cap) ? req.cap : _capFor(intent);
    if ((state.counters[trigger] || 0) >= cap) {
      return { decision: 'deny', reason: 'quota', keyHash };
    }
  }

  // ③ dedup 滑动窗：窗内拒绝；每次提案都刷新时间戳（v1 滑动语义，防"每 30 分钟擦边重复"）
  const dedupMs = Number.isFinite(req.dedupMs) ? req.dedupMs : state.config.dedupMs;
  const last = state.dedup.get(keyHash);
  const now = Date.now();
  if (last && now - last.ts < (Number.isFinite(last.ms) ? last.ms : dedupMs)) {
    last.ts = now;
    _markDirty(false);
    return { decision: 'quiet', reason: 'dedup', keyHash };
  }
  state.dedup.set(keyHash, { ts: now, ms: dedupMs });
  _markDirty(false);

  // ④ intent 分档 + 静默：native 下 confront 免静默；legacy 一律按 v1（静默入队）
  if (isSilentHour()) {
    const bypass = native && (INTENT_POLICIES[intent] || {}).silentBypass === true;
    if (!bypass) return { decision: 'queued', reason: 'silent_hours', keyHash };
  }

  // ⑤ 放行——调用方广播成功后必须回填 spend()（I1：只有播出才记账）
  return { decision: 'speak', keyHash };
}

/** 记账：仅在实际广播（含补播投递）后调用 */
function spend(trigger) {
  if (!trigger) return;
  _ensureDay();
  state.counters[trigger] = (state.counters[trigger] || 0) + 1;
  _markDirty(true);
}

/** 用户确认（gate 解除）：当日同内容不再播；数据变化 → 哈希变 → 自然过期（I2） */
function markAcked(trigger, text) {
  _load();
  const keyHash = ackKey(String(trigger), String(text));
  state.gates[keyHash] = { day: todayStr(), state: 'resolved', ackedAt: Date.now() };
  _pruneGates();
  _markDirty(true);
  return true;
}

/** 当日是否已确认（兼容旧 ack-store.isAckedToday 语义） */
function isAckedToday(trigger, text) {
  _load();
  const rec = state.gates[ackKey(String(trigger), String(text))];
  return !!(rec && rec.state === 'resolved' && rec.day === todayStr());
}

/** 防膨胀：超 500 条清非当日确认（继承 ack-store 先例） */
function _pruneGates() {
  const keys = Object.keys(state.gates);
  if (keys.length <= 500) return;
  const today = todayStr();
  for (const k of keys) {
    if (!state.gates[k] || state.gates[k].day !== today) delete state.gates[k];
  }
}

/* ─── 观测/测试钩子 ─── */
function stats() {
  return { dedupCount: state.dedup.size, counters: { ...state.counters }, day: state.day };
}

function _flushNow() { _saveNow(); }

function _reset() {
  state.counters = {};
  state.dedup = new Map();
  state.gates = {};
  state.day = todayStr();
  state.loaded = false;
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
}

module.exports = {
  configure, propose, spend, markAcked, isAckedToday, isSilentHour, ackKey,
  stats, _flushNow, _reset,
  INTENT_POLICIES, STATE_FILENAME,
};
