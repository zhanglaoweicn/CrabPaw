/**
 * gen-plugin-catalog.js — 插件贡献点目录生成器（Phase 4d, 2026-08-25）
 *
 * 扫描 plugins 目录下各插件的 manifest → 生成 docs/plugins-catalog.md：
 * 插件/版本/requiresHarness/permissions/信任级别/贡献点（工具/事件/服务/数据源）一览。
 * 语义同 gen-ui-registry：文档从清单生成，永不漂移。
 * 用法: node scripts/gen-plugin-catalog.js   （npm run gen:plugin-catalog）
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { checkPluginTrust } = require('../src/core/plugin/trust-check');

const PLUGINS_DIR = path.resolve(__dirname, '..', 'plugins');
const OUT_PATH = path.resolve(__dirname, '..', 'docs', 'plugins-catalog.md');

function loadOne(dir, name) {
  for (const fn of ['manifest.yaml', 'manifest.yml', 'manifest.json']) {
    const fp = path.join(dir, fn);
    if (fs.existsSync(fp)) {
      try {
        const manifest = fn.endsWith('.json') ? JSON.parse(fs.readFileSync(fp, 'utf8')) : yaml.load(fs.readFileSync(fp, 'utf8'));
        const trust = checkPluginTrust(manifest);
        return { name, manifest, trust };
      } catch (e) {
        return { name, manifest: null, trust: null, error: e.message };
      }
    }
  }
  return null;
}

const rows = [];
for (const e of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const r = loadOne(path.join(PLUGINS_DIR, e.name), e.name);
  if (!r) continue;
  const m = r.manifest || {};
  const contribs = m.contributes || {};
  const t = r.trust;
  const dataSrcs = (contribs.dataSources || []).map((d) => d.name || '?').join(',');
  const toolsLen = (contribs.tools || []).length;
  const eventsLen = (contribs.events || []).length;
  const servicesLen = (contribs.services || []).length;
  const contribCol = [toolsLen, eventsLen, servicesLen, dataSrcs].join('/');
  rows.push([
    `**${e.name}**`,
    m.version || '?',
    m.requiresHarness || '—',
    t ? t.trustLevel : '?',
    t && t.permissions ? (t.permissions.exec ? 'exec' : t.permissions.network ? 'net' : (t.permissions.files.length ? 'files' : '—')) : '—',
    contribCol,
  ].join(' | '));
}

rows.sort();
const body = `# 插件目录（自动生成, 勿手改 — npm run gen:plugin-catalog, ${new Date().toISOString().slice(0, 10)}）

| 插件 | 版本 | requiresHarness | 信任 | 权限 | 贡献点(工具/事件/服务/数据源) |
|---|---|---|---|---|---|
${rows.join('\n')}

> 生成器: scripts/gen-plugin-catalog.js；信任裁定: src/core/plugin/trust-check.js。
`;
fs.writeFileSync(OUT_PATH, body);
console.log(`✅ gen-plugin-catalog: ${rows.length} 个插件 → docs/plugins-catalog.md`);
