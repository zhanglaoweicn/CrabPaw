/**
 * secure-storage 密钥存储测试（2026-09-02 便携化改造）
 *
 * 背景：旧方案用「机器指纹」（含 MAC 地址列表）派生加密密钥——MAC 集合随
 * VPN/网卡/Wi-Fi 切换变化，每次重启后端都在掷骰子，密钥反复"消失"；
 * 且项目将来跑在 U 盘/移动硬盘上，任何主机绑定方案都不可用。
 *
 * 新方案（v2）：盘内随机主密钥 `.keystore`（与数据同盘随身走），
 * 密文带版本头 `enc:v2:`；旧指纹公式解密成功后由 loadApiKeys 自动升级重加密。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let secureStorage;
let config;

function freshRequire() {
  jest.resetModules();
  secureStorage = require('../core/secure-storage');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secstore-test-'));
  process.env.CRABPAW_DATA_DIR = tmpDir;
  freshRequire();
});

afterEach(() => {
  delete process.env.CRABPAW_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 清理 */ }
});

describe('v2 随机主密钥方案', () => {
  test('加密带 enc:v2: 版本头，往返无损', () => {
    const enc = secureStorage.encryptApiKey('sk-glm-test-49chars-xxxxxxxxxxxxxxxx');
    expect(enc.startsWith('enc:v2:')).toBe(true);
    expect(secureStorage.isEncrypted(enc)).toBe(true);
    expect(secureStorage.decryptApiKey(enc)).toBe('sk-glm-test-49chars-xxxxxxxxxxxxxxxx');
  });

  test('首次加密生成 .keystore（32 字节随机主密钥）', () => {
    secureStorage.encryptApiKey('sk-anything');
    const keystorePath = path.join(tmpDir, '.keystore');
    expect(fs.existsSync(keystorePath)).toBe(true);
    const key = Buffer.from(fs.readFileSync(keystorePath, 'utf8').trim(), 'base64');
    expect(key.length).toBe(32);
  });

  test('新进程重读 .keystore 可解密（模块缓存不携带主密钥语义）', () => {
    const enc = secureStorage.encryptApiKey('sk-persist-me');
    freshRequire();
    expect(secureStorage.decryptApiKey(enc)).toBe('sk-persist-me');
  });

  test('便携核心：数据整目录搬到"另一台机器"（新数据目录+新进程）仍可解密', () => {
    const enc = secureStorage.encryptApiKey('sk-portable');
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secstore-other-'));
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.copyFileSync(path.join(tmpDir, f), path.join(otherDir, f));
      }
      process.env.CRABPAW_DATA_DIR = otherDir;
      freshRequire();
      expect(secureStorage.decryptApiKey(enc)).toBe('sk-portable');
    } finally {
      try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch (e) { /* 清理 */ }
      process.env.CRABPAW_DATA_DIR = tmpDir;
      freshRequire();
    }
  });

  test('损坏的 v2 密文 → 返回 null 不抛异常', () => {
    expect(secureStorage.decryptApiKey('enc:v2:garbage!!')).toBeNull();
  });

  test('明文/空值原样透传（既有契约）', () => {
    expect(secureStorage.encryptApiKey('')).toBe('');
    expect(secureStorage.decryptApiKey('')).toBe('');
    expect(secureStorage.decryptApiKey('plain-key')).toBe('plain-key');
  });
});

describe('旧指纹公式兼容与自动升级', () => {
  test('当前指纹公式（enc: 无版本头）密文可解', () => {
    const legacyEnc = secureStorage._encryptWithFingerprint('sk-old-style');
    expect(legacyEnc.startsWith('enc:')).toBe(true);
    expect(legacyEnc.startsWith('enc:v2:')).toBe(false);
    expect(secureStorage.decryptApiKey(legacyEnc)).toBe('sk-old-style');
  });

  test('legacy 指纹公式（v3 前，无 arch）密文可解', () => {
    const legacyEnc = secureStorage._encryptWithLegacyFingerprint('sk-v3-era');
    expect(secureStorage.decryptApiKey(legacyEnc)).toBe('sk-v3-era');
  });

  test('saveApiKeys 收到旧格式密文 → 重加密为 v2（升级动作真实发生）', () => {
    config = require('../core/config');
    const oldEnc = secureStorage._encryptWithFingerprint('sk-migrate-me');
    config.saveApiKeys({ zhipu: oldEnc });
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.api_keys.json'), 'utf8'));
    expect(raw.zhipu.startsWith('enc:v2:')).toBe(true);
    expect(secureStorage.decryptApiKey(raw.zhipu)).toBe('sk-migrate-me');
  });
});

describe('config.loadApiKeys 无损迁移（存量 zhipu 密钥场景）', () => {
  test('旧指纹密文 → loadApiKeys 解出明文并自动重写为 v2', () => {
    // 预置旧格式密钥文件（模拟升级前的存量数据）
    const oldEnc = secureStorage._encryptWithFingerprint('sk-zhipu-real-key');
    fs.writeFileSync(path.join(tmpDir, '.api_keys.json'), JSON.stringify({ zhipu: oldEnc }));
    freshRequire();
    config = require('../core/config');

    const keys = config.loadApiKeys();
    expect(keys.zhipu).toBe('sk-zhipu-real-key');

    // 文件已被自动升级为 v2（重加密真实发生，不是只在日志里"建议"）
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.api_keys.json'), 'utf8'));
    expect(raw.zhipu.startsWith('enc:v2:')).toBe(true);
    expect(secureStorage.decryptApiKey(raw.zhipu)).toBe('sk-zhipu-real-key');
  });

  test('明文遗留密钥 → require 时迁移加密（既有 migrateApiKeys 行为保持）', () => {
    fs.writeFileSync(path.join(tmpDir, '.api_keys.json'), JSON.stringify({ zhipu: 'sk-plain-legacy' }));
    freshRequire();
    config = require('../core/config');
    const keys = config.loadApiKeys();
    expect(keys.zhipu).toBe('sk-plain-legacy');
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, '.api_keys.json'), 'utf8'));
    expect(raw.zhipu.startsWith('enc:v2:')).toBe(true);
  });
});
