/**
 * database-tools-readonly.test.js — MySQL/PG 语句级只读校验测试
 *
 * 对应 2026-08 P0+P1 安全加固 Task 10:
 * handleDatabaseQuery 此前只靠 startsWith 前缀判断（WITH 开头放行），
 * `WITH x AS(...) DELETE FROM ...`、`SELECT 1; DROP ...`、
 * `SELECT 1) UNION (UPDATE ...` 均可绕过。_assertReadOnlyQuery 在
 * _queryMySQL/_queryPostgres 执行前做语句级校验（多语句拒绝 + 写关键词
 * word-boundary 拦截），SQLite 由 better-sqlite3 readonly + CLI -readonly 兜底。
 */
const databaseTools = require('../tools/database-tools');

describe('语句级只读校验 _assertReadOnlyQuery', () => {
  test.each([
    'WITH t AS (SELECT 1) DELETE FROM users',
    'SELECT 1; DROP TABLE users',
    "SELECT 1; INSERT INTO users VALUES(1)",
    'SELECT 1) UNION (UPDATE t SET x=1',
    'with x as (select 1) truncate table t',
    'SELECT * FROM t; ALTER TABLE t ADD c INT',
    'DELETE FROM users',
    'insert into t values (1)',
    'update t set x = 1',
    'PRAGMA foreign_keys = OFF',
    "ATTACH DATABASE 'x' AS y",
  ])('语句级只读校验拒绝: %s', (q) => {
    expect(() => databaseTools._assertReadOnlyQuery(q)).toThrow(/只读|readonly|写操作/i);
  });

  test('合法 SELECT/WITH 查询放行', () => {
    expect(() => databaseTools._assertReadOnlyQuery('WITH t AS (SELECT 1) SELECT * FROM t')).not.toThrow();
    expect(() => databaseTools._assertReadOnlyQuery('SELECT * FROM users WHERE id=1')).not.toThrow();
  });

  test('单条语句尾随分号放行（多语句=分号分隔的非空语句数>1）', () => {
    expect(() => databaseTools._assertReadOnlyQuery('SELECT 1;')).not.toThrow();
  });

  test('字符串字面量内的分号不算多语句', () => {
    expect(() => databaseTools._assertReadOnlyQuery("SELECT 'a;b' AS v")).not.toThrow();
  });

  test('MySQL REPLACE() 函数不误伤（REPLACE INTO 仍拦）', () => {
    expect(() => databaseTools._assertReadOnlyQuery("SELECT REPLACE(name, 'a', 'b') FROM t")).not.toThrow();
    expect(() => databaseTools._assertReadOnlyQuery("REPLACE INTO t VALUES (1)")).toThrow();
  });
});

describe('审查修复轮：INTO OUTFILE/DUMPFILE 写原语 + SHOW CREATE TABLE 合法豁免', () => {
  test.each([
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "select * from t into outfile '/tmp/x'",   // 小写变体
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",   // 大写变体
    "SELECT 1 INTO DUMPFILE '/tmp/x'",         // dumpfile 形态
    "SELECT 1 Into   Outfile '/tmp/x'",        // 大小写 + 多空白
  ])('INTO OUTFILE/DUMPFILE 写原语拒绝: %s', (q) => {
    expect(() => databaseTools._assertReadOnlyQuery(q)).toThrow();
  });

  test('SHOW CREATE TABLE 是纯读语句，豁免放行', () => {
    expect(() => databaseTools._assertReadOnlyQuery('SHOW CREATE TABLE users')).not.toThrow();
    expect(() => databaseTools._assertReadOnlyQuery('show create table users')).not.toThrow();
    expect(() => databaseTools._assertReadOnlyQuery('SHOW CREATE TABLE `users`')).not.toThrow();
  });

  test('真 DDL 不受豁免影响仍拦', () => {
    expect(() => databaseTools._assertReadOnlyQuery('CREATE TABLE users (id INT)')).toThrow();
    expect(() => databaseTools._assertReadOnlyQuery('SHOW GRANTS; CREATE TABLE t (id INT)')).toThrow(); // 多语句先拦
    expect(() => databaseTools._assertReadOnlyQuery('SHOW CREATE TABLE t; DROP TABLE t')).toThrow();  // 豁免不放行后半段写
  });
});

describe('_assertReadOnlyQuery 被 MySQL/PG 执行函数接入', () => {
  const src = require('fs').readFileSync(require.resolve('../tools/database-tools'), 'utf8');

  test('_queryMySQL 执行前调用只读校验', () => {
    // 校验须在创建连接前（fail fast，不给恶意语句建连接）
    const mysqlFn = src.slice(src.indexOf('async function _queryMySQL'));
    expect(mysqlFn.indexOf('_assertReadOnlyQuery')).toBeGreaterThanOrEqual(0);
    expect(mysqlFn.indexOf('_assertReadOnlyQuery')).toBeLessThan(mysqlFn.indexOf('createConnection'));
  });

  test('_queryPostgres 执行前调用只读校验', () => {
    const pgFn = src.slice(src.indexOf('async function _queryPostgres'));
    expect(pgFn.indexOf('_assertReadOnlyQuery')).toBeGreaterThanOrEqual(0);
    expect(pgFn.indexOf('_assertReadOnlyQuery')).toBeLessThan(pgFn.indexOf('new Client'));
  });

  test('PG 连接后开启 default_transaction_read_only', () => {
    const pgFn = src.slice(src.indexOf('async function _queryPostgres'));
    expect(pgFn).toContain('default_transaction_read_only');
    // SET 须在用户查询执行前
    expect(pgFn.indexOf('default_transaction_read_only')).toBeLessThan(
      pgFn.indexOf('client.query({ text: query')
    );
  });
});
