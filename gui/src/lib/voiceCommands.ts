/**
 * voiceCommands — 本地语音命令注册表（无需联网即可执行的即时命令）
 *
 * 设计目标：
 *   - 替代 VoiceIntegration.tsx 中硬编码的 VOICE_CLOSE_MUSIC_PATTERNS
 *   - 可扩展：新命令只需往 VOICE_COMMANDS 推一条，或调用 registerVoiceCommand
 *   - 低误触：所有 pattern 使用 ^...$ 精确匹配，避免误拦截包含关键词的长句
 *     （例如 "帮我打开设置页面" 不会匹配 ^打开设置$）
 *   - 守卫机制：guard() 返回 false 时跳过该命令（如音乐面板未打开时不触发关闭）
 *
 * 命令分类：
 *   1. 音乐面板控制（关闭/暂停）
 *   2. TTS 播报控制（停止说话/闭嘴）
 *   3. 语音会话控制（停止监听）
 *   4. 页面导航（首页/对话/设置/技能/日历/记忆）
 */

import { playSound, type SoundType } from '../hooks/useSoundEffects'
import { stripCommandPrefix } from './voice-panel-commands'
import { executeCommand, getCommandHost, hasCommandHost } from './ui-command-registry'

// ─── 类型定义 ──────────────────────────────────────────

export interface VoiceCommand {
  /** 唯一标识，用于去重 */
  id: string
  /** 精确匹配正则数组（建议使用 ^...$ 锚定） */
  patterns: RegExp[]
  /** 命中后执行的动作 */
  action: () => void | Promise<void>
  /** 人类可读描述（日志/调试用） */
  description: string
  /** 命中时播放的音效 */
  sound?: SoundType
  /** 守卫：返回 false 时跳过该命令。省略则始终允许 */
  guard?: () => boolean
}

// ─── 动作辅助函数 ──────────────────────────────────────

function navigateTab(tab: string, section?: string): void {
  // 2026-08-12 (P1 缺陷 1): 弃用 crabpaw:navigate——该事件在单界面下仅
  // ManagementCockpit 监听且只处理 tab==='settings'（且不打开浮层），其余 tab 无监听者
  // → 导航命令被拦截但静默吞掉。改派 crabpaw:open-cockpit（VoiceShell 监听：打开管理舱/
  // 业务面板并切对应 tab，home/chat/calendar/memory 各有真实落点）。
  // crabpaw:navigate 仍由 Gateway/News/Status 真按钮直接派发，不受影响。
  window.dispatchEvent(new CustomEvent('crabpaw:open-cockpit', { detail: { tab, section } }))
}

function closeMusicPanel(): void {
  // A1(2026-09-05): 经 ui-command-registry(旧 window.__closeMusicPanel 退役)
  executeCommand('musicPanel', 'close')
}

// 2026-08-15: "暂停音乐"从 close-music 拆出——旧语义暂停即关面板,用户想
// "暂停待会继续听"被整卡关掉。独立暂停命令只停音频保留面板。
function pauseMusicPanel(): void {
  executeCommand('musicPanel', 'pause')
}

function stopTTS(): void {
  try {
    const fn = (window as any).__voiceInterruptTTS
    if (fn) fn(true)
  } catch (e) { console.warn('[VoiceCmd] interruptTTS error:', e) }
}

function stopVoiceSession(): void {
  try { (window as any).crabpawVoice?.stop?.() }
  catch (e) { console.warn('[VoiceCmd] stop voice session error:', e) }
}

// 2026-09-05: 关闭媒体/视频面板——与 matchPanelCommand 的 media close 规则对齐。
// 真机反馈(连续语音模式): "关闭视频"在打字路径命中 matchPanelCommand 正常关闭,
// 语音路径 interceptLocalVoiceCommand 无此规则落 LLM → LLM 无关闭工具 → 完全无反应。
// __mediaStage 恒注册(MediaStageHost 常驻), close 即删 surfaces(与 ×/Esc 同语义)。
function closeMediaStage(): void {
  executeCommand('mediaStage', 'close')
}

// ─── 命令注册表 ─────────────────────────────────────────

const VOICE_COMMANDS: VoiceCommand[] = [
  // 0. 媒体/视频面板关闭(2026-09-05 补齐——与打字路径 matchPanelCommand 的
  //    media close 规则对齐; 此前连续语音说"关闭视频"落 LLM 且无关闭工具=无反应)
  {
    id: 'close-media',
    patterns: [
      /^关闭(媒体面板|视频面板|视频卡片|视频卡|播放器|媒体|视频)$/,
      /^(收起|隐藏|关掉)(媒体面板|视频面板|视频卡片|视频卡|播放器|媒体|视频)$/,
    ],
    action: closeMediaStage,
    description: '关闭媒体/视频面板',
    sound: 'panel-close',
    guard: () => hasCommandHost('mediaStage'),
  },
  // 1. 音乐面板控制 — 仅在面板可见时生效
  {
    id: 'close-music',
    patterns: [
      /^关闭音乐$/, /^关闭播放$/, /^关闭播放器$/, /^关掉音乐$/,
      /^关掉播放$/, /^停止音乐$/, /^停止播放$/, /^关闭音乐面板$/, /^关音乐$/,
      /^关掉播放器$/,
    ],
    action: closeMusicPanel,
    description: '关闭音乐面板',
    sound: 'panel-close',
    guard: () => getCommandHost<{ isVisible?: () => boolean }>('musicPanel')?.isVisible?.() === true,
  },
  {
    id: 'pause-music',
    patterns: [/^暂停音乐$/, /^暂停播放$/, /^暂停$/],
    action: pauseMusicPanel,
    description: '暂停音乐播放（保留面板）',
    sound: 'panel-close',
    guard: () => getCommandHost<{ isVisible?: () => boolean }>('musicPanel')?.isVisible?.() === true,
  },

  // 2. TTS 播报控制
  {
    id: 'stop-tts',
    patterns: [/^停止说话$/, /^闭嘴$/, /^停止朗读$/, /^别说了$/, /^停止播报$/, /^停止响应$/],
    action: stopTTS,
    description: '停止语音播报',
    sound: 'voice-end',
  },

  // 3. 语音会话控制
  {
    id: 'stop-listening',
    patterns: [/^停止监听$/, /^关闭语音$/, /^关闭麦克风$/, /^停止收音$/, /^闭麦$/],
    action: stopVoiceSession,
    description: '停止语音监听',
    sound: 'voice-end',
  },

  // 4. 页面导航
  {
    id: 'nav-home',
    patterns: [/^回到首页$/, /^返回主页$/, /^回主页$/, /^打开首页$/],
    action: () => navigateTab('home'),
    description: '回到首页',
    sound: 'button-click',
  },
  {
    id: 'nav-chat',
    patterns: [/^打开对话$/, /^回到对话$/, /^打开聊天$/, /^切换到对话$/],
    action: () => navigateTab('chat'),
    description: '打开对话页',
    sound: 'button-click',
  },
  {
    id: 'nav-settings',
    patterns: [/^打开设置$/, /^进入设置$/, /^打开设置页$/, /^切换到设置$/],
    action: () => navigateTab('settings'),
    description: '打开设置页',
    sound: 'button-click',
  },
  {
    id: 'nav-skills',
    patterns: [/^打开技能$/, /^进入技能$/, /^打开技能页$/],
    action: () => navigateTab('skills'),
    description: '打开技能页',
    sound: 'button-click',
  },
  {
    id: 'nav-calendar',
    patterns: [/^打开日历$/, /^查看日历$/, /^打开日程$/],
    action: () => navigateTab('calendar'),
    description: '打开日历',
    sound: 'button-click',
  },
  {
    id: 'nav-memory',
    patterns: [/^打开记忆$/, /^查看记忆$/, /^打开记忆页$/],
    action: () => navigateTab('memory'),
    description: '打开记忆页',
    sound: 'button-click',
  },
]

// ─── 拦截入口 ───────────────────────────────────────────

/**
 * 拦截本地语音命令。命中则执行动作并返回 true（调用方应跳过发送给 AI）。
 * 未命中返回 false，调用方按正常流程处理。
 *
 * 对标 music-panel-enhancement.md：语音"关闭音乐"应立即响应，不等 ASR 静默发送延迟。
 */
export function interceptLocalVoiceCommand(text: string): boolean {
  // 2026-08-12: 匹配前剥离呼唤前缀（与 handleUserInput 同款 stripCommandPrefix）——
  // 语音路径先经本函数再进面板命令匹配，若不在此剥离，"小螃蟹打开设置"等带前缀
  // 说法永远命中不了本地导航命令（P1 缺陷 1/4 关联场景）。
  const trimmed = stripCommandPrefix((text || '').trim().toLowerCase())
  if (!trimmed) return false
  for (const cmd of VOICE_COMMANDS) {
    // 2026-08-07: guard 移入 try——守卫自身异常按"不命中"处理,不中断整个拦截流程
    try {
      if (cmd.guard && !cmd.guard()) continue
    } catch (e) {
      console.warn(`[VoiceCmd] 命令 "${cmd.id}" 守卫异常，按不命中处理:`, e)
      continue
    }
    if (cmd.patterns.some(p => p.test(trimmed))) {
      try {
        cmd.action()
        if (cmd.sound) playSound(cmd.sound)
        console.log(`[Voice] 本地命令拦截: ${cmd.description}`)
      } catch (e) {
        console.warn(`[VoiceCmd] 命令 "${cmd.id}" 执行失败:`, e)
      }
      return true
    }
  }
  return false
}

// ─── 扩展接口 ───────────────────────────────────────────

/** 获取当前注册的命令列表（只读视图，用于调试/测试） */
export function listVoiceCommands(): readonly VoiceCommand[] {
  return VOICE_COMMANDS
}

/**
 * 注册新的语音命令。若 id 已存在则忽略（幂等）。
 * 供其他模块在运行时扩展命令集，无需修改本文件。
 */
export function registerVoiceCommand(cmd: VoiceCommand): void {
  if (VOICE_COMMANDS.some(c => c.id === cmd.id)) {
    console.warn(`[VoiceCmd] 命令 "${cmd.id}" 已存在，跳过注册`)
    return
  }
  VOICE_COMMANDS.push(cmd)
}
