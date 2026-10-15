/**
 * briefing-today-default.test.js — 晨报取数「today 缺省」回归（2026-09-30 深度检查修复）
 *
 * 背景（实测缺陷）：/api/briefing/today 经 briefing-handler 调用
 *   listOverdueReceivables(dbPath, { limit: 5 }) / listExpiringContracts(dbPath, { limit: 5 })
 * **不传 today**，而这两个函数当时 `today` 无默认值：
 *   - 视图查询 `date(?, ?)` 收到 undefined，被 safeQuery 吞成 null → 落到逐表回退
 *   - 回退里 `new Date(undefined).toISOString()` 抛 RangeError → 被 catch 吞 → 返回 []
 *   - 端点仍报 sources.receivables.ok = true / count = 0
 * 结果：界面显示"当前无逾期应收"，而本机实际有 5 笔共 35.4 万元。
 *
 * 同一根因还波及 scanBusinessRisks(dbPath, {}) —— `today` 参与每条 SQL，异常被函数级
 * catch 吞掉后返回全 0 风险，导致 risk-alert-service 认为"无风险"而静默不发提醒。
 *
 * 装配：真实服务 + 真实注册表 + 真实 SQLite。临时 DATA_DIR 里先落空注册表再加载模块
 * （business-data-registry 在加载时按注册表所在目录定音 BUSINESS_DIR），并**不建
 * v_receivable / v_contract 视图**，强制走逐表回退——即原缺陷发生的分支。
 *
 * 日期口径注意：缺省 today = 系统当天（localDayKey），故用例里的"逾期/未逾期"样例一律
 * **相对系统当天**构造，而不是写死日期（初版写死 2026-06-25 当"未逾期"，在本机
 * 2026-09-30 下其实已逾期 97 天，导致断言自相矛盾——教训：日期断言必须相对 today）。
 *
 * ⚠ 隔离红线（本文件曾因此污染生产注册表，务必保持）：
 *   本用例会给临时库调用 `registerTable`。business-data-registry 在**模块加载时**
 *   按 DATA_DIR 定音 BUSINESS_DIR/REGISTRY_FILE；若该模块在 beforeAll 之前已被
 *   同进程的其他代码加载，registerTable 就会写进**生产** registry.json。
 *   实测后果：生产里 contracts 条目的列名被本文件的测试夹具（`到期日期`）覆盖，
 *   而真实表列是 `到期日` → 语义视图 v_contract 引用不存在的列 →
 *   SQLite 建视图不校验、查询时才报错 → 合同卡长期取不到数（表现为"无到期合同"）。
 *
 *   防护三层（缺一不可）：
 *     1. 先把空注册表落到隔离目录，再 require 业务模块
 *     2. jest.isolateModules 重建模块图
 *     3. 结束时**断言隔离目录被写、且生产注册表未被改动**（见最后一个 describe）——
 *        这层是兜底：将来有人调整顺序把这个 bug 引回来时，测试会自己失败。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 相对系统当天偏移 n 天（本地口径，与 localDayKey 一致） */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const OVERDUE_DATE = dayOffset(-60);   // 明显早于默认 30 天阈值 → 必判逾期
const FRESH_DATE = dayOffset(-3);      // 阈值内 → 不判逾期
const EXPIRING_DATE = dayOffset(10);   // 默认 30 天窗口内、scanBusinessRisks 7 天窗口外

let tmpDir;
let dbPath;
let svc;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-default-'));
  dbPath = path.join(tmpDir, 'business.db');
  process.env.CRABPAW_DATA_DIR = tmpDir;

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE receivables (客户 TEXT, 应收金额 INTEGER, 日期 TEXT);
    CREATE TABLE contracts (客户 TEXT, 合同金额 INTEGER, 到期日期 TEXT);
  `);
  db.prepare('INSERT INTO receivables VALUES (?, ?, ?)').run('华辰机械', 128000, OVERDUE_DATE);
  db.prepare('INSERT INTO receivables VALUES (?, ?, ?)').run('蓝湾食品', 86000, OVERDUE_DATE);
  // 未逾期的一条：证明"过滤仍然生效"，不是把全表当成逾期
  db.prepare('INSERT INTO receivables VALUES (?, ?, ?)').run('新客户', 9999, FRESH_DATE);
  // 合同到期日相对当天 +10 天：落在默认 30 天窗口内，但超出 scanBusinessRisks 的 7 天窗口，
  // 两个函数因此有可区分的期望值
  db.prepare('INSERT INTO contracts VALUES (?, ?, ?)').run('恒信物流', 96000, EXPIRING_DATE);
  db.close();

  // 真隔离：先把空注册表落到隔离目录，再加载任何业务模块
  const regFile = path.join(tmpDir, 'business', 'registry.json');
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  fs.writeFileSync(regFile, JSON.stringify({ tables: [] }), 'utf8');

  jest.isolateModules(() => {
    const reg = require('../core/business-data-registry');
    reg.registerTable({
      name: 'receivables',
      dbPath,
      sourceFile: path.join(tmpDir, 'receivables.csv'),
      rowCount: 3,
      columns: [
        { name: '客户', type: 'TEXT' },
        { name: '应收金额', type: 'INTEGER' },
        { name: '日期', type: 'TEXT' },
      ],
    });
    // 合同表已在上面建好（与 receivables 同库）：此处只需登记元数据
    reg.registerTable({
      name: 'contracts',
      dbPath,
      sourceFile: path.join(tmpDir, 'contracts.csv'),
      rowCount: 1,
      columns: [
        { name: '客户', type: 'TEXT' },
        { name: '合同金额', type: 'INTEGER' },
        { name: '到期日期', type: 'TEXT' },
      ],
    });
    svc = require('../core/proactive/morning-briefing-service');
  });
});

afterAll(() => {
  delete process.env.CRABPAW_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ }
});

describe('listOverdueReceivables / listExpiringContracts：today 缺省', () => {
  test('不传 today 时不得返回空（原缺陷：恒 []）', () => {
    const rows = svc.listOverdueReceivables(dbPath, { limit: 10 });
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.customer).sort()).toEqual(['华辰机械', '蓝湾食品']);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(214000);
  });

  test('不传 today 与显式传今天（localDayKey）结果完全一致', () => {
    const { localDayKey } = require('../core/usage-stats');
    const a = svc.listOverdueReceivables(dbPath, { limit: 10 });
    const b = svc.listOverdueReceivables(dbPath, { today: localDayKey(), limit: 10 });
    expect(a).toEqual(b);
  });

  test('未逾期的行仍被过滤掉（不是把全表当成逾期）', () => {
    const rows = svc.listOverdueReceivables(dbPath, { limit: 10 });
    expect(rows.some((r) => r.customer === '新客户')).toBe(false);
  });

  test('逾期天数为正且与样例日期相符（缺省基准 = 今天）', () => {
    const rows = svc.listOverdueReceivables(dbPath, { limit: 10 });
    const hua = rows.find((r) => r.customer === '华辰机械');
    expect(hua.overdueDays).toBe(60);
  });

  test('临期合同：不传 today 与显式传今天一致且非空', () => {
    const { localDayKey } = require('../core/usage-stats');
    const a = svc.listExpiringContracts(dbPath, { limit: 10 });
    const b = svc.listExpiringContracts(dbPath, { today: localDayKey(), limit: 10 });
    expect(a).toEqual(b);
    expect(a.length).toBe(1);
    expect(a[0].customer).toBe('恒信物流');
    expect(a[0].daysLeft).toBe(10);
  });
});

describe('scanBusinessRisks：today 缺省（风控告警取数）', () => {
  test('不传 today 时风险计数非 0，且与显式传今天一致', () => {
    const { localDayKey } = require('../core/usage-stats');
    const a = svc.scanBusinessRisks(dbPath, {});
    const b = svc.scanBusinessRisks(dbPath, { today: localDayKey() });
    expect(a).toEqual(b);
    // 逾期口径：date < (今天-30) 且金额 > 0 → 两条逾期，阈值内的"新客户"不计入
    expect(a.receivableOverdue).toBe(2);
    expect(a.totalReceivable).toBe(214000);
  });

  test('契约窗口为 7 天：今天+10 的合同不计入 contractsExpiring', () => {
    const r = svc.scanBusinessRisks(dbPath, {});
    expect(r.contractsExpiring).toBe(0);
  });

  test('顶层参数对象整体缺省时不抛错（与传 { } 等价）', () => {
    expect(() => svc.scanBusinessRisks(dbPath)).not.toThrow();
    expect(svc.scanBusinessRisks(dbPath)).toEqual(svc.scanBusinessRisks(dbPath, {}));
  });
});

/**
 * 隔离兜底断言（本文件曾真实污染生产注册表，见文件头"隔离红线"）。
 * 这层不验证业务逻辑，只验证**测试没有越界写库**——它会在将来有人调错顺序时失败，
 * 把"静默污染生产数据"变成"测试立刻红"。
 */
describe('隔离兜底：不得污染生产注册表', () => {
  test('登记确实写进了隔离目录，而不是程序树的 data/business', () => {
    const isoRegistry = path.join(tmpDir, 'business', 'registry.json');
    expect(fs.existsSync(isoRegistry)).toBe(true);
    const tables = JSON.parse(fs.readFileSync(isoRegistry, 'utf8')).tables;
    expect(tables.map((t) => t.name).sort()).toEqual(['contracts', 'receivables']);
    // 隔离条目必须指向隔离库
    for (const t of tables) expect(t.dbPath).toBe(dbPath);

    const prodRegistry = path.join(__dirname, '..', '..', 'data', 'business', 'registry.json');
    if (fs.existsSync(prodRegistry)) {
      const prodTables = JSON.parse(fs.readFileSync(prodRegistry, 'utf8')).tables;
      // 生产注册表里**不得**出现指向临时目录的条目
      const leaked = prodTables.filter((t) => /Temp|briefing-default-/.test(String(t.dbPath)));
      expect(leaked).toEqual([]);
      // 也不得出现本测试夹具独有的表名映射到临时路径
      const fixtureLeak = prodTables.filter((t) => t.name === 'receivables' && t.dbPath === dbPath);
      expect(fixtureLeak).toEqual([]);
    }
  });
});
