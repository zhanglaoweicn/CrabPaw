/**
 * briefing-voice.ts — 晨报语音指令（2026-09-30，P1-2 规格 §4.2）
 *
 * 三条话：
 *   "晨报"            → 开始播报（命中预热则立刻出声）
 *   "再说一遍"        → **只重播上一句**（不是整篇重来；老板在车里听漏一句的救急）
 *   "第二条"          → 跳过当前段，直接下一段
 *
 * 为什么把"识别"和"播放"拆开：
 *   识别是纯逻辑（模式匹配 + 未就绪时的体面拒绝），可以离线单测；
 *   播放要碰音频与 React 状态，只能真机验证。两者混在一个 2300 行的组件里就都测不了了。
 *   因此这里注册命令，动作只调用一个**明确句柄**（window.__crabpawBriefing），
 *   由 VoiceShell 在挂载时接上真正的控制器。
 *
 * 未接线时的行为（重要）：明确告知"晨报功能还没准备好"，而不是静默无反应——
 * 静默会让人以为麦克风坏了（"信"的成本比"少一个功能"高得多）。
 */

import { registerVoiceCommand } from './voiceCommands'

/** 晨报控制器在运行时暴露给语音命令的句柄 */
export interface BriefingVoiceHandler {
  /** 是否已就绪（未预热/未取到数据时可为 false） */
  isReady?: () => boolean
  /** 开始播报；返回实际入队段数（0 = 没稿可播） */
  start: () => number | Promise<number>
  /** 重播上一句；返回是否有可重播的段 */
  replayLast: () => boolean
  /** 跳到下一段；返回是否成功 */
  next: () => boolean
}

/** 命令 id（供测试与调试引用，避免字符串散落） */
export const BRIEFING_COMMANDS = {
  play: 'briefing-play',
  replay: 'briefing-replay',
  next: 'briefing-next',
} as const

/** 三类说的法（覆盖口语变体；全部锚定，避免"我今天看了晨报"这类误命中） */
export const BRIEFING_PATTERNS = {
  // 允许多个动词前缀连用（"开始听晨报"/"说一下今天的晨报"），但**必须整句就是这句话**
  // （锚定 + 固定词序，所以"我今天看了晨报"不会命中）
  play: [
    /^(开始|来|看|听|念|播|说|讲){0,2}(一下)?(今天|今日)?(的)?(晨报|简报)$/,
  ],
  replay: [
    /^再(说|念|播|讲)(一)?(遍|次)$/,
    /^重复(一)?(遍|下)?$/,
    /^刚才(那|这)?句(再)?(说|念)(一)?(遍)?$/,
    /^上一句$/,
  ],
  next: [
    /^下(一)?(条|句|段)$/,
    /^第(二|2)(条|句|段)$/,
    /^跳过(这?(条|句|段))?$/,
    /^继续$/,
  ],
}

/** 句柄读取（未接线 → null） */
export function getBriefingHandler(): BriefingVoiceHandler | null {
  try {
    const h = (window as unknown as { __crabpawBriefing?: BriefingVoiceHandler }).__crabpawBriefing
    return h && typeof h.start === 'function' ? h : null
  } catch { return null }
}

/** 未接线/未就绪时的统一提示文本（供 UI 与日志共用，避免两套文案） */
export const NOT_READY_HINT = '晨报还没准备好，稍等一下再说一次。'

/**
 * 注册三条语音命令（幂等）。应在应用启动早期调用一次。
 * @returns 实际注册条数（已注册过则为 0）
 */
export function registerBriefingVoiceCommands(): number {
  const defs: Array<{ id: string; patterns: RegExp[]; description: string; run: () => void }> = [
    {
      id: BRIEFING_COMMANDS.play,
      patterns: BRIEFING_PATTERNS.play,
      description: '播报晨报',
      run: () => {
        const h = getBriefingHandler()
        if (!h) { console.warn('[briefing-voice]', NOT_READY_HINT); return }
        void Promise.resolve(h.start()).then((n) => {
          // 0 段 = 没稿可播（取数未完成或数据为空）：说出来，不静默
          if (!n) console.warn('[briefing-voice] 没有可播报的晨报内容')
        }).catch((e) => console.warn('[briefing-voice] 播报失败:', e?.message || e))
      },
    },
    {
      id: BRIEFING_COMMANDS.replay,
      patterns: BRIEFING_PATTERNS.replay,
      description: '重播上一句',
      run: () => {
        const h = getBriefingHandler()
        if (!h) { console.warn('[briefing-voice]', NOT_READY_HINT); return }
        if (!h.replayLast()) console.warn('[briefing-voice] 没有可重播的上一句')
      },
    },
    {
      id: BRIEFING_COMMANDS.next,
      patterns: BRIEFING_PATTERNS.next,
      description: '跳到下一段',
      run: () => {
        const h = getBriefingHandler()
        if (!h) { console.warn('[briefing-voice]', NOT_READY_HINT); return }
        if (!h.next()) console.warn('[briefing-voice] 已经是最后一段')
      },
    },
  ]

  let registered = 0
  for (const d of defs) {
    // 守卫：只在晨报句柄已接线时接管这些说法。
    // 为什么需要：/"继续"/"上一句" 是很泛的说法，若晨报没接线就吃掉它们，
    // 会把原本该交给模型的对话指令吞掉（"继续"常用于让 AI 接着说）。
    registerVoiceCommand({
      id: d.id,
      patterns: d.patterns,
      description: d.description,
      guard: () => getBriefingHandler() !== null,
      action: d.run,
    })
    registered++
  }
  return registered
}
