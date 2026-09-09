/**
 * semantic-views — 语义视图层（多源异构表 → 统一业务模型）
 *
 * 把同业务角色的多张导入表 UNION 成一张标准视图（v_*），列按
 * business-data-registry 的 canonical 语义对齐：无论用户导了几张表、
 * 列名叫"销售额"还是"营收金额"还是"Amount"，卡片与 NL2SQL 只查视图。
 *
 * 安全约束（重要）：NL2SQL 安全门 WRITE_PATTERN 禁止 CREATE——视图只能
 * 由本模块在导入流程内以可信代码创建，LLM 路径永远只 SELECT。
 *
 * 参与合并的表：同 role、同业务库、非 external（conn://）、未被 superseded、
 * 表在 SQLite 中真实存在。canonical 列取各表并集；某表缺某 canonical 列时
 * 该列以 NULL 补位（UNION ALL 列数必须一致）。附 source_table 溯源列。
 */

const { ROLE_VIEW_NAMES } = require('../business-data-registry');

// canonical 列的固定输出顺序（只含出现在各表并集里的）
const CANONICAL_ORDER = [
  'date', 'product', 'customer', 'supplier',
  'revenue', 'purchase', 'payable', 'receivable', 'inventory', 'safety', 'contract',
];

/** 对某个库连接做只读存在性检查（表/视图） */
function objectExists(db, name, type) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
  return !!row;
}

function quoteIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}

/**
 * 构建单表的 SELECT 片段：把该表各列按 canonical 对齐到统一列集
 * @param {Array<{name, canonical}>} cols 注册表列定义
 * @param {string[]} unionCols 统一列集（canonical 名）
 * @param {string} tableName 源表名（附 __source 溯源）
 */
function buildSelectForTable(cols, unionCols, tableName) {
  const byCanonical = new Map();
  for (const c of cols) {
    if (c.canonical && !byCanonical.has(c.canonical)) byCanonical.set(c.canonical, c.name);
  }
  const projections = unionCols.map((uc) => {
    const src = byCanonical.get(uc);
    return src ? `${quoteIdent(src)} AS ${quoteIdent(uc)}` : `NULL AS ${quoteIdent(uc)}`;
  });
  // 溯源列是字符串字面量（表名加引号会被当作列引用）
  projections.push(`'${tableName.replace(/'/g, "''")}' AS ${quoteIdent('__source')}`);
  return `SELECT ${projections.join(', ')} FROM ${quoteIdent(tableName)}`;
}

/**
 * 重建某业务库中全部语义视图
 * @param {{ dbPath: string, tables: Array<{name, role, direction, dbPath, external, superseded, columns}> }} params
 *   tables 传 business-data-registry.listTables() 的结果（已按 dbPath 过滤或在此过滤）
 * @returns {{ rebuilt: string[], dropped: string[], errors: string[] }}
 */
function rebuildSemanticViews({ dbPath, tables }) {
  let Database;
  try { Database = require('better-sqlite3'); } catch {
    return { rebuilt: [], dropped: [], errors: ['缺少 better-sqlite3'] };
  }
  const rebuilt = [];
  const dropped = [];
  const errors = [];
  let db;
  try {
    db = new Database(dbPath);

    // 按 role 分组（仅本库、非 external、未 superseded、视图名已定义的角色）
    const groups = new Map();
    for (const t of tables || []) {
      if (t.external || t.superseded) continue;
      if (t.dbPath !== dbPath) continue;
      const viewName = ROLE_VIEW_NAMES[t.role];
      if (!viewName) continue;
      if (!groups.has(t.role)) groups.set(t.role, { viewName, tables: [] });
      groups.get(t.role).tables.push(t);
    }

    // 现存 v_* 视图若不再有对应分组（表被清空/角色变化）→ 清理
    const existingViews = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name LIKE 'v_%'").all();
    for (const v of existingViews) {
      const stillHasGroup = [...groups.values()].some((g) => g.viewName === v.name);
      if (!stillHasGroup) {
        db.exec(`DROP VIEW IF EXISTS ${quoteIdent(v.name)}`);
        dropped.push(v.name);
      }
    }

    for (const [role, group] of groups) {
      try {
        // 只合并 SQLite 里真实存在的表
        const present = group.tables.filter((t) => objectExists(db, t.name, 'table'));
        if (present.length === 0) continue;

        // 统一列集 = 各表 canonical 并集（固定顺序优先，其余按首见序）
        const unionSet = [];
        const seen = new Set();
        const pushCanonical = (c) => {
          if (c && !seen.has(c)) { seen.add(c); unionSet.push(c); }
        };
        for (const canonical of CANONICAL_ORDER) {
          if (present.some((t) => t.columns.some((col) => col.canonical === canonical))) pushCanonical(canonical);
        }
        for (const t of present) {
          for (const col of t.columns) pushCanonical(col.canonical);
        }
        // 没有任何可对齐列（全部 canonical 为 null）→ 放弃建视图，不值得
        const meaningful = unionSet.filter((c) => c !== 'date');
        if (meaningful.length === 0) continue;

        const selects = present.map((t) => buildSelectForTable(t.columns, unionSet, t.name));
        const sql = `CREATE VIEW ${quoteIdent(group.viewName)} AS ${selects.join(' UNION ALL ')}`;
        db.exec(`DROP VIEW IF EXISTS ${quoteIdent(group.viewName)}`);
        db.exec(sql);
        rebuilt.push(group.viewName);
      } catch (e) {
        errors.push(`${role}: ${e.message || e}`);
      }
    }
  } catch (e) {
    errors.push(e.message || e);
  } finally {
    try { if (db) db.close(); } catch (e) { console.warn('[semantic-views] 关闭数据库失败:', e.message || e); }
  }
  return { rebuilt, dropped, errors };
}

module.exports = { rebuildSemanticViews, buildSelectForTable, CANONICAL_ORDER };
