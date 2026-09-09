const fs = require('fs');
const path = require('path');
const os = require('os');
const { queryBusinessAggregate } = require('../../src/core/proactive/morning-briefing-service');
const { registerTable, removeTable } = require('../../src/core/business-data-registry');
const Database = require('better-sqlite3');

function makeBizDb(rows) {
  const dir = path.join(os.tmpdir(), `risk_eval_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'business.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE sales (日期 TEXT, 金额 REAL, 客户 TEXT)');
  const ins = db.prepare('INSERT INTO sales VALUES (?,?,?)');
  for (const r of rows) ins.run(r);
  db.close();
  return dbPath;
}

module.exports = {
  name: 'RiskAlert',
  cases: [
    {
      id: 'ra_001',
      name: 'queryBusinessAggregate 按日期列过滤 SUM',
      category: 'risk-alert',
      run: async () => {
        const dbPath = makeBizDb([['2026-08-05', 1000, 'A'], ['2026-08-06', 2500, 'B']]);
        const r = await queryBusinessAggregate(dbPath, 'sales', '金额', '日期', '2026-08-06', '2026-08-06');
        return r === 2500;
      },
    },
    {
      id: 'ra_002',
      name: '风险扫描识别逾期应收（日期早于阈值）',
      category: 'risk-alert',
      run: async () => {
        const { scanBusinessRisks } = require('../../src/core/proactive/morning-briefing-service');
        const dbPath = makeBizDb([['2026-05-01', 20000, '老赖公司'], ['2026-08-06', 500, '正常客户']]);
        const tableName = `eval_ar_${Date.now()}`;
        registerTable({ name: tableName, dbPath, sourceFile: 'ar.csv', columns: [{ name: '日期', type: 'TEXT' }, { name: '金额', type: 'REAL' }, { name: '客户', type: 'TEXT' }], rowCount: 2, role: 'receivable' });
        try {
          const r = scanBusinessRisks(dbPath, { today: '2026-08-07', overdueDays: 30 });
          return r.receivableOverdue === 1 && r.topOverdueCustomers[0].customer === '老赖公司';
        } finally { removeTable(tableName); }
      },
    },
    {
      id: 'ra_003',
      name: '风险扫描识别临期合同（7天内到期）',
      category: 'risk-alert',
      run: async () => {
        const { scanBusinessRisks } = require('../../src/core/proactive/morning-briefing-service');
        const dbPath = makeBizDb([['2026-08-10', 100, 'X'], ['2026-09-01', 100, 'Y']]);
        const tableName = `eval_contract_${Date.now()}`;
        registerTable({ name: tableName, dbPath, sourceFile: 'c.csv', columns: [{ name: '日期', type: 'TEXT' }, { name: '金额', type: 'REAL' }, { name: '客户', type: 'TEXT' }], rowCount: 2, role: 'contract' });
        try {
          const r = scanBusinessRisks(dbPath, { today: '2026-08-07' });
          return r.contractsExpiring === 1;
        } finally { removeTable(tableName); }
      },
    },
    {
      id: 'ra_004',
      name: '告警文本包含逾期金额与客户名',
      category: 'risk-alert',
      run: async () => {
        const { formatRiskAlert } = require('../../src/core/proactive/risk-alert-service');
        const t = formatRiskAlert({ receivableOverdue: 2, totalReceivable: 35000, topOverdueCustomers: [{ customer: '王总', amount: 20000 }] });
        return t.includes('2') && (t.includes('35,000') || t.includes('35000')) && t.includes('王总');
      },
    },
  ],
};
