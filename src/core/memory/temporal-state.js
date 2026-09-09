/**
 * temporal-state.js — 时态状态投影（semantica TemporalGraph state_at / reconstruct_at_time 范式 JS 版）
 *
 * 设计约定（与 semantica temporal_model.py 一致）：
 * - 事实仍是普通行（dict），valid_from/valid_to 是字段约定，不做独立存储；
 * - 时间窗口为半开区间 [valid_from, valid_to)：valid_from <= t < valid_to 时视为活跃
 *   （与 temporal-graph.js queryAtTime 的 SQL 语义一致：valid_to IS NULL OR valid_to > t）；
 * - NULL/缺字段 = 无窗口限制（恒活跃），保证旧数据向后兼容；
 * - 时间戳为 epoch 毫秒（REAL，与 relations.valid_from/valid_to 一致）；
 * - 关系须两端点实体皆活跃（悬边/引用已失效实体的关系自动剔除）。
 */

/**
 * 统一时间归一化：epoch ms / Date / ISO 字符串 → ms；无法解析返回 null。
 */
function toMs(t) {
  if (t == null) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  const n = new Date(t).getTime();
  return Number.isFinite(n) ? n : null;
}

/**
 * 单行（关系/记忆/实体）在 t 时刻是否活跃（纯函数）。
 * @param {{valid_from?: number|null, valid_to?: number|null}} row
 * @param {number} t epoch 毫秒
 */
function activeAt(row, t) {
  if (!row) return false;
  const ts = toMs(t);
  if (ts == null) return false;
  const vf = row.valid_from == null ? null : toMs(row.valid_from);
  const vt = row.valid_to == null ? null : toMs(row.valid_to);
  if (vf != null && vf > ts) return false;
  if (vt != null && vt <= ts) return false;
  return true;
}

/**
 * 点时刻子图投影（纯函数，深拷贝输入不被修改）——reconstruct_at_time 范式：
 * 实体按时间窗过滤；关系须自身活跃且两端点实体皆活跃（窗口段）。
 * @param {Array<{id: string, valid_from?: number|null, valid_to?: number|null}>} entities
 * @param {Array<{source_entity: string, target_entity: string, valid_from?: number|null, valid_to?: number|null}>} relations
 * @param {number} t epoch 毫秒
 * @returns {{entities: Array, relations: Array}}
 */
function projectStateAt(entities, relations, t) {
  const ts = toMs(t);
  if (ts == null) {
    return { entities: [], relations: [] };
  }
  const activeEntities = (entities || []).filter((e) => activeAt(e, ts));
  const activeIds = new Set(activeEntities.map((e) => e.id));
  const activeRelations = (relations || []).filter((r) => {
    if (!activeAt(r, ts)) return false;
    // 实体集合为空 = 端点视作恒存活（旧库兼容模式）；非空则两端点必须都在活跃集内
    if (activeIds.size === 0) return true;
    return activeIds.has(r.source_entity) && activeIds.has(r.target_entity);
  });
  return { entities: activeEntities, relations: activeRelations };
}

/**
 * 存储级时点快照：从 unified-store 拉图数据并投影到 t 时刻。
 * （关系层窗口下推到 SQL；实体层窗口在 JS 端校验，实体表无窗口字段时恒活跃。）
 * @param {{all: Function}} store unified-store 实例（含 all(sql, params)）
 * @param {number} t
 * @returns {{entities: Array, relations: Array}}
 */
function queryStateAt(store, t) {
  const ts = toMs(t);
  if (ts == null) {
    return { entities: [], relations: [] };
  }
  // 半开区间 [valid_from, valid_to)：SQL 与 activeAt 同语义，先下推过滤减少传输
  const relRows = store.all(
    `SELECT * FROM relations
     WHERE (valid_from IS NULL OR valid_from <= ?)
       AND (valid_to IS NULL OR valid_to > ?)`,
    [ts, ts]
  );
  const endpointIds = new Set();
  for (const r of relRows) {
    endpointIds.add(r.source_entity);
    endpointIds.add(r.target_entity);
  }
  const entities = endpointIds.size > 0
    ? store.all(`SELECT * FROM entities WHERE id IN (${Array.from(endpointIds).map(() => '?').join(',')})`, Array.from(endpointIds))
    : [];
  return projectStateAt(entities, relRows, ts);
}

module.exports = { toMs, activeAt, projectStateAt, queryStateAt };
