'use strict';
// 面板禁用开关（2026-08-27 已知限制#1 收口）——registry 读取面过滤 + 状态持久化 + 瞬态启用。
// 用 CRABPAW_DATA_DIR 指向临时目录（panel-states.json 可注入）。
// POST 用例：readJsonBody 需 req 流——用 jest.mock 替换 readJsonBody 注入 body（纯函数校验另测）。
jest.mock('../handlers/http-utils', () => {
  const actual = jest.requireActual('../handlers/http-utils');
  return { ...actual, readJsonBody: jest.fn() };
});

const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panels-'));
process.env.CRABPAW_DATA_DIR = tmp;

const registry = require('../core/panels/panel-registry');

describe('panel 禁用开关', () => {
  test('缺省全启用（无 panel-states.json → 无行为突变）', () => {
    const keys = registry.getPanelKeys();
    expect(keys).toContain('stock');
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });

  test('禁用 stock → 读取面消失, 其余不动, 状态持久化', () => {
    const r = registry.setPanelEnabled('stock', false);
    expect(r.ok).toBe(true);
    expect(registry.getPanelKeys()).not.toContain('stock');
    expect(registry.getPanelKeys()).toContain('weather');
    expect(registry.getSurfaceMap()['stock-panel']).toBeUndefined();
    expect(registry.getPanelStates().find((p) => p.key === 'stock').enabled).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'panel-states.json'))).toBe(true);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'panel-states.json'), 'utf-8'));
    expect(saved.stock.enabled).toBe(false);
  });

  test('启用恢复 + 非法 key/非法 enabled 拒绝', () => {
    expect(registry.setPanelEnabled('stock', true).ok).toBe(true);
    expect(registry.getPanelKeys()).toContain('stock');
    expect(registry.setPanelEnabled('no-such-panel', false).ok).toBe(false);
    expect(registry.setPanelEnabled('stock', 'yes').ok).toBe(false);
  });

  test('registry 状态缓存随 toggle 刷新（无需重启）', () => {
    registry.setPanelEnabled('weather', false);
    expect(registry.getPanelKeys()).not.toContain('weather');
    registry.setPanelEnabled('weather', true);
    expect(registry.getPanelKeys()).toContain('weather');
  });
});

describe('panel-state 重建与 API', () => {
  const { getPanelState, setPanelState, refreshPanelStateMaps, SURFACE_PANEL_MAP } = require('../core/panel-state');
  const { handlePanelStateGet, handlePanelStateSet, validatePanelStatePayload } = require('../handlers/local-handlers/panels');
  const { readJsonBody } = require('../handlers/http-utils');

  test('toggle 不禁用旁系面板时其 open 状态保留', () => {
    setPanelState('weather', 'open');
    registry.setPanelEnabled('filegen', false);
    refreshPanelStateMaps();
    expect(getPanelState()['weather'] ?? null).toBe('open'); // getPanelState 无参返回全量 map（值为有效状态）
    registry.setPanelEnabled('filegen', true);
    refreshPanelStateMaps();
  });

  test('refreshPanelStateMaps 后禁用面板从 panel-state 读面消失', () => {
    registry.setPanelEnabled('filegen', false);
    refreshPanelStateMaps();
    expect(getPanelState()).not.toHaveProperty('filegen'); // 注册表不再持有 → 键删除
    expect(SURFACE_PANEL_MAP['file-panel']).toBeUndefined();
    registry.setPanelEnabled('filegen', true);
    refreshPanelStateMaps();
    expect(getPanelState()).toHaveProperty('filegen');
    expect(SURFACE_PANEL_MAP['file-panel']).toBe('filegen');
  });

  test('GET /api/panels/state → success + panels 数组（含 enabled 字段）', async () => {
    const res = { writeHead: jest.fn(), end: jest.fn() };
    await handlePanelStateGet({ method: 'GET', url: '/api/panels/state' }, res, {});
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.panels)).toBe(true);
    expect(body.data.panels.length).toBeGreaterThanOrEqual(8);
    expect(body.data.panels.every((p) => typeof p.enabled === 'boolean')).toBe(true);
  });

  test('POST 非法 key → 400 且不落盘', async () => {
    readJsonBody.mockResolvedValue({ key: 'no-such-panel', enabled: false });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    await handlePanelStateSet({ method: 'POST', url: '/api/panels/state' }, res, {});
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.success).toBe(false);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'panel-states.json'), 'utf-8'));
    expect(saved['no-such-panel']).toBeUndefined();
  });

  test('POST 合法禁用 → 200 + 持久化 + panel-state 即时重建', async () => {
    readJsonBody.mockResolvedValue({ key: 'knowledge', enabled: false });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    await handlePanelStateSet({ method: 'POST', url: '/api/panels/state' }, res, {});
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'panel-states.json'), 'utf-8'));
    expect(saved.knowledge.enabled).toBe(false);
    expect(getPanelState()).not.toHaveProperty('knowledge'); // refresh 即时生效，无需重启
    // 恢复现场
    registry.setPanelEnabled('knowledge', true);
    refreshPanelStateMaps();
    expect(getPanelState()).toHaveProperty('knowledge');
  });

  test('validatePanelStatePayload: body 缺失/非法 key/非法 enabled 拒绝', () => {
    expect(validatePanelStatePayload(null).ok).toBe(false);
    expect(validatePanelStatePayload(undefined).ok).toBe(false);
    expect(validatePanelStatePayload('str').ok).toBe(false);
    expect(validatePanelStatePayload({}).ok).toBe(false);
    expect(validatePanelStatePayload({ key: 123, enabled: true }).ok).toBe(false);
    expect(validatePanelStatePayload({ key: '', enabled: true }).ok).toBe(false);
    expect(validatePanelStatePayload({ key: 'stock' }).ok).toBe(false);
    expect(validatePanelStatePayload({ key: 'stock', enabled: 'yes' }).ok).toBe(false);
    expect(validatePanelStatePayload({ key: 'stock', enabled: true })).toEqual({ ok: true, key: 'stock', enabled: true });
  });
});
