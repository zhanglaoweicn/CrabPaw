/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { KnowledgePanel, formatUpdatedAt, formatDueAt } from './index'
import { getCommandHost } from '../../lib/ui-command-registry'

// mock api 层（SchedulePanel 测试同款拦截）
const mockApiGet = vi.fn()
const mockApiPost = vi.fn()
vi.mock('../../lib/api', () => ({
  apiGet: (...args: any[]) => mockApiGet(...args),
  apiPost: (...args: any[]) => mockApiPost(...args),
}))
// mock scene-client: kb-panel surface 存在性驱动 visible
let mockSurface: { data: any } | null = null
vi.mock('../../lib/scene-client', () => ({
  useSceneClient: vi.fn(() => mockSurface),
}))
// mock SideSheet 与 styles.css
vi.mock('../SideSheet', () => ({ SideSheet: ({ open, onClose, children }: any) => (
  open ? <div data-testid="side-sheet" onClick={(e: any) => { if (e.target === e.currentTarget) onClose() }}>{children}</div> : null
) }))
vi.mock('./styles.css', () => ({}))

function kbGet(path: string) {
  return mockApiGet.mock.calls.map((c: any[]) => c[0]).filter((u: string) => u?.startsWith(path))
}

describe('KnowledgePanel 知识库面板（DeepTutor 精华前端承载）', () => {
  beforeEach(() => {
    mockSurface = null
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    // 默认:存量快照 + 空文档清单 + 空复习
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/stats')) {
        return Promise.resolve({ success: true, data: { documents: 3, chunks: 42, entities: 7, memories: 0, failures: [] } })
      }
      if (url.startsWith('/api/kb/list')) {
        return Promise.resolve({ success: true, data: { total: 0, documents: [] } })
      }
      if (url.startsWith('/api/kb/due')) {
        return Promise.resolve({ success: true, data: { total: 0, entities: [] } })
      }
      return Promise.resolve({ success: true, data: { query: 'x', total: 0, results: [], message: '知识库中未找到相关内容' } })
    })
    mockApiPost.mockResolvedValue({ success: true })
  })

  test('无 surface 不渲染;surface 到达即打开并预拉三区数据', async () => {
    const { rerender } = render(<KnowledgePanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    mockSurface = { data: { action: 'show' } }
    rerender(<KnowledgePanel />)
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
    // 预拉 stats + list + due（打开时开箱即快）
    await waitFor(() => expect(kbGet('/api/kb/stats')).toHaveLength(1))
    expect(kbGet('/api/kb/list')).toHaveLength(1)
    expect(kbGet('/api/kb/due')).toHaveLength(1)
  })

  test('检索:输入 + 搜索 → GET /api/kb/search 带溯源结果展示', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/search')) {
        return Promise.resolve({
          success: true,
          data: {
            query: '合同金额',
            total: 1,
            results: [{
              id: 'chunk_1', kind: 'chunk', title: '合同分析', snippet: '合同金额 500 万元，付款周期 90 天。',
              score: 0.042, documentId: 'doc_1', source: 'document_analysis', sourcePath: '/tmp/contract.pdf',
            }],
          },
        })
      }
      return Promise.resolve({ success: true, data: { documents: 1, chunks: 1, entities: 1, memories: 0, failures: [] } })
    })
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    fireEvent.change(screen.getByLabelText('知识库检索词'), { target: { value: '合同金额' } })
    fireEvent.click(screen.getByText('🔍 搜索'))
    await waitFor(() => expect(screen.getByText(/合同金额 500 万元/)).toBeTruthy())
    // 溯源（文档标题 + 来源路径）展示
    expect(screen.getByText('合同分析')).toBeTruthy()
    expect(screen.getByText('/tmp/contract.pdf')).toBeTruthy()
    expect(kbGet('/api/kb/search?q=')).toHaveLength(1)
  })

  test('检索:回车提交;空检索词禁用按钮', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    const btn = screen.getByRole('button', { name: /搜索/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true) // 空 query 禁用（弹卡守卫：不给空检索）
    fireEvent.change(screen.getByLabelText('知识库检索词'), { target: { value: '风险' } })
    expect(btn.disabled).toBe(false)
    fireEvent.keyDown(screen.getByLabelText('知识库检索词'), { key: 'Enter' })
    await waitFor(() => expect(kbGet('/api/kb/search?q=')).toHaveLength(1))
  })

  test('检索空结果 → 诚实 message（不编造）', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    fireEvent.change(screen.getByLabelText('知识库检索词'), { target: { value: '不存在的东西' } })
    fireEvent.click(screen.getByText('🔍 搜索'))
    await waitFor(() => expect(screen.getByText('知识库中未找到相关内容')).toBeTruthy())
  })

  test('文档 tab:切换 → 展示文档清单（标题/来源/更新时间）', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/list')) {
        return Promise.resolve({
          success: true,
          data: {
            total: 1,
            documents: [{ id: 'doc_1', title: '季度合同分析', updatedAt: 1750000000000, source: 'document_analysis', sourcePath: '/tmp/q.pdf', charCount: 12000 }],
          },
        })
      }
      return Promise.resolve({ success: true, data: { documents: 1, chunks: 1, entities: 1, memories: 0, failures: [] } })
    })
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    fireEvent.click(screen.getByText('📄 文档清单'))
    await waitFor(() => expect(screen.getByText('季度合同分析')).toBeTruthy())
    expect(screen.getByText('document_analysis')).toBeTruthy()
    expect(screen.getByText('/tmp/q.pdf')).toBeTruthy()
  })

  test('文档空态 → 引导录入（诚实提示）', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    fireEvent.click(screen.getByText('📄 文档清单'))
    await waitFor(() => expect(screen.getByText(/暂无分析文档/)).toBeTruthy())
  })

  test('复习 tab:到期实体展示 + 答对 → POST /api/kb/review correct:true + 条目移除', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/due')) {
        return Promise.resolve({
          success: true,
          data: {
            total: 1,
            entities: [{ id: 'ent_1', name: '付款周期', kind: 'concept', dueAt: Date.now(), interval: 0, streak: 1 }],
          },
        })
      }
      return Promise.resolve({ success: true, data: { documents: 1, chunks: 1, entities: 1, memories: 0, failures: [] } })
    })
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    fireEvent.click(screen.getByText(/🧠 复习/))
    await waitFor(() => expect(screen.getByText('付款周期')).toBeTruthy())
    expect(screen.getByText('概念')).toBeTruthy() // kind 标签
    fireEvent.click(screen.getByRole('button', { name: '记住 付款周期' }))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/api/kb/review', { entityId: 'ent_1', correct: true }))
    await waitFor(() => expect(screen.queryByText('付款周期')).toBeNull()) // 已复习移除
    expect(screen.getByText(/暂无到期复习项/)).toBeTruthy()
  })

  test('复习:答错 → POST correct:false', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/due')) {
        return Promise.resolve({
          success: true,
          data: {
            total: 1,
            entities: [{ id: 'ent_2', name: '合同有效期', kind: 'memory', dueAt: Date.now(), interval: 1, streak: 0 }],
          },
        })
      }
      return Promise.resolve({ success: true, data: { documents: 1, chunks: 1, entities: 1, memories: 0, failures: [] } })
    })
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    fireEvent.click(screen.getByText(/🧠 复习/))
    await waitFor(() => expect(screen.getByText('合同有效期')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /没记住 合同有效期/ }))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/api/kb/review', { entityId: 'ent_2', correct: false }))
  })

  test('关闭按钮 → close 三件套(remove surface + panel-state closed)', async () => {
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    await waitFor(() => expect(screen.getByTestId('side-sheet')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /关闭知识库面板/ }))
    await waitFor(() => expect(screen.queryByTestId('side-sheet')).toBeNull())
    const posts = mockApiPost.mock.calls.map(c => c[0])
    expect(posts).toContain('/api/scene/remove')
    expect(posts).toContain('/api/scene/panel-state')
    const panelStateBody = mockApiPost.mock.calls.find((c: any[]) => c[0] === '/api/scene/panel-state')![1]
    expect(panelStateBody).toMatchObject({ panel: 'knowledge', state: 'closed' })
  })

  test('命令宿主 knowledgePanel:open/close/search 可用', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/search')) {
        return Promise.resolve({
          success: true,
          data: { query: '风险', total: 1, results: [{ id: 'c1', kind: 'chunk', title: '风控报告', snippet: '项目风险点', score: 0.1, documentId: 'd1', source: 'document_analysis', sourcePath: null }] },
        })
      }
      return Promise.resolve({ success: true, data: { documents: 1, chunks: 1, entities: 1, memories: 0, failures: [] } })
    })
    render(<KnowledgePanel />)
    const host = getCommandHost<{ open: () => void; close: () => void; isOpen: () => boolean; search: (q?: string) => void }>('knowledgePanel')
    expect(host).toBeTruthy()
    await act(async () => { host!.open() })
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
    // visible 变化后宿主重注册——取新引用验证 isOpen（旧引用闭包持有旧 visible）
    expect(getCommandHost('knowledgePanel')!.isOpen()).toBe(true)
    // search(q) → 打开 + 自动检索
    await act(async () => { host!.search('风险') })
    await waitFor(() => expect(screen.getByText('风控报告')).toBeTruthy())
    await act(async () => { host!.close() })
    expect(screen.queryByTestId('side-sheet')).toBeNull()
  })

  test('底部存量快照展示 + 失败数显形', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/kb/stats')) {
        return Promise.resolve({ success: true, data: { documents: 3, chunks: 42, entities: 7, memories: 0, failures: [{ path: '/tmp/a.pdf', error: '解析失败' }] } })
      }
      return Promise.resolve({ success: true, data: { documents: 3, chunks: 42, entities: 7, memories: 0, failures: [] } })
    })
    mockSurface = { data: { action: 'show' } }
    render(<KnowledgePanel />)
    await waitFor(() => expect(screen.getByText(/3 文档/)).toBeTruthy())
    expect(screen.getByText(/42 片段/)).toBeTruthy()
    expect(screen.getByText(/7 实体/)).toBeTruthy()
    expect(screen.getByText(/1 条失败/)).toBeTruthy()
  })

  // ── 纯函数 ──

  test('formatUpdatedAt:今天 → 「今天 HH:mm」,历史 → YYYY-MM-DD,空 → 空串', () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 30).getTime()
    expect(formatUpdatedAt(today)).toMatch(/^今天 \d{2}:\d{2}$/)
    expect(formatUpdatedAt(new Date(2026, 0, 15).getTime())).toBe('2026-01-15')
    expect(formatUpdatedAt(null)).toBe('')
  })

  test('formatDueAt:今天/明天/日期/空', () => {
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    expect(formatDueAt(todayStart)).toBe('今天')
    expect(formatDueAt(todayStart + 86_400_000)).toBe('明天')
    expect(formatDueAt(todayStart + 5 * 86_400_000)).toMatch(/^\d{1,2}月\d{1,2}日$/)
    expect(formatDueAt(null)).toBe('随时')
  })
})
