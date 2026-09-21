/**
 * shellVoiceConfig — VoiceShell 语音配置域（2026-09-21 从 index.tsx 拆出，纯搬运）
 *
 * config.json 的 voice 段是唯一来源：Settings 页写入 / VoiceShell 读取 + 监听更新。
 * localStorage 'crabpaw_shell_voice' 仅用于一次性迁移（旧内存态配置落盘）。
 * 本文件全部为模块级类型/常量/纯函数，无组件、无副作用依赖（除 apiGet 降级）。
 */
import { apiGet } from '../../lib/api'
import type { VoiceConfig } from '../../hooks/useVoiceReply'

export const SHELL_VOICE_KEY = 'crabpaw_shell_voice'

export interface ShellVoiceConfig extends VoiceConfig {
  continuousMode: boolean
  wakeWordEnabled: boolean
  asrProvider: string
  /** 专注模式（仅 PTT）：多人环境用 — 连续对话/唤醒词失效，只留按住说话 */
  pttOnly: boolean
  /** 2026-08-15: 静音态持久化——不方便出声时点语音球静音, 重启后保持(此前
   *  内存态重启即恢复发声, 用户困惑"选了默认还是播报"的根因) */
  muted: boolean
  /** 2026-08-31: Jarvis 音效开关(useSoundEffects 总闸)——启动按此值应用 */
  ttsFxEnabled: boolean
  // 2026-08-04: 对齐控制台 Settings 语音配置(VoiceSection)字段——识别语言/灵敏度
  lang?: string
  voiceThreshold?: number
  /** 2026-09-17: 语音对话通道——classic=ASR+TTS 接力; realtime=豆包全双工端到端 */
  dialogChannel?: 'classic' | 'realtime'
}

// ── 语音配置单源化（2026-08-12）───────────────────────────────────────────
export const SHELL_VOICE_DEFAULTS: ShellVoiceConfig = {
  replyEnabled: true,
  continuousMode: false,
  wakeWordEnabled: true,
  pttOnly: false,
  // 2026-08-24(用户反馈): muted 语义升级为「语音总开关」且默认关闭——首启即
  // 静态白球, KWS 唤醒/ASR/TTS 全停(旧: 默认 wakeWordEnabled=true, 启动即
  // 常驻占麦监听)。点语音球开启, 已持久化配置不受影响。
  muted: true,
  // 2026-08-31: Jarvis 音效缺省开(与 useSoundEffects 默认及设置页缺省一致)
  ttsFxEnabled: true,
  asrProvider: 'volcengine',
  ttsProvider: 'edge-tts',
  defaultVoice: 'zh-CN-XiaoxiaoNeural',
  speed: 1.0,
  doubaoVoice: 'zh_female_xiaohe_uranus_bigtts',
  volcanoVoice: 'BV001_streaming',
  lang: 'zh',
  voiceThreshold: 0.008,
}

// config.voice → ShellVoiceConfig（缺省字段用统一默认值兜底）
export function normalizeVoiceSection(v: Record<string, unknown> | undefined | null): ShellVoiceConfig {
  const cfg = { ...SHELL_VOICE_DEFAULTS, ...(v || {}) } as ShellVoiceConfig
  // pttOnly 是 shell 扩展字段（Settings 页无此字段）：config 缺省时保持本地默认 false
  if (typeof cfg.pttOnly !== 'boolean') cfg.pttOnly = false
  if (typeof cfg.muted !== 'boolean') cfg.muted = false
  // edge/sapi 系厂商音色必须是 edge 风格 ID——config 中残留的 doubao 音色会直接合成失败
  const provider = cfg.ttsProvider || ''
  if ((provider === 'edge' || provider === 'edge-tts' || provider === 'sapi')
    && !/^[a-z]{2,3}-[A-Z]{2}-/.test(cfg.defaultVoice || '')) {
    cfg.defaultVoice = 'zh-CN-XiaoxiaoNeural'
  }
  return cfg
}

// ShellVoiceConfig → config.voice 段（只写本组件持有的字段；后端 POST /config 按段合并，其余字段保留）
export function voiceSectionForShell(cfg: ShellVoiceConfig): Record<string, unknown> {
  return {
    replyEnabled: cfg.replyEnabled,
    continuousMode: cfg.continuousMode,
    wakeWordEnabled: cfg.wakeWordEnabled,
    pttOnly: cfg.pttOnly,
    muted: cfg.muted,
    ttsFxEnabled: cfg.ttsFxEnabled,
    asrProvider: cfg.asrProvider,
    ttsProvider: cfg.ttsProvider,
    defaultVoice: cfg.defaultVoice,
    speed: cfg.speed,
    doubaoVoice: cfg.doubaoVoice,
    volcanoVoice: cfg.volcanoVoice,
    lang: cfg.lang,
    voiceThreshold: cfg.voiceThreshold,
  }
}

// 读取 config.json（优先主进程 IPC，降级 HTTP——参考 App.tsx splash 模式）
export async function fetchConfigForShell(): Promise<Record<string, unknown> | null> {
  if (window.electronAPI?.config?.get) {
    try {
      const cfg = await window.electronAPI.config.get()
      if (cfg) return cfg as unknown as Record<string, unknown>
    } catch (e) {
      console.warn('[shell] IPC config.get 失败，降级 HTTP:', e)
    }
  }
  try {
    const result = await apiGet('/config')
    if (result.success && result.data) return result.data
  } catch (e) {
    console.error('[shell] 语音配置读取失败（HTTP 降级）:', e)
  }
  return null
}
