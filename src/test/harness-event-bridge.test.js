/**
 * harness-event-bridge.test.js — Cordis 树事件桥（P1-c）纯函数与安装冒烟
 */
const { toBridgePayload } = require('../core/cordis/event-bridge');

describe('toBridgePayload（HarnessEvent → 桥载荷）', () => {
  test('toJSON 事件 → 含 category/type/route/payload', () => {
    const event = {
      category: 'llm', type: 'call_start', route: 'llm:call_start',
      toJSON: () => ({ severity: 'info' }),
    };
    const p = toBridgePayload(event);
    expect(p.category).toBe('llm');
    expect(p.type).toBe('call_start');
    expect(p.route).toBe('llm:call_start');
    expect(p.payload).toEqual({ severity: 'info' });
  });

  test('无 toJSON 事件 → 原样载荷', () => {
    const event = { category: 'tool', type: 'done', route: 'tool:done', data: { ok: 1 } };
    const p = toBridgePayload(event);
    expect(p.payload).toEqual({ category: 'tool', type: 'done', route: 'tool:done', data: { ok: 1 } });
  });

  test('null 防御 → null', () => {
    expect(toBridgePayload(null)).toBeNull();
    expect(toBridgePayload(undefined)).toBeNull();
  });
});
