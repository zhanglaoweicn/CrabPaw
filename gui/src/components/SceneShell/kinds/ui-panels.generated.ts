/**
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
  "music": { surface: "music-player", ui: "FloatingMusicPlayer", dataSource: null },
  "hotspot": { surface: "hotspot-panel", ui: "HotspotPanel", dataSource: null },
  "weather": { surface: "weather-panel", ui: "WeatherPanel", dataSource: "weather" },
  "stock": { surface: "stock-panel", ui: "StockPanel", dataSource: "stock" },
  "filegen": { surface: "file-panel", ui: "FileGenPanel", dataSource: null },
  "meeting": { surface: "meeting-panel", ui: "MeetingPanel", dataSource: null },
  "schedule": { surface: "schedule-panel", ui: "SchedulePanel", dataSource: null },
  "knowledge": { surface: "kb-panel", ui: "KnowledgePanel", dataSource: null },
  "typhoon": { surface: "typhoon-panel", ui: "TyphoonPanel", dataSource: null },
  "commodity": { surface: "commodity-panel", ui: "CommodityPanel", dataSource: "commodity" },
  "businessReport": { surface: "business-panel", ui: "BusinessReportPanel", dataSource: "business" },
  "receivable": { surface: "receivable-panel", ui: "ReceivablePanel", dataSource: "business" },
  "contractExpiry": { surface: "contract-expiry-panel", ui: "ContractExpiryPanel", dataSource: "business" },
  "businessBriefing": { surface: "business-briefing-panel", ui: "BusinessBriefingPanel", dataSource: "business" },
  "approvals": { surface: "approvals-panel", ui: "ApprovalsPanel", dataSource: null },
  "stockAlert": { surface: "stock-alert-panel", ui: "StockAlertPanel", dataSource: "business" },
  "customerView": { surface: "customer-panel", ui: "CustomerPanel", dataSource: "business" },
  "supplierProfile": { surface: "supplier-panel", ui: "SupplierPanel", dataSource: null },
}
