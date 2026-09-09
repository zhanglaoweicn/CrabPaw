/**
 * BusinessRiskScan — 经营风险扫描（morning-briefing-service 裁剪后保留）
 *
 * 供 risk-alert-service 使用：统计逾期应收（date < 阈值）与临期合同（date 在
 * [today, today+7]）。任何数据源失败都优雅降级（查询失败返回 null / 空结果）。
 */

const fs = require('fs');
const path = require('path');
const { listTables } = require('../business-data-registry');

/** 只读执行 SQLite 查询（better-sqlite3，查询失败返回 null） */
function safeQuery(dbPath, sql, params = []) {
  try {
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn('[briefing] 业务库查询失败:', e.message || e);
    return null;
  }
}

/** 按日期列聚合 SUM（口径：date 列在 [start, end] 区间） */
async function queryBusinessAggregate(dbPath, tableName, valueColumn, dateColumn, startDate, endDate) {
  const sql = `SELECT SUM("${valueColumn.replace(/"/g, '""')}") AS total FROM "${tableName.replace(/"/g, '""')}" WHERE date("${dateColumn.replace(/"/g, '""')}") BETWEEN date(?) AND date(?)`;
  const rows = safeQuery(dbPath, sql, [startDate, endDate]);
  return rows && rows[0] && rows[0].total != null ? Number(rows[0].total) : null;
}

/** 从 SQLite 库获取实际表名列表 */
function getSQLiteTableNames(dbPath) {
  const rows = safeQuery(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return rows ? rows.map((r) => r.name) : [];
}

/** 统计逾期应收（date < 阈值）与临期合同（date 在 [today, today+7]） */
function scanBusinessRisks(dbPath, { today, overdueDays = 30 }) {
  const result = { receivableOverdue: 0, contractsExpiring: 0, totalReceivable: null };
  try {
    const tables = listTables().filter((t) => !dbPath || t.dbPath === dbPath);
    const sqliteTableNames = getSQLiteTableNames(dbPath);
    for (const t of tables) {
      const colNames = t.columns.map((c) => c.name);
      const valueCol = colNames.find((n) => /(金额|余额|欠款|amount|balance)/i.test(n));
      const dateCol = colNames.find((n) => /(日期|到期|date|expire)/i.test(n));
      const customerCol = colNames.find((n) => /(客户|customer)/i.test(n));
      if (!valueCol || !dateCol) continue;
      // 解析实际表名：优先用注册名（若在 SQLite 中存在），否则取第一个实际表名
      const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
      if (t.role === 'receivable') {
        const overdueDate = new Date(today);
        overdueDate.setDate(overdueDate.getDate() - overdueDays);
        const overdueDateStr = overdueDate.toISOString().slice(0, 10);
        const rows = safeQuery(dbPath,
          `SELECT COUNT(*) AS c, SUM("${valueCol.replace(/"/g, '""')}") AS s FROM "${tableName.replace(/"/g, '""')}" WHERE date("${dateCol.replace(/"/g, '""')}") < date(?) AND "${valueCol.replace(/"/g, '""')}" > 0`,
          [overdueDateStr]);
        if (rows && rows[0]) {
          result.receivableOverdue += Number(rows[0].c || 0);
          result.totalReceivable = (result.totalReceivable || 0) + Number(rows[0].s || 0);
        }
        if (customerCol && rows && rows[0]) {
          // 逾期客户 TOP3（供卡片明细）
          const top = safeQuery(dbPath,
            `SELECT "${customerCol.replace(/"/g, '""')}" AS c, SUM("${valueCol.replace(/"/g, '""')}") AS s FROM "${tableName.replace(/"/g, '""')}" WHERE date("${dateCol.replace(/"/g, '""')}") < date(?) AND "${valueCol.replace(/"/g, '""')}" > 0 GROUP BY c ORDER BY s DESC LIMIT 3`,
            [overdueDateStr]);
          if (top && top.length) result.topOverdueCustomers = top.map((r) => ({ customer: r.c, amount: r.s }));
        }
      } else if (t.role === 'contract') {
        const end = new Date(today);
        end.setDate(end.getDate() + 7);
        const endStr = end.toISOString().slice(0, 10);
        const rows = safeQuery(dbPath,
          `SELECT COUNT(*) AS c FROM "${tableName.replace(/"/g, '""')}" WHERE date("${dateCol.replace(/"/g, '""')}") BETWEEN date(?) AND date(?)`,
          [today, endStr]);
        if (rows && rows[0]) result.contractsExpiring += Number(rows[0].c || 0);
      }
    }
  } catch (e) {
    console.warn('[briefing] 风险扫描失败:', e.message || e);
  }
  return result;
}

/** 视图存在性检查（v_* 语义视图优先——canonical 列已在建视图时对齐） */
function viewExists(dbPath, name) {
  const rows = safeQuery(dbPath, "SELECT name FROM sqlite_master WHERE type='view' AND name = ?", [name]);
  return !!(rows && rows.length);
}

/**
 * 逾期应收明细（按客户聚合，金额降序）——应收账款卡取数。
 * 优先走语义视图 v_receivable（canonical: customer/receivable/date，跨异构源表
 * 统一）；无视图时逐表回退（列名正则解析，同 scanBusinessRisks 口径）。
 * @returns {Array<{customer: string, amount: number, dueDate: string|null, overdueDays: number|null}>}
 */
function listOverdueReceivables(dbPath, { today, overdueDays = 30, limit = 20 } = {}) {
  if (viewExists(dbPath, 'v_receivable')) {
    const rows = safeQuery(dbPath,
      `SELECT "customer" AS c, SUM("receivable") AS s, MIN("date") AS d
       FROM "v_receivable"
       WHERE "receivable" IS NOT NULL AND "receivable" > 0 AND date("date") < date(?, ?)
       GROUP BY "customer" ORDER BY s DESC LIMIT ?`,
      [today, `-${overdueDays} day`, limit]);
    if (rows) {
      return rows.map((r) => ({
        customer: r.c || '(未标注客户)',
        amount: Number(r.s || 0),
        dueDate: r.d || null,
        overdueDays: r.d ? Math.max(0, Math.round((new Date(today) - new Date(r.d)) / 86400000)) : null,
      }));
    }
    // 视图查询失败 → 落到逐表回退
  }
  // 回退：逐表正则解析（与 scanBusinessRisks 同口径）
  const out = [];
  try {
    const tables = listTables().filter((t) => (!dbPath || t.dbPath === dbPath) && t.role === 'receivable' && !t.superseded);
    const sqliteTableNames = getSQLiteTableNames(dbPath);
    const overdueDate = new Date(today);
    overdueDate.setDate(overdueDate.getDate() - overdueDays);
    const overdueDateStr = overdueDate.toISOString().slice(0, 10);
    for (const t of tables) {
      const colNames = t.columns.map((c) => c.name);
      const valueCol = colNames.find((n) => /(金额|余额|欠款|amount|balance)/i.test(n));
      const dateCol = colNames.find((n) => /(日期|到期|date|expire)/i.test(n));
      const customerCol = colNames.find((n) => /(客户|customer)/i.test(n));
      if (!valueCol || !dateCol) continue;
      const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
      const rows = safeQuery(dbPath,
        `SELECT ${customerCol ? `"${customerCol.replace(/"/g, '""')}"` : "''"} AS c, SUM("${valueCol.replace(/"/g, '""')}") AS s, MIN(date("${dateCol.replace(/"/g, '""')}")) AS d
         FROM "${tableName.replace(/"/g, '""')}"
         WHERE date("${dateCol.replace(/"/g, '""')}") < date(?) AND "${valueCol.replace(/"/g, '""')}" > 0
         ${customerCol ? 'GROUP BY c' : ''} ORDER BY s DESC LIMIT ?`,
        [overdueDateStr, limit]);
      for (const r of rows || []) {
        if (r.s == null) continue;
        out.push({
          customer: r.c || '(未标注客户)',
          amount: Number(r.s),
          dueDate: r.d || null,
          overdueDays: r.d ? Math.max(0, Math.round((new Date(today) - new Date(r.d)) / 86400000)) : null,
        });
      }
    }
    out.sort((a, b) => b.amount - a.amount);
  } catch (e) {
    console.warn('[briefing] 逾期应收明细回退查询失败:', e.message || e);
  }
  return out.slice(0, limit);
}

/**
 * 临期合同明细（按到期日升序）——合同到期卡取数。
 * 视图优先 v_contract（canonical: date=到期日/contract=金额/customer），回退逐表。
 * @returns {Array<{customer: string|null, amount: number|null, expireDate: string, daysLeft: number}>}
 */
function listExpiringContracts(dbPath, { today, days = 30, limit = 20 } = {}) {
  const daysLeftOf = (d) => Math.max(0, Math.round((new Date(d) - new Date(today)) / 86400000));
  if (viewExists(dbPath, 'v_contract')) {
    const rows = safeQuery(dbPath,
      `SELECT "customer" AS c, SUM("contract") AS s, MIN("date") AS d, COUNT(*) AS n
       FROM "v_contract"
       WHERE date("date") BETWEEN date(?) AND date(?, ?)
       GROUP BY "customer", "date" ORDER BY d ASC LIMIT ?`,
      [today, today, `+${days} day`, limit]);
    if (rows) {
      return rows.map((r) => ({
        customer: r.c || null,
        amount: r.s != null ? Number(r.s) : null,
        expireDate: r.d,
        daysLeft: daysLeftOf(r.d),
        count: r.n || 1,
      }));
    }
    // 视图查询失败 → 落到逐表回退
  }
  const out = [];
  try {
    const tables = listTables().filter((t) => (!dbPath || t.dbPath === dbPath) && t.role === 'contract' && !t.superseded);
    const sqliteTableNames = getSQLiteTableNames(dbPath);
    const end = new Date(today);
    end.setDate(end.getDate() + days);
    const endStr = end.toISOString().slice(0, 10);
    for (const t of tables) {
      const colNames = t.columns.map((c) => c.name);
      const dateCol = colNames.find((n) => /(日期|到期|date|expire)/i.test(n));
      const valueCol = colNames.find((n) => /(金额|amount|balance)/i.test(n));
      const customerCol = colNames.find((n) => /(客户|对方|customer|party)/i.test(n));
      if (!dateCol) continue;
      const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
      const rows = safeQuery(dbPath,
        `SELECT ${customerCol ? `"${customerCol.replace(/"/g, '""')}"` : 'NULL'} AS c, ${valueCol ? `"${valueCol.replace(/"/g, '""')}"` : 'NULL'} AS s, date("${dateCol.replace(/"/g, '""')}") AS d
         FROM "${tableName.replace(/"/g, '""')}"
         WHERE date("${dateCol.replace(/"/g, '""')}") BETWEEN date(?) AND date(?)
         ORDER BY d ASC LIMIT ?`,
        [today, endStr, limit]);
      for (const r of rows || []) {
        if (!r.d) continue;
        out.push({ customer: r.c || null, amount: r.s != null ? Number(r.s) : null, expireDate: r.d, daysLeft: daysLeftOf(r.d), count: 1 });
      }
    }
    out.sort((a, b) => (a.expireDate < b.expireDate ? -1 : 1));
  } catch (e) {
    console.warn('[briefing] 临期合同明细回退查询失败:', e.message || e);
  }
  return out.slice(0, limit);
}

/**
 * 营收区间合计（视图优先 v_sales，回退逐表正则）。
 * @returns {number|null}
 */
function sumRevenueInRange(dbPath, startDate, endDate) {
  if (viewExists(dbPath, 'v_sales')) {
    const rows = safeQuery(dbPath,
      `SELECT SUM("revenue") AS t FROM "v_sales" WHERE date("date") BETWEEN date(?) AND date(?)`,
      [startDate, endDate]);
    return rows && rows[0] && rows[0].t != null ? Number(rows[0].t) : null;
  }
  let total = null;
  try {
    const tables = listTables().filter((t) => (!dbPath || t.dbPath === dbPath) && t.role === 'revenue' && !t.superseded);
    const sqliteTableNames = getSQLiteTableNames(dbPath);
    for (const t of tables) {
      const colNames = t.columns.map((c) => c.name);
      const valueCol = colNames.find((n) => /(金额|销售额|amount|revenue|sales|total)/i.test(n));
      const dateCol = colNames.find((n) => /(日期|时间|date|time)/i.test(n));
      if (!valueCol || !dateCol) continue;
      const tableName = sqliteTableNames.includes(t.name) ? t.name : (sqliteTableNames[0] || t.name);
      const v = queryBusinessAggregate(dbPath, tableName, valueCol, dateCol, startDate, endDate);
      if (v != null) total = (total || 0) + v;
    }
  } catch (e) {
    console.warn('[briefing] 营收回退聚合失败:', e.message || e);
  }
  return total;
}

function prevMonthRange(today) {
  const [y, m] = today.split('-').map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const start = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  const lastDay = new Date(prevY, prevM, 0).getDate();
  return { start, end: `${prevY}-${String(prevM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * 经营简报快照——经营简报卡取数。
 * 本月/上月营收 + 环比 + 昨日营收 + 风险摘要（复用 scanBusinessRisks）。
 */
function buildBriefingSnapshot(dbPath, { today } = {}) {
  const t = today || new Date().toISOString().slice(0, 10);
  const monthStart = `${t.slice(0, 8)}01`;
  const prev = prevMonthRange(t);
  const yesterdayDate = new Date(t);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const month = sumRevenueInRange(dbPath, monthStart, t);
  const prevMonth = sumRevenueInRange(dbPath, prev.start, prev.end);
  const yday = sumRevenueInRange(dbPath, yesterday, yesterday);
  const risks = scanBusinessRisks(dbPath, { today: t });
  const deltaPct = month != null && prevMonth != null && prevMonth > 0
    ? Math.round(((month - prevMonth) / prevMonth) * 1000) / 10
    : null;
  return {
    date: t,
    revenue: { month, prevMonth, yesterday: yday, deltaPct },
    risks: {
      receivableOverdue: risks.receivableOverdue,
      totalReceivable: risks.totalReceivable,
      contractsExpiring: risks.contractsExpiring,
    },
    generatedAt: Date.now(),
  };
}

module.exports = { queryBusinessAggregate, scanBusinessRisks, listOverdueReceivables, listExpiringContracts, buildBriefingSnapshot, sumRevenueInRange };
