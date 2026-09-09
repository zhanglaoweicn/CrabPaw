/**
 * yaml v2 API 回归测试（2026-08-29 Task 1）
 *
 * 背景：`yaml` 包 v2 移除了 `.load`（改 `.parse`）。config.js 使用 `yaml` 包，
 * 其 yaml.load 调用实际抛 `yaml.load is not a function`，被 catch 吞掉后
 * 配置加载静默回退默认值（生产 bug）。
 *
 * 注意：manifest.js / plugin-sdk.js 使用的是 `js-yaml`（v4），其 `.load` 是
 * 有效主 API 且**不存在 `.parse`**——这两个文件属回归守卫，防止误改成 .parse。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function walkJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // 跳过 node_modules/隐藏目录/测试目录（测试文件自身会引用并提及 yaml.load 模式）
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

describe('yaml v2 API 配置加载（yaml 包已无 .load）', () => {
  test('plugin/manifest.js（js-yaml）能解析 yaml 插件清单', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-manifest-'));
    try {
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'name: test-plugin\nversion: "1.0.0"\n');
      const { readManifest } = require('../core/plugin/manifest');
      const m = await readManifest(dir); // readManifest 为 async, 入参为插件目录
      expect(m).not.toBeNull();
      expect(m.name).toBe('test-plugin');
      expect(m._manifestFile).toBe('manifest.yaml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sdk/plugin-sdk.js verifyPlugin（js-yaml）能读取 yaml 清单（不报"未找到 manifest"）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-sdk-'));
    try {
      fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'name: test-plugin\nversion: "1.0.0"\n');
      const { verifyPlugin } = require('../sdk/plugin-sdk');
      const r = verifyPlugin(dir);
      expect(r.errors).not.toContain('未找到 manifest.yaml/json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('使用 `yaml` 包（非 js-yaml）的源文件不得残留 yaml.load(', () => {
    // yaml v2 已移除 .load——任何 require('yaml') 的文件调用 yaml.load 都是
    // 被静默吞掉的运行时炸弹。js-yaml 的 .load 是合法 API，不在本测试范围。
    const yamlPkg = require('yaml');
    expect(typeof yamlPkg.load).toBe('undefined');
    expect(typeof yamlPkg.parse).toBe('function');

    const srcRoot = path.join(__dirname, '..');
    const offenders = [];
    for (const file of walkJsFiles(srcRoot)) {
      const content = fs.readFileSync(file, 'utf8');
      // 精确匹配 require('yaml')，排除 require('js-yaml')
      const usesYamlPkg = /require\((['"`])yaml\1\)/.test(content);
      if (usesYamlPkg && /yaml\.load\(/.test(content)) {
        offenders.push(path.relative(srcRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
