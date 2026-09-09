import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useMeetingInsights } from './useMeetingInsights'

vi.mock('../lib/api', () => ({ apiPost: vi.fn(() => Promise.resolve({ success: true, data: { todos: ['T1'], decisions: [], points: ['P1'] } })) }))
import { apiPost } from '../lib/api'

// shouldAdvanceTime: RTL waitFor 的微任务清排走 setTimeout(0)——纯假时钟下
// 永不触发导致挂死(RTL 假钟检测只认 jest 不认 vitest), 须放行真实时间推进。
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers() })

function setup(enabled = true) {
  // 回调显式吃 rerender props——否则 rerender 传入的 meetingId 永远到不了 hook
  return renderHook((props?: { meetingId?: string }) => useMeetingInsights({
    meetingId: props?.meetingId ?? 'mtg_x',
    getTranscript: () => '转写内容',
    enabled,
  }))
}

describe('useMeetingInsights 节流提取', () => {
  test('finals 增量 ≥8 触发提取并更新快照', async () => {
    const { result } = setup()
    act(() => { result.current.notify(8) })
    await act(async () => { await vi.runAllTimersAsync() })
    await waitFor(() => expect(result.current.insights.todos).toEqual(['T1']))
    expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/insights', { transcript: '转写内容' })
  })

  test('有新增 + 距上次 ≥30s 触发', async () => {
    const { result } = setup()
    act(() => { result.current.notify(2) })
    await act(async () => { await vi.runAllTimersAsync() })
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))
    act(() => { vi.advanceTimersByTime(31_000); result.current.notify(3) })
    await act(async () => { await vi.runAllTimersAsync() })
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
  })

  test('in-flight 去重: running 中再 notify 不并发', async () => {
    const { result } = setup()
    let resolveApi: (v: any) => void = () => {}
    vi.mocked(apiPost).mockImplementationOnce(() => new Promise(r => { resolveApi = r }))
    act(() => { result.current.notify(8) })
    act(() => { result.current.notify(16) })
    await act(async () => { resolveApi({ success: true, data: { todos: [], decisions: [], points: [] } }); await vi.runAllTimersAsync() })
    expect(apiPost).toHaveBeenCalledTimes(1)
  })

  test('disabled 时 notify 不触发', async () => {
    const { result } = setup(false)
    act(() => { result.current.notify(8) })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(apiPost).not.toHaveBeenCalled()
  })

  test('API 失败静默: 保持上次快照不抛错', async () => {
    vi.useRealTimers()
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('网络断'))
    const { result } = setup()
    act(() => { result.current.notify(8) })
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.insights.todos).toEqual([])
  })

  test('meetingId 变化重置快照与计数（新会议不残留上一场提取）', async () => {
    const { result, rerender } = setup()
    act(() => { result.current.notify(8) })
    await act(async () => { await vi.runAllTimersAsync() })
    await waitFor(() => expect(result.current.insights.todos).toEqual(['T1']))
    rerender({ meetingId: 'mtg_y' })
    await act(async () => { await Promise.resolve() })
    expect(result.current.insights).toEqual({ todos: [], decisions: [], points: [] })
    // 节流计数同步归零: 新会议 8 个 final 再次触发提取
    act(() => { result.current.notify(8) })
    await act(async () => { await vi.runAllTimersAsync() })
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
  })
})
