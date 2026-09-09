/**
 * voice-state — 语音会话状态机定义（2026-08-04,P4）
 *
 * 移植 LiveKit 状态机思想(轻量版):
 * 语音会话状态是"环"(listening→recognizing→speaking→listening…),非线性单向,
 * 照搬 LiveKit 的 CAS 单向推进会破坏循环语义。改为显式转换表 +
 * 非法转换 warn 收集——先暴露真实非法路径,再按数据收紧。
 */

export type VoiceSessionState =
  | 'idle' | 'listening' | 'recognizing'
  | 'processing' | 'speaking' | 'error' | 'wake_listening' | 'media_paused'

/** 合法转换集合(守卫用)——非法转换仅 warn 收集,不阻止 */
export const VOICE_STATE_TRANSITIONS: Record<VoiceSessionState, VoiceSessionState[]> = {
  idle: ['listening', 'wake_listening', 'recognizing', 'speaking', 'error'],
  // speaking 加入 idle 出边: TTS 播放可能先于连续会话启动(suspendForTTS 在会话还
  // 是 idle 时被调用)——speaking 意为"mic 让给 TTS",从 idle 进入是良性时序,非非法。
  listening: ['recognizing', 'speaking', 'processing', 'idle', 'error', 'media_paused'],
  recognizing: ['listening', 'speaking', 'processing', 'idle', 'error'],
  processing: ['speaking', 'listening', 'idle', 'error'],
  // 2026-08-15 S8 补边: suspendForMedia 经 suspendShared 先置 'speaking' 再置
  // 'media_paused'(媒体播放挂起)——speaking 缺此出边时 dev 环境直接 throw、
  // 生产停留 'speaking' 状态错误。
  speaking: ['listening', 'recognizing', 'idle', 'error', 'media_paused'],
  error: ['idle', 'listening', 'recognizing'],
  wake_listening: ['listening', 'recognizing', 'idle', 'error'],
  media_paused: ['listening', 'idle', 'error'],
}

/** 判定转换是否合法 */
export function isLegalTransition(from: VoiceSessionState, to: VoiceSessionState): boolean {
  if (from === to) return true
  const allowed = VOICE_STATE_TRANSITIONS[from]
  return !!allowed && allowed.includes(to)
}

/**
 * 强制状态机（2026-08-12,移植 LiveKit atomic 状态管理思想）
 * - 非法转换：strict(默认 dev)下 throw；生产 console.error + 返回 false(停留原状态)
 * - force: 仅供已文档化的良性时序(如 idle→speaking 早于会话启动)
 */
// 2026-08-13 fix: 渲染进程无 process 标识符——裸引用即 ReferenceError(可选链不拦
// 未声明变量),导致 VoiceStateMachine 构造即崩、整窗 ErrorBoundary。typeof 守卫兼容浏览器。
const isDevEnv = () => typeof process !== 'undefined' && process.env?.NODE_ENV === 'development'

export class VoiceStateMachine {
  private state: VoiceSessionState
  private strict: boolean

  constructor(initial: VoiceSessionState = 'idle', opts: { strict?: boolean } = {}) {
    this.state = initial
    this.strict = opts.strict ?? isDevEnv()
  }

  get current(): VoiceSessionState {
    return this.state
  }

  setState(to: VoiceSessionState, opts: { force?: boolean } = {}): boolean {
    if (to === this.state) return true
    if (!opts.force && !isLegalTransition(this.state, to)) {
      const msg = `[voice-state] 非法状态转换: ${this.state} → ${to}`
      if (this.strict) throw new Error(msg)
      console.error(msg + '（停留原状态）')
      return false
    }
    this.state = to
    return true
  }
}
