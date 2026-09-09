/**
 * panel-state 指引契约守卫测试 — 2026-08-15
 *
 * 守卫目标：buildPanelStateContext 注入块中的工具调用示例（"Tool(param="value")" 形式）
 * 必须与 registry 实际注册的工具契约一致。防止指引文案与工具 schema 再次错位
 * （历史教训：HotspotMode 死工具引用 / ShowWeather(action="hide") 无效参数 / 契约层与
 * registry 不同步导致 validateToolInput 拒绝 → AI 工具熔断）。
 *
 * 校验规则（对每行 "  - xxx" 指引）：
 *   1. 工具名必须注册（registry.get(name) 非空）
 *   2. 每个参数名必须在 schema properties（兼容 parameters 与 properties 两种风格）
 *   3. 参数值（或 "a"|"b" 枚举链各值）必须命中 schema 枚举（参数有 enum 时）
 *
 * 实现注记（相对 brief 原稿的两处最小适配，其余逐字保留）：
 *   - jest 29 不支持 expect(actual, message) 双参形式 → assertMsg() 保留原失败消息
 *   - 枚举链 "a"|"b" 解析值含内嵌引号 → 比对前剥离引号（pause"|"next" → pause|next）
 */
const { registry } = require('../tools/registry');
const { validateToolInput } = require('../core/tool-contract');
const { buildPanelStateContext } = require('../core/panel-state');
require('../tools'); // 注册全部工具，确保 registry 就绪

function schemaProps(tool) {
  const s = tool && tool.schema;
  return (s && (s.parameters && s.parameters.properties || s.properties)) || {};
}

function schemaEnum(tool, param) {
  const p = schemaProps(tool)[param];
  return Array.isArray(p && p.enum) ? p.enum : null;
}

// 解析 "action=\"show\"" 与枚举链 "action=\"pause\"|\"next\""（值域不含裸引号、可含全角括号）
function parseArgs(argStr) {
  const args = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"]|"\|")+)"/g;
  let m;
  while ((m = re.exec(argStr))) args[m[1]] = m[2];
  return args;
}

function extractCalls(line) {
  const calls = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(line))) calls.push({ name: m[1], args: parseArgs(m[2]) });
  return calls;
}

// 注：brief 原稿使用 expect(actual, message) 双参形式附加失败消息；本仓 jest 29
// 不支持（"Expect takes at most one argument"）。用断言 + 显式 Error 保留原消息语义。
function assertMsg(cond, msg) {
  if (!cond) throw new Error(msg);
}

describe('panel-state 指引契约守卫', () => {
  const PANELS = ['music', 'hotspot', 'weather', 'stock'];
  const STATES = ['open', 'closed'];

  test.each(PANELS)('%s 两态指引行均可解析出工具调用', (panel) => {
    for (const state of STATES) {
      const block = buildPanelStateContext(panel, state, null);
      assertMsg(block != null, `${panel}/${state} 不应为 null`);
      const guidanceLines = block.split('\n').filter(l => l.startsWith('  - '));
      expect(guidanceLines.length).toBeGreaterThan(0);
      for (const line of guidanceLines) {
        assertMsg(extractCalls(line).length > 0, `无法解析指引行: ${line}`);
      }
    }
  });

  test.each(PANELS)('%s 指引引用工具已注册且参数/枚举在 schema 内', (panel) => {
    for (const state of STATES) {
      const block = buildPanelStateContext(panel, state, null);
      const guidanceLines = block.split('\n').filter(l => l.startsWith('  - '));
      for (const line of guidanceLines) {
        for (const call of extractCalls(line)) {
          const tool = registry.get(call.name);
          assertMsg(!!tool, `工具 ${call.name} 未注册`);
          const props = schemaProps(tool);
          for (const [param, value] of Object.entries(call.args)) {
            assertMsg(!!props[param], `${call.name} 参数 ${param} 不在 schema`);
            const enums = schemaEnum(tool, param);
            if (enums) {
              for (const raw of value.split('|')) {
                // 枚举链 "a"|"b" 的解析值含内嵌引号（parseArgs 保留 "|" 骨架），比对前剥离
                const v = raw.replaceAll('"', '');
                assertMsg(enums.includes(v), `${call.name} 参数 ${param} 值 ${v} 不在枚举 ${JSON.stringify(enums)}`);
              }
            }
          }
        }
      }
    }
  });

  // 2026-08-16: 契约层全量扫描——此前守卫只查 registry schema（Music/hotspot_mode
  // 无 validateToolInput 覆盖），契约层与 registry 不同步仍可致 validateToolInput
  // 拒绝 → AI 工具熔断。现对全部指引示例调用跑契约层校验；warning=契约表无条目，
  // 视为未覆盖即失败（无契约的工具 validateToolInput 默认放行但返回 warning）。
  describe('契约层全量扫描：全部指引示例调用必须通过 validateToolInput', () => {
    // 2026-08-18: v1 hotspot_mode 已注销（panels-v2 为标准），移除出期望清单
    const EXPECTED_TOOLS = ['Music', 'ShowHotspot', 'ShowWeather', 'ShowStock'];

    test('全部面板两态指引的每个示例调用契约校验零错误且契约表条目存在', () => {
      const seen = new Set();
      for (const panel of PANELS) {
        for (const state of STATES) {
          const block = buildPanelStateContext(panel, state, null);
          for (const line of block.split('\n').filter(l => l.startsWith('  - '))) {
            for (const call of extractCalls(line)) {
              seen.add(call.name);
              for (const [param, rawValue] of Object.entries(call.args)) {
                // 枚举链 "a"|"b"（parseArgs 保留 "|" 骨架）→ 逐个枚举值独立校验；普通值直接校验
                const values = rawValue.includes('"|"')
                  ? rawValue.split('|').map(v => v.replaceAll('"', ''))
                  : [rawValue];
                for (const value of values) {
                  const r = validateToolInput(call.name, { ...call.args, [param]: value });
                  assertMsg(r.valid, `${call.name}(${param}="${value}") 契约层拒绝: ${(r.errors || []).join('; ')}（指引行: ${line}）`);
                  assertMsg(!r.warning, `${call.name} 契约表无条目（${r.warning}）——契约层未覆盖（指引行: ${line}）`);
                }
              }
            }
          }
        }
      }
      for (const t of EXPECTED_TOOLS) assertMsg(seen.has(t), `契约扫描未覆盖指引工具 ${t}`);
    });
  });

  describe('契约微扩锁定（ShowWeather/ShowHotspot action show/hide）', () => {
    test('ShowWeather registry schema 含 action show/hide', () => {
      expect(schemaEnum(registry.get('ShowWeather'), 'action')).toEqual(['show', 'hide']);
    });
    test('ShowHotspot registry schema 含 action show/hide', () => {
      expect(schemaEnum(registry.get('ShowHotspot'), 'action')).toEqual(['show', 'hide']);
    });
    test('ShowWeather(action="hide") 契约层通过（tool-contract 不拒）', () => {
      const r = validateToolInput('ShowWeather', { city: '北京', action: 'hide' });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });
    test('ShowHotspot(action="hide") 契约层通过', () => {
      const r = validateToolInput('ShowHotspot', { platform: 'weibo', action: 'hide' });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });
    test('Music action 枚举覆盖指引使用的全部动作', () => {
      expect(schemaEnum(registry.get('Music'), 'action')).toEqual(
        expect.arrayContaining(['search', 'play', 'stop', 'pause', 'next', 'prev', 'set_volume', 'seek']));
    });
  });

  describe('ShowWeather/ShowHotspot action=hide 行为（实现层）', () => {
    test('ShowWeather(action="hide") 移除 weather-panel + panel-state weather=closed', async () => {
      const { getSceneStore } = require('../core/scene/scene-store');
      const { getPanelState } = require('../core/panel-state');
      const store = getSceneStore();
      store.upsertSurface('weather-panel', { kind: 'weather', data: { city: '北京' }, intent: 'inform' });
      const tool = registry.get('ShowWeather');
      const res = await tool.handler({ action: 'hide' }, {});
      expect(res.success).toBe(true);
      expect(store.getSnapshot().surfaces.some(s => s.id === 'weather-panel')).toBe(false);
      expect(getPanelState().weather).toBe('closed');
    });

    test('ShowHotspot(action="hide") 移除 hotspot-panel + panel-state hotspot=closed', async () => {
      const { getSceneStore } = require('../core/scene/scene-store');
      const { getPanelState } = require('../core/panel-state');
      const store = getSceneStore();
      store.upsertSurface('hotspot-panel', { kind: 'hotspot', data: { action: 'show', active: true }, intent: 'inform' });
      const tool = registry.get('ShowHotspot');
      const res = await tool.handler({ action: 'hide' }, {});
      expect(res.success).toBe(true);
      expect(store.getSnapshot().surfaces.some(s => s.id === 'hotspot-panel')).toBe(false);
      expect(getPanelState().hotspot).toBe('closed');
    });
  });
});

// ─── filegen 面板注册（2026-08-17, Task 3） ───
test('filegen 面板注册——SURFACE_PANEL_MAP 映射 + 指引存在', () => {
  const { SURFACE_PANEL_MAP, buildPanelStateContext, setPanelState } = require('../core/panel-state');
  expect(SURFACE_PANEL_MAP['file-panel']).toBe('filegen');
  const ctx = buildPanelStateContext('filegen', 'open', { taskId: 't1', title: '测试报告', phase: 'writing' });
  expect(ctx).toContain('文件生成面板');
  expect(ctx).toContain('当前: ✅ 已打开');
  expect(ctx).toContain('测试报告');
  setPanelState('filegen', 'closed');
  const closed = buildPanelStateContext('filegen', 'closed', null);
  expect(closed).toContain('⛔ 已关闭');
});

// 2026-08-17 M4: 原 filegen 指引引用未注册的 FileGen(action="show"/"hide") 工具——
// 模型按指引调用必然工具契约失败。指引已改纯指令文案；此守卫锁定：
// filegen 指引中任何形如 Tool(...) 的引用都必须是已注册工具（当前应为零）。
test('filegen 指引不引用未注册工具（M4 守卫）', () => {
  const { buildPanelStateContext } = require('../core/panel-state');
  for (const state of ['open', 'closed']) {
    const block = buildPanelStateContext('filegen', state, null);
    for (const line of block.split('\n').filter(l => l.startsWith('  - '))) {
      for (const call of extractCalls(line)) {
        assertMsg(!!registry.get(call.name), `filegen 指引引用未注册工具 ${call.name}（指引行: ${line}）`);
      }
    }
  }
});

// 2026-08-17 R2-1: AI 语音关闭指引——复用已注册 SceneSet(data=null)（契约+实现
// panel-close-chain.test.js 已锁定），模型必须知道可用工具名，否则"关闭文件面板"
// 指令无解（此前指引承认"无对应工具"→ AI 无法语音关面板）。
test('R2-1 filegen open 指引包含 SceneSet 关闭工具（AI 语音关闭链路）', () => {
  const { buildPanelStateContext } = require('../core/panel-state');
  const ctx = buildPanelStateContext('filegen', 'open', { taskId: 't1', title: '测试', phase: 'writing' });
  expect(ctx).toContain("SceneSet(id='file-panel', data=null)");
});
