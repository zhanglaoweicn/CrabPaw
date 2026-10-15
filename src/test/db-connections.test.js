/**
 * db-connections.test.js — 命名数据源持久化（DatabaseConfig 后端）回归测试
 *
 * 覆盖：
 *   - save/list 掩码（密码绝不明文回流，落盘为 secure-storage 密文）
 *   - 首个保存自动成为默认 + set-default/remove 后默认重算
 *   - resolveConnectionParams 三级合并：connection 指定 > 默认数据源，
 *     显式 params 字段 > 保存值；无保存数据源时零侵入
 *   - 校验拒绝：非法名/未知类型/缺必填字段
 *   - handleDatabaseConfig 各 action 的返回契约（save 不回显明文密码）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// DATA_DIR 在 config.js 模块加载期定型，必须先设再 require
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conn-test-'));
process.env.CRABPAW_DATA_DIR = TMP_DATA_DIR;

const dbConnections = require('../core/db-connections');
const databaseTools = require('../tools/database-tools');

afterAll(() => {
  try { fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不阻断 */ }
});

describe('saveConnection / listConnections（加密落盘 + 掩码）', () => {
  test('save 返回掩码记录，文件内密码为密文', () => {
    const r = dbConnections.saveConnection({
      name: 'prod', type: 'mysql', host: '192.168.1.10', port: 3306,
      database: 'sales', user: 'reader', password: 'S3cret-Passw0rd!',
    });
    expect(r.ok).toBe(true);
    expect(r.record.name).toBe('prod');
    expect(r.record.isDefault).toBe(true); // 首个保存自动成为默认
    expect(r.record.password).not.toContain('S3cret');

    const raw = fs.readFileSync(dbConnections.connectionsPath(), 'utf-8');
    expect(raw).not.toContain('S3cret-Passw0rd!');
  });

  test('list 全程掩码，解密仅 resolve 路径内部可见', () => {
    const list = dbConnections.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0].password).not.toContain('S3cret');
  });

  test('重复 save 同名=更新，不产生重复条目', () => {
    dbConnections.saveConnection({
      name: 'prod', type: 'mysql', host: '192.168.1.11', port: 3306,
      database: 'sales', user: 'reader', password: 'New-Passw0rd!',
    });
    const list = dbConnections.listConnections();
    expect(list.filter((c) => c.name === 'prod')).toHaveLength(1);
    expect(list[0].host).toBe('192.168.1.11');
  });

  test('校验拒绝：非法名 / 未知类型 / MySQL 缺 host/user/password', () => {
    expect(dbConnections.saveConnection({ name: '1bad', type: 'mysql', host: 'h', user: 'u', password: 'p', database: 'd' }).ok).toBe(false);
    expect(dbConnections.saveConnection({ name: 'ok', type: 'oracle', host: 'h', user: 'u', password: 'p', database: 'd' }).ok).toBe(false);
    expect(dbConnections.saveConnection({ name: 'ok', type: 'mysql', database: 'd' }).error).toMatch(/host|user|password/);
  });

  test('SQLite 数据源只需 database，密码可省', () => {
    const r = dbConnections.saveConnection({ name: 'biz', type: 'sqlite', database: 'D:/data/business.db' });
    expect(r.ok).toBe(true);
    expect(r.record.isDefault).toBe(false); // 已有默认 prod，不抢
  });
});

describe('resolveConnectionParams（三级合并）', () => {
  test('未传连接参数时回退默认数据源（prod）', () => {
    const merged = dbConnections.resolveConnectionParams({ query: 'SELECT 1' });
    expect(merged.type).toBe('mysql');
    expect(merged.host).toBe('192.168.1.11');
    expect(merged.user).toBe('reader');
    expect(merged.password).toBe('New-Passw0rd!');
  });

  test('params.connection 指定优先于默认', () => {
    const merged = dbConnections.resolveConnectionParams({ connection: 'biz', query: 'SELECT 1' });
    expect(merged.type).toBe('sqlite');
    expect(merged.database).toBe('D:/data/business.db');
  });

  test('显式 params 字段覆盖保存值', () => {
    const merged = dbConnections.resolveConnectionParams({ database: 'other_db', query: 'SELECT 1' });
    expect(merged.database).toBe('other_db');
    expect(merged.host).toBe('192.168.1.11'); // 其余仍回退默认数据源
  });

  test('connection 指向不存在的数据源时原样返回（错误由工具层给出）', () => {
    const params = { connection: 'ghost', query: 'SELECT 1' };
    expect(dbConnections.resolveConnectionParams(params)).toEqual(params);
  });

  test('无已保存数据源时零侵入（空库行为回归）', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-conn-empty-'));
    const prev = process.env.CRABPAW_DATA_DIR;
    process.env.CRABPAW_DATA_DIR = emptyDir;
    jest.resetModules();
    try {
      const fresh = require('../core/db-connections');
      const params = { query: 'SELECT 1', type: 'mysql', host: 'h' };
      expect(fresh.resolveConnectionParams(params)).toEqual(params);
    } finally {
      process.env.CRABPAW_DATA_DIR = prev;
      jest.resetModules();
      try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻断 */ }
    }
  });
});

describe('set-default / removeConnection（默认重算）', () => {
  test('set-default 切换默认', () => {
    const r = dbConnections.setDefaultConnection('biz');
    expect(r.ok).toBe(true);
    expect(dbConnections.getDefaultName()).toBe('biz');
  });

  test('remove 默认数据源后默认回落到剩余第一个', () => {
    const r = dbConnections.removeConnection('biz');
    expect(r.ok).toBe(true);
    expect(dbConnections.getDefaultName()).toBe('prod');
    expect(dbConnections.removeConnection('ghost').ok).toBe(false);
  });
});

describe('handleDatabaseConfig（工具层契约）', () => {
  test('save 不回显明文密码，note 说明回退规则', () => {
    const r = databaseTools.handleDatabaseConfig({
      action: 'save', name: 'crm', type: 'postgresql', host: '10.0.0.5',
      database: 'crm', user: 'ro', password: 'Pg-Passw0rd!', setDefault: true,
    });
    return r.then((out) => {
      expect(out.success).toBe(true);
      expect(JSON.stringify(out)).not.toContain('Pg-Passw0rd!');
      expect(out.note).toMatch(/默认数据源/);
    });
  });

  test('list 返回清单且默认名正确', () => {
    return databaseTools.handleDatabaseConfig({ action: 'list' }).then((out) => {
      expect(out.success).toBe(true);
      expect(out.default).toBe('crm');
      expect(out.connections.map((c) => c.name)).toEqual(expect.arrayContaining(['prod', 'crm']));
    });
  });

  test('未知 action / 缺 name 给出可读错误', async () => {
    const bad = await databaseTools.handleDatabaseConfig({ action: 'rename' });
    expect(bad.success).toBe(false);
    expect(bad.error).toMatch(/未知 action/);
    const noName = await databaseTools.handleDatabaseConfig({ action: 'remove' });
    expect(noName.success).toBe(false);
    expect(noName.error).toMatch(/name/);
  });

  test('test：connection 不存在时返回可读错误（不真实连库）', async () => {
    const out = await databaseTools.handleDatabaseConfig({ action: 'test', name: 'ghost' });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/ghost|数据源/);
  });
});

describe('DatabaseQuery/ListTables 连接校验（工具层错误分支）', () => {
  test('connection 指向不存在数据源 → 明确报错而非静默直连', async () => {
    const out = await databaseTools.handleDatabaseQuery({ connection: 'ghost', query: 'SELECT 1' });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/ghost/);
    const out2 = await databaseTools.handleListTables({ connection: 'ghost' });
    expect(out2.success).toBe(false);
  });
});
