'use strict';
/**
 * plugin-verify-lib.test.js — verifyPluginsInDir / verifyPluginsByProfile 单元测试（2026-08-27 D9 C1）
 * 抽取回归闸: npm run plugin:verify 行为不变（无 manifest 跳过/缺失引用入 missingRefs/空清单不落回退）。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { verifyPluginsInDir, verifyPluginsByProfile } = require('../sdk/plugin-verify-lib');

let tmp;
let goodDir, badDir, noManifestDir;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvl-'));
  goodDir = path.join(tmp, 'good-plugin');
  badDir = path.join(tmp, 'bad-plugin');
  noManifestDir = path.join(tmp, 'no-manifest');
  fs.mkdirSync(goodDir); fs.mkdirSync(badDir); fs.mkdirSync(noManifestDir);
  fs.writeFileSync(path.join(goodDir, 'manifest.yaml'),
    'name: good-plugin\nversion: "1.0.0"\nrequiresHarness: "2.4"\n');
  fs.writeFileSync(path.join(badDir, 'manifest.yaml'),
    'name: bad-plugin\nversion: "1.0.0"\nrequiresHarness: "3.0"\n');  // 主版本不符 → invalid
  fs.writeFileSync(path.join(noManifestDir, 'index.js'), 'module.exports = {}');
});

describe('verifyPluginsInDir', () => {
  test('好/坏/无 manifest 三态——无 manifest 跳过, 坏包计入 failed', () => {
    const r = verifyPluginsInDir(tmp);
    expect(r.total).toBe(2);
    expect(r.failed).toBe(1);
    const bad = r.results.find(x => x.name === 'bad-plugin');
    expect(bad.valid).toBe(false);
    expect(bad.errors.join('; ')).toContain('主版本');
    const good = r.results.find(x => x.name === 'good-plugin');
    expect(good.valid).toBe(true);
    expect(good.trustLevel).toBe('unsigned');
  });
  test('目录不存在 → 返回 total 0 不抛', () => {
    const r = verifyPluginsInDir(path.join(tmp, 'nope'));
    expect(r.total).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.results).toEqual([]);
  });
});

describe('verifyPluginsByProfile', () => {
  const layerDirs = () => ({
    builtin: tmp,
    bundled: path.join(tmp, 'bundled'),
    user: path.join(tmp, 'user'),
  });

  test('缺失引用计入 missingRefs, 有效包按 layer/name 命名', () => {
    const r = verifyPluginsByProfile(
      { builtin: ['good-plugin'], bundled: ['ghost-plugin'], user: [] }, 'test', layerDirs());
    expect(r.total).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.results[0].name).toBe('builtin/good-plugin');
    expect(r.results[0].valid).toBe(true);
    expect(r.missingRefs).toEqual(['bundled/ghost-plugin']);
  });

  test('空清单返回 total 0 与空 missingRefs（空清单拒绝语义由脚本侧保留）', () => {
    const r = verifyPluginsByProfile({ builtin: [], bundled: [], user: [] }, 'empty', layerDirs());
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.missingRefs).toEqual([]);
  });

  test('profile 缺失(非对象) → 回退全量 builtin 扫描', () => {
    const r = verifyPluginsByProfile(null, 'nope', layerDirs());
    expect(r.total).toBe(2);  // good + bad（no-manifest 跳过）
    expect(r.failed).toBe(1);
  });
});
