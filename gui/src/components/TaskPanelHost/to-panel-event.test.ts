/**
 * TaskPanelHost.to-panel-event 测试 — 2026-08-29 Task 8
 *
 * 后端 activity-stream TYPE 枚举只有 tool_preparing/tool_executing/tool_result,
 * 从不广播 type==='tool_call' 的 activity(那是独立的 SSE 事件名)。
 * toPanelEvent 必须把真实广播的 preparing/executing 归一为面板 tool_call,
 * 否则"执行中"条目永不注入任务面板。
 * 载荷字段实读自 activity-stream._broadcastSSE: toolName/roundId/summary 均为顶层字段。
 */

import { toPanelEvent } from './index'

describe('toPanelEvent 工具活动映射', () => {
  test('tool_preparing/tool_executing 映射为 tool_call 面板事件', () => {
    for (const t of ['tool_preparing', 'tool_executing']) {
      const e = toPanelEvent(t, { roundId: 'r1', toolName: 'Weather', summary: '查天气' }) as any
      expect(e?.type).toBe('tool_call')
      expect(e?.toolName).toBe('Weather')
      expect(e?.roundId).toBe('r1')
      expect(e?.summary).toBe('查天气')
    }
  })

  test('tool_executing 缺 summary 时回退 toolName(后端默认摘要为 "执行: X")', () => {
    const e = toPanelEvent('tool_executing', { roundId: 'r2', toolName: 'Bash' }) as any
    expect(e?.type).toBe('tool_call')
    expect(e?.summary).toBe('Bash')
  })

  test('tool_result 语义不变', () => {
    const e = toPanelEvent('tool_result', { roundId: 'r1', toolName: 'Weather', success: true, summary: 'ok' }) as any
    expect(e?.type).toBe('tool_result')
    expect((e as any)?.status).toBe('success')
  })

  test('tool_result success===false → error', () => {
    const e = toPanelEvent('tool_result', { roundId: 'r1', toolName: 'Weather', success: false }) as any
    expect((e as any)?.status).toBe('error')
  })

  test('无关类型返回 null', () => {
    expect(toPanelEvent('message_received', {})).toBeNull()
    expect(toPanelEvent('stream_chunk', {})).toBeNull()
  })
})
