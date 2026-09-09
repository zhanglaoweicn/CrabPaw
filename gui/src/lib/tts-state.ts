/**
 * tts-state — TTS 全局状态单一写入点（2026-08-12）
 *
 * 消除 window.__tts* 多文件乱写竞态（VoiceStateContext / useVoiceReply /
 * useSpeechQueue 各自直写导致状态互踩）。所有写操作收编到本模块：
 * - setTtsActive 带 owner 守卫——非 owner 不能清除他人状态（继承 __ttsOwner 语义）
 * - VoiceStateContext 订阅本模块镜像到 window.__（只读镜像,供旧代码读取）
 * - 读取方(barge-in 分类器等)继续读 window.__,无需改动
 */

export interface TtsState {
  active: boolean
  owner?: string
  audioElement: HTMLAudioElement | null
  aborted: AbortController | null
  ducked: boolean
  /** P5(GUI 全量修复): 播放音量 0-1(60ms 节流更新)——订阅通道, 不再全树广播 */
  volume: number
}

let state: TtsState = {
  active: false,
  owner: undefined,
  audioElement: null,
  aborted: null,
  ducked: false,
  volume: 0,
}

const listeners = new Set<(s: TtsState) => void>()

function commit(patch: Partial<TtsState>): void {
  state = { ...state, ...patch }
  for (const cb of listeners) {
    // 订阅者异常不影响其他订阅者（无空 catch：记录后继续）
    try {
      cb(state)
    } catch (err) {
      console.warn('[tts-state] 订阅者回调异常:', err)
    }
  }
}

export function getTtsState(): TtsState {
  return state
}

export function subscribeTtsState(cb: (s: TtsState) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function setTtsActive(owner: string, active: boolean): boolean {
  if (active) {
    commit({ active: true, owner })
    return true
  }
  // owner 守卫:只有当前 owner(或无人占用)才能清除
  if (state.owner === undefined || state.owner === owner) {
    commit({ active: false, owner: undefined })
    return true
  }
  return false
}

export function setTtsAudioElement(el: HTMLAudioElement | null): void {
  commit({ audioElement: el })
}

export function setTtsAbortController(c: AbortController | null): void {
  commit({ aborted: c })
}

export function setTtsDucked(d: boolean): void {
  commit({ ducked: d })
}

/** P5: 播放音量(0-1)——pub-sub 订阅通道, 消费方(音乐卡/诊断)本地订阅, 不触发 React 全树 */
export function setTtsVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v))
  if (Math.abs(clamped - state.volume) < 0.001) return
  commit({ volume: clamped })
}
