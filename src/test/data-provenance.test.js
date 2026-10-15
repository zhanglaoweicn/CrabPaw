/**
 * data-provenance.test.js — 数据出处链回归（2026-09-30，P2）
 *
 * 这条链路的价值全在"可核验"：老板问"这数从哪来"，给的必须是**事实**。
 * 因此断言围绕三件事：
 *   1. 事实齐全：来源表、导入时间、参与行数、空值数都能对上
 *   2. 不猜：未登记的来源表、已退役仍在视图里的表，都要如实标注而不是隐藏
 *   3. 不装死：库不可读 / 视图不存在 → 明确报原因（这不是"没有数据"，是取数失败）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let dbPath;

/** 建临时业务库 + 语义视图（带 __source 溯源列，与 semantic-views 产物同形） */
function seedDb() {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sales_a (日期 TEXT, 客户 TEXT, 销售额 INTEGER);
    CREATE TABLE sales_b (日期 TEXT, 客户 TEXT, 营收金额 INTEGER);
  `);
  db.prepare('INSERT INTO sales_a VALUES (?,?,?)').run('2026-01-15', '杭州贸易', 1200);
  db.prepare('INSERT INTO sales_a VALUES (?,?,?)').run('2026-01-20', '宁波工业', 3400);
  db.prepare('INSERT INTO sales_a VALUES (?,?,?)').run(null, '无日期客户', 500);   // 制造一个空值
  db.prepare('INSERT INTO sales_b VALUES (?,?,?)').run('2026-01-18', '温州商户', 8600);
  // 视图：UNION ALL + __source（模拟 semantic-views 的产物）
  db.exec(`
    CREATE VIEW v_sales AS
      SELECT "日期" AS "date", "客户" AS "customer", "销售额" AS "revenue", 'sales_a' AS "__source" FROM sales_a
      UNION ALL
      SELECT "日期" AS "date", "客户" AS "customer", "营收金额" AS "revenue", 'sales_b' AS "__source" FROM sales_b;
  `);
  db.close();
}

/** 桩注册表：sales_a 有完整元数据；sales_b **故意不登记**（验证"不猜"） */
function stubRegistry(over = {}) {
  return {
    listTables: () => [
      {
        name: 'sales_a', role: 'revenue', superseded: false, dbPath,
        sourceFile: 'D:/data/销售明细-1月.csv', importedAt: 1700000000000,
        fileHash: 'e2df484b04616371', rowCount: 3,
        columns: [{ name: '日期', canonical: 'date' }, { name: '客户', canonical: 'customer' }, { name: '销售额', canonical: 'revenue' }],
      },
      ...(over.extra || []),
    ],
  };
}

/** 重新加载被测模块，让它读到桩注册表。
 *  注意 mock 路径的基准是**被测模块所在目录**（src/core/business/），
 *  不是测试文件所在目录——jest.doMock 用模块 id 解析。
 */
function loadWith(registry) {
  jest.resetModules();
  jest.doMock('../core/business-data-registry', () => registry);
  return require('../core/business/data-provenance');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  dbPath = path.join(tmpDir, 'business.db');
  seedDb();
});

afterEach(() => {
  jest.dontMock('../core/business-data-registry');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄滞后 */ }
});

describe('完整链路：事实齐全', () => {
  test('营收指标解析到 v_sales，行数与来源分布正确', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    expect(p.ok).toBe(true);
    expect(p.view).toBe('v_sales')
    expect(p.label).toBe('营收');
    expect(p.rows).toBe(4);                          // 3 + 1
    const byTable = Object.fromEntries(p.sources.map(s => [s.table, s.rows]));
    expect(byTable.sales_a).toBe(3);
    expect(byTable.sales_b).toBe(1);
  })

  test('已登记来源带出导入时间/来源文件/行数/哈希', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    const a = p.sources.find(s => s.table === 'sales_a');
    expect(a.sourceFile).toBe('D:/data/销售明细-1月.csv');
    expect(a.importedAt).toBe(1700000000000);
    expect(a.fileHash).toBe('e2df484b04616371');
    expect(a.rowCount).toBe(3);
    expect(a.superseded).toBe(false);
  })

  test('空值数按 canonical 列统计（NULL 是"该表缺此列"的真实补位）', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    expect(p.nulls.date).toBe(1);        // 我们故意插了一条无日期
    expect(p.nulls.customer).toBe(0);
  })

  test('未登记的来源表如实标注（不猜它从哪来）', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    const b = p.sources.find(s => s.table === 'sales_b');
    expect(b).toBeTruthy();
    expect(b.sourceFile).toBeNull();     // 没有就说没有
    expect(b.importedAt).toBeNull();
    expect(p.notes.join('')).toContain('未在注册表中登记');
  })

  test('来源数受 limitSources 限制（不把长尾全塞进链路）', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    expect(buildProvenance({ dbPath, metric: 'revenue', limitSources: 1 }).sources).toHaveLength(1);
  })
})

describe('不猜：异常状态如实上报', () => {
  test('已退役来源仍出现在视图里 → 提示重建视图', () => {
    const { buildProvenance } = loadWith(stubRegistry({
      extra: [{
        name: 'sales_b', role: 'revenue', superseded: true, dbPath,
        sourceFile: 'x.csv', importedAt: 1, fileHash: 'h', rowCount: 1, columns: [],
      }],
    }));
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    expect(p.notes.join('')).toContain('已被取代');
    expect(p.notes.join('')).toContain('重建视图');
  })

  test('视图里有来源表但注册表为空 → 链路仍可用，只缺元数据', () => {
    const { buildProvenance } = loadWith({ listTables: () => [] });
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    expect(p.ok).toBe(true);
    expect(p.rows).toBe(4);
    for (const s of p.sources) expect(s.importedAt).toBeNull();
  })

  test('注册表抛错不影响链路（只少导入元数据，不整条失败）', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { buildProvenance } = loadWith({ listTables: () => { throw new Error('registry down') } });
    const p = buildProvenance({ dbPath, metric: 'revenue' });
    expect(p.ok).toBe(true);
    expect(p.rows).toBe(4);
    warn.mockRestore();
  })
})

describe('不装死：不可用必须说清原因', () => {
  test('库文件不存在 → ok=false + 明确原因，而不是"0 行"', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath: path.join(tmpDir, 'nope.db'), metric: 'revenue' });
    expect(p.ok).toBe(false);
    expect(p.rows).toBeNull();
    expect(p.unavailableReason).toBeTruthy();
    expect(p.notes.join('')).toContain('取数失败');
  })

  test('未配置库路径 → 报"未配置"', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath: null, metric: 'revenue' });
    expect(p.ok).toBe(false);
    expect(p.unavailableReason).toContain('未配置');
  })

  test('指标无对应视图 → 报缺失并列出尝试过的视图名', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'inventory' });
    expect(p.ok).toBe(false);
    expect(p.triedViews).toContain('v_inventory');
    expect(p.unavailableReason).toContain('未找到可溯源视图');
  })

  test('视图存在但空表 → ok=true 且 rows=0（"确实是空"与"取不到"要分清）', () => {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    // 用真实存在的列建视图，再筛成空——这样 rows=0 是"确实没有数据"而不是查询失败
    db.exec(`CREATE VIEW v_contract AS
      SELECT "日期" AS "date", "客户" AS "customer", "销售额" AS "contract", 'sales_a' AS "__source"
      FROM sales_a WHERE 0`);
    db.close();
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'contract' });
    expect(p.ok).toBe(true);
    expect(p.rows).toBe(0);
  })

  test('视图定义损坏（引用不存在的列）→ ok=false 并带查询失败原因，而不是 rows:0', () => {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    // SQLite 建视图时不校验列引用，查询时才报错——正是要覆盖的情形
    db.exec(`CREATE VIEW v_contract AS SELECT "不存在的列" AS "date", 'x' AS "__source" FROM sales_a`);
    db.close();
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath, metric: 'contract' });
    expect(p.ok).toBe(false);
    expect(p.rows).toBeNull();
    expect(p.unavailableReason).toBeTruthy();
    expect(p.notes.join('')).toContain('取数失败');
  })

  test('永不抛错（任意残缺输入）', () => {
    const { buildProvenance } = loadWith(stubRegistry());
    expect(() => buildProvenance({ dbPath, metric: 'unknown_metric' })).not.toThrow();
    expect(() => buildProvenance({ dbPath })).not.toThrow();
  })
})

describe('真实库自检（本机生产库只读，不修改）', () => {
  test('本机业务库的 v_sales 可溯源（若存在）', () => {
    const prodDb = path.join(__dirname, '..', '..', 'data', 'business', 'business.db');
    if (!fs.existsSync(prodDb)) return   // 库不在则跳过（CI/他人机器）
    const { buildProvenance } = loadWith(stubRegistry());
    const p = buildProvenance({ dbPath: prodDb, metric: 'revenue' });
    if (!p.ok) return                    // 该机器没有语义视图也不算失败
    expect(p.view).toBe('v_sales');
    expect(typeof p.rows).toBe('number');
    for (const s of p.sources) expect(typeof s.rows).toBe('number');
  })
})
