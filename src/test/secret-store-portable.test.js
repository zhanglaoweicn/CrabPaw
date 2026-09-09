'use strict';

/**
 * secret-store 便携化回归（2026-09-08）
 *
 * 背景：v1 主密钥由机器指纹(hostname|username|homedir)派生，U 盘/换机场景下旧密文
 * 永远解不开（数据必丢）。v2 改用盘内随机主密钥(.keystore，与 secure-storage 同源)，
 * 存储目录随 CRABPAW_HOME 走（桌面端注入 DATA_DIR → 随 U 盘）。
 *
 * 覆盖：
 * 1. set/get 往返 + 落盘位置随 CRABPAW_HOME（secrets/store.enc.json，version=2）
 * 2. v1 机器指纹密文读取后自动升级为 v2 主密钥（重加密落盘，legacy 密钥失效）
 * 3. 换机模拟：全新进程（模块图重载）仅凭随盘 .keystore 即可解密
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

describe('secret-store 便携化（v2 盘内主密钥）', () => {
  let tmpDataDir;
  let mod;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-secret-'));
    process.env.CRABPAW_DATA_DIR = tmpDataDir;
    process.env.CRABPAW_HOME = path.join(tmpDataDir, 'home');
    jest.resetModules();
    mod = require('../core/secret-store');
  });

  afterEach(() => {
    delete process.env.CRABPAW_DATA_DIR;
    delete process.env.CRABPAW_HOME;
    try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻塞 */ }
  });

  test('set/get 往返 + 落盘在 CRABPAW_HOME/secrets（version=2，.keystore 随盘生成）', () => {
    const store = new mod.SecretStore();
    store.set('k1', 'v1', { metadata: { tag: 'test' } });
    expect(store.get('k1')).toBe('v1');

    const storeFile = path.join(process.env.CRABPAW_HOME, 'secrets', 'store.enc.json');
    store.flush();
    expect(fs.existsSync(storeFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.entries[0].key).toBe('k1');
    expect(raw.entries[0].cipherBlob).toBeTruthy();
    // 盘内主密钥与数据同目录树（CRABPAW_DATA_DIR/.keystore）
    expect(fs.existsSync(path.join(tmpDataDir, '.keystore'))).toBe(true);
  });

  test('v1 机器指纹密文读取后自动升级为 v2（重加密，legacy 密钥失效）', () => {
    const legacyKey = mod.getLegacyMasterKey();
    const legacyStore = new mod.SecretStore({ masterKey: legacyKey });
    legacyStore.set('token', 'legacy-secret');
    legacyStore.flush();

    // v2 默认主密钥读同一份文件：当前密钥解不开 → legacy 解密成功 → 自动重加密升级
    const v2Store = new mod.SecretStore();
    expect(v2Store.get('token')).toBe('legacy-secret');
    v2Store.flush();

    // 新实例直接可解（文件里已是 v2 密文），legacy 密钥反而解不开了
    const again = new mod.SecretStore();
    expect(again.get('token')).toBe('legacy-secret');
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.env.CRABPAW_HOME, 'secrets', 'store.enc.json'), 'utf8')
    );
    expect(() => mod.decryptSecret(raw.entries[0].cipherBlob, legacyKey)).toThrow();
    expect(mod.decryptSecret(raw.entries[0].cipherBlob, mod.getMasterKey())).toBe('legacy-secret');
  });

  test('换机模拟：全新进程（模块重载）仅凭随盘 .keystore 即可解密', () => {
    const s1 = new mod.SecretStore();
    s1.set('k', 'portable-value');
    s1.flush();

    // 模拟换机后首次启动：模块图重载，机器指纹已无意义，只剩随盘的 .keystore 与密文
    jest.resetModules();
    const fresh = require('../core/secret-store');
    const s2 = new fresh.SecretStore();
    expect(s2.get('k')).toBe('portable-value');
  });
});
