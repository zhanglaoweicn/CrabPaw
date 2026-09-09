import { TaskPanelStore, resolveTaskPanelCommand } from './task-panel-store'

describe('resolveTaskPanelCommand（task_panel 语音显隐判定，问题 #1/#2 修复）', () => {
  test('打开：有进行中任务卡 → 可打开', () => {
    expect(resolveTaskPanelCommand('open', 2)).toBe(true)
  })

  test('打开：无任务卡 → 不可打开（触发"当前没有进行中的任务面板"播报）', () => {
    expect(resolveTaskPanelCommand('open', 0)).toBe(false)
  })

  test('关闭：无论有无卡均可关闭', () => {
    expect(resolveTaskPanelCommand('close', 0)).toBe(true)
    expect(resolveTaskPanelCommand('close', 3)).toBe(true)
  })
})

describe('TaskPanelStore 聚合规则', () => {
  test('tool_call + tool_result 按 roundId 聚合为一块面板', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: '读取文档', ts: 1 })
    store.ingest({ type: 'tool_result', roundId: 'r1', toolName: 'Read', status: 'success', summary: '读取完成', ts: 2 })
    const panels = store.getPanels()
    expect(panels).toHaveLength(1)
    expect(panels[0].id).toBe('r1')
    expect(panels[0].toolHistory).toHaveLength(2)
    expect(panels[0].status).toBe('running') // 有成功结果但任务未声明完成
  })

  test('无 roundId 的 tool_call 归入 default 面板', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', toolName: 'WebSearch', summary: '搜索', ts: 1 })
    expect(store.getPanels()[0].id).toBe('default')
  })

  test('thinking 事件更新面板 currentAction(G10: toPanelEvent thinking case 链路)', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'thinking', roundId: 'r1', summary: '正在分析问题…', ts: 1 })
    const panel = store.getPanels()[0]
    expect(panel.id).toBe('r1')
    expect(panel.currentAction).toBe('正在分析问题…')
  })

  test('workflow 步骤推进 progress', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'workflow_start', flowId: 'f1', name: '生成看板', steps: ['解析表格', '生成代码', '打开浏览器'], ts: 1 })
    store.ingest({ type: 'workflow_step', flowId: 'f1', stepId: 's1', name: '解析表格', status: 'done', ts: 2 })
    const panel = store.getPanels()[0]
    expect(panel.progress).toBe(33)
    expect(panel.currentAction).toBe('生成代码')
  })

  test('R12: 工具链任务(tool_result)推进 progress——不再恒 0%', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: '读取', ts: 1 })
    store.ingest({ type: 'tool_result', roundId: 'r1', toolName: 'Read', status: 'success', summary: '完成', ts: 2 })
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'WebSearch', summary: '搜索', ts: 3 })
    const panel = store.getPanels()[0]
    expect(panel.progress).toBeGreaterThan(0) // 有工具完成 → 进度推进
    expect(panel.toolHistory.length).toBe(3)
  })

  // 2026-08-29 Task 8: activity 的 tool_preparing/tool_executing 归一为 tool_call 后,
  // 同一工具会连发两条 running tool_call——去重合并(原地更新),防止工具链出现永久 ◌ 重复行。
  test('Task 8: 同工具连续 running tool_call 原地更新(不重复入栈)', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Bash', summary: 'Bash: cmd, path', ts: 1 })
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Bash', summary: '执行: Bash', ts: 2 })
    store.ingest({ type: 'tool_result', roundId: 'r1', toolName: 'Bash', status: 'success', summary: '完成', ts: 3 })
    const panel = store.getPanels()[0]
    expect(panel.toolHistory).toHaveLength(2) // 一条 running(被 executing 刷新) + 一条 done
    expect(panel.toolHistory[0].summary).toBe('执行: Bash')
    expect(panel.toolHistory[0].ts).toBe(2)
  })

  test('Task 8: 不同工具交替的 tool_call 各自入栈(去重不误伤)', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: '读取', ts: 1 })
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'WebSearch', summary: '搜索', ts: 2 })
    const panel = store.getPanels()[0]
    expect(panel.toolHistory).toHaveLength(2)
  })

  test('workflow_complete → status success', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'workflow_start', flowId: 'f1', name: '生成看板', steps: ['a'], ts: 1 })
    store.ingest({ type: 'workflow_complete', flowId: 'f1', ts: 2 })
    expect(store.getPanels()[0].status).toBe('success')
  })

  test('wecom_doc 创建文档分析面板', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'wecom_doc', title: '收到文档', fileName: '报表.xlsx', ts: 1 })
    const panel = store.getPanels()[0]
    expect(panel.title).toContain('文档')
    expect(panel.currentAction).toContain('报表.xlsx')
  })

  test('panel_cancel 标记 cancelled', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: 'x', ts: 1 })
    store.ingest({ type: 'panel_cancel', id: 'r1', ts: 2 })
    expect(store.getPanels()[0].status).toBe('cancelled')
  })

  test('onUpdate 回调触发', () => {
    const updates: number[] = []
    const store = new TaskPanelStore({ onUpdate: (p) => updates.push(p.length) })
    store.ingest({ type: 'tool_call', toolName: 'Read', summary: 'x', ts: 1 })
    store.ingest({ type: 'tool_result', toolName: 'Read', status: 'success', summary: 'y', ts: 2 })
    expect(updates).toEqual([1, 1])
  })

  test('reset() 通知 onUpdate（空数组）', () => {
    const updates: number[] = []
    const store = new TaskPanelStore({ onUpdate: (p) => updates.push(p.length) })
    store.ingest({ type: 'tool_call', toolName: 'Read', summary: 'x', ts: 1 })
    expect(updates).toEqual([1])
    store.reset()
    expect(updates).toEqual([1, 0])
  })
})

describe('setLastUserMessage(P1-5 重试链路)', () => {
  test('running 面板写入 lastUserMessage', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: 'x', ts: 1 })
    store.setLastUserMessage('r1', '帮我读一下这个文件')
    expect(store.getPanels()[0].lastUserMessage).toBe('帮我读一下这个文件')
  })

  test('非 running 面板忽略写入', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: 'x', ts: 1 })
    store.ingest({ type: 'tool_result', roundId: 'r1', toolName: 'Read', status: 'error', summary: 'boom', ts: 2 })
    store.setLastUserMessage('r1', '不会写入')
    expect(store.getPanels()[0].lastUserMessage).toBeUndefined()
  })

  test('未知面板忽略写入', () => {
    const store = new TaskPanelStore()
    store.setLastUserMessage('nope', 'x')
    expect(store.getPanels()).toHaveLength(0)
  })
})

describe('run 终态事件(P2-2)', () => {
  test('run_finished 置 roundId 面板 success+100%', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r1', toolName: 'Read', summary: 'x', ts: 1 })
    store.ingest({ type: 'run_finished', roundId: 'r1', ts: 2 })
    const panel = store.getPanels()[0]
    expect(panel.status).toBe('success')
    expect(panel.progress).toBe(100)
  })

  test('run_error 置 roundId 面板 error', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r2', toolName: 'Read', summary: 'x', ts: 1 })
    store.ingest({ type: 'run_error', roundId: 'r2', error: 'boom', ts: 2 })
    expect(store.getPanels()[0].status).toBe('error')
  })

  test('run_interrupted 置 roundId 面板 cancelled', () => {
    const store = new TaskPanelStore()
    store.ingest({ type: 'tool_call', roundId: 'r3', toolName: 'Read', summary: 'x', ts: 1 })
    store.ingest({ type: 'run_interrupted', roundId: 'r3', ts: 2 })
    expect(store.getPanels()[0].status).toBe('cancelled')
  })

  test('无工具调用轮次(无面板)时 run 终态跳过不报错', () => {
    const store = new TaskPanelStore()
    expect(() => {
      store.ingest({ type: 'run_finished', roundId: 'no-panel', ts: 1 })
    }).not.toThrow()
    expect(store.getPanels()).toHaveLength(0)
  })
})
