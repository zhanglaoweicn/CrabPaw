/**
 * @jest-environment jsdom
 */
import { subscribeAgui, AGUI_EVENT } from '../agui-events'
import type { Mock } from 'vitest'

// mock sse-hub: 捕获订阅, 手动触发
const mockHandlers = new Map<string, (data: any, seq?: number) => void>()
vi.mock('../sse-hub', () => ({
  subscribeSse: vi.fn((_path: string, event: string, cb: (data: any, seq?: number) => void) => {
    mockHandlers.set(event, cb)
    return () => mockHandlers.delete(event)
  }),
}))

describe('agui-events', () => {
  // 必须最先运行: jest 未配 clearMocks, subscribeSse.mock.calls 跨用例累积,
  // 模块级 unsubs/listeners 在首个用例后已挂满 — 只有零状态用例能证明"惰性挂接且只挂一次"。
  test('首个子订阅者惰性挂接 12 个标准名且只挂一次', async () => {
    // vitest 的 require 垫片无法解析 .ts 相对模块（Node 原生 require 语义）→ 用动态 import（vi.mock 同样拦截）
    const { subscribeSse } = (await import('../sse-hub')) as any
    subscribeAgui(AGUI_EVENT.RUN_STARTED, () => {})
    // 首个订阅触发 12 个标准名全量挂接, 一次到位
    expect(subscribeSse).toHaveBeenCalledTimes(12)
    const names = (subscribeSse as Mock).mock.calls.map((c: any[]) => c[1]).sort()
    expect(names).toEqual(Object.values(AGUI_EVENT).sort())
    // 第二个订阅者不再挂接(attach-once)
    subscribeAgui(AGUI_EVENT.TOOL_CALL_START, () => {})
    expect(subscribeSse).toHaveBeenCalledTimes(12)
    // 未知事件名不额外挂接(仍 12 次)
    subscribeAgui('NOT_IN_AGUI_EVENT' as any, () => {})
    expect(subscribeSse).toHaveBeenCalledTimes(12)
  })

  test('订阅 RUN_STARTED 收到帧且附 type 与 seq', () => {
    const got: Array<{ f: any; seq?: number }> = []
    const unsub = subscribeAgui(AGUI_EVENT.RUN_STARTED, (f, seq) => got.push({ f, seq }))
    mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 7)
    expect(got).toEqual([{ f: { runId: 'r1', type: 'RUN_STARTED' }, seq: 7 }])
    unsub()
    mockHandlers.get('RUN_STARTED')!({ runId: 'r2' }, 8)
    expect(got).toHaveLength(1)
  })
})
