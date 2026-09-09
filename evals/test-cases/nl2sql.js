const { Nl2SqlEngine, isSafeSelect } = require('../../src/core/nl2sql/nl2sql-engine');

// 注入假 LLM：返回参数里指定的 SQL
function fakeLlm(sql) {
  return async () => ({ content: `{"sql": ${JSON.stringify(sql)}, "explanation": "测试", "confidence": 0.9}` });
}

module.exports = {
  name: 'NL2SQL',
  cases: [
    {
      id: 'nl2sql_001',
      name: '安全门拒绝写语句',
      category: 'nl2sql',
      run: () => {
        const r = isSafeSelect('DELETE FROM orders; DROP TABLE users');
        return r.safe === false && /写|危险|非法/i.test(r.reason || '');
      },
    },
    {
      id: 'nl2sql_002',
      name: '安全门放行纯 SELECT',
      category: 'nl2sql',
      run: () => isSafeSelect('SELECT * FROM orders WHERE amount > 100').safe === true,
    },
    {
      id: 'nl2sql_003',
      name: '安全门拒绝多语句（分号注入）',
      category: 'nl2sql',
      run: () => isSafeSelect("SELECT * FROM t; DROP TABLE t").safe === false,
    },
    {
      id: 'nl2sql_004',
      name: '注释内语句被剥离视为安全（真多语句由 003 覆盖）',
      category: 'nl2sql',
      run: () => isSafeSelect('SELECT 1 -- ;DROP TABLE x').safe === true,
    },
    {
      id: 'nl2sql_005',
      name: '安全门拒绝 UNION 写注入的伪装路径',
      category: 'nl2sql',
      run: () => isSafeSelect('SELECT * FROM t WHERE x=1 UNION SELECT 1,2; UPDATE t SET a=1').safe === false,
    },
    {
      id: 'nl2sql_006',
      name: 'translate 用 schema 提示且输出 JSON 解析',
      category: 'nl2sql',
      run: async () => {
        const engine = new Nl2SqlEngine({ llmCall: fakeLlm('SELECT SUM(amount) FROM sales WHERE date >= date(\'now\', \'start of month\')') });
        const r = await engine.translate('这个月营收多少', { tables: [{ name: 'sales', columns: [{ name: 'amount' }] }] });
        return r.sql.includes('SUM(amount)') && r.confidence === 0.9 && !r.error;
      },
    },
    {
      id: 'nl2sql_007',
      name: 'LLM 返回 markdown 围栏仍可解析',
      category: 'nl2sql',
      run: async () => {
        const engine = new Nl2SqlEngine({ llmCall: async () => ({ content: '```json\n{"sql": "SELECT 1", "explanation": "x", "confidence": 0.8}\n```' }) });
        const r = await engine.translate('测试');
        return r.sql === 'SELECT 1' && !r.error;
      },
    },
    {
      id: 'nl2sql_008',
      name: 'LLM 返回非法 JSON 时优雅降级',
      category: 'nl2sql',
      run: async () => {
        const engine = new Nl2SqlEngine({ llmCall: async () => ({ content: '这不是 JSON' }) });
        const r = await engine.translate('测试');
        return !!r.error && r.sql === null;
      },
    },
    {
      id: 'nl2sql_009',
      name: 'LLM 生成危险 SQL 时拒绝并附原因',
      category: 'nl2sql',
      run: async () => {
        const engine = new Nl2SqlEngine({ llmCall: fakeLlm('DROP TABLE users') });
        const r = await engine.translate('删表');
        return r.sql === null && /写|危险|非法/i.test(r.error || '');
      },
    },
    {
      id: 'nl2sql_010',
      name: 'sqlite_master 系统表访问被拒绝',
      category: 'nl2sql',
      run: () => {
        const r = isSafeSelect('SELECT * FROM sqlite_master');
        return r.safe === false && /系统表/i.test(r.reason || '');
      },
    },
    {
      id: 'nl2sql_011',
      name: '中文问句自动走 NL 路径（registry 契约层验证）',
      category: 'nl2sql',
      run: () => {
        // 契约层：question 参数存在且可选
        const { validateToolInput } = require('../../src/core/tool-contract');
        const r = validateToolInput('DatabaseQuery', { type: 'sqlite', database: 'x.db', question: '这个月营收多少' });
        return r.valid;
      },
    },
    {
      id: 'nl2sql_012',
      name: 'ListTables 契约要求 type+database',
      category: 'nl2sql',
      run: () => {
        const { validateToolInput } = require('../../src/core/tool-contract');
        const missing = validateToolInput('ListTables', { type: 'sqlite' });
        const ok = validateToolInput('ListTables', { type: 'sqlite', database: 'x.db' });
        return !missing.valid && ok.valid;
      },
    },
    {
      id: 'nl2sql_013',
      name: 'DescribeTable 契约拒绝危险表名',
      category: 'nl2sql',
      run: () => {
        const { validateToolInput } = require('../../src/core/tool-contract');
        const r = validateToolInput('DescribeTable', { type: 'sqlite', database: 'x.db', table: 'orders; DROP TABLE x' });
        return !r.valid;
      },
    },
    {
      id: 'nl2sql_014',
      name: 'buildSchemaInfoForDb 读取 sqlite 表结构',
      category: 'nl2sql',
      run: async () => {
        const { buildSchemaInfoForDb } = require('../../src/tools/database-tools');
        const path = require('path');
        const os = require('os');
        const dbPath = path.join(os.tmpdir(), `nl2sql_schema_${Date.now()}.db`);
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        db.exec('CREATE TABLE sales (id INTEGER PRIMARY KEY, amount REAL, date TEXT)');
        db.close();
        const info = await buildSchemaInfoForDb({ type: 'sqlite', database: dbPath }, { workspaceDir: os.tmpdir() });
        const sales = info.tables.find((t) => t.name === 'sales');
        return !!(sales && sales.columns.some((c) => c.name === 'amount'));
      },
    },
    {
      id: 'nl2sql_015',
      name: '完整 NL 路径：question 参数 + 注入 llmCall 端到端查询',
      category: 'nl2sql',
      run: async () => {
        const path = require('path');
        const os = require('os');
        const Database = require('better-sqlite3');
        const dbPath = path.join(os.tmpdir(), `nl2sql_e2e_${Date.now()}.db`);
        const db = new Database(dbPath);
        db.exec('CREATE TABLE sales (日期 TEXT, 金额 REAL)');
        db.prepare('INSERT INTO sales VALUES (?,?)').run('2026-08-06', 2500);
        db.prepare('INSERT INTO sales VALUES (?,?)').run('2026-08-06', 500);
        db.close();
        const { handleDatabaseQuery } = require('../../src/tools/database-tools');
        const fakeLlm = async () => ({ content: '{"sql": "SELECT SUM(\\"金额\\") AS total FROM sales", "explanation": "总营收", "confidence": 0.9}' });
        const r = await handleDatabaseQuery(
          { type: 'sqlite', database: dbPath, question: '这两天的营收一共多少' },
          { workspaceDir: os.tmpdir(), llmCall: fakeLlm }
        );
        return r.success === true && r.sql.includes('SUM') && r.rowCount === 1 && Number(r.rows[0].total) === 3000;
      },
    },
  ],
};
