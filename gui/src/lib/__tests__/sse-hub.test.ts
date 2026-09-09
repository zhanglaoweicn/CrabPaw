/**
 * @jest-environment jsdom
 */
import { subscribeSse, subscribeSseStatus, resetSseHub } from '../sse-hub'
import type { Mock } from 'vitest'

// sse-hub 依赖 window.electronAPI 与 getApiBaseUrl——测试只走 EventSource 路径
vi.mock('../api', () => ({
  getApiBaseUrl: vi.fn(() => Promise.resolve('http://localhost:38767')),
}))

// EventSource mock(浏览器路径)——jsdom 无 EventSource 实现
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  listeners = new Map<string, Set<(e: any) => void>>()
  closed = false
  onerror: ((e: any) => void) | null = null
  onopen: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }
  addEventListener(event: string, fn: any) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(fn)
  }
  close() { this.closed = true }
  // 测试辅助: 触发一帧, 可带 lastEventId(即服务端 id: <seq> 行)
  fire(event: string, data: any, lastEventId?: string) {
    const set = this.listeners.get(event)
    if (set) for (const fn of set) fn({ data: JSON.stringify(data), lastEventId })
  }
  fireError() {
    if (this.onerror) this.onerror({} as any)
  }
}

// Electron IPC mock(主进程代连路径)
interface MockIpc {
  sse: Mock
  sseClose: Mock
  sseOnData: Mock
  sseOnEnd: Mock
  sseOnError: Mock
  dataListeners: Array<(msg: { streamId: string; data: string; event?: string; seq?: number }) => void>
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

describe('sse-hub seq 捕获/去重', () => {
  beforeEach(() => {
    resetSseHub()
    MockEventSource.instances = []
    ;(globalThis as any).EventSource = MockEventSource
    delete (window as any).electronAPI
  })

  test('handler 收到第二参 seq(来自 lastEventId)', () => {
    // 契约用例: Handler 第二参(seq)可选——现有订阅者 (data) => ... 零改动
    const calls: Array<[string, any]> = []
    const unsub = subscribeSse('/events', 'x', (data, seq) => calls.push([data, seq]))
    expect(typeof unsub).toBe('function')
    unsub()
  })

  describe('EventSource 路径', () => {
    test('e.lastEventId 作为第二参 seq 透传 handler', async () => {
      const fn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      // connectEs 异步(await getApiBaseUrl)——等 EventSource 创建
      await Promise.resolve()
      await Promise.resolve()

      const es = MockEventSource.instances[0]
      es.fire('x', { hello: 1 }, '7')

      expect(fn).toHaveBeenCalledWith({ hello: 1 }, 7)
      u()
    })

    test('seq 去重: 小于等于 lastSeq 的帧丢弃, 无 seq 帧照常送达', async () => {
      const fn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      await Promise.resolve()
      await Promise.resolve()

      const es = MockEventSource.instances[0]
      es.fire('x', { n: 5 }, '5')      // 首帧 seq 5 → 送达
      es.fire('x', { n: 'dup' }, '5')  // 重复 seq → 丢弃(重放帧)
      es.fire('x', { n: 3 }, '3')      // 落后 seq → 丢弃
      es.fire('x', { n: 6 }, '6')      // 新 seq → 送达
      es.fire('x', { n: 0 })           // 无 seq → 照常送达(seq 为 undefined)

      expect(fn).toHaveBeenCalledTimes(3)
      expect(fn).toHaveBeenNthCalledWith(1, { n: 5 }, 5)
      expect(fn).toHaveBeenNthCalledWith(2, { n: 6 }, 6)
      expect(fn).toHaveBeenNthCalledWith(3, { n: 0 }, undefined)
      u()
    })

    test('断线重连自动携带 since(EventSource URL); 重放交界帧去重', async () => {
      vi.useFakeTimers()
      const fn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      await Promise.resolve()
      await Promise.resolve()

      const es1 = MockEventSource.instances[0]
      expect(es1.url).toBe('http://localhost:38767/events') // 首连不带 since
      es1.fire('x', { n: 7 }, '7')
      es1.fireError()

      // 退避 2000ms 后重连
      vi.advanceTimersByTime(2100)
      await Promise.resolve()
      await Promise.resolve()

      expect(MockEventSource.instances).toHaveLength(2)
      const es2 = MockEventSource.instances[1]
      expect(es2.url).toBe('http://localhost:38767/events?since=7')

      // 重放帧与直播帧交界: seq<=lastSeq 丢弃, 新帧继续
      es2.fire('x', { n: 7 }, '7')
      expect(fn).toHaveBeenCalledTimes(1)
      es2.fire('x', { n: 8 }, '8')
      expect(fn).toHaveBeenCalledTimes(2)
      expect(fn).toHaveBeenLastCalledWith({ n: 8 }, 8)
      u()
      vi.useRealTimers()
    })

    test('connected 对账: 服务端 seq 低于 lastSeq → lastSeq 归零(重启黑障修复)', async () => {
      const fn = vi.fn()
      const conn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      const uc = subscribeSse('/events', 'connected', conn)
      await Promise.resolve()
      await Promise.resolve()

      const es = MockEventSource.instances[0]
      // 直播推进 lastSeq 到 300(后端重启前)
      es.fire('x', { n: 300 }, '300')
      expect(fn).toHaveBeenCalledTimes(1)

      // 后端重启: connected 帧 seq=5 < 300 → lastSeq 归零(connected 监听者仍收到帧)
      es.fire('connected', { type: 'connected', seq: 5 })
      expect(conn).toHaveBeenCalledTimes(1)
      expect(conn.mock.calls[0][0]).toEqual({ type: 'connected', seq: 5 })
      // 重启后新帧 seq 6 必须送达(否则静默黑障)
      es.fire('x', { n: 6 }, '6')
      expect(fn).toHaveBeenCalledTimes(2)
      expect(fn).toHaveBeenLastCalledWith({ n: 6 }, 6)
      u()
      uc()
    })

    test('connected 对账: 服务端 seq >= lastSeq 不重置(正常去重不受影响)', async () => {
      const fn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      const uc = subscribeSse('/events', 'connected', vi.fn())
      await Promise.resolve()
      await Promise.resolve()

      const es = MockEventSource.instances[0]
      // 直播推进 lastSeq 到 350(350 > 后续重放帧 301, 保证去重前提成立)
      es.fire('x', { n: 350 }, '350')
      expect(fn).toHaveBeenCalledTimes(1)

      // connected seq=400 >= lastSeq=350 → 不重置
      es.fire('connected', { type: 'connected', seq: 400 })
      // seq 301 <= 350 → 仍按去重丢弃(未重置的旧 lastSeq 依然有效)
      es.fire('x', { n: 301 }, '301')
      expect(fn).toHaveBeenCalledTimes(1)
      u()
      uc()
    })
  })

  describe('Electron IPC 路径', () => {
    let mock: MockIpc

    beforeEach(() => {
      mock = installMockIpc()
    })

    test('sseOnData 帧的 seq 字段透传 handler 第二参', async () => {
      const fn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      await Promise.resolve()
      await Promise.resolve()

      expect(mock.sse).toHaveBeenCalledWith({ endpoint: '/events', since: undefined })

      for (const cb of mock.dataListeners) {
        cb({ streamId: 'stream-1', data: JSON.stringify({ a: 1 }), event: 'x', seq: 3 })
      }
      expect(fn).toHaveBeenCalledWith({ a: 1 }, 3)
      u()
    })

    test('重连自动携带 since(IPC 参数); 重放交界帧去重', async () => {
      vi.useFakeTimers()
      const fn = vi.fn()
      const u = subscribeSse('/events', 'x', fn)
      await Promise.resolve()
      await Promise.resolve()

      for (const cb of mock.dataListeners) {
        cb({ streamId: 'stream-1', data: JSON.stringify({ a: 1 }), event: 'x', seq: 3 })
      }
      // sse:end → 退避重连
      for (const cb of mock.endListeners) cb({ streamId: 'stream-1' })
      vi.advanceTimersByTime(2100)
      await Promise.resolve()
      await Promise.resolve()

      expect(mock.sse).toHaveBeenCalledTimes(2)
      expect(mock.sse).toHaveBeenLastCalledWith({ endpoint: '/events', since: 3 })

      // 重放交界帧(seq<=lastSeq)丢弃, 新帧送达
      for (const cb of mock.dataListeners) {
        cb({ streamId: 'stream-1', data: JSON.stringify({ a: 3 }), event: 'x', seq: 3 })
      }
      expect(fn).toHaveBeenCalledTimes(1)
      for (const cb of mock.dataListeners) {
        cb({ streamId: 'stream-1', data: JSON.stringify({ a: 4 }), event: 'x', seq: 4 })
      }
      expect(fn).toHaveBeenCalledTimes(2)
      u()
      vi.useRealTimers()
    })

    test('api.sse 同步抛异常: 不向调用方抛出, 走退避重试而非楔死 group', () => {
      // Task 6 前 preload validateString 对非 string 同步抛异常——防御性捕获
      vi.useFakeTimers()
      mock.sse.mockImplementation(() => {
        throw new Error('validateString: 参数必须为 string')
      })

      const status = vi.fn()
      const unsubStatus = subscribeSseStatus('/events', status)
      const fn = vi.fn()
      // 同步抛异常不得传播到调用方
      expect(() => subscribeSse('/events', 'x', fn)).not.toThrow()

      // 状态监听器收到 error 状态(retry/delay 信息)——scheduleRetry 补发
      expect(status).toHaveBeenCalledWith('error', expect.objectContaining({ retry: 1, delay: 2000 }))

      // 未楔死: connecting 已复位, 退避定时器触发第二次连接尝试
      vi.advanceTimersByTime(2100)
      expect(mock.sse).toHaveBeenCalledTimes(2)
      expect(status).toHaveBeenCalledWith('error', expect.objectContaining({ retry: 2, delay: 4000 }))

      unsubStatus()
      vi.useRealTimers()
    })
  })
})
