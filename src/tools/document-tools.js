/**
 * Document Tools - 文档处理工具集
 *
 * 支持 Word(docx)、Excel(xlsx)、PDF 等格式的文档处理工具
 * docx 通过 ZIP+XML 解析，使用 Node.js 内置 zlib、
 * xlsx 通过 exceljs 库实现读写、
 * PDF 通过 pdf-parse 库（npm 包）实现解析
 */

const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');
// 2026-08-17: filegen 插桩——html_generate 产物走 FileGenPanel 面板（web-preview
// 中央卡已移除, done 事件带 previewUrl 供面板内 iframe 预览）
const filegen = require('../core/filegen-events');

// 2026-08-25: 长文本 → 文档卡分页(pages:[{text}])。节标题处优先翻页,
// 页长上限 limit 字符硬切(超标段自然成立, 不丢内容)。
// 2026-08-25: splitContentPages(document 分页场景卡专用)已删除——本模块不再推分页卡。
// 2026-08-22: 产物文件名统一清洗（V8 字符类 `_-一` 相邻陷阱修复，中文不再被吞成下划线）
const { sanitizeFilename } = require('../core/filename-utils');
// SP-4 SA-1: 产物落盘目录单轨统一（5 处拼接 → getDocumentArtifactsDir）
const { getDocumentArtifactsDir } = require('../core/doc-artifacts/registry');
/**
 * 2026-08-31 filegen UX 修复(假死感知): 生成类工具为同步阻塞, label 只发一次——
 * 20-60s 无更新, 用户判死。1.5s 心跳把 label 刷新为"正在生成 X…（N 秒）"。
 * phaseFileGen 同 taskId 广播 label 更新(前端无条件刷新); done/fail 后必须 clear。
 */
function startFilegenHeartbeat(fgTaskId, baseLabel) {
  const t0 = Date.now();
  const timer = setInterval(() => {
    try {
      const sec = Math.floor((Date.now() - t0) / 1000);
      filegen.phaseFileGen(fgTaskId, 'writing', `${baseLabel}（${sec} 秒）`);
    } catch (e) { /* 心跳失败不阻塞 */ }
  }, 1500);
  if (timer.unref) timer.unref();
  return timer;
}


// ============================================================
// PDF 解析函数（延迟加载）
// ============================================================

let _pdfParse = null;
function _getPdfParse() {
  if (!_pdfParse) {
    try { _pdfParse = require('pdf-parse'); } catch (_) { _pdfParse = false; }
  }
  return _pdfParse || null;
}

/**
 * 兼容解析 PDF buffer（2026-08-22 修复）
 *
 * 实机 bug：doc_read/pdf_extract 读 PDF 全失败，智能体换工具/换 Python 都拿不到
 * 内容。根因：package.json 声明 pdf-parse ^2.4.5（v2 版本线），v2 把导出从
 * 「可调用函数」(v1: pdfParse(buffer) → {text,numpages,info}) 改为「命名空间
 * 对象」(v2: { PDFParse } 类)。代码按 v1 API 调用 → TypeError:
 * pdfParse is not a function。
 *
 * 本函数 v1/v2 双兼容，统一返回 v1 形状 { text, numpages, info }，
 * 供 document-tools.js 与 pdf-to-word-docx 技能共用。
 */
async function parsePdfBuffer(buffer) {
  const mod = _getPdfParse();
  if (!mod) throw new Error('pdf-parse not installed. Run: npm install pdf-parse');

  // v1: 模块本身是可调用函数
  if (typeof mod === 'function') {
    return await mod(buffer);
  }

  // v2: 模块是命名空间对象，核心类 PDFParse
  if (mod && mod.PDFParse) {
    const parser = new mod.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      let numpages = (result && result.total) || 0;
      let info = {};
      try {
        const infoResult = await parser.getInfo({ parsePageInfo: true });
        if (infoResult) {
          numpages = infoResult.total || numpages;
          info = infoResult.info || {};
        }
      } catch (infoErr) {
        console.warn('[pdf] getInfo 失败(不阻塞):', infoErr.message);
      }
      return { text: (result && result.text) || '', numpages, info };
    } finally {
      try { await parser.destroy(); } catch (destroyErr) {
        console.warn('[pdf] destroy 失败(不阻塞):', destroyErr.message);
      }
    }
  }

  throw new Error('pdf-parse 导出形态无法识别: ' + ((mod && Object.keys(mod).join(',')) || 'empty'));
}

// ============================================================
// DOCX 文本提取：ZIP + XML 解析，无需外部依赖
// ============================================================

async function extractDocxText(filePath) {
  try {
    const AdmZip = (() => {
      try { return require('adm-zip'); } catch (_) { return null; }
    })();

    if (AdmZip) {
      const zip = new AdmZip(filePath);
      const entry = zip.getEntry('word/document.xml');
      if (!entry) return '';
      const xml = entry.getData().toString('utf-8');
      return _extractTextFromDocxXml(xml);
    }

    const { safeExtractZip } = require('../core/safe-zip');
    const tmpDir = path.join(require('os').tmpdir(), 'crabpaw_docx_' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      // 2026-08-19 发行审计 W3: 弃用 PowerShell Expand-Archive——它对 zip entry 名为
      // ../ 或绝对路径的恶意 zip 不防护(zip-slip 可越界写 tmp 之外)。
      // 2026-08-29 安全收口: extract-zip 全版本 zip-slip (CWE-22, CVSS 8.1) 无上游
      // 补丁——改用统一安全解压 safeExtractZip(条目名越界/绝对路径/符号链接整体拒绝,
      // 全有或全无), 非法条目直接中止解压(异常向上抛, 调用方已有空内容守卫)。
      await safeExtractZip(filePath, tmpDir);
      const docXml = path.join(tmpDir, 'word', 'document.xml');
      if (fs.existsSync(docXml)) {
        const xml = fs.readFileSync(docXml, 'utf-8');
        return _extractTextFromDocxXml(xml);
      } else {
        return '';
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { console.warn('Failed to clean up temp dir ' + tmpDir); }
    }
  } catch (e) {
    // 2026-08-19 E2E 实锤：此前返回 "[docx parse failed: ...]" 错误文本——
    // DocumentAnalyze 把它当文档内容喂 LLM → 分析结果变成"分析报错文本"。
    // 统一语义：解析失败 = 空内容（调用方已有"内容为空"守卫）。
    console.warn('[docx] 解析失败(返回空内容):', e.message);
    return '';
  }
}

function _extractTextFromDocxXml(xml) {
  const texts = [];
  const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let match;
  while ((match = tRegex.exec(xml)) !== null) {
    if (match[1]) texts.push(match[1]);
  }
  return texts.join('');
}

// ============================================================
// XLSX 数据读取：使用 exceljs
// ============================================================

async function extractXlsxData(filePath) {
  try {
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    // 2026-09-07 实测修复: 每表截前 100 行但静默——智能体把 128 行表当全量算出
    // 总销售额 52.4 万(真实 71.1 万, 低 26%)。改为显式声明 totalRows/truncated,
    // handler 层附 notice 引导改用全量读取路径。
    const XLSX_READ_ROW_LIMIT = 100;
    const result = { sheets: [] };
    workbook.eachSheet((sheet) => {
      const rows = [];
      sheet.eachRow((row) => {
        rows.push(row.values.slice(1));
      });
      result.sheets.push({
        name: sheet.name,
        rowCount: rows.length,
        returnedRows: Math.min(rows.length, XLSX_READ_ROW_LIMIT),
        truncated: rows.length > XLSX_READ_ROW_LIMIT,
        rows: rows.slice(0, XLSX_READ_ROW_LIMIT),
      });
    });
    return result;
  } catch (e) {
    return { error: 'xlsx parse failed: ' + e.message };
  }
}

// ============================================================
// PDF 解析函数
// ============================================================

async function extractPdfText(filePath) {
  // 2026-08-22: 走 parsePdfBuffer 兼容封装（v2 API 断裂修复），解析失败抛错
  // 给调用方——chat-handler 有降级兜底，doc_read 让智能体看到真实错误（此前
  // 错误/占位文本被当文档内容喂 LLM 的教训）
  const buffer = fs.readFileSync(filePath);
  const data = await parsePdfBuffer(buffer);
  return data.text;
}

async function extractPdfFull(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const data = await parsePdfBuffer(buffer);

    const pages = [];
    let currentPage = '';
    let pageNum = 1;
    const lines = data.text.split('\n');
    for (const line of lines) {
      if (line.trim() === '' && currentPage.length > 500) {
        pages.push({ page: pageNum++, text: currentPage.trim() });
        currentPage = '';
      } else {
        currentPage += line + '\n';
      }
    }
    if (currentPage.trim()) {
      pages.push({ page: pageNum, text: currentPage.trim() });
    }

    const tables = _detectTables(data.text);
    const fields = _extractKeyFields(data.text);

    return {
      success: true,
      metadata: {
        pageCount: data.numpages || pages.length,
        info: data.info || {},
      },
      text: data.text.substring(0, 20000),
      pages: pages.slice(0, 20),
      tables,
      fields,
    };
  } catch (e) {
    return { success: false, error: 'PDF parse failed: ' + e.message };
  }
}

function _detectTables(text) {
  const tables = [];
  const lines = text.split('\n');
  let tableStart = -1;
  let tableLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts2 = line.trim().split(/\s{2,}/);
    const parts1 = line.trim().split(/\s+/);
    // Use double-space split if it produces multiple columns, otherwise single-space
    const parts = parts2.length >= 3 ? parts2 : (parts1.length >= 3 ? parts1 : parts2);
    const hasNumbers = parts.filter(p => /^-?\d[\d,.]*$/.test(p.trim())).length;
    // Header row: >= 3 columns, no numbers needed; Data row: >= 3 columns with numbers
    const isHeaderLike = parts.length >= 3 && tableStart === -1;
    const isDataLike = parts.length >= 3 && hasNumbers >= 1;
    const isTableLike = isHeaderLike || isDataLike;

    if (isTableLike) {
      if (tableStart === -1) tableStart = i;
      tableLines.push(parts.map(p => p.trim()));
    } else {
      if (tableLines.length >= 2) {
        tables.push({
          startLine: tableStart + 1,
          rowCount: tableLines.length,
          headers: tableLines[0],
          rows: tableLines.slice(1).slice(0, 50),
        });
      }
      tableStart = -1;
      tableLines = [];
    }
  }

  if (tableLines.length >= 2) {
    tables.push({
      startLine: tableStart + 1,
      rowCount: tableLines.length,
      headers: tableLines[0],
      rows: tableLines.slice(1).slice(0, 50),
    });
  }

  return tables.slice(0, 10);
}

function _extractKeyFields(text) {
  const fields = {};

  // Amount: number with comma grouping + optional decimal + currency/unit
  const amountRe = /(?:(?:人民币|美元|欧元|港币|日元|元|块|刀|\$)\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\s*[万元]?)|(\d+\.\d{2}\s*(?:元|人民币|美元|欧元)?)/g;
  const amounts = [];
  let m;
  while ((m = amountRe.exec(text)) !== null) {
    const val = (m[1] || m[2]).trim();
    if (val.length >= 4 && !amounts.includes(val)) amounts.push(val);
  }
  if (amounts.length) fields.amounts = amounts.slice(0, 20);

  const dates = text.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日]?/g);
  if (dates) fields.dates = [...new Set(dates)].slice(0, 20);

  const contractNos = text.match(/[合同协议]?[合同编号][合同:\s]*([A-Za-z0-9_\-[\]（）()]{4,30})/g);
  if (contractNos) fields.contractNos = contractNos.slice(0, 10).map(c => c.replace(/[合同编号][合同:\s]*/, ''));

  const idCards = text.match(/\d{17}[\dXx]/g);
  if (idCards) fields.idCards = idCards.slice(0, 5);

  const phones = text.match(/1[3-9]\d{9}/g);
  if (phones) fields.phones = [...new Set(phones)].slice(0, 5);

  const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (emails) fields.emails = [...new Set(emails)].slice(0, 10);

  const uscc = text.match(/[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}/g);
  if (uscc) fields.uscc = uscc.slice(0, 5);

  return fields;
}

// ============================================================
// 工具注册
// ============================================================

registry.register({
  name: 'doc_read',
  toolset: 'document',
  category: 'document',
  description: 'Read Word(docx), Excel(xlsx), or PDF files. Auto-detects file type.',
  whenNotToUse: ['不要用于读取纯文本/Markdown 文件，改用 Read', '不要用于写入或生成文档，改用 docx_generate 等'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      // 2026-08-20: 参数名统一 path——与 tool-contract.js 契约校验一致。
      // 此前注册 schema 用 filePath 而契约要求 path(additionalProperties:false),
      // AI 按注册 schema 传 filePath 被契约拒绝(上传分析连续 7 次失败)。
      // 2026-08-22: 补 filePath 别名(仅可选, required 仍为 path)——实测 deepseek-v4-flash
      // 参数名跟随差仍传 filePath("转成 HTML"实机被拒), 与 ShowStock query/symbols 同型。
      path: { type: 'string', description: 'Absolute file path' },
      filePath: { type: 'string', description: '兼容别名(同 path), 任选其一' },
    },
    required: ['path'],
  },
  async handler(params) {
    const filePath = params.path ?? params.filePath; // 双兼容(契约/历史调用)
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }

    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.docx') {
      const text = await extractDocxText(filePath);
      // 2026-09-07: 截断显式化（同 xlsx——防把节选当全量）
      return { success: true, type: 'docx', content: text.substring(0, 10000), length: text.length, truncated: text.length > 10000 };
    }

    if (ext === '.xlsx' || ext === '.xls') {
      const data = await extractXlsxData(filePath);
      if (data.error) return { success: false, error: data.error };
      // 2026-09-07: 截断显式化——附 notice 引导模型走全量读取路径,
      // 防止把截断样本当全量计算(数字级错误)。
      const truncatedSheets = (data.sheets || []).filter(s => s.truncated);
      if (truncatedSheets.length > 0) {
        const totalRows = data.sheets.map(s => `${s.name}:${s.rowCount}行`).join(', ');
        return {
          success: true, type: 'xlsx', ...data,
          truncated: true,
          notice: `⚠️ 截断声明: 以下工作表仅返回前100行——${totalRows}。当前返回内容不是全量数据，禁止把已返回行当作全量统计。需要全量分析时请改用: ①ImportDataFile 导入业务库后用 DatabaseQuery/NL2SQL 查询；②xlsx_query 分页(limit/offset)读取；③ShellExec 运行脚本直接读文件路径。`,
        };
      }
      return { success: true, type: 'xlsx', ...data };
    }

    if (ext === '.pdf') {
      const text = await extractPdfText(filePath);
      return { success: true, type: 'pdf', content: text, length: text.length };
    }

    if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json') {
      const text = fs.readFileSync(filePath, 'utf-8');
      return { success: true, type: ext.slice(1), content: text.substring(0, 10000), length: text.length, truncated: text.length > 10000 };
    }

    return { success: false, error: 'Unsupported file type: ' + ext };
  }
});

registry.register({
  name: 'xlsx_query',
  toolset: 'document',
  category: 'document',
  description: 'Query Excel data with filter, sort, column selection.',
  whenNotToUse: ["不要用于非 Excel 文件","不要用于读取整张表原始内容，仅做结构化查询"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      // 2026-08-20: 参数名统一 path——与 tool-contract.js 契约校验一致(同 doc_read)
      // 2026-08-22: 补 filePath 别名(仅可选)——同 doc_read 实机参数名跟随差
      path: { type: 'string', description: 'Excel file path' },
      filePath: { type: 'string', description: '兼容别名(同 path), 任选其一' },
      sheet: { type: 'string', description: 'Sheet name, default first' },
      filter: { type: 'string', description: 'Filter expression, e.g. "sales>1000"' },
      columns: { type: 'string', description: 'Columns to return, comma-separated' },
      limit: { type: 'number', description: 'Max rows, default 50' },
    },
    required: ['path'],
  },
  async handler(params) {
    try {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(params.path ?? params.filePath); // 双兼容

      const sheet = params.sheet
        ? workbook.getWorksheet(params.sheet)
        : workbook.worksheets[0];

      if (!sheet) return { success: false, error: 'Sheet not found' };

      const rows = [];
      const headers = [];
      sheet.getRow(1).eachCell((cell, colNum) => {
        headers[colNum] = cell.value ? String(cell.value) : 'Col' + colNum;
      });

      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const obj = {};
        row.eachCell((cell, colNum) => {
          obj[headers[colNum]] = cell.value;
        });
        rows.push(obj);
      });

      let filtered = rows;
      if (params.filter) {
        const m = params.filter.match(/^(.+?)([><=!]+)(.+)$/);
        if (m) {
          const [, col, op, val] = m;
          const numVal = parseFloat(val);
          filtered = rows.filter(r => {
            const cellVal = r[col.trim()];
            if (typeof cellVal === 'number' && !isNaN(numVal)) {
              switch (op) {
                case '>': return cellVal > numVal;
                case '<': return cellVal < numVal;
                case '>=': return cellVal >= numVal;
                case '<=': return cellVal <= numVal;
                case '=': case '==': return String(cellVal) === val;
                case '!=': return String(cellVal) !== val;
                default: return true;
              }
            }
            return String(cellVal || '').includes(val);
          });
        }
      }

      if (params.columns) {
        const cols = params.columns.split(',').map(c => c.trim());
        filtered = filtered.map(r => {
          const obj = {};
          cols.forEach(c => { if (c in r) obj[c] = r[c]; });
          return obj;
        });
      }

      return {
        success: true,
        sheet: sheet.name,
        totalRows: rows.length,
        filteredRows: filtered.length,
        headers,
        rows: filtered.slice(0, params.limit || 50),
      };
    } catch (e) {
      return { success: false, error: 'Excel query failed: ' + e.message };
    }
  }
});

registry.register({
  name: 'pdf_extract',
  toolset: 'document',
  category: 'document',
  description: 'Deep PDF parsing: extract text, metadata, tables, and key fields (amounts, dates, contract numbers, IDs, phones, emails).',
  whenNotToUse: ["不要用于 Word/Excel 文件，改用 doc_read","不要用于简单文本提取，本工具面向结构化字段抽取"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      // 2026-08-20: 参数名统一 path——与 tool-contract.js 契约校验一致(同 doc_read)
      // 2026-08-22: 补 filePath 别名(仅可选)——同 doc_read 实机参数名跟随差
      path: { type: 'string', description: 'PDF file path' },
      filePath: { type: 'string', description: '兼容别名(同 path), 任选其一' },
      extractTables: { type: 'boolean', description: 'Detect and extract tables, default true' },
      extractFields: { type: 'boolean', description: 'Extract key fields, default true' },
    },
    required: ['path'],
  },
  async handler(params) {
    const filePath = params.path ?? params.filePath; // 双兼容
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      return { success: false, error: 'Only PDF files supported' };
    }
    return extractPdfFull(filePath);
  }
});

registry.register({
  name: 'doc_to_markdown',
  toolset: 'document',
  category: 'document',
  description: 'Convert PDF/Word to Markdown with table preservation.',
  whenNotToUse: ["不要用于生成文档，仅做格式转换","不要用于纯文本文件"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      // 2026-08-20: 参数名统一 path——与 tool-contract.js 契约校验一致(同 doc_read)
      // 2026-08-22: 补 filePath 别名(仅可选)——同 doc_read 实机参数名跟随差
      path: { type: 'string', description: 'Document path (pdf/docx)' },
      filePath: { type: 'string', description: '兼容别名(同 path), 任选其一' },
    },
    required: ['path'],
  },
  async handler(params) {
    const filePath = params.path ?? params.filePath; // 双兼容
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }

    const ext = path.extname(filePath).toLowerCase();
    let text = '';

    if (ext === '.pdf') {
      const result = await extractPdfFull(filePath);
      if (!result.success) return result;
      text = result.text;

      if (result.tables && result.tables.length > 0) {
        text += '\n\n## Tables Found\n\n';
        for (const table of result.tables) {
          if (table.headers && table.headers.length > 0) {
            text += '| ' + table.headers.join(' | ') + ' |\n';
            text += '| ' + table.headers.map(function() { return '---'; }).join(' | ') + ' |\n';
            for (const row of table.rows) {
              text += '| ' + row.join(' | ') + ' |\n';
            }
            text += '\n';
          }
        }
      }

      return { success: true, type: 'pdf', markdown: text.substring(0, 30000), length: text.length };
    }

    if (ext === '.docx') {
      text = await extractDocxText(filePath);
      return { success: true, type: 'docx', markdown: text.substring(0, 30000), length: text.length };
    }

    return { success: false, error: 'Unsupported type: ' + ext };
  }
});

// ============================================================
// DOCX 生成：Markdown 转 Word（Node.js 原生实现，无需 Python）
// 支持标题、粗体、斜体、代码、列表、表格、分割线
// 复杂排版建议走 MarkdownToWord 工具（调用 Python python-docx）
// ============================================================



// 内建样式配置（Node.js 轻量版，4 种预设）
const DOCX_STYLES = {
  '商务报告': {
    bodyFont: '微软雅黑', bodySize: '22', bodyColor: '1A1A1A',
    h1Size: '32', h1Color: '1A3A5C', h2Size: '28', h2Color: '2B5797', h3Size: '24', h3Color: '2B5797',
    codeSize: '18', lineSpacing: '360', bodyAfter: '120', pageMargin: '1440',
  },
  '中国公文': {
    bodyFont: '仿宋', bodySize: '32', bodyColor: '000000',
    h1Size: '32', h1Color: '000000', h2Size: '32', h2Color: '000000', h3Size: '32', h3Color: '000000',
    codeSize: '28', lineSpacing: '560', bodyAfter: '0',
    pageMargin: '2102', // 约 3.7cm top
  },
  '学术论文': {
    bodyFont: '宋体', bodySize: '24', bodyColor: '000000',
    h1Size: '28', h1Color: '000000', h2Size: '24', h2Color: '000000', h3Size: '24', h3Color: '000000',
    codeSize: '18', lineSpacing: '360', bodyAfter: '0', pageMargin: '1440',
  },
  '简约现代': {
    bodyFont: 'Arial', bodySize: '21', bodyColor: '333333',
    h1Size: '28', h1Color: '333333', h2Size: '24', h2Color: '555555', h3Size: '22', h3Color: '555555',
    codeSize: '18', lineSpacing: '276', bodyAfter: '160', pageMargin: '1440',
  },
};

function _buildDocxXml(markdown, styleName) {
  const S = DOCX_STYLES[styleName] || DOCX_STYLES['商务报告'];
  const lines = markdown.split('\n');
  const paragraphs = [];
  let inCodeBlock = false;
  let inTable = false;
  let tableRows = [];
  let inList = false;
  let listType = null; // 'ul' | 'ol'
  let listCounter = 0;

  function flushTable() {
    if (tableRows.length === 0) return;
    const numCols = Math.max(...tableRows.map(r => r.length));
    // 补全列数
    tableRows.forEach(r => { while (r.length < numCols) r.push(''); });
    const tblXml = ['<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid>'];
    for (let c = 0; c < numCols; c++) tblXml.push('<w:gridCol w:w="' + Math.floor(9000/numCols) + '"/>');
    tblXml.push('</w:tblGrid>');
    tableRows.forEach((row, ri) => {
      tblXml.push('<w:tr>');
      row.forEach(cell => {
        const isHeader = ri === 0;
        const bg = isHeader ? ('<w:shd w:val="clear" w:fill="' + S.h1Color + '"/>') : '';
        const fgColor = isHeader ? 'FFFFFF' : S.bodyColor;
        tblXml.push(`<w:tc><w:tcPr>${bg}</w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${S.bodyFont}" w:hAnsi="${S.bodyFont}" w:eastAsia="${S.bodyFont}"/><w:sz w:val="${isHeader ? '22' : '20'}"/><w:b/>` + (isHeader ? `<w:color w:val="${fgColor}"/>` : `<w:color w:val="${S.bodyColor}"/>`) + `</w:rPr><w:t xml:space="preserve">${_escapeXml(cell)}</w:t></w:r></w:p></w:tc>`);
      });
      tblXml.push('</w:tr>');
    });
    tblXml.push('</w:tbl>');
    paragraphs.push(tblXml.join(''));
    paragraphs.push('<w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr></w:p>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块
    if (trimmed.startsWith('```')) {
      if (inTable) { flushTable(); inTable = false; tableRows = []; }
      if (inList) { inList = false; listType = null; }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      paragraphs.push(`<w:p><w:pPr><w:shd w:val="clear" w:fill="F5F5F5"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="${S.codeSize}"/></w:rPr><w:t xml:space="preserve">${_escapeXml(line)}</w:t></w:r></w:p>`);
      continue;
    }

    // 空行
    if (trimmed === '') {
      if (inTable) { flushTable(); inTable = false; tableRows = []; }
      if (inList) { inList = false; listType = null; listCounter = 0; }
      paragraphs.push('<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr></w:p>');
      continue;
    }

    // 表格
    if (trimmed.startsWith('|') && trimmed.includes('|')) {
      if (inList) { inList = false; listType = null; }
      if (!inTable) { inTable = true; tableRows = []; }
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      // 跳过分隔行
      if (cells.every(c => /^:?-{3,}:?$/.test(c.replace(/\s/g, '')))) continue;
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
      inTable = false;
      tableRows = [];
    }

    // 标题
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      if (inList) { inList = false; listType = null; }
      const level = hMatch[1].length;
      const text = _escapeXml(hMatch[2].trim());
      const sizes = { 1: S.h1Size, 2: S.h2Size, 3: S.h3Size };
      const colors = { 1: S.h1Color, 2: S.h2Color, 3: S.h3Color };
      const sz = sizes[level] || '22';
      const clr = colors[level] || S.bodyColor;
      const outlineLvl = level - 1;
      paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="Heading${Math.min(level, 3)}"/><w:outlineLvl w:val="${outlineLvl}"/><w:spacing w:before="${Math.max(200 - level * 20, 80)}" w:after="${Math.max(120 - level * 20, 60)}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${S.bodyFont}" w:hAnsi="${S.bodyFont}" w:eastAsia="${S.bodyFont}"/><w:b/><w:sz w:val="${sz}"/><w:color w:val="${clr}"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`);
      continue;
    }

    // 分割线
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      if (inList) { inList = false; listType = null; }
      paragraphs.push(`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/></w:pPr><w:r><w:rPr><w:color w:val="CCCCCC"/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${'─'.repeat(40)}</w:t></w:r></w:p>`);
      continue;
    }

    // 无序列表
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') { inList = true; listType = 'ul'; }
      const text = _escapeXml(ulMatch[1]);
      paragraphs.push(`<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/><w:spacing w:before="20" w:after="20" w:line="${S.lineSpacing}" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${S.bodyFont}" w:hAnsi="${S.bodyFont}" w:eastAsia="${S.bodyFont}"/><w:sz w:val="${S.bodySize}"/><w:color w:val="${S.bodyColor}"/></w:rPr><w:t xml:space="preserve">• ${text}</w:t></w:r></w:p>`);
      continue;
    }

    // 有序列表
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') { inList = true; listType = 'ol'; listCounter = 0; }
      listCounter++;
      const text = _escapeXml(olMatch[2]);
      paragraphs.push(`<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/><w:spacing w:before="20" w:after="20" w:line="${S.lineSpacing}" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${S.bodyFont}" w:hAnsi="${S.bodyFont}" w:eastAsia="${S.bodyFont}"/><w:sz w:val="${S.bodySize}"/><w:color w:val="${S.bodyColor}"/></w:rPr><w:t xml:space="preserve">${listCounter}. ${text}</w:t></w:r></w:p>`);
      continue;
    }

    // 引用块
    if (trimmed.startsWith('> ')) {
      if (inList) { inList = false; listType = null; }
      const text = _escapeXml(trimmed.substring(2));
      paragraphs.push(`<w:p><w:pPr><w:ind w:left="720"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="2B5797"/></w:pBdr><w:spacing w:before="60" w:after="60" w:line="${S.lineSpacing}" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${S.bodyFont}" w:hAnsi="${S.bodyFont}" w:eastAsia="${S.bodyFont}"/><w:sz w:val="${S.bodySize}"/><w:color w:val="666666"/><w:i/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`);
      continue;
    }

    // 普通段落
    paragraphs.push(_buildParagraph(line, false, S));
  }

  // 清理残留
  if (inTable) flushTable();

  return paragraphs.join('');
}

function _buildParagraph(line, isCode, S) {
  if (!S) S = DOCX_STYLES['商务报告'];

  if (isCode) {
    return `<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${_escapeXml(line)}</w:t></w:r></w:p>`;
  }

  // 解析内联格式: **粗体**, *斜体*, `代码`, ~~删除线~~
  const runs = [];
  let parts = [];
  let lastIdx = 0;
  let match;

  // 用正则匹配所有格式标记，按位置排序
  const tokens = [];
  const patterns = [
    { re: /\*\*(.+?)\*\*/g, type: 'bold' },
    { re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, type: 'italic' },
    { re: /`(.+?)`/g, type: 'code' },
    { re: /~~(.+?)~~/g, type: 'strikethrough' },
  ];

  for (const { re, type } of patterns) {
    re.lastIndex = 0;
    while ((match = re.exec(line)) !== null) {
      tokens.push({ start: match.index, end: match.index + match[0].length, text: match[1], type });
    }
  }
  tokens.sort((a, b) => a.start - b.start);

  lastIdx = 0;
  for (const tok of tokens) {
    if (tok.start > lastIdx) {
      parts.push({ text: line.slice(lastIdx, tok.start), type: 'normal' });
    }
    parts.push({ text: tok.text, type: tok.type });
    lastIdx = tok.end;
  }
  if (lastIdx < line.length) {
    parts.push({ text: line.slice(lastIdx), type: 'normal' });
  }
  if (parts.length === 0) {
    parts.push({ text: line, type: 'normal' });
  }

  for (const part of parts) {
    const text = _escapeXml(part.text);
    const font = S.bodyFont;
    const size = S.bodySize;
    const color = S.bodyColor;
    const rPrParts = [`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/><w:sz w:val="${size}"/><w:color w:val="${color}"/>`];
    if (part.type === 'bold') rPrParts.push('<w:b/>');
    if (part.type === 'italic') rPrParts.push('<w:i/>');
    if (part.type === 'strikethrough') rPrParts.push('<w:strike/>');
    if (part.type === 'code') {
      rPrParts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>');
      rPrParts.push('<w:sz w:val="18"/>');
      rPrParts.push('<w:highlight w:val="lightGray"/>');
    }
    runs.push(`<w:r><w:rPr>${rPrParts.join('')}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`);
  }

  return `<w:p><w:pPr><w:spacing w:before="0" w:after="${S.bodyAfter}" w:line="${S.lineSpacing}" w:lineRule="auto"/></w:pPr>${runs.join('')}</w:p>`;
}

function _escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _generateDocx(markdown, title, styleName) {
  return new Promise((resolve, reject) => {
    try {
      const S = DOCX_STYLES[styleName] || DOCX_STYLES['商务报告'];
      const bodyXml = _buildDocxXml(markdown, styleName);

      // 2026-08-22 修复: 误写数组解构 [Content_Types] → 只取模板字符串首字符 '<'（1 字节），
      // [Content_Types].xml 写坏 → WPS 打开报「文件损坏」。去掉方括号（实测：坏文件解压后恰 1B）。
      const Content_Types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

      const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

      const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

      const pageMarginVal = S.pageMargin || '1440';
      const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="${pageMarginVal}" w:right="${pageMarginVal}" w:bottom="${pageMarginVal}" w:left="${pageMarginVal}"/>
      <w:footerReference w:type="default" r:id="rId2"/>
    </w:sectPr>
  </w:body>
</w:document>`;

      const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:sz w:val="${S.bodySize}"/><w:rFonts w:ascii="${S.bodyFont}" w:hAnsi="${S.bodyFont}" w:eastAsia="${S.bodyFont}"/><w:color w:val="${S.bodyColor}"/></w:rPr>
    <w:pPr><w:spacing w:line="${S.lineSpacing}" w:lineRule="auto"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="${S.h1Size}"/><w:color w:val="${S.h1Color}"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="${S.h2Size}"/><w:color w:val="${S.h2Color}"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:rPr><w:b/><w:sz w:val="${S.h3Size}"/><w:color w:val="${S.h3Color}"/></w:rPr>
  </w:style>
</w:styles>`;

      // 页脚（页码）
      const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r><w:fldChar w:fldCharType="begin"/></w:r>
    <w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
    <w:r><w:fldChar w:fldCharType="end"/></w:r>
  </w:p>
</w:ftr>`;

      // Build ZIP using streams
      // eslint-disable-next-line no-unused-vars
      const { PassThrough } = require('stream');
      const Zip = (() => {
        try { return require('archiver'); } catch (_) { return null; }
      })();

      if (Zip) {
        // Use archiver if available
        const archive = Zip('zip', { zlib: { level: 9 } });
        const buffers = [];
        archive.on('data', (chunk) => buffers.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(buffers)));
        archive.on('error', reject);
        archive.append(Buffer.from(Content_Types, 'utf-8'), { name: '[Content_Types].xml' });
        archive.append(Buffer.from(rels, 'utf-8'), { name: '_rels/.rels' });
        archive.append(Buffer.from(docRels, 'utf-8'), { name: 'word/_rels/document.xml.rels' });
        archive.append(Buffer.from(documentXml, 'utf-8'), { name: 'word/document.xml' });
        archive.append(Buffer.from(stylesXml, 'utf-8'), { name: 'word/styles.xml' });
        archive.append(Buffer.from(footerXml, 'utf-8'), { name: 'word/footer1.xml' });
        archive.finalize();
      } else {
        // Fallback: manual ZIP with zlib (basic, works for small files)
        resolve(_buildManualZip(Content_Types, rels, docRels, documentXml, stylesXml, footerXml));
      }
    } catch (e) {
      reject(e);
    }
  });
}

function _buildManualZip(Content_Types, rels, docRels, documentXml, stylesXml, footerXml) {
  // Minimal ZIP implementation for Node.js without external deps
  const files = [
    { name: '[Content_Types].xml', data: Buffer.from(Content_Types, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(docRels, 'utf-8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml, 'utf-8') },
    { name: 'word/footer1.xml', data: Buffer.from(footerXml || '', 'utf-8') },
  ];


  const localFileHeaders = [];
  const centralDirEntries = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf-8');
    const crc = _crc32(file.data);
    
    localFileHeaders.push(Buffer.concat([
      Buffer.from('PK\x03\x04'),
      Buffer.from([0x14, 0x00]), // version needed
      Buffer.from([0x00, 0x00]), // flags
      Buffer.from([0x00, 0x00]), // compression: stored
      Buffer.from([0x00, 0x00]), // mod time
      Buffer.from([0x00, 0x00]), // mod date
      _u32le(crc),
      _u32le(file.data.length),
      _u32le(file.data.length),
      _u16le(nameBuffer.length),
      Buffer.from([0x00, 0x00]), // extra field length
      nameBuffer,
      file.data,
    ]));

    centralDirEntries.push(Buffer.concat([
      Buffer.from('PK\x01\x02'),
      Buffer.from([0x14, 0x00]),
      Buffer.from([0x14, 0x00]),
      Buffer.from([0x00, 0x00]),
      Buffer.from([0x00, 0x00]),
      Buffer.from([0x00, 0x00]),
      Buffer.from([0x00, 0x00]),
      _u32le(crc),
      _u32le(file.data.length),
      _u32le(file.data.length),
      _u16le(nameBuffer.length),
      Buffer.from([0x00, 0x00]), // extra
      Buffer.from([0x00, 0x00]), // comment
      Buffer.from([0x00, 0x00]), // disk
      Buffer.from([0x00, 0x00]), // internal
      _u32le(0x20), // external
      _u32le(offset),
      nameBuffer,
    ]));

    offset += localFileHeaders[localFileHeaders.length - 1].length;
  }

  const centralDir = Buffer.concat(centralDirEntries);
  const centralDirOffset = offset;
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // disk
    _u16le(files.length),
    _u16le(files.length),
    _u32le(centralDir.length),
    _u32le(centralDirOffset),
    Buffer.from([0x00, 0x00]), // comment length
  ]);

  return Buffer.concat([...localFileHeaders, centralDir, eocd]);
}

function _crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _u32le(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}

function _u16le(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

registry.register({
  name: 'docx_generate',
  toolset: 'document',
  category: 'document',
  description: 'Generate a Word (.docx) file from Markdown content with professional formatting. Supports headings, bold/italic/code/strikethrough, lists, tables, blockquotes.',
  whenNotToUse: ["不要用于读取已有 Word 文件，改用 doc_read","不要用于简单纯文本输出，改用 Write"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Markdown content to convert to Word' },
      title: { type: 'string', description: 'Document title (used as filename, no extension)' },
      style: { type: 'string', enum: ['\u5546\u52a1\u62a5\u544a', '\u4e2d\u56fd\u516c\u6587', '\u5b66\u672f\u8bba\u6587', '\u7b80\u7ea6\u73b0\u4ee3'], description: 'Formatting template (default: \u5546\u52a1\u62a5\u544a)' },
      outputPath: { type: 'string', description: 'Output file path. If not provided, auto-generates in workspace.' }
    },
    required: ['content', 'title']
  },
  async handler(params) {
    const { content, title, style, outputPath } = params;
    let fgTaskId = null;
    let hbTimer = null;
    try {
      try {
        fgTaskId = filegen.ensureFileGenTask({ title: title || 'Word 文档', format: 'docx', phase: 'writing', label: '正在生成 Word 文档…' });
      } catch (fgErr) { console.error('[filegen] docx_generate 插桩失败(不阻塞):', fgErr.message); }
        if (fgTaskId) hbTimer = startFilegenHeartbeat(fgTaskId, '正在生成 Word 文档…');
      let outPath = outputPath;
      if (!outPath) {
        const workspaceDir = getDocumentArtifactsDir();
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        // 2026-08-22 修复: title 缺失(LLM 参数猜测漏传,实测)时裸 .replace 崩——
        // 「Cannot read properties of undefined (reading 'replace')」,同 xlsx/pdf 生成器兜底写法
        const safeName = sanitizeFilename(title, 'document');
        outPath = path.join(workspaceDir, `${safeName}_${Date.now()}.docx`);
      }

      const buffer = await _generateDocx(content, title, style || '\u5546\u52a1\u62a5\u544a');
      fs.writeFileSync(outPath, buffer);
      const sizeKB = (buffer.length / 1024).toFixed(1);
      console.log(`\u2705 docx_generate: ${outPath} (${sizeKB}KB) [${style || '\u5546\u52a1\u62a5\u544a'}]`);
      try {
        if (fgTaskId) {
          filegen.doneFileGen(fgTaskId, {
            path: outPath,
            name: outPath.split(/[/\\]/).pop(),
            size: buffer.length,
            format: 'docx',
            url: filegen.previewUrlFor('docx', outPath),
          });
        }
      } catch (fgErr) { console.error('[filegen] docx_generate done 插桩失败(不阻塞):', fgErr.message); }
      // 2026-08-25 用户指令(硬删除): document 分页场景卡推送代码已删——文档任务
      // 只走 FileGenPanel 专项文档卡(单栏文档流)/filegen 任务流, 不再推 document kind。
      return { success: true, path: outPath, size: buffer.length, sizeKB, style: style || '\u5546\u52a1\u62a5\u544a' };
    } catch (e) {
      console.error('docx_generate 失败:', e.message);
      try { if (fgTaskId) filegen.failFileGen(fgTaskId, 'Word generation failed: ' + e.message); }
      catch (fgErr) { console.error('[filegen] docx_generate fail 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      return { success: false, error: 'Word generation failed: ' + e.message };
    }
  }
});

// ============================================================
// XLSX 生成：结构化数据 → 专业格式化 Excel
// 使用内置 ExcelGenerator 引擎（data/skills/excel-generator/）
// ============================================================

/**
 * 从结构化数据生成格式化的 Excel 文件
 * @param {Object} spec - { sheets, colorScheme, title }
 * @returns {Promise<Buffer>}
 */
async function _generateXlsx(spec) {
  // eslint-disable-next-line no-unused-vars
  const { sheets = [], colorScheme = 'corporate', title } = spec;

  // 延迟加载 ExcelGenerator（保持启动速度）
  const ExcelGenerator = (() => {
    try {
      const egPath = path.join(__dirname, '..', '..', 'data', 'skills', 'excel-generator', 'excel-generator.js');
      const mod = require(egPath);
      return mod.ExcelGenerator;
    } catch (_) {
      return null;
    }
  })();

  if (!ExcelGenerator) {
    throw new Error('ExcelGenerator 不可用，请确认 data/skills/excel-generator/excel-generator.js 存在且 exceljs 已安装');
  }

  const gen = new ExcelGenerator({ colorScheme });

  for (const sheetSpec of sheets) {
    // 2026-08-23 别名兼容（deepseek 实机三套变体）: sheetName/rows/columns/options.kpi/
    // sheetConfig.kpiCards 均被传过——只认 name/headers/data 会导致 handler 空表
    // → generator 内部 null.forEach 崩溃（实锤 02:20:58）
    if (!sheetSpec || typeof sheetSpec !== 'object') continue; // 防御：空/非法元素直接跳过
    const _sheetCfg = sheetSpec.sheetConfig || sheetSpec.options || {};
    const {
      name = sheetSpec.sheetName || 'Sheet1',
      title: sheetTitle,
      headers = sheetSpec.columns || [],
      data = sheetSpec.rows || [],
      columnFormats = {},
      totalRow = false,
      totalLabel = '合计',
      kpis = sheetSpec.kpis || _sheetCfg.kpiCards
        || (Array.isArray(_sheetCfg.kpi) ? _sheetCfg.kpi.map(s => (typeof s === 'string' ? { label: s, value: '' } : s)) : []),
      colorScale = false,
      dataBar = false,
      autoFilter = true,
      freezeRow = 0,
    } = sheetSpec;

    const sheetName = (name || sheetTitle || 'Sheet1').replace(/[\\/*\\[\\]:?]/g, '_').substring(0, 31);
    gen.addSheet(sheetName);

    let currentRow = 1;

    // 标题
    if (sheetTitle) {
      gen.mergeCells(sheetName, currentRow, 1, currentRow, Math.max(headers.length, 2));
      gen.setCell(sheetName, currentRow, 1, sheetTitle, 'title');
      currentRow += 2;
    }

    // KPI 卡片
    if (kpis.length > 0) {
      gen.addKPICards(sheetName, currentRow, 1, kpis);
      currentRow += 3;
    }

    // 数据表
    if (headers.length > 0 || data.length > 0) {
      const tableHeaders = headers.length > 0 ? headers
        : (data.length > 0 ? data[0].map((_, i) => `列${i + 1}`) : ['A', 'B']);

      const tableData = headers.length > 0 ? data
        : (data.length > 1 ? data.slice(1) : []);

      gen.writeTable(sheetName, currentRow, 1, tableHeaders, tableData, {
        columnFormats,
        totalRow,
        totalLabel,
      });

      const dataEndRow = currentRow + 1 + tableData.length + (totalRow ? 1 : 0);
      const dataEndCol = tableHeaders.length;

      // 条件格式
      if (colorScale) {
        const cols = typeof colorScale === 'string' ? [colorScale]
          : (Array.isArray(colorScale) ? colorScale
          : tableHeaders.filter(h => columnFormats[h] === 'number' || columnFormats[h] === 'currency' || columnFormats[h] === 'percent'));
        for (const col of cols) {
          const colIdx = typeof col === 'string' ? tableHeaders.indexOf(col) + 1 : col;
          if (colIdx > 0) {
            const colLetter = String.fromCharCode(64 + colIdx);
            gen.addColorScale(sheetName, `${colLetter}${currentRow + 1}:${colLetter}${dataEndRow - (totalRow ? 1 : 0)}`);
          }
        }
      }

      if (dataBar) {
        const cols = typeof dataBar === 'string' ? [dataBar]
          : (Array.isArray(dataBar) ? dataBar
          : []);
        for (const col of cols) {
          const colIdx = typeof col === 'string' ? tableHeaders.indexOf(col) + 1 : col;
          if (colIdx > 0) {
            const colLetter = String.fromCharCode(64 + colIdx);
            gen.addDataBar(sheetName, `${colLetter}${currentRow + 1}:${colLetter}${dataEndRow - (totalRow ? 1 : 0)}`);
          }
        }
      }

      // 自动筛选
      if (autoFilter && tableData.length > 0) {
        const endColLetter = String.fromCharCode(64 + dataEndCol);
        gen.addAutoFilter(sheetName, `${String.fromCharCode(64 + 1)}${currentRow}:${endColLetter}${dataEndRow}`);
      }

      // 冻结
      if (freezeRow > 0) {
        gen.freezeRow(sheetName, freezeRow);
      } else {
        gen.freezeRow(sheetName, currentRow);
      }
    }

    // 自动列宽
    gen.autoColumnWidth(sheetName);
  }

  return await gen.toBuffer();
}

registry.register({
  name: 'xlsx_generate',
  toolset: 'document',
  category: 'document',
  description: 'Generate a professionally formatted Excel (.xlsx) file from structured data. Supports multiple sheets, KPI cards, conditional formatting (color scales, data bars), auto-filter, totals row, and 6 color schemes.',
  whenNotToUse: ['不要用于查询已有 Excel，改用 xlsx_query', '不要用于简单 CSV 输出'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    properties: {
      sheets: {
        type: 'array',
        description: 'Array of sheet definitions. Each sheet has: name, title, headers (array of column names), data (2D array of values), columnFormats (map of column name to format: number|integer|percent|currency|currency_usd|date|datetime), totalRow (boolean), totalLabel, kpis (array of {label, value, format}), colorScale (true or column name array), dataBar (column name array)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Sheet name (max 31 chars)' },
            title: { type: 'string', description: 'Sheet title shown at top' },
            headers: { type: 'array', items: { type: 'string' }, description: 'Column header names' },
            data: { type: 'array', items: { type: 'array' }, description: 'Data rows (2D array)' },
            columnFormats: { type: 'object', description: 'Map of header name to format type. Valid: number, integer, percent, currency, currency_usd, date, datetime' },
            totalRow: { type: 'boolean', description: 'Add a total row with SUM formulas' },
            totalLabel: { type: 'string', description: 'Label for total row (default: 合计)', default: '合计' },
            kpis: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: {}, format: { type: 'string' } } }, description: 'KPI cards at top of sheet' },
            colorScale: { description: 'Add green→yellow→red color scale. true=all numeric cols, or list column names' },
            dataBar: { description: 'Add data bars. Pass column name(s) to highlight' },
          },
        },
      },
      colorScheme: { type: 'string', enum: ['corporate', 'green', 'blue', 'red', 'purple', 'dark'], description: 'Color scheme for headers and accents (default: corporate dark blue)' },
      title: { type: 'string', description: 'Overall workbook title (used as filename prefix if no outputPath given)' },
      outputPath: { type: 'string', description: 'Output file path. Auto-generated in workspace if omitted.' },
    },
    required: ['sheets'],
  },
  async handler(params) {
    // 2026-08-23: 解包 data 嵌套——deepseek 实机三种形态: ①{"data":{"sheets":[...]}}
    // ②{"data":"{\"sheets\":[...]}"}(JSON 字符串对象) ③{"data":"[...]"}(JSON 字符串数组)
    // (契约已 anyOf 放行, handler 这里统一取数; 别名漂移同类第 7 处)
    let rawData = params.data;
    if (typeof rawData === 'string' && rawData.trim()) {
      try { rawData = JSON.parse(rawData); } catch (e) { rawData = null; }
    }
    const dataWrap = (rawData && typeof rawData === 'object') ? rawData : {};
    const sheets = params.sheets || (Array.isArray(rawData) ? rawData : dataWrap.sheets);
    const { colorScheme, outputPath } = params;
    const title = params.title || dataWrap.title;
    let fgTaskId = null;
    let hbTimer = null;
    try {
      fgTaskId = filegen.ensureFileGenTask({ title: title || 'Excel 表格', format: 'xlsx', phase: 'writing', label: '正在生成 Excel 表格…' });
    } catch (fgErr) { console.error('[filegen] xlsx_generate 插桩失败(不阻塞):', fgErr.message); }
        if (fgTaskId) hbTimer = startFilegenHeartbeat(fgTaskId, '正在生成 Excel 表格…');
    try {
      const buffer = await _generateXlsx({ sheets, colorScheme: colorScheme || 'corporate', title });

      let outPath = outputPath;
      if (!outPath) {
        const workspaceDir = getDocumentArtifactsDir();
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        const safeName = sanitizeFilename(title || sheets[0]?.title || sheets[0]?.name, 'report');
        outPath = path.join(workspaceDir, `${safeName}_${Date.now()}.xlsx`);
      }

      fs.writeFileSync(outPath, buffer);
      const sizeKB = (buffer.length / 1024).toFixed(1);
      console.log(`✅ xlsx_generate: ${outPath} (${sizeKB}KB) [${colorScheme || 'corporate'} / ${sheets.length} sheet(s)]`);
      try {
        if (fgTaskId) {
          filegen.doneFileGen(fgTaskId, {
            path: outPath,
            name: outPath.split(/[/\\]/).pop(),
            size: buffer.length,
            format: 'xlsx',
            url: filegen.previewUrlFor('xlsx', outPath),
          });
        }
      } catch (fgErr) { console.error('[filegen] xlsx_generate done 插桩失败(不阻塞):', fgErr.message); }
      return {
        success: true,
        path: outPath,
        size: buffer.length,
        sizeKB,
        sheets: sheets.length,
        colorScheme: colorScheme || 'corporate',
        message: `Excel 文件已生成 (${sheets.length} 个工作表, 配色: ${colorScheme || 'corporate'})`,
      };
    } catch (e) {
      console.error('xlsx_generate 失败:', e.message);
      try { if (fgTaskId) filegen.failFileGen(fgTaskId, 'Excel generation failed: ' + e.message); }
      catch (fgErr) { console.error('[filegen] xlsx_generate fail 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      return { success: false, error: 'Excel generation failed: ' + e.message };
    }
  },
});

// ============================================================
// PPTX 生成：结构化幻灯片数据 → 专业格式化 PowerPoint
// 使用内置 PPTGenerator 引擎（data/skills/pptx-generator/generate.js）
// ============================================================

/**
 * 从幻灯片规格生成格式化的 PowerPoint 文件
 * @param {Object} spec - { slides, style, title }
 * @returns {Promise<Buffer>}
 */
async function _generatePptx(spec) {
  const SCHEMES_PATH = path.join(__dirname, "..", "..", "data", "pptx-color-schemes-36.json");
  var COLOR_SCHEMES = {};
  var PPTX_STYLES = ["business_blue","academic_white","creative_purple","tech_dark","minimal_gray"];
  try { if (fs.existsSync(SCHEMES_PATH)) { var loaded = JSON.parse(fs.readFileSync(SCHEMES_PATH,"utf-8")); if (loaded.schemes) { COLOR_SCHEMES = {}; for (var n in loaded.schemes) { var s = loaded.schemes[n]; COLOR_SCHEMES[n] = { primary: s.primary, secondary: s.secondary, accent: s.accent, text: s.text, bg: s.bg, titleText: s.titleText||"FFFFFF" }; } PPTX_STYLES = Object.keys(COLOR_SCHEMES); } } } catch(e) { console.warn("[pptx] 配色文件加载失败:", e.message); }
  if (Object.keys(COLOR_SCHEMES).length === 0) {
    COLOR_SCHEMES = { business_blue: { primary:"1E3C72", secondary:"4682B4", accent:"FFC107", text:"333333", bg:"FFFFFF", titleText:"FFFFFF" }, academic_white: { primary:"003366", secondary:"666666", accent:"CC0000", text:"333333", bg:"FFFFFF", titleText:"FFFFFF" }, creative_purple:{ primary:"662D8C", secondary:"9B59B6", accent:"F1C40F", text:"333333", bg:"F8F8FF", titleText:"FFFFFF" }, tech_dark: { primary:"1E1E1E", secondary:"3C3C3C", accent:"00C896", text:"F0F0F0", bg:"14141A", titleText:"F0F0F0" }, minimal_gray: { primary:"505050", secondary:"969696", accent:"0078D7", text:"333333", bg:"FAFAFA", titleText:"FFFFFF" } };
    PPTX_STYLES = Object.keys(COLOR_SCHEMES);
  }
  var styleName = PPTX_STYLES.indexOf(spec.style) >= 0 ? spec.style : "business_blue";
  // 旧名称 → 新名称映射（向后兼容）
  var NAME_MAP = {
    business_blue: 'corporate-clean', academic_white: 'academic-paper', creative_purple: 'catppuccin-mocha',
    tech_dark: 'tokyo-night', minimal_gray: 'minimal-white', modern: 'pitch-deck-vc',
    classic: 'nord', dark: 'aurora', ocean: 'arctic-cool', forest: 'terminal-green',
    sunset: 'sunset-warm', pastel: 'soft-pastel', github: 'blueprint', corporate: 'corporate-clean',
    ink: 'japanese-minimal', neubrutalism: 'neo-brutalism', duotone: 'sharp-mono',
  };
  // 如果旧名称不在方案中，尝试映射
  if (!COLOR_SCHEMES[styleName] && NAME_MAP[styleName] && COLOR_SCHEMES[NAME_MAP[styleName]]) {
    styleName = NAME_MAP[styleName];
  }

  // 延迟加载 PPTGenerator
  const pptxgenjs = (() => {
    try { return require('pptxgenjs'); } catch (_) { return null; }
  })();

  if (!pptxgenjs) {
    throw new Error('pptxgenjs 不可用，请运行 npm install pptxgenjs');
  }

  const colors = COLOR_SCHEMES[styleName];
  const pptx = new pptxgenjs();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'CrabPaw';
  pptx.subject = spec.title || 'Generated by CrabPaw';

  const FONT_TITLE = 'Microsoft YaHei';
  const FONT_BODY = 'Microsoft YaHei';
  const meta = colors._meta || {};
  const surface2 = meta.surface2 || 'F5F7FA';
  const borderC = meta.border || 'E0E0E0';
  const text3 = meta.text3 || '8B93A8';

  // 2026-08-23 版式升级：页码/页脚 + 标题栏装饰线（内容页统一）
  function _addTitleBar(slide, title, idx, total) {
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 0, y: 0, w: 10, h: 0.9,
      fill: { color: colors.primary },
    });
    // 标题栏底部强调线（accent 3px）——比纯色条更有设计层次
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: 0, y: 0.9, w: 10, h: 0.04,
      fill: { color: colors.accent },
    });
    slide.addText(title, {
      x: 0.5, y: 0.1, w: 9.0, h: 0.8,
      fontSize: title.length > 22 ? 22 : 26,
      fontFace: FONT_TITLE,
      color: colors.titleText, bold: true, valign: 'middle',
    });
    // 页码 + 主题角标（右下角，弱化色）
    if (typeof idx === 'number' && typeof total === 'number') {
      slide.addText(`${idx} / ${total}`, {
        x: 8.4, y: 5.45, w: 1.2, h: 0.35,
        fontSize: 10, fontFace: FONT_BODY, color: text3, align: 'right', valign: 'middle',
      });
    }
  }

  // 内容字号自适应：条目越多字号越小（防溢出）
  function _autoSize(n) {
    if (n >= 10) return 13;
    if (n >= 7) return 15;
    if (n >= 5) return 16;
    return 17;
  }

  function _mkBullet(text, fontSize, color, code) {
    return {
      text: typeof text === 'string' ? text : (text && text.text) || String(text || ''),
      options: {
        fontSize, fontFace: FONT_BODY, color: color || colors.text,
        bullet: { code: code || '2022' }, paraSpaceAfter: 7,
      },
    };
  }

  // 2026-08-23 版式升级（用户反馈「PPT 很丑、排版简单、内容单薄」）:
  // 语义图标前缀（要点卡左上角/两列列表）——按关键词匹配, 无命中返回空（用编号兜底）
  function _smartIcon(text) {
    const MAP = [
      [/数据|统计|增长|指标|规模|份额/, '📊'], [/安全|隐私|加密|防护|合规/, '🔒'],
      [/速度|延迟|响应|性能|毫秒|实时/, '⚡'], [/趋势|发展|未来|前景|展望/, '🚀'],
      [/挑战|风险|难点|瓶颈|限制|难题/, '⚠️'], [/成本|价格|经济|费用|投入/, '💰'],
      [/手机|移动|终端|设备|硬件/, '📱'], [/AI|智能|模型|算法|学习|推理/, '🤖'],
      [/总结|核心|本质|关键|结论/, '✅'], [/案例|例子|示例|实践|场景|落地/, '💡'],
      [/用户|体验|交互|界面|需求/, '👤'], [/云|联网|在线|服务端/, '☁️'],
    ];
    for (const [re, icon] of MAP) { if (re.test(String(text))) return icon; }
    return '';
  }

  // 2026-08-23: 要点富文本——「观点：支撑」结构拆分（首段加粗主色, 读起来有层次）;
  // 无分隔符则整条常规显示
  function _pointRuns(text, fontSize) {
    const raw = String(text);
    const m = raw.match(/^(.*?)[：:——]\s*(.+)$/s);
    if (m && m[1] && m[2]) {
      return [
        { text: m[1] + '：', options: { fontSize, fontFace: FONT_BODY, color: colors.primary, bold: true, paraSpaceAfter: 2 } },
        { text: m[2], options: { fontSize, fontFace: FONT_BODY, color: colors.text } },
      ];
    }
    return [{ text: raw, options: { fontSize, fontFace: FONT_BODY, color: colors.text } }];
  }

  const totalSlides = (spec.slides || []).length;

  for (let si = 0; si < totalSlides; si++) {
    const s = spec.slides[si];
    // 2026-08-23 字段别名对齐（deepseek 实传 layout/points/left_points——旧引擎
    // 只认 type/bullets/left/right → 所有页按空 content 渲染, 内容全丢）；
    // 2026-08-23 二轮: 用户实机 PPT 再传 left_bullets/right_bullets/note 新变体
    // （对比页两列正文全丢, 仅剩列标题空壳——解包 端侧AI知识普及_1787426431543.pptx
    // slide6 实锤 11 shape 仅 4 有文本）。items = bullets 要点别名, 一并兼容。
    const type = s.type || s.layout || 'content';
    const bullets = s.bullets || s.points || s.items || [];
    const left = s.left || s.left_points || s.left_bullets || s.left_content || [];
    const right = s.right || s.right_points || s.right_bullets || s.right_content || [];
    const leftTitle = s.left_title || s.leftTitle || '';
    const rightTitle = s.right_title || s.rightTitle || '';
    const pageNo = si + 1;

    if (type === 'title') {
      const slide = pptx.addSlide();
      slide.background = { color: colors.bg };
      // 封面升级：左侧主色竖带 + 右上几何圆点装饰 + 双层强调线
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: 0, y: 0, w: 0.35, h: 5.63, fill: { color: colors.primary },
      });
      slide.addShape(pptx.shapes.OVAL, {
        x: 8.6, y: 0.5, w: 0.5, h: 0.5, fill: { color: colors.accent },
      });
      slide.addShape(pptx.shapes.OVAL, {
        x: 8.0, y: 1.15, w: 0.25, h: 0.25, fill: { color: colors.secondary },
      });
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: 1.5, y: 2.0, w: 2.2, h: 0.05, fill: { color: colors.accent },
      });
      slide.addText(s.title || '', {
        x: 0.8, y: 2.25, w: 8.4, h: 1.5,
        fontSize: s.title && s.title.length > 16 ? 36 : 44,
        fontFace: FONT_TITLE,
        color: colors.primary, bold: true, align: 'center', valign: 'middle',
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 0.8, y: 3.85, w: 8.4, h: 0.8,
          fontSize: 20, fontFace: FONT_BODY,
          color: colors.secondary, align: 'center', valign: 'top',
        });
      }
      slide.addShape(pptx.shapes.RECTANGLE, {
        x: 1.5, y: 4.85, w: 2.2, h: 0.05, fill: { color: colors.accent },
      });
    } else if (type === 'content') {
      const slide = pptx.addSlide();
      slide.background = { color: colors.bg };
      _addTitleBar(slide, s.title || '', pageNo, totalSlides);
      // 2026-08-23 版式升级（用户反馈「排版过于简单、主内容区单薄」）: 平铺列表 →
      // 要点卡片网格（≤4 条 2×2, 5-6 条 3×2）——圆角色块卡 + 浅色底 + 主色描边 +
      // 左上角语义图标/编号圆点 + 「观点：支撑」首段加粗。克制设计: 无阴影渐变。
      const pts = bullets.filter((b) => b !== undefined && b !== null && String(b).trim());
      if (pts.length > 0) {
        const cols = pts.length <= 2 ? pts.length : (pts.length <= 4 ? 2 : 3);
        const rows = Math.ceil(pts.length / cols);
        const GAP = 0.28, MARGIN_X = 0.5, TOP_Y = 1.4, BOTTOM = 5.15;
        const cardW = (9.2 - (cols - 1) * GAP) / cols;
        const cardH = (BOTTOM - TOP_Y - (rows - 1) * GAP) / rows;
        const fs = cols === 3 || rows >= 3 ? 11 : 12.5;
        pts.forEach((pt, i) => {
          const r = Math.floor(i / cols), c = i % cols;
          const x = MARGIN_X + c * (cardW + GAP);
          const y = TOP_Y + r * (cardH + GAP);
          slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
            x, y, w: cardW, h: cardH,
            fill: { color: surface2 }, line: { color: colors.primary, width: 1 },
            rectRadius: 0.06,
          });
          const icon = _smartIcon(pt);
          slide.addShape(pptx.shapes.OVAL, {
            x: x + 0.18, y: y + 0.18, w: 0.42, h: 0.42,
            fill: { color: colors.primary },
          });
          slide.addText(icon || String(i + 1).padStart(2, '0'), {
            x: x + 0.18, y: y + 0.13, w: 0.42, h: 0.42,
            fontSize: icon ? 14 : 11, fontFace: FONT_BODY, color: 'FFFFFF', align: 'center', valign: 'middle', bold: !icon,
          });
          slide.addText(_pointRuns(pt, fs), {
            x: x + 0.75, y: y + 0.12, w: cardW - 0.95, h: cardH - 0.24, valign: 'middle',
          });
        });
      }
    } else if (type === 'two_column') {
      const slide = pptx.addSlide();
      slide.background = { color: colors.bg };
      _addTitleBar(slide, s.title || '', pageNo, totalSlides);
      const mkRows = (items) => (items || []).map(item => {
        // 2026-08-23: 两列页轻量点缀——语义图标前缀（空间窄, 保持列表不卡片化）
        const icon = _smartIcon(item);
        return _mkBullet(icon ? icon + ' ' + String(item) : String(item), 15);
      });
      // 列标题（左/右各一小标题 + 色块点）——提升两列可读性
      const colTitle = (t, x) => {
        if (!t) return;
        slide.addShape(pptx.shapes.OVAL, { x, y: 1.28, w: 0.16, h: 0.16, fill: { color: colors.accent } });
        slide.addText(t, {
          x: x + 0.25, y: 1.15, w: 3.8, h: 0.4,
          fontSize: 14, fontFace: FONT_TITLE, color: colors.primary, bold: true, valign: 'middle',
        });
      };
      colTitle(leftTitle, 0.5);
      colTitle(rightTitle, 5.3);
      slide.addText(mkRows(left), { x: 0.5, y: 1.7, w: 4.3, h: 3.7, valign: 'top' });
      slide.addShape(pptx.shapes.LINE, {
        x: 5.0, y: 1.35, w: 0.0, h: 4.0,
        line: { color: borderC, width: 1, dashType: 'dash' },
      });
      slide.addText(mkRows(right), { x: 5.3, y: 1.7, w: 4.3, h: 3.7, valign: 'top' });
    } else if (type === 'table') {
      const slide = pptx.addSlide();
      slide.background = { color: colors.bg };
      _addTitleBar(slide, s.title || '', pageNo, totalSlides);
      const headers = s.headers || s.tableData?.headers || [];
      const rows = s.rows || s.tableData?.rows || [];
      // 表头底色 + 隔行浅色（surface2）——数据可读性
      const tableRows = [
        headers.map(h => ({ text: String(h),
          options: { bold: true, fontSize: 14, fontFace: FONT_TITLE, color: 'FFFFFF', fill: { color: colors.primary }, align: 'center', valign: 'middle' },
        })),
        ...rows.map((row, ri) => (row || []).map(cell => ({ text: String(cell),
          options: { fontSize: 12, fontFace: FONT_BODY, color: colors.text, align: 'center', valign: 'middle', fill: ri % 2 === 1 ? { color: surface2 } : undefined },
        }))),
      ];
      const colCount = Math.max(headers.length, ...rows.map(r => (r || []).length), 1);
      slide.addTable(tableRows, {
        x: 0.5, y: 1.5, w: 9.0,
        border: { pt: 0.5, color: borderC },
        colW: Array.from({ length: colCount }, () => 9.0 / colCount),
        rowH: [0.5, ...rows.map(() => 0.42)],
        autoPage: false,
      });
    } else if (type === 'summary') {
      const slide = pptx.addSlide();
      slide.background = { color: colors.bg };
      _addTitleBar(slide, s.title || '', pageNo, totalSlides);
      if (bullets.length > 0) {
        const fs = _autoSize(bullets.length);
        slide.addText(bullets.map(p => _mkBullet(p, fs, colors.text, '2713')), { x: 0.8, y: 1.35, w: 8.4, h: 3.2, valign: 'top' });
      }
      if (s.conclusion) {
        slide.addShape(pptx.shapes.ROUNDED_RECTANGLE, {
          x: 0.8, y: 4.85, w: 8.4, h: 0.85,
          fill: { color: colors.secondary }, rectRadius: 0.1,
        });
        slide.addText(s.conclusion, {
          x: 0.8, y: 4.85, w: 8.4, h: 0.85,
          fontSize: 15, fontFace: FONT_TITLE,
          color: colors.titleText, bold: true, align: 'center', valign: 'middle',
        });
      }
    }
    // 演讲者备注（模型实传 notes 字段）
    if (s.notes || s.note) {
      try { pptx.getSlides()[pptx.getSlides().length - 1].addNotes(String(s.notes || s.note)); } catch (e) { /* 备注写入失败不阻塞 */ }
    }
  }

  // 输出为 buffer
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buffer;
}

registry.register({
  name: 'pptx_generate',
  toolset: 'document',
  category: 'document',
  description: 'Generate a professionally formatted PowerPoint (.pptx) presentation from structured slide data. Supports 5 color schemes and 5 slide types: title, content, two_column, table, summary.',
  whenNotToUse: ["不要用于读取已有 PPT","复杂演示需求优先使用 presentation-builder 做主题路由"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      slides: {
        type: 'array',
        description: 'Array of slide definitions. Each slide has a type (title|content|two_column|table|summary) and type-specific fields. Title slides: title, subtitle. Content slides: title, bullets[]. Two-column: title, left[], right[]. Table: title, headers[], rows[][]. Summary: title, points[], conclusion.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['title', 'content', 'two_column', 'table', 'summary'], description: 'Slide type. Alias: layout (layout: "title" etc. both work)' },
            layout: { type: 'string', enum: ['title', 'content', 'two_column', 'table', 'summary'], description: 'Alias of type (compatibility). Same values.' },
            title: { type: 'string', description: 'Slide title' },
            subtitle: { type: 'string', description: 'Subtitle (title slide only)' },
            bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points (content slide). Alias: points/items' },
            points: { type: 'array', items: { type: 'string' }, description: 'Alias of bullets (compatibility). Same semantics.' },
            items: { type: 'array', items: { type: 'string' }, description: 'Alias of bullets (compatibility). Same semantics.' },
            left: { type: 'array', items: { type: 'string' }, description: 'Left column items (two_column). Alias: left_points/left_bullets/left_content' },
            left_points: { type: 'array', items: { type: 'string' }, description: 'Alias of left (compatibility).' },
            left_bullets: { type: 'array', items: { type: 'string' }, description: 'Alias of left (compatibility).' },
            left_content: { type: 'array', items: { type: 'string' }, description: 'Alias of left (compatibility).' },
            right: { type: 'array', items: { type: 'string' }, description: 'Right column items (two_column). Alias: right_points/right_bullets/right_content' },
            right_points: { type: 'array', items: { type: 'string' }, description: 'Alias of right (compatibility).' },
            right_bullets: { type: 'array', items: { type: 'string' }, description: 'Alias of right (compatibility).' },
            right_content: { type: 'array', items: { type: 'string' }, description: 'Alias of right (compatibility).' },
            left_title: { type: 'string', description: 'Left column heading (two_column)' },
            right_title: { type: 'string', description: 'Right column heading (two_column)' },
            headers: { type: 'array', items: { type: 'string' }, description: 'Table headers' },
            rows: { type: 'array', items: { type: 'array' }, description: 'Table data rows (2D array)' },
            conclusion: { type: 'string', description: 'Conclusion text (summary slide)' },
            notes: { type: 'string', description: 'Speaker notes for this slide (optional). Alias: note' },
            note: { type: 'string', description: 'Alias of notes (compatibility).' },
            // 2026-08-23 别名兼容：deepseek 实机 table 类型传 tableData:{headers,rows}（契约名 headers/rows）→ ajv 拒。
            tableData: { type: 'object', properties: { headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array' } } }, description: 'Alias of headers+rows (compatibility). { headers: [], rows: [[]] }' },
          },
        },
      },
      style: { type: 'string', description: 'Color scheme (36 options from pptx-color-schemes-36.json). Popular: corporate-clean, pitch-deck-vc, minimal-white, editorial-serif, sunset-warm, tokyo-night. Old names still work: business_blue, modern, dark' },
      // 2026-08-23 别名兼容：deepseek 实机传 colorScheme（契约名 style）→ ajv 拒 3 次后模型改走 MarkdownToPPT 又失败，双断。
      colorScheme: { type: 'string', description: 'Alias of style (compatibility). Same color scheme values.' },
      title: { type: 'string', description: 'Presentation title (used for filename if no outputPath)' },
      outputPath: { type: 'string', description: 'Output file path. Auto-generated in workspace if omitted.' },
    },
    required: ['slides'],
  },
  async handler(params) {
    const { slides, style, colorScheme, title, outputPath } = params;
    const effStyle = style || colorScheme || 'business_blue';
    let fgTaskId = null;
    let hbTimer = null;
    try {
      fgTaskId = filegen.ensureFileGenTask({ title: title || 'PPT 演示', format: 'pptx', phase: 'writing', label: '正在生成 PPT 演示…' });
    } catch (fgErr) { console.error('[filegen] pptx_generate 插桩失败(不阻塞):', fgErr.message); }
        if (fgTaskId) hbTimer = startFilegenHeartbeat(fgTaskId, '正在生成 PPT 演示…');
    try {
      const buffer = await _generatePptx({ slides: slides || [], style: effStyle, title });

      let outPath = outputPath;
      if (!outPath) {
        const workspaceDir = getDocumentArtifactsDir();
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        const safeName = sanitizeFilename(title || slides?.[0]?.title, 'presentation');
        outPath = path.join(workspaceDir, `${safeName}_${Date.now()}.pptx`);
      }

      fs.writeFileSync(outPath, buffer);
      const sizeKB = (buffer.length / 1024).toFixed(1);
      console.log(`✅ pptx_generate: ${outPath} (${sizeKB}KB) [${effStyle} / ${(slides || []).length} slide(s)]`);
      try {
        if (fgTaskId) {
          filegen.doneFileGen(fgTaskId, {
            path: outPath,
            name: outPath.split(/[/\\]/).pop(),
            size: buffer.length,
            format: 'pptx',
            url: filegen.previewUrlFor('pptx', outPath),
          });
        }
      } catch (fgErr) { console.error('[filegen] pptx_generate done 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      if (hbTimer) clearInterval(hbTimer);
      if (hbTimer) clearInterval(hbTimer);
      if (hbTimer) clearInterval(hbTimer);
      return {
        success: true, path: outPath, size: buffer.length, sizeKB,
        slides: (slides || []).length, style: effStyle,
        message: `PPT 已生成 (${(slides || []).length} 页, 配色: ${effStyle})`,
      };
    } catch (e) {
      console.error('pptx_generate 失败:', e.message);
      try { if (fgTaskId) filegen.failFileGen(fgTaskId, 'PPT generation failed: ' + e.message); }
      catch (fgErr) { console.error('[filegen] pptx_generate fail 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      return { success: false, error: 'PPT generation failed: ' + e.message };
    }
  },
});

// ============================================================
// PDF 生成：HTML → 专业格式化 PDF（Playwright 渲染）
// 4 种预设模板，对标 Word 美化体系
// ============================================================

const PDF_STYLES = {
  '商务报告': {
    page: { size: 'A4', margin: { top: '2.54cm', bottom: '2.54cm', left: '2.54cm', right: '2.54cm' } },
    css: `
      @page { size: A4; margin: 2.54cm; @bottom-center { content: counter(page); font-family: 'Microsoft YaHei', sans-serif; font-size: 9pt; color: #999; } }
      body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; font-size: 11pt; color: #1A1A1A; line-height: 1.6; }
      h1 { font-size: 22pt; color: #1A3A5C; border-bottom: 3px solid #1A3A5C; padding-bottom: 8px; margin-top: 0; }
      h2 { font-size: 16pt; color: #1A3A5C; margin-top: 24pt; page-break-after: avoid; }
      h3 { font-size: 13pt; color: #2B5797; margin-top: 18pt; page-break-after: avoid; }
      h4 { font-size: 11pt; color: #2B5797; font-weight: bold; }
      table { width: 100%; border-collapse: collapse; margin: 12pt 0; page-break-inside: avoid; }
      th { background: #1A3A5C; color: #FFFFFF; padding: 8pt 10pt; font-size: 10pt; text-align: left; }
      td { padding: 6pt 10pt; border-bottom: 1px solid #E0E6ED; font-size: 10pt; }
      tr:nth-child(even) td { background: #F2F6FA; }
      code { font-family: 'Consolas', 'Courier New', monospace; font-size: 9pt; background: #F5F5F5; padding: 2pt 4pt; border-radius: 2pt; }
      pre { background: #F5F5F5; padding: 12pt; border-left: 3px solid #1A3A5C; font-size: 9pt; line-height: 1.4; overflow-x: auto; page-break-inside: avoid; }
      blockquote { border-left: 4px solid #2B5797; margin: 12pt 0; padding: 8pt 16pt; color: #666; font-style: italic; background: #F7FAFC; }
      ul, ol { margin: 6pt 0; padding-left: 24pt; }
      li { margin: 3pt 0; }
      hr { border: none; border-top: 1px solid #CCC; margin: 20pt 0; }
      .cover-title { text-align: center; padding-top: 120pt; }
      .cover-title h1 { font-size: 28pt; border-bottom: none; margin-bottom: 8pt; }
      .cover-title .subtitle { font-size: 14pt; color: #2B5797; }
      .cover-title .date { font-size: 11pt; color: #999; margin-top: 40pt; }
      .cover-line { width: 60%; height: 3px; background: #1A3A5C; margin: 20pt auto; }
    `,
  },
  '中国公文': {
    page: { size: 'A4', margin: { top: '3.7cm', bottom: '3.5cm', left: '2.8cm', right: '2.6cm' } },
    css: `
      @page { size: A4; margin: 3.7cm 2.6cm 3.5cm 2.8cm; @bottom-center { content: "— " counter(page) " —"; font-family: 'FangSong', '仿宋', serif; font-size: 10pt; } }
      body { font-family: 'FangSong', '仿宋', serif; font-size: 16pt; color: #000; line-height: 2; }
      h1 { font-family: 'SimHei', '黑体', sans-serif; font-size: 22pt; color: #D41C1C; text-align: center; font-weight: normal; }
      h2 { font-family: 'SimHei', '黑体', sans-serif; font-size: 16pt; font-weight: bold; margin-top: 20pt; }
      h3 { font-family: 'KaiTi', '楷体', serif; font-size: 16pt; font-weight: bold; margin-top: 16pt; }
      table { width: 100%; border-collapse: collapse; margin: 12pt 0; }
      th { background: #C00000; color: #FFF; padding: 6pt; font-size: 14pt; text-align: center; }
      td { padding: 6pt; border: 1px solid #333; font-size: 14pt; }
      hr { border: 2px solid #D41C1C; margin: 16pt 0; }
      .red-line { width: 100%; height: 3px; background: #D41C1C; margin: 8pt 0 20pt 0; }
    `,
  },
  '学术论文': {
    page: { size: 'A4', margin: { top: '2.54cm', bottom: '2.54cm', left: '3.17cm', right: '3.17cm' } },
    css: `
      @page { size: A4; margin: 2.54cm 3.17cm; @bottom-center { content: counter(page); font-family: 'SimSun', '宋体', serif; font-size: 9pt; } }
      body { font-family: 'SimSun', '宋体', serif; font-size: 12pt; color: #000; line-height: 1.8; }
      h1 { font-family: 'SimHei', '黑体', sans-serif; font-size: 16pt; text-align: center; font-weight: bold; }
      h2 { font-family: 'SimHei', '黑体', sans-serif; font-size: 14pt; font-weight: bold; margin-top: 18pt; }
      h3 { font-family: 'KaiTi', '楷体', serif; font-size: 12pt; font-weight: bold; margin-top: 14pt; }
      table { width: 100%; border-collapse: collapse; margin: 10pt 0; }
      th { background: #333; color: #FFF; padding: 6pt; font-size: 10pt; text-align: center; }
      td { padding: 5pt; border: 1px solid #666; font-size: 10pt; }
      blockquote { font-family: 'KaiTi', '楷体', serif; border-left: 3px solid #999; padding-left: 12pt; margin: 8pt 0; }
      .abstract { font-weight: bold; margin: 12pt 0; }
      .keywords { color: #555; }
    `,
  },
  '简约现代': {
    page: { size: 'A4', margin: { top: '2.5cm', bottom: '2.5cm', left: '2.5cm', right: '2.5cm' } },
    css: `
      @page { size: A4; margin: 2.5cm; @bottom-center { content: counter(page); font-family: 'Arial', sans-serif; font-size: 8pt; color: #BBB; } }
      body { font-family: 'Arial', 'Helvetica Neue', sans-serif; font-size: 10.5pt; color: #333; line-height: 1.5; }
      h1 { font-size: 20pt; color: #333; font-weight: 300; border-bottom: 2px solid #333; padding-bottom: 6px; letter-spacing: 2px; }
      h2 { font-size: 14pt; color: #555; font-weight: 400; margin-top: 28pt; }
      h3 { font-size: 11pt; color: #555; font-weight: 600; margin-top: 20pt; }
      table { width: 100%; border-collapse: collapse; margin: 10pt 0; }
      th { background: #444; color: #FFF; padding: 7pt; font-size: 9pt; font-weight: 400; text-transform: uppercase; letter-spacing: 1px; }
      td { padding: 6pt 8pt; border-bottom: 1px solid #EEE; font-size: 9.5pt; }
      tr:nth-child(even) td { background: #FAFAFA; }
      code { font-family: 'SF Mono', 'Consolas', monospace; background: #F8F8F8; padding: 2pt 5pt; font-size: 9pt; }
      pre { background: #F8F8F8; padding: 12pt; font-size: 9pt; }
      blockquote { border-left: 2px solid #CCC; padding: 4pt 12pt; color: #888; }
      hr { border: none; border-top: 1px solid #EEE; margin: 24pt 0; }
    `,
  },
};

/**
 * 将 HTML 内容渲染为格式化 PDF（使用 Playwright）
 * @param {string} html - HTML 内容片段（放入 <body>）
 * @param {Object} options - { style, title, author, coverPage }
 * @returns {Promise<Buffer>}
 */
async function _generatePdf(html, options = {}) {
  const styleName = options.style || '商务报告';
  const preset = PDF_STYLES[styleName] || PDF_STYLES['商务报告'];
  const { title, author } = options;

  // 构建封面（如果有 title 且内容不以 h1 开头）
  let coverHtml = '';
  if (title && !html.trim().startsWith('<h1')) {
    const isGw = styleName === '中国公文';
    const redLine = isGw ? '<div class="red-line"></div>' : '<div class="cover-line"></div>';
    coverHtml = `
      <div class="cover-title">
        ${isGw ? redLine : ''}
        <h1>${title}</h1>
        ${author ? `<p class="subtitle">${author}</p>` : ''}
        <p class="date">${new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
        ${!isGw ? '<div class="cover-line"></div>' : ''}
      </div>
      <div style="page-break-after: always;"></div>`;
  }

  const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  ${title ? `<title>${title}</title>` : ''}
  ${author ? `<meta name="author" content="${author}">` : ''}
  <style>${preset.css}</style>
</head>
<body>
  ${coverHtml}
  ${html}
</body>
</html>`;

  let browser;
  try {
    const { chromium } = require('playwright-core');
    // 2026-08-18 实机修复: playwright-core 默认找固定版本二进制，环境缺失则 PDF 必败
    // ——探测 ms-playwright 目录已装浏览器（headless shell 优先，其次完整版）兜底。
    const launchOpts = { headless: true };
    try {
      if (process.platform === 'win32') {
        const pwBase = path.join(require('os').homedir(), 'AppData', 'Local', 'ms-playwright');
        if (fs.existsSync(pwBase)) {
          const dirs = fs.readdirSync(pwBase).filter((d) => d.startsWith('chromium')).sort().reverse();
          const found = dirs
            .map((d) => {
              const shell = path.join(pwBase, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
              const win = path.join(pwBase, d, 'chrome-win', 'chrome.exe');
              return fs.existsSync(shell) ? shell : (fs.existsSync(win) ? win : null);
            })
            .filter(Boolean)[0];
          if (found) launchOpts.executablePath = found;
        }
      }
    } catch (pgErr) { console.warn('[pdf] Playwright 浏览器探测失败(用默认):', pgErr.message); }
    browser = await chromium.launch(launchOpts);
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: 'networkidle' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: preset.page.margin,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:9pt;color:#999;text-align:center;width:100%;font-family:'Microsoft YaHei',sans-serif;"><span class="pageNumber"></span></div>`,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    if (browser) await browser.close().catch(e => console.debug('[document] Close failed:', e?.message));
  }
}

registry.register({
  name: 'pdf_generate',
  toolset: 'document',
  category: 'document',
  description: 'Generate a professionally formatted PDF document from HTML content with 4 style presets. Uses Playwright for CSS rendering — supports tables, code blocks, blockquotes, page numbers.',
  whenNotToUse: ["不要用于读取已有 PDF，改用 pdf_extract","未安装 Playwright 时不要使用"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'HTML content to render as PDF (supports h1-h4, tables, code, blockquote, ul/ol, hr). Will be wrapped with style CSS.' },
      style: { type: 'string', enum: ['商务报告', '中国公文', '学术论文', '简约现代'], description: 'Style preset with fonts, colors, margins (default: 商务报告)' },
      title: { type: 'string', description: 'Document title (shown on cover page and used as filename prefix)' },
      author: { type: 'string', description: 'Document author (metadata)' },
      outputPath: { type: 'string', description: 'Output file path. Auto-generated in workspace if omitted.' },
    },
    required: ['content'],
  },
  async handler(params) {
    const { content, style, title, author, outputPath } = params;
    let fgTaskId = null;
    let hbTimer = null;
    try {
      fgTaskId = filegen.ensureFileGenTask({ title: title || 'PDF 文档', format: 'pdf', phase: 'writing', label: '正在转换 PDF…' });
    } catch (fgErr) { console.error('[filegen] pdf_generate 插桩失败(不阻塞):', fgErr.message); }
        if (fgTaskId) hbTimer = startFilegenHeartbeat(fgTaskId, '正在转换 PDF…');
    try {
      const buffer = await _generatePdf(content || '', { style: style || '商务报告', title, author });

      let outPath = outputPath;
      if (!outPath) {
        const workspaceDir = getDocumentArtifactsDir();
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        const safeName = sanitizeFilename(title, 'document');
        outPath = path.join(workspaceDir, `${safeName}_${Date.now()}.pdf`);
      }

      fs.writeFileSync(outPath, buffer);
      const sizeKB = (buffer.length / 1024).toFixed(1);
      console.log(`✅ pdf_generate: ${outPath} (${sizeKB}KB) [${style || '商务报告'}]`);
      try {
        if (fgTaskId) {
          filegen.doneFileGen(fgTaskId, {
            path: outPath,
            name: outPath.split(/[/\\]/).pop(),
            size: buffer.length,
            format: 'pdf',
            url: filegen.previewUrlFor('pdf', outPath),
          });
        }
      } catch (fgErr) { console.error('[filegen] pdf_generate done 插桩失败(不阻塞):', fgErr.message); }
      return {
        success: true, path: outPath, size: buffer.length, sizeKB,
        style: style || '商务报告',
        message: `PDF 已生成 (${sizeKB} KB, 模板: ${style || '商务报告'})`,
      };
    } catch (e) {
      console.error('pdf_generate 失败:', e.message);
      console.error('pdf_generate 失败:', e.message);
      try { if (fgTaskId) filegen.failFileGen(fgTaskId, 'PDF generation failed: ' + e.message); }
      catch (fgErr) { console.error('[filegen] pdf_generate fail 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      return { success: false, error: 'PDF generation failed: ' + e.message };
    }
  },
});

// ============================================================
// HTML 生成：Markdown/HTML → 带 CSS 美化的完整网页
// 5 种网页风格模板，响应式布局
// ============================================================

/**
 * 从内容生成美化 HTML 页面
 * @param {string} content — Markdown 或 HTML 内容
 * @param {Object} options — { style, title, lang, inputType: 'markdown'|'html' }
 * @returns {string} 完整 HTML 文档
 */
function _generateHtml(content, options = {}) {
  const { MarkdownRenderer } = require('../core/markdown-renderer');
  const renderer = new MarkdownRenderer();
  const inputType = options.inputType || 'markdown';
  const text = inputType === 'html'
    ? _stripHtmlBody(content)
    : content;
  return renderer.render(text, { style: options.style, title: options.title, lang: options.lang });
}

function _stripHtmlBody(html) {
  // Extract body content from HTML, or return as-is if no body tag
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html.replace(/<!DOCTYPE[^>]*>/i, '').replace(/<html[^>]*>|<\/html>/gi, '').replace(/<head[\s\S]*?<\/head>/i, '');
}

registry.register({
  name: 'html_generate',
  toolset: 'document',
  category: 'document',
  description: 'Generate a beautifully styled HTML webpage from Markdown or HTML content. Features 5 CSS templates with responsive design, syntax highlighting, and table styling.',
  whenNotToUse: ["不要用于读取已有 HTML 文件","不要用于生成 PDF，改用 pdf_generate"],

  riskLevel: 'low',

  schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Markdown or HTML content to render as a styled webpage' },
      style: { type: 'string', description: 'Webpage style template. Supported: 商务报告/技术文档/博客文章/落地页/简约暗色 (default: 商务报告); English hints auto-mapped (dark→简约暗色, light→商务报告)' },
      title: { type: 'string', description: 'Page title (shown in title bar and as heading)' },
      inputType: { type: 'string', description: 'Input content type: markdown or html (default: markdown; md/htm aliases accepted)' },
      outputPath: { type: 'string', description: 'Output .html file path. Auto-generated in workspace if omitted.' },
    },
    required: ['content'],
  },
  async handler(params) {
    const { content, style, title, inputType, outputPath } = params;
    // 2026-08-18: 契约容错——style/inputType 不再用严格 enum（模型常传 dark/light/md 等
    // 英文或别名，enum 被契约自动对齐后拦截 → 对话流报"❌ 失败"，虽经 Write 兜底成功
    // 仍误导用户以为生成失败）；此处归一化映射，未知值回落默认模板。
    const STYLE_MAP = {
      dark: '简约暗色', '简约暗色': '简约暗色', 暗色: '简约暗色', 深色: '简约暗色', 极简: '简约暗色',
      light: '商务报告', 商务: '商务报告', 简洁: '商务报告', 报告: '商务报告',
      博客: '博客文章', blog: '博客文章',
      技术: '技术文档', 文档: '技术文档', tech: '技术文档',
      落地: '落地页', 官网: '落地页', landing: '落地页',
    };
    const STYLE_WHITELIST = ['商务报告', '技术文档', '博客文章', '落地页', '简约暗色'];
    const normStyle = STYLE_WHITELIST.includes(style) ? style : (STYLE_MAP[String(style || '').trim()] || '商务报告');
    const normInputType = String(inputType || 'markdown').toLowerCase().trim() === 'html' ? 'html' : 'markdown';
    // 2026-08-17: filegen 插桩（不阻塞生成）——html_generate 直连 FileGenPanel
    let fgTaskId = null;
    let hbTimer = null;
    try {
      // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进③内容撰写；无活跃任务(直接生成)则新建。
      fgTaskId = filegen.ensureFileGenTask({ title: title || '网页', format: 'html', phase: 'writing', label: '正在编写网页…' });
    } catch (fgErr) { console.error('[filegen] html_generate 插桩失败(不阻塞):', fgErr.message); }
        if (fgTaskId) hbTimer = startFilegenHeartbeat(fgTaskId, '正在编写网页…');
    try {
      const html = _generateHtml(content || '', { style: normStyle, title: title, inputType: normInputType });

      let outPath = outputPath;
      if (!outPath) {
        const workspaceDir = getDocumentArtifactsDir();
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }
        const safeName = sanitizeFilename(title, 'page');
        outPath = path.join(workspaceDir, `${safeName}_${Date.now()}.html`);
      }

      fs.writeFileSync(outPath, html, 'utf-8');
      const sizeKB = (html.length / 1024).toFixed(1);
      console.log(`✅ html_generate: ${outPath} (${sizeKB}KB) [${normStyle}]`);
      try {
        if (fgTaskId) {
          filegen.doneFileGen(fgTaskId, {
            path: outPath,
            name: outPath.split(/[/\\]/).pop(),
            size: html.length,
            format: 'html',
            url: filegen.previewUrlFor('html', outPath),
          });
        }
      } catch (fgErr) { console.error('[filegen] html_generate done 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      return {
        success: true, path: outPath, size: html.length, sizeKB,
        style: normStyle,
        message: `HTML 网页已生成 (${sizeKB} KB, 模板: ${normStyle})`,
      };
    } catch (e) {
      console.error('html_generate 失败:', e.message);
      try { if (fgTaskId) filegen.failFileGen(fgTaskId, 'HTML generation failed: ' + e.message); }
      catch (fgErr) { console.error('[filegen] html_generate fail 插桩失败(不阻塞):', fgErr.message); }
      if (hbTimer) clearInterval(hbTimer);
      return { success: false, error: 'HTML generation failed: ' + e.message };
    }
  },
});



// ── html-presentation 工具注册 ─────────────────────────
(function() {
  try {
    var htmlMod = require('../../skills/html-presentation/executor.js');
    registry.register({
      name: 'html-presentation',
      toolset: 'document',
      category: 'document',
      description: 'Generate HTML presentation: 36 themes, 31 layouts, 47 animations, Chart.js.',
      whenNotToUse: ["不要用于生成 .pptx 文件，改用 pptx_generate","不要用于普通网页生成，改用 html_generate"],

      riskLevel: 'low',

      schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Presentation topic' },
          slides: { type: 'array', description: 'Slides array [{type, title, bullets, ...}]' },
          style: { type: 'string', description: 'Theme name (36 options)' },
        },
        required: ['slides'],
      },
      async handler(params) {
        return await htmlMod.execute(params);
      },
      timeout: 60000,
      isReadOnly: false,
    });
    // 2026-08-30 Task 11: 契约主名已 PascalCase 化（tool-contract.js），注册
    // PascalCase 主名→kebab 注册名的反向别名——契约自动对齐（registerIntoRegistry
    // 按 PascalCase 契约键 r.get）可命中真实工具。
    if (typeof registry.registerAlias === 'function') {
      registry.registerAlias('HtmlPresentation', 'html-presentation');
    }
  } catch(e) { console.warn('[html-presentation] 注册失败:', e.message); }
})();


// ── presentation-builder 工具注册 ─────────────────────────
(function() {
  try {
    var pbMod = require('../../skills/presentation-builder/executor.js');
    registry.register({
      name: 'presentation-builder',
      toolset: 'document',
      category: 'document',
      description: 'Analyze presentation topic, infer style/cover, generate outline, route to pptx_generate or html-presentation. Call this first when user asks to make a presentation.',
      whenNotToUse: ['不要直接调用 pptx_generate/html-presentation，演示需求应先经过本工具路由', '不要用于非演示类文档'],
      riskLevel: 'low',
      schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Presentation topic' },
          style: { type: 'string', description: 'Color scheme (auto-detected if omitted)' },
          slideCount: { type: 'number', description: 'Desired slide count (auto-detected)' },
        },
        required: ['topic'],
      },
      async handler(params) {
        return await pbMod.execute(params);
      },
      timeout: 15000,
      isReadOnly: true,
    });
    // 2026-08-30 Task 11: 同上——PresentationBuilder 契约主名反向别名。
    if (typeof registry.registerAlias === 'function') {
      registry.registerAlias('PresentationBuilder', 'presentation-builder');
    }
  } catch(e) { console.warn('[presentation-builder] 注册失败:', e.message); }
})();
module.exports = { extractDocxText, extractXlsxData, extractPdfText, extractPdfFull, parsePdfBuffer, _detectTables, _extractKeyFields, _generateDocx, _buildDocxXml, _buildManualZip, _generateXlsx, _generatePptx, _generatePdf, _generateHtml };
