jest.mock('../sse-broadcast', () => ({
  broadcastEvent: jest.fn(),
}))

describe('proactive 规则通道 v1', () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
  })

  test('白天规则命中 → 发声 (broadcastEvent 收到 proactive_speak)', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    const { init, notify } = require('./index')
    const { broadcastEvent } = require('../sse-broadcast')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    const res = notify({ trigger: 'reminder', text: '老板，会议将在 15 分钟后开始' })
    expect(res.ok).toBe(true)
    expect(broadcastEvent).toHaveBeenCalledWith('proactive_speak', expect.objectContaining({
      trigger: 'reminder',
      text: '老板，会议将在 15 分钟后开始',
      intent: 'inform',
    }))
    jest.useRealTimers()
  })

  test('静默时段 → 不发声, 入补播队列', () => {
    // 模拟 23:00（jest.useFakeTimers + setSystemTime）
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T23:00:00+08:00'))
    const { init, notify, getQueue } = require('./index')
    const { broadcastEvent } = require('../sse-broadcast')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    const res = notify({ trigger: 'reminder', text: '会议提醒' })
    expect(res.ok).toBe(true)
    expect(res.reason).toBe('silent_hours')
    expect(broadcastEvent).not.toHaveBeenCalledWith('proactive_speak', expect.anything())
    expect(getQueue()).toHaveLength(1)
    jest.useRealTimers()
  })

  test('同一事件 30 分钟去重', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    const { init, notify } = require('./index')
    const { broadcastEvent } = require('../sse-broadcast')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    notify({ trigger: 'reminder', text: '重复提醒' })
    const res2 = notify({ trigger: 'reminder', text: '重复提醒' })
    expect(res2.ok).toBe(false)
    expect(res2.reason).toBe('dedup')
    expect(broadcastEvent).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  test('confront 意图透传', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    const { init, notify } = require('./index')
    const { broadcastEvent } = require('../sse-broadcast')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    notify({ trigger: 'task', text: '重要任务到期', intent: 'confront' })
    expect(broadcastEvent).toHaveBeenCalledWith('proactive_speak', expect.objectContaining({ intent: 'confront' }))
    jest.useRealTimers()
  })

  test('补播队列可冲刷', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T23:00:00+08:00'))
    const { init, notify, getQueue, flushQueue } = require('./index')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    notify({ trigger: 'reminder', text: '夜间提醒' })
    const flushed = flushQueue()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].text).toBe('夜间提醒')
    expect(getQueue()).toHaveLength(0)
    jest.useRealTimers()
  })

  test('dedupCache 超阈值(>500)自动清理过期项', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    const { init, notify, getCacheSize } = require('./index')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    // 写入 501 个唯一键（同一时刻 → 无过期项，容量保留）
    for (let i = 0; i < 501; i++) notify({ trigger: `t${i}`, text: `第${i}条` })
    expect(getCacheSize()).toBe(501)
    // 时间推进到 40 分钟后 → 全部过期，下一次 notify 触发清理
    jest.setSystemTime(new Date('2026-08-01T10:40:00+08:00'))
    notify({ trigger: 'fresh', text: '新消息' })
    expect(getCacheSize()).toBe(1) // 过期清理后仅 fresh 一条
    jest.useRealTimers()
  })

  test('补播队列上限 50，超出丢最旧', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T23:00:00+08:00'))
    const { init, notify, getQueue } = require('./index')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    for (let i = 0; i < 60; i++) notify({ trigger: `q${i}`, text: `队列第${i}条` })
    const q = getQueue()
    expect(q).toHaveLength(50)
    expect(q[0].text).toBe('队列第10条') // 最旧的 10 条被丢弃
    jest.useRealTimers()
  })

  test('flushAndBroadcast 冲刷队列并重新广播', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T23:00:00+08:00'))
    const { init, notify, flushAndBroadcast, getQueue } = require('./index')
    const { broadcastEvent } = require('../sse-broadcast')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    notify({ trigger: 'reminder', text: '夜间提醒A' })
    notify({ trigger: 'reminder', text: '夜间提醒B' })
    const n = flushAndBroadcast()
    expect(n).toBe(2)
    expect(getQueue()).toHaveLength(0)
    expect(broadcastEvent).toHaveBeenCalledTimes(2)
    expect(broadcastEvent).toHaveBeenCalledWith('proactive_speak', expect.objectContaining({ text: '夜间提醒A' }))
    jest.useRealTimers()
  })

  test('isSilentHour 跨零点判断', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] })
    const { init, isSilentHour } = require('./index')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    jest.setSystemTime(new Date('2026-08-01T23:00:00+08:00'))
    expect(isSilentHour()).toBe(true)
    jest.setSystemTime(new Date('2026-08-01T07:00:00+08:00'))
    expect(isSilentHour()).toBe(true)
    jest.setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    expect(isSilentHour()).toBe(false)
    jest.useRealTimers()
  })

  test('silentStart === silentEnd 静默禁用，白天 notify 直接广播', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    const { init, notify } = require('./index')
    const { broadcastEvent } = require('../sse-broadcast')
    init({ silentStart: 8, silentEnd: 8, dedupMs: 1800000 })
    const res = notify({ trigger: 'reminder', text: '白天通知' })
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(broadcastEvent).toHaveBeenCalledWith('proactive_speak', expect.objectContaining({ text: '白天通知' }))
    jest.useRealTimers()
  })

  test('notify() 无参数返回 invalid_request', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] }).setSystemTime(new Date('2026-08-01T10:00:00+08:00'))
    const { init, notify } = require('./index')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    const res = notify()
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('invalid_request')
    jest.useRealTimers()
  })

  test('isSilentHour 边界 08:00 精确 (07:59 true / 08:00 false)', () => {
    jest.useFakeTimers({ doNotFake: ['nextTick'] })
    const { init, isSilentHour } = require('./index')
    init({ silentStart: 22, silentEnd: 8, dedupMs: 1800000 })
    jest.setSystemTime(new Date('2026-08-01T07:59:00+08:00'))
    expect(isSilentHour()).toBe(true)
    jest.setSystemTime(new Date('2026-08-01T08:00:00+08:00'))
    expect(isSilentHour()).toBe(false)
    jest.useRealTimers()
  })
})
