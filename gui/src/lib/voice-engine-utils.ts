/**
 * voice-engine-utils — 语音引擎纯函数工具（可单测）
 *
 * 从 useVoiceSession / useVoiceReply 抽取的确定性逻辑，使修复可独立验证：
 *   - trimSentenceQueue           TTS 播放队列速率控制（丢新保新）
 *   - computeAgcGain              自适应增益计算（防噪声放大淹没语音）
 *   - ensureAudioContextRunning   AudioContext 启动（含失败重试）
 */

// ── F2: TTS 播放队列速率控制 ────────────────────────────
/** 播放队列最大深度——超过即丢队尾（最新句），保住已排入的语义顺序 */
// 2026-08-07: 3→50——原深度 3 导致长回复"挑着播"(LLM 流式产出远超 TTS 语速,
// 队列超 3 段即丢队头,几百字回复只播尾部 3 句)。50 段仅作失控上限(约 2-4 分钟
// 播报量),正常回复远达不到;最终回复(markDone)完全不裁剪。
export const MAX_TTS_QUEUE_DEPTH = 50

export interface TrimSentenceQueueResult {
  dropped: number
}

/**
 * 将播放队列裁剪到 maxDepth 以内（丢新保新）。
 * 原地修改 queue。返回丢弃的段数。
 *
 * 背景：LLM 流式产出（15-60 字/秒）远超 TTS 语速（约 4-6 字/秒），
 * 播放队列会以约 10 倍速度拉长，语音落后文字且越拖越长。
 * 超限丢弃最新的段(队尾),保住队头语义顺序。调用方负责告警与计数。
 */
export function trimSentenceQueue(queue: string[], maxDepth: number): TrimSentenceQueueResult {
  let dropped = 0
  // 2026-08-12: 丢旧保新 → 丢新保新——极端失控时丢弃最新未播句,
  // 保住已排入的语义顺序(语音直追最新导致"跳过内容"的体验更糟)
  while (queue.length > maxDepth) {
    queue.pop()
    dropped++
  }
  return { dropped }
}

// ── TTS duck 音量（2026-08-08,音量忽大忽小修复）── ──────
/**
 * duck 时的目标音量。旧值 0.15(85% 削减)太极端,句间 1.0↔0.15 硬跳变即"忽大忽小"。
 * 0.35 足够"让出舞台"又不至于听起来像损坏。
 */
export const TTS_DUCK_VOLUME = 0.35
/** duck 平滑过渡时长（ms）——硬跳变 → 120ms ease-out */
export const TTS_DUCK_RAMP_MS = 120

/** 目标音量纯函数（可单测）：ducked ? TTS_DUCK_VOLUME : 1 */
export function duckVolumeFor(ducked: boolean): number {
  return ducked ? TTS_DUCK_VOLUME : 1
}

/**
 * 将 duck 状态应用到指定 audio 元素（带 120ms 指数缓出 ramp）。
 * 修复根因:旧实现在 new Audio() 时一次性读取 __ttsDucked——
 * ① duck/unduck 翻转不回溯当前播放段,下一句才生效 → 句间忽大忽小;
 * ② 0.15/1.0 硬切换无平滑,跳变即"忽"感。
 * 现在 duck 状态翻转时实时应用到当前元素,带平滑过渡。
 */
export function applyDuckVolume(audio: HTMLAudioElement | null, ducked: boolean): void {
  if (!audio) return
  const target = duckVolumeFor(ducked)
  const start = audio.volume
  if (Math.abs(start - target) < 0.01) return
  if (typeof performance === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    audio.volume = target
    return
  }
  const t0 = performance.now()
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / TTS_DUCK_RAMP_MS)
    // ease-out cubic: 起步快、收尾缓,听感自然
    const k = 1 - Math.pow(1 - p, 3)
    audio.volume = start + (target - start) * k
    if (p < 1 && !audio.paused) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ── F5: 自适应增益（AGC）── ─────────────────────────────
/** 自适应增益目标 RMS（Float32 域） */
export const AGC_TARGET_RMS = 0.06
/** 增益上限——2026-09-05 深度优化：8→16→24(两步)。弱麦真机实测 USB 麦说话
 *  RMS~0.0018, 16 倍只到 0.0288(-31dBFS) 仍偏弱；24 倍到 0.0432(-27dBFS)
 *  接近目标。安全依据: noiseSuppression 已开(旧上限 24 的噪声淹没问题发生在
 *  降噪关闭时期)+静音判定用 AGC 前原始信号+HPF 先滤低频隆隆。
 *  强信号用户不受影响(增益趋近 1)。KWS 侧如出现噪声放大再单独对齐。 */
export const AGC_MAX_GAIN = 24
/** 低于此 RMS 的帧视为静音，不参与增益学习 */
const AGC_SILENCE_RMS = 0.0005
/**
 * 2026-08-08 (冒烟修复): 语音冻结阈值——rms 高于此视为"人声语音帧"，增益不调整。
 * 原实现在每一帧都做指数平滑：真人说话的句尾收段增益爬升,把残余噪声放大到
 * ASR 端点检测阈值之上 → 尾字被切/识别不稳定（实测"小龙女"→"小龙"→"小龙女"抖动、
 * "回到首页"→"回到首"）。手机放合成音音量恒定无停顿所以不受影响。
 * 语音帧恒定 → ASR 稳定断句；仅低音量区(0.0005~0.004,弱麦)学习放大。
 */
export const AGC_SPEECH_HOLD_RMS = 0.004
/** 强信号回落阈值：rms 足够强且增益 >1.2 时缓慢回落（防高增益削顶饱和） */
const AGC_STRONG_SIGNAL_RMS = 0.1
/** 强信号回落系数（每帧 ×0.95） */
const AGC_STRONG_FALLBACK = 0.95

/**
 * 计算下一次 AGC 增益（指数平滑）。
 * - rms ≤ 静音阈值 → 增益不更新（保持现状，防噪声抬升）
 * - rms ≥ 语音阈值 → 语音帧冻结（说话中增益恒定，防句尾爬升切字）
 *   —— 但若信号强(≥0.1)且增益 >1.2，缓慢回落（防放大削顶）
 * - 低音量区 → 目标增益 = clamp(targetRms / rms, 1, maxGain)，指数平滑
 * - 平滑系数 0.7/0.3，避免突变
 */
export function computeAgcGain(
  rms: number,
  currentGain: number,
  targetRms: number = AGC_TARGET_RMS,
  maxGain: number = AGC_MAX_GAIN,
  speechHoldRms: number = AGC_SPEECH_HOLD_RMS,
): number {
  if (!Number.isFinite(rms) || rms <= AGC_SILENCE_RMS) return currentGain
  if (rms >= speechHoldRms) {
    // 语音帧：冻结；强信号 + 高增益时缓慢回落防削顶
    if (currentGain > 1.2 && rms >= AGC_STRONG_SIGNAL_RMS) return currentGain * AGC_STRONG_FALLBACK
    return currentGain
  }
  const target = Math.min(maxGain, Math.max(1, targetRms / rms))
  return currentGain * 0.7 + target * 0.3
}

// ── F4: AudioContext 启动（autoplay 策略兜底）── ─────────
/**
 * 确保 AudioContext 处于 running 态。
 * 无用户手势时浏览器会以 NotAllowedError 拒绝首次 resume（autoplay 策略）；
 * 周期性重试直到成功或 maxAttempts 耗尽。返回最终是否 running。
 *
 * 调用方应在返回 false 时上报可见错误并中止会话启动——
 * 而不是静默继续（否则"看起来在听、实际 ASR 收到全静音"）。
 */
export async function ensureAudioContextRunning(
  ctx: { state: string; resume: () => Promise<void> },
  maxAttempts = 8,
  intervalMs = 500,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (ctx.state === 'running') return true
    try {
      await ctx.resume()
      if (ctx.state === 'running') return true
    } catch (e) {
      // 无手势授权——稍后重试（首次用户交互后 resume 可能成功）
      console.debug('[voice-engine-utils] ensureAudioContextRunning: resume 失败，将重试', e)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return ctx.state === 'running'
}

// ── 2026-08-12: 客户端背压门控(移植 LiveKit 流控)── ──
/** WS bufferedAmount 门控阈值——超限本地暂存降速,不静默丢弃 */
export const WS_BUFFERED_THRESHOLD_BYTES = 64 * 1024

export function shouldBackpressure(
  level: 'ok' | 'high',
  bufferedBytes: number,
  thresholdBytes: number = WS_BUFFERED_THRESHOLD_BYTES,
): boolean {
  return level === 'high' || bufferedBytes > thresholdBytes
}
