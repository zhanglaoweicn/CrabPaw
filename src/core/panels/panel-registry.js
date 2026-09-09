/**
 * panel-registry.js — 卡片面板贡献点注册表（Phase 3 业务插件化首批, 2026-08-25）
 *
 * 卡片插件化语义：一张卡 = 一个注册条目：
 *   { key, surface, ui }  —— key=panel-state 键, surface=场景 surface id, ui=前端组件名（清单聚合用）
 * 注册来源三级：
 *   ① 内置默认（本模块 DEFAULT_PANELS，与历史 panel-state 硬编码 1:1——行为等价迁移）
 *   ② 插件/配置（外部模块或后续建卡模板调用 registerPanel）
 *   ③ 三方（插件清单声明 → Phase 3b 由 manifest 解析器接入）
 * 消费方：panel-state.js（panelStates / SURFACE_PANEL_MAP 单一事实源改由本表构建）。
 */

// 2026-08-27 面板禁用开关（已知限制#1 收口）：
// 状态存 data/.crabpaw/panel-states.json（缺省=全启用, 无行为突变）；
// 读时过滤（listPanels/getPanelKeys/getSurfaceMap 只返回启用面）——enable/disable 即时生效无需重启。
const path = require('path');
const fsSync = require('fs');
const config = require('../config');

const DEFAULT_PANELS = [
  { key: 'music', surface: 'music-player', ui: 'FloatingMusicPlayer' },
  { key: 'hotspot', surface: 'hotspot-panel', ui: 'HotspotPanel' },
  { key: 'weather', surface: 'weather-panel', ui: 'WeatherPanel', dataSource: 'weather' },
  { key: 'stock', surface: 'stock-panel', ui: 'StockPanel', dataSource: 'stock' },
  { key: 'filegen', surface: 'file-panel', ui: 'FileGenPanel' },
  { key: 'meeting', surface: 'meeting-panel', ui: 'MeetingPanel' },
  { key: 'schedule', surface: 'schedule-panel', ui: 'SchedulePanel' },
  { key: 'knowledge', surface: 'kb-panel', ui: 'KnowledgePanel' },
  // 2026-08-29: typhoon 键补注册——此前 setPanelState('typhoon') 静默 no-op,
  // ShowTyphoon/GET /panels/typhoon 打开后面板状态无法跟踪（AI 上下文零注入）。
  { key: 'typhoon', surface: 'typhoon-panel', ui: 'TyphoonPanel' },
  // 2026-08-15 历史注: stock key 曾缺失致 setPanelState 静默 no-op——注册表保证 key 唯一且必须先注册
];

const _panels = new Map(); // key → {key, surface, ui}
const _surfaceToKey = new Map(); // surface → key

for (const p of DEFAULT_PANELS) {
  _registerLocked(p);
}

function _registerLocked(p) {
  if (_panels.has(p.key)) return { ok: false, error: `重复注册 key: ${p.key}` };
  if (_surfaceToKey.has(p.surface)) {
    if (_surfaceToKey.get(p.surface) !== p.key) {
      return { ok: false, error: 'surface 冲突: ' + p.surface + ' 已存在(' + _surfaceToKey.get(p.surface) + ')' };
    }
  }
  _panels.set(p.key, p);
  _surfaceToKey.set(p.surface, p.key);
  return { ok: true };
}

/**
 * 注册面板（幂等 key 去重——存在相同 key 返回 ok:false 而非覆盖）。
 * @param {{key: string, surface: string, ui?: string}} panel
 */
function registerPanel(panel) {
  if (!panel || typeof panel.key !== 'string' || !panel.key.trim()) {
    return { ok: false, error: 'panel.key 必填' };
  }
  if (typeof panel.surface !== 'string' || !panel.surface.trim()) {
    return { ok: false, error: `panel(${panel.key}).surface 必填` };
  }
  return _registerLocked({ key: panel.key, surface: panel.surface, ui: panel.ui || panel.key, dataSource: panel.dataSource });
}

// ─── 面板禁用开关状态（2026-08-27 已知限制#1 收口） ───

const getPanelStatesPath = () => path.join(config.DATA_DIR, 'panel-states.json');
let _statesCache = null; // { key: { enabled: Boolean } }，惰性加载
function _loadPanelStates() {
  if (_statesCache) return _statesCache;
  try {
    const raw = fsSync.readFileSync(getPanelStatesPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    _statesCache = typeof parsed === 'object' && parsed && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    // 首次/文件损坏 → 全启用；ENOENT 属正常缺省，其余须 log（空 catch 禁止）
    if (e && e.code !== 'ENOENT') console.warn('[panel-registry] 面板状态文件读取失败(按全启用):', e.message);
    _statesCache = {};
  }
  return _statesCache;
}
function _isEnabled(key) {
  const s = _loadPanelStates()[key];
  return !(s && s.enabled === false);
}
function _persistStates() {
  try {
    const p = getPanelStatesPath();
    fsSync.mkdirSync(path.dirname(p), { recursive: true });
    fsSync.writeFileSync(p, JSON.stringify(_statesCache || {}, null, 2));
  } catch (e) {
    console.warn('[panel-registry] 状态持久化失败:', e && e.message);
  }
}

/** 面板状态清单（含 ui 组件名——插件页清单/总览副题用；含禁用面） */
function getPanelStates() {
  return Array.from(_panels.values()).map((p) => ({
    key: p.key,
    surface: p.surface,
    ui: p.ui || p.key,
    dataSource: p.dataSource || null,
    enabled: _isEnabled(p.key),
  }));
}

/** 启用/禁用面板（生效即：读取面过滤+状态文件持久化；非法 key/enabled 拒绝） */
function setPanelEnabled(key, enabled) {
  if (!_panels.has(key)) return { ok: false, error: `不存在面板 key: ${key}` };
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须为布尔' };
  _loadPanelStates();
  if (enabled) delete _statesCache[key]; else _statesCache[key] = { enabled: false };
  _persistStates();
  console.log(`[panel-registry] 面板 ${key} 已${enabled ? '启用' : '禁用'}`);
  return { ok: true };
}

/** 全部启用面板键（panel-state 构建用——禁用面过滤） */
function getPanelKeys() {
  return Array.from(_panels.keys()).filter((k) => _isEnabled(k));
}

/** surface → key 映射（单一事实源——禁用面过滤） */
function getSurfaceMap() {
  const out = {};
  for (const [k, p] of _panels) if (_isEnabled(k)) out[p.surface] = k;
  return out;
}

/** 面板描述（含 ui 组件名——前端清单聚合用；禁用面过滤） */
function listPanels() {
  return Array.from(_panels.values()).filter((p) => _isEnabled(p.key));
}

// 2026-08-25 产品卡：商品查询（多模态视觉解析电商截图 → 表格化卡片）
registerPanel({ key: 'commodity', surface: 'commodity-panel', ui: 'CommodityPanel', dataSource: 'commodity' });

// 2026-08-25 产品卡：经营日报（插件化体系首张业务卡——模块级注册, gen/测试/管线同步可见）
registerPanel({ key: 'businessReport', surface: 'business-panel', ui: 'BusinessReportPanel', dataSource: 'business' });

// 2026-09-05 业务卡 P0 三张（数据源=导入的经营表/语义视图, ShowXxxPanel 发射 surface 数据）
registerPanel({ key: 'receivable', surface: 'receivable-panel', ui: 'ReceivablePanel', dataSource: 'business' });
registerPanel({ key: 'contractExpiry', surface: 'contract-expiry-panel', ui: 'ContractExpiryPanel', dataSource: 'business' });
registerPanel({ key: 'businessBriefing', surface: 'business-briefing-panel', ui: 'BusinessBriefingPanel', dataSource: 'business' });

// 2026-09-05 业务卡 P1 三张（审批待办/库存预警/客户跟进过渡版）
registerPanel({ key: 'approvals', surface: 'approvals-panel', ui: 'ApprovalsPanel' });
registerPanel({ key: 'stockAlert', surface: 'stock-alert-panel', ui: 'StockAlertPanel', dataSource: 'business' });
registerPanel({ key: 'customerView', surface: 'customer-panel', ui: 'CustomerPanel', dataSource: 'business' });

// 2026-09-05 业务卡 P2: 供应商档案卡（采购汇总+可选工商查询+可选 Bitable 联系人）
registerPanel({ key: 'supplierProfile', surface: 'supplier-panel', ui: 'SupplierPanel' });

module.exports = { registerPanel, getPanelKeys, getSurfaceMap, listPanels, getPanelStates, setPanelEnabled, DEFAULT_PANELS };
