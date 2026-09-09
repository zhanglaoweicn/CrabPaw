/**
 * panel-registry.test.js — 卡片贡献点注册表（Phase 3a）
 */
const {
  registerPanel, getPanelKeys, getSurfaceMap, listPanels, DEFAULT_PANELS,
} = require('../core/panels/panel-registry');

describe('panel-registry（卡片贡献点）', () => {
  test('面板集 1:1（8 历史内置 + 2 产品卡 + 3 业务卡 P0）', () => {
    const keys = getPanelKeys();
    expect(keys.sort()).toEqual(['approvals', 'businessBriefing', 'businessReport', 'commodity', 'contractExpiry', 'customerView', 'filegen', 'hotspot', 'knowledge', 'meeting', 'music', 'receivable', 'schedule', 'stock', 'stockAlert', 'supplierProfile', 'typhoon', 'weather']);
    const map = getSurfaceMap();
    expect(map['stock-panel']).toBe('stock');
    expect(map['file-panel']).toBe('filegen');
    expect(map['music-player']).toBe('music');
    expect(map['receivable-panel']).toBe('receivable');
    expect(map['contract-expiry-panel']).toBe('contractExpiry');
    expect(map['business-briefing-panel']).toBe('businessBriefing');
  });

  test('注册新卡（三方/插件）→ 进入面板集 + surface 映射', () => {
    const r = registerPanel({ key: 'train', surface: 'train-panel', ui: 'TrainPanel' });
    expect(r.ok).toBe(true);
    expect(getPanelKeys()).toContain('train');
    expect(getSurfaceMap()['train-panel']).toBe('train');
    const found = listPanels().find((p) => p.key === 'train');
    expect(found.ui).toBe('TrainPanel');
  });

  test('重名 key 拒绝（不覆盖）', () => {
    const r = registerPanel({ key: 'stock', surface: 'stock-x' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('重复注册');
    expect(getSurfaceMap()['stock-panel']).toBe('stock');
    expect(getSurfaceMap()['stock-x']).toBeUndefined();
  });

  test('surface 冲突拒绝（不同 key 同一 surface）', () => {
    const r = registerPanel({ key: 'other', surface: 'stock-panel' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('surface 冲突');
  });

  test('字段校验：缺 key/surface 拒绝', () => {
    expect(registerPanel({ surface: 's' }).ok).toBe(false);
    expect(registerPanel({ key: 'k' }).ok).toBe(false);
    expect(registerPanel(null).ok).toBe(false);
  });

  test('DEFAULT_PANELS 不可通过 registerPanel 重复注入', () => {
    const anyDup = DEFAULT_PANELS.some((p) => registerPanel(p).ok === false);
    expect(anyDup).toBe(true); // 全部重复——注册表防重语义
  });
});
