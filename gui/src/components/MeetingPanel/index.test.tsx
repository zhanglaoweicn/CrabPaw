/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Mock } from 'vitest'
import { MeetingPanel } from './index'
import { getCommandHost } from '../../lib/ui-command-registry'

// mock api 层：真实 api.ts 含 import.meta.env（babel-jest 无法解析），
// FileGenPanel 测试同款拦截
vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(() => Promise.resolve({ success: true, data: [] })),
  apiPost: vi.fn(() => Promise.resolve({ success: true, data: {} })),
  apiDelete: vi.fn(() => Promise.resolve({ success: true })),
}))
const { apiGet, apiPost, apiDelete } = await vi.importMock('../../lib/api') as {
  apiGet: Mock
  apiPost: Mock
  apiDelete: Mock
}
// mock scene-client：surface 存在性驱动 visible
let mockSurface: { data: any } | null = null
vi.mock('../../lib/scene-client', () => ({
  useSceneClient: vi.fn(() => mockSurface),
}))
// mock SSE：捕获 handlers 手动触发
let mockSseHandlers: Record<string, (d: any) => void> = {}
vi.mock('../../hooks/useSSE', () => ({
  useSse: vi.fn(({ handlers }: any) => { mockSseHandlers = handlers }),
}))
// mock SideSheet（同 FileGenPanel 测试）
vi.mock('../SideSheet', () => ({ SideSheet: ({ open, onClose, children }: any) => (
  open ? <div data-testid="side-sheet" onClick={(e: any) => { if (e.target === e.currentTarget) onClose() }}>{children}</div> : null
) }))
// mock 转写 hook：不碰真实 WebSocket/AudioContext；state/方法可注入断言。
// mockOnTranscript 捕获组件传入的回调——测试注入 final 段验证落库路径。
let mockHookState = 'idle'
let mockOnTranscript: ((seg: any) => void) | null = null
const mockHookStart = vi.fn(() => Promise.resolve())
const mockHookStop = vi.fn(() => Promise.resolve(65))
const mockHookCleanup = vi.fn()
vi.mock('../../hooks/useMeetingTranscription', () => ({
  useMeetingTranscription: (opts: any) => {
    mockOnTranscript = opts.onTranscript || null
    return {
      state: mockHookState,
      startRecording: mockHookStart,
      stopRecording: mockHookStop,
      cleanup: mockHookCleanup,
    }
  },
}))
// 组件导入自己的 styles.css——jest 无 CSS 转换，virtual mock 拦截
vi.mock('./styles.css', () => ({}))
// mock 唤醒词加载（真实实现走 window.electronAPI, 组件测试注入固定词表）
vi.mock('../../lib/wake-words', () => ({
  loadWakeWords: vi.fn(() => Promise.resolve(['小龙女', '小螃蟹'])),
  invalidateWakeWords: vi.fn(),
  BUILTIN_WAKE_WORDS: ['小螃蟹', '小龙女', 'crabpaw'],
}))

const MTG_SURFACE = { data: { meetingId: 'mtg_1', title: '早会', status: 'recording' } }

describe('MeetingPanel 状态机', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockHookState = 'idle'
    mockOnTranscript = null
    mockHookStart.mockClear()
    mockHookStop.mockClear()
    mockHookCleanup.mockClear()
    apiGet.mockClear()
    apiPost.mockClear()
    apiDelete.mockClear()
    apiGet.mockImplementation(() => Promise.resolve({ success: true, data: [] }))
    apiPost.mockImplementation(() => Promise.resolve({ success: true, data: {} }))
    apiDelete.mockImplementation(() => Promise.resolve({ success: true }))
  })

  test('无 surface 不渲染；surface 到达即打开（空态引导）', () => {
    const { rerender } = render(<MeetingPanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    mockSurface = { data: null }
    rerender(<MeetingPanel />)
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
    expect(screen.getByText(/开始记录/)).toBeTruthy()
    expect(screen.getByText(/历史纪要/)).toBeTruthy()
  })

  test('点击「开始记录」→ POST /api/meetings 建会 + hook 开录 → 录制视图', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: { id: 'mtg_1', title: '会议' } })
      return Promise.resolve({ success: true, data: {} })
    })
    mockSurface = MTG_SURFACE
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/开始记录/))
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/meetings', {})
      expect(mockHookStart).toHaveBeenCalled()
    })
    expect(screen.getByText(/结束记录/)).toBeTruthy()
    expect(screen.getByText('00:00')).toBeTruthy()
  })

  test('SSE meeting:start（LLM 路径）→ 不建会，用事件 meetingId 直接开录；关闭后能复活', async () => {
    mockSurface = MTG_SURFACE
    render(<MeetingPanel />)
    // 先关闭（dismissed）
    fireEvent.click(screen.getByRole('button', { name: /关闭会议面板/ }))
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    expect(apiPost).toHaveBeenCalledWith('/api/scene/remove', { id: 'meeting-panel' })
    // 语音「开始记录」命中 LLM → 后端广播 meeting:start
    act(() => { mockSseHandlers['meeting:start']?.({ meetingId: 'mtg_llm', title: '讨论会' }) })
    await waitFor(() => {
      expect(mockHookStart).toHaveBeenCalled()
      expect(apiPost).not.toHaveBeenCalledWith('/api/meetings', {})
    })
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
    expect(screen.getByText(/结束记录/)).toBeTruthy()
  })

  test('点击「结束记录」→ flush 落库 + 总结 → 展示摘要', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: { id: 'mtg_1', title: '会议' } })
      if (url === '/api/meetings/mtg_1/segments') return Promise.resolve({ success: true, data: { segmentCount: 2 } })
      if (url === '/api/meetings/mtg_1/summarize') {
        return Promise.resolve({ success: true, data: { id: 'mtg_1', summary: '讨论了 Q3 目标与预算', keyPoints: ['要点A', '要点B'] } })
      }
      return Promise.resolve({ success: true, data: {} })
    })
    mockSurface = MTG_SURFACE
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/开始记录/))
    await waitFor(() => expect(mockHookStart).toHaveBeenCalled())
    // 注入 final 段（实时转写落 transcriptsMirrorRef 全量镜像）
    act(() => { mockOnTranscript?.({ id: 'mtg_s1', text: '大家好，今天讨论预算', sequenceId: 1, isFinal: true, timestamp: 0, audioStartTime: 1000 }) })
    fireEvent.click(screen.getByText(/结束记录/))
    await waitFor(() => {
      expect(mockHookStop).toHaveBeenCalled()
      expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_1/segments', expect.objectContaining({ segments: [{ text: '大家好，今天讨论预算', time: 1 }], duration: 65 }))
      expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_1/summarize', {})
    })
    expect(await screen.findByText(/讨论了 Q3 目标与预算/)).toBeTruthy()
    expect(screen.getByText('要点A')).toBeTruthy()
    expect(screen.getByText('要点B')).toBeTruthy()
  })

  test('总结失败 → 错误条 + 重试按钮；重试成功展示摘要', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: { id: 'mtg_1', title: '会议' } })
      if (url === '/api/meetings/mtg_1/segments') return Promise.resolve({ success: true, data: {} })
      if (url === '/api/meetings/mtg_1/summarize') {
        return Promise.resolve({ success: false, error: 'AI 未返回有效回复' })
      }
      return Promise.resolve({ success: true, data: {} })
    })
    mockSurface = MTG_SURFACE
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/开始记录/))
    await waitFor(() => expect(mockHookStart).toHaveBeenCalled())
    fireEvent.click(screen.getByText(/结束记录/))
    expect(await screen.findByText(/AI 未返回有效回复/)).toBeTruthy()
    // 重试成功
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings/mtg_1/summarize') {
        return Promise.resolve({ success: true, data: { id: 'mtg_1', summary: '重试成功摘要', keyPoints: [] } })
      }
      return Promise.resolve({ success: true, data: {} })
    })
    fireEvent.click(screen.getByText(/重试总结/))
    expect(await screen.findByText(/重试成功摘要/)).toBeTruthy()
  })

  test('SSE meeting:stop（LLM 停止路径）→ 面板正在录制时走停止+总结流程', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: { id: 'mtg_1', title: '会议' } })
      if (url === '/api/meetings/mtg_1/summarize') {
        return Promise.resolve({ success: true, data: { id: 'mtg_1', summary: 'SSE 停止摘要', keyPoints: ['k'] } })
      }
      return Promise.resolve({ success: true, data: {} })
    })
    mockSurface = MTG_SURFACE
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/开始记录/))
    await waitFor(() => expect(mockHookStart).toHaveBeenCalled())
    act(() => { mockSseHandlers['meeting:stop']?.({ meetingId: 'mtg_1' }) })
    expect(await screen.findByText(/SSE 停止摘要/)).toBeTruthy()
  })

  test('SSE meeting:summary → 面板复活直接展示摘要（surface 快照兜底）', async () => {
    const { rerender } = render(<MeetingPanel />)
    // SSE 先行：summary 到达（后端 completeMeeting 会紧跟 upsert surface）
    act(() => { mockSseHandlers['meeting:summary']?.({ meetingId: 'mtg_9', summary: 'SSE 摘要', keyPoints: ['k1'] }) })
    // surface 兜底到达 → rerender 打开
    mockSurface = { data: { meetingId: 'mtg_9', title: '复盘', status: 'done', summary: 'SSE 摘要', keyPoints: ['k1'] } }
    rerender(<MeetingPanel />)
    await waitFor(() => expect(screen.getByTestId('side-sheet')).toBeTruthy())
    expect(await screen.findByText(/SSE 摘要/)).toBeTruthy()
  })

  test('历史列表：GET 列表 → 点条目 → GET 详情展示摘要', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/meetings') {
        return Promise.resolve({ success: true, data: [{ id: 'm1', title: '早会', date: '2026-08-19T01:00:00.000Z', duration: 65, segmentCount: 3, hasSummary: true, status: 'done' }] })
      }
      if (url === '/api/meetings/m1') {
        return Promise.resolve({ success: true, data: { id: 'm1', title: '早会', date: '2026-08-19T01:00:00.000Z', duration: 65, segments: [{ text: '大家好', time: 3 }], status: 'done', summary: '历史总结', keyPoints: ['历史要点'] } })
      }
      return Promise.resolve({ success: true, data: null })
    })
    mockSurface = { data: null }
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/历史纪要/))
    expect(await screen.findByText('早会')).toBeTruthy()
    fireEvent.click(screen.getByText('早会'))
    expect(await screen.findByText(/历史总结/)).toBeTruthy()
    expect(screen.getByText('历史要点')).toBeTruthy()
    expect(screen.getByText('大家好')).toBeTruthy()
  })

  test('录音中关闭 → 保存转写但不总结；关闭三件套（remove + panel-state closed）', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: { id: 'mtg_1', title: '会议' } })
      if (url === '/api/meetings/mtg_1/segments') return Promise.resolve({ success: true, data: {} })
      return Promise.resolve({ success: true, data: {} })
    })
    mockSurface = MTG_SURFACE
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/开始记录/))
    await waitFor(() => expect(mockHookStart).toHaveBeenCalled())
    act(() => { mockOnTranscript?.({ id: 'mtg_s1', text: '先记下这句话', sequenceId: 1, isFinal: true, timestamp: 0, audioStartTime: 5000 }) })
    fireEvent.click(screen.getByRole('button', { name: /关闭会议面板/ }))
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/scene/remove', { id: 'meeting-panel' })
      expect(apiPost).toHaveBeenCalledWith('/api/scene/panel-state', { panel: 'meeting', state: 'closed' })
      expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_1/segments', expect.objectContaining({ segments: [{ text: '先记下这句话', time: 5 }] }))
    })
    expect(apiPost).not.toHaveBeenCalledWith('/api/meetings/mtg_1/summarize')
  })

  test('历史列表删除条目 → apiDelete', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/meetings') {
        return Promise.resolve({ success: true, data: [{ id: 'm1', title: '早会', date: '2026-08-19T01:00:00.000Z', duration: 0, segmentCount: 0, hasSummary: false, status: 'done' }] })
      }
      return Promise.resolve({ success: true, data: null })
    })
    mockSurface = { data: null }
    render(<MeetingPanel />)
    fireEvent.click(screen.getByText(/历史纪要/))
    await waitFor(() => expect(screen.getByText('早会')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /删除 早会/ }))
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/meetings/m1'))
  })

  test('命令宿主恒注册：__meetingPanel 提供 startRecording/stopRecording/isRecording', async () => {
    apiPost.mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: { id: 'mtg_1', title: '会议' } })
      return Promise.resolve({ success: true, data: {} })
    })
    mockSurface = null
    render(<MeetingPanel />)
    const host = getCommandHost('meetingPanel')!
    expect(host).toBeTruthy()
    expect(host.isRecording()).toBe(false)
    expect(typeof host.startRecording).toBe('function')
    expect(typeof host.stopRecording).toBe('function')
    expect(typeof host.openHistory).toBe('function')
    expect(typeof host.close).toBe('function')
    expect(host.isOpen()).toBe(false)
    // 语音「开始记录」直连宿主（本地命令路径，不经 SSE）→ 开录即弹卡
    await act(async () => { await host.startRecording() })
    // visible/recording 变化后宿主重新注册——每次从 window 重读最新对象
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/meetings', {})
      expect(getCommandHost('meetingPanel')!.isRecording()).toBe(true)
    })
    expect(getCommandHost('meetingPanel')!.isOpen()).toBe(true)
    // 语音「停止记录」→ 停止+总结流程
    await act(async () => { await getCommandHost('meetingPanel')!.stopRecording() })
    await waitFor(() => expect(mockHookStop).toHaveBeenCalled())
  })
})

/** 驱动（指令回路测试）: 打开面板 → 开录（等建会 POST 落定, recordingRef 置位）→ 推送转录帧。
 * waitMs: 推该帧前等待（裸词通道需 ≥800ms 文本稳定, 模拟火山累积帧间停顿） */
async function drive(frames: { id: string; text: string; isFinal: boolean; waitMs?: number }[]) {
  mockSurface = { data: { meetingId: 'mtg_x' } }
  render(<MeetingPanel />)
  await waitFor(() => expect(screen.getByTestId('side-sheet')).toBeTruthy())
  // 点「开始记录」进入 recording（startRecording 异步: POST 建会后 recordingRef 才置位）
  await act(async () => {
    screen.getByText('▶ 开始记录').click()
  })
  await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings', {}))
  // 等 recording 视图落定——finalize 守卫 recordingRef, 转录帧推送必须在其置位之后
  await waitFor(() => expect(screen.getByText(/■ 结束记录/)).toBeTruthy())
  for (const f of frames) {
    if (f.waitMs) await new Promise(r => setTimeout(r, f.waitMs))
    await act(async () => {
      mockOnTranscript!({ id: f.id, text: f.text, isFinal: f.isFinal, sequenceId: 1, timestamp: Date.now(), audioStartTime: 1000 })
    })
  }
}

describe('MeetingPanel 指令回路（D1/D3 修复）', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockHookState = 'idle'
    mockOnTranscript = null
    mockHookStart.mockClear()
    mockHookStop.mockClear()
    mockHookCleanup.mockClear()
    apiGet.mockClear()
    apiPost.mockClear()
    apiDelete.mockClear()
    apiGet.mockImplementation(() => Promise.resolve({ success: true, data: [] }))
    // data.id 供 startRecording 建会路径, data.summary 供 summarize 成功路径——
    // 空 data 会让 startRecording 抛错停不进 recording
    apiPost.mockImplementation(() => Promise.resolve({ success: true, data: { id: 'mtg_x', summary: '摘要', keyPoints: [] } }))
    apiDelete.mockImplementation(() => Promise.resolve({ success: true }))
  })

  test('partial 尾段稳定后命中停止词即停（不等 final——D1 根因样本）', async () => {
    await drive([
      { id: 'a', text: '第一句内容', isFinal: true },
      // 首帧 stableMs=0 → 裸词通道不触发（防抖语义本身）
      { id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', isFinal: false },
      // 模拟火山累积帧: 850ms 后同段重推 → 稳定命中
      { id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', isFinal: false, waitMs: 850 },
    ])
    // 命中即 finalize（转写落库 + 总结请求）
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/segments', expect.anything()))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/summarize', expect.anything()))
  }, 15000)

  test('落库保留指令前真实内容、剔除指令子串（D3/D4）', async () => {
    await drive([
      { id: 'a', text: '第一句内容', isFinal: true },
      { id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', isFinal: false },
      { id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', isFinal: false, waitMs: 850 },
    ])
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/segments', expect.anything()))
    const call = apiPost.mock.calls.find(c => String(c[0]).endsWith('/segments'))!
    const body = call[1] as any
    const texts = body.segments.map((s: any) => s.text)
    expect(texts).toContain('第一句内容')
    expect(texts).toContain('是 OPC，OPC 适合的人群以及所面临的问题')
    expect(texts.join('|')).not.toContain('结束记录')
  }, 15000)

  test('唤醒词即时通道: partial 帧稳定 0ms 也停', async () => {
    await drive([
      { id: 'a', text: '讨论第一点。小龙女，结束记录', isFinal: false },
    ])
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/summarize', expect.anything()), { timeout: 2000 })
  }, 10000)

  test('停止后 flush 迟到帧不回灌镜像（停止词不重新混入落库 payload）', async () => {
    // 模拟真实 hookStop: flush 期间火山重推同段 raw 尾帧（含停止词）
    mockHookStop.mockImplementationOnce(() => {
      mockOnTranscript?.({ id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', sequenceId: 2, isFinal: false, timestamp: Date.now(), audioStartTime: 1000 })
      return Promise.resolve(42)
    })
    await drive([
      { id: 'a', text: '第一句内容', isFinal: true },
      { id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', isFinal: false },
      { id: 'b', text: '是 OPC，OPC 适合的人群以及所面临的问题。结束记录', isFinal: false, waitMs: 850 },
    ])
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/segments', expect.anything()))
    const call = apiPost.mock.calls.find(c => String(c[0]).endsWith('/segments'))!
    const texts = (call[1] as any).segments.map((s: any) => s.text)
    expect(texts).toContain('是 OPC，OPC 适合的人群以及所面临的问题')
    expect(texts.join('|')).not.toContain('结束记录')
  }, 15000)

  test('唤醒词书签: 打点+TTS+剔除指令词+不停止录制', async () => {
    const speakSpy = vi.spyOn(window, 'dispatchEvent')
    await drive([
      { id: 'a', text: '第一句内容', isFinal: true },
      { id: 'b', text: '讨论预算。小龙女，标记重点', isFinal: false },
    ])
    // 不停止: 无 summarize 调用
    expect(apiPost.mock.calls.filter(c => String(c[0]).endsWith('/summarize'))).toHaveLength(0)
    // 指令词被剔除（转写+落库镜像都干净）
    await waitFor(() => {
      const shown = document.querySelectorAll('.meeting-seg')
      expect(Array.from(shown).map(e => e.textContent).join('|')).not.toContain('标记重点')
    })
    // TTS 播报已标记
    expect(speakSpy.mock.calls.some(c => String((c[0] as any)?.detail?.text || '').includes('已标记'))).toBe(true)
    speakSpy.mockRestore()
  }, 15000)

  test('书签去重: 同段重推同指令不重复打点（finalize payload 单条）', async () => {
    await drive([
      { id: 'a', text: '第一句内容', isFinal: true },
      { id: 'b', text: '小龙女，标记重点', isFinal: false },
      { id: 'b', text: '小龙女，标记重点', isFinal: false, waitMs: 100 },
    ])
    // 手动停止 → segments payload 的 bookmarks 恰 1 条
    await act(async () => { screen.getByText(/■ 结束记录/).click() })
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/meetings/mtg_x/segments', expect.anything()))
    const call = apiPost.mock.calls.find(c => String(c[0]).endsWith('/segments'))!
    expect((call[1] as any).bookmarks).toHaveLength(1)
  }, 15000)

  test('详情视图: 有 bookmarks 渲染重点时刻 chip（R2 空态不共存）', async () => {
    const { apiGet: apiGetMock } = await import('../../lib/api')
    vi.mocked(apiGetMock).mockImplementation((url: string) => {
      if (url === '/api/meetings') return Promise.resolve({ success: true, data: [{ id: 'mtg_bm', title: 'B会', date: '2026-09-01T08:00:00Z', duration: 60, segmentCount: 2, hasSummary: true, status: 'done' }] })
      if (String(url).startsWith('/api/meetings/mtg_bm')) {
        return Promise.resolve({ success: true, data: { id: 'mtg_bm', title: 'B会', date: '2026-09-01T08:00:00Z', duration: 60, segments: [{ text: '讨论预算', time: 0 }, { text: '拍板方案A', time: 30 }], status: 'done', summary: '摘要', keyPoints: [], bookmarks: [{ time: 30, at: 1000 }] } })
      }
      return Promise.resolve({ success: true, data: null })
    })
    mockSurface = { data: { meetingId: 'mtg_bm' } }
    render(<MeetingPanel />)
    await waitFor(() => expect(screen.getByTestId('side-sheet')).toBeTruthy())
    await act(async () => { mockSseHandlers['meeting:history']?.({}) })
    await waitFor(() => expect(screen.getByText('B会')).toBeTruthy())
    await act(async () => { screen.getByText('B会').click() })
    expect(await screen.findByText('🔖 重点时刻')).toBeTruthy()
    expect(screen.getAllByText('00:30').length).toBeGreaterThanOrEqual(1)
  })

  test('录制中右栏提取结果渲染（实时智能层 P2b）', async () => {
    // apiPost 对 /insights 返回提取结果（其余路径沿用默认 mock）
    apiPost.mockImplementation((url: string) => {
      if (String(url).endsWith('/insights')) return Promise.resolve({ success: true, data: { todos: ['发周报'], decisions: ['用方案A'], points: [] } })
      return Promise.resolve({ success: true, data: { id: 'mtg_x', summary: '摘要', keyPoints: [] } })
    })
    // enabled 门 = transcribeState==='recording'（生产中开录后 hook 即 recording），
    // mock 默认恒 idle——须置录制态否则节流提取永不触发
    mockHookState = 'recording'
    await drive([
      { id: 'a', text: '第一句内容', isFinal: true },
      { id: 'b', text: '第二句', isFinal: true },
      // 触发: 8 个 final 增量——用 waitMs+重复 final 帧推计数（id 不同各计一次）
      ...Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, text: `第${i}句`, isFinal: true, waitMs: 30 })),
    ])
    expect(await screen.findByText('📌 待办')).toBeTruthy()
    expect(screen.getByText('发周报')).toBeTruthy()
    expect(screen.getByText('⚖️ 决策')).toBeTruthy()
    // 空组隐藏: 要点为空不渲染
    expect(screen.queryByText('✨ 要点')).toBeNull()
  }, 20000)
})

describe('MeetingPanel 历史空态（R2）', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockOnTranscript = null; vi.clearAllMocks() })

  test('interrupted 空壳详情: 渲染诚实空态 + 删除后回历史列表', async () => {
    // 删除感知 mock：apiDelete 命中后列表返回空（真实后端语义——openHistory 删除后会重新拉取）
    let deleted = false
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/meetings') {
        return Promise.resolve({
          success: true,
          data: deleted ? [] : [{ id: 'mtg_empty', title: '会议 9/1', date: '2026-09-01T08:00:00Z', duration: 0, segmentCount: 0, hasSummary: false, status: 'interrupted' }],
        })
      }
      if (String(url).startsWith('/api/meetings/mtg_empty')) {
        return Promise.resolve({ success: true, data: { id: 'mtg_empty', title: '会议 9/1', date: '2026-09-01T08:00:00Z', duration: 0, segments: [], status: 'interrupted' } })
      }
      return Promise.resolve({ success: true, data: null })
    })
    apiDelete.mockImplementation((url: string) => {
      if (url === '/api/meetings/mtg_empty') deleted = true
      return Promise.resolve({ success: true })
    })
    mockSurface = { data: { meetingId: 'mtg_empty' } }
    render(<MeetingPanel />)
    await waitFor(() => expect(screen.getByTestId('side-sheet')).toBeTruthy())
    // 经 SSE meeting:history（Task 5 接线）打开历史列表
    await act(async () => { mockSseHandlers['meeting:history']?.({}) })
    await waitFor(() => expect(screen.getByText('会议 9/1')).toBeTruthy())
    // 「已中断」徽章可见（R4 前端语义）
    expect(screen.getByText('已中断')).toBeTruthy()
    await act(async () => { screen.getByText('会议 9/1').click() })
    // 空态呈现（R2: 旧实现此场景 body 全空白）
    expect(await screen.findByText('该记录未捕获到语音内容')).toBeTruthy()
    expect(screen.getByText('录制期间可能未拾音或面板过早关闭')).toBeTruthy()
    // 删除 → apiDelete 调用 → 回历史列表
    await act(async () => { screen.getByText('删除这条记录').click() })
    await waitFor(() => expect(vi.mocked(apiDelete)).toHaveBeenCalledWith('/api/meetings/mtg_empty'))
    expect(await screen.findByText('还没有会议记录，点「开始记录」录一场吧')).toBeTruthy()
  })
})

describe('MeetingPanel S3.3: 日程×纪要宿主方法', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    apiGet.mockReset()
    apiPost.mockReset()
    apiGet.mockResolvedValue({ success: true, data: [] })
    apiPost.mockResolvedValue({ success: true, data: {} })
  })

  test('startRecordingForSchedule: POST /api/meetings 带 {scheduleId,title} → 开录+弹卡', async () => {
    apiPost.mockImplementation((url: string, body?: any) => {
      if (url === '/api/meetings' && body?.scheduleId) {
        return Promise.resolve({ success: true, data: { id: 'mtg_s3', title: body.title } })
      }
      return Promise.resolve({ success: true, data: {} })
    })
    render(<MeetingPanel />)
    const host = getCommandHost('meetingPanel')!
    expect(typeof host.startRecordingForSchedule).toBe('function')
    await act(async () => { await host.startRecordingForSchedule('evt_1', '产品评审') })
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledWith('/api/meetings', { scheduleId: 'evt_1', title: '产品评审' })
      expect(getCommandHost('meetingPanel')!.isRecording()).toBe(true)
      expect(getCommandHost('meetingPanel')!.isOpen()).toBe(true)
    })
  })

  test('openMeetingDetail: 拉详情并直开面板', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/meetings/mtg_9') {
        return Promise.resolve({ success: true, data: { id: 'mtg_9', title: '有纪要的会', date: '2026-09-02T10:00:00Z', duration: 60, segments: [], status: 'done', summary: '摘要内容', keyPoints: ['k1'] } })
      }
      return Promise.resolve({ success: true, data: [] })
    })
    render(<MeetingPanel />)
    const host = getCommandHost('meetingPanel')!
    expect(typeof host.openMeetingDetail).toBe('function')
    await act(async () => { await host.openMeetingDetail('mtg_9') })
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/meetings/mtg_9')
      expect(getCommandHost('meetingPanel')!.isOpen()).toBe(true)
    })
    await waitFor(() => expect(screen.getByText(/摘要内容/)).toBeTruthy())
  })
})
