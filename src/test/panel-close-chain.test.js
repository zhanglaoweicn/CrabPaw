/**
 * 股票面板关闭链路回归测试 — 2026-08-15 实机日志三连败复盘
 *
 * 现象：用户语音"关闭股票面板" → AI 工具调用三连败（crabpaw.log.1 07:54:33-47）：
 *   SceneSet {id:"stock-panel",data:null}  → 契约拒: required 'kind'（删除语义被拦截）
 *   ControlUI {action:"close_panel",...}   → 契约拒: additional properties
 *   ControlUI {command:"close_panel",...}  → 契约拒: enum 无 stock 项
 * 连续失败触发工具熔断（07:55:08 移除 SceneSet/ControlUI），面板彻底无法关闭。
 *
 * 根因：tool-contract.js 契约表与 registry 实现错位（wiring 断层）——
 *   - ShowStock 契约/实现无 action=hide 语义（ShowTyphoon/HotspotMode 均有）→ AI 无正规关闭路径
 *   - SceneSet 契约 data 仅 object 不容 null，required 含 kind（实现支持 data:null 删除）
 *   - ControlUI command enum 无 stock 项
 *
 * 修复：ShowStock 契约+实现加 action show/hide（对齐 ShowTyphoon）；SceneSet 契约
 *   对齐 registry（data oneOf object|null）；panel-state 补 stock key；
 *   /api/scene/remove 同步 setPanelState('stock','closed')。
 *
 * 2026-08-16: 补 SceneSet(data=null)/upsert(data=null) 关闭链路的 closed 写入测试
 *   （SURFACE_PANEL_MAP 上收 panel-state.js 后的关闭路径全覆盖）。
 */
const { validateToolInput } = require('../core/tool-contract');
const { registry } = require('../tools/registry');
require('../tools');

// 2026-08-15: open 写入链路测试——mock panels 数据面，避免 ShowWeather/ShowStock
// handler 真实发起网络请求（wttr.in / 东方财富）。
jest.mock('../core/panels', () => ({
  ...jest.requireActual('../core/panels'),
  weather: {
    getWeather: jest.fn(async () => ({ city: '北京', current: { temp: '28', condition: '晴', humidity: '60%', wind: '6km/h' }, forecast: [] })),
    render: jest.fn(() => ''),
    renderCompact: jest.fn(() => ''),
  },
  stock: {
    getStockPanelData: jest.fn(async () => ({ items: [{ code: '600519', name: '贵州茅台', price: 1450.5, change: 12, changePct: 0.85 }], kline: null, index: null })),
    render: jest.fn(() => ''),
  },
  typhoon: {
    getTyphoon: jest.fn(async () => ({ list: [], active: null, updatedAt: new Date().toISOString() })),
  },
}));

describe('股票面板关闭链路（2026-08-15 三连败回归）', () => {
  describe('契约层：ShowStock 关闭语义', () => {
    test('ShowStock(action="hide") 契约校验通过（正规关闭路径）', () => {
      const r = validateToolInput('ShowStock', { action: 'hide' });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    test('ShowStock(action="show", queries) 契约校验通过（既有打开用法兼容）', () => {
      const r = validateToolInput('ShowStock', { action: 'show', queries: '贵州茅台,600519' });
      expect(r.valid).toBe(true);
    });

    test('ShowStock 无参调用契约校验通过（默认 show，AI 常见形态）', () => {
      const r = validateToolInput('ShowStock', {});
      expect(r.valid).toBe(true);
    });
  });

  describe('契约层：SceneSet 删除语义', () => {
    // 实机日志 07:54:33 的调用形态——scene-tools.js 文档承诺 "SceneSet(id, null) 移除卡片"
    test('SceneSet(id, data=null) 契约校验通过（删除 surface）', () => {
      const r = validateToolInput('SceneSet', { id: 'stock-panel', data: null });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    test('SceneSet 创建卡片仍需 id + data 对象', () => {
      const r = validateToolInput('SceneSet', { data: { kind: 'text', data: { text: 'hi' } } });
      expect(r.valid).toBe(false); // 缺 id
      const r2 = validateToolInput('SceneSet', { id: 'x' });
      expect(r2.valid).toBe(false); // 缺 data
      const r3 = validateToolInput('SceneSet', { id: 'x', data: { kind: 'text' } });
      expect(r3.valid).toBe(true);
    });
  });

  describe('实现层：ShowStock handler 关闭行为', () => {
    test('action=hide 移除 stock-panel surface 并记录 closed 面板状态', async () => {
      const { getSceneStore } = require('../core/scene/scene-store');
      const { getPanelState } = require('../core/panel-state');
      const store = getSceneStore();
      // 先构造"面板已打开"状态
      store.upsertSurface('stock-panel', { kind: 'stock-panel', data: { items: [] }, intent: 'inform' });
      expect(store.getSnapshot().surfaces.some(s => s.id === 'stock-panel')).toBe(true);

      const tool = registry.get('ShowStock');
      const res = await tool.handler({ action: 'hide' }, {});
      expect(res.success).toBe(true);
      // surface 已移除 → 前端 useSceneClient 收 null → 面板关闭
      expect(store.getSnapshot().surfaces.some(s => s.id === 'stock-panel')).toBe(false);
      // panel-state 记录 closed（供 AI 上下文注入）
      expect(getPanelState().stock).toBe('closed');
    });
  });
});

describe('实现层：open 写入链路（2026-08-15 wiring 补齐）', () => {
  test('ShowWeather handler 成功 → panel-state weather=open', async () => {
    const { getPanelState } = require('../core/panel-state');
    const tool = registry.get('ShowWeather');
    const res = await tool.handler({ city: '北京' }, {});
    expect(res.success).toBe(true);
    expect(getPanelState().weather).toBe('open');
  });

  // 2026-08-18: v1 hotspot_mode 已注销 → 改测 v2 ShowHotspot（show 需 format=scene 写面板）
  test('ShowHotspot format=scene → hotspot-panel surface + panel-state hotspot=open；hide 对称 closed', async () => {
    const { getPanelState } = require('../core/panel-state');
    const { getSceneStore } = require('../core/scene/scene-store');
    const tool = registry.get('ShowHotspot');
    const show = await tool.handler({ action: 'show', format: 'scene', platform: 'weibo' }, {});
    expect(show.success).toBe(true);
    expect(getSceneStore().getSnapshot().surfaces.some(s => s.id === 'hotspot-panel')).toBe(true);
    expect(getPanelState().hotspot).toBe('open');
    const hide = await tool.handler({ action: 'hide' }, {});
    expect(hide.success).toBe(true);
    expect(getSceneStore().getSnapshot().surfaces.some(s => s.id === 'hotspot-panel')).toBe(false);
    expect(getPanelState().hotspot).toBe('closed');
  });

  test('ShowStock handler 成功 → panel-state stock=open', async () => {
    const { getPanelState } = require('../core/panel-state');
    const tool = registry.get('ShowStock');
    const res = await tool.handler({ queries: '贵州茅台' }, {});
    expect(res.success).toBe(true);
    expect(getPanelState().stock).toBe('open');
  });

  test('HTTP /api/scene/upsert 已知面板 id → panel-state open（前端手动打开链路）', async () => {
    const { EventEmitter } = require('events');
    const { handleSceneApi } = require('../handlers/panel-handler');
    const { getPanelState } = require('../core/panel-state');
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/scene/upsert';
    const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end() {} };
    const p = handleSceneApi(req, res, '/api/scene/upsert');
    req.emit('data', JSON.stringify({ id: 'weather-panel', data: { kind: 'weather', data: { city: '北京', temp: '28', condition: '晴' }, intent: 'inform' } }));
    req.emit('end');
    await p;
    expect(res.statusCode).toBe(200);
    expect(getPanelState().weather).toBe('open');
  });

  test('HTTP /api/scene/upsert 未知 id → 不动 panel-state', async () => {
    const { EventEmitter } = require('events');
    const { handleSceneApi } = require('../handlers/panel-handler');
    const { setPanelState, getPanelState } = require('../core/panel-state');
    setPanelState('stock', 'closed'); // 显式复位，保证断言确定
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/scene/upsert';
    const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end() {} };
    const p = handleSceneApi(req, res, '/api/scene/upsert');
    req.emit('data', JSON.stringify({ id: 'random-card', data: { kind: 'text', data: { text: 'hi' } } }));
    req.emit('end');
    await p;
    expect(res.statusCode).toBe(200);
    expect(getPanelState().stock).toBe('closed'); // 未被 upsert 误写 open
  });
});

describe('实现层：SceneSet/upsert null 关闭链路（2026-08-16 wiring 补齐）', () => {
  test('SceneSet(id="stock-panel", data=null) 移除 surface + panel-state stock=closed（07:54:33 实机关闭形态）', async () => {
    const { getSceneStore } = require('../core/scene/scene-store');
    const { getPanelState } = require('../core/panel-state');
    const store = getSceneStore();
    store.upsertSurface('stock-panel', { kind: 'stock-panel', data: { items: [] }, intent: 'inform' });
    expect(store.getSnapshot().surfaces.some(s => s.id === 'stock-panel')).toBe(true);

    const tool = registry.get('SceneSet');
    const res = await tool.handler({ id: 'stock-panel', data: null }, {});
    expect(res.success).toBe(true);
    expect(res.op).toBe('remove');
    expect(store.getSnapshot().surfaces.some(s => s.id === 'stock-panel')).toBe(false);
    expect(getPanelState().stock).toBe('closed');
  });

  test('SceneSet(data=null) 非映射 id 不动 panel-state（SURFACE_PANEL_MAP 守卫）', async () => {
    const { setPanelState, getPanelState } = require('../core/panel-state');
    setPanelState('weather', 'open'); // 已知状态，观察未被误写
    const tool = registry.get('SceneSet');
    await tool.handler({ id: 'progress-card', data: null }, {});
    expect(getPanelState().weather).toBe('open');
  });

  test('HTTP /api/scene/upsert {id:"stock-panel", data:null} → surface 移除 + stock=closed', async () => {
    const { EventEmitter } = require('events');
    const { handleSceneApi } = require('../handlers/panel-handler');
    const { getSceneStore } = require('../core/scene/scene-store');
    const { getPanelState } = require('../core/panel-state');
    const store = getSceneStore();
    store.upsertSurface('stock-panel', { kind: 'stock-panel', data: { items: [] }, intent: 'inform' });
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/scene/upsert';
    const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end() {} };
    const p = handleSceneApi(req, res, '/api/scene/upsert');
    req.emit('data', JSON.stringify({ id: 'stock-panel', data: null }));
    req.emit('end');
    await p;
    expect(res.statusCode).toBe(200);
    expect(store.getSnapshot().surfaces.some(s => s.id === 'stock-panel')).toBe(false);
    expect(getPanelState().stock).toBe('closed');
  });

  test('HTTP /api/scene/upsert {id:"random-card", data:null} → 不动 panel-state', async () => {
    const { EventEmitter } = require('events');
    const { handleSceneApi } = require('../handlers/panel-handler');
    const { setPanelState, getPanelState } = require('../core/panel-state');
    setPanelState('hotspot', 'open'); // 已知状态，观察未被误写
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/api/scene/upsert';
    const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end() {} };
    const p = handleSceneApi(req, res, '/api/scene/upsert');
    req.emit('data', JSON.stringify({ id: 'random-card', data: null }));
    req.emit('end');
    await p;
    expect(res.statusCode).toBe(200);
    expect(getPanelState().hotspot).toBe('open'); // 未被误写 closed
  });
});

// 2026-08-17 R2-1: file-panel 关闭链路（与 stock 同构——SURFACE_PANEL_MAP['file-panel']='filegen'）
describe('R2-1 file-panel 关闭链路（SceneSet data=null）', () => {
  test('SceneSet(id="file-panel", data=null) 契约校验通过', () => {
    const r = validateToolInput('SceneSet', { id: 'file-panel', data: null });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('SceneSet(id="file-panel", data=null) 移除 surface + panel-state filegen=closed', async () => {
    const { getSceneStore } = require('../core/scene/scene-store');
    const { getPanelState } = require('../core/panel-state');
    const store = getSceneStore();
    store.upsertSurface('file-panel', { kind: 'file-panel', data: { taskId: 't1', phase: 'writing' }, intent: 'inform' });
    expect(store.getSnapshot().surfaces.some(s => s.id === 'file-panel')).toBe(true);

    const tool = registry.get('SceneSet');
    const res = await tool.handler({ id: 'file-panel', data: null }, {});
    expect(res.success).toBe(true);
    expect(res.op).toBe('remove');
    expect(store.getSnapshot().surfaces.some(s => s.id === 'file-panel')).toBe(false);
    expect(getPanelState().filegen).toBe('closed');
  });
});

// 2026-08-29 Task 9: 面板状态 open 对称——SceneSet upsert 分支补 open / typhoon 键注册 /
// GET /panels/{stock,typhoon} 直开路径同步。此前只有 closed 写入（null 分支/scene API），
// 面板重开后 closed TTL(120s) 内 AI 上下文仍注入"已关闭"→ 误报。
describe('面板状态 open 对称（2026-08-29 Task 9）', () => {
  test('SceneSet upsert 面板 surface 时同步 panel-state open（closed 翻转场景）', async () => {
    const { setPanelState, getPanelState } = require('../core/panel-state');
    // 先构造"已关闭"——closed TTL 内经 SceneSet 重开，状态必须翻转为 open
    setPanelState('schedule', 'closed');
    const tool = registry.get('SceneSet');
    const res = await tool.handler({ id: 'schedule-panel', data: { kind: 'schedule', data: { action: 'show' }, intent: 'inform' } }, {});
    expect(res.success).toBe(true);
    expect(res.op).toBe('upsert');
    expect(getPanelState().schedule).toBe('open');
  });

  test('SceneSet upsert 非映射 id 不动 panel-state（SURFACE_PANEL_MAP 守卫）', async () => {
    const { setPanelState, getPanelState } = require('../core/panel-state');
    setPanelState('schedule', 'closed'); // 已知状态，观察未被误写
    const tool = registry.get('SceneSet');
    await tool.handler({ id: 'progress-card', data: { kind: 'progress', data: { label: 'x', progress: 1 }, intent: 'ambient' } }, {});
    expect(getPanelState().schedule).toBe('closed');
  });

  test('typhoon 键已注册进 panel-registry（setPanelState 不再 no-op）', () => {
    const { listPanels } = require('../core/panels/panel-registry');
    expect(listPanels().some(p => p.key === 'typhoon')).toBe(true);
    const { setPanelState, getPanelState } = require('../core/panel-state');
    setPanelState('typhoon', 'open');
    expect(getPanelState().typhoon).toBe('open');
  });

  test('HTTP GET /panels/typhoon 直开路径 → panel-state typhoon=open', async () => {
    const { EventEmitter } = require('events');
    const { handlePanelApi } = require('../handlers/panel-handler');
    const { getPanelState } = require('../core/panel-state');
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/panels/typhoon';
    const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end() {} };
    await handlePanelApi(req, res, '/panels/typhoon');
    expect(res.statusCode).toBe(200);
    expect(getPanelState().typhoon).toBe('open');
  });

  test('HTTP GET /panels/stock 直开路径 → panel-state stock=open', async () => {
    const { EventEmitter } = require('events');
    const { handlePanelApi } = require('../handlers/panel-handler');
    const { getPanelState } = require('../core/panel-state');
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = '/panels/stock';
    const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, end() {} };
    await handlePanelApi(req, res, '/panels/stock');
    expect(res.statusCode).toBe(200);
    expect(getPanelState().stock).toBe('open');
  });
});
