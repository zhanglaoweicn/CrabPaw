'use strict';
/**
 * plugin-verify-lib.test.js — verifyPluginsInDir / verifyPluginsByProfile 单元测试（2026-08-27 D9 C1）
 *
 * 2026-09-30 深度检查修复（门禁空转）后语义变更：
 *   旧: 无 manifest 目录**静默跳过**（README 称 14 个插件，门禁实际只覆盖 8 个还报绿灯）；
 *       目录不存在 → total 0 而脚本照打「全部通过 ✓」（plugins/bundled 实际缺失）。
 *   新: 无 manifest 目录计入 failed 与 skipped（要求补清单或移出 plugins/）；
 *       目录缺失写入 missingDirs，由调用方按 requireDir 决定是否失败。
 * 本用例即锁住新语义 —— 覆盖了多少必须能被回答。
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
  test('好/坏/无清单三态——坏包与无清单目录都计入 failed', () => {
    const r = verifyPluginsInDir(tmp);
    expect(r.total).toBe(2);          // 仅可校验的进 results
    expect(r.failed).toBe(2);         // bad-plugin + no-manifest
    expect(r.skipped).toEqual(['no-manifest']);
    const bad = r.results.find(x => x.name === 'bad-plugin');
    expect(bad.valid).toBe(false);
    expect(bad.errors.join('; ')).toContain('主版本');
    const good = r.results.find(x => x.name === 'good-plugin');
    expect(good.valid).toBe(true);
    expect(good.trustLevel).toBe('unsigned');
  });

  test('dashboard 形态（根无清单 + dashboard/manifest.json）视为可校验目录，不误报', () => {
    const dash = path.join(tmp, 'dash-plugin', 'dashboard');
    fs.mkdirSync(dash, { recursive: true });
    fs.writeFileSync(path.join(dash, 'manifest.json'),
      JSON.stringify({ name: 'dash-plugin', version: '1.0.0', tab: { path: '/x' } }));
    const r = verifyPluginsInDir(tmp);
    expect(r.skipped).toEqual(['no-manifest']);
    const d = r.results.find(x => x.name === 'dash-plugin');
    expect(d).toBeTruthy();
    expect(d.kind).toBe('dashboard');
  });

  test('目录不存在 → total 0 不抛，并记录 missingDirs', () => {
    const r = verifyPluginsInDir(path.join(tmp, 'nope'));
    expect(r.total).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.missingDirs).toEqual([path.join(tmp, 'nope')]);
  });

  test('目录不存在且 requireDir=true → failed=1（门禁不允许静默通过）', () => {
    const r = verifyPluginsInDir(path.join(tmp, 'nope'), { requireDir: true });
    expect(r.total).toBe(0);
    expect(r.failed).toBe(1);
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

  test('profile 点名的目录缺清单 → 计入 skipped 与 failed（不再静默通过）', () => {
    const r = verifyPluginsByProfile({ builtin: ['no-manifest'], bundled: [], user: [] }, 't', layerDirs());
    expect(r.skipped).toEqual(['builtin/no-manifest']);
    expect(r.failed).toBe(1);
  });

  test('空清单返回 total 0 与空 missingRefs（空清单拒绝语义由脚本侧保留）', () => {
    const r = verifyPluginsByProfile({ builtin: [], bundled: [], user: [] }, 'empty', layerDirs());
    expect(r.total).toBe(0);
    expect(r.results).toEqual([]);
    expect(r.missingRefs).toEqual([]);
  });

  test('profile 缺失(非对象) → 回退全量 builtin 扫描', () => {
    const r = verifyPluginsByProfile(null, 'nope', layerDirs());
    expect(r.total).toBe(2);  // good + bad
    expect(r.failed).toBe(2); // bad + no-manifest（新语义：无清单计入失败）
  });
});
