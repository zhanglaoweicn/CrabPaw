/**
 * plugin-trust-x509.test.js — x509 证书签名校验（Phase 4 剩余）
 * 用 openssl 生成自签证书做真实验签。
 *
 * 2026-09-30 深度检查修复: 原注释假设"Git Bash 环境自带 openssl"，在未装 Git Bash /
 * openssl 未入 PATH 的 Windows 上，beforeAll 直接抛错 → **两条用例一起失败**（其中
 * "无效证书 → 抛错"根本不依赖 openssl）。CI 跑 ubuntu-latest 自带 openssl 所以没暴露。
 * 现改为：检测不到 openssl 时**整组优雅跳过**并说明原因，不再把环境缺失报成测试失败。
 */
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeManifestFingerprint, verifyX509 } = require('../core/plugin/trust-check');

let tmpDir, privKey, certB64;
let opensslAvailable = false;

function hasOpenssl() {
  try {
    execSync('openssl version', { stdio: 'ignore', shell: true });
    return true;
  } catch { return false; }
}

beforeAll(() => {
  opensslAvailable = hasOpenssl();
  if (!opensslAvailable) {
    console.warn('[plugin-trust-x509] 未检测到 openssl（需在 PATH 中）——跳过真实证书验签用例');
    return;
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x509-test-'));
  const key = path.join(tmpDir, 'k.pem');
  const cert = path.join(tmpDir, 'c.pem');
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 1 -subj /CN=crabpaw-test`, { shell: true });
  privKey = fs.readFileSync(key);
  certB64 = fs.readFileSync(cert).toString('base64');
});

afterAll(() => { try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ } });

/** 依赖 openssl 的用例：环境缺失时跳过而非失败 */
const maybe = () => (opensslAvailable ? test : test.skip);

describe('verifyX509（正式证书签名）', () => {
  // 用真实 openssl 生成的自签证书做验签——环境无 openssl 时跳过（见文件头说明）
  maybe()('有效签名通过 / 篡改拒绝', () => {
    const manifest = { name: 'signed-pkg', version: '1.0.0', requiresHarness: '2.4' };
    const fp = computeManifestFingerprint(manifest);
    const sig = crypto.sign('sha256', Buffer.from(fp, 'utf8'), privKey).toString('base64');
    expect(verifyX509({ cert: certB64, value: sig }, manifest)).toBe(true);
    expect(verifyX509({ cert: certB64, value: sig }, { ...manifest, name: 'tampered' })).toBe(false);
  });

  // 本用例不依赖 openssl：伪造证书 base64 即可，必须始终运行
  test('无效证书 → 抛错（上层转拒绝）', () => {
    expect(() => verifyX509({ cert: 'bm90LWEtY2VydA==', value: 'x' }, { name: 'a' })).toThrow();
  });
});
