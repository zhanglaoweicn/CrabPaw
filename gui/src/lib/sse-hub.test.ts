/**
 * sse-hub 单连接总线测试(GUI 全量修复 P4, G7)
 *
 * 覆盖: 引用计数(末订阅者关闭连接)、同事件多播(activity/file_generated 双消费者)、
 * 订阅者异常隔离、onStatus 补发(useAgentMonitor wsConnected 语义)、
 * IPC mock(一次 invoke + streamId 过滤)、EventSource mock、重连退避、
 * AG-UI 大写事件名穿透(哑管道)。
 */
import {
  subscribeSse,
  subscribeSseStatus,
  getSseHubActiveGroups,
  resetSseHub,
} from './sse-hub'
import type { Mock } from 'vitest'

// ── 测试基础设施: 模拟 Electron IPC 或 EventSource ──
// jest testEnvironment 为 node——为 sse-hub 提供 window 别名
;(globalThis as any).window = globalThis

// 浏览器路径: hub 动态 import('../lib/api') 取 getApiBaseUrl——mock 掉避免真实网络
vi.mock('./api', () => ({
  getApiBaseUrl: vi.fn(async () => 'http://localhost:38767'),
}))

interface MockIpc {
  sse: Mock
  sseClose: Mock
  sseOnData: Mock
  sseOnEnd: Mock
  sseOnError: Mock
  dataListeners: Array<(msg: { streamId: string; data: string; event?: string }) => void>
  endListeners: Array<(msg: { streamId: string }) => void>
}

function installMockIpc(): MockIpc {
  const mock: MockIpc = {
    sse: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    sseClose: vi.fn(async () => ({ success: true })),
    sseOnData: vi.fn(),
    sseOnEnd: vi.fn(),
    sseOnError: vi.fn(),
    dataListeners: [],
    endListeners: [],
  }
  mock.sseOnData.mockImplementation((cb: any) => { mock.dataListeners.push(cb); return () => { } })
  mock.sseOnEnd.mockImplementation((cb: any) => { mock.endListeners.push(cb); return () => { } })
  mock.sseOnError.mockImplementation(() => () => { })
  ;(window as any).electronAPI = {
    api: {
      sse: mock.sse,
      sseClose: mock.sseClose,
      sseOnData: mock.sseOnData,
      sseOnEnd: mock.sseOnEnd,
      sseOnError: mock.sseOnError,
    },
  }
  return mock
}

function pushIpcData(mock: MockIpc, event: string, data: any, streamId = 'stream-1') {
  for (const cb of mock.dataListeners) cb({ streamId, data: JSON.stringify(data), event })
}

// EventSource mock(浏览器路径)
class MockEventSource {
  static instances: MockEventSource[] = []
  listeners = new Map<string, Set<(e: any) => void>>()
  closed = false
  url: string
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(event: string, fn: any) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
  }
  close() { this.closed = true }
  // 测试辅助
  fire(event: string, data: any) {
    const set = this.listeners.get(event)
    if (set) for (const fn of set) fn({ data: JSON.stringify(data) })
  }
  fireError() {
    if (this.onerror) this.onerror({} as any)
  }
  fireOpen() {
    if (this.onopen) this.onopen()
  }
  onerror: ((e: any) => void) | null = null
  onopen: (() => void) | null = null
}

describe('sse-hub: Electron IPC 路径', () => {
  let mock: MockIpc

  beforeEach(() => {
    resetSseHub()
    mock = installMockIpc()
  })

  test('两个订阅者共享一条连接(api:sse 只 invoke 一次)', async () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const u1 = subscribeSse('/events', 'activity', fn1)
    const u2 = subscribeSse('/events', 'turn_complete', fn2)

    // 等待 connect 的异步 invoke 完成
    await Promise.resolve()
    await Promise.resolve()

    expect(mock.sse).toHaveBeenCalledTimes(1)
    expect(mock.sse).toHaveBeenCalledWith({ endpoint: '/events', since: undefined })

    pushIpcData(mock, 'activity', { summary: 'a1' })
    expect(fn1).toHaveBeenCalledWith({ summary: 'a1' }, undefined)
    expect(fn2).not.toHaveBeenCalled()

    u1()
    u2()
  })

  test('同事件多播: activity 双消费者(useAgentMonitor + TaskPanelHost)都收到', async () => {
    const logFn = vi.fn()
    const storeFn = vi.fn()
    const u1 = subscribeSse('/events', 'activity', logFn)
    const u2 = subscribeSse('/events', 'activity', storeFn)
    await Promise.resolve()
    await Promise.resolve()

    pushIpcData(mock, 'activity', { summary: 'x' })

    expect(logFn).toHaveBeenCalledTimes(1)
    expect(storeFn).toHaveBeenCalledTimes(1)
    u1()
    u2()
  })

  test('引用计数归零 → sseClose 被调(末订阅者关闭连接)', async () => {
    const u1 = subscribeSse('/events', 'activity', vi.fn())
    const u2 = subscribeSse('/events', 'activity', vi.fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(getSseHubActiveGroups()).toBe(1)

    u1()
    expect(mock.sseClose).not.toHaveBeenCalled() // 还有 u2
    u2()
    expect(mock.sseClose).toHaveBeenCalledWith('stream-1')
    expect(getSseHubActiveGroups()).toBe(0)
  })

  test('AG-UI 大写事件名原样穿透(哑管道, 无转换)', async () => {
    const fn = vi.fn()
    const u = subscribeSse('/events', 'RUN_FINISHED', fn)
    await Promise.resolve()
    await Promise.resolve()

    pushIpcData(mock, 'RUN_FINISHED', { outcome: { type: 'success' } })

    expect(fn).toHaveBeenCalledWith({ outcome: { type: 'success' } }, undefined)
    u()
  })

  test('handler 抛错不影响其他订阅者(错误隔离)', async () => {
    const bad = vi.fn(() => { throw new Error('boom') })
    const good = vi.fn()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const u1 = subscribeSse('/events', 'activity', bad)
    const u2 = subscribeSse('/events', 'activity', good)
    await Promise.resolve()
    await Promise.resolve()

    pushIpcData(mock, 'activity', { x: 1 })

    expect(good).toHaveBeenCalledWith({ x: 1 }, undefined)
    expect(bad).toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    u1()
    u2()
  })

  test('JSON 解析失败: 仅告警, 不崩', async () => {
    const fn = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const u = subscribeSse('/events', 'activity', fn)
    await Promise.resolve()
    await Promise.resolve()

    for (const cb of mock.dataListeners) cb({ streamId: 'stream-1', data: 'not-json{{', event: 'activity' })

    expect(fn).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
    u()
  })
})

describe('sse-hub: onStatus 语义(useAgentMonitor wsConnected 依赖)', () => {
  let mock: MockIpc

  beforeEach(() => {
    resetSseHub()
    mock = installMockIpc()
  })

  test('连接 open 后新订阅者立即收到当前状态(补发)', async () => {
    const statuses: string[] = []
    const u1 = subscribeSse('/events', 'activity', vi.fn())
    await Promise.resolve()
    await Promise.resolve()

    const u2 = subscribeSseStatus('/events', (s) => statuses.push(s))
    // 补发: 已有 open 状态
    expect(statuses).toContain('open')
    u1()
    u2()
  })

  test('断线(stream ended) → error 状态 → 退避重连后恢复 open', async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const u = subscribeSse('/events', 'activity', vi.fn())
    const uStatus = subscribeSseStatus('/events', (s) => statuses.push(s))
    await Promise.resolve()
    await Promise.resolve()

    for (const cb of mock.endListeners) cb({ streamId: 'stream-1' })
    expect(statuses).toContain('error')

    // 退避后重连 → 第二次 invoke(新 streamId)
    vi.advanceTimersByTime(2100)
    await Promise.resolve()
    await Promise.resolve()
    expect(mock.sse).toHaveBeenCalledTimes(2)
    expect(statuses).toContain('open')
    vi.useRealTimers()
    u()
    uStatus()
  })
})

describe('sse-hub: 浏览器 EventSource 路径', () => {
  beforeEach(() => {
    resetSseHub()
    // 移除 electronAPI → 走 EventSource 回退
    delete (window as any).electronAPI
    ;(global as any).EventSource = MockEventSource
    MockEventSource.instances = []
  })

  test('单个 EventSource 服务多个事件; 末订阅者关闭', async () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const u1 = subscribeSse('/events', 'scene:change', fn1)
    const u2 = subscribeSse('/events', 'activity', fn2)
    // connectEs 异步(await getApiBaseUrl)——等 EventSource 创建
    await Promise.resolve()
    await Promise.resolve()

    expect(MockEventSource.instances).toHaveLength(1)
    const es = MockEventSource.instances[0]

    es.fire('scene:change', { ops: [] })
    expect(fn1).toHaveBeenCalled()

    u1()
    u2()
    expect(es.closed).toBe(true)
  })

  test('onerror → 退避重连(新 EventSource); onopen → open 状态', async () => {
    vi.useFakeTimers()
    const statuses: string[] = []
    const u = subscribeSse('/events', 'activity', vi.fn())
    const uStatus = subscribeSseStatus('/events', (s) => statuses.push(s))
    await Promise.resolve()
    await Promise.resolve()

    const es1 = MockEventSource.instances[0]
    es1.fireOpen()
    expect(statuses).toContain('open')

    es1.fireError()
    expect(statuses).toContain('error')

    vi.advanceTimersByTime(2100)
    await Promise.resolve()
    await Promise.resolve()
    expect(MockEventSource.instances).toHaveLength(2)
    vi.useRealTimers()
    u()
    uStatus()
  })
})

describe('sse-hub: 恢复/清理', () => {
  test('resetSseHub 清空全部连接', async () => {
    const mock = installMockIpc()
    const u = subscribeSse('/events', 'activity', vi.fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(getSseHubActiveGroups()).toBe(1)

    resetSseHub()
    expect(getSseHubActiveGroups()).toBe(0)
    expect(mock.sseClose).toHaveBeenCalled()
    expect(mock.sseClose).toHaveBeenCalled()
    u()
  })
})
