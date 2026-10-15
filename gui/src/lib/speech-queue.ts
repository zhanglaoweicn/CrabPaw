/**
 * 语音归因播报队列（P5，规格 §7.1）— 多智能体并行完成时按"先完成先报、结论合并报"节奏播报。
 * 纯 reducer，可 jest。播报不打断主对话（canSpeak 守卫在 useSpeechQueue 内）。
 */
export interface SpeechJob {
  id: string
  text: string
  kind: 'expert-done' | 'expert-error' | 'summary' | 'panel' | 'briefing'
  /** P3: 过期时间戳(ms)——静音期间入队 job 超时后丢弃,解除静音后不集中补播 */
  expiresAt?: number
  /** 2026-09-04 部门化 P3: 岗位音色(voiceStyle→TTS voice id, resolveExpertTtsVoice)——
   *  缺省回落队列级 voice 配置。"已接通财务部「财务顾问」"用自己的音色说。 */
  voice?: string
  /** 2026-09-30 音频优先晨报(P1-2): 已预热的音频——命中则直接播放，免去合成往返
   *  （老板说"晨报"要立刻出声）。缺省时按原逻辑实时合成。 */
  audio?: { audioBase64: string; audioFormat?: string }
  /** 晨报段序号（0-based）——用于"屏幕显示必须等于正在播的段"这条同步约束 */
  segmentIndex?: number
}

export interface SpeechQueueState {
  jobs: SpeechJob[]
  playingId: string | null
}

export type SpeechQueueAction =
  | { type: 'enqueue'; job: SpeechJob }
  | { type: 'start' }     // 开始播放队首（标记播放中，防 effect 重入重复播放）
  | { type: 'dequeue' }   // 当前播放结束（onended）→ 空闲可播下一段
  | { type: 'reset' }     // 静音时清空
  | { type: 'clearByPrefix'; prefix: string }  // 仅清指定前缀的 job（收球只清协作播报，不动共享队列其他来源）
  /** 2026-09-30 P1-2: 把某条插到队首（"再说一遍"）——不重排其余 job，也不影响正在播的段 */
  | { type: 'replay'; job: SpeechJob }

export function speechQueueReducer(state: SpeechQueueState, action: SpeechQueueAction): SpeechQueueState {
  switch (action.type) {
    case 'enqueue':
      return { ...state, jobs: [...state.jobs, action.job] }
    case 'start': {
      if (state.playingId !== null) return state  // 已在播：忽略
      const head = state.jobs[0]
      if (!head) return state
      return { ...state, playingId: head.id }
    }
    case 'dequeue': {
      if (state.jobs.length === 0) return state
      const [, ...rest] = state.jobs
      return { jobs: rest, playingId: null }  // 播完 → 空闲，下一段可播
    }
    case 'reset':
      return { jobs: [], playingId: null }
    case 'clearByPrefix': {
      const jobs = state.jobs.filter(j => !j.id.startsWith(action.prefix))
      // 若被清的恰好是当前播放段,释放 playingId 让下一段可播
      const playingId = state.playingId && state.playingId.startsWith(action.prefix) ? null : state.playingId
      return { jobs, playingId }
    }
    case 'replay': {
      // "再说一遍"：插到**正在播的段之后**（无正在播则队首）。
      // 不能无脑 unshift：playingId 指向队首那个 job（见 dequeue/start 的实现），
      // 把新 job 插到队首会把正在播的 job 挤到 index 1 —— playingId 与队首失配，
      // 状态不一致（本模块初版即踩此坑，被单测抓出）。
      // 插到当前段之后同时满足两个诉求：不打断正在念的这句，且它是"下一句"。
      const filtered = state.jobs.filter(j => j.id !== action.job.id)
      if (state.playingId === null) return { ...state, jobs: [action.job, ...filtered] }
      const at = filtered.findIndex(j => j.id === state.playingId)
      if (at < 0) return { ...state, jobs: [action.job, ...filtered] }
      const jobs = [...filtered.slice(0, at + 1), action.job, ...filtered.slice(at + 1)]
      return { ...state, jobs }
    }
    default:
      return state
  }
}

/** 队首待播 job id（无正在播放且队列非空时） */
export function nextToPlay(state: SpeechQueueState): string | null {
  if (state.playingId !== null) return null
  return state.jobs.length > 0 ? state.jobs[0].id : null
}
