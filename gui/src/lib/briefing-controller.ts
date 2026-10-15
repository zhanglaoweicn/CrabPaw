/**
 * briefing-controller.ts — 音频优先晨报的装配层（2026-09-30，规格 §4）
 *
 * 职责：把"取数 → 编译 60 秒稿件 → 预热音频 → 逐段播报 → 分句导航"串起来，
 * 并保证**屏幕显示的那一句 === 正在播的那一句**。
 *
 * 为什么单独成层而不是塞进 VoiceShell：
 *   · 屏音同步是"信"的核心，必须可断言；VoiceShell 是 2300 行的组件，逻辑进去就测不动了。
 *   · 依赖全部注入（取数 / 预热缓存 / 播报队列），因此本模块**不依赖 React、不依赖网络**，
 *     可以用假实现完整验证顺序、预热命中、重播、跳段与失败降级。
 *
 * 与播报队列的分工：
 *   · 队列是**播放事实**的唯一来源（谁在播、播到哪）；
 *   · 本控制器是**晨报意图**的唯一来源（稿件内容、段边界、"下一段是什么"）。
 *   两者靠 `SpeechJob.segmentIndex` 对齐——不各自维护一份 position（那会漂移）。
 */

import {
  buildBriefingScript,
  type BriefingInput,
  type BriefingScript,
  type BriefingSegment,
} from './briefing-script'
import type { SpeechJob } from './speech-queue'

/** 播报队列的最小接口（生产传 useSpeechQueue 的返回值；测试传假实现） */
export interface BriefingPlayer {
  enqueue: (job: SpeechJob) => void
  /** 正在播的 job（含 segmentIndex）；空闲为 null */
  currentJob: SpeechJob | null
  isPlaying: boolean
  /**
   * 2026-10-09 跳段支持（可选）：清掉指定前缀的排队 job。
   * next() 用它清掉尚未播的晨报段，避免重入队后与旧排队段重复。
   */
  clearByPrefix?: (prefix: string) => void
  /**
   * 2026-10-09 跳段支持（可选）：立即结束当前段音频并释放播放位。
   * 没有"下一段"的即时性就没有"跳过"——只清排队不动音频的跳段是假的。
   */
  skipCurrent?: () => boolean
}

export interface BriefingControllerDeps {
  /** 取简报数据（生产接 window.electronAPI.api.proxy('/api/briefing/today') 或 fetch） */
  loadBriefing: () => Promise<BriefingInput>
  /** 预热缓存（生产传 TtsPrewarmCache 实例） */
  prewarm: {
    warm: (texts: string[], voice: string, speed: number) => Promise<number>
    get: (text: string, voice: string, speed: number) => { audioBase64: string; audioFormat?: string } | null
  }
  player: BriefingPlayer
  /** 当前音色/语速（预热键的一部分，变了必须重新预热） */
  voice: () => string
  speed: () => number
  now?: () => number
}

/** 一天之内稿件有效；跨天必须重取重编（否则会念昨天的数字） */
export const SCRIPT_TTL_MS = 12 * 60 * 60 * 1000

/** 段序号放在 id 里便于排查（`briefing-<n>`），与 segmentIndex 双写互为校验 */
export function briefingJobId(index: number, date: string): string {
  return `briefing-${date}-${index}`
}

export class BriefingController {
  private readonly deps: BriefingControllerDeps
  private script: BriefingScript | null = null
  private preparedAt = 0
  private preparing: Promise<BriefingScript | null> | null = null
  private jobIds: string[] = []

  constructor(deps: BriefingControllerDeps) {
    this.deps = deps
  }

  private get now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /** 已就绪的稿件（未准备/已过期 → null） */
  get ready(): boolean {
    return !!this.script && this.now - this.preparedAt <= SCRIPT_TTL_MS
  }

  getScript(): BriefingScript | null {
    if (!this.ready) return null
    return this.script
  }

  /**
   * 取数 + 编译 + 预热（幂等；并发调用复用同一个准备过程）。
   * 失败不抛：取数失败时用空输入编译——稿件会**如实说"取数失败"**，
   * 而不是静默不播（不说话比说错更让人以为系统坏了）。
   */
  async prepare(): Promise<BriefingScript | null> {
    if (this.ready) return this.script
    if (this.preparing) return this.preparing
    this.preparing = (async () => {
      let input: BriefingInput
      try {
        input = await this.deps.loadBriefing()
      } catch (e) {
        console.warn('[briefing] 取数失败，用诚实降级稿:', (e as Error)?.message || e)
        input = { sources: { snapshot: { ok: false }, receivables: { ok: false }, contracts: { ok: false } } }
      }
      const script = buildBriefingScript(input)
      this.script = script
      this.preparedAt = this.now
      // 预热：命中则"说晨报立刻出声"；失败只是回到实时合成，不影响正确性
      try {
        const n = await this.deps.prewarm.warm(script.segments.map(s => s.text), this.deps.voice(), this.deps.speed())
        console.log(`[briefing] 音频预热 ${n}/${script.segments.length} 段`)
      } catch (e) {
        console.warn('[briefing] 预热失败（回落实时合成）:', (e as Error)?.message || e)
      }
      return script
    })().finally(() => { this.preparing = null })
    return this.preparing
  }

  /**
   * 开始播报：按段依次入队，命中预热则自带音频（队列直接播，免合成往返）。
   * @returns 入队段数（0 表示无稿可播）
   */
  async start(): Promise<number> {
    const script = await this.prepare()
    if (!script || script.segments.length === 0) return 0
    const voice = this.deps.voice()
    const speed = this.deps.speed()
    this.jobIds = script.segments.map((_seg, i) => briefingJobId(i, script.date || 'today'))
    script.segments.forEach((seg, index) => {
      const audio = this.deps.prewarm.get(seg.text, voice, speed)
      this.deps.player.enqueue({
        id: this.jobIds[index],
        text: seg.text,
        kind: 'briefing',
        segmentIndex: index,
        ...(audio?.audioBase64 ? { audio: { audioBase64: audio.audioBase64, audioFormat: audio.audioFormat } } : {}),
      })
    })
    return script.segments.length
  }

  /** 正在播的段序号（从播放事实推导；没在播晨报则为 null） */
  currentIndex(): number | null {
    const job = this.deps.player.currentJob
    if (!job || job.kind !== 'briefing' || job.segmentIndex == null) return null
    return job.segmentIndex
  }

  /**
   * 屏幕该显示的那一句 —— 与音频严格同源（都读 currentJob.segmentIndex）。
   * 没在播晨报时返回 null，调用方据此隐藏卡片（不显示"上一句"冒充当前句）。
   */
  currentSegment(): BriefingSegment | null {
    const idx = this.currentIndex()
    const script = this.getScript()
    if (idx == null || !script) return null
    return script.segments[idx] ?? null
  }

  /**
   * "再说一遍"：只重播**上一句**。
   *
   * 为什么不用队列的 replayLast：队列里存的是"最后播完的 job"，而晨报需要的是
   * "上一段"——两者在跳段/打断场景下会不一致。这里直接从稿件取段重新入队，
   * 语义清晰（上一句 = 当前段 - 1），且预热音频一并带上。
   */
  replayLast(): boolean {
    const script = this.getScript()
    if (!script) return false
    const cur = this.currentIndex()
    // 正在播第 n 段 → 重播第 n-1 段；没在播 → 重播最后一段（老板通常刚听完才说"再说一遍"）
    const target = cur == null ? script.segments.length - 1 : Math.max(0, cur - 1)
    const seg = script.segments[target]
    if (!seg) return false
    const voice = this.deps.voice()
    const speed = this.deps.speed()
    const audio = this.deps.prewarm.get(seg.text, voice, speed)
    this.deps.player.enqueue({
      id: `${briefingJobId(target, script.date || 'today')}#replay-${this.now}`,
      text: seg.text,
      kind: 'briefing',
      segmentIndex: target,
      ...(audio?.audioBase64 ? { audio: { audioBase64: audio.audioBase64, audioFormat: audio.audioFormat } } : {}),
    })
    return true
  }

  /**
   * "下一条/跳过这段"：跳过当前段，从下一段续播到结尾。
   *
   * 2026-10-09 补齐（此前只有 replayLast，BriefingVoiceHandler.next 缺实现，
   * "第二条"命令永不生效）。语义三件事：
   *   ① 清掉尚未播的晨报排队段（防重入队后重复）；
   *   ② 立即结束当前段音频（注入了 skipCurrent 才做——旧队列自然播完才轮转）；
   *   ③ 从目标段起把剩余段重新入队（带预热音频，segmentIndex 不变 → 屏音同步不破）。
   * 没在播晨报时视作"从头播"（不动其他来源的播报音频）。
   * @returns 是否成功排上目标段（已到最后一段/无稿 → false）
   */
  next(): boolean {
    const script = this.getScript()
    if (!script) return false
    const cur = this.currentIndex()
    const target = cur == null ? 0 : cur + 1
    const seg = script.segments[target]
    if (!seg) return false
    const voice = this.deps.voice()
    const speed = this.deps.speed()
    this.deps.player.clearByPrefix?.('briefing-')
    if (cur != null) this.deps.player.skipCurrent?.()
    for (let i = target; i < script.segments.length; i++) {
      const s = script.segments[i]
      const audio = this.deps.prewarm.get(s.text, voice, speed)
      this.deps.player.enqueue({
        id: `${briefingJobId(i, script.date || 'today')}#next-${this.now}-${i}`,
        text: s.text,
        kind: 'briefing',
        segmentIndex: i,
        ...(audio?.audioBase64 ? { audio: { audioBase64: audio.audioBase64, audioFormat: audio.audioFormat } } : {}),
      })
    }
    return true
  }

  /** 跨天/换音色后强制重编重热 */
  invalidate(): void {
    this.script = null
    this.preparedAt = 0
    this.jobIds = []
  }
}
