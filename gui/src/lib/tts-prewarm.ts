/**
 * tts-prewarm.ts — 晨报音频预热（"说晨报就立刻出声"）
 *
 * 问题（规格 §4.1）：现有播报链路是"先合成、再播放"——`useSpeechQueue` 播放前
 * 才 POST /api/voice/tts 等 base64 回来。晨报四段合计约 55 秒语音，首段合成往返
 * 通常 1–3 秒，老板在车里说完"晨报"却要干等，体验断在第一秒。
 *
 * 做法：启动后（以及每天首次）在后台把当天晨报的四段音频**预合成**并缓存在内存，
 * 老板开口时直接播放，无需等待合成。
 *
 * 设计取舍：
 *   · **只缓存在内存**，不写 localStorage/IndexedDB。理由：单段 base64 可达数百 KB，
 *     四段轻易超过 localStorage 的 5MB 配额；而 U 盘上的磁盘配额更该留给业务数据。
 *     代价是重启后需重新预热——可接受，因为预热本就发生在启动后空闲时段。
 *   · 预热是**尽力而为**：失败不重试、不报错、不阻塞任何交互（见 warm() 的语义）。
 *   · 缓存键包含文本+音色+语速：换音色或调语速必须重新合成，否则会"用旧音色念新稿"。
 */

export interface TtsAudio {
  audioBase64: string
  audioFormat?: string
}

/** 一条预热条目 */
export interface PrewarmEntry {
  key: string
  audio: TtsAudio
  /** 生成时刻，用于过期判断 */
  createdAt: number
}

/** 缓存键：同一句话在不同音色/语速下必须是不同条目 */
export function ttsCacheKey(text: string, voice: string, speed: number): string {
  return `${voice}|${speed}|${text}`
}

/** 默认存活 12 小时——晨报每天更新，跨天必须重合成，避免念昨天的数字 */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

export interface PrewarmCacheOptions {
  ttlMs?: number
  /** 注入时钟，便于测试 */
  now?: () => number
  /** 实际合成函数（生产接 /api/voice/tts；测试注入假实现） */
  synthesize: (text: string, voice: string, speed: number) => Promise<TtsAudio | null>
}

export class TtsPrewarmCache {
  private entries = new Map<string, PrewarmEntry>()
  private inflight = new Map<string, Promise<TtsAudio | null>>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly synthesize: PrewarmCacheOptions['synthesize']

  constructor(opts: PrewarmCacheOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts.now ?? (() => Date.now())
    this.synthesize = opts.synthesize
  }

  /** 取已预热的音频；未预热、已过期、或音色/语速变了 → null */
  get(text: string, voice: string, speed: number): TtsAudio | null {
    const entry = this.entries.get(ttsCacheKey(text, voice, speed))
    if (!entry) return null
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(entry.key)
      return null
    }
    return entry.audio
  }

  has(text: string, voice: string, speed: number): boolean {
    return this.get(text, voice, speed) !== null
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * 预热一批文本。**尽力而为**：
   *   · 单条失败 → 跳过该条，不影响其他条，也不抛错（预热失败不该打断任何交互）
   *   · 同一 key 并发预热 → 复用同一个 in-flight Promise（防重复合成）
   * @returns 成功预热的条数
   */
  async warm(texts: string[], voice: string, speed: number): Promise<number> {
    let ok = 0
    await Promise.all(texts.map(async (text) => {
      if (!text) return
      if (this.has(text, voice, speed)) { ok++; return }
      const key = ttsCacheKey(text, voice, speed)
      let p = this.inflight.get(key)
      if (!p) {
        p = this.synthesize(text, voice, speed)
          .catch((e) => {
            console.warn('[tts-prewarm] 单条预热失败(跳过):', e?.message || e)
            return null
          })
          .finally(() => { this.inflight.delete(key) })
        this.inflight.set(key, p)
      }
      const audio = await p
      if (audio?.audioBase64) {
        this.entries.set(key, { key, audio, createdAt: this.now() })
        ok++
      }
    }))
    return ok
  }

  /** 清空（换音色/语速或跨天时调用） */
  clear(): void {
    this.entries.clear()
  }

  /** 清理过期条目（长期挂着的会话定期调用，防内存缓慢增长） */
  prune(): number {
    const t = this.now()
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (t - entry.createdAt > this.ttlMs) { this.entries.delete(key); removed++ }
    }
    return removed
  }
}
