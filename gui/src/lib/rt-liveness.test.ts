/**
 * rt-liveness 单测——实时通道判活（2026-09-25）
 *
 * 核心回归：委托在途的静默不得触发重连（实机台风问答被误杀，看门狗动作比
 * ShowTyphoon 实际执行还早 1.1s，答案被推迟 30s+ 才播）。
 */
import { describe, it, expect } from 'vitest'
import {
  RT_HALFOPEN_MS,
  RT_HALFOPEN_PENDING_MS,
  RT_DELEGATION_MAX_MS,
  RT_MISSED_PONG_LIMIT,
  decideRtReconnect,
  isDelegationPending,
  shouldReplaySpeakText,
  shouldSendPing,
  isPongTimedOut,
} from './rt-liveness'

const T0 = 1_700_000_000_000

describe('decideRtReconnect —— 推断式判活', () => {
  it('从未上行过人声 → 不判死（无判据）', () => {
    expect(decideRtReconnect({
      now: T0, lastLoudSentTs: 0, lastInboundTs: T0 - 999_999, delegationSince: 0, reconnectScheduled: false,
    })).toBeNull()
  })

  it('说完话且下行静默超阈值（无委托）→ 判假死', () => {
    const reason = decideRtReconnect({
      now: T0,
      lastLoudSentTs: T0 - 5000,
      lastInboundTs: T0 - (RT_HALFOPEN_MS + 1000),
      delegationSince: 0,
      reconnectScheduled: false,
    })
    expect(reason).toContain('豆包下行')
  })

  it('【回归】委托在途时，22s 静默不得重连（实机误杀场景）', () => {
    // 实机: 08:52:04.8 委托 → 08:52:26.9 旧看门狗动手(22.1s) → 08:52:28.1 工具才执行
    const delegationSince = T0
    const reason = decideRtReconnect({
      now: T0 + 22_100,
      lastLoudSentTs: T0 - 1000,
      lastInboundTs: T0 - 22_100,
      delegationSince,
      reconnectScheduled: false,
    })
    expect(reason).toBeNull()
  })

  it('委托在途但静默超过长阈值（120s）→ 仍判真死（长兜底）', () => {
    const now = T0 + (RT_HALFOPEN_PENDING_MS + 5000)
    const reason = decideRtReconnect({
      now,
      lastLoudSentTs: now - 5000, // 用户 5s 前还在说（在 60s 认定窗内）
      lastInboundTs: now - (RT_HALFOPEN_PENDING_MS + 5000), // 下行已静默 125s
      delegationSince: T0,
      reconnectScheduled: false,
    })
    expect(reason).toContain('委托在途已超长阈值')
  })

  it('委托标记超时失效（>180s）→ 退回普通阈值，不再豁免', () => {
    const now = T0 + RT_DELEGATION_MAX_MS + 25_000
    const reason = decideRtReconnect({
      now,
      lastLoudSentTs: now - 5000,
      lastInboundTs: now - (RT_HALFOPEN_MS + 1000),
      delegationSince: T0,
      reconnectScheduled: false,
    })
    expect(reason).toContain('用户已说话')
  })

  it('用户还在说（未停口 3s）→ 不判死', () => {
    expect(decideRtReconnect({
      now: T0,
      lastLoudSentTs: T0 - 1000,
      lastInboundTs: T0 - 60_000,
      delegationSince: 0,
      reconnectScheduled: false,
    })).toBeNull()
  })

  it('已有重连在排队 → 不重复触发', () => {
    expect(decideRtReconnect({
      now: T0,
      lastLoudSentTs: T0 - 5000,
      lastInboundTs: T0 - 60_000,
      delegationSince: 0,
      reconnectScheduled: true,
    })).toBeNull()
  })

  it('静默未达阈值 → 不判死（正常思考停顿）', () => {
    expect(decideRtReconnect({
      now: T0,
      lastLoudSentTs: T0 - 5000,
      lastInboundTs: T0 - 8000,
      delegationSince: 0,
      reconnectScheduled: false,
    })).toBeNull()
  })
})

describe('isDelegationPending', () => {
  it('无委托 → false；在途 → true；超时失效 → false', () => {
    expect(isDelegationPending(0, T0)).toBe(false)
    expect(isDelegationPending(T0, T0 + 10_000)).toBe(true)
    expect(isDelegationPending(T0, T0 + RT_DELEGATION_MAX_MS + 1)).toBe(false)
  })
})

describe('shouldReplaySpeakText —— 断线续播去重', () => {
  it('首次重连且未播完 → 续播', () => {
    expect(shouldReplaySpeakText({ everReady: true, text: '台风提醒', done: false, replayedText: '' })).toBe(true)
  })

  it('从未 ready 过（首连）→ 不续播', () => {
    expect(shouldReplaySpeakText({ everReady: false, text: '台风提醒', done: false, replayedText: '' })).toBe(false)
  })

  it('已念完 → 不重念', () => {
    expect(shouldReplaySpeakText({ everReady: true, text: '台风提醒', done: true, replayedText: '' })).toBe(false)
  })

  it('【回归】同一段文本已续播过 → 不再重念（实测被念 3 遍）', () => {
    expect(shouldReplaySpeakText({ everReady: true, text: '明天海口是晴天', done: false, replayedText: '明天海口是晴天' })).toBe(false)
  })

  it('新一段文本 → 允许续播一次', () => {
    expect(shouldReplaySpeakText({ everReady: true, text: '新的回复', done: false, replayedText: '明天海口是晴天' })).toBe(true)
  })
})

describe('心跳判活', () => {
  it('按间隔发心跳', () => {
    expect(shouldSendPing(T0, 0)).toBe(true)
    expect(shouldSendPing(T0, T0 - 1000)).toBe(false)
    expect(shouldSendPing(T0, T0 - 6000)).toBe(true)
  })

  it('没发过心跳（计数为 0）→ 不判超时', () => {
    expect(isPongTimedOut(0)).toBe(false)
    expect(isPongTimedOut(1)).toBe(false)
  })

  it('【核心】连续多个心跳无回包 → 判链路半开（真死连接可被直接探测）', () => {
    expect(isPongTimedOut(RT_MISSED_PONG_LIMIT)).toBe(true)
    expect(isPongTimedOut(RT_MISSED_PONG_LIMIT + 5)).toBe(true)
  })

  it('【回归】回包正常（含正在等主链路长答案）→ 计数被清零, 不判死', () => {
    // 计数语义: 每收到 pong 调用方清零; 这里断言阈值前不误判
    expect(isPongTimedOut(RT_MISSED_PONG_LIMIT - 1)).toBe(false)
  })
})
