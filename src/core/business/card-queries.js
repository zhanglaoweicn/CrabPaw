/**
 * card-queries — 业务卡取数查询（库存预警 / 客户汇总）
 *
 * 与 morning-briefing-service 同构：语义视图 v_* 优先，无视图/查询失败
 * 逐表回退（列名正则解析）。任何失败优雅降级，不抛错。
 */

const { listTables, listSemanticViews } = require('../business-data-registry');

function safeQuery(dbPath, sql, params = []) {
  try {
    if (!dbPath || !require('fs').existsSync(dbPath)) return null;
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn('[card-queries] 查询失败:', e.message || e);
    return null;
  }
}

function viewExists(dbPath, name) {
  return listSemanticViews().some((v) => v.name === name);
}

function getSQLiteTableNames(dbPath) {
  const rows = safeQuery(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return rows ? rows.map((r) => r.name) : [];
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

/**
 * 库存预警明细——库存预警卡取数。
 * 约定：库存表需成对出现"当前库存"列（canonical: inventory）与"安全库存"列
 * （canonical: safety）；当前 < 安全 即预警。
 * @returns {Array<{product: string|null, current: number, safety: number, gap: number}>}
 */
function listStockAlerts(dbPath, { limit = 20 } = {}) {
  const toRow = (r) => ({
    product: r.p || null,
    current: Number(r.cur || 0),
    safety: Number(r.saf || 0),
    gap: Number((r.saf || 0) - (r.cur || 0)),
  });
  if (viewExists(dbPath, 'v_inventory')) {
    const rows = safeQuery(dbPath,
      `SELECT ${q('product')} AS p, ${q('inventory')} AS cur, ${q('safety')} AS saf
       FROM ${q('v_inventory')}
       WHERE ${q('safety')} IS NOT NULL AND ${q('inventory')} IS NOT NULL AND ${q('inventory')} < ${q('safety')}
       ORDER BY (${q('safety')} - ${q('inventory')}) DESC LIMIT ?`,
      [limit]);
    if (rows) return rows.map(toRow);
    // 失败 → 逐表回退
  }
  const out = [];
  try {
    const tables = listTables().filter((t) => (!dbPath || t.dbPath === dbPath) && t.role === 'inventory' && !t.superseded);
    const sqliteTableNames = getSQLiteTableNames(dbPath);
    for (const t of tables) {
      const colNames = t.columns.map((c) => c.name);
      const canonicalOf = (c) => (t.columns.find((x) => x.name === c) || {}).canonical;
      const curCol = colNames.find((n) => canonicalOf(n) === 'inventory' || /(库存|现存|stock|quantity|qty)/i.test(n) && !/安全|safety/i.test(n));
      const safCol = colNames.find((n) => canonicalOf(n) === 'safety' || /安全库存|安全线|安全存量|safety/i.test(n));
      const prodCol = colNames.find((n) => canonicalOf(n) === 'product' || /(商品|品名|货品|产品|product)/i.test(n));
      if (!curCol || !safCol) continue;
      const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
      const rows = safeQuery(dbPath,
        `SELECT ${prodCol ? q(prodCol) : 'NULL'} AS p, ${q(curCol)} AS cur, ${q(safCol)} AS saf
         FROM ${q(tableName)}
         WHERE ${q(curCol)} IS NOT NULL AND ${q(safCol)} IS NOT NULL AND ${q(curCol)} < ${q(safCol)}
         ORDER BY (${q(safCol)} - ${q(curCol)}) DESC LIMIT ?`,
        [limit]);
      for (const r of rows || []) out.push(toRow(r));
    }
    out.sort((a, b) => b.gap - a.gap);
  } catch (e) {
    console.warn('[card-queries] 库存预警回退查询失败:', e.message || e);
  }
  return out.slice(0, limit);
}

/**
 * 客户维度汇总——客户跟进卡（过渡版）取数。
 * 汇总 v_sales（累计销售额/最近成交日）与 v_receivable（当前应收），按客户合并。
 * @returns {Array<{customer: string, totalSales: number|null, lastSaleDate: string|null, receivable: number|null}>}
 */
function summarizeCustomers(dbPath, { limit = 30 } = {}) {
  const sales = new Map(); // customer -> {totalSales, lastSaleDate}
  const recv = new Map(); // customer -> receivable
  if (viewExists(dbPath, 'v_sales')) {
    const rows = safeQuery(dbPath,
      `SELECT ${q('customer')} AS c, SUM(${q('revenue')}) AS t, MAX(${q('date')}) AS d
       FROM ${q('v_sales')} WHERE ${q('customer')} IS NOT NULL
       GROUP BY ${q('customer')} ORDER BY t DESC LIMIT ?`,
      [limit]);
    for (const r of rows || []) {
      if (!r.c) continue;
      sales.set(r.c, { totalSales: r.t != null ? Number(r.t) : null, lastSaleDate: r.d || null });
    }
  }
  if (viewExists(dbPath, 'v_receivable')) {
    const rows = safeQuery(dbPath,
      `SELECT ${q('customer')} AS c, SUM(${q('receivable')}) AS t
       FROM ${q('v_receivable')} WHERE ${q('customer')} IS NOT NULL AND ${q('receivable')} > 0
       GROUP BY ${q('customer')}`,
      []);
    for (const r of rows || []) {
      if (!r.c) continue;
      recv.set(r.c, r.t != null ? Number(r.t) : null);
    }
  }
  // 视图缺失时逐表回退（客户列正则）
  if (sales.size === 0 && recv.size === 0) {
    try {
      const tables = listTables().filter((t) => (!dbPath || t.dbPath === dbPath) && !t.superseded && ['revenue', 'receivable'].includes(t.role));
      const sqliteTableNames = getSQLiteTableNames(dbPath);
      for (const t of tables) {
        const colNames = t.columns.map((c) => c.name);
        const custCol = colNames.find((n) => /(客户|customer)/i.test(n));
        if (!custCol) continue;
        const dateCol = colNames.find((n) => /(日期|时间|date|time)/i.test(n));
        const valueCol = colNames.find((n) => t.role === 'revenue' ? /(销售额|金额|amount|revenue|sales|total)/i.test(n) : /(应收|欠款|回款|receivable|debt)/i.test(n));
        if (!valueCol) continue;
        const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
        const rows = safeQuery(dbPath,
          `SELECT ${q(custCol)} AS c, SUM(${q(valueCol)}) AS t${dateCol ? `, MAX(date(${q(dateCol)})) AS d` : ''}
           FROM ${q(tableName)} WHERE ${q(custCol)} IS NOT NULL GROUP BY ${q(custCol)} ORDER BY t DESC LIMIT ?`,
          [limit]);
        for (const r of rows || []) {
          if (!r.c) continue;
          if (t.role === 'revenue') sales.set(r.c, { totalSales: r.t != null ? Number(r.t) : null, lastSaleDate: (r.d || null) });
          else recv.set(r.c, r.t != null ? Number(r.t) : null);
        }
      }
    } catch (e) {
      console.warn('[card-queries] 客户汇总回退查询失败:', e.message || e);
    }
  }
  const customers = new Set([...sales.keys(), ...recv.keys()]);
  const out = [];
  for (const c of customers) {
    const s = sales.get(c) || {};
    out.push({
      customer: c,
      totalSales: s.totalSales ?? null,
      lastSaleDate: s.lastSaleDate ?? null,
      receivable: recv.has(c) ? recv.get(c) : null,
    });
  }
  out.sort((a, b) => (b.totalSales || b.receivable || 0) - (a.totalSales || a.receivable || 0));
  return out.slice(0, limit);
}

/**
 * 供应商维度汇总——供应商档案卡内部交易区块取数。
 * 汇总 v_purchase（canonical: supplier/purchase/product/date）：按供应商聚合
 * 采购总额/单数/最近采购日；supplier 参数指定时只返回该供应商。
 * @returns {Array<{supplier: string, totalPurchase: number|null, orderCount: number, lastPurchaseDate: string|null}>}
 */
function summarizeSuppliers(dbPath, { supplier, limit = 20 } = {}) {
  const rowsOf = (where, params) => safeQuery(dbPath,
    `SELECT ${q('supplier')} AS s, SUM(${q('purchase')}) AS t, COUNT(*) AS n, MAX(${q('date')}) AS d
     FROM ${q('v_purchase')}
     WHERE ${q('supplier')} IS NOT NULL AND ${q('purchase')} IS NOT NULL${where}
     GROUP BY ${q('supplier')} ORDER BY t DESC LIMIT ?`,
    params);
  if (viewExists(dbPath, 'v_purchase')) {
    const rows = supplier
      ? rowsOf(` AND ${q('supplier')} = ?`, [supplier, limit])
      : rowsOf('', [limit]);
    if (rows) {
      return rows.map((r) => ({ supplier: r.s, totalPurchase: r.t != null ? Number(r.t) : null, orderCount: Number(r.n || 0), lastPurchaseDate: r.d || null }));
    }
    // 失败 → 逐表回退
  }
  const out = new Map();
  try {
    const tables = listTables().filter((t) => (!dbPath || t.dbPath === dbPath) && t.role === 'purchase' && !t.superseded);
    const sqliteTableNames = getSQLiteTableNames(dbPath);
    for (const t of tables) {
      const colNames = t.columns.map((c) => c.name);
      const supCol = colNames.find((n) => /(供应商|vendor|supplier|卖方|乙方)/i.test(n));
      const valueCol = colNames.find((n) => /(采购金额|采购额|进货金额|金额|amount)/i.test(n));
      const dateCol = colNames.find((n) => /(日期|时间|date|time)/i.test(n));
      if (!supCol) continue;
      const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
      const rows = safeQuery(dbPath,
        `SELECT ${q(supCol)} AS s, ${valueCol ? `SUM(${q(valueCol)})` : 'NULL'} AS t, COUNT(*) AS n${dateCol ? `, MAX(date(${q(dateCol)})) AS d` : ', NULL AS d'}
         FROM ${q(tableName)} WHERE ${q(supCol)} IS NOT NULL${supplier ? ` AND ${q(supCol)} = ?` : ''}
         GROUP BY ${q(supCol)} ORDER BY t DESC LIMIT ?`,
        supplier ? [supplier, limit] : [limit]);
      for (const r of rows || []) {
        if (!r.s) continue;
        out.set(r.s, { supplier: r.s, totalPurchase: r.t != null ? Number(r.t) : null, orderCount: Number(r.n || 0), lastPurchaseDate: r.d || null });
      }
    }
  } catch (e) {
    console.warn('[card-queries] 供应商汇总回退查询失败:', e.message || e);
  }
  return [...out.values()].slice(0, limit);
}

module.exports = { listStockAlerts, summarizeCustomers, summarizeSuppliers };
