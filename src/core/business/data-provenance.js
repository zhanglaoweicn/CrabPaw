/**
 * data-provenance.js — 数据出处链（P2，"这数从哪来"）
 *
 * 场景：老板/合作方问"本月营收 57.1 万这个数从哪来"。当前只能让模型念工具名，
 * 很难建立信任。本模块把**可核验的事实**整理成一条链路：
 *
 *   来源文件 → 导入时间 → 参与计算的行数 → 空值数 → 语义视图 → 指标
 *
 * 一条硬规则（本项目已吃过亏）：**只报可核验的事实，不猜**。
 *   · 缺某字段 → 如实留 null，界面显示"—"，不编造"约"、"估计"
 *   · 数据源不可用 → 明确报 unavailable 并给原因，而不是给一条空链路让人以为没数据
 *   · 视图在库里不存在 → 报 missing，而不是当成"0 行"
 *
 * 纯逻辑 + 只读查询，无副作用；供 /api/business/provenance 使用。
 */

const fs = require('fs');
const path = require('path');

/** 语义视图 → 中文标签（对齐 semantic-views 实际创建的视图名；
 *  实测本机只有 v_sales / v_receivable / v_contract，v_revenue 不在其中） */
const VIEW_LABELS = {
  v_sales: '营收',
  v_revenue: '营收',
  v_receivable: '应收',
  v_contract: '合同',
  v_purchase: '采购',
  v_payable: '应付',
  v_inventory: '库存',
  v_commodity: '商品',
};

/** 指标名 → 候选视图（按优先级；存在的第一个生效） */
const METRIC_VIEWS = {
  revenue: ['v_sales', 'v_revenue'],
  receivable: ['v_receivable'],
  contract: ['v_contract'],
  purchase: ['v_purchase'],
  payable: ['v_payable'],
  inventory: ['v_inventory'],
  commodity: ['v_commodity'],
};

const SOURCE_COL = '__source';

/** 只读打开业务库（失败返回 null，由调用方决定如何报告） */
function openReadonly(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath, { readonly: true });
  } catch (e) {
    console.warn('[provenance] 业务库只读打开失败:', e.message || e);
    return null;
  }
}

/** 安全查询：任何失败返回 null（调用方据此报 unavailable，而不是当成 0） */
function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null }
}
function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return null }
}

function tableExists(db, name, type) {
  const row = safeGet(db, "SELECT name FROM sqlite_master WHERE type = ? AND name = ?", [type, name]);
  return !!row;
}

function quoteIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}

/**
 * 解析某个指标的可溯源视图。
 * @returns {{ view: string|null, tried: string[] }}
 */
function resolveView(db, metric) {
  const tried = METRIC_VIEWS[metric] || [];
  for (const v of tried) {
    if (tableExists(db, v, 'view') || tableExists(db, v, 'table')) return { view: v, tried };
  }
  return { view: null, tried };
}

/**
 * 逐来源统计行数与关键列空值数（用于"参与计算的行数/空值数"）。
 * 只用视图自己携带的 `__source` 列——不猜表名、不做模糊匹配。
 * @returns {{ rows: number|null, sources: Array, error?: string }}
 *   rows=null 且带 error 表示**查询失败**（视图定义坏了等），调用方必须报不可用，
 *   不能当成"0 行"——两者对老板的含义完全不同。
 */
function describeSources(db, view, columns) {
  if (!tableExists(db, view, 'view') && !tableExists(db, view, 'table')) return { rows: null, sources: [], error: '视图不存在' };
  // 不用 safeGet：这里要把失败原因带出去，而不是吞掉
  let total;
  try {
    total = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(view)}`).get();
  } catch (e) {
    return { rows: null, sources: [], error: `视图查询失败：${e.message || e}` };
  }
  if (total == null) return { rows: null, sources: [], error: '视图计数返回空' };
  const rows = Number(total.c) || 0;
  if (!columns.includes(SOURCE_COL)) return { rows, sources: [] };
  try {
    const grouped = db.prepare(`SELECT ${quoteIdent(SOURCE_COL)} AS s, COUNT(*) AS c FROM ${quoteIdent(view)} GROUP BY ${quoteIdent(SOURCE_COL)} ORDER BY c DESC`).all();
    return { rows, sources: (grouped || []).map((g) => ({ table: g.s == null ? null : String(g.s), rows: Number(g.c) || 0 })) };
  } catch (e) {
    // 来源分布查不到不算致命：行数仍可信，但要如实说明缺了分布
    return { rows, sources: [], error: `来源分布查询失败：${e.message || e}` };
  }
}

/** 空值统计：对指定 canonical 列数 NULL（视图里 NULL 是"该表缺此列"的补位，是真事实） */
function countNulls(db, view, columns, targetCols) {
  const out = {};
  for (const col of targetCols) {
    if (!columns.includes(col)) { out[col] = null; continue; }
    const r = safeGet(db, `SELECT COUNT(*) AS c FROM ${quoteIdent(view)} WHERE ${quoteIdent(col)} IS NULL`);
    out[col] = r == null ? null : Number(r.c) || 0;
  }
  return out;
}

function viewColumns(db, view) {
  const cols = safeAll(db, `PRAGMA table_info(${quoteIdent(view)})`);
  return cols == null ? [] : cols.map((c) => String(c.name));
}

/**
 * 构建某个指标的完整出处链。
 *
 * @param {{ dbPath: string, metric: string, limitSources?: number }} params
 * @returns {{
 *   ok: boolean,
 *   metric: string,
 *   label: string,
 *   view: string | null,
 *   triedViews: string[],
 *   rows: number | null,
 *   nulls: Record<string, number|null>,
 *   sources: Array<{table, rows, sourceFile, importedAt, fileHash, rowCount, superseded}>,
 *   notes: string[],
 *   unavailableReason?: string
 * }}
 */
function buildProvenance({ dbPath, metric, limitSources = 8 }) {
  const label = VIEW_LABELS[(METRIC_VIEWS[metric] || [])[0]] || metric;
  const base = {
    ok: false,
    metric,
    label,
    view: null,
    triedViews: [],
    rows: null,
    nulls: {},
    sources: [],
    notes: [],
  };

  // 注册表（失败不致命——视图本身仍可查，只是少了导入元数据）
  let registryTables = [];
  try {
    // 延迟 require：本模块也可能在无注册表环境下被单测调用
    const bdr = require('../business-data-registry');
    registryTables = (bdr.listTables && bdr.listTables()) || [];
  } catch (e) {
    base.notes.push('注册表不可用，导入元数据缺失');
  }

  const db = openReadonly(dbPath);
  if (!db) {
    return {
      ...base,
      unavailableReason: dbPath ? `业务库不可读：${path.basename(String(dbPath))}` : '未配置业务库路径',
      notes: [...base.notes, '数据源不可用——这不是"没有数据"，而是取数失败'],
    };
  }

  try {
    const { view, tried } = resolveView(db, metric);
    if (!view) {
      return {
        ...base,
        triedViews: tried,
        unavailableReason: `未找到可溯源视图（已尝试：${tried.join(' / ') || '无候选'}）`,
        notes: [...base.notes, '视图不存在——可能尚未导入该业务数据'],
      };
    }

    const columns = viewColumns(db, view);
    const described = describeSources(db, view, columns);
    // 行数查不到 = 取数失败（不是"0 行"）：明确报不可用，绝不静默降级
    if (described.rows == null) {
      return {
        ...base,
        view,
        triedViews: tried,
        unavailableReason: described.error || '视图不可查询',
        notes: [...base.notes, '视图存在但查询失败——这不是"没有数据"，是取数失败'],
      };
    }
    const rows = described.rows;
    const sources = described.sources;
    if (described.error) base.notes.push(described.error);
    const canonicals = ['date', 'customer', 'product', 'supplier'].filter((c) => columns.includes(c));
    const nulls = countNulls(db, view, columns, canonicals);

    // 把视图内的来源表与注册表登记信息对上（拿导入时间/来源文件/哈希）
    const byName = new Map(registryTables.map((t) => [String(t.name), t]));
    const enriched = (sources.length > 0 ? sources : []).map((s) => {
      const reg = s.table ? byName.get(s.table) : null;
      return {
        table: s.table,
        rows: s.rows,
        sourceFile: reg?.sourceFile ?? null,
        importedAt: reg?.importedAt ?? null,
        fileHash: reg?.fileHash ?? null,
        rowCount: reg?.rowCount ?? null,
        superseded: !!reg?.superseded,
      };
    }).slice(0, limitSources);

    // 视图里出现但注册表没有的来源（例如手工建表）——如实列出，不隐藏
    const unregistered = (sources || []).filter((s) => s.table && !byName.has(s.table)).map((s) => s.table);
    if (unregistered.length > 0) base.notes.push(`有 ${unregistered.length} 张来源表未在注册表中登记（无法给出导入时间）`);
    // 已退役的表若仍出现在视图里，说明视图未重建
    const stale = enriched.filter((s) => s.superseded).map((s) => s.table);
    if (stale.length > 0) base.notes.push(`来源表 ${stale.join('、')} 已被取代但仍出现在视图中，建议重建视图`);

    return {
      ...base,
      ok: true,
      view,
      triedViews: tried,
      rows,
      nulls,
      sources: enriched,
      notes: base.notes,
    };
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }
}

module.exports = { buildProvenance, METRIC_VIEWS, VIEW_LABELS };
