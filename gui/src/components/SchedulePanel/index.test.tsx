/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SchedulePanel, ScheduleEventFormModal, groupSchedule, isPastEvent, findConflicts } from './index'
import { getCommandHost } from '../../lib/ui-command-registry'

// mock api 层(FileGenPanel 测试同款拦截)
const mockApiGet = vi.fn()
const mockApiPost = vi.fn()
const mockApiPut = vi.fn()
const mockApiDelete = vi.fn()
vi.mock('../../lib/api', () => ({
  apiGet: (...args: any[]) => mockApiGet(...args),
  apiPost: (...args: any[]) => mockApiPost(...args),
  apiPut: (...args: any[]) => mockApiPut(...args),
  apiDelete: (...args: any[]) => mockApiDelete(...args),
}))
// mock scene-client:surface 存在性驱动 visible
let mockSurface: { data: any } | null = null
vi.mock('../../lib/scene-client', () => ({
  useSceneClient: vi.fn(() => mockSurface),
}))
// mock useSse(FileGenPanel 同款):捕获 handlers 以便测试手动触发 schedule:updated
let mockSseHandlers: any = {}
vi.mock('../../hooks/useSSE', () => ({
  useSse: vi.fn(({ handlers }: any) => { mockSseHandlers = handlers }),
}))
// mock SideSheet 与 styles.css
vi.mock('../SideSheet', () => ({ SideSheet: ({ open, onClose, children }: any) => (
  open ? <div data-testid="side-sheet" onClick={(e: any) => { if (e.target === e.currentTarget) onClose() }}>{children}</div> : null
) }))
vi.mock('./styles.css', () => ({}))

function dateStr(offsetDays: number): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function makeEvent(overrides: Partial<{ id: string; title: string; date: string; time: string; duration: number; description: string; color: string; source: string }> = {}): any {
  return {
    id: 'ev1', title: '产品评审', date: dateStr(0), time: '14:00', duration: 60,
    description: '', color: 'blue', source: 'local',
    ...overrides,
  }
}

describe('SchedulePanel 日程卡片', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiPut.mockReset()
    mockApiDelete.mockReset()
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
    mockApiPost.mockResolvedValue({ success: true })
    mockApiPut.mockResolvedValue({ success: true })
    mockApiDelete.mockResolvedValue({ success: true })
  })

  test('无 surface 不渲染;surface 到达即打开并拉取近 7 天日程', async () => {
    const events = [makeEvent({ id: 'a', title: '站会', date: dateStr(0), time: '09:30' })]
    mockApiGet.mockResolvedValue({ success: true, data: { events } })
    const { rerender } = render(<SchedulePanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    mockSurface = { data: { action: 'show' } }
    rerender(<SchedulePanel />)
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('站会')).toBeTruthy())
    // 请求带今天起 7 天窗口
    const url = mockApiGet.mock.calls.map(c => c[0]).find((u: string) => u?.startsWith('/api/calendar?'))
    expect(url).toContain(`start=${dateStr(0)}`)
    expect(url).toContain(`end=${dateStr(6)}`)
  })

  test('分组:今天/明天/日期组 + 时间升序', async () => {
    const events = [
      makeEvent({ id: 'a', title: '后天会议', date: dateStr(2), time: '15:00' }),
      makeEvent({ id: 'b', title: '明天评审', date: dateStr(1), time: '10:00' }),
      makeEvent({ id: 'c', title: '今天站会', date: dateStr(0), time: '09:00' }),
    ]
    mockApiGet.mockResolvedValue({ success: true, data: { events } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('今天站会')).toBeTruthy())
    expect(screen.getByText('今天')).toBeTruthy()
    expect(screen.getByText('明天')).toBeTruthy()
    expect(screen.getByText(/月.*日/)).toBeTruthy()
    // 组内时间升序(今天:09:00 先于 14:00)
    const todayGroup = screen.getByText('今天').closest('.schedule-group') as HTMLElement
    const times = [...todayGroup.querySelectorAll('.schedule-item-time')].map(n => n.textContent)
    expect(times).toEqual(['09:00 - 10:00'])
  })

  test('空态引导', async () => {
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText(/近 7 天暂无日程/)).toBeTruthy())
  })

  test('加载失败 → 错误条 + 重试', async () => {
    mockApiGet.mockResolvedValue({ success: false, error: '加载失败' })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy())
    mockApiGet.mockResolvedValue({ success: true, data: { events: [makeEvent({ title: '站会' })] } })
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(screen.getByText('站会')).toBeTruthy())
  })

  test('关闭按钮 → close 三件套(remove surface + panel-state closed)', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByTestId('side-sheet')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /关闭日程面板/ }))
    await waitFor(() => expect(screen.queryByTestId('side-sheet')).toBeNull())
    const posts = mockApiPost.mock.calls.map(c => c[0])
    expect(posts).toContain('/api/scene/remove')
    expect(posts).toContain('/api/scene/panel-state')
  })

  test('命令宿主 schedulePanel:open 打开卡片', async () => {
    render(<SchedulePanel />)
    const host = getCommandHost<{ open: () => void; close: () => void; isOpen: () => boolean }>('schedulePanel')
    expect(host).toBeTruthy()
    await act(async () => { host!.open() })
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
    await act(async () => { host!.close() })
    expect(screen.queryByTestId('side-sheet')).toBeNull()
  })

  test('schedule:updated 广播 → 面板开着时自动刷新(创建日程后立即可见)', async () => {
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText(/近 7 天暂无日程/)).toBeTruthy())
    const before = mockApiGet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('/api/calendar')).length
    mockApiGet.mockResolvedValue({ success: true, data: { events: [makeEvent({ title: '新创建的会' })] } })
    act(() => { mockSseHandlers['schedule:updated']?.({ action: 'create', event: { id: 'x', title: '新创建的会' } }) })
    await waitFor(() => expect(screen.getByText('新创建的会')).toBeTruthy())
    expect(mockApiGet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('/api/calendar')).length).toBe(before + 1)
  })

  test('schedule:updated 广播 → 面板关闭时不拉取(打开时自会拉新鲜数据)', async () => {
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
    render(<SchedulePanel />)
    const before = mockApiGet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('/api/calendar')).length
    act(() => { mockSseHandlers['schedule:updated']?.({ action: 'create', event: { id: 'x' } }) })
    expect(mockApiGet.mock.calls.filter((c: any[]) => String(c[0]).startsWith('/api/calendar')).length).toBe(before)
  })

  // ── 2026-08-19: 内建增删管（不再跳转业务面板） ──

  test('「添加日程」按钮 → 打开内建表单,不派发业务面板跳转事件', async () => {
    const listener = vi.fn()
    window.addEventListener('crabpaw:open-business-panel', listener as any)
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /添加日程/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /添加日程/ }))
    // 内建模态打开
    expect(screen.getByRole('dialog', { name: '添加日程' })).toBeTruthy()
    // 绝不派发跳转事件
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('crabpaw:open-business-panel', listener as any)
  })

  test('添加日程:填表保存 → POST /api/calendar 带表单 + 关闭模态', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /添加日程/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /添加日程/ }))
    fireEvent.change(screen.getByLabelText('日程标题'), { target: { value: '周会' } })
    fireEvent.change(screen.getByLabelText('日程日期'), { target: { value: '2026-08-21' } })
    fireEvent.change(screen.getByLabelText('日程时间'), { target: { value: '15:00' } })
    fireEvent.change(screen.getByLabelText('日程时长'), { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('日程描述'), { target: { value: '本周同步' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalled())
    const [url, body] = mockApiPost.mock.calls.find((c: any[]) => c[0] === '/api/calendar')!
    expect(url).toBe('/api/calendar')
    expect(body).toMatchObject({ title: '周会', date: '2026-08-21', time: '15:00', duration: 90, description: '本周同步' })
    // 成功后关闭模态
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('自然语言智能解析 → POST /api/calendar/parse 回填表单', async () => {
    mockApiPost.mockResolvedValueOnce({ success: true, data: { event: { title: '开周会', date: '2026-08-20', time: '15:00', duration: 60, description: '明天下午3点开周会' } } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /添加日程/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /添加日程/ }))
    fireEvent.change(screen.getByLabelText('自然语言日程描述'), { target: { value: '明天下午3点开周会' } })
    fireEvent.click(screen.getByText(/智能解析/))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/api/calendar/parse', { text: '明天下午3点开周会' }))
    // 回填
    await waitFor(() => expect((screen.getByLabelText('日程标题') as HTMLInputElement).value).toBe('开周会'))
    expect((screen.getByLabelText('日程日期') as HTMLInputElement).value).toBe('2026-08-20')
    expect((screen.getByLabelText('日程时间') as HTMLInputElement).value).toBe('15:00')
  })

  test('编辑日程:点条目 ✏️ → 表单预填 → 保存 PUT /api/calendar 带 id', async () => {
    mockApiGet.mockResolvedValue({ success: true, data: { events: [makeEvent({ id: 'ev1', title: '产品评审', time: '14:00' })] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('产品评审')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '编辑 产品评审' }))
    const dialog = screen.getByRole('dialog', { name: '编辑日程' })
    expect(dialog).toBeTruthy()
    // 预填
    expect((screen.getByLabelText('日程标题') as HTMLInputElement).value).toBe('产品评审')
    fireEvent.change(screen.getByLabelText('日程标题'), { target: { value: '产品评审(改)' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(mockApiPut).toHaveBeenCalled())
    const [url, body] = mockApiPut.mock.calls.find((c: any[]) => c[0] === '/api/calendar')!
    expect(url).toBe('/api/calendar')
    expect(body).toMatchObject({ id: 'ev1', title: '产品评审(改)', date: dateStr(0), time: '14:00', duration: 60 })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('删除日程:确认后 DELETE /api/calendar?id=', async () => {
    mockApiGet.mockResolvedValue({ success: true, data: { events: [makeEvent({ id: 'ev1', title: '产品评审' })] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('产品评审')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '删除 产品评审' }))
    // useConfirm 弹窗出现
    expect(screen.getByText('删除日程')).toBeTruthy()
    fireEvent.click(screen.getByText('确定'))
    await waitFor(() => expect(mockApiDelete).toHaveBeenCalledWith('/api/calendar?id=ev1'))
  })

  test('删除日程:取消 → 不调 DELETE', async () => {
    mockApiGet.mockResolvedValue({ success: true, data: { events: [makeEvent({ id: 'ev1', title: '产品评审' })] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('产品评审')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '删除 产品评审' }))
    fireEvent.click(screen.getAllByText('取消')[0])
    await waitFor(() => expect(screen.queryByText('删除日程')).toBeNull())
    expect(mockApiDelete).not.toHaveBeenCalled()
  })

  test('ScheduleEventFormModal:独立组件——取消关闭 + 必填校验', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const { rerender } = render(
      <ScheduleEventFormModal open initial={null} onClose={onClose} onSaved={onSaved} />,
    )
    fireEvent.click(screen.getByText('取消'))
    expect(onClose).toHaveBeenCalled()
    // 重新打开:空标题保存 → 不发 POST(必填校验)
    rerender(<ScheduleEventFormModal open initial={null} onClose={onClose} onSaved={onSaved} />)
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(mockApiPost).not.toHaveBeenCalled())
  })

  test('groupSchedule:今天/明天置顶,其余日期升序;isPastEvent 判定', () => {
    const groups = groupSchedule([
      makeEvent({ id: 'd', title: 'D', date: dateStr(4) }),
      makeEvent({ id: 'a', title: 'A', date: dateStr(0) }),
      makeEvent({ id: 'b', title: 'B', date: dateStr(1) }),
      makeEvent({ id: 'c', title: 'C', date: dateStr(2) }),
    ])
    expect(groups.map(g => g.label)).toEqual([
      '今天', '明天',
      expect.stringMatching(/月.*日/), expect.stringMatching(/月.*日/),
    ])
    expect(groups[0].events[0].title).toBe('A')
    // 今天已过时段 → past;未来 → 非 past
    expect(isPastEvent(makeEvent({ date: dateStr(-1) }))).toBe(true)
    expect(isPastEvent(makeEvent({ date: dateStr(0), time: '23:59', duration: 60 }))).toBe(false)
  })
})

describe('SchedulePanel R5 UX', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
    mockApiPost.mockResolvedValue({ success: true })
  })

  test('NL 解析无 title → 表单保持原值不被半填', async () => {
    mockApiPost.mockResolvedValueOnce({ success: true, data: { event: { title: '', date: '2026-08-20', time: '15:00', duration: 60 } } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /添加日程/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /添加日程/ }))
    fireEvent.change(screen.getByLabelText('日程标题'), { target: { value: '手动标题' } })
    fireEvent.change(screen.getByLabelText('自然语言日程描述'), { target: { value: '随便说点啥' } })
    fireEvent.click(screen.getByText(/智能解析/))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/api/calendar/parse', { text: '随便说点啥' }))
    // 解析失败(无 title)不触碰已填表单
    expect((screen.getByLabelText('日程标题') as HTMLInputElement).value).toBe('手动标题')
  })

  test('刷新已有数据时不清空列表（loading 态保留旧数据+顶部细条）', async () => {
    const events = [makeEvent({ id: 'a', title: '站会', time: '09:30' })]
    let resolveSecond: (v: any) => void = () => {}
    mockApiGet.mockResolvedValueOnce({ success: true, data: { events } })  // calendar 首载
    mockApiGet.mockResolvedValueOnce({ success: true, data: [] })          // meetings 首载(S3.3)
    mockApiGet.mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))  // calendar 刷新挂起
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('站会')).toBeTruthy())
    // SSE 触发刷新 → 第二次 GET 挂起
    act(() => { mockSseHandlers['schedule:updated']?.() })
    // 挂起期间旧数据仍在 + 顶部刷新细条出现
    expect(screen.getByText('站会')).toBeTruthy()
    expect(document.querySelector('.schedule-refresh-bar')).toBeTruthy()
    resolveSecond({ success: true, data: { events } })
    await waitFor(() => expect(document.querySelector('.schedule-refresh-bar')).toBeNull())
    expect(screen.getByText('站会')).toBeTruthy()
  })

  test('表单含颜色选择器且默认 blue', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByRole('button', { name: /添加日程/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /添加日程/ }))
    for (const c of ['blue', 'green', 'orange', 'red', 'purple', 'teal']) {
      expect(screen.getByLabelText(`颜色 ${c}`)).toBeTruthy()
    }
    expect(screen.getByLabelText('颜色 blue').className).toContain('color-dot--active')
    fireEvent.click(screen.getByLabelText('颜色 red'))
    expect(screen.getByLabelText('颜色 red').className).toContain('color-dot--active')
    expect(screen.getByLabelText('颜色 blue').className).not.toContain('color-dot--active')
  })
})

describe('SchedulePanel S2.1: schedule:form SSE 预填分流', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
  })

  test('收到 schedule:form → 面板内打开预填表单模态', () => {
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    act(() => {
      mockSseHandlers['schedule:form']?.({ prefill: { title: '开周会', time: '15:00', duration: 60, description: '明天下午3点开周会' } })
    })
    const dialog = screen.getByRole('dialog', { name: '添加日程' })
    expect(dialog).toBeTruthy()
    expect((screen.getByLabelText('日程标题') as HTMLInputElement).value).toBe('开周会')
    expect((screen.getByLabelText('日程时间') as HTMLInputElement).value).toBe('15:00')
  })

  test('panel 未打开时收到 schedule:form → 不崩（数据先行，surface 后到也能预填）', () => {
    const { rerender } = render(<SchedulePanel />)
    act(() => {
      mockSseHandlers['schedule:form']?.({ prefill: { title: '稍后到' } })
    })
    // 面板未渲染(无 surface) → 无模态, 不抛错
    expect(screen.queryByRole('dialog')).toBeNull()
    // surface 到达 → 面板打开且预填仍在
    act(() => { mockSurface = { data: { action: 'show' } } })
    rerender(<SchedulePanel />)
    expect((screen.getByLabelText('日程标题') as HTMLInputElement).value).toBe('稍后到')
  })
})

describe('SchedulePanel S3.1/S3.2: 今日时间线 + 冲突检测', () => {
  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockApiGet.mockReset()
    mockApiGet.mockResolvedValue({ success: true, data: { events: [] } })
  })

  test('findConflicts: 当天重叠事件互相标记, 不重叠不标', () => {
    const conflicts = findConflicts([
      makeEvent({ id: 'a', title: 'A会', time: '10:00', duration: 60 }),
      makeEvent({ id: 'b', title: 'B会', time: '10:30', duration: 30 }),
      makeEvent({ id: 'c', title: 'C会', time: '14:00', duration: 60 }),
    ])
    expect(conflicts.get('a')).toEqual(['B会'])
    expect(conflicts.get('b')).toEqual(['A会'])
    expect(conflicts.has('c')).toBe(false)
  })

  test('今天组第一个未来事件前渲染 now-line', () => {
    const d = dateStr(0)
    const futureTime = '23:59'
    const pastTime = '00:00'
    mockApiGet.mockResolvedValue({ success: true, data: { events: [
      makeEvent({ id: 'past', title: '早会', date: d, time: pastTime, duration: 30 }),
      makeEvent({ id: 'future', title: '下午会', date: d, time: futureTime, duration: 60 }),
    ] } })
    mockSurface = { data: { action: 'show' } }
    const { container } = render(<SchedulePanel />)
    return waitFor(() => expect(screen.getByText('下午会')).toBeTruthy()).then(() => {
      const line = container.querySelector('.schedule-now-line')
      expect(line).toBeTruthy()
      // now-line 位于 future 条目之前: DOM 顺序 past → now-line → future
      const items = Array.from(container.querySelectorAll('.schedule-item, .schedule-now-line'))
      const idxLine = items.findIndex(el => el.classList.contains('schedule-now-line'))
      expect(items[idxLine - 1].textContent).toContain('早会')
      expect(items[idxLine + 1].textContent).toContain('下午会')
    })
  })

  test('已开始未结束的事件灰化(ongoing class)', () => {
    const d = dateStr(0)
    const h = new Date().getHours()
    const m = new Date().getMinutes()
    const startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` // 此刻开始 → 进行中
    mockApiGet.mockResolvedValue({ success: true, data: { events: [
      makeEvent({ id: 'live', title: '进行中会', date: d, time: startTime, duration: 60 }),
    ] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    return waitFor(() => expect(screen.getByText('进行中会')).toBeTruthy()).then(() => {
      const item = screen.getByText('进行中会').closest('.schedule-item') as HTMLElement
      expect(item.className).toContain('schedule-item--ongoing')
    })
  })

  test('冲突事件渲染 ⚠ 角标并标注对方标题', () => {
    const d = dateStr(0)
    mockApiGet.mockResolvedValue({ success: true, data: { events: [
      makeEvent({ id: 'a', title: 'A会', date: d, time: '10:00', duration: 60 }),
      makeEvent({ id: 'b', title: 'B会', date: d, time: '10:30', duration: 30 }),
    ] } })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    return waitFor(() => expect(screen.getByText('B会')).toBeTruthy()).then(() => {
      const itemA = screen.getByText('A会').closest('.schedule-item') as HTMLElement
      expect(itemA.className).toContain('schedule-item--conflict')
      expect(itemA.textContent).toContain('⚠ 与「B会」时间冲突')
      const itemB = screen.getByText('B会').closest('.schedule-item') as HTMLElement
      expect(itemB.textContent).toContain('⚠ 与「A会」时间冲突')
    })
  })
})

// S3.3: 命令宿主注册表 mock（保留 register 语义, getCommandHost 可控）
const mockHostRegistry: Record<string, any> = {}
vi.mock('../../lib/ui-command-registry', () => ({
  registerCommandHost: (name: string, host: any) => {
    mockHostRegistry[name] = host
    return () => { delete mockHostRegistry[name] }
  },
  getCommandHost: (name: string) => mockHostRegistry[name] || null,
}))

describe('SchedulePanel S3.3: 日程×纪要打通', () => {
  const mockMeetingHost = { startRecordingForSchedule: vi.fn(), openMeetingDetail: vi.fn() }

  beforeEach(() => {
    mockSurface = null
    mockSseHandlers = {}
    mockHostRegistry['meetingPanel'] = mockMeetingHost
    mockMeetingHost.startRecordingForSchedule.mockClear()
    mockMeetingHost.openMeetingDetail.mockClear()
    mockApiGet.mockReset()
    mockApiGet.mockImplementation((url: string) => {
      if (url?.startsWith('/api/calendar')) {
        return Promise.resolve({ success: true, data: { events: [makeEvent({ id: 'ev1', title: '评审会', date: dateStr(0), time: '23:59' })] } })
      }
      if (url === '/api/meetings') {
        return Promise.resolve({ success: true, data: [{ id: 'mtg_5', title: '评审会纪要', scheduleId: 'ev1', status: 'done', hasSummary: true }] })
      }
      return Promise.resolve({ success: true, data: [] })
    })
  })

  test('今天/未来条目有「🎙️ 记录」按钮 → 调 meetingPanel.startRecordingForSchedule(id, title)', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('评审会')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '记录 评审会' }))
    expect(mockMeetingHost.startRecordingForSchedule).toHaveBeenCalledWith('ev1', '评审会')
  })

  test('已关联纪要的条目显示「📋 纪要」chip → 点击 openMeetingDetail(mtgid)', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('评审会')).toBeTruthy())
    const chip = await screen.findByRole('button', { name: '纪要 评审会' })
    fireEvent.click(chip)
    expect(mockMeetingHost.openMeetingDetail).toHaveBeenCalledWith('mtg_5')
  })

  test('无关联纪要 → 不渲染 chip', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url?.startsWith('/api/calendar')) {
        return Promise.resolve({ success: true, data: { events: [makeEvent({ id: 'ev1', title: '评审会', date: dateStr(0), time: '23:59' })] } })
      }
      return Promise.resolve({ success: true, data: [] })
    })
    mockSurface = { data: { action: 'show' } }
    render(<SchedulePanel />)
    await waitFor(() => expect(screen.getByText('评审会')).toBeTruthy())
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/api/meetings'))
    expect(screen.queryByRole('button', { name: '纪要 评审会' })).toBeNull()
  })
})
