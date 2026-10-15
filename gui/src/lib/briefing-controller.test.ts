/**
 * briefing-controller.test.ts — 音频优先晨报装配层回归（2026-09-30，P1-2）
 *
 * 锁三件事（都是"信"的组成部分）：
 *   1. **屏音同步**：屏幕显示的那一句必须来自正在播的 job，不能用别的状态源
 *   2. **预热命中**：预热过的段入队时自带音频（否则"零等待"是空话）
 *   3. **降级不装死**：取数失败要出一份如实说"取数失败"的稿子并照播，
 *      而不是静默不播（不说话比说错更让人以为系统坏了）
 */
import { describe, test, expect, vi } from 'vitest'
import { BriefingController, briefingJobId, SCRIPT_TTL_MS } from './briefing-controller'
import type { SpeechJob } from './speech-queue'
import type { BriefingInput } from './briefing-script'

const FULL: BriefingInput = {
  date: '2026-09-30',
  snapshot: {
    revenue: { month: 571000, prevMonth: 500000, yesterday: 30000, deltaPct: 14.2 },
    risks: { receivableOverdue: 1, totalReceivable: 128000, contractsExpiring: 0 },
  },
  receivables: { count: 1, amount: 128000, items: [{ customer: '华辰机械', amount: 128000, overdueDays: 45 }] },
  contracts: { count: 0, items: [] },
  sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: true } },
}

/** 假播放队列：enqueue 记录入队，escalate/currentJob 由测试直接摆布 */
function makePlayer() {
  const jobs: SpeechJob[] = []
  const player = {
    jobs,
    currentJob: null as SpeechJob | null,
    isPlaying: false,
    enqueue: vi.fn((job: SpeechJob) => { jobs.push(job) }),
    /** 测试助手：模拟"某段开始播" */
    play(index: number) {
      const job = jobs.find(j => j.segmentIndex === index) ?? null
      player.currentJob = job
      player.isPlaying = !!job
    },
    idle() { player.currentJob = null; player.isPlaying = false },
  }
  return player
}

function makePrewarm(opts: { warmOk?: boolean; hit?: boolean } = {}) {
  const warmCalls: string[][] = []
  return {
    warmCalls,
    warm: vi.fn(async (texts: string[]) => {
      warmCalls.push(texts)
      if (opts.warmOk === false) throw new Error('TTS 挂了')
      return opts.hit === false ? 0 : texts.length
    }),
    get: vi.fn((text: string) =>
      opts.hit === false ? null : { audioBase64: `PRE:${text.slice(0, 2)}`, audioFormat: 'mp3' }),
  }
}

function makeController(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const deps = makeDeps(over)
  return { ctl: new BriefingController(deps), deps }
}

function makeDeps(over: {
  loadOk?: boolean
  warmOk?: boolean
  prewarmHit?: boolean
  voice?: string
  speed?: number
  now?: () => number
} = {}) {
  const player = makePlayer()
  const prewarm = makePrewarm({ warmOk: over.warmOk, hit: over.prewarmHit })
  return {
    player,
    prewarm,
    loadBriefing: vi.fn(async () => { if (over.loadOk === false) throw new Error('db missing'); return FULL }),
    voice: () => over.voice ?? 'zh-CN-XiaoxiaoNeural',
    speed: () => over.speed ?? 1.0,
    now: over.now,
  }
}

describe('prepare：取数 → 编译 → 预热', () => {
  test('准备后稿件就绪，四段', async () => {
    const { ctl } = makeController()
    const s = await ctl.prepare()
    expect(s?.segments.map(x => x.kind)).toEqual(['headline', 'numbers', 'risk', 'closing'])
    expect(ctl.ready).toBe(true)
  })

  test('预热用稿件原文，且每段都预热（否则"零等待"不成立）', async () => {
    const { ctl, deps } = makeController()
    const s = await ctl.prepare()
    const warmed = deps.prewarm.warmCalls[0]
    expect(warmed).toEqual(s!.segments.map(x => x.text))
  })

  test('重复 prepare 不重复取数（幂等）', async () => {
    const { ctl, deps } = makeController()
    await ctl.prepare()
    await ctl.prepare()
    expect(deps.loadBriefing).toHaveBeenCalledTimes(1)
  })

  test('并发 prepare 复用同一次准备（不产生两次取数）', async () => {
    const { ctl, deps } = makeController()
    await Promise.all([ctl.prepare(), ctl.prepare(), ctl.prepare()])
    expect(deps.loadBriefing).toHaveBeenCalledTimes(1)
  })

  test('跨天/超时后不再算就绪（不能念昨天的数字）', async () => {
    let t = 1_000
    const { ctl } = makeController({ now: () => t })
    await ctl.prepare()
    expect(ctl.ready).toBe(true)
    t += SCRIPT_TTL_MS + 1
    expect(ctl.ready).toBe(false)
    expect(ctl.getScript()).toBeNull()
  })

  test('invalidate 强制重编（换音色/跨天时调用）', async () => {
    const { ctl, deps } = makeController()
    await ctl.prepare()
    ctl.invalidate()
    await ctl.prepare()
    expect(deps.loadBriefing).toHaveBeenCalledTimes(2)
  })
})

describe('start：逐段入队，命中预热则自带音频', () => {
  test('入队四段，序号 0..3，音频来自预热', async () => {
    const { ctl, deps } = makeController()
    const n = await ctl.start()
    expect(n).toBe(4)
    expect(deps.player.enqueue).toHaveBeenCalledTimes(4)
    const jobs = deps.player.jobs
    expect(jobs.map(j => j.segmentIndex)).toEqual([0, 1, 2, 3])
    expect(jobs.map(j => j.kind)).toEqual(['briefing', 'briefing', 'briefing', 'briefing'])
    for (const j of jobs) {
      expect(j.audio?.audioBase64).toMatch(/^PRE:/)
    }
  })

  test('job id 含日期与序号（便于排查串段）', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    expect(deps.player.jobs[0].id).toBe(briefingJobId(0, '2026-09-30'))
  })

  test('预热未命中 → 不带音频入队（队列回落实时合成，语义正确）', async () => {
    const { ctl, deps } = makeController({ prewarmHit: false })
    await ctl.start()
    for (const j of deps.player.jobs) expect(j.audio).toBeUndefined()
  })

  test('预热抛错不影响播报（回落实时合成）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctl, deps } = makeController({ warmOk: false })
    const n = await ctl.start()
    expect(n).toBe(4)
    expect(deps.player.jobs).toHaveLength(4)
    warn.mockRestore()
  })
})

describe('屏音同步：屏幕显示 = 正在播的那一句', () => {
  test('currentSegment 跟随 currentJob 的 segmentIndex', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.play(0)
    expect(ctl.currentSegment()?.kind).toBe('headline')
    deps.player.play(2)
    expect(ctl.currentSegment()?.kind).toBe('risk')
    deps.player.play(3)
    expect(ctl.currentSegment()?.kind).toBe('closing')
  })

  test('没在播晨报（空闲/播别的）→ null，不拿"上一句"冒充当前句', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.play(1)
    expect(ctl.currentSegment()).not.toBeNull()
    deps.player.idle()
    expect(ctl.currentSegment()).toBeNull()
    // 正在播非晨报 job → 也不显示晨报段
    deps.player.currentJob = { id: 'x', text: '别的播报', kind: 'panel' }
    expect(ctl.currentSegment()).toBeNull()
  })

  test('currentSegment 文本与入队文本逐字相同（不允许屏幕另写一套）', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.play(2)
    const shown = ctl.currentSegment()
    const playing = deps.player.currentJob
    expect(shown?.text).toBe(playing?.text)
  })

  test('前言不搭后语防护：稿件未准备时不返回任何段', () => {
    const { ctl, deps } = makeController()
    deps.player.currentJob = { id: 'briefing-x-0', text: 't', kind: 'briefing', segmentIndex: 0 }
    expect(ctl.currentSegment()).toBeNull()
  })
})

describe('"再说一遍"：只重播上一句', () => {
  test('正在播第 3 段 → 重播第 2 段（不是第一段，也不是整篇）', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.play(2)
    expect(ctl.replayLast()).toBe(true)
    const last = deps.player.jobs[deps.player.jobs.length - 1]
    expect(last.segmentIndex).toBe(1)
    expect(last.id).toContain('#replay-')
  })

  test('正在播第 1 段 → 重播第 1 段本身（没有更早的了）', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.play(0)
    ctl.replayLast()
    expect(deps.player.jobs[deps.player.jobs.length - 1].segmentIndex).toBe(0)
  })

  test('没在播（刚播完）→ 重播最后一段', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.idle()
    ctl.replayLast()
    expect(deps.player.jobs[deps.player.jobs.length - 1].segmentIndex).toBe(3)
  })

  test('重播段也带预热音频（否则"再说一遍"又要等合成）', async () => {
    const { ctl, deps } = makeController()
    await ctl.start()
    deps.player.play(2)
    ctl.replayLast()
    const last = deps.player.jobs[deps.player.jobs.length - 1]
    expect(last.audio?.audioBase64).toMatch(/^PRE:/)
  })

  test('稿件未就绪 → 返回 false（调用方可据此提示而不是静默无反应）', () => {
    const { ctl } = makeController()
    expect(ctl.replayLast()).toBe(false)
  })
})

describe('降级不装死：取数失败也要说话', () => {
  test('取数抛错 → 仍出一份如实说"取数失败"的稿子并照播', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctl, deps } = makeController({ loadOk: false })
    const n = await ctl.start()
    expect(n).toBe(4)
    const all = deps.player.jobs.map(j => j.text).join('')
    expect(all).toContain('取数失败')
    expect(all).toContain('重试')
    warn.mockRestore()
  })

  test('取数失败也不得念出假数字（不能把 null 说成 0）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctl, deps } = makeController({ loadOk: false })
    await ctl.start()
    const all = deps.player.jobs.map(j => j.text).join('')
    expect(all).not.toContain('0 笔逾期')
    expect(all).not.toContain('没有逾期')
    warn.mockRestore()
  })
})

describe('音色/语速变化', () => {
  test('预热键随音色变化（换音色必须重新预热，否则用旧音色念新配置）', async () => {
    const { ctl, deps } = makeController({ voice: 'voice-B' })
    await ctl.prepare()
    // prewarm.warm 收到的是 voice() 的当前值
    expect(deps.prewarm.warm).toHaveBeenCalledWith(expect.any(Array), 'voice-B', 1.0)
  })

  test('入队时按当前音色取预热音频（键一致才命中）', async () => {
    const { ctl, deps } = makeController({ voice: 'voice-B', speed: 1.3 })
    await ctl.start()
    expect(deps.prewarm.get).toHaveBeenCalledWith(expect.any(String), 'voice-B', 1.3)
  })
})
