/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiGet, apiPost } from '../../lib/api'
import { getCommandHost } from '../../lib/ui-command-registry'
import { FileGenPanel, formatFileSize, highlightLine } from './index'

// mock api 层：真实 api.ts 含 import.meta.env（babel-jest 无法解析），
// 且测试无 API 调用断言——StockPanel 测试同款拦截
vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(() => Promise.resolve({ success: true, data: null })),
  apiPost: vi.fn(() => Promise.resolve({ success: true })),
}))
// mock scene-client：surface 存在性驱动 visible
let mockSurface: { data: any } | null = null
vi.mock('../../lib/scene-client', () => ({
  useSceneClient: vi.fn(() => mockSurface),
}))
// mock SSE：捕获 handlers + onStatus 手动触发
let mockSseHandlers: Record<string, (d: any) => void> = {}
let mockSseOnStatus: ((status: string) => void) | null = null
vi.mock('../../hooks/useSSE', () => ({
  useSse: vi.fn(({ handlers, onStatus }: any) => { mockSseHandlers = handlers; mockSseOnStatus = onStatus ?? null }),
}))
// 关键：直接 mock useSse 后不必走真实 SSE
vi.mock('../SideSheet', () => ({ SideSheet: ({ open, onClose, children }: any) => (
  open ? <div data-testid="side-sheet" onClick={(e: any) => { if (e.target === e.currentTarget) onClose() }}>{children}</div> : null
) }))
// react-markdown/remark-gfm 为纯 ESM 包（v9/v4），jest(CommonJS) 无法 require——
// 测试无 markdown 渲染断言（md 预览 url=null 走加载态），null 渲染 mock 不改变测试语义
vi.mock('react-markdown', () => {
  const React = require('react')
  return { __esModule: true, default: ({ children }: any) => React.createElement('div', null, children) }
})
vi.mock('remark-gfm', () => ({ __esModule: true, default: () => ({}) }))
// 组件导入自己的 styles.css——jest 无 CSS 转换，virtual mock 拦截（StockPanel 测试同款模式）
// styles.css: vitest 默认 css:false 自动空对象，无需 mock

describe('FileGenPanel 状态机', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })
  afterEach(() => { vi.useRealTimers() })

  test('无 surface 不渲染；surface 到达即打开（空态引导）', () => {
    const { rerender } = render(<FileGenPanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    mockSurface = { data: { taskId: null, title: '', format: '', phase: 'idle' } }
    rerender(<FileGenPanel />)
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
  })

  test('filegen:start → 显示任务标题与阶段徽章', () => {
    mockSurface = { data: { taskId: 't1', title: '市场分析', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    expect(screen.getByText(/市场分析/)).toBeTruthy()
  })

  // 2026-08-18 实机反馈修复: 标题栏此前无关闭按钮(SideSheet 契约要求各面板
  // 自带 data-close-btn, 供打开聚焦/焦点圈闭)——唯一缺该按钮的面板
  test('标题栏关闭按钮（data-close-btn）→ 点击关闭面板', () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    const closeBtn = screen.getByRole('button', { name: /关闭文件面板/ })
    expect(closeBtn.getAttribute('data-close-btn')).not.toBeNull()
    fireEvent.click(closeBtn)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
  })

  test('filegen:done(md) → 预览分派 markdown 阅读器', async () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'done', file: { name: 'a.md' } } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:done']?.({ taskId: 't1', file: { path: '/x/a.md', name: 'a.md', format: 'md', url: null } })
    })
    await waitFor(() => expect(screen.getByText(/已生成/)).toBeTruthy())
  })

  test('filegen:error → 显示错误信息', () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'error', error: 'python 转换失败' } }
    render(<FileGenPanel />)
    expect(screen.getByText(/python 转换失败/)).toBeTruthy()
  })

  test('filegen:done(html) → 开发模式分屏（iframe + 代码窗）', () => {
    mockSurface = { data: { taskId: 't2', title: '行情页', format: 'html', phase: 'done', file: { path: '/x/out.html', name: 'out.html', url: 'local:///x/out.html' } } }
    render(<FileGenPanel />)
    const iframe = screen.getByTitle('html-preview') as HTMLIFrameElement
    expect(iframe).toBeTruthy()
    // 安全断言：仅 allow-scripts，禁 allow-same-origin（防沙箱逃逸读取本地文件）
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(screen.getByText(/代码流/)).toBeTruthy()
  })

  // 2026-08-22 UI 迭代（方案 A）: md/docx 改单栏文档流——Write 内容直渲染文档流
  //（不再经 /api/files/read 双栏预览）。Write 帧先于 done → 内容显示且 done 后保持。
  test('Write 帧 → 单栏文档流渲染正文与大纲（done 后内容保持）', async () => {
    mockSurface = { data: { taskId: 't3', title: '报告', format: 'md', phase: 'writing', label: '正在撰写 a.md…' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({
        taskId: 't3', toolName: 'Write',
        toolArgs: { path: '/x/a.md', content: '# 标题一\n\n正文内容第一段' },
      })
    })
    await waitFor(() => expect(screen.getByText(/正文内容第一段/)).toBeTruthy())
    // 大纲区提取标题（②大纲编写步骤的真实内容）
    const outline = screen.getByTestId('filegen-docstream-outline')
    expect(within(outline).getByText(/标题一/)).toBeTruthy()
    // done 到达 → 内容保持显示
    act(() => { mockSseHandlers['filegen:done']?.({ taskId: 't3', file: { path: '/x/a.md', name: 'a.md', format: 'md', url: null }, files: [{ path: '/x/a.md', name: 'a.md', format: 'md', url: null }] }) })
    expect(screen.getByText(/正文内容第一段/)).toBeTruthy()
  })

  // 2026-08-17 实机回归：用户关闭面板后,新任务 filegen:start 不得复活面板。
  // 此前 start 无条件 setDismissed(false)——"关闭文档卡片"后下次写文档又弹。
  test('用户关闭后面板不因新任务 start 复活', () => {
    // 任务1 开始：后端 upsert surface + start 事件 → 面板打开
    mockSurface = { data: { taskId: 't1', title: '第一份', format: 'md', phase: 'collect' } }
    const { rerender } = render(<FileGenPanel />)
    act(() => { mockSseHandlers['filegen:start']?.({ taskId: 't1', title: '第一份', format: 'md' }) })
    rerender(<FileGenPanel />)
    expect(screen.getByTestId('side-sheet')).toBeTruthy()

    // 用户关闭（surface 仍在，点 ✕ → handleClose: dismissed=true + 异步 remove）
    fireEvent.click(screen.getByTestId('side-sheet'))
    rerender(<FileGenPanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()

    // 新任务开始：surface 重新 upsert + start 事件 → 面板必须保持关闭
    mockSurface = { data: { taskId: 't2', title: '第二份', format: 'md', phase: 'collect' } }
    rerender(<FileGenPanel />)
    act(() => { mockSseHandlers['filegen:start']?.({ taskId: 't2', title: '第二份', format: 'md' }) })
    rerender(<FileGenPanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
  })

  // 2026-08-17 实机回归：生成中显示过程流（thinking/tool_call 滚入）——
  // 用户要求面板中可见 搜索资料→编写内容 的生成过程
  // 2026-08-22 UI 迭代: md 单栏文档流——过程行显示为文档流顶部「过程提示条」
  test('生成中显示过程流（thinking/tool_call 滚入文档流过程条）', () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    act(() => { mockSseHandlers['thinking']?.({ content: '正在搜索台风相关资料…' }) })
    act(() => { mockSseHandlers['tool_call']?.({ toolName: 'WebSearch', toolArgs: '{"query":"台风"}' }) })
    const processBar = screen.getByTestId('filegen-docstream-process')
    expect(within(processBar).getByText(/正在搜索台风相关资料/)).toBeTruthy()
    expect(within(processBar).getByText(/WebSearch/)).toBeTruthy()
  })

  // 用户主动语音重开后,新任务快照正常显示（与关闭不复活互斥语义）
  test('用户重新打开后新任务仍显示', () => {
    mockSurface = { data: { taskId: 't1', title: '第一份', format: 'md', phase: 'done', file: { name: 'a.md' } } }
    const { rerender } = render(<FileGenPanel />)
    // 关闭
    fireEvent.click(screen.getByTestId('side-sheet'))
    rerender(<FileGenPanel />)
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    // 语音重开（__filePanel.setVisible(true)）→ 新任务快照恢复
    act(() => { getCommandHost('filePanel')!.setVisible!(true) })
    rerender(<FileGenPanel />)
    expect(screen.getByTestId('side-sheet')).toBeTruthy()
  })

  test('registerCommandHost 暴露 close/open（window.__filePanel）', () => {
    render(<FileGenPanel />)
    expect(getCommandHost('filePanel')).toBeTruthy()
    expect(typeof getCommandHost('filePanel')!.close).toBe('function')
    expect(typeof getCommandHost('filePanel')!.setVisible).toBe('function')
  })

  // 2026-08-17: 流程指示器逐步可视化；2026-08-23 双卡片架构——文档版五步
  // （资料搜集→大纲→撰写→格式转换→成品）/ 网页版四步（资料搜集→大纲→编码→实时预览）
  describe('流程指示器（文档五步 / 网页四步）', () => {
    const stepEls = () => Array.from(document.querySelectorAll('.filegen-step'))

    test('collect 阶段 → ①资料搜集高亮，后续未完成（文档五步，md+autoDocx）', () => {
      mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'collect', autoDocx: true } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el.length).toBe(5)
      expect(el[0].className).toContain('filegen-step--active')
      expect(el[1].className).not.toContain('filegen-step--done')
      expect(el[1].className).not.toContain('filegen-step--active')
    })

    test('2026-09-06: 纯 md（无 autoDocx）→ 四步表（无"格式转换"步）', () => {
      mockSurface = { data: { taskId: 't1', title: '文章', format: 'md', phase: 'collect' } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el.length).toBe(4)
      expect(el.map(e => e.textContent).join('')).not.toContain('格式转换')
      expect(el[3].textContent).toContain('成品')
    })

    test('html 网页版 → 四步（③编码 ④实时预览）', () => {
      mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing', label: '正在写页面…' } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el.length).toBe(4)
      expect(el[3].textContent).toContain('实时预览')
      // 文档五步的「格式转换/成品」不在网页版
      expect(el.map(e => e.textContent).join('')).not.toContain('格式转换')
    })

    test('M2 直接生成(DocxGenerate) → ③撰写高亮(不再停②大纲)', () => {
      mockSurface = { data: { taskId: 't9', title: '报告', format: 'docx', phase: 'collect' } }
      render(<FileGenPanel />)
      act(() => { mockSseHandlers['filegen:phase']({ taskId: 't9', phase: 'writing', label: '正在生成 Word 文档…' }) })
      act(() => { mockSseHandlers['tool_call']({ toolName: 'DocxGenerate', toolArgs: '{}', toolId: 'x' }) })
      const el = stepEls()
      expect(el[2].className).toContain('filegen-step--active')
    })

    test('M2 轮询同 phase label 刷新(心跳停滞恢复)', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        mockSurface = { data: { taskId: 't10', title: '报告', format: 'docx', phase: 'writing', label: '正在生成 Word 文档…' } }
        ;(apiGet as any).mockResolvedValue({ success: true, data: { taskId: 't10', format: 'docx', phase: 'writing', label: '正在生成 Word 文档…（5 秒）' } })
        render(<FileGenPanel />)
        await act(async () => { await vi.advanceTimersByTimeAsync(10010) })
        await waitFor(() => expect(screen.getAllByText(/（5 秒）/).length).toBeGreaterThan(0))
      } finally {
        vi.useRealTimers()
      }
    })

    test('writing 阶段未出现写入调用 → ②大纲高亮', () => {
      mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing', label: '正在撰写…' } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el[0].className).toContain('filegen-step--done')
      expect(el[1].className).toContain('filegen-step--active')
    })

    test('writing 阶段出现 Write 工具调用 → ③撰写高亮', () => {
      mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing', label: '正在撰写…' } }
      render(<FileGenPanel />)
      act(() => { mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: '{"file_path":"a.md"}' }) })
      const el = stepEls()
      expect(el[1].className).toContain('filegen-step--done')
      expect(el[2].className).toContain('filegen-step--active')
    })

    test('converting 阶段 → ④格式转换高亮（文档五步）', () => {
      mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'converting', label: '正在转换为 Word…' } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el[0].className).toContain('filegen-step--done')
      expect(el[1].className).toContain('filegen-step--done')
      expect(el[2].className).toContain('filegen-step--done')
      expect(el[3].className).toContain('filegen-step--active')
    })

    test('done(文档，md+autoDocx) → 五步全部完成（✓ 勾选）', () => {
      mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'done', file: { name: 'a.md' }, autoDocx: true } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el.length).toBe(5)
      el.forEach(e => expect(e.className).toContain('filegen-step--done'))
    })

    test('2026-09-06: done(纯 md 无转换) → 四步全部完成（"格式转换"不再自动 ✓）', () => {
      mockSurface = { data: { taskId: 't1', title: '文章', format: 'md', phase: 'done', file: { name: 'a.md' } } }
      render(<FileGenPanel />)
      const el = stepEls()
      expect(el.length).toBe(4)
      el.forEach(e => expect(e.className).toContain('filegen-step--done'))
    })
  })
})

// ─── 2026-08-17 R2-4 多文件归组 ───
describe('R2-4 代码流按文件归组', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  // 2026-08-23 降噪: 工具调用标题行/thinking 帧改走操作日志（折叠条）——
  // 代码流 tab 只有真实文件组，不再有 '过程' 组（网页版主区呈现编码而非工具调用）
  test('tool_call 带不同 path → 生成多个文件 tab；thinking/标题行进操作日志（无 过程 tab）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['thinking']?.({ content: '正在构思布局…' })
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/index.html', content: '<h1>hi</h1>' }) })
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ file_path: '/x/style.css', content: 'body{}' }) })
    })
    // tab 条：index.html / style.css（tab 按钮带 data-testid 定位，避开代码流内容重名）
    expect(screen.getByTestId('flow-tab-index.html')).toBeTruthy()
    expect(screen.getByTestId('flow-tab-style.css')).toBeTruthy()
    // 2026-08-23 降噪: 无 '过程' tab——thinking/标题行收纳进操作日志折叠条
    expect(screen.queryByTestId('flow-tab-过程')).toBeNull()
    expect(screen.getByTestId('filegen-oplog')).toBeTruthy()
  })

  test('切换 tab 只显示该文件代码行', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/index.html', content: 'AAA' }) })
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/style.css', content: 'BBB' }) })
    })
    fireEvent.click(screen.getByTestId('flow-tab-index.html'))
    expect(screen.getByText(/AAA/)).toBeTruthy()
    expect(screen.queryByText(/BBB/)).toBeNull()
  })
})

// ─── 2026-08-18 实机反馈修复 G2: 编码过程可视化 ───
// 用户反馈"整个过程太快了，没有显示网页代码编写的过程"——此前 tool_call 的
// toolArgs 全量参数 JSON（含 Write content）被拼成一条巨长行。修复后标题行只带
// 路径，Write 的 content / Edit 的 new_string 按行滚入代码流（逐行 div + reveal 动画）。
describe('G2 编码过程可视化（Write/Edit content 逐行滚入）', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  // 2026-08-23 降噪: 代码流只含 Write/Edit 的真实代码行——标题行（⟪Write⟫ 路径）
  // 收纳进操作日志折叠条（默认收起 → 展开后可见）。G2 的「标题行只带路径」语义保留，
  // 只是展示位置从代码流移到操作日志。
  test('Write tool_call → 代码流只渲染 content 行，标题行进操作日志（无全量 JSON 巨长行）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({
        toolName: 'Write',
        toolArgs: JSON.stringify({ file_path: '/x/index.html', content: '<!DOCTYPE html>\n<html>\n<body>hi</body>\n</html>' }),
      })
    })
    // 全量参数 JSON 不进代码流
    expect(screen.queryByText(/"content"/)).toBeNull()
    expect(screen.queryByText(/"file_path"/)).toBeNull()
    // 代码流行 = content 4 行（每行独立 div，非一条巨长行；无标题行）
    const lines = document.querySelectorAll('.filegen-code-line')
    expect(lines.length).toBe(4)
    expect(lines[0].textContent).toBe('<!DOCTYPE html>')
    expect(lines[2].textContent).toContain('hi')
    // 行带错峰 animationDelay（reveal 动画生效）
    expect((lines[0] as HTMLElement).style.animationDelay).toBe('0ms')
    expect((lines[3] as HTMLElement).style.animationDelay).toBe('42ms')
    // 标题行（⟪Write⟫ + 路径，不带全量参数）→ 操作日志；默认收起 → 展开可见
    fireEvent.click(screen.getByText(/操作日志/).closest('button')!)
    expect(screen.getByText(/⟪Write⟫ \/x\/index\.html/)).toBeTruthy()
    expect(screen.getByText(/⟪Write⟫/).textContent).not.toContain('"content"')
  })

  test('Edit tool_call → new_string 按行滚入代码流', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Edit', toolArgs: JSON.stringify({ file_path: '/x/index.html', new_string: 'line-a\nline-b' }) })
    })
    const lines = document.querySelectorAll('.filegen-code-line')
    expect(lines.length).toBe(2) // new_string 2 行（标题行进操作日志，不在代码流）
    expect(lines[0].textContent).toBe('line-a')
    expect(lines[1].textContent).toBe('line-b')
  })

  test('内容超 400 行 → 截断并提示省略行数', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    const big = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n')
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/big.html', content: big }) })
    })
    expect(screen.getByText(/省略 50 行/)).toBeTruthy()
  })

  test('无 content 的 Write（如仅指定路径）→ 代码流无行，标题行进操作日志', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/out.html' }) })
    })
    // 无 content → 代码流无行（显示等待文案）
    expect(document.querySelectorAll('.filegen-code-line').length).toBe(0)
    // 标题行 → 操作日志（展开可见）
    fireEvent.click(screen.getByText(/操作日志/).closest('button')!)
    expect(screen.getByText(/⟪Write⟫ \/x\/out\.html/)).toBeTruthy()
  })
})

// ─── 2026-08-17 R2-2 网页实时分屏 ───
describe('R2-2 html 生成中分屏（编码过程可视化）', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  test('html 类型生成中（writing）→ 渲染分屏（iframe 存在 + 代码流）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/index.html', content: '<h1>hi</h1>' }) })
    })
    // 分屏 iframe（src=local://…主 html，2026-08-18 html=1 门控参数）
    const iframe = document.querySelector('iframe.filegen-html-iframe') as HTMLIFrameElement | null
    expect(iframe).toBeTruthy()
    expect(iframe?.src).toContain('index.html')
    expect(iframe?.src).toContain('html=1')
  })

  test('每次 Write tool_call → iframe src 刷新（?t= 时间戳变化）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/index.html', content: 'v1' }) })
    })
    const src1 = (document.querySelector('iframe.filegen-html-iframe') as HTMLIFrameElement).src
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/index.html', content: 'v2' }) })
    })
    const src2 = (document.querySelector('iframe.filegen-html-iframe') as HTMLIFrameElement).src
    expect(src2).not.toBe(src1)
    expect(src2).toContain('&t=')
  })

  test('非 html 格式生成中不渲染分屏（md 走 working 流）', () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing' } }
    render(<FileGenPanel />)
    expect(document.querySelector('iframe.filegen-html-iframe')).toBeNull()
  })

  // 2026-08-17 审查修复 Minor-3：新任务 collect 期 file.url=null 时两个 effect 均跳过
  // → src 残留旧任务文件，iframe 显示旧产物。修复后 url 置空即清 src，显示等待文案。
  test('新任务 collect 期清空 iframe src（跨任务不残留旧产物）', async () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'Write', toolArgs: JSON.stringify({ path: '/x/index.html', content: 'v1' }) })
    })
    expect(document.querySelector('iframe.filegen-html-iframe')).toBeTruthy()
    // 新任务 start（mainHtmlPath 重置 → url=null）→ iframe 必须消失
    act(() => { mockSseHandlers['filegen:start']?.({ taskId: 't2', title: '新网页', format: 'html' }) })
    await waitFor(() => expect(document.querySelector('iframe.filegen-html-iframe')).toBeNull())
    expect(screen.getByText('等待主文件写出…')).toBeTruthy()
  })
})

// ─── 2026-08-17 审查修复 Important-2: highlightLine 单次交替正则 ───
// 分步 replace 会重扫上一步插入的 <span> 标记——字符串正则命中 "tok-…" 属性值、
// 关键字正则命中 class，属性被拆碎泄漏为可见文本（⟪Write⟫ JSON 行全损）。
describe('highlightLine 语法高亮（单次交替正则，插入标记不被重扫）', () => {
  test('注释行整体标记 tok-comment', () => {
    expect(highlightLine('// 注释')).toBe('<span class="tok-comment">// 注释</span>')
  })

  test('字符串+关键字行 token 完整（span 属性不被拆碎）', () => {
    expect(highlightLine('const url = "http://x";'))
      .toBe('<span class="tok-key">const</span> url = <span class="tok-str">"http://x"</span>;')
  })

  test('⟪Write⟫ JSON 行两处 tok-str 完整（无属性重扫）', () => {
    const out = highlightLine('⟪Write⟫ {"path":"/x/a.html"}')
    expect(out).toContain('<span class="tok-str">"path"</span>')
    expect(out).toContain('<span class="tok-str">"/x/a.html"</span>')
    // 两处字符串 → 恰好 2 个 span；若插入标记被重扫，span 数会膨胀
    expect((out.match(/<span/g) || []).length).toBe(2)
  })
})

// ─── 2026-08-17 R2-3 后台完成通知 ───
// 2026-09-06 修订: done 不再强制滑入面板（"完成即打断"改 toast 分层）——
// dismissed 时派发 toast + 播报，面板保持关闭；点击 toast"查看"才重开。
describe('R2-3 done 通知分层（toast + 播报，不强制滑入）', () => {
  test('用户关闭（dismissed）后当前任务 done → 面板不复活 + crabpaw:speak 播报', () => {
    const speakSpy = vi.fn()
    window.addEventListener('crabpaw:speak', speakSpy as any)
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing' } }
    render(<FileGenPanel />)
    // 模拟用户关闭：触发 SideSheet onClose
    fireEvent.click(screen.getByTestId('side-sheet'))
    // 关闭后面板消失
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    // 任务完成
    act(() => {
      mockSseHandlers['filegen:done']?.({ taskId: 't1', file: { path: '/x/a.md', name: 'a.md', format: 'md', url: null } })
    })
    // 2026-09-06: 不再自动重开（防打断），但语音播报照发
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    expect(speakSpy).toHaveBeenCalled()
    const evt = speakSpy.mock.calls[0][0] as CustomEvent
    expect(evt.detail.text).toContain('a.md')
    window.removeEventListener('crabpaw:speak', speakSpy as any)
  })

  test('新任务 start 不复活面板（回归：用户主动关闭后不自动弹出）', () => {
    mockSurface = { data: { taskId: 't1', title: '旧', format: 'md', phase: 'writing' } }
    render(<FileGenPanel />)
    fireEvent.click(screen.getByTestId('side-sheet'))
    expect(screen.queryByTestId('side-sheet')).toBeNull()
    act(() => {
      mockSseHandlers['filegen:start']?.({ taskId: 't2', title: '新', format: 'md' })
    })
    expect(screen.queryByTestId('side-sheet')).toBeNull() // 不复活
  })
})

// ─── 2026-08-17 final-review 修复轮（whole-branch 审查 P2×2 + R2-4）───
describe('final-review: done 态多文件（format 不翻转 + 产物清单）', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  // P2: 多文件网页 index.html→style.css 依次 done，最后一个 done 事件的 file 是 css——
  // format 被翻转成 'code' 后 done 预览丢页面预览。产物含 html 文件必须保持 html。
  test('多文件网页 done：最后产物 css 不把 format 翻转成 code（保持 html 页面预览）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:done']?.({
        taskId: 't1',
        file: { path: '/x/style.css', name: 'style.css', size: 50, format: 'code', url: null },
        files: [
          { path: '/x/index.html', name: 'index.html', size: 1234, format: 'html', url: 'local:///x/index.html' },
          { path: '/x/style.css', name: 'style.css', size: 50, format: 'code', url: null },
        ],
      })
    })
    const iframe = document.querySelector('iframe.filegen-html-iframe') as HTMLIFrameElement | null
    expect(iframe).toBeTruthy()
    expect(iframe?.src).toContain('index.html') // 页面预览指向 html 主文件而非 css
  })

  // R2-4: done 态产物清单（icon+名+人类可读大小，点击打开；主文件高亮）
  test('done 态渲染产物清单：多文件列表 + 主文件高亮 + 大小人类可读', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:done']?.({
        taskId: 't1',
        file: { path: '/x/index.html', name: 'index.html', size: 1234, format: 'html', url: 'local:///x/index.html' },
        files: [
          { path: '/x/index.html', name: 'index.html', size: 1234, format: 'html', url: 'local:///x/index.html' },
          { path: '/x/style.css', name: 'style.css', size: 50, format: 'code', url: null },
        ],
      })
    })
    expect(screen.getByText(/产物清单/)).toBeTruthy()
    const main = screen.getByTestId('artifact-index.html')
    const sub = screen.getByTestId('artifact-style.css')
    expect(main).toBeTruthy()
    expect(sub).toBeTruthy()
    // 主文件高亮：path 与 task.file.path 匹配的 html 文件
    expect(main.className).toContain('filegen-artifact--main')
    expect(sub.className).not.toContain('filegen-artifact--main')
    // 人类可读大小（1234 B → 1.2 KB；50 B → 50 B）
    expect(screen.getByText('1.2 KB')).toBeTruthy()
    expect(screen.getByText('50 B')).toBeTruthy()
  })

  test('formatFileSize 人类可读大小', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1234)).toBe('1.2 KB')
    expect(formatFileSize(3.5 * 1024 * 1024)).toBe('3.5 MB')
    expect(formatFileSize(-1)).toBe('—')
  })
})

// ─── 2026-08-20 SSE 断连重连对账 ───
// 实机场景：任务已 done，但 done 事件在 SSE 断开期间发出（后端重启/网络抖动）→
// 面板永久卡「正在撰写…」。SSE open（含重连）时拉 /api/filegen/status 快照恢复。
describe('SSE 重连对账', () => {
  // 2026-08-28 SP-4: 组件挂载即拉 /api/doc-artifacts——once 队列会被挂载拉取抢先消费,
  // 对账 mock 改按路径路由（/api/filegen/status 专属）, 其余路径默认空数据
  beforeEach(() => {
    mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null
    ;(apiGet as any).mockImplementation(() => Promise.resolve({ success: true, data: null }))
  })

  test('SSE open 时拉状态快照 → 断连期完成的终态恢复（不再永久卡撰写中）', async () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing', label: '正在撰写…' } }
    ;(apiGet as any).mockImplementation((p: string) => p.startsWith('/api/filegen/status')
      ? Promise.resolve({
        success: true,
        data: { taskId: 't1', title: '报告', format: 'md', phase: 'done', file: { name: '报告.md' } },
      })
      : Promise.resolve({ success: true, data: null }))
    render(<FileGenPanel />)
    // 初始卡 writing（②大纲编写 active，④未完成）
    const el0 = Array.from(document.querySelectorAll('.filegen-step'))
    expect(el0[1].className).toContain('filegen-step--active')
    expect(el0[3].className).not.toContain('filegen-step--done')

    // SSE 重连 open → 对账快照恢复 done
    act(() => { mockSseOnStatus?.('open') })
    await waitFor(() => {
      const el = Array.from(document.querySelectorAll('.filegen-step'))
      el.forEach(e => expect(e.className).toContain('filegen-step--done'))
    })
    // 终态产物清单渲染（done 快照带 file）
    expect(screen.getByText(/报告\.md|已生成/)).toBeTruthy()
  })

  test('快照 taskId 与当前任务不匹配 → 不对账（不串任务）', async () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing', label: '正在撰写…' } }
    ;(apiGet as any).mockImplementation((p: string) => p.startsWith('/api/filegen/status')
      ? Promise.resolve({
        success: true,
        data: { taskId: 'other', phase: 'done', file: { name: '别的.md' } },
      })
      : Promise.resolve({ success: true, data: null }))
    render(<FileGenPanel />)
    act(() => { mockSseOnStatus?.('open') })
    // 保持 writing（②仍 active）
    const el = Array.from(document.querySelectorAll('.filegen-step'))
    expect(el[1].className).toContain('filegen-step--active')
    expect(el[3].className).not.toContain('filegen-step--done')
  })

  test('对账失败（接口错误）不抛错——仅告警', () => {
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'md', phase: 'writing', label: '正在撰写…' } }
    ;(apiGet as any).mockImplementation((p: string) => p.startsWith('/api/filegen/status')
      ? Promise.reject(new Error('backend down'))
      : Promise.resolve({ success: true, data: null }))
    render(<FileGenPanel />)
    expect(() => act(() => { mockSseOnStatus?.('open') })).not.toThrow()
  })

  // ─── 2026-08-22 UI 迭代（方案 A）: 文章单栏文档流（md/docx 不再双栏代码流）───
  test('docx 生成中 → 单栏文档流（空态等待 + 状态条）', () => {
    mockSurface = { data: { taskId: 't1', title: '文章', format: 'docx', phase: 'writing', label: '正在撰写 文章.md…' } }
    render(<FileGenPanel />)
    // 单栏文档流（无左右分栏）
    expect(screen.getByTestId('filegen-docstream')).toBeTruthy()
    expect(screen.queryByTestId('filegen-preview-pane')).toBeNull()
    expect(screen.queryByText(/编码中/)).toBeNull()
    // 未写出内容 → 空态
    expect(screen.getByTestId('filegen-docstream-empty')).toBeTruthy()
  })

  test('done(docx) → 单栏文档流 + 底部操作条', () => {
    mockSurface = {
      data: {
        taskId: 't1', title: '文章', format: 'docx', phase: 'done',
        file: { path: 'D:/data/workspace/documents/文章_123.docx', name: '文章_123.docx', size: 10240, format: 'docx', url: null },
        files: [{ path: 'D:/data/workspace/documents/文章_123.docx', name: '文章_123.docx', size: 10240, format: 'docx', url: null }],
      },
    }
    render(<FileGenPanel />)
    // 单栏文档流（无右栏文件卡——产物由底部操作条呈现）
    expect(screen.getByTestId('filegen-docstream')).toBeTruthy()
    expect(screen.queryByTestId('filegen-preview-pane')).toBeNull()
    // 操作条三件套（html 才显示"用浏览器打开"——docx 不显示）
    expect(screen.getByText('打开文件')).toBeTruthy()
    expect(screen.getByText('打开文件夹')).toBeTruthy()
    expect(screen.getByText('复制路径')).toBeTruthy()
    expect(screen.queryByText('用浏览器打开')).toBeNull()
  })

  test('md 生成中 Write 写出 → 单栏文档流实时渲染正文', async () => {
    mockSurface = { data: { taskId: 't1', title: '介绍文章', format: 'md', phase: 'writing', label: '正在撰写 a.md…' } }
    render(<FileGenPanel />)
    // 未写出 → 空态
    expect(screen.getByTestId('filegen-docstream-empty')).toBeTruthy()
    // Write 工具调用（md 路径）→ docText 覆盖 → 文档流渲染正文 + 大纲
    act(() => {
      mockSseHandlers['tool_call']?.({
        taskId: 't1', toolName: 'Write',
        toolArgs: { path: 'D:/x/a.md', content: '# 智能体介绍\n\n第一段正文' },
      })
    })
    await waitFor(() => expect(screen.getByText(/第一段正文/)).toBeTruthy())
    // 大纲区提取标题（正文里也有同名标题行——作用域大纲区断言）
    const outline = screen.getByTestId('filegen-docstream-outline')
    expect(within(outline).getByText(/智能体介绍/)).toBeTruthy()
  })

  test('autoDocx 双产物 done → 主文件 docx（单栏文档流）+ 产物清单含 md', () => {
    mockSurface = {
      data: {
        taskId: 't1', title: '介绍文章', format: 'docx', phase: 'done',
        file: { path: 'D:/data/workspace/documents/介绍文章_123.docx', name: '介绍文章_123.docx', size: 20480, format: 'docx', url: null },
        files: [
          { path: 'D:/x/介绍文章.md', name: '介绍文章.md', size: 5120, format: 'md', url: 'local:///x/介绍文章.md' },
          { path: 'D:/data/workspace/documents/介绍文章_123.docx', name: '介绍文章_123.docx', size: 20480, format: 'docx', url: null },
        ],
      },
    }
    render(<FileGenPanel />)
    // 单栏文档流（无右栏文件卡）
    expect(screen.getByTestId('filegen-docstream')).toBeTruthy()
    expect(screen.queryByTestId('filegen-preview-pane')).toBeNull()
    // 产物清单: md + docx, 主文件高亮 docx
    expect(screen.getByTestId('artifact-介绍文章.md')).toBeTruthy()
    expect(screen.getByTestId('artifact-介绍文章_123.docx')).toBeTruthy()
    const mainArtifact = screen.getByTestId('artifact-介绍文章_123.docx')
    expect(mainArtifact.className).toContain('filegen-artifact--main')
  })
})

describe('2026-08-23 资料区（研究阶段 WebSearch 插桩）', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  test('filegen:source → 资料区渲染关键词与来源链接；计数正确', () => {
    mockSurface = { data: { taskId: 't1', title: '演讲稿', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:source']?.({
        taskId: 't1', query: 'OPC 智能体 趋势',
        sources: [
          { title: 'OPC UA 指南', url: 'https://example.com/opc', snippet: '最佳实践' },
          { title: '智能制造 2026', url: 'https://example.com/m2026', snippet: '行业摘要' },
        ],
      })
      mockSseHandlers['filegen:source']?.({
        taskId: 't1', query: '一人公司 商业模式',
        sources: [{ title: '一人公司案例', url: 'https://example.com/solo' }],
      })
    })
    expect(screen.getByTestId('filegen-sources')).toBeTruthy()
    expect(screen.getByText(/3 条来源 · 2 次搜索/)).toBeTruthy()
    expect(screen.getByText('OPC UA 指南')).toBeTruthy()
    expect(screen.getByText('一人公司案例')).toBeTruthy()
    const link = screen.getByText('智能制造 2026')
    expect(link.closest('a')?.getAttribute('href')).toBe('https://example.com/m2026')
  })

  test('资料区折叠：点击头部收起（内容隐藏、计数保留）', () => {
    mockSurface = { data: { taskId: 't1', title: '研究', format: 'md', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:source']?.({
        taskId: 't1', query: 'AIGC 行业', sources: [{ title: '来源A', url: 'https://example.com/a' }],
      })
    })
    expect(screen.getByText('来源A')).toBeTruthy()
    fireEvent.click(screen.getByText(/1 条来源/).closest('button')!)
    expect(screen.queryByText('来源A')).toBeNull()
    // 计数仍可见（头部常驻）
    expect(screen.getByText(/1 条来源/)).toBeTruthy()
  })

  test('新任务 start → 资料区清空（不显示旧任务资料）', () => {
    mockSurface = { data: { taskId: 't1', title: '旧', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:source']?.({
        taskId: 't1', query: '旧任务', sources: [{ title: '旧来源', url: 'https://example.com/old' }],
      })
    })
    expect(screen.getByText('旧来源')).toBeTruthy()
    act(() => { mockSseHandlers['filegen:start']?.({ taskId: 't2', title: '新', format: 'md' }) })
    expect(screen.queryByTestId('filegen-sources')).toBeNull()
    expect(screen.queryByText('旧来源')).toBeNull()
  })

  test('无资料时不渲染资料区', () => {
    mockSurface = { data: { taskId: 't1', title: '介绍', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    expect(screen.queryByTestId('filegen-sources')).toBeNull()
  })

  test('WebSearch tool_call 帧 → 操作日志 + 文档流过程条滚入 🔍 搜索关键词', () => {
    mockSurface = { data: { taskId: 't1', title: '演讲稿', format: 'md', phase: 'collect' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({ toolName: 'WebSearch', toolArgs: { query: '台风 最新动态' } })
    })
    // md → 文档流：logLines 尾 3 行显示在过程条（搜索帧可见）
    const processBar = screen.getByTestId('filegen-docstream-process')
    expect(within(processBar).getByText(/🔍 搜索: 台风 最新动态/)).toBeTruthy()
  })
})

// ─── 2026-08-23 双卡片架构: 操作日志降噪 + 载体感知视图（PPT 页面轨道 /
// EXCEL 表格矩阵 / PDF 转换进度）───
describe('2026-08-23 双卡片 + 载体感知视图', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  test('网页版: thinking/工具调用标题进操作日志（默认收起，展开可见）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['thinking']?.({ content: '正在构思页面结构…' })
      mockSseHandlers['tool_call']?.({ toolName: 'WebSearch', toolArgs: { query: '响应式布局' } })
    })
    // 操作日志存在，默认收起（body 不渲染）；3 条 = thinking 1 + 标题行 1 + 搜索帧 1
    const oplog = screen.getByTestId('filegen-oplog')
    expect(screen.queryByTestId('filegen-oplog-body')).toBeNull()
    expect(within(oplog).getByText(/3 条/)).toBeTruthy()
    // 展开 → thinking 与标题行可见
    fireEvent.click(screen.getByText(/操作日志/).closest('button')!)
    expect(screen.getByText(/正在构思页面结构/)).toBeTruthy()
    expect(screen.getByText(/⟪WebSearch⟫/)).toBeTruthy()
    // 网页版无文档流过程条（降噪后代码流主区不被思考行侵占）
    expect(screen.queryByTestId('filegen-docstream-process')).toBeNull()
  })

  test('pptx → PPT 页面轨道（# 标题拆页，点击缩略卡切换当前页大图）', () => {
    mockSurface = { data: { taskId: 't1', title: '路演', format: 'pptx', phase: 'writing', label: '正在撰写 路演.md…' } }
    render(<FileGenPanel />)
    // Write 写出多页内容（# 标题拆页）
    act(() => {
      mockSseHandlers['tool_call']?.({
        toolName: 'Write',
        toolArgs: { path: '/x/路演.md', content: '# 封面\n\n- 主题：智能体\n\n# 市场分析\n\n- 规模 2800 亿\n- 增速 42%' },
      })
    })
    expect(screen.getByTestId('filegen-slides')).toBeTruthy()
    // 两页缩略卡 + 当前页大图默认第一页
    expect(screen.getByTestId('slide-thumb-0')).toBeTruthy()
    expect(screen.getByTestId('slide-thumb-1')).toBeTruthy()
    const stage = screen.getByTestId('filegen-slide-stage')
    expect(within(stage).getByText(/封面/)).toBeTruthy()
    expect(within(stage).getByText(/主题：智能体/)).toBeTruthy()
    // 点击第 2 页 → 当前页切换
    fireEvent.click(screen.getByTestId('slide-thumb-1'))
    expect(within(screen.getByTestId('filegen-slide-stage')).getByText(/市场分析/)).toBeTruthy()
    expect(within(screen.getByTestId('filegen-slide-stage')).getByText(/2800 亿/)).toBeTruthy()
  })

  test('pptx 未写出内容 → 等待态（不渲染页面轨道）', () => {
    mockSurface = { data: { taskId: 't1', title: '路演', format: 'pptx', phase: 'collect' } }
    render(<FileGenPanel />)
    expect(screen.queryByTestId('filegen-slides')).toBeNull()
    expect(screen.getByText(/正在搜集资料/)).toBeTruthy()
  })

  test('pptx 直出 done 态 → 成品文件卡（不再永显「等待演示文稿内容写出…」）', () => {
    // 2026-08-23 用户实锤: PptxGenerate 直出无 Write 内容, done 后卡片仍显示
    // 「等待演示文稿内容写出…」（DocText 恒空 → parseSlides 无页 → 空态永驻）
    mockSurface = { data: { taskId: 't1', title: '端侧AI', format: 'pptx', phase: 'collect' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:done']?.({
        taskId: 't1',
        file: { path: '/x/端侧AI知识普及.pptx', name: '端侧AI知识普及.pptx', size: 123596, format: 'pptx', url: null },
        files: [{ path: '/x/端侧AI知识普及.pptx', name: '端侧AI知识普及.pptx', size: 123596, format: 'pptx', url: null }],
      })
    })
    expect(screen.getByText('端侧AI知识普及.pptx')).toBeTruthy()
    expect(screen.getByText(/120\.7 KB/)).toBeTruthy()
    expect(screen.queryByText(/等待演示文稿内容写出/)).toBeNull()
  })

  test('pptx 生成中空态显示后端推进 label（「正在组织内容…」）', () => {
    // 2026-08-23: 后端 sourceFileGen 后推进 phase writing + label「正在组织内容…」——
    // 卡片空态必须显示该推进文案, 而非恒显「正在搜集资料…」
    mockSurface = { data: { taskId: 't1', title: '路演', format: 'pptx', phase: 'writing', label: '正在组织内容…' } }
    render(<FileGenPanel />)
    // 阶段徽章 + 主区空态可能各显示一处——断言存在且无「正在搜集资料」
    expect(screen.getAllByText(/正在组织内容/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/正在搜集资料/)).toBeNull()
  })

  test('xlsx → EXCEL 表格矩阵（Gfm 表格提取：表头粗体 + 行数据）', () => {
    mockSurface = { data: { taskId: 't1', title: '数据表', format: 'xlsx', phase: 'writing', label: '正在撰写 数据表.md…' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({
        toolName: 'Write',
        toolArgs: {
          path: '/x/数据表.md',
          content: '| 城市 | 成交额 | 同比 |\n|------|--------|------|\n| 上海 | 812 亿 | +18% |\n| 北京 | 654 亿 | +9%  |',
        },
      })
    })
    expect(screen.getByTestId('filegen-tables')).toBeTruthy()
    const table = screen.getByTestId('table-block-0')
    expect(within(table).getByText('城市')).toBeTruthy()
    expect(within(table).getByText('成交额')).toBeTruthy()
    expect(within(table).getByText('812 亿')).toBeTruthy()
    expect(within(table).getByText('+18%')).toBeTruthy()
    // 表格标题带行列计数
    expect(within(table).getByText(/2 行 × 3 列/)).toBeTruthy()
  })

  test('xlsx 直出 done 态 → 成品文件卡（同 PPT 空态修复）', () => {
    mockSurface = { data: { taskId: 't1', title: '数据表', format: 'xlsx', phase: 'collect' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:done']?.({
        taskId: 't1',
        file: { path: '/x/数据表.xlsx', name: '数据表.xlsx', size: 20480, format: 'xlsx', url: null },
        files: [{ path: '/x/数据表.xlsx', name: '数据表.xlsx', size: 20480, format: 'xlsx', url: null }],
      })
    })
    expect(screen.getByText('数据表.xlsx')).toBeTruthy()
    expect(screen.queryByText(/等待表格内容写出/)).toBeNull()
  })

  test('pdf → converting 转换进度；done 后渲染成品文件卡', () => {
    // converting: 进度占位
    mockSurface = { data: { taskId: 't1', title: '报告', format: 'pdf', phase: 'converting', label: '正在转换为 PDF…' } }
    render(<FileGenPanel />)
    expect(screen.getByTestId('filegen-pdfview')).toBeTruthy()
    expect(screen.getByText(/正在转换 PDF/)).toBeTruthy()
    // done: 文件卡
    act(() => {
      mockSseHandlers['filegen:done']?.({
        taskId: 't1',
        file: { path: '/x/报告.pdf', name: '报告.pdf', size: 102400, format: 'pdf', url: null },
        files: [{ path: '/x/报告.pdf', name: '报告.pdf', size: 102400, format: 'pdf', url: null }],
      })
    })
    expect(screen.getByText('报告.pdf')).toBeTruthy()
    expect(screen.getByText(/100\.0 KB/)).toBeTruthy()
  })

  test('新任务 start → 操作日志清空（不残留旧任务痕迹）', () => {
    mockSurface = { data: { taskId: 't1', title: '旧', format: 'html', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => { mockSseHandlers['thinking']?.({ content: '旧任务思考' }) })
    expect(screen.getByTestId('filegen-oplog')).toBeTruthy()
    act(() => { mockSseHandlers['filegen:start']?.({ taskId: 't2', title: '新', format: 'html' }) })
    expect(screen.queryByTestId('filegen-oplog')).toBeNull()
  })
})

// ─── 2026-08-28 SP-4: 历史产物区（GET /api/doc-artifacts 注册表最近 5 条）───
describe('SP-4 历史产物区', () => {
  // 挂载即拉 /api/doc-artifacts 且 done 后 800ms 延迟再拉——mock 按路径路由
  // （once 队列会被挂载/延迟拉取抢先消费, 且跨测试 stray timer 会串扰）
  beforeEach(() => {
    mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null
    ;(apiGet as any).mockImplementation((p: string) => p?.startsWith('/api/doc-artifacts')
      ? Promise.resolve({ success: true, data: { artifacts: [] } })
      : Promise.resolve({ success: true, data: null }))
  })
  afterEach(() => { delete (window as any).electronAPI })

  const historyArtifacts = [
    { id: 'art_1', path: 'D:/data/workspace/documents/报告_123.docx', name: '报告_123.docx', size: 20480, format: 'docx', url: null, taskId: 't1', createdAt: Date.now() - 60 * 60 * 1000 },
    { id: 'art_2', path: 'D:/data/workspace/documents/行情页.html', name: '行情页.html', size: 5120, format: 'html', url: 'local:///data/workspace/documents/行情页.html', taskId: 't2', createdAt: Date.now() },
  ]
  const idleSurface = { data: { taskId: null, title: '', format: '', phase: 'idle' } }
  const mockArtifacts = (list: any[]) => {
    ;(apiGet as any).mockImplementation((p: string) => p?.startsWith('/api/doc-artifacts')
      ? Promise.resolve({ success: true, data: { artifacts: list } })
      : Promise.resolve({ success: true, data: null }))
  }

  test('挂载拉取 /api/doc-artifacts?limit=50 → 渲染折叠区（名称 + N 条计数；2026-09-06 搜索过滤拉全量）', async () => {
    mockArtifacts(historyArtifacts)
    mockSurface = idleSurface
    render(<FileGenPanel />)
    await waitFor(() => expect(screen.getByTestId('filegen-history')).toBeTruthy())
    expect(apiGet).toHaveBeenCalledWith('/api/doc-artifacts?limit=50')
    expect(screen.getByText(/2 条/)).toBeTruthy()
    expect(screen.getByText('报告_123.docx')).toBeTruthy()
    expect(screen.getByText('行情页.html')).toBeTruthy()
  })

  test('2026-09-06: 搜索框过滤产物名称（无匹配显示空态）', async () => {
    mockArtifacts(historyArtifacts)
    mockSurface = idleSurface
    render(<FileGenPanel />)
    await waitFor(() => expect(screen.getByText('报告_123.docx')).toBeTruthy())
    const input = screen.getByPlaceholderText('搜索产物名称…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '行情' } })
    expect(screen.queryByText('报告_123.docx')).toBeNull()
    expect(screen.getByText('行情页.html')).toBeTruthy()
    fireEvent.change(input, { target: { value: 'zzz不存在' } })
    expect(screen.getByText('无匹配产物')).toBeTruthy()
  })

  test('点击历史产物 → 复用 electronAPI.file.open IPC 打开（不新建协议）', async () => {
    const openSpy = vi.fn(() => Promise.resolve({ success: true }))
    ;(window as any).electronAPI = { file: { open: openSpy } }
    mockArtifacts(historyArtifacts)
    mockSurface = idleSurface
    render(<FileGenPanel />)
    await waitFor(() => expect(screen.getByText('报告_123.docx')).toBeTruthy())
    fireEvent.click(screen.getByText('报告_123.docx'))
    expect(openSpy).toHaveBeenCalledWith('D:/data/workspace/documents/报告_123.docx')
  })

  test('无记录 → 空态提示「暂无记录——生成后自动登记」', async () => {
    mockSurface = idleSurface
    render(<FileGenPanel />)
    await waitFor(() => expect(screen.getByText(/暂无记录——生成后自动登记/)).toBeTruthy())
  })

  test('接口失败 → 不崩溃, 折叠区仍渲染（空态）', async () => {
    ;(apiGet as any).mockImplementation((p: string) => p?.startsWith('/api/doc-artifacts')
      ? Promise.reject(new Error('backend down'))
      : Promise.resolve({ success: true, data: null }))
    mockSurface = idleSurface
    render(<FileGenPanel />)
    await waitFor(() => expect(screen.getByTestId('filegen-history')).toBeTruthy())
    expect(screen.getByText(/暂无记录——生成后自动登记/)).toBeTruthy()
  })
})

// ─── 2026-09-06 状态机 v2 回归：artifact/cancelled/paused/取消/直出回填/后端结构 ───
describe('状态机 v2: artifact/cancelled/paused/取消/直出回填/后端结构', () => {
  beforeEach(() => { mockSurface = null; mockSseHandlers = {}; mockSseOnStatus = null })

  test('filegen:artifact 登记产物但不触发 done（任务保持进行态）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing', label: '正在撰写 index.html…' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:artifact']?.({
        taskId: 't1',
        file: { path: 'D:/x/index.html', name: 'index.html', size: 10, format: 'html', url: null },
        files: [{ path: 'D:/x/index.html', name: 'index.html', size: 10, format: 'html', url: null }],
      })
    })
    // 阶段徽标仍是进行态（非 done/error）
    expect(screen.getByText('撰写中')).toBeTruthy()
    // 产物清单仅在 done 渲染
    expect(screen.queryByText('产物清单')).toBeNull()
  })

  test('filegen:cancelled → 徽标与状态条切已取消', () => {
    mockSurface = { data: { taskId: 't1', title: 'T', format: 'md', phase: 'writing' } }
    render(<FileGenPanel />)
    act(() => { mockSseHandlers['filegen:cancelled']?.({ taskId: 't1' }) })
    expect(screen.getAllByText('已取消').length).toBeGreaterThan(0)
  })

  test('writing 态显示取消按钮 → 点击 POST /api/filegen/cancel', async () => {
    mockSurface = { data: { taskId: 't1', title: 'T', format: 'md', phase: 'writing' } }
    render(<FileGenPanel />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/filegen/cancel', { taskId: 't1' }))
  })

  test('paused 态 → 状态条显示暂停文案 + 放弃任务按钮', () => {
    mockSurface = { data: { taskId: 't1', title: '帮我生成一个网页', format: 'md', phase: 'paused', label: '已暂停 · 等待补充需求信息' } }
    render(<FileGenPanel />)
    expect(screen.getAllByText(/已暂停 · 等待补充需求信息/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '放弃任务' })).toBeTruthy()
    expect(screen.getByText('已暂停')).toBeTruthy() // 徽标
  })

  // 2026-09-06 恢复链路: "继续生成"≠"重新生成"——继续类短消息走后端恢复通道
  //（复活暂停任务/保留资料产物），重发原始请求会开新任务清空残留
  test('paused 态「继续生成」→ 派发 crabpaw:send-message(text=继续)', () => {
    mockSurface = { data: { taskId: 't1', title: '帮我生成一个网页', format: 'md', phase: 'paused', label: '已暂停 · 可继续生成', originalMessage: '帮我生成一个网页' } }
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    render(<FileGenPanel />)
    fireEvent.click(screen.getByRole('button', { name: '继续生成' }))
    const sent = dispatchSpy.mock.calls.map(c => c[0] as CustomEvent).find(e => e.type === 'crabpaw:send-message')
    expect(sent).toBeTruthy()
    expect((sent!.detail as any).text).toBe('继续')
    // 与"重新生成"并存（后者重发原始请求）
    expect(screen.getByRole('button', { name: '重新生成' })).toBeTruthy()
    dispatchSpy.mockRestore()
  })

  test('filegen:doc-structure slides → PPT 轨道渲染后端页面（docText 为空也出页）', () => {
    mockSurface = { data: { taskId: 't1', title: 'PPT', format: 'pptx', phase: 'writing', label: '正在撰写大纲.md…' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['filegen:doc-structure']?.({
        taskId: 't1', kind: 'slides',
        pages: [
          { type: 'title', title: '封面标题', subtitle: '副标题' },
          { type: 'content', title: '页一', bullets: ['要点A', '要点B'] },
        ],
      })
    })
    expect(screen.getByTestId('filegen-slides')).toBeTruthy()
    expect(screen.getAllByText('封面标题').length).toBeGreaterThan(0)
    // 默认选中第 1 页（封面）；点击第 2 页缩略卡 → 内容页要点
    fireEvent.click(screen.getByTestId('slide-thumb-1'))
    expect(screen.getByText('要点A')).toBeTruthy()
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  test('PptxGenerate 直出参数回填 → tool_call 帧后轨道即有页面（直出不再是空转）', () => {
    mockSurface = { data: { taskId: 't1', title: 'PPT', format: 'pptx', phase: 'writing', label: '正在生成 PPT 演示…' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({
        toolName: 'PptxGenerate', toolId: 'x',
        toolArgs: JSON.stringify({ slides: [{ type: 'content', title: '直出页', bullets: ['直出要点'] }] }),
      })
    })
    expect(screen.getAllByText('直出页').length).toBeGreaterThan(0)
    expect(screen.getByText('直出要点')).toBeTruthy()
  })

  test('HtmlGenerate 直出 content → iframe 即时 blob 预览（不等 done）', () => {
    mockSurface = { data: { taskId: 't1', title: '网页', format: 'html', phase: 'writing', label: '正在编写网页…' } }
    render(<FileGenPanel />)
    act(() => {
      mockSseHandlers['tool_call']?.({
        toolName: 'HtmlGenerate', toolId: 'x',
        toolArgs: JSON.stringify({ content: '<html><body>直出页面</body></html>' }),
      })
    })
    const iframe = document.querySelector('iframe.filegen-html-iframe') as HTMLIFrameElement | null
    expect(iframe).toBeTruthy()
    expect(iframe!.getAttribute('src')).toMatch(/^blob:/)
  })
})
