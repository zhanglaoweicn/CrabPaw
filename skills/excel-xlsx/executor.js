/**
 * Excel XLSX 技能执行器
 *
 * 提供以下操作（通过 input.action 指定）：
 *   - create  根据 sheets 配置生成真实 .xlsx 文件
 *   - read    读取已有 .xlsx，返回结构化数据
 *
 * 依赖：exceljs（CrabPaw 全局依赖，与 excel-generator 共用引擎）
 */

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const HEADER_STYLE = {
  font: { bold: true, size: 12, color: { argb: 'FFFFFF' } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E3A5F' } },
  alignment: { horizontal: 'center', vertical: 'middle' },
  border: {
    top: { style: 'thin', color: { argb: 'D0D0D0' } },
    left: { style: 'thin', color: { argb: 'D0D0D0' } },
    bottom: { style: 'thin', color: { argb: 'D0D0D0' } },
    right: { style: 'thin', color: { argb: 'D0D0D0' } },
  },
};

const DATA_BORDER = {
  top: { style: 'thin', color: { argb: 'D0D0D0' } },
  left: { style: 'thin', color: { argb: 'D0D0D0' } },
  bottom: { style: 'thin', color: { argb: 'D0D0D0' } },
  right: { style: 'thin', color: { argb: 'D0D0D0' } },
};

async function execute(input) {
  const parsed = typeof input === 'string' ? { action: 'create', title: input } : (input || {});
  const action = parsed.action || 'create';

  try {
    switch (action) {
      case 'create':
        return await handleCreate(parsed);
      case 'read':
        return await handleRead(parsed);
      default:
        return { success: false, error: `不支持的操作: ${action}，可用操作: create, read` };
    }
  } catch (err) {
    console.error('[excel-xlsx] 执行失败:', err);
    return { success: false, error: err.message };
  }
}

async function handleCreate(input) {
  const title = input.title || '工作表';
  const sheets = input.sheets || [{ name: 'Sheet1', headers: ['A', 'B', 'C'], rows: [] }];
  const outputPath = input.outputPath || path.join(process.env.TEMP || '/tmp', `excel-${Date.now()}.xlsx`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CrabPaw';
  workbook.created = new Date();

  let totalRows = 0;

  for (const sheetConfig of sheets) {
    const sheetName = (sheetConfig.name || 'Sheet').replace(/[\\/*?[\]:]/g, '_').substring(0, 31);
    const ws = workbook.addWorksheet(sheetName);
    const headers = sheetConfig.headers || [];
    const rows = sheetConfig.rows || [];

    // Write headers
    if (headers.length > 0) {
      headers.forEach((header, colIdx) => {
        const cell = ws.getCell(1, colIdx + 1);
        cell.value = header;
        cell.font = HEADER_STYLE.font;
        cell.fill = HEADER_STYLE.fill;
        cell.alignment = HEADER_STYLE.alignment;
        cell.border = HEADER_STYLE.border;
      });
      ws.getRow(1).height = 28;
    }

    // Write data rows
    for (let r = 0; r < rows.length; r++) {
      const rowNum = r + 2; // row 1 is header
      ws.getRow(rowNum).height = 22;
      const rowData = rows[r];
      for (let c = 0; c < headers.length; c++) {
        const cell = ws.getCell(rowNum, c + 1);
        cell.value = rowData[c] !== undefined ? rowData[c] : '';
        cell.border = DATA_BORDER;
        cell.alignment = { vertical: 'middle' };
      }
      totalRows++;
    }

    // Auto column width
    ws.columns.forEach((col, idx) => {
      let maxLen = 10;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const len = (cell.value || '').toString().length;
        if (len > maxLen) maxLen = len;
      });
      col.width = Math.min(maxLen + 4, 50);
    });

    // Freeze header
    if (headers.length > 0) {
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
  }

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  await workbook.xlsx.writeFile(outputPath);

  return {
    success: true,
    outputPath,
    title,
    sheetCount: sheets.length,
    totalRows,
    message: `已生成「${title}」(${sheets.length} 个工作表, ${totalRows} 行数据)`,
  };
}

async function handleRead(input) {
  const filePath = input.filePath || input.file || input.path;
  if (!filePath) {
    return { success: false, error: '请提供 filePath 参数指定要读取的 .xlsx 文件' };
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, error: `文件不存在: ${filePath}` };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheets = [];
  workbook.eachSheet((ws) => {
    const headers = [];
    const rows = [];

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1 && row.values && row.values.length > 1) {
        // Extract headers from first row
        for (let i = 1; i < row.values.length; i++) {
          headers.push(row.values[i] !== undefined ? String(row.values[i]) : `COL${i}`);
        }
      } else if (row.values && row.values.length > 1) {
        const rowData = [];
        for (let i = 1; i <= headers.length; i++) {
          const val = row.values[i];
          rowData.push(val !== undefined ? val : '');
        }
        rows.push(rowData);
      }
    });

    sheets.push({ name: ws.name, headers, rows });
  });

  return {
    success: true,
    filePath,
    sheetCount: sheets.length,
    sheets,
  };
}

const schema = {
  name: 'excel-xlsx',
  description: 'Excel 生成与读取引擎（基于 exceljs 真实 .xlsx 输出）',
  capabilities: ['spreadsheet_generation', 'spreadsheet_reading'],
  input: {
    action: { type: 'string', enum: ['create', 'read'] },
    title: { type: 'string' },
    sheets: { type: 'array' },
    filePath: { type: 'file' },
  },
  output: {
    outputPath: { type: 'file' },
    sheetCount: { type: 'number' },
    totalRows: { type: 'number' },
  },
  whenNotToUse: '仅需 JSON 表格数据时不需要此技能，直接返回结构化数据即可',
};

module.exports = { execute, schema };
