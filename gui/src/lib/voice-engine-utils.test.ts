import {
  trimSentenceQueue,
  computeAgcGain,
  ensureAudioContextRunning,
  MAX_TTS_QUEUE_DEPTH,
  TTS_DUCK_VOLUME,
  duckVolumeFor,
  applyDuckVolume,
} from './voice-engine-utils'

describe('trimSentenceQueue (F2 播放队列丢新保新)', () => {
  test('队列超限时丢弃队尾新句', () => {
    // MAX_TTS_QUEUE_DEPTH=50(2026-08-07 由 3 放宽)；55 项 → 丢 5 队尾，保留前 50 项
    const q = Array.from({ length: 55 }, (_, i) => `s${i + 1}`)
    const { dropped } = trimSentenceQueue(q, MAX_TTS_QUEUE_DEPTH)
    expect(dropped).toBe(5)
    expect(q.length).toBe(50)
    expect(q[0]).toBe('s1')
    expect(q[49]).toBe('s50')
  })

  test('队列未超限时不动', () => {
    const q = ['s1', 's2']
    const { dropped } = trimSentenceQueue(q, MAX_TTS_QUEUE_DEPTH)
    expect(dropped).toBe(0)
    expect(q).toEqual(['s1', 's2'])
  })

  test('空队列安全', () => {
    const q: string[] = []
    const { dropped } = trimSentenceQueue(q, MAX_TTS_QUEUE_DEPTH)
    expect(dropped).toBe(0)
    expect(q).toEqual([])
  })

  test('maxDepth=0 时全部丢弃', () => {
    const q = ['s1']
    const { dropped } = trimSentenceQueue(q, 0)
    expect(dropped).toBe(1)
    expect(q).toEqual([])
  })
})

describe('computeAgcGain (F5 自适应增益防噪放大)', () => {
  test('低音量区(弱麦)增益被限制在 maxGain 内', () => {
    // 极弱麦 rms=0.0018(<语音阈值) → 目标增益 0.06/0.0018≈33 → clamp 到 8
    const g = computeAgcGain(0.0018, 1, 0.06, 8)
    expect(g).toBeGreaterThanOrEqual(1)
    expect(g).toBeLessThanOrEqual(8)
  })

  test('语音帧冻结增益（说话中恒定，防句尾爬升切字）', () => {
    // rms=0.05 是语音帧 → 增益保持 3 不变
    expect(computeAgcGain(0.05, 3, 0.06, 8)).toBe(3)
    // 手机强信号 rms=0.5 且增益=1(已收敛) → 保持 1
    expect(computeAgcGain(0.5, 1, 0.06, 8)).toBe(1)
  })

  test('强信号+高增益缓慢回落（防削顶饱和）', () => {
    // rms=0.5 ≥ 0.1 且 gain=4 > 1.2 → ×0.95 缓慢回落
    expect(computeAgcGain(0.5, 4, 0.06, 8)).toBeCloseTo(3.8, 5)
  })

  test('静音帧不更新增益', () => {
    const before = 3
    const g = computeAgcGain(0.0001, before, 0.06, 8)
    expect(g).toBe(before)
  })

  test('低音量区指数平滑收敛且不超上限（弱麦可放大到位）', () => {
    let g = 1
    for (let i = 0; i < 20; i++) g = computeAgcGain(0.003, g, 0.06, 8)
    expect(g).toBeGreaterThan(4)
    expect(g).toBeLessThanOrEqual(8)
  })
})

describe('ensureAudioContextRunning (F4 resume 重试)', () => {
  test('已 running 立即返回 true', async () => {
    const ctx = { state: 'running', resume: async () => {} }
    await expect(ensureAudioContextRunning(ctx)).resolves.toBe(true)
  })

  test('resume 被拒绝后重试成功', async () => {
    let attempts = 0
    const ctx = {
      state: 'suspended' as string,
      resume: async () => {
        attempts++
        if (attempts < 3) throw new Error('NotAllowedError')
        ctx.state = 'running'
      },
    }
    await expect(ensureAudioContextRunning(ctx, 5, 1)).resolves.toBe(true)
    expect(attempts).toBe(3)
  })

  test('重试耗尽返回 false（调用方应上报可见错误）', async () => {
    const ctx = {
      state: 'suspended',
      resume: async () => { throw new Error('NotAllowedError') },
    }
    await expect(ensureAudioContextRunning(ctx, 3, 1)).resolves.toBe(false)
  })
})

describe('duckVolumeFor / applyDuckVolume (2026-08-08 音量忽大忽小修复)', () => {
  // vitest jsdom 存在 requestAnimationFrame → 摘除走同步降级分支（用例意图即「无 rAF 环境降级」）
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', undefined) })
  afterEach(() => { vi.unstubAllGlobals() })

  test('ducked → 0.35（非旧 0.15——85% 削减听感跳变剧烈）', () => {
    expect(duckVolumeFor(true)).toBe(TTS_DUCK_VOLUME)
    expect(TTS_DUCK_VOLUME).toBeGreaterThan(0.15)
    expect(TTS_DUCK_VOLUME).toBeLessThan(1)
  })

  test('未 duck → 1.0', () => {
    expect(duckVolumeFor(false)).toBe(1)
  })

  test('applyDuckVolume 立即设值（无 rAF 环境降级）', () => {
    // jsdom 无 requestAnimationFrame → 走同步降级
    const audio = { volume: 1, paused: false } as unknown as HTMLAudioElement
    applyDuckVolume(audio, true)
    expect(audio.volume).toBe(TTS_DUCK_VOLUME)
  })

  test('applyDuckVolume 目标已到位时不变更', () => {
    const audio = { volume: TTS_DUCK_VOLUME, paused: false } as unknown as HTMLAudioElement
    applyDuckVolume(audio, true)
    expect(audio.volume).toBe(TTS_DUCK_VOLUME)
  })
})
import { shouldBackpressure } from './voice-engine-utils'

describe('shouldBackpressure（客户端背压门控）', () => {
  it('high 级别直接背压', () => {
    expect(shouldBackpressure('high', 0)).toBe(true)
  })
  it('ok 级别但 bufferedAmount 超阈值背压', () => {
    expect(shouldBackpressure('ok', 64 * 1024 + 1)).toBe(true)
  })
  it('ok 级别低缓冲不背压', () => {
    expect(shouldBackpressure('ok', 1024)).toBe(false)
  })
})

describe('trimSentenceQueue 丢新保新 (2026-08-12)', () => {
  it('超限丢弃队尾(最新句),保留队头语义顺序', () => {
    const q = ['a', 'b', 'c']
    const { dropped } = trimSentenceQueue(q, 2)
    expect(dropped).toBe(1)
    expect(q).toEqual(['a', 'b'])
  })
  it('50 段上限(失控保护)', () => {
    const q = Array.from({ length: MAX_TTS_QUEUE_DEPTH + 5 }, (_, i) => `s${i}`)
    const { dropped } = trimSentenceQueue(q, MAX_TTS_QUEUE_DEPTH)
    expect(dropped).toBe(5)
    expect(q[0]).toBe('s0') // 队头从未被丢弃
    expect(q.length).toBe(MAX_TTS_QUEUE_DEPTH)
  })
  it('不超限不裁剪', () => {
    const q = ['a', 'b']
    expect(trimSentenceQueue(q, 2).dropped).toBe(0)
  })
})
