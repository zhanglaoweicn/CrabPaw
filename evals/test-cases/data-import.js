const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCsvFile, inferColumnType, BUSINESS_DB_PATH, BUSINESS_DIR } = require('../../src/tools/data-import-tools');

function tmpCsv(content, name = `import_${Date.now()}.csv`) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

module.exports = {
  name: 'Data Import',
  cases: [
    {
      id: 'di_001',
      name: 'CSV 解析支持带引号逗号字段',
      category: 'data_import',
      run: () => {
        const p = tmpCsv('a,b,c\n"1,200","x,y",z\n');
        const r = parseCsvFile(p);
        return r.columns.join(',') === 'a,b,c' && r.rows[0][0] === '1,200' && r.rows[0][1] === 'x,y';
      },
    },
    {
      id: 'di_002',
      name: 'CSV 解析剥离 UTF-8 BOM',
      category: 'data_import',
      run: () => {
        const p = tmpCsv('﻿日期,金额\n2026-01-01,100\n');
        const r = parseCsvFile(p);
        return r.columns[0] === '日期' && r.rows.length === 1;
      },
    },
    {
      id: 'di_003',
      name: 'GBK 编码 CSV 自动解码（iconv-lite）',
      category: 'data_import',
      run: () => {
        const { encode } = require('iconv-lite');
        const p = path.join(os.tmpdir(), `gbk_${Date.now()}.csv`);
        fs.writeFileSync(p, encode('客户,金额\n张三,100\n', 'gbk'));
        const r = parseCsvFile(p);
        return r.columns[0] === '客户' && r.rows[0][0] === '张三';
      },
    },
    {
      id: 'di_004',
      name: '类型推断：数字/金额列 → REAL',
      category: 'data_import',
      run: () => inferColumnType(['100', '200.5', '0']) === 'REAL',
    },
    {
      id: 'di_005',
      name: '类型推断：日期列 → TEXT（不做日期类型）',
      category: 'data_import',
      run: () => inferColumnType(['2026-01-01', '2026-02-03']) === 'TEXT',
    },
    {
      id: 'di_006',
      name: '类型推断：混合文本 → TEXT',
      category: 'data_import',
      run: () => inferColumnType(['张三', '李四', '100']) === 'TEXT',
    },
    {
      id: 'di_007',
      name: '非法路径被拒绝（必须在 data/workspace 内）',
      category: 'data_import',
      run: async () => {
        const { handleImportDataFile } = require('../../src/tools/data-import-tools');
        const r = await handleImportDataFile({ filePath: 'C:/Windows/system32/evil.csv' }, {});
        return r.success === false;
      },
    },
    {
      id: 'di_008',
      name: '业务库路径常量固定于 data/.crabpaw/business',
      category: 'data_import',
      run: () => BUSINESS_DIR.endsWith('business') && BUSINESS_DB_PATH.endsWith('business.db'),
    },
    {
      id: 'di_009',
      name: '空文件或越权路径导入报错不崩溃',
      category: 'data_import',
      run: async () => {
        const { handleImportDataFile } = require('../../src/tools/data-import-tools');
        const { getDataDir } = require('../../src/core/config');
        const results = [];
        // 子检查 1：os.tmpdir() 中的空文件 → 越权路径边界先触发
        const p = path.join(os.tmpdir(), `empty_${Date.now()}.csv`);
        fs.writeFileSync(p, '');
        results.push(await handleImportDataFile({ filePath: p }, {}));
        // 子检查 2：数据目录内的空文件 → 空文件检测触发
        const dp = path.join(getDataDir(), `empty_${Date.now()}.csv`);
        fs.writeFileSync(dp, '');
        try {
          results.push(await handleImportDataFile({ filePath: dp }, {}));
        } finally {
          fs.rmSync(dp, { force: true });
        }
        return results.length === 2 && results.every((r) => r.success === false && !!r.error);
      },
    },
  ],
};
