/**
 * gen-ui-registry.js — 面板清单 → 前端注册表生成（Phase 3c, 2026-08-25）
 *
 * 取后端 panel-registry（单一事实源：key/surface/ui/dataSource），生成
 * src/components/SceneShell/kinds/ui-panels.generated.ts 纯数据注册表：
 *   PANEL_REGISTRY: Record<key, {surface, ui, dataSource}>
 * 构建时聚合（无运行时热装——PluginBridge 死链教训）；UI 组件 lazy 解析由宿主
 * （VoiceShell 常驻宿主/场景面）按组件名各自提供——生成物零路径假设、零漂移。
 *
 * 用法: node scripts/gen-ui-registry.js   (gui/ 目录)
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.resolve(__dirname, '..', '..', 'src', 'core', 'panels', 'panel-registry.js');
const OUT_PATH = path.resolve(__dirname, '..', 'src', 'components', 'SceneShell', 'kinds', 'ui-panels.generated.ts');

if (!fs.existsSync(REGISTRY_PATH)) {
  console.error('[gen-ui-registry] 后端 panel-registry 不存在:', REGISTRY_PATH);
  process.exit(1);
}
const { listPanels } = require(REGISTRY_PATH);
const panels = listPanels();

const entries = panels
  .map((p) =>
    `  ${JSON.stringify(p.key)}: { surface: ${JSON.stringify(p.surface)}, ui: ${JSON.stringify(p.ui || p.key)}, dataSource: ${JSON.stringify(p.dataSource || null)} },`)
  .join('\n');

const out = `/**
 * ui-panels.generated.ts — 生成文件，勿手改（gui/scripts/gen-ui-registry.js 输出，2026-08-25）
 * 数据源: src/core/panels/panel-registry.js（后端单一事实源）。
 * 新增卡片 = 后端 registerPanel 后执行 npm run gen:ui-registry。
 */

export interface PanelRegistryEntry {
  surface: string
  ui: string
  dataSource: string | null
}

export const PANEL_REGISTRY: Record<string, PanelRegistryEntry> = {
${entries}
}
`;

fs.writeFileSync(OUT_PATH, out);
console.log(`✅ gen-ui-registry: ${panels.length} 个面板 → ${path.relative(process.cwd(), OUT_PATH)}`);
