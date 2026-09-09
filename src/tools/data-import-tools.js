/**
 * Data Import Tools — CSV/XLSX 导入自动建表
 *
 * 将老板的报表（CSV/XLSX）导入 SQLite 业务库，自动推断列类型，
 * 并注册到 BusinessDataRegistry，之后即可语音 NL2SQL 查询。
 */

const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');
const { getDataDir } = require('../core/config');
const { BUSINESS_DIR } = require('../core/business-data-registry');
const { registerTable } = require('../core/business-data-registry');
const { normalizeDateValue, detectDateColumn } = require('../core/business/date-normalize');

const BUSINESS_DB_PATH = path.join(BUSINESS_DIR, 'business.db');
const MAX_ROWS = 200000; // 单次导入行数上限
const MAX_COLUMNS = 200;

/** 解析 CSV（支持引号字段/逗号/换行/BOM/CRLF），GBK 自动转码 */
function parseCsvFile(filePath) {
  let raw = fs.readFileSync(filePath);
  // 尝试 UTF-8 解码；失败或出现替换符则用 GBK
  let text = raw.toString('utf8');
  if (text.includes('�')) {
    const { decode } = require('iconv-lite');
    text = decode(raw, 'gbk');
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // 规范化换行
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('文件为空');
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  const rows = lines.slice(1, MAX_ROWS + 1).map(parseLine);
  return { columns: header, rows };
}

/** 推断列类型（采样前 200 行） */
function inferColumnType(values) {
  const sample = values.filter((v) => v !== undefined && v !== null && String(v).trim() !== '').slice(0, 200);
  if (sample.length === 0) return 'TEXT';
  const nums = sample.filter((v) => /^-?\d+(\.\d+)?$/.test(String(v).trim()));
  if (nums.length === sample.length) {
    return sample.some((v) => String(v).includes('.')) ? 'REAL' : 'INTEGER';
  }
  return 'TEXT';
}

/** 规范化表名：中文/特殊字符 → 下划线 */
function normalizeTableName(name, columns) {
  let base = (name || 'table').replace(/[^\w一-鿿㐀-䶿-]/g, '_');
  if (!/^[\w一-鿿]/.test(base)) base = `t_${base}`;
  if (!/\D/.test(base)) base = `t_${base}`;
  return base;
}

function sanitizeIdentifier(id) {
  return String(id).replace(/[^\w一-鿿㐀-䶿]/g, '_');
}

/** 解析 XLSX 为 { columns, rows } */
async function parseXlsxFile(filePath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('XLSX 无工作表');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && 'text' in v ? v.text : String(v ?? ''))));
  });
  if (rows.length === 0) throw new Error('工作表为空');
  const header = rows[0].map((h) => String(h).trim() || 'col');
  return { columns: header, rows: rows.slice(1) };
}

/**
 * 导入文件到 SQLite 业务库（自动建表）
 * @returns {Promise<{ success: boolean, tableName?: string, rowCount?: number, columns?: Array<{name,type}>, role?: string|null, error?: string }>}
 */
async function handleImportDataFile(params, context) {
  const { filePath, tableName, mode = 'create', dbPath } = params;
  try {
    if (!filePath) return { success: false, error: '缺少 filePath 参数' };
    const resolvedPath = path.resolve(filePath);
    const workspaceDir = context?.workspaceDir ? path.resolve(context.workspaceDir) : null;
    const dataDir = getDataDir();
    const inWorkspace = workspaceDir && (resolvedPath === workspaceDir || resolvedPath.startsWith(workspaceDir + path.sep));
    const inDataDir = resolvedPath === dataDir || resolvedPath.startsWith(dataDir + path.sep);
    if (!inWorkspace && !inDataDir) {
      return { success: false, error: '导入文件必须在工作目录或数据目录内（当前设备为一体机，禁止读取任意路径）' };
    }
    if (!fs.existsSync(resolvedPath)) return { success: false, error: `文件不存在: ${filePath}` };
    if (fs.statSync(resolvedPath).size > 100 * 1024 * 1024) return { success: false, error: '文件超过 100MB 限制' };

    const ext = path.extname(resolvedPath).toLowerCase();
    let parsed;
    if (ext === '.csv') parsed = parseCsvFile(resolvedPath);
    else if (ext === '.xlsx' || ext === '.xlsm') parsed = await parseXlsxFile(resolvedPath);
    else return { success: false, error: `不支持的文件类型: ${ext}（支持 .csv/.xlsx）` };

    if (parsed.columns.length > MAX_COLUMNS) return { success: false, error: `列数超限（>${MAX_COLUMNS}）` };
    if (parsed.columns.length === 0) return { success: false, error: '文件无列头' };

    // 规范化列名并去重
    const columns = [];
    const seen = new Set();
    parsed.columns.forEach((c, i) => {
      let name = sanitizeIdentifier(c) || `col${i + 1}`;
      while (seen.has(name)) name = `${name}_${i}`;
      seen.add(name);
      columns.push(name);
    });

    const name = normalizeTableName(tableName || path.basename(resolvedPath, ext), columns);

    // 写 SQLite（better-sqlite3；不可用时明确报错，不静默降级）
    let Database;
    try { Database = require('better-sqlite3'); } catch { return { success: false, error: '缺少 better-sqlite3，无法写入业务库' }; }

    fs.mkdirSync(BUSINESS_DIR, { recursive: true });
    const db = new Database(dbPath || BUSINESS_DB_PATH);
    try {
      if (mode === 'replace') db.exec(`DROP TABLE IF EXISTS "${name}"`);
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (mode === 'create' && exists) {
        db.close();
        return { success: false, error: `表 ${name} 已存在，请使用 mode=append 追加或 mode=replace 覆盖` };
      }

      // 列类型推断（按列采样）
      const typedCols = columns.map((c, ci) => {
        const values = parsed.rows.map((r) => r[ci]);
        return { name: c, type: inferColumnType(values) };
      });

      // 日期列识别：TEXT 列大面积命中日期形态时，入库前统一转 ISO。
      // SQLite date() 只认 ISO 前缀，`2024/01/15` 等格式会被 risk-alert
      // 巡检与 NL2SQL 的日期过滤静默丢行——这里是唯一合适的修复位。
      const dateCols = {};
      let dateParseFailed = 0;
      for (let ci = 0; ci < columns.length; ci++) {
        if (typedCols[ci].type !== 'TEXT') continue;
        const probe = detectDateColumn(parsed.rows.map((r) => r[ci]));
        if (probe.isDateColumn) dateCols[ci] = probe;
      }
      const dateColNames = Object.keys(dateCols).map((ci) => columns[ci]);
      if (dateColNames.length) console.log(`[data-import] 日期列已规范化为 ISO: ${dateColNames.join(', ')}`);

      const colDefs = typedCols.map((c) => `"${c.name}" ${c.type}`).join(', ');
      if (!exists || mode === 'replace') db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs})`);

      const placeholders = columns.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO "${name}" VALUES (${placeholders})`);
      const tx = db.transaction((rows) => {
        for (const row of rows) {
          const vals = columns.map((_, ci) => {
            const raw = row[ci];
            if (raw === undefined || raw === null || raw === '') return null;
            const type = typedCols[ci].type;
            if (type === 'REAL' || type === 'INTEGER') {
              const n = Number(String(raw).replace(/[,\s]/g, ''));
              return Number.isFinite(n) ? n : null;
            }
            if (dateCols[ci]) {
              const iso = normalizeDateValue(String(raw), { defaultYear: dateCols[ci].defaultYear });
              if (iso !== null) return iso;
              dateParseFailed += 1;
            }
            return String(raw);
          });
          insert.run(vals);
        }
      });
      tx(parsed.rows.slice(0, MAX_ROWS));
      const rowCount = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c;
      db.close();

      if (dateParseFailed > 0) console.warn(`[data-import] ${dateParseFailed} 个日期单元格无法解析，已保留原值`);

      // 文件指纹（留档 + 同内容重传识别）
      const crypto = require("crypto");
      const fileHash = crypto.createHash('sha256').update(fs.readFileSync(resolvedPath)).digest('hex').slice(0, 16);
      const checksum = crypto.createHash('sha256').update(JSON.stringify(parsed.rows.slice(0, 50))).digest('hex').slice(0, 16);

      const { role, direction, columns: registered } = registerTable({
        name, dbPath: dbPath || BUSINESS_DB_PATH, sourceFile: resolvedPath, columns: typedCols, rowCount, fileHash,
      });

      // 2026-08-25 DataPoint: 导入即留档（历史/回溯/累计口径的依据）
      try {
        const { recordDataPoint } = require("../core/business-data-registry");
        recordDataPoint({ table: name, role, rowCount, fileHash, checksum, semanticType: direction });
      } catch (dpErr) { console.warn("[datapoint] 留档失败(不阻塞):", dpErr.message || dpErr); }

      // superseded 语义：replace 时同名旧历史打标（registry 新条目不标）；
      // 同内容重传（fileHash 一致）时旧表整表退役——修正文件重传不再双算
      try {
        const bdr = require("../core/business-data-registry");
        if (mode === 'replace') bdr.markTableSuperseded(name, { markRegistry: false, dbPath: dbPath || BUSINESS_DB_PATH });
        const dupes = (bdr.listTables() || []).filter((t) => t.name !== name && !t.superseded && t.fileHash === fileHash);
        for (const d of dupes) bdr.markTableSuperseded(d.name, { dbPath: d.dbPath || (dbPath || BUSINESS_DB_PATH) });
        if (dupes.length) console.log(`[data-import] ${dupes.length} 张同内容旧表已标记 superseded: ${dupes.map((d) => d.name).join(', ')}`);
      } catch (spErr) { console.warn("[supersede] 打标失败(不阻塞):", spErr.message || spErr); }

      // 语义视图重建：同角色异构源表 UNION 成 v_*（P1.7）
      let semanticViews = [];
      try {
        const bdr = require("../core/business-data-registry");
        const { rebuildSemanticViews } = require('../core/business/semantic-views');
        const sv = rebuildSemanticViews({ dbPath: dbPath || BUSINESS_DB_PATH, tables: bdr.listTables() });
        semanticViews = sv.rebuilt;
        if (sv.errors.length) console.warn('[data-import] 语义视图重建告警:', sv.errors.join('; '));
        if (sv.rebuilt.length) console.log(`[data-import] 语义视图已重建: ${sv.rebuilt.join(', ')}`);
      } catch (svErr) { console.warn('[data-import] 语义视图重建失败(不阻塞):', svErr.message || svErr); }
      return { success: true, tableName: name, rowCount, columns: registered, role, direction, dateNormalized: dateColNames, dateParseFailed, semanticViews };
    } catch (e) {
      try { db.close(); } catch (e) { console.error('[data-import] 关闭数据库失败:', e.message || e); }
      throw e;
    }
  } catch (e) {
    console.error('[data-import] 导入失败:', e.message || e);
    return { success: false, error: e.message || '导入失败' };
  }
}

registry.register({
  name: 'ImportDataFile',
  toolset: 'data',
  category: 'database',
  description: '导入 CSV/XLSX 报表文件到本地业务数据库并自动建表（类型推断+业务角色识别）。导入后即可用自然语言查询（如"这个月营收多少"）。',
  whenNotToUse: ['导入文件不在工作目录或数据目录内时', '需要修改已有表结构时（先换名导入）', '文件超过 100MB 时'],
  riskLevel: 'medium',
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'CSV/XLSX 文件绝对路径（必须在工作目录或数据目录内）' },
      tableName: { type: 'string', description: '目标表名（默认取文件名，自动规范化）' },
      mode: { type: 'string', enum: ['create', 'replace', 'append'], description: 'create=新建(已存在则报错), replace=覆盖, append=追加', default: 'create' },
      dbPath: { type: 'string', description: '业务库路径（默认 data/.crabpaw/business/business.db）' },
    },
    required: ['filePath'],
  },
  handler: handleImportDataFile,
  timeout: 60000,
  isReadOnly: false,
});

module.exports = { handleImportDataFile, parseCsvFile, inferColumnType, BUSINESS_DIR, BUSINESS_DB_PATH };
