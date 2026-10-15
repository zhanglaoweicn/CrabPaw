/**
 * Recall Exclusion — 目录级召回排除 + 会话冷却账本
 *
 * 思想来源：OpenViking（volcengine）#5982 的工程逻辑移植：
 *   ① exclude_uris 子树匹配——排除一个"目录"时应连同其整棵子树一起排除，
 *      而不是只挡掉该 URI 本身；
 *   ② session ledger 冷却——本会话已服务过的 URI 进入冷却期，避免
 *      "已上文的目录遮蔽新内容"造成的重复注入与排序自遮挡。
 *
 * （仅移植设计思想，零代码复制，规避 AGPL —— 2026-10-15 技术债治理轮）
 *
 * 用法（配合 hybrid-retrieval.search 的 opts）：
 *   const part = applyRecallExclusion(results, { excludeUris, ledger, now });
 *   // part.kept / part.excluded
 *   // 最终返回前：kept.forEach(r => r.uri && ledger.markServed(r.uri))
 */

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 默认冷却 30 分钟
const DEFAULT_MAX_ENTRIES = 500;            // 账本容量上限（LRU 淘汰）

/** 规范化 URI：去尾部斜杠，统一比较口径 */
function normalizeUri(uri) {
  return String(uri || '').replace(/\/+$/, '');
}

/**
 * 子树匹配：uri 命中 pattern 自身、其子路径（pattern/...）或通配尾部（pattern*）。
 * @param {string} uri     条目 URI，如 "kb/finance/2026/q3"
 * @param {string} pattern 排除模式，如 "kb/finance"（子树）、"kb/finance/2026*"（前缀通配）
 * @returns {boolean}
 */
function uriMatchesPattern(uri, pattern) {
  if (!uri || !pattern) return false;
  const u = normalizeUri(uri);
  const p = normalizeUri(pattern);
  if (!p) return false;
  if (u === p) return true;
  if (p.endsWith('*')) return u.startsWith(p.slice(0, -1));
  return u.startsWith(`${p}/`);
}

/** 从检索结果条目解析 URI（字段名兼容多源：uri / sourceUri / path） */
function resolveItemUri(item) {
  if (!item) return '';
  return item.uri || item.sourceUri || item.source_uri || item.path || '';
}

/**
 * 按排除模式过滤结果数组。
 * @returns {{kept: Array, excluded: Array<{id, uri, reason}>}}
 */
function filterExcludedUris(results, excludeUris) {
  const patterns = (excludeUris || []).map(normalizeUri).filter(Boolean);
  const kept = [];
  const excluded = [];
  for (const item of results || []) {
    const uri = resolveItemUri(item);
    const hit = patterns.find((p) => uriMatchesPattern(uri, p));
    if (hit) {
      excluded.push({ id: item.id, uri, reason: `exclude_uris:${hit}` });
    } else {
      kept.push(item);
    }
  }
  return { kept, excluded };
}

/**
 * 会话召回账本：记录本会话已服务过的 URI，冷却期内不再召回。
 * 纯内存实现，容量上限 LRU 淘汰，可 toJSON/fromJSON 持久化。
 */
class SessionRecallLedger {
  constructor(config = {}) {
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    /** @type {Map<string, number>} uri -> servedAt(ms)，Map 迭代序即插入序 */
    this._served = new Map();
  }

  /** 标记某 URI 已在本会话服务过 */
  markServed(uri, now = Date.now()) {
    const u = normalizeUri(uri);
    if (!u) return;
    if (this._served.has(u)) this._served.delete(u); // 刷新到最新（LRU 语义）
    this._served.set(u, now);
    while (this._served.size > this.maxEntries) {
      const oldest = this._served.keys().next().value;
      this._served.delete(oldest);
    }
  }

  /** URI 是否处于冷却期 */
  isCooled(uri, now = Date.now()) {
    const servedAt = this._served.get(normalizeUri(uri));
    if (servedAt === undefined) return false;
    return now - servedAt < this.cooldownMs;
  }

  /** 批量划分：{kept, excluded}，excluded.reason = 'session_cool:<剩余ms>' */
  partitionByCooldown(results, now = Date.now()) {
    const kept = [];
    const excluded = [];
    for (const item of results || []) {
      const uri = resolveItemUri(item);
      if (uri && this.isCooled(uri, now)) {
        const servedAt = this._served.get(normalizeUri(uri));
        excluded.push({ id: item.id, uri, reason: `session_cool:${this.cooldownMs - (now - servedAt)}` });
      } else {
        kept.push(item);
      }
    }
    return { kept, excluded };
  }

  /** 清理过期条目，返回清除数量 */
  prune(now = Date.now()) {
    let removed = 0;
    for (const [uri, servedAt] of this._served) {
      if (now - servedAt >= this.cooldownMs) {
        this._served.delete(uri);
        removed++;
      }
    }
    return removed;
  }

  get size() {
    return this._served.size;
  }

  toJSON() {
    return { cooldownMs: this.cooldownMs, maxEntries: this.maxEntries, served: [...this._served] };
  }

  static fromJSON(json) {
    const ledger = new SessionRecallLedger({ cooldownMs: json?.cooldownMs, maxEntries: json?.maxEntries });
    for (const [uri, ts] of json?.served || []) ledger._served.set(uri, ts);
    return ledger;
  }
}

/**
 * 一站式召回排除：先过 exclude_uris 子树，再过会话冷却。
 * @param {Array} results
 * @param {{excludeUris?:string[], ledger?:SessionRecallLedger, now?:number}} opts
 * @returns {{kept: Array, excluded: Array<{id, uri, reason}>}}
 */
function applyRecallExclusion(results, opts = {}) {
  const now = opts.now ?? Date.now();
  let kept = results || [];
  const excluded = [];

  if (opts.excludeUris && opts.excludeUris.length) {
    const r = filterExcludedUris(kept, opts.excludeUris);
    kept = r.kept;
    excluded.push(...r.excluded);
  }

  if (opts.ledger) {
    const r = opts.ledger.partitionByCooldown(kept, now);
    kept = r.kept;
    excluded.push(...r.excluded);
  }

  return { kept, excluded };
}

module.exports = {
  normalizeUri,
  uriMatchesPattern,
  resolveItemUri,
  filterExcludedUris,
  SessionRecallLedger,
  applyRecallExclusion,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ENTRIES,
};
