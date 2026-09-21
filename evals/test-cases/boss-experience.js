/**
 * BossExperience — 老板视角体验型 eval（2026-09-21 P2-2）
 *
 * 与工程回归 eval 的分野：不看模块内部实现，验证"老板每天会摸到的体验链路"
 * 的口径正确性——晨报带数字从哪来、日期口径是否本地、会议结论能否结构化
 * 成决策卡、数据缺失时是否诚实降级（不装作有数）。这些点此前只能靠老板
 * 本人实测反馈兜底，此套件把最容易静默错掉的部分固化为可回归断言。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function makeBizDb(rows) {
  const dir = path.join(os.tmpdir(), `boss_exp_eval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'business.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE ar (日期 TEXT, 金额 REAL, 客户 TEXT)');
  const ins = db.prepare('INSERT INTO ar VALUES (?,?,?)');
  for (const r of rows) ins.run(r);
  db.close();
  return dbPath;
}

module.exports = {
  name: 'BossExperience',
  cases: [
    {
      id: 'bx_001',
      name: '日键本地口径：localDayKey=系统本地日期（0-8 点不再落昨天）',
      category: 'boss-experience',
      run: async () => {
        const { localDayKey } = require('../../src/core/usage-stats');
        const d = new Date();
        const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        // 北京时间 0-8 点时 UTC 键是昨天——若此处相等即回归了 UTC 口径
        const utc = d.toISOString().split('T')[0];
        return localDayKey(d) === local && (utc === local || localDayKey(d) !== utc);
      },
    },
    {
      id: 'bx_002',
      name: '晨报快照无业务库时诚实降级（营收 null 不抛错）',
      category: 'boss-experience',
      run: async () => {
        const { buildBriefingSnapshot } = require('../../src/core/proactive/morning-briefing-service');
        const fakePath = path.join(os.tmpdir(), `no_such_biz_${Date.now()}.db`);
        const snap = buildBriefingSnapshot(fakePath);
        return snap && snap.revenue.month === null && snap.risks.receivableOverdue != null;
      },
    },
    {
      id: 'bx_003',
      name: '晨报聚合端点四源字段齐全（缺源=ok:false 不抛 500）',
      category: 'boss-experience',
      run: async () => {
        const { handleBriefingToday } = require('../../src/handlers/local-handlers/briefing-handler');
        const res = { statusCode: 200, writeHead: () => {}, end: (body) => { res._body = body; } };
        await handleBriefingToday({ url: '/api/briefing/today', headers: {} }, res, {});
        const parsed = JSON.parse(res._body);
        if (!parsed.success) return false;
        const keys = Object.keys(parsed.data.sources || {});
        return ['snapshot', 'receivables', 'contracts', 'schedule'].every((k) => keys.includes(k));
      },
    },
    {
      id: 'bx_004',
      name: '会议收口解析为决策卡结构（结论+【负责人】任务行）',
      category: 'boss-experience',
      run: async () => {
        const { parseConclusion } = require('../../src/core/experts/roundtable');
        const out = parseConclusion('## 会议结论\n本月应收需压降，先催老赖公司。\n## 任务清单\n【财务顾问】出催款函\n【销售总监】约谈客户\n无');
        return (
          out.text.includes('应收需压降') &&
          out.tasks.length === 2 &&
          out.tasks[0].owner === '财务顾问' &&
          out.tasks[0].task.includes('催款函')
        );
      },
    },
    {
      id: 'bx_005',
      name: '收口无任务时决策卡任务区为空（"无"不入清单）',
      category: 'boss-experience',
      run: async () => {
        const { parseConclusion } = require('../../src/core/experts/roundtable');
        const out = parseConclusion('## 会议结论\n纯方向性讨论，暂无落地任务。\n## 任务清单\n无');
        return out.tasks.length === 0 && out.text.includes('纯方向性讨论');
      },
    },
    {
      id: 'bx_006',
      name: '逾期应收明细可追（老板追问路径: 字段含客户/金额）',
      category: 'boss-experience',
      run: async () => {
        const { listOverdueReceivables } = require('../../src/core/proactive/morning-briefing-service');
        const { registerTable, removeTable } = require('../../src/core/business-data-registry');
        const dbPath = makeBizDb([['2026-05-01', 20000, '老赖公司'], ['2026-08-06', 500, '正常客户']]);
        const tableName = `bx_ar_${Date.now()}`;
        registerTable({ name: tableName, dbPath, sourceFile: 'bx-ar.csv', columns: [{ name: '日期', type: 'TEXT' }, { name: '金额', type: 'REAL' }, { name: '客户', type: 'TEXT' }], rowCount: 2, role: 'receivable' });
        try {
          const items = listOverdueReceivables(dbPath, { today: '2026-08-07', overdueDays: 30, limit: 5 }) || [];
          return items.length >= 1 && items[0].customer === '老赖公司' && Number(items[0].amount) === 20000;
        } finally { removeTable(tableName); }
      },
    },
  ],
};
