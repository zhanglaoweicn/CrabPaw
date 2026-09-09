/**
 * voice-auto-send — 语音自动发送门控(纯函数, GUI 全量修复 P2)
 *
 * P0 根因: useContinuousVoice.scheduleAutoSend 首行 `if (getAutoSend?.() === false) return`,
 * 而 VoiceIntegration 的 getAutoSend = effectiveContinuous —— 默认(唤醒词)模式下
 * effectiveContinuous=false → 唤醒后说出的内容永不发送给 LLM。
 *
 * 修复语义: 唤醒词模式下, 唤醒会话窗口内(wakeState 非 sleeping/dismissing)
 * 自动发送也放行——会话由 onWake → startSession 启动, 未唤醒时无 session 无转写,
 * 不存在"未唤醒杂音误发"。60s 空闲退场后 wakeState 回 sleeping, 门禁自然关闭。
 */

/** 唤醒会话窗口判定: sleeping/dismissing 之外均为唤醒活跃期 */
export function isWakeActive(wakeState: string): boolean {
  return wakeState !== 'sleeping' && wakeState !== 'dismissing'
}

export interface ShouldAutoSendParams {
  /** 空格 PTT 按住中(恒短路) */
  pttHolding: boolean
  /** 连续对话模式(实时监听) */
  effectiveContinuous: boolean
  /** 唤醒词模式生效(非 pttOnly) */
  effectiveWakeWord: boolean
  /** 当前是否处于唤醒会话窗口 */
  wakeActive: boolean
}

/**
 * 自动发送门控:
 * - pttHolding → 恒 false(PTT 独立管线负责)
 * - 连续模式 → 恒 true(原有行为)
 * - 唤醒词模式 → 仅在唤醒会话窗口内 true
 */
export function shouldAutoSend(p: ShouldAutoSendParams): boolean {
  if (p.pttHolding) return false
  if (p.effectiveContinuous) return true
  return p.effectiveWakeWord && p.wakeActive
}
