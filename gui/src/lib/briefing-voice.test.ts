/**
 * briefing-voice.test.ts — 晨报语音指令回归（2026-09-30，P1-2）
 *
 * 三条语音指令的口语覆盖面与**未接线时的体面拒绝**是本用例重点。
 * 特别是 /继续/ /上一句/ 这类泛说法：晨报没接线时必须放行给模型，
 * 否则会把正常对话指令吞掉（"继续"最常用于让 AI 接着说）。
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  registerBriefingVoiceCommands,
  BRIEFING_COMMANDS,
  BRIEFING_PATTERNS,
  NOT_READY_HINT,
  getBriefingHandler,
  type BriefingVoiceHandler,
} from './briefing-voice'
import { interceptLocalVoiceCommand, listVoiceCommands } from './voiceCommands'

/** 匹配辅助：直接测模式（不依赖注册表状态） */
const hits = (patterns: RegExp[], text: string) => patterns.some(p => p.test(text))
const norm = (s: string) => s.trim().toLowerCase()

function setHandler(h: BriefingVoiceHandler | null) {
  ;(window as unknown as { __crabpawBriefing?: BriefingVoiceHandler | null }).__crabpawBriefing = h
}

function makeHandler(over: Partial<BriefingVoiceHandler> = {}): BriefingVoiceHandler {
  return {
    start: vi.fn(() => 4),
    replayLast: vi.fn(() => true),
    next: vi.fn(() => true),
    ...over,
  }
}

describe('"晨报"：口语变体覆盖 + 不误伤闲聊', () => {
  test('覆盖常见说法', () => {
    for (const t of ['晨报', '听晨报', '念一下晨报', '今天的晨报', '说一下今天的晨报', '开始听晨报', '今日简报', '听简报']) {
      expect(hits(BRIEFING_PATTERNS.play, norm(t))).toBe(true)
    }
  })

  test('不误伤提到"晨报"两字的闲聊', () => {
    for (const t of ['我今天看了晨报', '晨报是谁写的', '帮我写个晨报模板并保存到文件']) {
      expect(hits(BRIEFING_PATTERNS.play, norm(t))).toBe(false)
    }
  })
})

describe('"再说一遍" / "第二条"：只认真正想重播或跳段的说法', () => {
  test('重播说法', () => {
    for (const t of ['再说一遍', '再说一次', '再念一遍', '重复一遍', '重复', '上一句', '刚才那句再说一遍']) {
      expect(hits(BRIEFING_PATTERNS.replay, norm(t))).toBe(true)
    }
  })

  test('跳段说法', () => {
    for (const t of ['下一条', '下一句', '下一段', '第二条', '第2条', '跳过', '跳过这条', '继续']) {
      expect(hits(BRIEFING_PATTERNS.next, norm(t))).toBe(true)
    }
  })

  test('普通长句不命中（避免把正常对话当命令）', () => {
    for (const t of ['再说一遍那个合同金额是多少', '把第二条建议改成明天', '继续帮我分析下这个表']) {
      expect(hits(BRIEFING_PATTERNS.replay, norm(t))).toBe(false)
      expect(hits(BRIEFING_PATTERNS.next, norm(t))).toBe(false)
    }
  })
})

describe('守卫：未接线时绝不吞掉对话指令', () => {
  /** 清掉可能已注册的晨报命令，保证每条用例都从"未注册"开始 */
  const dropBriefingCommands = () => {
    const list = listVoiceCommands() as unknown as Array<{ id: string }>
    for (const id of Object.values(BRIEFING_COMMANDS)) {
      const idx = list.findIndex(c => c.id === id)
      if (idx >= 0) list.splice(idx, 1)
    }
  }
  beforeEach(() => {
    setHandler(null)
    dropBriefingCommands()
  })
  afterEach(() => { setHandler(null) })

  test('注册成功（幂等接口存在）', () => {
    expect(registerBriefingVoiceCommands()).toBe(3)
  })

  test('未接线时"继续"不被晨报拦截（必须放行给模型）', () => {
    registerBriefingVoiceCommands()
    setHandler(null)
    expect(interceptLocalVoiceCommand('继续')).toBe(false)
  })

  test('未接线时"上一句"不被拦截', () => {
    registerBriefingVoiceCommands()
    setHandler(null)
    expect(interceptLocalVoiceCommand('上一句')).toBe(false)
  })

  test('未接线时"晨报"也不拦截（避免看起来命中了却毫无反应）', () => {
    registerBriefingVoiceCommands()
    setHandler(null)
    expect(interceptLocalVoiceCommand('晨报')).toBe(false)
  })
})

describe('接线后：命令真的调到控制器', () => {
  beforeEach(() => {
    const list = listVoiceCommands() as unknown as Array<{ id: string }>
    for (const id of Object.values(BRIEFING_COMMANDS)) {
      const idx = list.findIndex(c => c.id === id)
      if (idx >= 0) list.splice(idx, 1)
    }
    registerBriefingVoiceCommands()
  })
  afterEach(() => { setHandler(null) })

  test('"晨报" → start()', () => {
    const h = makeHandler()
    setHandler(h)
    expect(interceptLocalVoiceCommand('晨报')).toBe(true)
    expect(h.start).toHaveBeenCalledTimes(1)
  })

  test('"再说一遍" → replayLast()（不是重播整篇）', () => {
    const h = makeHandler()
    setHandler(h)
    interceptLocalVoiceCommand('再说一遍')
    expect(h.replayLast).toHaveBeenCalledTimes(1)
    expect(h.start).not.toHaveBeenCalled()
  })

  test('"下一段" → next()', () => {
    const h = makeHandler()
    setHandler(h)
    interceptLocalVoiceCommand('下一段')
    expect(h.next).toHaveBeenCalledTimes(1)
  })

  test('start 抛错不冒泡（语音链路不能被一个播报失败打断）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setHandler(makeHandler({ start: () => { throw new Error('TTS 挂了') } }))
    expect(() => interceptLocalVoiceCommand('晨报')).not.toThrow()
    warn.mockRestore()
  })

  test('start 返回 0（无稿可播）→ 记日志而不是静默', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setHandler(makeHandler({ start: () => 0 }))
    interceptLocalVoiceCommand('晨报')
    // 异步 then 分支，等一个微任务
    return Promise.resolve().then(() => {
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  test('replayLast 返回 false → 记日志（调用方能据此提示）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setHandler(makeHandler({ replayLast: () => false }))
    interceptLocalVoiceCommand('再说一遍')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('句柄读取的健壮性', () => {
  test('空/残缺句柄视为未接线', () => {
    ;(window as unknown as { __crabpawBriefing?: unknown }).__crabpawBriefing = {}
    expect(getBriefingHandler()).toBeNull()
    ;(window as unknown as { __crabpawBriefing?: unknown }).__crabpawBriefing = undefined
    expect(getBriefingHandler()).toBeNull()
  })

  test('提示文案是单一来源（UI 与日志共用，避免两套说法）', () => {
    expect(NOT_READY_HINT.length).toBeGreaterThan(0)
    expect(NOT_READY_HINT).toContain('晨报')
  })
})
