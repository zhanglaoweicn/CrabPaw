/**
 * tts-prewarm.test.ts — 晨报音频预热的缓存语义回归（2026-09-30，P1-2）
 *
 * 预热的意义只有一个：**老板说"晨报"，音频立刻出声**。所以断言围绕三件事：
 *   1. 命中要真命中（同文本/音色/语速）
 *   2. 不该命中的必须不命中（换音色、调语速、跨天过期）——否则会用旧音色念新稿
 *   3. 预热失败绝不影响任何交互（尽力而为，不抛错、不重试风暴）
 */
import { describe, test, expect, vi } from 'vitest'
import { TtsPrewarmCache, ttsCacheKey, DEFAULT_TTL_MS } from './tts-prewarm'

const AUDIO = { audioBase64: 'AAA', audioFormat: 'mp3' }

function makeCache(opts: Partial<ConstructorParameters<typeof TtsPrewarmCache>[0]> = {}) {
  return new TtsPrewarmCache({
    synthesize: vi.fn(async () => AUDIO),
    ...opts,
  } as ConstructorParameters<typeof TtsPrewarmCache>[0])
}

describe('缓存键：音色与语速必须参与', () => {
  test('同文本不同音色/语速 → 不同键（否则会用旧音色念新配置）', () => {
    expect(ttsCacheKey('早上好', 'A', 1.0)).not.toBe(ttsCacheKey('早上好', 'B', 1.0))
    expect(ttsCacheKey('早上好', 'A', 1.0)).not.toBe(ttsCacheKey('早上好', 'A', 1.3))
    expect(ttsCacheKey('早上好', 'A', 1.0)).toBe(ttsCacheKey('早上好', 'A', 1.0))
  })
})

describe('预热与命中', () => {
  test('预热后立刻可取（这就是"零等待出声"）', async () => {
    const c = makeCache()
    const n = await c.warm(['第一句', '第二句'], 'v1', 1.0)
    expect(n).toBe(2)
    expect(c.get('第一句', 'v1', 1.0)).toEqual(AUDIO)
    expect(c.has('第二句', 'v1', 1.0)).toBe(true)
    expect(c.size).toBe(2)
  })

  test('未预热的文本 → null（调用方据此回落实时合成，不静默播空）', () => {
    const c = makeCache()
    expect(c.get('没预热过', 'v1', 1.0)).toBeNull()
  })

  test('换音色 → 不命中（必须重新合成）', async () => {
    const c = makeCache()
    await c.warm(['早上好'], 'v1', 1.0)
    expect(c.get('早上好', 'v2', 1.0)).toBeNull()
  })

  test('调语速 → 不命中', async () => {
    const c = makeCache()
    await c.warm(['早上好'], 'v1', 1.0)
    expect(c.get('早上好', 'v1', 1.3)).toBeNull()
  })

  test('重复 warm 同一条 → 不重复合成（命中即跳过）', async () => {
    const synth = vi.fn(async () => AUDIO)
    const c = makeCache({ synthesize: synth as never })
    await c.warm(['同一句'], 'v1', 1.0)
    await c.warm(['同一句'], 'v1', 1.0)
    expect(synth).toHaveBeenCalledTimes(1)
  })

  test('并发 warm 同一条 → 复用同一个 in-flight（不产生重复合成）', async () => {
    let resolveIt: (v: typeof AUDIO) => void = () => {}
    const synth = vi.fn(() => new Promise<typeof AUDIO>((res) => { resolveIt = res }))
    const c = makeCache({ synthesize: synth as never })
    const p1 = c.warm(['并发句'], 'v1', 1.0)
    const p2 = c.warm(['并发句'], 'v1', 1.0)
    resolveIt(AUDIO)
    await Promise.all([p1, p2])
    expect(synth).toHaveBeenCalledTimes(1)
  })
})

describe('过期：跨天必须重合成（不能念昨天的数字）', () => {
  test('超过 TTL → 不命中并清理', async () => {
    let t = 1_000
    const c = makeCache({ now: () => t })
    await c.warm(['早上好'], 'v1', 1.0)
    expect(c.has('早上好', 'v1', 1.0)).toBe(true)
    t += DEFAULT_TTL_MS + 1
    expect(c.get('早上好', 'v1', 1.0)).toBeNull()
    expect(c.size).toBe(0)   // 过期即删，不占内存
  })

  test('prune 清掉过期条目、保留新鲜条目', async () => {
    let t = 1_000
    const c = makeCache({ now: () => t })
    await c.warm(['旧的'], 'v1', 1.0)
    t += DEFAULT_TTL_MS + 1
    await c.warm(['新的'], 'v1', 1.0)
    expect(c.prune()).toBe(1)
    expect(c.has('新的', 'v1', 1.0)).toBe(true)
  })
})

describe('尽力而为：预热失败不得影响交互', () => {
  test('单条合成失败 → 跳过该条，其余照常，整体不抛', async () => {
    const synth = vi.fn(async (text: string) => {
      if (text === '坏句') throw new Error('TTS 500')
      return AUDIO
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = makeCache({ synthesize: synth as never })
    await expect(c.warm(['好句', '坏句', '另一句'], 'v1', 1.0)).resolves.toBe(2)
    expect(c.has('好句', 'v1', 1.0)).toBe(true)
    expect(c.has('坏句', 'v1', 1.0)).toBe(false)
    expect(c.has('另一句', 'v1', 1.0)).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('合成返回缺音频的空响应 → 不入缓存（防播空）', async () => {
    const c = makeCache({ synthesize: (async () => ({ audioBase64: '' })) as never })
    await expect(c.warm(['空响应'], 'v1', 1.0)).resolves.toBe(0)
    expect(c.has('空响应', 'v1', 1.0)).toBe(false)
  })

  test('空文本/空数组不触发合成', async () => {
    const synth = vi.fn(async () => AUDIO)
    const c = makeCache({ synthesize: synth as never })
    await c.warm([], 'v1', 1.0)
    await c.warm(['', ''], 'v1', 1.0)
    expect(synth).not.toHaveBeenCalled()
  })

  test('失败一次后再次 warm 会重试（失败不留毒标记）', async () => {
    let fail = true
    const synth = vi.fn(async () => { if (fail) throw new Error('x'); return AUDIO })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = makeCache({ synthesize: synth as never })
    await c.warm(['重试句'], 'v1', 1.0)
    fail = false
    await c.warm(['重试句'], 'v1', 1.0)
    expect(c.has('重试句', 'v1', 1.0)).toBe(true)
    warn.mockRestore()
  })

  test('clear 清空全部（换音色/换日时调用）', async () => {
    const c = makeCache()
    await c.warm(['a', 'b'], 'v1', 1.0)
    c.clear()
    expect(c.size).toBe(0)
    expect(c.get('a', 'v1', 1.0)).toBeNull()
  })
})
