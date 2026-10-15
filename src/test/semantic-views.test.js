/**
 * 语义视图层测试（P1.7/P1.8/P1.9）：
 *   - canonical 对齐投影 + NULL 补位 + __source 溯源
 *   - 异构两张表（销售额 vs 营收金额）导入后 v_sales 合并可查
 *   - 同内容重传（同 fileHash）旧表 superseded，视图与 schema 排除
 *   - getSchemaPrompt 视图优先列出
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSelectForTable } = require('../core/business/semantic-views');

// Windows 下 SQLite 文件句柄释放有滞后，rmSync 立即删会 EPERM——重试后放弃（不影响断言）
function rmTemp(dir) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
      if (i === 4) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

describe('buildSelectForTable（canonical 对齐投影）', () => {
  test('命中列对齐、缺失列 NULL 补位、附 __source', () => {
    const cols = [
      { name: '日期', canonical: 'date' },
      { name: '销售额', canonical: 'revenue' },
      { name: '客户名称', canonical: 'customer' },
    ];
    const sql = buildSelectForTable(cols, ['date', 'customer', 'revenue', 'supplier'], 't_sales_01');
    expect(sql).toBe(
      'SELECT "日期" AS "date", "客户名称" AS "customer", "销售额" AS "revenue", NULL AS "supplier", \'t_sales_01\' AS "__source" FROM "t_sales_01"'
    );
  });

  test('列名含双引号时正确转义', () => {
    const cols = [{ name: '金"额', canonical: 'revenue' }];
    const sql = buildSelectForTable(cols, ['revenue'], 't');
    expect(sql).toContain('"金""额" AS "revenue"');
  });
});

describe('导入 → 视图合并 → superseded（端到端）', () => {
  function writeCsv(dir, name, content) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  test('异构销售表合并进 v_sales；同内容重传旧表退役', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-views-'));
    const oldEnv = process.env.CRABPAW_DATA_DIR;
    process.env.CRABPAW_DATA_DIR = tmp;
    try {
      let importA = null;
      let importB = null;
      let importDup = null;
      let mod = null;
      jest.isolateModules(() => {
        mod = {
          tools: require('../tools/data-import-tools'),
          registry: require('../core/business-data-registry'),
        };
        const { handleImportDataFile } = mod.tools;
        const ctx = { workspaceDir: tmp };
        // 表 A：销售口径
        const a = writeCsv(tmp, 'sales-jan.csv', '日期,客户名称,销售额\n2024/01/15,杭州贸易,1200\n2024/01/20,宁波工业,3400\n');
        // 表 B：营收口径（列名不同、同业务）
        const b = writeCsv(tmp, 'rev-jan.csv', '时间,客户名,营收金额\n2024/01/18,温州商户,8600\n2024/01/25,绍兴商行,950\n');
        importA = handleImportDataFile({ filePath: a, tableName: 'sales_jan', mode: 'replace' }, ctx);
        importB = handleImportDataFile({ filePath: b, tableName: 'rev_jan', mode: 'replace' }, ctx);
      });
      importA = await importA;
      importB = await importB;
      expect(importA.success).toBe(true);
      expect(importB.success).toBe(true);
      expect(importA.semanticViews).toContain('v_sales');
      expect(importB.semanticViews).toContain('v_sales');

      // 合并查询：两张异构表统一进 v_sales
      const Database = require('better-sqlite3');
      const dbPath = path.join(tmp, 'business', 'business.db');
      let db = new Database(dbPath, { readonly: true });
      const merged = db.prepare('SELECT COUNT(*) AS c, SUM("revenue") AS total FROM "v_sales"').get();
      expect(merged.c).toBe(4);
      expect(merged.total).toBe(14150);
      const sources = db.prepare('SELECT DISTINCT "__source" FROM "v_sales" ORDER BY "__source"').all().map((r) => r.__source);
      expect(sources).toEqual(['rev_jan', 'sales_jan']);
      db.close();

      // 同内容重传（B 的副本，不同表名）→ B 退役，视图排除
      jest.isolateModules(() => {
        const { handleImportDataFile } = require('../tools/data-import-tools');
        mod.registry = require('../core/business-data-registry');
        const dup = writeCsv(tmp, 'rev-jan-copy.csv', '时间,客户名,营收金额\n2024/01/18,温州商户,8600\n2024/01/25,绍兴商行,950\n');
        importDup = handleImportDataFile({ filePath: dup, tableName: 'rev_jan_copy', mode: 'replace' }, { workspaceDir: tmp });
      });
      importDup = await importDup;
      expect(importDup.success).toBe(true);

      const supersededEntry = mod.registry.getTable('rev_jan');
      expect(supersededEntry.superseded).toBe(true);

      db = new Database(dbPath, { readonly: true });
      const after = db.prepare('SELECT COUNT(*) AS c FROM "v_sales"').get();
      expect(after.c).toBe(4); // A + 副本，B 已排除（内容相同所以仍 4 行，但来源变了）
      const afterSources = db.prepare('SELECT DISTINCT "__source" FROM "v_sales" ORDER BY "__source"').all().map((r) => r.__source);
      expect(afterSources).toEqual(['rev_jan_copy', 'sales_jan']);
      db.close();

      // schema 提示：视图优先、被取代表不出现
      const prompt = mod.registry.getSchemaPrompt();
      const viewLine = prompt.split('\n').findIndex((l) => l.startsWith('视图 v_sales'));
      const tableLine = prompt.split('\n').findIndex((l) => l.startsWith('表 sales_jan'));
      expect(viewLine).toBeGreaterThanOrEqual(0);
      expect(viewLine).toBeLessThan(tableLine);
      expect(prompt).not.toContain('表 rev_jan\n');
      expect(prompt).toContain('表 sales_jan');
    } finally {
      if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
      else process.env.CRABPAW_DATA_DIR = oldEnv;
      rmTemp(tmp);
    }
  });

  test('表被清空后视图一并清理', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-views-'));
    const oldEnv = process.env.CRABPAW_DATA_DIR;
    process.env.CRABPAW_DATA_DIR = tmp;
    try {
      let p1 = null;
      jest.isolateModules(() => {
        const tools = require('../tools/data-import-tools');
        const registry = require('../core/business-data-registry');
        const csvPath = writeCsv(tmp, 'only.csv', '日期,销售额\n2024/01/15,100\n');
        p1 = tools.handleImportDataFile({ filePath: csvPath, tableName: 'only_sales', mode: 'replace' }, { workspaceDir: tmp })
          .then((r) => {
            expect(r.semanticViews).toContain('v_sales');
            return registry.removeTable('only_sales');
          })
          .then(() => {
            const { rebuildSemanticViews } = require('../core/business/semantic-views');
            return rebuildSemanticViews({ dbPath: path.join(tmp, 'business', 'business.db'), tables: registry.listTables() });
          });
      });
      const result = await p1;
      expect(result.dropped).toContain('v_sales');
      expect(result.rebuilt).toEqual([]);
    } finally {
      if (oldEnv === undefined) delete process.env.CRABPAW_DATA_DIR;
      else process.env.CRABPAW_DATA_DIR = oldEnv;
      rmTemp(tmp);
    }
  });
});

/**
 * reconcileColumns —— 注册表列名 vs 真实表结构的对账（2026-09-30 实机故障）
 *
 * 真实故障经过：注册表把 contracts 的列记成 `到期日期`，而表里其实是 `到期日`。
 * SQLite 的 CREATE VIEW **不校验列引用**，于是 v_contract "建成功"、查询时才报
 * `no such column` → 合同卡长期显示"无到期合同"（错误只落在日志里）。
 * 对策是建视图前拿真实列名过滤并如实上报差异——本组用例锁住这个过滤。
 */
describe('reconcileColumns（建视图前的列名对账）', () => {
  const { reconcileColumns, rebuildSemanticViews } = require('../core/business/semantic-views');

  test('两端都有的列保留，缺失的列单独报出（不静默丢弃）', () => {
    const declared = [
      { name: '客户', canonical: 'customer' },
      { name: '合同金额', canonical: 'contract' },
      { name: '到期日期', canonical: 'date' },   // 表里没有：多了一个"期"
    ];
    const { kept, missing } = reconcileColumns(declared, ['客户', '合同金额', '到期日']);
    expect(kept.map((c) => c.name)).toEqual(['客户', '合同金额']);
    expect(missing).toEqual(['到期日期']);
  });

  test('完全一致 → 无缺失', () => {
    const { kept, missing } = reconcileColumns(
      [{ name: 'a', canonical: 'date' }, { name: 'b', canonical: 'revenue' }], ['a', 'b', 'c'],
    );
    expect(kept).toHaveLength(2);
    expect(missing).toEqual([]);
  })

  test('声明为空/未定义 → 空结果不抛', () => {
    expect(reconcileColumns([], ['a']).kept).toEqual([]);
    expect(reconcileColumns(undefined, ['a']).kept).toEqual([]);
    expect(reconcileColumns([{ name: 'a' }], []).missing).toEqual(['a']);
  })

  test('用坏列名建视图会被剔除，视图仍可用（这是修复的核心收益）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
    const Database = require('better-sqlite3');
    const dbPath = path.join(tmp, 'b.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE contracts (客户 TEXT, 合同金额 INTEGER, 到期日 TEXT)');
    db.prepare('INSERT INTO contracts VALUES (?,?,?)').run('恒信物流', 96000, '2026-10-20');
    db.close();

    const r = rebuildSemanticViews({
      dbPath,
      tables: [{
        name: 'contracts', role: 'contract', dbPath, superseded: false,
        columns: [
          { name: '客户', canonical: 'customer' },
          { name: '合同金额', canonical: 'contract' },
          { name: '到期日期', canonical: 'date' },   // 坏列名
        ],
      }],
    });
    // 视图建出来了，且差异被如实上报
    expect(r.rebuilt).toContain('v_contract');
    expect(r.reconciled).toEqual([{ table: 'contracts', view: 'v_contract', missing: ['到期日期'] }]);
    expect(r.errors.join('')).toContain('到期日期');

    // 关键：视图真的能查（修复前会 no such column）
    const db2 = new Database(dbPath, { readonly: true });
    const row = db2.prepare('SELECT "customer", "contract" FROM v_contract').get();
    db2.close();
    expect(row.customer).toBe('恒信物流');
    rmTemp(tmp);
  })

  test('坏列名不会导致整组放弃（其余列照常进视图）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile2-'));
    const Database = require('better-sqlite3');
    const dbPath = path.join(tmp, 'b.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE receivables (客户 TEXT, 应收金额 INTEGER, 日期 TEXT)');
    db.prepare('INSERT INTO receivables VALUES (?,?,?)').run('华辰机械', 128000, '2026-04-01');
    db.close();

    const r = rebuildSemanticViews({
      dbPath,
      tables: [{
        name: 'receivables', role: 'receivable', dbPath,
        columns: [
          { name: '客户', canonical: 'customer' },
          { name: '应收金额', canonical: 'receivable' },
          { name: '日期', canonical: 'date' },
          { name: '不存在的列', canonical: 'supplier' },   // 坏列名
        ],
      }],
    });
    expect(r.rebuilt).toContain('v_receivable');
    const db2 = new Database(dbPath, { readonly: true });
    const row = db2.prepare('SELECT COUNT(*) AS c FROM v_receivable').get();
    db2.close();
    expect(row.c).toBe(1);
    rmTemp(tmp);
  })
});
