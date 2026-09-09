/**
 * voice-orb-state — 语音球状态推导纯函数（2026-08-24 用户反馈轮）
 *
 * 统一语义（用户定义）：
 *   关闭态（muted=语音总开关）→ 静态白色球体（idle，ASR/TTS/唤醒全部停）
 *   语音开启态（唤醒/实时PTT任一策略）→ 绿色球体：
 *      无音量 → 绿色静态；有人声（volume>0）→ 绿色动态波动
 *   发声（TTS 播放）→ 蓝色动态波动（speaking）
 *   思考（LLM 处理）→ 橙色扫描环（thinking，保持原语义）
 *
 * 迁移自 VoiceShell/index.tsx 内联 derive（585-595 行）：旧逻辑按
 * muted→蓝灰、待机能量→监听、实时安静→idle(白) 三处分叉，用户反馈
 * 「语音没开球却变色/实时待命是白色」——问题出在关闭态与开启态
 * 的球色语义混淆。本函数将「关闭→白/开启→绿」提升为唯一规则，
 * 能量电平只驱动音量（见调用方 volume 推导），不再直接切换 mode。
 */

export type VoiceOrbMode = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface OrbStateInput {
  /** 语音总开关（点球切换）：关闭时 ASR/KWS/TTS/PTT 全停，球为静态白 */
  muted: boolean
  /** 流式 TTS / 复用播报队列播放中 → 蓝色动态 */
  ttsPlaying: boolean
  isSpeaking: boolean
  queuePlaying: boolean
  /** LLM 处理中 → 橙色扫描环 */
  pending: boolean
  /** ASR 会话激活（实时监听中/PTT 按住/唤醒后） */
  voiceSessionActive: boolean
  /** 语音策略开启标志（均已按 muted 门控——wakeWordEnabled&&!muted 等） */
  wakeArmed: boolean
  continuousMode: boolean
  pttOnly: boolean
}

export function deriveOrbMode(i: OrbStateInput): VoiceOrbMode {
  // 关闭态：一律静态白（与旧 muted→蓝灰 不同——用户要求「不启用 asr/tts = 白色静态球」）
  if (i.muted) return 'idle'
  // 发声（TTS）→ 蓝；优先级高于 pending（播报本身也是处理中，语音优先）
  if (i.ttsPlaying || i.isSpeaking || i.queuePlaying) return 'speaking'
  // 思考 → 橙
  if (i.pending) return 'thinking'
  // 语音开启态（任一策略或会话激活）→ 绿；安静/有声的强弱由 volume 驱动（调用方传入）
  if (i.voiceSessionActive || i.wakeArmed || i.continuousMode || i.pttOnly) return 'listening'
  return 'idle'
}

/** 关闭态 = 完全静止白球：关闭时音量应恒为 0（防残留电平驱动球体） */
export function deriveOrbVolume(i: {
  muted: boolean
  voiceSessionActive: boolean
  asrLevel: number | null
  kwsLevel: number | null
}): number {
  if (i.muted) return 0
  const level = i.voiceSessionActive ? i.asrLevel : i.kwsLevel
  return level ?? 0
}

/**
 * B3(2026-09-05) agent 注意带状态——极简布局下左右栏(时间线/工具执行)整体隐藏,
 * 用户除 orb 四态色外看不到 agent 在执行什么/等什么。本函数与 deriveOrbMode
 * 同源同模式(纯函数、同输入族), 但描述执行层语义而非感知层:
 *   waiting  等用户拍板(审批未决)——需要行动, 最高优先
 *   acting   工具执行中(flow.toolEvents running 数>0)——进展可见
 *   speaking/thinking/listening/idle 与 orb 四态同义(播报/思考/在听/待命)
 * 优先级依据: 执行与等待是"用户需要知道"的增量信息, 感知态是常态背景。
 */
export type AgentFocusState = 'idle' | 'listening' | 'thinking' | 'acting' | 'waiting' | 'speaking'

export interface AgentFocusInput {
  /** 待审批数(inline ApprovalHost onActiveChange)——>0 即等用户拍板 */
  pendingApprovals: number
  /** 本轮执行中的工具数(flow.toolEvents status==='running') */
  toolRunning: number
  muted: boolean
  ttsPlaying: boolean
  isSpeaking: boolean
  queuePlaying: boolean
  pending: boolean
  voiceSessionActive: boolean
  wakeArmed: boolean
  continuousMode: boolean
  pttOnly: boolean
}

export function deriveAgentFocus(i: AgentFocusInput): AgentFocusState {
  // 等拍板最高——用户行动项压过一切进行中状态
  if (i.pendingApprovals > 0) return 'waiting'
  // 工具执行中——即使语音关闭(muted)也要显示: 工作在跑, 盲飞感来自这里
  if (i.toolRunning > 0) return 'acting'
  if (i.ttsPlaying || i.isSpeaking || i.queuePlaying) return 'speaking'
  if (i.pending) return 'thinking'
  if (i.muted) return 'idle'
  if (i.voiceSessionActive || i.wakeArmed || i.continuousMode || i.pttOnly) return 'listening'
  return 'idle'
}
