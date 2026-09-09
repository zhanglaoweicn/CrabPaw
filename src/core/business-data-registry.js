/**
 * BusinessDataRegistry — 经营数据源注册表
 *
 * 记录所有导入的业务表（表名/库路径/列结构/业务角色启发式识别），
 * 供 NL2SQL Schema 注入与播报服务聚合（Task 5/6）。
 * 持久化: data/.crabpaw/business/registry.json
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const BUSINESS_DIR = path.join(config.DATA_DIR, 'business');
const REGISTRY_FILE = path.join(BUSINESS_DIR, 'registry.json');

// 业务角色启发式：列名 → 业务域。
// 顺序敏感：采购语境列（采购金额）须先于 revenue 的 /金额/ 命中，否则方向反转。
// dimension: true 的角色是实体维度列（供应商/客户/商品），参与方向推断与视图
// 对齐，但不参与表角色投票——表角色表达的是"这张表记录什么业务"。
const ROLE_RULES = [
  { role: 'supplier', dimension: true, match: /(供应商|vendor|supplier|卖方|乙方)/i },
  { role: 'customer', dimension: true, match: /(客户名称|客户名|客户|customer|client)/i },
  { role: 'product', dimension: true, match: /(商品|货品|品名|产品|product)/i },
  { role: 'purchase', match: /(采购|进货|purchase|procurement)/i },
  { role: 'payable', match: /(应付|付款|payable)/i },
  { role: 'receivable', match: /(应收|欠款|回款|receivable|debt)/i },
  { role: 'contract', match: /(合同|到期|续约|contract|expire|renew)/i },
  { role: 'revenue', match: /(营收|收入|销售额|金额|amount|revenue|sales|price|total)/i },
  { role: 'inventory', match: /(库存|数量|存货|stock|quantity|qty)/i },
  { role: 'date', match: /(日期|时间|date|time|day)/i },
];

// 列别名库：canonical 语义 → 高频列名变体。导入时为每列精确匹配（忽略大小写，
// 不做子串猜测）标注 canonical，供语义视图（v_*）对齐异构源表列。
// 映射不上的列 canonical 为 null——留给用户确认，不自动猜。
const COLUMN_ALIASES = {
  date: ['日期', '时间', '订单日期', '创建时间', '到期日', '到期日期', 'date', 'time'],
  product: ['商品名称', '商品', '货品', '品名', '产品', 'product', 'item'],
  customer: ['客户名称', '客户名', '客户', 'customer', 'client'],
  supplier: ['供应商名称', '供应商', 'vendor', 'supplier'],
  revenue: ['销售额', '营收', '营收金额', '收入', '销售金额', '金额', '合计', '总价', 'amount', 'revenue', 'sales', 'total'],
  purchase: ['采购金额', '采购额', '进货金额', '采购价', 'purchase_amount', 'purchase', 'procurement'],
  payable: ['应付金额', '应付账款', '付款金额', 'payable', 'payment_due'],
  inventory: ['库存数量', '库存量', '现存数量', '安全库存', 'stock', 'quantity', 'qty'],
  safety: ['安全库存', '安全线', '安全存量', 'safety_stock', 'safety'],
  receivable: ['应收金额', '应收账款', '欠款金额', '回款金额', 'receivable', 'debt'],
  contract: ['合同金额', 'contract_amount'],
};

// 语义视图命名：表角色 → 视图名（revenue 的交易语义是销售流水，视图名用 v_sales）
const SEMANTIC_VIEW_ROLE = {
  v_sales: 'revenue',
  v_purchase: 'purchase',
  v_payable: 'payable',
  v_receivable: 'receivable',
  v_inventory: 'inventory',
  v_contract: 'contract',
};
const ROLE_VIEW_NAMES = Object.fromEntries(Object.entries(SEMANTIC_VIEW_ROLE).map(([v, r]) => [r, v]));

/** 识别单列业务角色 */
function detectColumnRole(name) {
  for (const r of ROLE_RULES) {
    if (r.match.test(name)) return r.role;
  }
  return null;
}

/** 识别单列 canonical 语义（精确别名匹配，不猜） */
function detectCanonicalName(name) {
  const key = String(name).trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === key)) return canonical;
  }
  return null;
}

/** 识别整表业务角色（按列角色投票；维度列与日期列不投票） */
function detectTableRole(columns) {
  const votes = {};
  for (const r of ROLE_RULES) {
    if (!r.dimension && r.role !== 'date') votes[r.role] = 0;
  }
  for (const c of columns) {
    const role = detectColumnRole(c.name);
    if (role && role in votes) votes[role] += 1;
  }
  let best = null;
  let bestScore = 0;
  for (const [role, score] of Object.entries(votes)) {
    if (score > bestScore) { bestScore = score; best = role; }
  }
  return bestScore > 0 ? best : null;
}

// 表级方向推断：进/销方向是"表"的属性——金额列在采购表和销售表里长得
// 一样（都叫金额），列级正则判不出方向。供应商/采购列在场 → 采购优先。
const DIRECTION_RULES = [
  { direction: 'purchase', match: /(供应商|vendor|supplier|卖方|乙方|采购|进货|purchase|procurement)/i },
  { direction: 'sales', match: /(客户|customer|client|销售|营收|销售额|sales|revenue)/i },
];

/** 推断整表业务方向（purchase=买入 / sales=卖出），无信号返回 null */
function inferTableDirection(columns) {
  for (const r of DIRECTION_RULES) {
    if (columns.some((c) => r.match.test(c.name || ''))) return r.direction;
  }
  return null;
}

function ensureDir() {
  fs.mkdirSync(BUSINESS_DIR, { recursive: true });
}

function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_FILE)) return { tables: [] };
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return { tables: Array.isArray(raw.tables) ? raw.tables : [] };
  } catch (e) {
    console.error('[business-data-registry] 读取注册表失败:', e.message || e);
    return { tables: [] };
  }
}

function saveRegistry(registry) {
  ensureDir();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8');
}

/**
 * 注册一张导入表
 * @param {{ name: string, dbPath: string, sourceFile: string, columns: Array<{name, type}>, rowCount: number, direction?: string, fileHash?: string }} meta
 * @returns {{ role: string|null, direction: string|null, columns: Array<{name, type, role: string|null, canonical: string|null}> }}
 */
function registerTable(meta) {
  const registry = loadRegistry();
  const cols = (meta.columns || []).map((c) => ({
    name: c.name,
    type: c.type,
    role: detectColumnRole(c.name),
    canonical: detectCanonicalName(c.name),
  }));
  const role = meta.role || detectTableRole(cols);
  const direction = meta.direction || inferTableDirection(cols);
  const entry = {
    name: meta.name,
    dbPath: meta.dbPath,
    sourceFile: meta.sourceFile,
    rowCount: meta.rowCount || 0,
    role,
    direction,
    fileHash: meta.fileHash || null,
    columns: cols,
    importedAt: Date.now(),
  };
  const idx = registry.tables.findIndex((t) => t.name === entry.name);
  if (idx >= 0) registry.tables[idx] = entry; else registry.tables.push(entry);
  saveRegistry(registry);
  return { role, direction, columns: cols };
}

function listTables() {
  return loadRegistry().tables;
}

function getTable(name) {
  return loadRegistry().tables.find((t) => t.name === name) || null;
}

// 2026-08-25 DataPoint: 导入历史版本流（"上传的历史记录"——每次导入均留档, 供回溯/累计口径）
function recordDataPoint({ table, role, rowCount, fileHash, checksum, semanticType }) {
  const dbPath = path.join(BUSINESS_DIR, "business.db");
  let Database;
  try { Database = require('better-sqlite3'); } catch { return { ok: false, error: '缺少 better-sqlite3' }; }
  try {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS import_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, role TEXT, semantic_type TEXT, row_count INTEGER NOT NULL DEFAULT 0, file_hash TEXT, checksum TEXT, imported_at INTEGER NOT NULL, superseded_at INTEGER)');
    const info = db.prepare('INSERT INTO import_history (table_name, role, semantic_type, row_count, file_hash, checksum, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(table, role || null, semanticType || null, rowCount || 0, fileHash || null, checksum || null, Date.now());
    db.close();
    return { ok: true, id: info.lastInsertRowid };
  } catch (e) { console.error("[datapoint] 记录失败:", e.message || e); return { ok: false, error: e.message }; }
}

function listDataPoints(table) {
  const dbPath = path.join(BUSINESS_DIR, 'business.db');
  let Database;
  try { Database = require('better-sqlite3'); } catch { return { ok: false, error: '缺少 better-sqlite3' }; }
  try {
    const db = new Database(dbPath);
    const rows = table
      ? db.prepare('SELECT * FROM import_history WHERE table_name = ? ORDER BY imported_at DESC').all(table)
      : db.prepare('SELECT * FROM import_history ORDER BY imported_at DESC LIMIT 200').all();
    db.close();
    return { ok: true, rows };
  } catch (e) { return { ok: false, error: e.message }; }
}

function removeTable(name) {
  const registry = loadRegistry();
  const before = registry.tables.length;
  registry.tables = registry.tables.filter((t) => t.name !== name);
  if (registry.tables.length !== before) saveRegistry(registry);
  return registry.tables.length !== before;
}

/**
 * 标记表被取代（superseded）：语义视图重建时排除、getSchemaPrompt 降权。
 * 两种触发：
 *   - mode=replace 同名重导：只给 import_history 旧打点退役（markRegistry=false），
 *     registry 条目是刚导入的新内容，绝不能标；
 *   - 同 fileHash 重传（不同表名）：内容与已有表完全一致，旧表整表退役
 *     （registry 条目 + import_history 双标）。
 * import_history.superseded_at 字段 2026-08-25 预留至今，此处首次写入。
 */
function markTableSuperseded(name, { markRegistry = true, dbPath } = {}) {
  if (markRegistry) {
    const registry = loadRegistry();
    const entry = registry.tables.find((t) => t.name === name);
    if (entry) {
      entry.superseded = true;
      saveRegistry(registry);
    }
  }
  let Database;
  try { Database = require('better-sqlite3'); } catch { return { ok: false, error: '缺少 better-sqlite3' }; }
  try {
    const target = dbPath || path.join(BUSINESS_DIR, 'business.db');
    const db = new Database(target);
    db.prepare('UPDATE import_history SET superseded_at = ? WHERE table_name = ? AND superseded_at IS NULL')
      .run(Date.now(), name);
    db.close();
    return { ok: true };
  } catch (e) {
    console.warn('[business-data-registry] superseded 打标失败(不阻塞):', e.message || e);
    return { ok: false, error: e.message };
  }
}

/** 生成 LLM 可用的 Schema 提示块（NL2SQL 注入用）。语义视图（v_*）列在源表之前。 */
function getSchemaPrompt() {
  const tables = loadRegistry().tables;
  if (tables.length === 0) return '';
  const lines = [];
  const views = listSemanticViews();
  for (const v of views) {
    lines.push(`视图 ${v.name}${v.role ? ` [业务角色:${v.role}·多表合并]` : ''}: ${v.columns.join(', ')}`);
  }
  for (const t of tables) {
    if (t.superseded) continue; // 被取代的旧表不进 schema，防 LLM 查到双份
    const cols = t.columns.map((c) => `${c.name}${c.role ? `(${c.role})` : ''}`).join(', ');
    lines.push(`表 ${t.name}${t.role ? ` [业务角色:${t.role}]` : ''}: ${cols}`);
  }
  return lines.join('\n');
}

/**
 * 列出业务库中现存语义视图（v_*）。只读探测、失败静默（无库/无 better-sqlite3 返回空）。
 */
function listSemanticViews() {
  let Database;
  try { Database = require('better-sqlite3'); } catch { return []; }
  try {
    const dbPath = path.join(BUSINESS_DIR, 'business.db');
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='view' AND name LIKE 'v_%'").all();
    db.close();
    return rows.map((r) => {
      // 从 CREATE VIEW 语句提取视图列清单（生成端恒输出带引号别名：
      // "源列" AS "canonical"，引号约束避免把 SELECT/FROM 关键字抓进来）
      const cols = [];
      const re = /AS\s+"([^"]+)"/gi;
      let m;
      while ((m = re.exec(r.sql || '')) !== null) cols.push(m[1]);
      return { name: r.name, columns: cols, role: SEMANTIC_VIEW_ROLE[r.name] || null };
    });
  } catch (e) {
    console.warn('[business-data-registry] 语义视图探测失败:', e.message || e);
    return [];
  }
}

/** 注册 external 表（企业数据库连接同步而来，dbPath 用 conn://<id>） */
function registerExternalTable({ connId, tableName, columns, rowCount = 0 }) {
  const registry = loadRegistry();
  const cols = (columns || []).map((c) => ({ name: c.name, type: c.type, role: detectColumnRole(c.name) }));
  const role = detectTableRole(cols);
  const entry = {
    name: tableName,
    dbPath: `conn://${connId}`,
    sourceFile: `conn://${connId}`,
    rowCount,
    role,
    external: true,
    columns: cols,
    importedAt: Date.now(),
  };
  const idx = registry.tables.findIndex((t) => t.name === entry.name);
  if (idx >= 0) registry.tables[idx] = entry; else registry.tables.push(entry);
  saveRegistry(registry);
  return { role, columns: cols };
}

module.exports = {
  recordDataPoint,
  listDataPoints,
  BUSINESS_DIR,
  REGISTRY_FILE,
  registerTable,
  registerExternalTable,
  listTables,
  getTable,
  removeTable,
  markTableSuperseded,
  listSemanticViews,
  getSchemaPrompt,
  detectColumnRole,
  detectCanonicalName,
  detectTableRole,
  inferTableDirection,
  ROLE_VIEW_NAMES,
};
