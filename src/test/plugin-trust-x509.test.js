/**
 * plugin-trust-x509.test.js — x509 证书签名校验（Phase 4 剩余）
 * 用 openssl 生成自签证书做真实验签（Git Bash 环境自带 openssl）。
 */
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeManifestFingerprint, verifyX509 } = require('../core/plugin/trust-check');

let tmpDir, privKey, certB64;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x509-test-'));
  const key = path.join(tmpDir, 'k.pem');
  const cert = path.join(tmpDir, 'c.pem');
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${cert}" -days 1 -subj /CN=crabpaw-test`, { shell: true });
  privKey = fs.readFileSync(key);
  certB64 = fs.readFileSync(cert).toString('base64');
});

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ } });

describe('verifyX509（正式证书签名）', () => {
  test('有效签名通过 / 篡改拒绝', () => {
    const manifest = { name: 'signed-pkg', version: '1.0.0', requiresHarness: '2.4' };
    const fp = computeManifestFingerprint(manifest);
    const sig = crypto.sign('sha256', Buffer.from(fp, 'utf8'), privKey).toString('base64');
    expect(verifyX509({ cert: certB64, value: sig }, manifest)).toBe(true);
    expect(verifyX509({ cert: certB64, value: sig }, { ...manifest, name: 'tampered' })).toBe(false);
  });

  test('无效证书 → 抛错（上层转拒绝）', () => {
    expect(() => verifyX509({ cert: 'bm90LWEtY2VydA==', value: 'x' }, { name: 'a' })).toThrow();
  });
});
