const { listTables, registerTable, removeTable, getTable, detectColumnRole, detectTableRole, getSchemaPrompt, BUSINESS_DIR } = require('../../src/core/business-data-registry');
const { rebuildSemanticViews } = require('../../src/core/business/semantic-views');

module.exports = {
  name: 'Business Data',
  cases: [
    {
      id: 'bd_001',
      name: '列角色识别：金额列 → revenue',
      category: 'business_data',
      run: () => detectColumnRole('订单金额') === 'revenue' && detectColumnRole('amount') === 'revenue',
    },
    {
      id: 'bd_002',
      name: '列角色识别：客户列 → customer 维度角色，欠款列 → receivable',
      category: 'business_data',
      run: () => detectColumnRole('客户名称') === 'customer' && detectColumnRole('欠款余额') === 'receivable',
    },
    {
      id: 'bd_003',
      name: '表角色识别：含客户+金额 → receivable',
      category: 'business_data',
      run: () => detectTableRole([{ name: '客户名称' }, { name: '欠款余额' }, { name: '日期' }]) === 'receivable',
    },
    {
      id: 'bd_004',
      name: '注册表读写闭环（注册→查询→删除）',
      category: 'business_data',
      run: () => {
        const tableName = `eval_bd_${Date.now()}`;
        registerTable({ name: tableName, dbPath: 'x.db', sourceFile: 'x.csv', columns: [{ name: '日期', type: 'TEXT' }, { name: '金额', type: 'REAL' }], rowCount: 3 });
        const ok1 = !!getTable(tableName) && listTables().some((t) => t.name === tableName);
        const ok2 = removeTable(tableName) && getTable(tableName) === null;
        return ok1 && ok2;
      },
    },
    {
      id: 'bd_005',
      name: 'Schema 提示包含表名与角色',
      category: 'business_data',
      run: () => {
        const tableName = `eval_schema_${Date.now()}`;
        registerTable({ name: tableName, dbPath: 'x.db', sourceFile: 'x.csv', columns: [{ name: '金额', type: 'REAL' }], rowCount: 1 });
        const prompt = getSchemaPrompt();
        removeTable(tableName);
        return prompt.includes(tableName) && prompt.includes('revenue');
      },
    },
    {
      id: 'bd_006',
      name: '语义视图：异构两张表（销售额 vs 营收金额）经 v_sales 合并可查',
      category: 'business_data',
      run: () => {
        const path = require('path');
        const Database = require('better-sqlite3');
        const dbPath = path.join(BUSINESS_DIR, 'business.db');
        const db = new Database(dbPath);
        db.exec('CREATE TABLE IF NOT EXISTS "eval_sales_a" ("日期" TEXT, "客户名称" TEXT, "销售额" REAL)');
        db.prepare('INSERT INTO "eval_sales_a" VALUES (?,?,?)').run('2024-01-15', '杭州贸易', 1200);
        db.exec('CREATE TABLE IF NOT EXISTS "eval_sales_b" ("时间" TEXT, "客户名" TEXT, "营收金额" REAL)');
        db.prepare('INSERT INTO "eval_sales_b" VALUES (?,?,?)').run('2024-01-18', '温州商户', 8600);
        db.close();
        registerTable({ name: 'eval_sales_a', dbPath, sourceFile: 'a.csv', rowCount: 1, columns: [{ name: '日期', type: 'TEXT' }, { name: '客户名称', type: 'TEXT' }, { name: '销售额', type: 'REAL' }] });
        registerTable({ name: 'eval_sales_b', dbPath, sourceFile: 'b.csv', rowCount: 1, columns: [{ name: '时间', type: 'TEXT' }, { name: '客户名', type: 'TEXT' }, { name: '营收金额', type: 'REAL' }] });
        const r = rebuildSemanticViews({ dbPath, tables: listTables().filter((t) => t.dbPath === dbPath) });
        let ok = r.rebuilt.includes('v_sales');
        if (ok) {
          const db2 = new Database(dbPath, { readonly: true });
          const merged = db2.prepare('SELECT COUNT(*) AS c, SUM("revenue") AS total FROM "v_sales"').get();
          db2.close();
          ok = merged.c === 2 && merged.total === 9800;
        }
        removeTable('eval_sales_a');
        removeTable('eval_sales_b');
        rebuildSemanticViews({ dbPath, tables: listTables().filter((t) => t.dbPath === dbPath) });
        return ok;
      },
    },
    {
      id: 'bd_007',
      name: '导入日期规范化：斜杠/中文日期入库转 ISO，date() 聚合可命中',
      category: 'business_data',
      run: () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const { handleImportDataFile } = require('../../src/tools/data-import-tools');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-date-'));
        const csvPath = path.join(tmp, 'sales.csv');
        fs.writeFileSync(csvPath, '日期,客户名称,销售额\n2024/01/15,杭州贸易,1200\n2024年2月20日,宁波工业,3400\n', 'utf8');
        const tableName = `eval_date_${Date.now()}`;
        return handleImportDataFile({ filePath: csvPath, tableName, mode: 'replace' }, { workspaceDir: tmp })
          .then((r) => {
            if (!r.success) return false;
            const Database = require('better-sqlite3');
            const dbPath = path.join(BUSINESS_DIR, 'business.db');
            const db = new Database(dbPath, { readonly: true });
            const hit = db.prepare(`SELECT SUM("销售额") AS t FROM "${tableName}" WHERE date("日期") >= date('2024-01-01')`).get();
            db.close();
            return hit && hit.t === 4600;
          })
          .finally(() => {
            removeTable(tableName);
            fs.rmSync(tmp, { recursive: true, force: true });
          });
      },
    },
  ],
};
