/**
 * Database Tools — 数据库查询工具
 *
 * 支持 SQLite、MySQL、PostgreSQL 三种数据库。
 * SQLite 用 better-sqlite3（降级 sqlite3 CLI）；MySQL/PostgreSQL 用 mysql2/pg 驱动直连。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');
const { getDataDir } = require('../core/config');
const { BUSINESS_DIR } = require('../core/business-data-registry');

// 业务库默认路径（2026-09-06): DatabaseQuery 未传 database 时 sqlite 默认指向此处
const BUSINESS_DB_PATH = require('path').join(BUSINESS_DIR, 'business.db');

const { Nl2SqlEngine } = require('../core/nl2sql/nl2sql-engine');

const NL2SQL_LIMIT = 200; // NL 路径强制结果上限

/**
 * 获取 sqlite 库的表清单与表结构（供 NL2SQL schema 注入）
 */
async function _sqliteSchema(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    const result = [];
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).all();
      result.push({
        name: t.name,
        columns: cols.map((c) => ({ name: c.name, type: c.type })),
      });
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * 构建数据库 Schema 信息（NL2SQL 提示注入用）
 * @returns {Promise<{ tables: Array<{ name: string, columns: Array<{ name: string, type?: string }> }> }>}
 */
async function buildSchemaInfoForDb(params, context) {
  const { type = 'sqlite', database } = params;
  try {
    if (type === 'sqlite') {
      if (!database) return { tables: [] };
      const resolvedPath = path.resolve(database);
      const workspaceDir = context?.workspaceDir ? path.resolve(context.workspaceDir) : null;
      const dataDir = getDataDir();
      const inWorkspace = workspaceDir && (resolvedPath === workspaceDir || resolvedPath.startsWith(workspaceDir + path.sep));
      const inDataDir = resolvedPath === dataDir || resolvedPath.startsWith(dataDir + path.sep);
      if (!inWorkspace && !inDataDir) return { tables: [] };
      return { tables: await _sqliteSchema(resolvedPath) };
    }
    return { tables: [] };
  } catch (e) {
    console.error('[database-tools] buildSchemaInfoForDb 失败:', e.message || e);
    return { tables: [] };
  }
}

async function handleListTables(params, context) {
  const { type = 'sqlite', database, host, port, user, password } = params;
  try {
    if (type === 'sqlite') {
      if (!database) return { success: false, error: 'SQLite 需要 database 参数（文件路径）' };
      const schema = await buildSchemaInfoForDb({ type, database }, context);
      return { success: true, type, database, tables: schema.tables.map((t) => t.name) };
    }
    if (type === 'mysql') {
      const rows = await _queryMySQL({ host, port, user, password, database }, 'SHOW TABLES');
      const key = rows[0] ? Object.keys(rows[0])[0] : null;
      return { success: true, type, database, tables: key ? rows.map((r) => r[key]) : [] };
    }
    if (type === 'postgresql') {
      const lines = await _queryPostgres({ host, port, user, password, database },
        "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
      return { success: true, type, database, tables: lines };
    }
    return { success: false, error: `不支持的数据库类型: ${type}` };
  } catch (e) {
    console.error('[database-tools] handleListTables 失败:', e.message || e);
    return { success: false, error: `列表面失败: ${e.message}` };
  }
}

async function handleDescribeTable(params, context) {
  const { type = 'sqlite', database, table, host, port, user, password } = params;
  if (!table || typeof table !== 'string') return { success: false, error: '缺少 table 参数' };
  if (table.includes(';') || /^sqlite_/i.test(table)) return { success: false, error: '非法表名' };
  try {
    if (type === 'sqlite') {
      if (!database) return { success: false, error: 'SQLite 需要 database 参数' };
      const schema = await buildSchemaInfoForDb({ type, database }, context);
      const t = schema.tables.find((x) => x.name === table);
      if (!t) return { success: false, error: `表不存在: ${table}` };
      return { success: true, type, database, table, columns: t.columns };
    }
    return { success: false, error: 'DescribeTable v1 仅支持 sqlite' };
  } catch (e) {
    console.error('[database-tools] handleDescribeTable 失败:', e.message || e);
    return { success: false, error: `表结构查询失败: ${e.message}` };
  }
}

/** 判断字符串是否为自然语言问句（含中文或 SQL 关键字缺失） */
function looksLikeNaturalLanguage(q) {
  if (!q) return false;
  if (/[一-鿿]/.test(q)) return true;
  const first = q.trim().toUpperCase();
  const sqlish = /^(SELECT|EXPLAIN|PRAGMA|SHOW|DESCRIBE|ANALYZE|WITH|\.)/;
  return !sqlish.test(first) && q.trim().split(/\s+/).length <= 6;
}

const QUERY_TIMEOUT = 30000;
const MAX_ROWS = 500;

function _exec(cmd, args, stdin = null, env = null) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      timeout: QUERY_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: env || process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) return reject(new Error('查询超时'));
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
    if (stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function _querySQLite(dbPath, query) {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库文件不存在: ${dbPath}`);

  // 优先使用 better-sqlite3（Node.js 原生绑定）
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(query).all();
    db.close();
    return rows;
  } catch { console.warn('[database-tools] better-sqlite3 failed, degrading to sqlite3 CLI:'); }

  // 降级：使用 sqlite3 CLI（-readonly 强制只读打开，防止绕过只读契约写库）
  if (hasMultiStatement(query)) {
    throw new Error('SQLite CLI 降级路径不支持多语句查询（本工具为只读契约）');
  }
  const jsonScript = `.mode json\n.headers on\n${query}`;
  try {
    const result = await _exec('sqlite3', ['-readonly', dbPath], jsonScript);
    return result ? JSON.parse(result) : [];
  } catch (e) {
    throw new Error('SQLite 查询失败。需要 better-sqlite3 模块或 sqlite3 CLI。');
  }
}

/**
 * 检测多语句 SQL（剥离字符串字面量后检查分号），用于 CLI 降级路径防注入
 */
function hasMultiStatement(sql) {
  if (!sql || typeof sql !== 'string') return false;
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, '');
  return stripped.includes(';');
}

/**
 * 语句级只读校验（MySQL/PostgreSQL 路径）：在建立连接前执行，fail fast。
 * - 拒绝多语句：剥离字符串字面量/注释后按 ';' 拆分，非空语句 > 1 即拒
 *   （单条语句尾随分号放行）。
 * - 拒绝写关键词：word-boundary 正则，出现在 WITH CTE / 子查询 / UNION
 *   后半段也拦（此前 handleDatabaseQuery 只靠 startsWith 前缀判断，
 *   `WITH x AS(...) DELETE FROM ...` 可整条绕过）。REPLACE() 函数形态
 *   除外（MySQL 字符串函数），REPLACE INTO 写入形态仍拦。
 * 与 handleDatabaseQuery 的前缀白名单构成双保险；SQLite 路径由
 * better-sqlite3 readonly:true + CLI -readonly 兜底。
 */
function _assertReadOnlyQuery(query) {
  if (!query || typeof query !== 'string') {
    throw new Error('只读校验失败: 查询为空');
  }
  const stripped = query
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    throw new Error(`只读校验失败: 不允许多语句查询（检测到 ${statements.length} 条语句）`);
  }
  // 2026-08 审查修复 I3：SELECT ... INTO OUTFILE/DUMPFILE 是服务端文件写原语
  //（可写任意服务端可写路径），语句级拒绝（word-boundary + 多空白容忍，大小写不敏感）。
  if (/\binto\s+(outfile|dumpfile)\b/i.test(stripped)) {
    throw new Error('只读校验失败: 检测到写原语 INTO OUTFILE/DUMPFILE（服务端文件写入），本工具为只读契约');
  }
  // 2026-08 审查修复 I4：`SHOW CREATE TABLE xxx` 是纯读语句（返回建表 DDL 文本，
  // 不执行任何 DDL），豁免其 CREATE 关键词；真 DDL（CREATE TABLE ...）无 SHOW 前缀仍拦，
  // 混入其他写关键词（如 SHOW CREATE TABLE t; DROP ...）先被多语句拒绝。
  const isShowCreate = /^show\s+create\s+(table|view|procedure|function|trigger)\s+\S/i.test(statements[0] || '');
  const kwRe = /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|attach|detach|pragma)\b(?!\s*\()/gi;
  let m;
  while ((m = kwRe.exec(stripped))) {
    if (isShowCreate && m[1].toLowerCase() === 'create') continue;
    throw new Error(`只读校验失败: 检测到写操作关键词 ${m[1].toUpperCase()}，本工具为只读契约`);
  }
}

async function _queryMySQL(connStr, query) {
  _assertReadOnlyQuery(query); // 语句级只读校验（建连接前 fail fast）
  const mysql = require('mysql2/promise');
  let conn;
  try {
    conn = await mysql.createConnection({
      host: connStr.host, port: connStr.port || 3306, user: connStr.user,
      password: connStr.password || '', database: connStr.database,
      connectTimeout: 15000,
    });
    const [rows] = await conn.query({ sql: query, timeout: QUERY_TIMEOUT });
    return rows;
  } catch (e) {
    throw new Error(`MySQL 查询失败: ${e.message}`);
  } finally {
    if (conn) { try { await conn.end(); } catch (e) { console.warn('[database-tools] mysql 关闭失败:', e.message || e); } }
  }
}

async function _queryPostgres(connStr, query) {
  _assertReadOnlyQuery(query); // 语句级只读校验（建连接前 fail fast）
  const { Client } = require('pg');
  const client = new Client({
    host: connStr.host, port: connStr.port || 5432, user: connStr.user,
    password: connStr.password || '', database: connStr.database,
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
    // 会话级只读兜底：即使语句校验被绕过，服务端也拒绝写事务
    await client.query('SET default_transaction_read_only = on');
    const res = await client.query({ text: query, query_timeout: QUERY_TIMEOUT });
    // 兼容 ListTables 取 tablename 单列：返回第一列值数组；多列返回对象数组
    const fields = res.fields || [];
    if (fields.length === 1) return res.rows.map((r) => r[fields[0].name]);
    return res.rows;
  } catch (e) {
    throw new Error(`PostgreSQL 查询失败: ${e.message}`);
  } finally {
    try { await client.end(); } catch (e) { console.warn('[database-tools] pg 关闭失败:', e.message || e); }
  }
}

async function handleDatabaseQuery(params, context) {
  let { type = 'sqlite', database, query, host, port, user, password } = params;

  type = params.type || 'sqlite';
  // 2026-09-06: sqlite 未传 database 时默认指向业务库——导入的经营数据
  //（应收/营收/合同/库存等，经 v_* 语义视图）都在这里。此前模型必须自己猜
  // 业务库路径，猜不中就放弃查询改翻文件（实机：财务问答全走 DocRead 翻 xlsx）。
  database = params.database || (type === 'sqlite' ? BUSINESS_DB_PATH : undefined);
  host = params.host;
  port = params.port;
  user = params.user;
  password = params.password;


  const hasQuestion = !!params.question;
  if ((!query || typeof query !== 'string') && !hasQuestion) {
    return { success: false, error: '缺少 query 参数（SQL 查询语句，或提供 question 自然语言参数）' };
  }

  // NL2SQL 路径：question 参数或自然语言形态的 query via LLM 翻译后执行
  const nlQuestion = !params._fromNL && (params.question || (looksLikeNaturalLanguage(query) ? query : null));
  if (nlQuestion) {
    try {
      const schemaInfo = await buildSchemaInfoForDb(params, context);
      // 合并经营数据注册表（导入的业务表，含角色标注）
      try {
        const { getSchemaPrompt } = require("../core/business-data-registry");
        const bizPrompt = getSchemaPrompt();
        if (bizPrompt) schemaInfo.bizTablesPrompt = bizPrompt;
      } catch (e) {
        console.warn("[database-tools] 业务注册表读取失败:", e.message || e);
      }
      const engine = new Nl2SqlEngine({ llmCall: context && context.llmCall });
      const translated = await engine.translate(nlQuestion, schemaInfo);
      if (!translated.sql) {
        return { success: false, error: `无法理解查询: ${translated.error || '翻译失败'}` };
      }
      const limitedSql = /LIMIT\s+\d+\s*$/i.test(translated.sql.trim())
        ? translated.sql
        : `${translated.sql.trim()} LIMIT ${NL2SQL_LIMIT}`;
      return { ...(await handleDatabaseQuery({ ...params, query: limitedSql, question: undefined, _fromNL: true }, context)), sql: limitedSql, explanation: translated.explanation, confidence: translated.confidence };
    } catch (e) {
      console.error('[database-tools] NL2SQL 路径失败:', e.message || e);
      return { success: false, error: `自然语言查询失败: ${e.message}` };
    }
  }

  // SQL 注入防护：只允许 SELECT 类只读语句，写语句默认拒绝（除非显式配置允许写）
  const q = query.trim().toUpperCase();
  const allowedPrefixes = ['SELECT', 'EXPLAIN', 'PRAGMA', 'SHOW', 'DESCRIBE', 'ANALYZE', 'WITH', '.mode', '.headers', '.tables', '.schema', '.databases'];
  const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'REPLACE', 'TRUNCATE', 'GRANT', 'REINDEX', 'VACUUM', 'ATTACH'];
  const allowWrite = !!params.allowWrite || !!context?.allowWrite;
  const matchedWrite = writeKeywords.find(k => q.startsWith(k));
  if (matchedWrite && !allowWrite) {
    return { success: false, error: `不允许的写操作 (${matchedWrite})。本工具为只读工具契约，写语句默认拒绝` };
  }
  const isAllowed = allowedPrefixes.some(p => q.startsWith(p));
  if (!isAllowed) {
    return { success: false, error: `不允许的 SQL 操作。只允许: ${allowedPrefixes.join(', ')}` };
  }

  try {
    let rows;

    if (type === 'sqlite') {
      if (!database) return { success: false, error: 'SQLite 需要 database 参数（文件路径）' };
      const resolvedPath = path.resolve(database);
      // 安全检查：path.resolve + normalize + path.sep 边界判定，
      // 只允许 workspace 或数据目录内（允许目录本身，防 'data' 子串绕过）
      const workspaceDir = context?.workspaceDir ? path.resolve(context.workspaceDir) : null;
      const dataDir = getDataDir();
      const inWorkspace = workspaceDir && (resolvedPath === workspaceDir || resolvedPath.startsWith(workspaceDir + path.sep));
      const inDataDir = resolvedPath === dataDir || resolvedPath.startsWith(dataDir + path.sep);
      if (!inWorkspace && !inDataDir) {
        return { success: false, error: '数据库文件必须在工作目录或数据目录内' };
      }
      rows = await _querySQLite(resolvedPath, query);
    } else if (type === 'mysql') {
      rows = await _queryMySQL({ host, port, user, password, database }, query);
    } else if (type === 'postgresql') {
      rows = await _queryPostgres({ host, port, user, password, database }, query);
    } else {
      return { success: false, error: `不支持的数据库类型: ${type}。支持: sqlite, mysql, postgresql` };
    }

    const limited = Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : rows;
    return {
      success: true,
      type,
      database: database || `${type}@${host || 'localhost'}`,
      rowCount: (Array.isArray(rows) ? rows.length : 0),
      truncated: Array.isArray(rows) && rows.length > MAX_ROWS,
      rows: limited,
    };
  } catch (e) {
    return { success: false, error: e.message, type, database };
  }
}

registry.register({
  name: 'DatabaseQuery',
  toolset: 'data',
  category: 'database',
  description: '查询数据库。支持 SQLite（文件路径）、MySQL/PostgreSQL（host/user/password）。安全限制：只允许 SELECT 类只读操作，SQLite 文件必须在工作目录或数据目录内。用户导入的经营数据（应收/营收/合同/库存等，客户问"营收多少/应收情况/逾期"类问题）默认都在 SQLite 业务库（database 不传即为业务库）：用 question 参数传自然语言即可自动翻译 SQL 查询。',
  whenNotToUse: ['需要执行写操作（INSERT/UPDATE/DELETE/DROP 等）时', '需要多语句批处理时', 'better-sqlite3 与 sqlite3 CLI 均不可用（SQLite 路径）时'],
  riskLevel: 'medium',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['sqlite', 'mysql', 'postgresql'], description: '数据库类型', default: 'sqlite' },
      database: { type: 'string', description: '数据库名（SQLite：文件路径；MySQL/PostgreSQL：数据库名）' },
      query: { type: 'string', description: 'SQL 查询语句。只允许 SELECT/PRAGMA/EXPLAIN/ANALYZE/WITH 查询' },
      question: { type: 'string', description: '自然语言查询（可选，提供后自动走 NL2SQL 翻译）' },
      host: { type: 'string', description: '数据库主机地址（MySQL/PostgreSQL 需要）' },
      port: { type: 'number', description: '数据库端口' },
      user: { type: 'string', description: '数据库用户名' },
      password: { type: 'string', description: '数据库密码' },
    },
    anyOf: [{ required: ['query'] }, { required: ['question'] }],
  },
  handler: handleDatabaseQuery,
  timeout: 60000,
  isReadOnly: true,
});

registry.register({
  name: 'ListTables',
  toolset: 'data',
  category: 'database',
  description: '列出数据库全部表名。支持 SQLite/MySQL/PostgreSQL。NL2SQL 前自动调用，也可供用户查询库内有什么数据。',
  whenNotToUse: ['需要查询具体数据时（用 DatabaseQuery）', '需要表结构详情时（用 DescribeTable）'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['sqlite', 'mysql', 'postgresql'], description: '数据库类型', default: 'sqlite' },
      database: { type: 'string', description: '数据库名（SQLite：文件路径）' },
      host: { type: 'string' }, port: { type: 'number' },
      user: { type: 'string' }, password: { type: 'string' },
    },
    required: ['type', 'database'],
  },
  handler: handleListTables,
  timeout: 30000,
  isReadOnly: true,
});

registry.register({
  name: 'DescribeTable',
  toolset: 'data',
  category: 'database',
  description: '查看单张表的列结构（列名/类型）。支持 SQLite。',
  whenNotToUse: ['只需要表名清单时（用 ListTables）', '需要查询数据时（用 DatabaseQuery）'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['sqlite'], description: '数据库类型', default: 'sqlite' },
      database: { type: 'string', description: '数据库文件路径' },
      table: { type: 'string', description: '表名（禁止分号与 sqlite_ 前缀）' },
    },
    required: ['type', 'database', 'table'],
  },
  handler: handleDescribeTable,
  timeout: 30000,
  isReadOnly: true,
});

module.exports = { handleDatabaseQuery, handleListTables, handleDescribeTable, buildSchemaInfoForDb, looksLikeNaturalLanguage, _assertReadOnlyQuery };
