/**
 * plugin-trust-check.test.js — 插件信任门禁（Phase 4a）
 */
const { checkPluginTrust, computeManifestFingerprint, parsePermissions, HARNESS_VERSION } = require('../core/plugin/trust-check');

const BASE = { name: 'demo', version: '1.0.0' };

describe('checkPluginTrust（fail-closed 信任门禁）', () => {
  test('合规放行：requiresHarness 匹配 + 无签名 → unsigned 放行（仅提示）', () => {
    const r = checkPluginTrust({ ...BASE, requiresHarness: HARNESS_VERSION });
    expect(r.ok).toBe(true);
    expect(r.trustLevel).toBe('unsigned');
    expect(r.warnings.some((w) => w.includes('未声明 requiresHarness'))).toBe(false);
  });

  test('requiresHarness 主版本不匹配 → 拒绝', () => {
    const r = checkPluginTrust({ ...BASE, requiresHarness: '1.9' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('主版本不匹配');
  });

  test('签名声明且匹配 → signed 放行', () => {
    const m = { ...BASE, requiresHarness: HARNESS_VERSION, signature: 'x' };
    m.signature = computeManifestFingerprint(m);
    const r = checkPluginTrust(m);
    expect(r.ok).toBe(true);
    expect(r.trustLevel).toBe('signed');
  });

  test('签名不匹配（篡改）→ 拒绝', () => {
    const r = checkPluginTrust({ ...BASE, signature: 'deadbeef'.repeat(8) });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('signature 校验失败');
  });

  test('permissions 解析（声明即受约束记录）', () => {
    const r = checkPluginTrust({ ...BASE, permissions: { files: ['data/'], network: true, exec: true } });
    expect(r.ok).toBe(true);
    expect(r.permissions).toEqual({ files: ['data/'], network: true, exec: true });
    expect(parsePermissions(null)).toEqual({ files: [], network: false, exec: false });
  });
});
