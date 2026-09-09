jest.mock('../core/proactive', () => ({
  notify: jest.fn(),
}))

describe('ProactiveSpeak 工具', () => {
  beforeEach(() => {
    // 注：registry 实际 API 无 reset()/remove()（仅 clear()/unregisterBySource()，且
    // register() 重复注册仅 warn 覆盖不抛错）。jest.resetModules() 使每个测试重新
    // 加载 registry → 全新实例，重复注册不可能发生，无需额外清理。
    jest.resetModules()
    jest.clearAllMocks()
  })

  function getTool() {
    require('./proactive-speak-tool')
    return require('./registry').registry.get('ProactiveSpeak')
  }

  test('注册契约完整（PascalCase/schema/whenNotToUse/riskLevel）', () => {
    const tool = getTool()
    expect(tool).toBeDefined()
    expect(tool.name).toBe('ProactiveSpeak')
    expect(tool.schema).toBeDefined()
    expect(tool.schema.required).toContain('text')
    expect(tool.whenNotToUse).toBeTruthy()
    expect(tool.riskLevel).toBe('low')
  })

  test('正常发声 → 调 notify, 返回 broadcast', async () => {
    const { notify } = require('../core/proactive')
    notify.mockReturnValue({ ok: true })
    const tool = getTool()
    const res = await tool.handler({ text: '老板，会议 15 分钟后开始', trigger: 'reminder', intent: 'inform' })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'reminder', text: '老板，会议 15 分钟后开始', intent: 'inform' }))
    expect(res).toEqual({ success: true, state: 'broadcast' })
  })

  test('静默时段 → 返回 queued_silent', async () => {
    const { notify } = require('../core/proactive')
    notify.mockReturnValue({ ok: true, reason: 'silent_hours' })
    const tool = getTool()
    const res = await tool.handler({ text: '夜间提醒', trigger: 'reminder' })
    expect(res).toEqual({ success: true, state: 'queued_silent', reason: 'silent_hours' })
  })

  test('去重/非法 → 返回 suppressed 不抛错', async () => {
    const { notify } = require('../core/proactive')
    notify.mockReturnValue({ ok: false, reason: 'dedup' })
    const tool = getTool()
    const res = await tool.handler({ text: '重复提醒', trigger: 'reminder' })
    expect(res).toEqual({ success: true, state: 'suppressed', reason: 'dedup' })
  })
})
