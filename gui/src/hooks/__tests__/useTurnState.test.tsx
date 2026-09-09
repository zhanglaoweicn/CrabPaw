/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react'
import { useTurnState } from '../useTurnState'

const mockHandlers = new Map<string, (f: any, seq?: number) => void>()
vi.mock('../../lib/agui-events', () => ({
  AGUI_EVENT: {
    RUN_STARTED: 'RUN_STARTED', RUN_FINISHED: 'RUN_FINISHED', RUN_ERROR: 'RUN_ERROR',
    STEP_STARTED: 'STEP_STARTED', STEP_FINISHED: 'STEP_FINISHED',
    TEXT_MESSAGE_CHUNK: 'TEXT_MESSAGE_CHUNK', TOOL_CALL_START: 'TOOL_CALL_START',
    TOOL_CALL_ARGS: 'TOOL_CALL_ARGS', TOOL_CALL_END: 'TOOL_CALL_END',
    TOOL_CALL_RESULT: 'TOOL_CALL_RESULT', ACTIVITY_DELTA: 'ACTIVITY_DELTA', CUSTOM: 'CUSTOM',
  },
  subscribeAgui: vi.fn((type: string, cb: any) => { mockHandlers.set(type, cb); return () => mockHandlers.delete(type) }),
}))

describe('useTurnState', () => {
  test('RUN_STARTED → running+step1; STEP_STARTED 更新 step; RUN_FINISHED → idle', () => {
    const { result } = renderHook(() => useTurnState())
    expect(result.current).toEqual({ running: false, step: 0, runId: null, steps: [] })
    act(() => { mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 1) })
    // startedAt 为 Date.now(), 不能精确 toEqual, 用 toMatchObject 断言结构
    expect(result.current).toMatchObject({ running: true, step: 1, runId: 'r1', steps: [{ stepIndex: 1, status: 'running', toolCalls: 0 }] })
    act(() => { mockHandlers.get('STEP_STARTED')!({ runId: 'r1', stepIndex: 2 }, 2) })
    expect(result.current.step).toBe(2)
    expect(result.current.steps).toHaveLength(2)
    act(() => { mockHandlers.get('RUN_FINISHED')!({ runId: 'r1' }, 3) })
    expect(result.current.running).toBe(false)
    // RUN_FINISHED 兜底关闭全部 running 步骤
    expect(result.current.steps.every(s => s.status !== 'running')).toBe(true)
  })

  test('RUN_ERROR 终止本轮: running → false, running 步骤标 error', () => {
    const { result } = renderHook(() => useTurnState())
    act(() => { mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 1) })
    expect(result.current.running).toBe(true)
    act(() => { mockHandlers.get('RUN_ERROR')!({ runId: 'r1', error: 'boom' }, 2) })
    expect(result.current.running).toBe(false)
    expect(result.current.steps).toMatchObject([{ stepIndex: 1, status: 'error' }])
  })

  test('STEP_FINISHED → 步骤 done + durationMs(前端按 startedAt 推算)', () => {
    const { result } = renderHook(() => useTurnState())
    act(() => { mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 1) })
    act(() => { mockHandlers.get('STEP_STARTED')!({ runId: 'r1', stepIndex: 2 }, 2) })
    act(() => { mockHandlers.get('STEP_FINISHED')!({ runId: 'r1', stepIndex: 2 }, 3) })
    expect(result.current.steps[1]).toMatchObject({
      stepIndex: 2,
      status: 'done',
      toolCalls: 0,
      finishedAt: expect.any(Number),
      durationMs: expect.any(Number),
    })
  })

  test('TOOL_CALL_START 计入当前 running 步骤的 toolCalls(串行取最后一条)', () => {
    const { result } = renderHook(() => useTurnState())
    act(() => { mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 1) })
    act(() => { mockHandlers.get('STEP_STARTED')!({ runId: 'r1', stepIndex: 2 }, 2) })
    act(() => { mockHandlers.get('TOOL_CALL_START')!({ runId: 'r1', toolCallId: 't1', toolCallName: 'bash' }, 3) })
    act(() => { mockHandlers.get('TOOL_CALL_START')!({ runId: 'r1', toolCallId: 't2', toolCallName: 'read' }, 4) })
    expect(result.current.steps[1].toolCalls).toBe(2)
    // 步骤1 已不活跃, 计数不动
    expect(result.current.steps[0].toolCalls).toBe(0)
  })

  test('STEP_FINISHED 幂等: 重复帧不重复写终态', () => {
    const { result } = renderHook(() => useTurnState())
    act(() => { mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 1) })
    const finished = mockHandlers.get('STEP_FINISHED')!
    act(() => { finished({ runId: 'r1', stepIndex: 1 }, 2) })
    const once = result.current.steps[0].durationMs
    act(() => { finished({ runId: 'r1', stepIndex: 1 }, 3) })
    expect(result.current.steps[0].durationMs).toBe(once)
  })

  test('STEP_STARTED 守卫: 非 number stepIndex 不改变 step', () => {
    const { result } = renderHook(() => useTurnState())
    act(() => { mockHandlers.get('RUN_STARTED')!({ runId: 'r1' }, 1) })
    expect(result.current.step).toBe(1)
    // 帧无 stepIndex 字段 → 忽略
    act(() => { mockHandlers.get('STEP_STARTED')!({ runId: 'r1' }, 2) })
    expect(result.current.step).toBe(1)
    // stepIndex 为字符串 → 忽略
    act(() => { mockHandlers.get('STEP_STARTED')!({ runId: 'r1', stepIndex: '2' }, 3) })
    expect(result.current.step).toBe(1)
    // 合法 number 才推进
    act(() => { mockHandlers.get('STEP_STARTED')!({ runId: 'r1', stepIndex: 2 }, 4) })
    expect(result.current.step).toBe(2)
  })

  test('unmount 退订: 卸载后 RUN_STARTED 帧不再改变状态', () => {
    const { result, unmount } = renderHook(() => useTurnState())
    const runStarted = mockHandlers.get('RUN_STARTED')!
    act(() => { runStarted({ runId: 'r1' }, 1) })
    expect(result.current.running).toBe(true)
    unmount()
    // 退订证据: handler 已从 Map 移除
    expect(mockHandlers.has('RUN_STARTED')).toBe(false)
    // 残留回调即便被直接触发, 对已卸载组件也不再生效
    act(() => { runStarted({ runId: 'r2' }, 2) })
    expect(result.current).toMatchObject({ running: true, step: 1, runId: 'r1' })
  })
})
