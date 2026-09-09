/**
 * VoiceShell — 语音优先主界面（默认入口）
 *
 * 布局（克制型）：
 *  ┌────────────────────────────────────────────┐
 *  │  CrabPaw 徽标        [状态点]                 │  顶栏
 *  │                                              │
 *  │              （环境辉光层 AmbientGlow）      │
 *  │                ● 居中 VoiceOrb (260px)      │
 *  │              （orb-halo 径向光晕）           │
 *  │                                              │
 *  │         [模式胶囊: 连续对话/PTT]             │
 *  │        转写文字（实时）                      │
 *  │        当前回合 AI 文本（流式）              │
 *  │        提示语: "说'小螃蟹'或'小龙女'唤醒我" │  底部 HUD
 *  └────────────────────────────────────────────┘
 *
 * 语音机制：由 useVoiceChatFlow（chat 流 → TTS 接线）+ VoiceIntegration（三模式）编排。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AmbientGlow } from '../../components/AmbientGlow'
import TaskOrbit from '../../components/TaskOrbit'
import { HoloDissolve } from '../../components/HoloDissolve'
import { SceneSurfaceRenderer } from '../../components/SceneShell'
import type { Surface } from '../../components/SceneShell'
import { VoiceIntegration } from '../../components/VoiceIntegration'
import { useVoiceChatFlow } from '../../hooks/useVoiceChatFlow'
import { useAgentMonitor } from '../../hooks/useAgentMonitor'
import { useKwsWakeWord, type KwsAudioLevel } from '../../hooks/useKwsWakeWord'
import { useVoiceState } from '../../contexts/VoiceStateContext'
import { useSpeechQueue } from '../../hooks/useSpeechQueue'
import { useSceneSurfaces } from '../../lib/scene-client'
import type { VoiceConfig } from '../../hooks/useVoiceReply'
import { resolveVoiceStyle, resolveExpertTtsVoice } from '../../lib/expert-persona'
import { matchPanelCommand, stripCommandPrefix, extractSongQuery, SUGGESTED_PROMPTS, detectExpertSummonCommand, detectExpertMeetingConfirmation } from '../../lib/voice-panel-commands'
import { summonExpert, startDepartmentMeeting, fetchTeamPresets, fetchExpertDetail, fetchExpertsByDepartment, getCollabStatus } from '../../components/ExpertsPanel/api'
import { deriveAgentFocus, deriveOrbMode, deriveOrbVolume } from '../../lib/voice-orb-state'
import { interceptLocalVoiceCommand } from '../../lib/voiceCommands'
import { isDevMode } from '../../lib/dev-mode'
import { setSoundEnabled } from '../../hooks/useSoundEffects'
import { apiGet, apiPost } from '../../lib/api'
import { useDraggable } from '../../lib/useDraggable'
import { ShellFloatCard } from '../../components/ShellFloatCard'
import { HeartbeatCard } from '../../components/HeartbeatCard'
import { SysInfoCard } from '../../components/SysInfoCard'
import { fileUrlFor, isImageAttachment, formatFileSize } from '../../lib/attachment'
import { isCardWallKind, loadDismissedKeys, saveDismissedKeys } from '../../lib/surface-utils'
import { subscribeSse } from '../../lib/sse-hub'
import { nextPhaseThreshold, phaseText, sceneFromPhase } from '../../lib/holo-phase'
import { Minus, Square, X, Columns, RotateCcw, LayoutDashboard, History, Brush, ChevronDown, Send } from 'lucide-react'
import { toast } from 'sonner'
import { ManagementCockpit, type CockpitTab } from '../../components/ManagementCockpit'
import { COCKPIT_TAB_MAP, COCKPIT_TARGET_MAP } from '../../lib/cockpit-navigation'
import { activateOverlay, closeActiveSheet, closeSheet } from '../../components/SideSheet/sheet-state'
import { executeCommand, getCommandHost, registerCommandHost } from '../../lib/ui-command-registry'
import { COMMAND_DEFS } from '../../lib/command-defs'
import CommandPalette from '../../components/CommandPalette'
import { SessionDrawer } from './SessionDrawer'
import { AgentLeftPanel } from './AgentLeftPanel'
import { OrbTopBlock } from './OrbTopBlock'
import { AgentRightPanel } from './AgentRightPanel'
import { ToolCardStream } from './ToolCardStream'
// P6(GUI 全量修复 P1): 恢复协作轨道——CollabOrbit 此前无人挂载(死代码),
// 后端仍在广播 subagent:start/end + collab:* → 专家完成播报/协作总结/评审卡
// 整链静默丢失
import { CollabOrbit } from '../../components/CollabOrbit'
// 2026-08-19 三栏联动轮 P2: 审批输入区接管——inline 变体嵌输入区上方(非悬浮卡)
import { ApprovalHost } from '../../components/ApprovalHost'
import { FocusRibbon } from '../../components/FocusRibbon'
import { ORB_FLOAT_DOM_ID } from '../../lib/collab-orbit'
import './styles.css'
// 2026-08-19 排版修复: 对话气泡启用 Markdown 渲染(react-markdown + GFM 已在依赖,
// FileGenPanel 同款用法)——此前纯文本直出, LLM 输出的 **加粗**/- 列表/链接
// 原样显示源码字符, 用户看到"没有格式化排版"。
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown 链接组件: 新窗口打开(react-markdown 默认 <a> 在同一窗口覆盖会话)
function chatMarkdownLink(props: { href?: string; children?: React.ReactNode }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  )
}

const SHELL_VOICE_KEY = 'crabpaw_shell_voice'

// 2026-08-13 key 冲突根治: 模块级单调序号——pushChat/handleHistoryResume/
// holoHistory 共用。此前 pushChat 仅检查与前一条 ts 碰撞,3 条以上同毫秒连发
// 仍产生重复 key(React 警告 "Encountered two children with the same key",
// 可能导致 children 重复/省略)。序号保证同毫秒内递增唯一 + 单调不回拨。
let chatTsLast = 0
let chatTsSeq = 0
function nextChatTs(): number {
  const now = Date.now()
  chatTsLast = Math.max(now, chatTsLast)
  return chatTsLast + chatTsSeq++
}

// 调试子页语音直达映射：voice target → DebugPanel 子页（未命中回退 'logs'）
// 2026-08-19 审计修复: 补 evolution/voice——此前仅 4 项 vs 语音命令拦截列表 6 项不同步,
// 开发者语音「打开进化日志/语音诊断」经 debugTabMap[target] ?? 'logs' 静默降级到 logs 子页
const debugTabMap: Record<string, string> = {
  logs: 'logs', status: 'status', gateway: 'gateway', memory: 'memory',
  evolution: 'evolution', voice: 'voice',
}

// P5.5: 面板确认播报的中文名
function panelLabel(kind: string): string {
  switch (kind) {
    case 'task_panel': return '任务面板'
    case 'news': return '资讯'
    case 'meeting_recording': return '会议面板'
    case 'music': return '音乐播放器'
    case 'weather': return '天气面板'
    case 'hotspot': return '热点面板'
    case 'typhoon': return '台风面板'
    case 'stock': return '股票面板'
    case 'filegen': return '文件生成面板'
    case 'web-preview': return '网页预览'
    case 'document': return '文章卡片'
    default: return '面板'
  }
}

// 2026-08-27 面板禁用开关: 语音直开 weather/stock 绕过了 registry 读面过滤
// (P2 防绕过核查实锤)——按 /api/panels/state 启用态门控, 12s TTL 缓存。
// 查询失败 → 返回 null(不拦截, 由后端 registry 读面兜底); 未知键 → 放行(向后兼容)。
let _panelEnabledCache: { at: number; map: Record<string, boolean> | null } = { at: 0, map: null }
async function checkPanelEnabled(kind: string): Promise<boolean | null> {
  if (!_panelEnabledCache.map || Date.now() - _panelEnabledCache.at > 12000) {
    try {
      const res = await apiGet<{ panels?: { key: string; enabled: boolean }[] }>('/api/panels/state')
      _panelEnabledCache = { at: Date.now(), map: Object.fromEntries((res?.data?.panels || []).map((p): [string, boolean] => [p.key, p.enabled])) }
    } catch (e) {
      console.warn('[shell] 面板启用态查询失败(门控放行):', e)
      return null
    }
  }
  return _panelEnabledCache.map![kind] ?? true
}

interface ShellVoiceConfig extends VoiceConfig {
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
}

// ── 语音配置单源化（2026-08-12）───────────────────────────────────────────
// config.json 的 voice 段是唯一来源：Settings 页写入 / 本组件读取 + 监听更新。
// localStorage 'crabpaw_shell_voice' 仅用于一次性迁移（见 loadShellConfigOnce）。
const SHELL_VOICE_DEFAULTS: ShellVoiceConfig = {
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
function normalizeVoiceSection(v: Record<string, unknown> | undefined | null): ShellVoiceConfig {
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
function voiceSectionForShell(cfg: ShellVoiceConfig): Record<string, unknown> {
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
async function fetchConfigForShell(): Promise<Record<string, unknown> | null> {
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

export function VoiceShell() {
  const [shellConfig, setShellConfig] = useState<ShellVoiceConfig>(SHELL_VOICE_DEFAULTS)
  // ── 智能体显示名：单源来自 cfg.agent.name（SetupWizard/管理舱配置页写入）
  //         默认值 'CrabPaw'——本项目 BossAgent 自身代号，不硬编码第三方品牌名 ──
  // 2026-08-31 M3: 布局模式——simple(三浮动卡片)/advanced(原三栏即时切换,信息零丢失)
  const [layoutMode, setLayoutMode] = useState<'simple' | 'advanced'>(() => {
    try { return localStorage.getItem('voice-shell.layout') === 'advanced' ? 'advanced' : 'simple' } catch { return 'simple' }
  })
  const [layoutResetNonce, setLayoutResetNonce] = useState(0)
  // 2026-08-31: 对话卡可收缩——默认缩起(小胶囊, 点击展开)；持久化
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('voice-shell.chat.collapsed') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('voice-shell.chat.collapsed', chatCollapsed ? '1' : '0') } catch { /* 忽略 */ } }, [chatCollapsed])
  useEffect(() => { try { localStorage.setItem('voice-shell.layout', layoutMode) } catch { /* 忽略 */ } }, [layoutMode])
  // chat 卡片拖动（simple 态）——位置持久化(与音乐卡同模式)
  const chatCardRef = useRef<HTMLDivElement>(null)
  const [chatDragOffset, setChatDragOffset] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem('voice-shell.card.chat')
      if (raw) { const p = JSON.parse(raw); if (p && typeof p.x === 'number' && typeof p.y === 'number') return p }
    } catch { /* 默认 */ }
    return null
  })
  const { handlers: chatDragHandlers } = useDraggable({
    enabled: layoutMode === 'simple',
    offset: chatDragOffset,
    onOffsetChange: setChatDragOffset,
    panelRef: chatCardRef,
  })
  useEffect(() => {
    try { if (chatDragOffset) localStorage.setItem('voice-shell.card.chat', JSON.stringify(chatDragOffset)) } catch { /* 忽略 */ }
  }, [chatDragOffset])
  const [agentDisplayName, setAgentDisplayName] = useState<string>('CrabPaw')
  // 2026-08-25(用户反馈): 对话窗口头像应对齐智能体配置页——activeProfile 的
  // icon(默认 🦀);此前用名字首字(「小」=小龙女首字), 配置页头像形同虚设。
  const [agentDisplayIcon, setAgentDisplayIcon] = useState<string>('🦀')

  // ── 语音配置 + 智能体名：启动从 config.json 同一次加载 ──
  const configLoadedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    const loadShellConfigOnce = async () => {
      try {
        const cfg = await fetchConfigForShell()
        if (cancelled) return
        let voice: Record<string, unknown> = (cfg?.voice as Record<string, unknown>) || {}
        // 平滑迁移：旧 localStorage 配置合并进 config（localStorage 值优先），成功后清除——
        // 一次性迁移，此后 config.json 成为唯一源；写入失败则保留 localStorage 下次重试
        try {
          const raw = localStorage.getItem(SHELL_VOICE_KEY)
          if (raw) {
            const legacy = JSON.parse(raw) as Record<string, unknown>
            voice = { ...voice, ...legacy }
            try {
              await apiPost('/config', { voice })
              localStorage.removeItem(SHELL_VOICE_KEY)
              console.log('[shell] 已迁移 localStorage 语音配置到 config.json（单源化完成）')
            } catch (e) {
              console.error('[shell] 语音配置迁移写入失败，保留 localStorage 待重试:', e)
            }
          }
        } catch (e) {
          console.error('[shell] 语音配置迁移解析失败:', e)
        }
        // ── 2026-08-15 配置自愈(唤醒词失效根因): "默认"模式(pttOnly=false &&
        // continuousMode=false)的语义就是"唤醒词+空格可用", 但持久配置可能出现
        // wakeWordEnabled=false 的不一致组合(如专注模式遗留)——此时 KWS 订阅
        // 永不建立, 唤醒词命中无人消费("说了唤醒词没反应")。启动即修复并回写。
        const healed = normalizeVoiceSection(voice)
        if (!healed.pttOnly && !healed.continuousMode && !healed.wakeWordEnabled) {
          console.warn('[shell] 配置自愈: 默认模式下 wakeWordEnabled=false → 修复为 true')
          healed.wakeWordEnabled = true
          try {
            apiPost('/config', { voice: voiceSectionForShell(healed) }).catch((e) => console.warn('[shell] 配置自愈保存失败:', e?.message || e))
          } catch (e) { console.warn('[shell] 配置自愈回写失败:', e) }
        }
        setShellConfig(healed)
        // 2026-08-31 修复: Jarvis 音效总闸接通真实逻辑——启动按持久化的
        // config.voice.ttsFxEnabled 应用 useSoundEffects 开关(缺省视为开, 与
        // localStorage 默认 behavior 及设置页缺省一致)。
        try {
          setSoundEnabled(healed.ttsFxEnabled !== false)
        } catch (e) { console.warn('[shell] 应用音效开关失败:', e instanceof Error ? e.message : String(e)) }
        // ── 2026-08-14 取消硬编码：agent 名使用配置页真实值 ──
        const agentCfg = cfg?.agent as Record<string, unknown> | undefined
        const cfgName = typeof agentCfg?.name === 'string' && agentCfg.name.trim()
          ? agentCfg.name.trim()
          : null
        if (cfgName) setAgentDisplayName(cfgName)
        // 2026-08-25: 头像同步配置页 activeProfile.icon(失败静默默认 🦀, 不阻塞)
        try {
          const pres = await apiGet('/api/profiles')
          const plist = (pres?.data?.profiles || []) as Array<{ id: string; icon?: string; isDefault?: boolean }>
          const actId = pres?.data?.activeProfile as string | null | undefined
          const p = plist.find(x => actId ? x.id === actId : x.isDefault) || plist[0]
          if (p?.icon) setAgentDisplayIcon(String(p.icon))
        } catch (err: any) { console.warn('[shell] 加载智能体头像失败(默认 🦀):', err?.message || err) }
        configLoadedRef.current = true
      } catch (e) {
        console.error('[shell] 加载语音配置失败，使用默认值:', e)
        setShellConfig(SHELL_VOICE_DEFAULTS)
        configLoadedRef.current = true
      }
    }
    loadShellConfigOnce()
    return () => { cancelled = true }
  }, [])

  // ── 2026-08-14: 后端服务自动启动（AgentHome 删除后自其挂载 effect 迁移）──
  // 非首启默认直达 VoiceShell 后后端无人启动 → 全部 API ECONNREFUSED（G5 遗留缺口）。
  // service:start 内部有端口检查,已运行则直接返回（幂等,可安全重复调用）。
  useEffect(() => {
    ;(async () => {
      try {
        if (window.electronAPI?.service?.start) {
          await window.electronAPI.service.start({ channel: 'none' })
        }
      } catch (e) {
        console.error('[VoiceShell] 后端服务启动失败:', e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  // 监听 Settings 页保存（config-updated / config-updated-voice）→ 重新拉取并刷新
  useEffect(() => {
    const onConfigUpdated = () => {
      if (!configLoadedRef.current) return
      ;(async () => {
        try {
          const cfg = await fetchConfigForShell()
          if (cfg === null) return // 拉取失败：保持当前状态，避免误重置
          setShellConfig(normalizeVoiceSection((cfg.voice as Record<string, unknown>) || {}))
        } catch (e) {
          console.error('[shell] 配置更新事件重载失败:', e)
        }
      })()
    }
    window.addEventListener('config-updated', onConfigUpdated)
    window.addEventListener('config-updated-voice', onConfigUpdated)
    return () => {
      window.removeEventListener('config-updated', onConfigUpdated)
      window.removeEventListener('config-updated-voice', onConfigUpdated)
    }
  }, [])

  // 构建 useVoiceChatFlow 所需的 VoiceConfig
  // P4 style 注入：当前固定 orchestrator 音色；运行时按 activeArchetype 切换待 Task 5 接线（useVoiceChatFlow 尚未暴露 onRoute 回调）
  // personaPrefix 同理 — 当前无 TTS 文本单一组装点，前缀注入随轨道图接线（Task 5）
  const voiceConfig: VoiceConfig = {
    replyEnabled: shellConfig.replyEnabled,
    continuousMode: shellConfig.continuousMode,
    ttsProvider: shellConfig.ttsProvider,
    defaultVoice: shellConfig.defaultVoice,
    speed: shellConfig.speed,
    doubaoVoice: shellConfig.doubaoVoice,
    volcanoVoice: shellConfig.volcanoVoice,
    style: resolveVoiceStyle('orchestrator'),
  }

  // 2026-08-15: muted 派生自 shellConfig(持久化)——重启后保持静音
  const muted = shellConfig.muted === true
  // 2026-08-14: 语速三档高亮（语速配置已从左栏迁移到右上角语音球下方）
  const [speechRate, setSpeechRate] = useState<'low' | 'default' | 'high'>('default')

  // 2026-08-06: 右侧对话卡片——完整对话历史（用户 + AI），可滚动
  // 2026-08-13 P2-1: 增加 tool 角色——工具调用记录行(用户消息后/AI 回复前)
  // 2026-08-19 三栏联动轮: 增加 round 字段——轮次序号(一次用户发送 = 一轮),
  // 三栏联动键(时间线组/对话流消息/右栏工具批按轮对齐)
  // 2026-08-21: 附件字段——用户消息气泡渲染上传的图片/文件
  // （后端 /chat files 协议形状一致：path/name/type/size）
  interface ChatMsgFile { path: string; name: string; size?: number; type?: string }
  // 2026-09-07: channel——消息来源通道标记（'wecom'=企业微信同步镜像），气泡带通道徽标
  interface ChatMsg { role: 'user' | 'ai' | 'tool'; text: string; ts: number; toolId?: string; round?: number; files?: ChatMsgFile[]; channel?: 'wecom' | 'lark' }
  const [conversation, setConversation] = useState<ChatMsg[]>([])
  const conversationRef = useRef<ChatMsg[]>([])
  // 2026-08-19 三栏联动轮: 轮次序号 + 最近一轮(用户消息落轮次, AI 落卡沿用)
  const roundSeqRef = useRef(0)
  const lastUserRoundRef = useRef<number | null>(null)
  // 2026-08-13: 消息反馈(P0-3)——按 ts 记录已反馈状态,失败回滚保持可点
  // (handleMessageFeedback 在 flow 声明之后定义,见 flow 下方)
  const [feedbackMap, setFeedbackMap] = useState<Map<number, 'up' | 'down'>>(new Map())
  const pushChat = useCallback((role: 'user' | 'ai' | 'tool', text: string, toolId?: string, round?: number, files?: ChatMsgFile[], channel?: 'wecom' | 'lark') => {
    const clean = text?.trim() || ''
    if (!clean && (!files || files.length === 0)) return
    // 2026-08-13: ts 定位键——nextChatTs 单调唯一(点赞/点踩按 ts 定位,
    // 同 ms 任意数量连发不碰撞;此前仅查前一条,3 条以上同 ms 仍重复)
    const ts = nextChatTs()
    const next = [...conversationRef.current, { role, text: clean, ts, toolId, round, files: files && files.length > 0 ? files : undefined, channel }]
    conversationRef.current = next
    setConversation(next)
  }, [])

  // ── 2026-09-07: 企微对话同步进对话窗口 ──
  // wecom_sync 模式下后端广播 wecom_message / wecom_reply（chat-handler 步骤 9.5/15）。
  // 此前 GUI 无消费方：TaskPanelHost 只显示带附件的"收到企微文档"卡，纯文本对话在
  // 桌面端无处可见（用户实测"没看到桌面端与企微同步对话内容"）。此处把企微用户消息
  // 与 AI 回复镜像为带"企微"通道徽标的对话气泡（仅独立模式不广播，故无重复风险）。
  useEffect(() => {
    const unsubMsg = subscribeSse('/events', 'wecom_message', (data: any) => {
      if (!data?.content) return
      const fileTag = data.file?.name
        ? `（附件：${data.fileCount && data.fileCount > 1 ? `${data.file.name} 等 ${data.fileCount} 个` : data.file.name}）`
        : ''
      pushChat('user', `${data.content}${fileTag}`, undefined, undefined, undefined, 'wecom')
    })
    const unsubReply = subscribeSse('/events', 'wecom_reply', (data: any) => {
      if (!data?.content) return
      pushChat('ai', data.content, undefined, undefined, undefined, 'wecom')
    })
    return () => { unsubMsg(); unsubReply() }
  }, [pushChat])

  // P7 Task 2: 播报后停留窗口 + 消散动画
  const [postSpeakUntil, setPostSpeakUntil] = useState<number | null>(null)
  const [dissolveSource, setDissolveSource] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [postSpeakSegment, setPostSpeakSegment] = useState<string | null>(null)  // 停留窗口保留最后播报句
  const prevOrbModeRef = useRef<'idle' | 'listening' | 'thinking' | 'speaking'>('idle')
  const captionRef = useRef<HTMLElement | null>(null)  // 消散采样源(字幕区已移除,恒 null 时静默跳过)

  // P7 Task 4: 阶段 TTS 阈值播报——每阈值(30/60/90)只播一次
  const phaseDoneRef = useRef(new Set<number>())
  const speechRef = useRef<ReturnType<typeof useSpeechQueue> | null>(null)
  const handlePhase = useCallback((evt: { phase: string; summary?: string; detail?: string; progress?: number }) => {
    const t = nextPhaseThreshold(evt.progress ?? 0, phaseDoneRef.current)
    if (t !== null) {
      phaseDoneRef.current.add(t)
      speechRef.current?.enqueue({ id: `phase_${t}`, text: phaseText(t, sceneFromPhase(evt.phase)), kind: 'panel' })
    }
    // B6: 移除"progress>=99 即 clear"——deliver 阶段若连续推送多个 ≥99 的 phase 事件,
    // 每次 clear 会让 30/60/90 在空集合上反复触发重播(语音轰炸),违反"每阈值只播一次"。
    // 新会话重置由 handleUserInput 里的 phaseDoneRef.clear() 统一负责。
  }, [])

  const flow = useVoiceChatFlow(voiceConfig, muted, handlePhase)
  // G7: 左右栏真实数据（SSE activity + memory stats + runs/active）
  const monitor = useAgentMonitor()

  // ── 2026-08-14 ag-ui 二次分析：右栏双区块日志分区 ──
  // 2026-08-15 左右日志合并: 右栏历史区块(行动日志/思考与工具)并入左栏全量
  // 事件时间线——此处不再计算分区, 右栏仅保留本轮工具过程(flow.toolEvents)。

  // 2026-08-13: 消息反馈(P0-3)——点赞/点踩落 audit-log,反哺模型调优
  const handleMessageFeedback = useCallback((m: ChatMsg, rating: 'up' | 'down') => {
    if (feedbackMap.has(m.ts)) return
    setFeedbackMap(prev => { const next = new Map(prev); next.set(m.ts, rating); return next })
    apiPost('/api/chat/message-feedback', {
      conversationId: flow.getConversationId(),
      messageTs: m.ts,
      rating,
      text: m.text.slice(0, 500),
    }).catch((err) => {
      console.error('[shell] 消息反馈发送失败:', err)
      setFeedbackMap(prev => { const next = new Map(prev); next.delete(m.ts); return next })
    })
  }, [feedbackMap, flow])

  // ── 本地 KWS 唤醒接入（P0 Electron 唤醒体系） ──
  const { updateState } = useVoiceState()
  // 2026-08-04: KWS 唤醒接入(移植 LiveKit audiolevel)。
  // 2026-08-14: audioLevel 恢复消费——待机期能量源(唤醒前用户说话球体有响应感);
  // 聆听期 probe 被暂停(setMicEnabled(false)),由 useVoiceSession 的
  // crabpaw:voice-energy 事件承担(见 orbMode 推导)。
  // 2026-08-15: 唤醒词禁用态(专注模式)命中 → 语音提示当前模式(30s 节流),
  // 而非静默吞掉——用户喊唤醒词无反应时不再无从知晓原因
  const disabledHitHintAtRef = useRef(0)
  const { resetIdle, audioLevel: kwsAudioLevel } = useKwsWakeWord({
    // 2026-08-24: 语音总开关——muted 时 KWS 唤醒采集/电平广播/命中订阅全停
    // (旧: 仅 TTS 静音, KWS 仍常驻占麦——用户实测「没声音但 ASR 在跑」)
    enabled: shellConfig.wakeWordEnabled && !muted,
    onDisabledHit: () => {
      const now = Date.now()
      if (now - disabledHitHintAtRef.current < 30000) return
      disabledHitHintAtRef.current = now
      try {
        speech.enqueue({ id: `modehint_${now}`, text: shellConfig.pttOnly ? '当前是专注模式，请按住空格说话' : '当前未开启唤醒词，请点击语音球旁的按钮切换模式', kind: 'panel' })
      } catch (e) { console.warn('[shell] 模式提示播报失败:', e) }
    },
    onWake: () => {
      updateState({ voiceSessionActive: true })
      // 2026-08-06: 唤醒词 = 万能打断——先停音乐（关闭面板同时暂停音频），再打断 TTS + 启动会话
      try {
        const w = window as any
        if (typeof w.__closeMusicPanel === 'function') w.__closeMusicPanel()
      } catch (e) { console.error('[shell] 唤醒时关闭音乐失败:', e) }
      // 2026-08-03: 本地 KWS 命中 → 复用 VoiceIntegration 的唤醒处理
      // （__voiceWakeHit = useWakeWord.onHit：打断 TTS + 启动会话）——
      // 此前本地 KWS 命中只更新状态，播报中喊唤醒词无法打断
      try {
        const w = window as any
        if (typeof w.__voiceWakeHit === 'function') w.__voiceWakeHit()
      } catch (e) { console.error('[shell] KWS 唤醒处理失败:', e) }
    },
    onDismiss: () => {
      // R5: KWS 60s 待机退场只在会话未激活时生效。旧实现无条件 stopSession——
      // 而 KWS 的 60s 定时器只在唤醒命中时刷新,会话 active 后不再触发 resetIdle,
      // 定时器必然到期 → 在用户说话/识别时杀掉活跃会话 → 球静默需反复唤醒。
      // 会话已激活(连续对话监听中/TTS 播放中)则忽略退场,由连续对话自身管理生命周期。
      try {
        const cv = (window as any).crabpawVoice
        if (cv && typeof cv.isActive === 'function' && cv.isActive()) {
          console.log('[shell] KWS 空闲退场忽略:会话活跃中')
          return
        }
        if (cv && typeof cv.stop === 'function') cv.stop()
      } catch (e) { console.warn('[shell] KWS onDismiss stopSession 失败:', e) }
      updateState({ voiceSessionActive: false })
    },
  })

  const handleStateChange = useCallback((s: { sessionActive?: boolean }) => {
    if (s.sessionActive) resetIdle()
    // resetIdle 为非稳定引用时接受变化，随 KWS 实例重建
  }, [resetIdle])

  // R5 第二层防御: 识别到文字(recognizing)时刷新 KWS idle 定时器——
  // 用户在说话即活跃,防止 KWS 60s 待机退场在会话进行中误杀
  useEffect(() => {
    if (flow.voiceSessionState === 'recognizing') {
      resetIdle()
    }
  }, [flow.voiceSessionState, resetIdle])

  // 2026-08-04: 布局简化——球永远居中，回复用"字幕式"（球下方一行，说完消失）。
  // 移除左侧对话大卡（内容多时遮挡/排版乱问题）；任务卡存在性事件保留（无副作用）。

  // ── 单源化写入通道：乐观更新本地 state + 异步 POST /api/config（合并 voice 段） ──
  // 写入失败仅 console.error，不阻塞交互（UI 已乐观更新，重启后可能回退到旧值）
  const shellConfigRef = useRef<ShellVoiceConfig>(shellConfig)
  shellConfigRef.current = shellConfig
  const persistShellConfig = useCallback(async (next: ShellVoiceConfig) => {
    try {
      const cfg = await fetchConfigForShell()
      const voice = { ...(cfg?.voice as Record<string, unknown> || {}), ...voiceSectionForShell(next) }
      await apiPost('/config', { voice })
    } catch (e) {
      console.error('[shell] 语音配置持久化失败（UI 已生效）:', e)
    }
  }, [])
  const applyShellConfig = useCallback((patch: Partial<ShellVoiceConfig> | ((v: ShellVoiceConfig) => ShellVoiceConfig)) => {
    const next = typeof patch === 'function' ? patch(shellConfigRef.current) : { ...shellConfigRef.current, ...patch }
    shellConfigRef.current = next
    setShellConfig(next)
    void persistShellConfig(next)
  }, [persistShellConfig])

  // 2026-08-14: 原 toggleContinuous/togglePttOnly 已合并进 cycleMicMode（三态循环按钮）
  const toggleMute = useCallback(() => {
    applyShellConfig(v => ({ ...v, muted: !v.muted }))
  }, [applyShellConfig])

  // 2026-09-05 空格 PTT 体验修复: 静音态按空格自动解除语音总开关(显式解除, 非 toggle)
  const unmute = useCallback(() => {
    applyShellConfig(v => ({ ...v, muted: false }))
  }, [applyShellConfig])

  // 2026-08-14 T-1: frameless 窗口控制（preload 已暴露 electronAPI.window.*,
  // 此前 gui 全目录无调用方——用户只能 Alt+F4/任务栏关窗）
  const handleWindowAction = useCallback((action: 'minimize' | 'maximize' | 'close') => {
    try {
      const win = window.electronAPI?.window
      if (win && typeof win[action] === 'function') {
        win[action]()?.catch?.((e: unknown) => {
          console.warn(`[shell] 窗口 ${action} 调用失败:`, e)
        })
        return
      }
      console.warn(`[shell] 窗口控制不可用（非 Electron 环境）: ${action}`)
    } catch (e) {
      console.error(`[shell] 窗口 ${action} 调用异常:`, e)
    }
  }, [])

  // 2026-08-14: 语速三档（低/默认/高）——迁移自左栏，点击语音球下方按钮切换 + 持久化 speed
  const setSpeechRateLevel = useCallback((rate: 'low' | 'default' | 'high') => {
    setSpeechRate(rate)
    applyShellConfig(v => ({ ...v, speed: rate === 'high' ? 1.3 : rate === 'low' ? 0.7 : 1 }))
  }, [applyShellConfig])

  // 2026-08-14: 语音模式三态循环（DingDong MicModeButton 对齐）——
  // 默认(唤醒词+空格) → 专注(仅空格) → 实时(连续对话) → 默认。
  // 原输入框上方"静音/连续对话/专注"三按钮合并为此按钮;静音保留为点击语音球。
  const micMode: 'default' | 'focus' | 'live' = shellConfig.pttOnly
    ? 'focus'
    : shellConfig.continuousMode
      ? 'live'
      : 'default'
  const cycleMicMode = useCallback(() => {
    const enqueue = (text: string) => {
      try { speechRef.current?.enqueue({ id: `mic_${Date.now()}`, text, kind: 'panel' }) } catch (err) {
        console.error('[shell] 模式切换播报失败:', err)
      }
    }
    if (shellConfig.pttOnly) {
      // 专注 → 实时（连续对话）
      applyShellConfig(v => ({ ...v, pttOnly: false, continuousMode: true, wakeWordEnabled: false }))
      enqueue('已切换到实时监听，连续对话模式')
    } else if (shellConfig.continuousMode) {
      // 实时 → 默认（唤醒词 + 空格）
      applyShellConfig(v => ({ ...v, continuousMode: false, wakeWordEnabled: true }))
      enqueue('已切换到默认模式，唤醒词与空格对话可用')
    } else {
      // 默认 → 专注（仅空格）
      applyShellConfig(v => ({ ...v, pttOnly: true, continuousMode: false, wakeWordEnabled: false }))
      enqueue('已切换到专注模式，仅按住空格说话')
    }
  }, [shellConfig.pttOnly, shellConfig.continuousMode, applyShellConfig])

  // P5.5: 共享播报队列（面板确认播报 + CollabOrbit 协作播报共用，防双音）
  // 2026-08-14: 播报队列跟随用户 TTS 配置(音色/语速)——此前 hook 内硬编码
  // zh-CN-XiaoxiaoNeural/1.0,Settings 修改对面板确认/阶段播报等队列播报不生效
  const speech = useSpeechQueue({ isTtsPlaying: flow.ttsPlaying || flow.isSpeaking, muted, voice: shellConfig.defaultVoice, speed: shellConfig.speed })
  // P7 Task 4: 将 speech 实例写入 ref，供阶段播报回调使用（hooks 顺序约束：speech 在 flow 之后）
  speechRef.current = speech

  // 2026-08-17 R2-3: 全局播报事件（FileGenPanel done 自动重开时播报"文档已生成"）——
  // 复用 speechRef.enqueue（阶段播报同款通道，muted 时 enqueue 2min 自动过期丢弃）
  useEffect(() => {
    const onSpeak = (ev: any) => {
      const d = ev?.detail
      if (d?.text) {
        speechRef.current?.enqueue({ id: d.id || `speak_${Date.now()}`, text: d.text, kind: 'panel' })
      }
    }
    window.addEventListener('crabpaw:speak', onSpeak)
    return () => window.removeEventListener('crabpaw:speak', onSpeak)
  }, [])

  // 切到静音时立即停止当前播报（副作用与状态变化解耦，符合 React 并发语义）
  useEffect(() => {
    if (muted && (flow.ttsPlaying || flow.isSpeaking)) {
      flow.stopSpeaking()
    }
  }, [muted, flow.ttsPlaying, flow.isSpeaking])

  // 2026-08-14: 聆听期能量(ASR 采集侧)——useVoiceSession 1s 节流广播 crabpaw:voice-energy
  // (KWS probe 在会话期间被暂停,主进程 wake:audio-level 停摆,需此第二信号源)
  const [asrEnergy, setAsrEnergy] = useState<KwsAudioLevel | null>(null)
  useEffect(() => {
    const onEnergy = (e: Event) => {
      const d = (e as CustomEvent<{ level?: number; active?: boolean }>).detail
      if (!d || typeof d.level !== 'number') return
      const lv = Math.min(1, Math.max(0, d.level))
      const act = !!d.active
      // 值未变化返回同引用,避免 1Hz 广播无谓重渲染整个 VoiceShell
      setAsrEnergy(prev => (prev && prev.level === lv && prev.active === act) ? prev : { level: lv, active: act })
    }
    window.addEventListener('crabpaw:voice-energy', onEnergy)
    return () => window.removeEventListener('crabpaw:voice-energy', onEnergy)
  }, [])

  // 由语音会话状态推导球体模式（2026-08-24 语义统一，纯函数见 lib/voice-orb-state）：
  //   关闭态(muted 语音总开关) → 静态白球(idle)
  //   语音开启态(唤醒/实时/PTT 任一策略或会话激活) → 绿(listening), 强弱由音量驱动
  //   发声 → 蓝(speaking, 优先级高于思考); LLM 处理 → 橙(thinking)
  const orbMode = useMemo<'idle' | 'listening' | 'thinking' | 'speaking'>(() => {
    return deriveOrbMode({
      muted,
      ttsPlaying: flow.ttsPlaying,
      isSpeaking: flow.isSpeaking,
      queuePlaying: speech.isPlaying,
      pending: flow.pending,
      voiceSessionActive: flow.voiceSessionActive,
      wakeArmed: shellConfig.wakeWordEnabled && !muted,
      continuousMode: shellConfig.continuousMode && !muted,
      pttOnly: shellConfig.pttOnly && !muted,
    })
  }, [muted, flow.ttsPlaying, flow.isSpeaking, flow.pending, flow.voiceSessionActive, speech.isPlaying, shellConfig.wakeWordEnabled, shellConfig.continuousMode, shellConfig.pttOnly])

  // 2026-08-24: 绿态波动幅度 = 能量电平(listening 期取 ASR 采集侧, 待机取 KWS 侧;
  // 关闭态恒 0——白球完全静止)。电平只驱动幅度不切换 mode——旧实现把 active 当
  // 模式分叉用, 导致实时模式安静时球变白、关闭态被 KWS 电平点亮。
  const orbVolume = useMemo(() => deriveOrbVolume({
    muted,
    voiceSessionActive: flow.voiceSessionActive,
    asrLevel: asrEnergy?.level ?? null,
    kwsLevel: kwsAudioLevel?.level ?? null,
  }), [muted, flow.voiceSessionActive, asrEnergy, kwsAudioLevel])

  // 2026-08-06: AI 回复完成 → push 到右侧对话卡片。
  // 时机: aiText 非空 + 回复流已结束(replyCompleted) + TTS 播放结束(或未启用 TTS)。
  // 2026-08-07: 新增 replyCompleted 条件——此前仅靠"TTS 播放间隙"判断,
  // PTT 打断 TTS 时半截 aiText 被 push,回复完整后再 push → 卡片内容重复分段
  // （用户反馈"一个回答分了几次回答,每次一段逐步增多"根因）。
  const lastAiPushedRef = useRef('')
  useEffect(() => {
    const aiTextNow = flow.aiText || ''
    // 回复流未结束或 TTS 播放中或仍在 pending → 等完成
    if (!flow.replyCompleted || flow.ttsPlaying || flow.isSpeaking || flow.pending) return
    // 2026-08-14(用户反馈): 工具调用记录不再进对话卡——工具逻辑已由侧栏承载
    // (右栏"工具执行"状态卡 flow.toolEvents)。对话窗口保持纯消息线程(AG-UI 语义:
    // message thread 与 tool events 分离)。无 AI 文本的纯工具任务不落对话卡。
    if (!aiTextNow.trim()) return
    // 避免重复 push（同一条 aiText 只 push 一次）
    if (lastAiPushedRef.current === aiTextNow) return
    lastAiPushedRef.current = aiTextNow
    // 2026-08-19 三栏联动轮: AI 落卡带轮次(最近一轮的 round, 与时间线/工具批对齐)
    pushChat('ai', aiTextNow, undefined, lastUserRoundRef.current ?? undefined)
    // 新对话开始时 reset（aiText 清空时）
    if (!aiTextNow) lastAiPushedRef.current = ''
  }, [flow.aiText, flow.replyCompleted, flow.ttsPlaying, flow.isSpeaking, flow.pending, flow.toolEvents, pushChat])

  // ── 2026-08-19 三栏联动轮: 工具批历史(对话流工具链回看数据源) ──
  // flow.toolEvents 每轮清空重填(sendText 清空)——清空即旧批收官, 归档到轮次。
  // 归档轮次: 清空发生在下一轮 sendText 后(round 已递增), 旧批属上一轮。
  // 上限 20 批(环形裁剪, 防长会话无界增长)。
  type FlowToolEvent = (typeof flow.toolEvents)[number]
  const toolBatchesRef = useRef<Array<{ round: number; events: FlowToolEvent[] }>>([])
  const activeBatchRef = useRef<FlowToolEvent[] | null>(null)
  useEffect(() => {
    const cur = flow.toolEvents
    if (cur.length === 0) {
      if (activeBatchRef.current && activeBatchRef.current.length > 0) {
        const batchRound = Math.max(1, (lastUserRoundRef.current ?? 1) - 1)
        toolBatchesRef.current = [...toolBatchesRef.current, { round: batchRound, events: activeBatchRef.current }].slice(-20)
      }
      activeBatchRef.current = null
    } else {
      activeBatchRef.current = cur
    }
  }, [flow.toolEvents])
  /** 按轮取工具批(当前轮优先, 历史次之)——工具链回看按钮数据源 */
  const getToolBatch = useCallback((round: number) => {
    if (round === lastUserRoundRef.current && activeBatchRef.current) return activeBatchRef.current
    return toolBatchesRef.current.find(b => b.round === round)?.events ?? null
  }, [])

  // ── 2026-08-19 三栏联动轮: 工具链展开(Set<消息 ts>——AI 消息旁 ⛓ 按钮) ──
  const [toolchainOpenTs, setToolchainOpenTs] = useState<Set<number>>(new Set())
  const toggleToolchain = useCallback((ts: number) => {
    setToolchainOpenTs(prev => {
      const next = new Set(prev)
      if (next.has(ts)) next.delete(ts)
      else next.add(ts)
      return next
    })
  }, [])
  // ── 2026-08-19 三栏联动轮: thinking 折叠(思维条长文本点击展开) ──
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  useEffect(() => { if (!flow.currentThinking) setThinkingExpanded(false) }, [flow.currentThinking])

  // ── 2026-08-19 三栏联动轮 P2: 待审批数(inline ApprovalHost 通知)——>0 时接管输入区 ──
  const [approvalPendingCount, setApprovalPendingCount] = useState(0)

  // ── B3(2026-09-05): agent 注意带——极简布局下执行层状态唯一常驻通道。
  // 输入与 orbMode 同口径(muted/策略门控一致), 增量仅 flow.toolEvents(running)
  // 与 approvalPendingCount; 状态词与配色见 FocusRibbon/deriveAgentFocus。 ──
  const focusState = useMemo(() => {
    const runningTools = flow.toolEvents.filter(t => t.status === 'running')
    return deriveAgentFocus({
      pendingApprovals: approvalPendingCount,
      toolRunning: runningTools.length,
      muted,
      ttsPlaying: flow.ttsPlaying,
      isSpeaking: flow.isSpeaking,
      queuePlaying: speech.isPlaying,
      pending: flow.pending,
      voiceSessionActive: flow.voiceSessionActive,
      wakeArmed: shellConfig.wakeWordEnabled && !muted,
      continuousMode: shellConfig.continuousMode && !muted,
      pttOnly: shellConfig.pttOnly && !muted,
    })
  }, [approvalPendingCount, flow.toolEvents, flow.ttsPlaying, flow.isSpeaking, flow.pending,
    flow.voiceSessionActive, speech.isPlaying, muted,
    shellConfig.wakeWordEnabled, shellConfig.continuousMode, shellConfig.pttOnly])
  const focusRunningTool = useMemo(
    () => flow.toolEvents.filter(t => t.status === 'running').slice(-1)[0] ?? null,
    [flow.toolEvents],
  )

  // ── 2026-08-19 三栏联动轮: 联动轮次(时间线/对话流/右栏三向高亮+定位) ──
  const [linkedRound, setLinkedRound] = useState<number | null>(null)
  /** 联动定位: 高亮三栏对应轮 + 中栏滚动到该轮 user 消息(主动定位打破回底) */
  const linkRound = useCallback((round: number) => {
    setLinkedRound(round)
    const el = chatMessagesRef.current
    if (!el) return
    const roundEl = el.querySelector<HTMLElement>(`[data-round="${round}"]`)
    if (!roundEl) return
    roundEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
    chatAtBottomRef.current = false
    setChatAtBottom(false)
  }, [])

  // ── 2026-08-14 C-1 修复: 流式回复文本增量可见 ──
  // flow.aiText 在流式过程（onChunk → setAiText(accumulated)）中持续累积,
  // 此前只在"回复完成 + TTS 播完"后由上方 effect 落卡——静音模式整段流期间
  // 中栏零可见文本(10-30s 静默)。现在流式中直接渲染为带 ▌ 光标的流式气泡;
  // 定稿条件满足后上方 effect 落卡(lastAiPushedRef 更新)→ 依赖 conversation
  // 重算, 气泡随定稿消失, 不闪烁不重复。TTS 播报中文本保持可见(气泡存在)。
  const streamingAiText = useMemo(() => {
    const t = flow.aiText || ''
    if (!t) return ''
    if (lastAiPushedRef.current === t) return '' // 已定稿落卡
    return t
  }, [flow.aiText, flow.replyCompleted, flow.ttsPlaying, flow.isSpeaking, flow.pending, conversation])

  // 流式气泡随 chunk 增量更新 → 自动滚到底部保持最新文本可见
  // 2026-08-14 ag-ui 二次分析: 自动滚动尊重用户上翻(读历史时不被拽回底部,
  // Kotlin MessageList 同口径); 离开底部显示回底按钮(copilot-scroll-to-bottom 语义)
  const chatMessagesRef = useRef<HTMLDivElement | null>(null)
  const chatAtBottomRef = useRef(true)
  const [chatAtBottom, setChatAtBottom] = useState(true)
  const handleChatScroll = useCallback(() => {
    const el = chatMessagesRef.current
    if (!el) return
    // 与 Logs 页同阈值: 距底部 <40px 视为"在底部"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    chatAtBottomRef.current = atBottom
    setChatAtBottom(atBottom)
  }, [])
  const scrollChatToBottom = useCallback(() => {
    const el = chatMessagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    chatAtBottomRef.current = true
    setChatAtBottom(true)
  }, [])
  useEffect(() => {
    const el = chatMessagesRef.current
    if (el && chatAtBottomRef.current) el.scrollTop = el.scrollHeight
  }, [conversation, streamingAiText])

  // ── P7 Task 5: 订阅 SceneShell surface 数据（主区域全息场景层） ──
  // useSceneSurfaces 使用模块级共享缓存（surfaceCache/manifestSubs），与 SceneShell/App 共存无冲突
  const { surfaces } = useSceneSurfaces()

  // ── 2026-08-08: 网页生成完成 → 自动打开系统浏览器预览 ──
  // 用户期望流程: 提需求 → 回复收到 → 执行 → 显示过程 → 自动打开浏览器。
  // 检测到新 web-preview surface(local:// URL)即用 file:open 打开默认浏览器
  // (主进程侧有 DATA_DIR/项目目录白名单 + 敏感文件黑名单校验)。
  const openedPreviewRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const wp = surfaces.find(s => s.kind === 'web-preview')
    const url = wp?.data?.url
    if (typeof url !== 'string' || !url.startsWith('local://') || openedPreviewRef.current.has(url)) return
    openedPreviewRef.current.add(url)
    // local:///D:/path → D:/path（反斜杠供主进程 path 处理）
    const filePath = url.replace(/^local:\/\//, '').replace(/^\//, '').replace(/\//g, '\\')
    try {
      window.electronAPI?.file?.open(filePath)?.then?.((r: { success?: boolean; error?: string }) => {
        if (r && r.success === false) console.warn('[auto-open] 打开网页预览失败:', r.error)
      })
    } catch (err) {
      console.warn('[auto-open] 自动打开预览失败:', err instanceof Error ? err.message : String(err))
    }
  }, [surfaces])

  // 2026-08-13 事件断链修复: crabpaw:open-browser —— TaskPanelHost 收到 file_generated
  // (HTML) 广播(detail: { path } 纯文件路径,非 local:// URL)→ 自动打开系统浏览器预览。
  // 此前无监听方 → 可视化文件生成后无自动预览。复用 web-preview 的 file.open 链路
  // (主进程侧白名单/黑名单校验同样生效);path 直接透传,不做 local:// 前缀转换。
  useEffect(() => {
    const onOpenBrowser = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const path = typeof detail?.path === 'string' ? detail.path : ''
      if (!path) return
      try {
        window.electronAPI?.file?.open(path)?.then?.((r: { success?: boolean; error?: string }) => {
          if (r && r.success === false) console.warn('[open-browser] 打开文件失败:', r.error)
        })
      } catch (err) {
        console.warn('[open-browser] 自动打开浏览器失败:', err instanceof Error ? err.message : String(err))
      }
    }
    window.addEventListener('crabpaw:open-browser', onOpenBrowser)
    return () => window.removeEventListener('crabpaw:open-browser', onOpenBrowser)
  }, [])
  // 2026-08-08 (用户反馈): 过滤常驻低信息卡 memory_graph/session_list——
  // 语音球上方横条(记忆图+会话列表)多余;真实场景推送卡(网页预览/媒体/briefing)保留
  // P6(GUI 全量修复 P1): 过滤改按 id——hotspot-panel 是全屏面板专用 surface
  // (HotspotPanel 订阅), 而 ShowHotspot(format=scene) 推 id hotspot_<platform>
  // 的场景卡(热榜列表)应进卡片墙; 旧实现按 kind 过滤把两者都滤掉
  // 2026-08-16 实机修复: home.* 前缀的 scene-bridge 遥测(记忆图/会话列表/记忆总数)
  // 是 Home 页数据投影, 不该出现在对话层卡片墙——memory_stats(kind 'metric')此前
  // 因 store() 遮蔽 bug 从未推送, 修复后首次暴露, 显示"896 记忆总数"且无法关闭。
  // 按 id 前缀统一过滤, 不影响 agent 主动推的 SceneMetric 指标卡。
  // 2026-08-17 实机修复: 面板专用 surface 一律过滤——常驻面板组件已各自订阅
  // (StockPanel→stock-panel, FileGenPanel→file-panel 等), 漏进卡片墙会被
  // SceneSurfaceRenderer 按 kind 渲染成对话窗口内的小卡("对话窗口中间的小股票
  // 卡片"根因: StockQuery 发 stocks-card 被 kinds/stocks.tsx 渲染成中央舞台小卡)。
  // 场景推送卡(web-preview/briefing/document/hotspot_<platform>/媒体)保留。
  const PANEL_SURFACE_IDS = new Set([
    'stock-panel', 'stocks-card', 'stocks-kline',
    'typhoon-panel', 'hotspot-panel', 'weather-panel',
    'file-panel', 'music-player',
    'business-panel',
    // 2026-08-18: 'typhoon'（TyphoonQuery 发的旧小卡 surface）也过滤——
    // 台风问题统一走 ShowTyphoon → 'typhoon-panel' 大面板，小卡彻底不渲染。
    'typhoon',
  ])
  const stageSurfaces = useMemo(
    () => surfaces.filter(s => !s.id.startsWith('home.') && !PANEL_SURFACE_IDS.has(s.id)),
    [surfaces],
  )
  // 2026-08-12 修复: 场景卡本地关闭通道。单界面迁移后 SceneShell 不再挂载,
  // __sceneShell 全局接口(语音关闭依赖)成为死代码 → 场景卡无法语音关闭。
  // 在此重建: dismissedIds 本地即时隐藏,恢复 setVisible/closeTop 契约。
  // 键 = id + 数据指纹——智能体重新生成同 id 卡(新文章)时指纹变化 → 旧关闭
  // 记录不遮蔽新卡片(旧 SceneShell 用 _instanceKey 解决的同类问题)。
  const dismissKey = useCallback((s: Surface) => `${s.id}@${JSON.stringify(s.data)}`, [])
  // 2026-08-20 弹卡治理: dismiss 记录持久化到 localStorage。
  // 此前 sceneEpoch(后端重启/重连全量重推)会清空 dismissedIds → 用户已要求
  // 清除的卡片全部复活。现改为跨重启保留: 同指纹卡保持关闭,新数据卡(新指纹)
  // 照常出现。持久化逻辑见 lib/surface-utils(上限 300 条防膨胀)。
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(loadDismissedKeys)
  // 变更即落盘——已清除的卡片跨重启/重连保持关闭
  useEffect(() => { saveDismissedKeys(dismissedIds) }, [dismissedIds])
  const dismissSurface = useCallback((s: Surface) => {
    setDismissedIds(prev => {
      const next = new Set(prev)
      next.add(dismissKey(s))
      return next
    })
  }, [dismissKey])
  const visibleSurfaces = useMemo(
    () => stageSurfaces.filter(s => !dismissedIds.has(dismissKey(s))),
    [stageSurfaces, dismissedIds, dismissKey],
  )
  // 2026-08-20 弹卡治理: 对话窗口卡片墙不渲染纯文本 kind(text/info)。
  // reminder/proactive 的文本卡此前以裸文本形式出现在 holo-stage 卡片墙,
  // 属"临时文本卡片"。过滤后提醒消息仍走对话流(AI 消息),不再以卡片出现。
  // 注意: 过滤在渲染层,不影响 dismiss/closeTop 契约。判定见 lib/surface-utils。
  const cardWallSurfaces = useMemo(
    () => visibleSurfaces.filter(s => isCardWallKind(s.kind)),
    [visibleSurfaces],
  )
  // B1(2026-09-05) 卡片墙渐进收纳——纯视觉层: 墙上卡片超过 4 张时, ambient 档
  // 收进缩略条(kind 图标 + 摘要首行), 点击展开。只改渲染, 不动 surface 生命周期
  // (scene-client 缓存/dismiss 契约零接触, patch/resync 不会"复活"或丢状态)。
  // confront/inform 保持展开(戏剧强度契约); 交互类卡(choice/form)在渲染器内独占。
  const HOLO_STACK_LIMIT = 4
  const [holoStackExpanded, setHoloStackExpanded] = useState<Set<string>>(new Set())
  // surface 消失后清掉展开记录, 防 Set 泄漏
  useEffect(() => {
    setHoloStackExpanded(prev => {
      if (prev.size === 0) return prev
      const alive = new Set(cardWallSurfaces.map(s => s.id))
      const next = new Set([...prev].filter(id => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [cardWallSurfaces])
  const holoStacked = useMemo(
    () => (cardWallSurfaces.length <= HOLO_STACK_LIMIT
      ? []
      : cardWallSurfaces.filter(s => (s.intent ?? 'inform') === 'ambient' && !holoStackExpanded.has(s.id))),
    [cardWallSurfaces, holoStackExpanded],
  )
  const holoExpanded = useMemo(() => {
    const stacked = new Set(holoStacked.map(s => s.id))
    return cardWallSurfaces.filter(s => !stacked.has(s.id))
  }, [cardWallSurfaces, holoStacked])
  // 2026-08-13: confront 压暗(参考实现借鉴)——存在 confront 级卡片时背景压暗、
  // 聚焦中央决策。基于 dismissed 过滤后的 visibleSurfaces，已关闭的卡不保留压暗。
  const hasConfront = useMemo(
    () => visibleSurfaces.some(s => s.intent === 'confront'),
    [visibleSurfaces],
  )
  // 2026-08-12: 文章/网页预览类卡片 → 左侧阅读面板（不遮盖中央语音球）；
  // 其余场景卡仍走中央全息舞台。contract 为 document 变体（条款纸页）同归面板。
  const ARTICLE_KINDS = new Set(['web-preview', 'document', 'contract'])
  const articleSurfaces = useMemo(
    () => visibleSurfaces.filter(s => ARTICLE_KINDS.has(s.kind)),
    [visibleSurfaces],
  )
  // 2026-08-17: 结果卡出现 → FileGenPanel 自动退场（原 DocReader reading 阶段同款逻辑,
  // 2026-08-12 起两条管线冗余: 生成面板(SSE 驱动) + web-preview 卡(后端推送)——同一篇文章显示两次。
  // 职责划分: 生成面板 = 过程可视化; 结果卡 = 结果展示。仅当面板空态或任务已 done
  // 才自动关闭; 生成中(collect/writing/converting)不关,过程可视化不中断。
  const seenArticleKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const s of articleSurfaces) {
      const key = dismissKey(s)
      if (seenArticleKeysRef.current.has(key)) continue
      seenArticleKeysRef.current.add(key)
      try {
        const fp = getCommandHost('filePanel')
        if (fp && typeof fp.isOpen === 'function' && fp.isOpen()) {
          const t = typeof fp.getTask === 'function' ? fp.getTask() : null
          if (!t || !t.taskId || t.phase === 'done') {
            fp.close()
            console.log('[shell] 结果卡出现,文件生成面板自动退场')
          }
        }
      } catch (e) {
        console.error('[shell] 自动关闭文件生成面板失败:', e)
      }
    }
  }, [articleSurfaces, dismissKey])
  // __sceneShell 契约恢复（对齐旧 SceneShell 语义: setVisible 开关指定 kind, closeTop 关最上层）
  useEffect(() => {
    const api = {
      setVisible: (kind: string, visible: boolean): boolean => {
        const hasKind = stageSurfaces.some(s => s.kind === kind)
        setDismissedIds(prev => {
          const next = new Set(prev)
          for (const s of stageSurfaces) {
            if (s.kind !== kind) continue
            if (visible) next.delete(dismissKey(s))
            else next.add(dismissKey(s))
          }
          return next
        })
        return hasKind
      },
      closeTop: () => {
        const top = visibleSurfaces[visibleSurfaces.length - 1]
        if (top) dismissSurface(top)
      },
    }
    // A1(2026-09-05): 经 ui-command-registry 注册(旧 window.__sceneShell 退役)
    const unregisterScene = registerCommandHost('sceneShell', api)
    return () => { unregisterScene() }
  }, [stageSurfaces, visibleSurfaces, dismissSurface, dismissKey])
  // G9: 原 I2 场景语义色 orbTint/orbVariant（含 latestSurface 中间量）已删——
  // 语音球/点云已移除后无消费；tintForWeather 随之不再引用。

  // P7 Task 5: surface 可见性——播报中或停留窗口期内保持显示；idle + 停留期结束隐藏
  // ── P7 Task 2: speaking→idle 跳变 → 启动 3s 停留窗口（合并 ref-sync + 检测，修复顺序 bug） ──
  // B6: 用 ref 保留最后非空播报句——orbMode 变 idle 时 onComplete 已把
  // flow.speakingSegment 置空,读它恒得 null(停留窗口从不显示、历史写占位)。ref 在
  // speakingSegment 更新时同步,保证 speaking→idle 时能取到真正播过的句。
  const lastSpokenSegmentRef = useRef<string | null>(null)
  useEffect(() => {
    if (flow.speakingSegment) lastSpokenSegmentRef.current = flow.speakingSegment
  }, [flow.speakingSegment])

  useEffect(() => {
    const prev = prevOrbModeRef.current
    prevOrbModeRef.current = orbMode
    if (prev === 'speaking' && orbMode === 'idle') {
      setPostSpeakUntil(Date.now() + 3000)
      // 快照当前播报句，停留窗口期间保持显示
      setPostSpeakSegment(lastSpokenSegmentRef.current)
    }
  }, [orbMode, flow.speakingSegment])

  // ── P7 T2 审查: 新语音/聆听/思考 取消停留与消散 ──
  useEffect(() => {
    if (orbMode !== 'idle') {
      setPostSpeakUntil(null)
      setDissolveSource(null)
    }
  }, [orbMode])

  // ── P7 T2 审查: 消散触发 helper（去重 rect 采样） ──
  const triggerDissolve = () => {
    const el = captionRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setDissolveSource({ x: r.left, y: r.top, w: r.width, h: r.height })
    }
  }

  // ── P7 Task 2: 3s 停留后触发消散动画 ──
  useEffect(() => {
    if (postSpeakUntil === null) return
    const remaining = postSpeakUntil - Date.now()
    if (remaining <= 0) {
      triggerDissolve()
      setPostSpeakUntil(null)
      return
    }
    const timer = setTimeout(() => {
      triggerDissolve()
      setPostSpeakUntil(null)
    }, remaining)
    return () => clearTimeout(timer)
  }, [postSpeakUntil])

  // P7 Task 10: 历史区 state（消费 __pushHoloHistory，最多保留 3 条）
  const [holoHistory, setHoloHistory] = useState<Array<{ kind: string; summary: string; ts: number }>>([])
  // 历史区点击展开摘要卡
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null)

  // P7 Task 2 + Task 10: window.__pushHoloHistory —— push + 截断 3 条
  useEffect(() => {
    // A1: 经 ui-command-registry 注册(旧 window.__pushHoloHistory 退役)
    const unregisterHoloHistory = registerCommandHost('pushHoloHistory', {
      push: (kind: string, summary: string) => {
        setHoloHistory(prev => {
          const next = [{ kind, summary, ts: nextChatTs() }, ...prev]
          return next.slice(0, 3)
        })
      },
    })
    return () => { unregisterHoloHistory() }
  }, [])

  // M3: 点击历史摘要卡外部区域关闭卡片
  useEffect(() => {
    if (expandedHistory === null) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.holo-history-item')) {
        setExpandedHistory(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [expandedHistory])

  // ── 2026-08-04: 文本对话与附件（默认界面补充）──
  // 阶段 B: 管理舱（设置/插件/技能/用量/调试）——配置功能归入管理舱 settings tab
  //（2026-08-12: 移除独立 ⚙ 配置面板,顶部按钮重复,避免双浮层与双份脏检查）
  const [cockpitVisible, setCockpitVisible] = useState(false)
  const [cockpitTab, setCockpitTab] = useState<CockpitTab>('overview')
  const [cockpitNavSection, setCockpitNavSection] = useState<string | null>(null)
  const [cockpitDebugTab, setCockpitDebugTab] = useState<string>('logs')
  // 2026-08-27 全局搜索: crabpaw:open-cockpit detail.keyword → 透传面板 initialKeyword
  const [cockpitKeyword, setCockpitKeyword] = useState<string | null>(null)
  // 2026-08-15: 右栏多服务连接状态——/health services 轮询 + KWS fatal 事件
  const [healthServices, setHealthServices] = useState<{
    ai?: { configured?: boolean }
    wecom?: { configured?: boolean; connected?: boolean }
    lark?: { configured?: boolean; connected?: boolean }
  } | null>(null)
  const [voiceEngineFatal, setVoiceEngineFatal] = useState(false)
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const res = await apiGet<{ services?: typeof healthServices }>('/health')
        if (!stopped && res?.data?.services) setHealthServices(res.data.services)
      } catch (e) {
        console.warn('[shell] 服务状态拉取失败:', (e as Error)?.message || e)
      }
    }
    load()
    const t = setInterval(load, 60000)
    return () => { stopped = true; clearInterval(t) }
  }, [])
  useEffect(() => {
    const onFatal = () => setVoiceEngineFatal(true)
    window.addEventListener('crabpaw:kws-fatal', onFatal)
    return () => window.removeEventListener('crabpaw:kws-fatal', onFatal)
  }, [])
  // Task 13: 会话历史抽屉
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false)
  // A2(2026-09-05): 管理舱/历史抽屉并入 sheet-state 互斥——与 11 个 SideSheet 面板
  // 同一互斥位, 打开任一方自动关闭另一方(activateOverlay/activateSheet 内部互斥),
  // 替代原先散落在命令处理器/按钮 onClick 里的 if(cockpitVisible)/if(historyDrawerOpen)
  // 手动跨排斥检查。overlay 档不做 body 布局联动(全屏浮层无让位语义)。
  useEffect(() => {
    if (!cockpitVisible) return
    const unregister = activateOverlay('cockpit', () => setCockpitVisible(false))
    return () => { closeSheet('cockpit'); unregister() }
  }, [cockpitVisible])
  useEffect(() => {
    if (!historyDrawerOpen) return
    const unregister = activateOverlay('history-drawer', () => setHistoryDrawerOpen(false))
    return () => { closeSheet('history-drawer'); unregister() }
  }, [historyDrawerOpen])
  // 2026-08-14 P2-图例2: 大面板(热点/台风,70vw)打开时,主布局 holo-stage 与 chat-row 自动让出空间
  // 监听 HotspotPanel/TyphoonPanel 广播的 crabpaw:hotspot-panel-visibility 事件
  // 2026-08-14: 按 name 聚合——两面板互斥切换时事件顺序不定,单 bool 会被先到的
  // "关闭"事件错误清零(如开台风顶掉热点: hotspot关→typhoon开 顺序颠倒则布局错乱)
  const [hotspotPanelOpen, setHotspotPanelOpen] = useState(false)
  const bigPanelStateRef = useRef<{ [name: string]: boolean }>({})
  useEffect(() => {
    const onVisible = (e: Event) => {
      const ce = e as CustomEvent<{ visible?: boolean; name?: string }>
      const name = ce.detail?.name || 'hotspot'
      bigPanelStateRef.current[name] = !!ce.detail?.visible
      setHotspotPanelOpen(Object.values(bigPanelStateRef.current).some(Boolean))
    }
    window.addEventListener('crabpaw:hotspot-panel-visibility', onVisible as any)
    return () => window.removeEventListener('crabpaw:hotspot-panel-visibility', onVisible as any)
  }, [])

  // Esc 关闭浮层：历史抽屉直接关；管理舱 Esc 由 ManagementCockpit 内部
  // 处理（走 requestClose 脏检查），此处不再重复
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && historyDrawerOpen) {
        setHistoryDrawerOpen(false)
        return
      }
      // 2026-08-12 (P2-8): 全局 ESC 关闭最上层场景卡（__sceneShell.closeTop，无卡时静默 no-op）。
      // 条件守卫避免抢其他浮层的 ESC：
      //  - 输入框/文本域聚焦时不拦截（输入场景的 ESC 用于取消/清空）
      //  - 管理舱/音乐播放器打开时不拦截（各自组件自行处理 ESC）
      // 2026-08-15 参考实现对齐: 面板快捷键 h/t/s/w/m——统一豁免规则
      // (输入聚焦/修饰键组合不触发; 参考实现 V/H/M + input 豁免同款语义)
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const aePanel = document.activeElement
        const inInputPanel = aePanel instanceof HTMLElement
          && (aePanel.tagName === 'INPUT' || aePanel.tagName === 'TEXTAREA' || aePanel.isContentEditable)
        if (!inInputPanel) {
          const key = e.key.toLowerCase()
          // B2(2026-09-05): 快捷键与 CommandPalette 同一命令源(command-defs)——
          // toggle 语义在 def 上声明, 新增快捷键不再碰本 handler
          const def = COMMAND_DEFS.find(d => d.shortcut === key)
          if (def) {
            e.preventDefault()
            try {
              if (def.toggle) def.toggle()
              else def.run()
            } catch (err) { console.error('[shell] 面板快捷键失败:', err) }
          }
        }
      }
      if (e.key === 'Escape') {
        const ae = document.activeElement
        const inInput = ae instanceof HTMLElement && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
        const musicOpen = getCommandHost<{ isVisible?: () => boolean }>('musicPanel')?.isVisible?.() === true
        // 2026-08-15 修复(Esc 双层关闭): SideSheet 面板(热点/台风/股票/媒体)自带 Esc
        // 关闭 handler, 本 handler 同一次 Esc 又把场景卡 closeTop 关掉——一次 Esc 关
        // 两层。补面板 isVisible 守卫: 任一 SideSheet 面板打开时本轮 Esc 只归面板
        // 消费, closeTop 让位。bigPanelStateRef 由 crabpaw:hotspot-panel-visibility
        // 事件维护(hotspot/typhoon/stock/media 四面板), 天气经 __weatherPanel 接口。
        let weatherOpen = false
        try {
          const wh = getCommandHost<{ isVisible?: () => boolean }>('weatherPanel')
          weatherOpen = typeof wh?.isVisible === 'function' && wh.isVisible() === true
        } catch (err) { console.warn('[shell] 读取天气面板状态失败:', err) }
        const bigPanelOpen = Object.values(bigPanelStateRef.current).some(Boolean)
        if (!inInput && !cockpitVisible && !musicOpen && !weatherOpen && !bigPanelOpen) {
          try {
            const shell = getCommandHost('sceneShell')
            if (shell && typeof shell.closeTop === 'function') shell.closeTop()
          } catch (err) { console.error('[shell] Esc 关闭场景卡失败:', err) }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // 2026-08-08(审计 P1): 补 historyDrawerOpen 依赖——旧闭包陈旧,打开历史抽屉后
    // 按 Esc 永远走不到抽屉分支,抽屉只能点 ✕ 关闭
  }, [historyDrawerOpen, cockpitVisible])

  // ── Ctrl+K 命令面板全局接口 ──
  // __voiceShell.newConversation() —— 清空当前对话
  // 2026-08-13 P2-4: flowRef 防陈旧闭包(effect 依赖 [] 捕获首渲染 flow,
  // newConversation 需调最新 flow 方法)
  const flowRef = useRef(flow)
  flowRef.current = flow

  // 2026-08-13 P2-4: 恢复横幅(ag-ui 快照化恢复借鉴)——挂载时拉最近运行终态,
  // 24h 内的中断/失败 run 提示"继续对话"(续用会话上下文)或开始新对话
  const [resumeBanner, setResumeBanner] = useState<{ roundId: string; status: string; ts: number; conversationId?: string | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGet<{ run: { roundId: string; status: string; ts: number; conversationId?: string | null } | null }>('/api/runs/active?userId=voice_shell_user')
      .then((res) => {
        if (cancelled) return
        const run = res?.data?.run
        if (run && run.status !== 'finished' && Date.now() - run.ts < 24 * 3600 * 1000) {
          setResumeBanner(run)
        }
      })
      .catch((err) => console.warn('[shell] 恢复横幅加载失败:', (err as Error)?.message || err))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    // A1: 经 ui-command-registry 注册(旧 window.__voiceShell 退役)
    const unregisterVoiceShell = registerCommandHost('voiceShell', {
      newConversation: () => {
        try { setConversation([]); conversationRef.current = [] } catch (err) { console.error('[shell] 命令面板清空对话失败:', err) }
        try { flowRef.current.newConversation() } catch (err) { console.error('[shell] 重置会话失败:', err) }
      },
    })
    return () => { unregisterVoiceShell() }
  }, [])

  // crabpaw:open-cockpit —— ManagementCockpit.__cockpit.open(tab) 与 voiceCommands 导航命令
  // 经 custom event 通知 VoiceShell。2026-08-12 (P1 缺陷 1): 补语音导航映射——
  // 单界面下日历→业务面板日程 tab、记忆→管理舱调试 memory 子页（非开发者播报引导）、
  // 首页/对话→收起浮层回主界面并播报确认（无独立页面，保证绝不静默吞）。
  useEffect(() => {
    // 2026-08-21 审计 P0-1: 映射收敛单源 lib（cockpit-navigation.ts）——原内联键复数 experts
    // 与发射方单数 expert 错位致静默落 settings；单源 + 旧键兼容见 lib 注释。
    const cockpitTabMap = COCKPIT_TAB_MAP
    // 2026-08-27: 原 mcp 键删除——mcp 已独立成 tab, 无 section 定位(死角键),
    // 删除后 cockpitSectionMap['mcp'] ?? null 返回 null, 直接落 mcp tab
    const cockpitSectionMap: Record<string, string | null> = {
      model: 'model',
    }
    const onOpenCockpit = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const tab = detail?.tab || 'settings'
      try {
        if (tab === 'calendar') {
          // 日历 → 日程卡片 SchedulePanel（2026-08-19 业务面板退役后直达卡片）
          // A2: cockpit/抽屉由 sheet-state 互斥自动收起(SideSheet 打开即顶掉 overlay)
          setCockpitKeyword(null)   // 分流分支不消费搜索关键词, 清掉防残留
          try { executeCommand('schedulePanel', 'open') } catch (err) { console.error('[shell] 打开日程卡片失败:', err) }
          return
        }
        if (tab === 'memory') {
          // 2026-08-26 用户反馈「记忆图谱按钮→管理舱但无记忆内容」: 原实现按
          // isDevMode 分流——非开发者落 settings(8-21 裁决"记忆管理在设置页可见"
          // 实际未实现, 设置页仅开发者模式开关)。记忆图谱/进化/快照是核心功能
          // (左侧栏按钮 + 语音统一), 不应被开发者模式门槛挡住——直达记忆页
          // (管理舱 debug→memory 子页, 独立于 isDevMode)。
          setCockpitKeyword(null)   // debug 直达不消费搜索关键词, 清掉防残留
          setCockpitTab('debug')
          setCockpitNavSection(null)
          setCockpitDebugTab('memory')
          setCockpitVisible(true)
          return
        }
        if (tab === 'home' || tab === 'chat') {
          // 单界面无独立首页/对话页——收起所有浮层回到主界面并播报确认（可见反应）
          if (cockpitVisible) setCockpitVisible(false)
          setHistoryDrawerOpen(false)
          setCockpitKeyword(null)   // 回到主界面, 搜索关键词一并作废
          speech.enqueue({ id: `nav_${Date.now()}`, text: tab === 'home' ? '已回到首页' : '对话已打开', kind: 'panel' })
          return
        }
        // A2: 开管理舱由 sheet-state 互斥自动收起历史抽屉
        // detail: { tab, section?, keyword? } —— 全局搜索 & 未来召唤直达
        setCockpitKeyword(detail?.keyword || null)
        setCockpitTab(cockpitTabMap[tab] || 'settings')
        setCockpitNavSection(detail?.section ?? cockpitSectionMap[tab] ?? null)
        // 2026-08-28 CK6: 普通打开重置调试子页——memory 等深链残留会让下次「调试」tab
        // 落在旧子页; debug 深链分支(上方)自行显式设置, 不经过这里。
        setCockpitDebugTab('logs')
        setCockpitVisible(true)
      } catch (err) { console.error('[shell] 命令面板打开管理舱失败:', err) }
    }
    window.addEventListener('crabpaw:open-cockpit', onOpenCockpit)
    return () => window.removeEventListener('crabpaw:open-cockpit', onOpenCockpit)
  }, [cockpitVisible, speech])

  // crabpaw:open-search —— 语音"帮我找 X/搜索 X"（voice-panel-commands search kind）→
  // 打开文件生成面板 FileGenPanel + 播报引导（老板可直接说文件名继续找,不依赖 LLM 4-6s 碰运气）
  useEffect(() => {
    const onOpenSearch = (e: Event) => {
      const detail = (e as CustomEvent).detail
      try {
        // A2: 文件面板(SideSheet)打开时由 sheet-state 互斥自动收起管理舱/抽屉
        try { executeCommand('filePanel', 'setVisible', true) } catch (err) { console.error('[shell] 打开文件面板失败:', err) }
        speech.enqueue({ id: `search_${Date.now()}`, text: '已打开文件面板，您可以直接说文件名让我找', kind: 'panel' })
        // UiCommandBridge(agent 命令)派发 detail { query };本地语音命令路径派发 { text }——双兼容读取
        const q = detail?.query ?? detail?.text
        if (q) console.log('[shell] 语音搜索请求: (len=%d)', q.length)
      } catch (err) { console.error('[shell] 语音打开文件搜索失败:', err) }
    }
    window.addEventListener('crabpaw:open-search', onOpenSearch)
    return () => window.removeEventListener('crabpaw:open-search', onOpenSearch)
  }, [speech])

  // crabpaw:tts-error —— useVoiceReply 流式 TTS 全链路失败广播(detail: { message })。
  // 此前无监听方 → 用户零反馈。接线: 播报提示(语音队列自身失败不递归广播,无循环风险)
  useEffect(() => {
    const onTtsError = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const msg = detail?.message || '语音播报失败，请检查网络与 TTS 配置'
      console.error('[shell] TTS 播报错误:', msg)
      try {
        speech.enqueue({ id: `tts_err_${Date.now()}`, text: msg, kind: 'panel' })
      } catch (err) { console.error('[shell] TTS 错误提示入队失败:', err) }
      // toast 可见反馈: TTS 全挂时音频播报链路同样失败,不能只依赖播报（审查修复 I1）
      const shortMsg = msg.length > 80 ? msg.slice(0, 80) + '…' : msg
      toast.error('语音合成失败：' + shortMsg)
    }
    window.addEventListener('crabpaw:tts-error', onTtsError)
    return () => window.removeEventListener('crabpaw:tts-error', onTtsError)
  }, [speech])

  // crabpaw:voice-error —— VoiceIntegration 语音会话错误广播(detail: { message },如麦克风失败)。
  // 此前无监听方 → 用户"看起来在听实际聋"无提示。接线: 播报提示 + 日志
  useEffect(() => {
    const onVoiceError = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const msg = detail?.message || '语音会话出错，请检查麦克风权限'
      console.error('[shell] 语音会话错误:', msg)
      try {
        speech.enqueue({ id: `voice_err_${Date.now()}`, text: msg, kind: 'panel' })
      } catch (err) { console.error('[shell] 语音错误提示入队失败:', err) }
      // toast 可见反馈: 麦克风/会话链路故障时播报不可依赖,补 UI 通道（审查修复 I1）
      const shortMsg = msg.length > 80 ? msg.slice(0, 80) + '…' : msg
      toast.error('语音设备错误：' + shortMsg)
    }
    window.addEventListener('crabpaw:voice-error', onVoiceError)
    return () => window.removeEventListener('crabpaw:voice-error', onVoiceError)
  }, [speech])

  // crabpaw:close-scene-card —— 通用"收起/关闭卡片"命令（voice-panel-commands scene-card kind）
  // → 关闭最上层场景卡（复用 __sceneShell.closeTop 契约，与 scene kind 同语义；事件化便于复用）
  useEffect(() => {
    const onCloseSceneCard = () => {
      try {
        const shell = getCommandHost('sceneShell')
        if (shell && typeof shell.closeTop === 'function') shell.closeTop()
      } catch (err) { console.error('[shell] 关闭场景卡失败:', err) }
    }
    window.addEventListener('crabpaw:close-scene-card', onCloseSceneCard)
    return () => window.removeEventListener('crabpaw:close-scene-card', onCloseSceneCard)
  }, [])

  const [textInput, setTextInput] = useState('')
  // 2026-08-19 修复: 组合输入状态自跟踪——此前依赖 e.nativeEvent.isComposing 守卫回车,
  // 但 SideSheet 打开时焦点被抢(关闭按钮 focus)打断组合 → compositionend 不触发 →
  // 原生 isComposing 卡死为 true → 之后回车永远被吞(鼠标点发送却正常)。
  // 自跟踪 ref + blur 取消: 组合中途失焦视为取消,ref 归 false,回车恢复可用。
  const composingRef = useRef(false)
  const [attachments, setAttachments] = useState<{ path: string; name: string; size?: number; type?: string; pending?: boolean }[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 2026-09-04 P3 组队确认环: 语音例会提案挂起（90s 过期, 非应答语句即作废落正常链路）
  const pendingMeetingRef = useRef<null | { label: string; expiresAt: number; launch: () => Promise<void> }>(null)

  // 公共输入处理：语音与文本输入共用（专注模式命令 → 面板命令 → 音乐快速关闭 → rearm + 发送）
  const handleUserInput = useCallback((text: string, files?: { path: string; name: string }[]) => {
    const t = text.trim().toLowerCase()
    // 2026-08-07: 剥离呼唤前缀——用户每句常带"小龙女，…"，前缀污染导致
    // 面板命令全部落 LLM（幻觉播报"已打开"实际没执行 + 4-6s 慢响应）。
    // 剥离后命令匹配命中率大幅提升；剥离失败/无前缀时保持原文本。
    // 2026-08-12 (P1 缺陷 4): 剥离逻辑抽到 lib/stripCommandPrefix（可测）——
    // 补默认唤醒词"小螃蟹"，且唤醒词允许零分隔符连读（"小螃蟹打开股票"无标点也要剥离）。
    const ct = stripCommandPrefix(t)
    // 专注模式语音开关（多人环境：仅 PTT 可用）
    if (/^(打开|开启|进入)(专注模式|仅按键模式|仅ptt模式)$/.test(t)) {
      applyShellConfig(v => v.pttOnly ? v : { ...v, pttOnly: true, continuousMode: false, wakeWordEnabled: false })
      speech.enqueue({ id: `focus_${Date.now()}`, text: '已开启专注模式，仅按住空格说话', kind: 'panel' })
      return
    }
    if (/^(关闭|退出)(专注模式|仅按键模式)$/.test(t)) {
      applyShellConfig(v => v.pttOnly ? { ...v, pttOnly: false, continuousMode: true, wakeWordEnabled: true } : v)
      speech.enqueue({ id: `focus_${Date.now()}`, text: '已退出专注模式', kind: 'panel' })
      return
    }
    // 2026-08-19 修复: 裸「关闭」本地拦截——此前「关闭」无目标词不命中任何面板规则
    // → 落 LLM 无反应(会议纪要卡打开时输入「关闭」期望关掉卡片)。
    // 命中条件: ① SideSheet 宿主卡(会议/热点/台风等)激活 → sheet-state 通用关闭;
    // ② 场景卡在屏 → closeTop 关最上层;③ 都无 → 不拦截,落 LLM(对话语境正常词)。
    if (/^(关闭|关掉|收起|隐藏)$/.test(ct)) {
      try {
        if (closeActiveSheet()) return
      } catch (err) { console.error('[shell] 关闭活动面板失败:', err) }
      const shell = getCommandHost('sceneShell')
      if (visibleSurfaces.length > 0 && shell && typeof shell.closeTop === 'function') {
        try { shell.closeTop() } catch (err) { console.error('[shell] 关闭最上层场景卡失败:', err) }
        return
      }
    }
    // 2026-09-04 P3 组队确认环: 例会提案挂起时优先消费确认/取消应答
    const pending = pendingMeetingRef.current
    if (pending) {
      if (Date.now() > pending.expiresAt) {
        pendingMeetingRef.current = null
      } else {
        const conf = detectExpertMeetingConfirmation(ct)
        if (conf === 'confirm') {
          pendingMeetingRef.current = null
          void (async () => {
            try {
              await pending.launch()
            } catch (e: any) {
              console.warn('[shell] 例会确认发车失败:', e?.message || e)
              speech.enqueue({ id: `experts_${Date.now()}`, text: '例会启动失败，请稍后再试', kind: 'panel' })
            }
          })()
          return
        }
        if (conf === 'cancel') {
          pendingMeetingRef.current = null
          speech.enqueue({ id: `experts_${Date.now()}`, text: '好的，先不开了。', kind: 'panel' })
          return
        }
        // 非应答语句：提案作废，该语句走正常链路
        pendingMeetingRef.current = null
      }
    }

    // 2026-09-04 部门化 P2/P3: 专家召唤/部门例会语音指令——命中即走 summon/collab API
    // 并语音播报结果(带岗位音色), 不落 LLM。例会走确认环: 提案阵容→应答→发车。
    const summonHit = detectExpertSummonCommand(ct)
    if (summonHit) {
      void (async () => {
        const say = (text: string, voice?: string) => speech.enqueue({ id: `experts_${Date.now()}`, text, kind: 'panel', ...(voice ? { voice } : {}) })
        try {
          if (summonHit.kind === 'department-meeting') {
            // 组队确认环: 先提案阵容，等"开始/取消"应答再发车
            let goal = summonHit.goal || ''
            let roster: { name: string; voiceStyle?: string }[] = []
            let leadName = ''
            if (summonHit.presetId) {
              const presets = await fetchTeamPresets()
              const preset = presets.find(p => p.id === summonHit.presetId)
              goal = goal || preset?.defaultGoal || ''
              const details = await Promise.all((preset?.expertIds || []).map(id => fetchExpertDetail(id)))
              roster = details.filter(Boolean).map(d => ({ name: d!.name, voiceStyle: (d as any)!.voiceStyle }))
              leadName = roster[0]?.name || ''
            } else if (summonHit.departmentId) {
              const members = await fetchExpertsByDepartment(summonHit.departmentId)
              roster = members.slice(0, 4).map(m => ({ name: m.name, voiceStyle: m.voiceStyle }))
            }
            if (!goal) goal = '部门工作例检：当前状况、主要问题与本周重点建议'
            const label = summonHit.label || '部门例会'
            if (roster.length === 0) { say(`${label}暂无在编岗位，无法召开`); return }
            const params = summonHit.presetId
              ? { presetId: summonHit.presetId, goal }
              : { department: summonHit.departmentId!, goal }
            pendingMeetingRef.current = {
              label,
              expiresAt: Date.now() + 90000,
              launch: async () => {
                const h = await startDepartmentMeeting(params)
                say(`${h.departmentLabel}例会已开始，${h.lead?.name || '主管'}主持，${h.tasks.length} 位岗位分别分析中。每位完成会向我汇报，全部完成后我为您念纪要结论——纪要全文会显示在语音球下方，可以随时查看。`, resolveExpertTtsVoice(h.lead?.voiceStyle))
                // P3: 例会进度轮询（15s×40≈10min, 与后端看门狗一致）——只负责检测
                // 整场终态；成员完成不另行播报（CollabOrbit 的"X汇报"已覆盖，双通道
                // 重复播报是 2026-09-06 用户反馈的叠音来源）。
                let polled = 0
                const poll = setInterval(async () => {
                  polled++
                  try {
                    const st = await getCollabStatus(h.collabId)
                    if (!st) return
                    if (st.status !== 'running' && st.status !== 'synthesizing') {
                      clearInterval(poll)
                      if (st.status === 'done' && st.summary) {
                        // 2026-09-06 三态分离·结论态: 例会纪要以消息形式进对话流
                        //（markdown 原样渲染，永久留在会话历史里，不随浮卡收球消失）
                        try {
                          pushChat('ai', `📋 **${h.departmentLabel}例会结论**（主持：${h.lead?.name || '主管'}）\n\n${String(st.summary)}`)
                        } catch (e) { console.warn('[shell] 例会纪要落卡失败:', e) }
                        say(`${h.departmentLabel}例会完成。结论已整理进对话窗口，我念一下重点：${String(st.summary).replace(/[#*>]/g, '').slice(0, 220)}…`, resolveExpertTtsVoice(h.lead?.voiceStyle))
                      } else {
                        say(`${h.departmentLabel}例会已结束，但未产出有效汇总，详情请到任务面板查看。`)
                      }
                    }
                  } catch { /* 轮询失败静默 */ }
                  if (polled >= 40) clearInterval(poll)
                }, 15000)
              },
            }
            say(`${label}提案：${goal}。我准备请 ${roster.map(r => r.name).join('、')} 参加${leadName ? `，由${leadName}主持` : ''}。开始吗？`, resolveExpertTtsVoice(roster[0]?.voiceStyle))
          } else {
            const r = await summonExpert(summonHit.target)
            if (!r) { say('没有找到对应的岗位或部门'); return }
            if (r.type === 'expert' && r.activated) {
              say(`已接通${r.expert!.departmentLabel || ''}「${r.expert!.name}」，请讲。`, resolveExpertTtsVoice(r.expert!.voiceStyle))
            } else if (r.type === 'department' && r.activated) {
              const leadVoice = resolveExpertTtsVoice(r.members?.find(m => m.id === r.department!.lead)?.voiceStyle)
              say(`已接通${r.department!.label}，${r.department!.memberCount} 位在编岗位，主管为您服务。`, leadVoice)
            } else if (r.type === 'ambiguous' && r.candidates?.length) {
              say(`找到 ${r.candidates.length} 个相关岗位：${r.candidates.map(c => c.name).join('、')}。请说得再具体些，或到专家面板选择。`)
            } else {
              say('召唤未生效，请重试或到专家面板操作。')
            }
          }
        } catch (e: any) {
          console.warn('[shell] 专家语音指令失败:', e?.message || e)
          speech.enqueue({ id: `experts_${Date.now()}`, text: '专家服务暂不可用，请稍后再试', kind: 'panel' })
        }
      })()
      return
    }
    // P5.5: 语音面板命令拦截（命中则不进入 LLM）
    // 用剥离前缀后的文本匹配（见上方 ct 定义）；分发内取歌名等用 ct 而非 t
    const cmd = matchPanelCommand(ct)
    if (cmd) {
      // 2026-08-15 参考实现对齐: open 时本地无可恢复内容的面板(news/会议/媒体)
      // → 不拦截, 落 LLM 由对应工具创建内容（本地关键词兜底失败降级 LLM 工具）;
      // 其余命令命中即拦截（含本地失败播报）
      let fallthroughToLLM = false
      try {
        const shell = getCommandHost('sceneShell')
        let hasPanel = true
        // 音乐面板走 FloatingMusicPlayer 全局接口（非 SceneShell 面板流）
        if (cmd.kind === 'music') {
          // A1: 经 ui-command-registry(musicPanel/musicSearch 宿主)
          if (cmd.action === 'close') {
            executeCommand('musicPanel', 'close')
          } else if (cmd.action === 'pause') {
            // 2026-08-15: "暂停音乐"本地即时暂停、保留面板
            executeCommand('musicPanel', 'pause')
          } else if (cmd.action === 'open') {
            // R8: 提取歌名——"播放周杰伦的歌" → 歌名"周杰伦" → musicSearch.openWithQuery
            // 自动搜索并播放;无歌名("播放歌曲")→ 只打开面板手动选
            // 2026-08-07: 用剥离前缀后的 ct 提取（"小龙女，播放周杰伦的歌"不再混入"小龙女"）
            const songQuery = extractSongQuery(ct)
            if (songQuery) {
              executeCommand('musicSearch', 'openWithQuery', songQuery)
            } else {
              executeCommand('musicPanel', 'open')
            }
          }
        } else if (cmd.kind === 'approval') {
          const host = getCommandHost('approvalHost')
          if (!host) {
            speech.enqueue({ id: `approval_${Date.now()}`, text: '审批面板不可用', kind: 'panel' })
          } else {
            const ok = cmd.action === 'approve' ? host.approve() : host.reject()
            speech.enqueue({
              id: `approval_${Date.now()}`,
              text: ok ? (cmd.action === 'approve' ? '已批准' : '已拒绝') : '当前没有待审批的请求',
              kind: 'panel',
            })
          }
        } else if (cmd.kind === 'management_cockpit') {
          // 阶段 B: 管理舱（设置/插件/技能/用量/调试）
          const targetMap = COCKPIT_TARGET_MAP
          const sectionMap: Record<string, string | null> = {
            model: 'model', mcp: 'mcp',
          }
          if (cmd.action === 'open') {
            const target = cmd.target || 'settings'
            // 2026-08-26 同款(1183 按钮分流)对齐: memory/evolution 是核心记忆功能
            // (记忆图谱/进化/快照), 不属调试——移出 isDevMode 解锁清单; 调试项
            // (logs/status/gateway/voice) 维持开发者模式门槛。与 COCKPIT_TARGET_MAP
            // memory→debug 映射配合: 语音"打开记忆"同样直达记忆页。
            if (['logs', 'status', 'gateway', 'voice'].includes(target) && !isDevMode()) {
              // 非开发者模式：调试功能不可达，播报引导（hasPanel=true 抑制下方通用"无面板"播报，避免双 TTS）
              hasPanel = true
              try {
                speech.enqueue({
                  id: `cockpit_${Date.now()}`,
                  text: '调试功能需要先在管理舱内开启开发者模式',
                  kind: 'panel',
                })
              } catch (err) { console.error('[shell] 开发者模式提示播报失败:', err) }
            } else {
              try {
                setCockpitTab(targetMap[target] || 'settings')
                setCockpitNavSection(sectionMap[target] ?? null)
                setCockpitDebugTab(debugTabMap[target] ?? 'logs')
                setCockpitVisible(true)
                hasPanel = true
              } catch (err) { console.error('[shell] 打开管理舱失败:', err); hasPanel = false }
            }
          } else {
            // 2026-08-19 审计: 舱未开时播报而非静默——此前「关闭数据库」在舱未开时
            // hasPanel=true 吞掉反馈(与「打开数据库」本地命中不对称)
            if (!cockpitVisible) {
              try {
                speech.enqueue({ id: `cockpit_${Date.now()}`, text: '管理舱当前未打开', kind: 'panel' })
              } catch (err) { console.error('[shell] 管理舱未打开提示播报失败:', err) }
            } else {
              try {
                // 关闭走 __cockpit.close（dirty-aware requestClose）——与 __taskPanel/__weatherPanel 同款
                const cp = getCommandHost('cockpit')
                if (cp && typeof cp.close === 'function') cp.close()
                else setCockpitVisible(false)
              } catch (err) { console.error('[shell] 关闭管理舱失败:', err) }
            }
            hasPanel = true
          }
        } else if (cmd.kind === 'search') {
          // 2026-08-12 (搜索落地 4a): 语音"帮我找 X/搜索 X"——本地直达,不落 LLM 等 4-6s 碰运气。
          // 派发 crabpaw:open-search 事件,由下方监听打开文件面板(FileGenPanel)并播报引导
          //（detail 携带剥离前缀后的原文,预留后续透传搜索词）
          try {
            window.dispatchEvent(new CustomEvent('crabpaw:open-search', { detail: { text: ct } }))
            hasPanel = true
          } catch (err) { console.error('[shell] 派发打开搜索事件失败:', err); hasPanel = false }
        } else if (cmd.kind === 'guidance') {
          // 引导语播报：本地拦截后直接 TTS 回复（不进入 LLM），如"车次""看板"
          if (cmd.target) {
            speech.enqueue({ id: `guidance_${Date.now()}`, text: cmd.target, kind: 'panel' })
          }
          hasPanel = true
        } else if (cmd.kind === 'task_panel') {
          // 任务面板统一归 TaskPanelHost 浮层（通道 B），SceneShell 不再渲染该 kind
          const tp = getCommandHost('taskPanel')
          // P3 修复: !== false 兼容 setVisible 返回 undefined(未显式返回)的场景
          hasPanel = tp && typeof tp.setVisible === 'function'
            ? tp.setVisible(cmd.action === 'open') !== false
            : false
        } else if (cmd.kind === 'cancel_task') {
          // 2026-08-12(任务链复活): 取消任务——本地规则+事件。TaskPanelHost 持有 store,
          // 由它找最近 running flow 面板并 POST /api/taskflows/:id/cancel(组件内自处置)
          try {
            window.dispatchEvent(new CustomEvent('crabpaw:cancel-task'))
            hasPanel = true
          } catch (err) { console.error('[shell] 派发取消任务事件失败:', err); hasPanel = false }
        } else if (cmd.kind === 'filegen') {
          // 文件生成面板打开/关闭/转换（2026-08-17: 替代 DocReader,经 __filePanel 全局接口）
          // convert：打开面板后由用户继续语音描述（如"把这篇文档转成 Word"）触发实际转换
          const panel = getCommandHost('filePanel')
          hasPanel = panel && typeof panel.setVisible === 'function'
            ? panel.setVisible(cmd.action !== 'close') !== false
            : false
          if (cmd.action === 'open' && !hasPanel) {
            // 兜底：无任务时打开面板显示空态引导
            hasPanel = true
          }
        } else if (cmd.kind === 'meeting_recording') {
          // 会议记录面板（2026-08-18 会议卡片轮）——MeetingPanel 常驻挂载,宿主恒在:
          // open+target:'start' → 开卡录音;open+target:'history' → 历史列表;
          // close+target:'stop' → 停止并总结;其余 close → 关闭面板。
          // 语音「开始记录/记录一下」直达宿主,不经 LLM,不依赖 intent 路由。
          const mp = getCommandHost('meetingPanel')
          if (!mp) {
            // 宿主未挂载（异常场景）→ 落 LLM 由 meeting_mode 工具接管
            hasPanel = false
            fallthroughToLLM = true
          } else {
            try {
              if (cmd.action === 'open') {
                if (cmd.target === 'start' && typeof mp.startRecording === 'function') mp.startRecording()
                else if (typeof mp.openHistory === 'function') mp.openHistory()
              } else if (cmd.target === 'stop' && typeof mp.stopRecording === 'function') {
                mp.stopRecording()
              } else if (typeof mp.close === 'function') {
                mp.close()
              }
              hasPanel = true // 宿主恒在,本地已接管
            } catch (err) { console.error('[shell] 会议面板命令执行失败:', err); hasPanel = false }
          }
        } else if (cmd.kind === 'schedule') {
          // 日程卡片（2026-08-19）——SchedulePanel 常驻挂载,宿主恒在:
          // open → 打开日程卡片(近 7 天日程);close → 关闭卡片。
          // 语音「打开日程/日历」直达宿主,不经 LLM(数据走 /api/calendar)。
          const sp = getCommandHost('schedulePanel')
          if (!sp) {
            // 宿主未挂载（异常场景）→ 落 LLM 由 SceneSet 工具接管
            hasPanel = false
            fallthroughToLLM = true
          } else {
            try {
              if (cmd.action === 'open' && typeof sp.open === 'function') sp.open()
              else if (typeof sp.close === 'function') sp.close()
              hasPanel = true // 宿主恒在,本地已接管
            } catch (err) { console.error('[shell] 日程卡片命令执行失败:', err); hasPanel = false }
          }
        } else if (cmd.kind === 'knowledge') {
          // 知识库面板（2026-08-20）——KnowledgePanel 常驻挂载,宿主恒在:
          // open → 打开知识库卡片(检索/文档清单/SRS 复习);close → 关闭面板。
          // 语音「打开知识库」直达宿主,不经 LLM(数据走 /api/kb/*)。
          // 内容问题("知识库里 XX 是多少")不在此拦截 → 落 LLM 走 kb_query 意图。
          const kp = getCommandHost('knowledgePanel')
          if (!kp) {
            // 宿主未挂载（异常场景）→ 落 LLM 由 SceneSet 工具接管
            hasPanel = false
            fallthroughToLLM = true
          } else {
            try {
              if (cmd.action === 'open' && typeof kp.open === 'function') kp.open()
              else if (typeof kp.close === 'function') kp.close()
              hasPanel = true // 宿主恒在,本地已接管
            } catch (err) { console.error('[shell] 知识库面板命令执行失败:', err); hasPanel = false }
          }
        } else if (cmd.kind === 'history') {
          // Task 13: 会话历史抽屉——语音命令"历史/历史会话/查看历史/会话记录"
          if (cmd.action === 'open') {
            // A2: 语音开历史抽屉与按钮同口径——管理舱由 sheet-state 互斥自动收起
            setHistoryDrawerOpen(true)
            hasPanel = true
          } else {
            setHistoryDrawerOpen(false)
            hasPanel = false
          }
        } else if (cmd.kind === 'media') {
          // 媒体面板打开/关闭（MediaStage 全局接口）
          const ms = getCommandHost('mediaStage')
          if (cmd.action === 'open') {
            if (ms && typeof ms.open === 'function') { ms.open(); hasPanel = true }
            else {
              // 2026-08-15: 接口仅在媒体场景卡挂载时注册——无卡即无接口,
              // open 落 LLM（SceneMedia/GenerateImage 等工具创建卡后自动弹出）
              hasPanel = false
              fallthroughToLLM = true
            }
          } else {
            if (ms && typeof ms.close === 'function') {
              ms.close()
              // 2026-09-05: 关闭执行反馈——此前静默执行, 用户感知"没反应"
              speech.enqueue({ id: `media_${Date.now()}`, text: '好的，媒体面板已关闭', kind: 'panel' })
            }
            hasPanel = false
          }
        } else if (cmd.kind === 'scene') {
          // 对话面板/场景卡关闭——SceneShell 关闭最上层面板
          const shell = getCommandHost('sceneShell')
          if (shell && typeof shell.closeTop === 'function') shell.closeTop()
          hasPanel = false
        } else if (cmd.kind === 'scene-card') {
          // 通用"收起/关闭卡片"（P1 缺陷 2：此前被 doc close 规则劫持）——
          // 派发统一事件，由 crabpaw:close-scene-card 监听关闭最上层场景卡
          try { window.dispatchEvent(new CustomEvent('crabpaw:close-scene-card')) }
          catch (err) { console.error('[shell] 派发关闭场景卡事件失败:', err) }
          hasPanel = false
        } else if (cmd.kind === 'skill') {
          // 技能执行全息卡关闭（SkillStageHost 全局接口）
          const ss = getCommandHost('skillStage')
          if (ss && typeof ss.close === 'function') ss.close()
          hasPanel = false
        } else if (cmd.kind === 'weather' || cmd.kind === 'hotspot' || cmd.kind === 'typhoon' || cmd.kind === 'stock') {
          // 天气/热点/台风/股票归独立组件（App 根层常驻），走全局显隐接口
          const panel = getCommandHost(({ weather: 'weatherPanel', hotspot: 'hotspotPanel', typhoon: 'typhoonPanel', stock: 'stockPanel' } as Record<string, string>)[cmd.kind])
          // P3: !== false 兼容 setVisible 返回 undefined
          hasPanel = panel && typeof panel.setVisible === 'function'
            ? panel.setVisible(cmd.action === 'open') !== false
            : false
          // 2026-08-15: 无数据可恢复的 open(天气/台风/股票) → **前端自取数据直开面板**
          // (GET /panels/<name>, 后端自动 upsert surface)——不再落 LLM。此前落 LLM 的
          // 问题: 按需工具注入的意图分类器可能把"打开股票面板"判成 file_operation,
          // 工具集裁剪后无 ShowStock → LLM 换文档工具 → 文档生成舱误开(用户实锤)。
          // 天气端点不自动 upsert, 前端映射后手动 upsert surface。
          if (cmd.action === 'open' && !hasPanel && cmd.kind !== 'hotspot') {
            hasPanel = true // 已本地接管
            const kind = cmd.kind
            // 2026-08-27 面板禁用开关: 语音直开绕过了 registry 读面过滤（P2 核查实锤）——
            // weather/stock 直开改按面板启用态门控（12s 缓存, 复用 /api/panels/state 面板集语义）。
            // handleUserInput 非 async, 门控以 promise 链前置实现（语义同 await 版）。
            const gate = (kind === 'weather' || kind === 'stock') ? checkPanelEnabled(kind) : Promise.resolve(null as boolean | null)
            gate.then(enabled => {
              if (enabled === false) {
                speech.enqueue({ id: `panel_disabled_${Date.now()}`, text: `${kind === 'weather' ? '天气' : '股票'}面板已停用，可在管理舱插件页启用`, kind: 'panel' })
                return
              }
              apiGet<any>(`/panels/${kind}${kind === 'weather' ? '' : '?refresh=1'}`)
                .then(res => {
                  if (kind === 'weather' && res?.data) {
                    const w = res.data.data || {}
                    apiPost('/api/scene/upsert', {
                      id: 'weather-panel',
                      data: {
                        kind: 'weather',
                        data: {
                          city: w.city || '北京',
                          temp: w.current?.temp || '',
                          condition: w.current?.condition || '',
                          humidity: w.current?.humidity || '',
                          wind: w.current?.wind || '',
                          forecast: (w.forecast || []).slice(0, 5),
                        },
                        intent: 'inform',
                      },
                    }).catch(e => console.warn('[shell] 天气 surface upsert 失败:', e))
                  }
                  // typhoon/stock 端点已自动 upsert surface → 面板自动打开
                })
                .catch(e => {
                  console.error(`[shell] 面板自取数据失败(${kind}):`, e)
                  speech.enqueue({ id: `panel_fail_${Date.now()}`, text: `${panelLabel(kind as any)}数据获取失败，请稍后再试`, kind: 'panel' })
                })
            })
          }
        } else if (cmd.kind === '*') {
          if (shell?.closeTop) shell.closeTop()
        } else if (shell?.setVisible) {
          // P3: !== false 兼容 setVisible 返回 undefined
          hasPanel = shell.setVisible(cmd.kind, cmd.action === 'open') !== false
          // 2026-08-15: news/meeting_recording 的 open 在无卡可恢复时落 LLM
          // （对应工具: ShowHotspot(format=scene)/meeting_mode 创建场景卡）
          if (cmd.action === 'open' && !hasPanel && (cmd.kind === 'news' || cmd.kind === 'meeting_recording')) {
            fallthroughToLLM = true
          }
        }
        // R11: 动作型命令成功执行 → 静默(用户从 UI 看到效果,如面板打开/歌曲播放),
        // 不再播报"已打开XX/已关闭XX"确认——语音播报只留给"失败/需说明"的场景。
        // 仅当"请求打开但实际没有该面板"时简短播报说明（落 LLM 的除外）。
        if (!fallthroughToLLM && cmd.action === 'open' && !hasPanel) {
          speech.enqueue({
            id: `panel_${Date.now()}`,
            text: `当前没有进行中的${panelLabel(cmd.kind)}`,
            kind: 'panel',
          })
        }
      } catch (e) {
        console.error('[shell] 面板命令执行失败:', e)
      }
      // 2026-08-15: fallthrough → 不拦截, 落到下方 LLM 发送流程
      if (!fallthroughToLLM) return
    }
    // 本地命令快速拦截（音乐/热点面板关闭 —— 全局事件，Dashboard 同款）
    if (/关闭.*音乐|关掉.*音乐|停止音乐/.test(t)) {
      try {
        executeCommand('musicPanel', 'close')
      } catch (e) {
        console.error('[shell] 关闭音乐面板:', e)
      }
      return
    }
    // 2026-08-18: 会议录制期语音隔离——开会转写只进卡片,不进 AI 对话流。
    // 本地命令分发在其上方已完成(「结束记录/停止记录」照常工作),其余语音
    // 一律吞掉,不 pushChat、不进 LLM;卡片内实时转写由 ASR 通道直连。
    if (getCommandHost('meetingPanel')?.isRecording?.()) return
    // 2026-08-17: crabpaw:doc-rearm 随 DocReader 退役删除——FileGenPanel 由
    // filegen:start/phase/done SSE 事件驱动,无需用户发言重新武装。
    // P7 Task 4: 新会话开始——重置阶段阈值播报集合
    phaseDoneRef.current.clear()
    // 2026-08-06: 右侧对话卡片——push 用户消息
    // 2026-08-19 三栏联动轮: 用户消息落轮次序号(三栏联动键——时间线组/工具批同轮对齐)
    const round = ++roundSeqRef.current
    lastUserRoundRef.current = round
    // 2026-08-21: 附件随用户消息进气泡（files 已过滤 pending）
    pushChat('user', text, undefined, round, files)
    lastAiPushedRef.current = ''
    flow.setTranscript(text)
    // 2026-08-13 审查 P1: .catch 兜底——sendText 内部已捕获 chat 流错误,
    // 此处覆盖 ensureConversationId 等前置 await 的异常(拒绝静默失败)
    flow.sendText(text, files)?.catch((err: Error) => {
      console.error('[shell] 消息发送失败(兜底):', err)
    })
    // 2026-08-13: P1-5 重试链路——记录用户消息到最近 running 任务面板
    try { window.dispatchEvent(new CustomEvent('crabpaw:user-sent', { detail: { text } })) } catch (e) { console.error('[shell] 用户消息事件派发失败:', e) }
  }, [speech, flow, cockpitVisible, historyDrawerOpen, pushChat, applyShellConfig, visibleSurfaces])

  // 2026-08-13: P1-5 任务失败重试——TaskPanelHost 派发 crabpaw:resend-message,
  // 复用完整 handleUserInput 发送链路(含本地命令拦截与 LLM)
  useEffect(() => {
    const onResend = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text
      if (!text) return
      handleUserInput(text)
    }
    window.addEventListener('crabpaw:resend-message', onResend)
    return () => window.removeEventListener('crabpaw:resend-message', onResend)
  }, [handleUserInput])

  // 2026-08-14 ag-ui 二次分析: AI 消息 hover 动作行——复制回复
  // （clipboard API 优先, 非安全上下文 execCommand 兜底, 不静默失败）
  const handleCopyMessage = useCallback((m: ChatMsg) => {
    const text = m.text || ''
    const done = () => toast.success('已复制到剪贴板')
    const fail = (err: unknown) => {
      console.error('[shell] 复制回复失败:', err instanceof Error ? err.message : String(err))
      toast.error('复制失败')
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail)
      return
    }
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      let ok = false
      try { ok = document.execCommand('copy') } catch (err) { throw err }
      document.body.removeChild(ta)
      if (ok) done(); else fail(new Error('execCommand copy 返回 false'))
    } catch (err) {
      fail(err)
    }
  }, [])

  // 2026-08-14 ag-ui 二次分析: 重新生成——找到该 AI 消息前最近一条用户消息,
  // 移除该问答对后经 handleUserInput 完整链路重发(copilot-regenerate-button 语义,
  // 面板命令拦截/会话上下文/代际守卫全部复用, 不新建旁路)
  const handleRegenerate = useCallback((m: ChatMsg) => {
    const idx = conversation.findIndex(x => x.ts === m.ts)
    if (idx < 0) return
    for (let i = idx - 1; i >= 0; i--) {
      if (conversation[i].role === 'user') {
        const userMsg = conversation[i]
        const removeTs = new Set([userMsg.ts, m.ts])
        const next = conversation.filter(x => !removeTs.has(x.ts))
        conversationRef.current = next
        setConversation(next)
        try { handleUserInput(userMsg.text) } catch (err) {
          console.error('[shell] 重新生成发送失败:', err)
          toast.error('重新生成失败')
        }
        return
      }
    }
    console.warn('[shell] 重新生成: 未找到可重发的用户消息')
    toast.error('未找到可重发的用户消息')
  }, [conversation, handleUserInput])

  // I-4 T2: chip 点击触发链——先本地命令拦截（导航/音乐/播报），未命中走面板命令+LLM
  const handleCommandChip = useCallback((cmdText: string) => {
    if (interceptLocalVoiceCommand(cmdText)) return
    handleUserInput(cmdText)
  }, [handleUserInput])

  // 附件上传：POST /upload（multipart，仅带 X-Api-Key——Content-Type 由浏览器自动带 boundary）
  const handlePickFiles = useCallback(() => fileInputRef.current?.click(), [])
  // 2026-09-06: 消息桥——面板组件（FileGenPanel error/paused 态"重新生成"）经
  // crabpaw:send-message 事件请求重发一条用户消息。面板与 VoiceShell 无父子通信
  // 通道，CustomEvent 桥是最小耦合方案（同 crabpaw:speak 模式）。
  useEffect(() => {
    const onSendMessage = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const text = typeof detail?.text === 'string' ? detail.text.trim() : ''
      if (!text) return
      handleUserInput(text)
    }
    window.addEventListener('crabpaw:send-message', onSendMessage)
    return () => window.removeEventListener('crabpaw:send-message', onSendMessage)
  }, [handleUserInput])
  const handleFilesChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || [])
    e.target.value = ''
    if (picked.length === 0 || uploading) return
    // 立即显示临时 chip（带进度百分比）
    const tempEntries = picked.map(f => ({ path: '', name: f.name, size: f.size, pending: true }))
    setAttachments(prev => [...prev, ...tempEntries])
    setUploadPct(0)
    setUploading(true)
    try {
      const { resolveApiUrl, getApiHeaders } = await import('../../lib/api')
      const [url, headers] = await Promise.all([resolveApiUrl('/upload'), getApiHeaders()])
      const fd = new FormData()
      for (const f of picked) fd.append('files', f, f.name)
      const { 'Content-Type': _ct, ...authHeaders } = headers
      // XHR 替代 fetch 以获取上传进度
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', url)
        for (const [k, v] of Object.entries(authHeaders)) {
          if (v) xhr.setRequestHeader(k, v as string)
        }
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const json = JSON.parse(xhr.responseText)
              if (!json?.success) { reject(new Error(json?.error || `上传失败 ${xhr.status}`)); return }
              // 移除临时条目，替换为服务端返回的真实条目
              setAttachments(prev => {
                const cleaned = prev.filter(a => !a.pending)
                const ups = (json.files || []).map((f: any) => ({ path: f.path, name: f.originalName, size: f.size, type: f.type }))
                return [...cleaned, ...ups]
              })
              resolve()
            } catch (e) { reject(e) }
          } else {
            reject(new Error(`HTTP ${xhr.status}`))
          }
        }
        xhr.onerror = () => reject(new Error('网络错误'))
        xhr.send(fd)
      })
    } catch (e: any) {
      console.error('[shell] 附件上传失败:', e?.message || e)
      // 移除临时条目
      setAttachments(prev => prev.filter(a => !a.pending))
      speech.enqueue({ id: `upload_${Date.now()}`, text: '附件上传失败，请重试', kind: 'panel' })
    } finally {
      setUploading(false)
      setUploadPct(0)
    }
  }, [uploading, speech])

  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // 2026-08-21: 气泡附件打开——Electron openPath 优先（本地文件系统默认程序；
  // openExternal 仅放行 https/http，本地路径会静默失败——实测修复），
  // 浏览器 dev 模式回退 window.open（/files/ URL，图片可直接看）
  const openAttachmentFile = useCallback((f: ChatMsgFile) => {
    try {
      const shell = (window as any).electronAPI?.shell
      if (shell?.openPath) {
        shell.openPath(f.path)
          .then((r: { success: boolean; error?: string }) => {
            if (r && !r.success) console.warn('[shell] 附件打开失败:', r.error)
          })
          .catch((e: Error) => console.warn('[shell] 附件打开失败:', e?.message || e))
        return
      }
      if (shell?.openExternal) {
        shell.openExternal(f.path).catch((e: Error) => console.warn('[shell] 附件打开失败:', e?.message || e))
        return
      }
      const url = fileUrlFor(f.path)
      if (url) window.open(url, '_blank', 'noopener,noreferrer')
      else console.warn('[shell] 浏览器模式无附件访问 URL:', f.path)
    } catch (err) { console.error('[shell] 打开附件失败:', err) }
  }, [])

  // Task 13: 从会话历史恢复消息到对话卡片
  // 2026-08-13 P2-4: 增加 sessionId 参数——恢复后续用该会话(上下文延续)
  const handleHistoryResume = useCallback((messages: Array<{ role: string; content: string; timestamp?: number }>, sessionId?: string) => {
    const converted: ChatMsg[] = []
    for (const m of messages) {
      // 2026-08-13 P2-1: tool 角色预留分支(本阶段工具消息不持久化,数据源无 tool 消息)
      const role = m.role === 'user' ? 'user' : m.role === 'tool' ? 'tool' : 'ai'
      const text = (m.content || '').trim()
      if (!text) continue
      converted.push({ role, text, ts: m.timestamp || nextChatTs() })
    }
    conversationRef.current = converted
    setConversation(converted)
    if (sessionId) {
      try { flowRef.current.resumeConversation(sessionId) } catch (err) { console.error('[shell] 续用会话失败:', err) }
    }
  }, [])

  // 恢复横幅"继续对话":优先用 run.conversationId 拉消息续上下文;兜底最近会话
  const handleResumeContinue = useCallback(async () => {
    const run = resumeBanner
    if (!run) return
    try {
      if (run.conversationId) {
        const res = await apiGet<{ messages: Array<{ role: string; content: string; timestamp?: number }> }>(
          `/api/sessions/${encodeURIComponent(run.conversationId)}`,
        )
        if (res.success && res.data?.messages) {
          handleHistoryResume(res.data.messages, run.conversationId)
          setResumeBanner(null)
          return
        }
      }
      // 兜底:拉最近一条语音会话
      const list = await apiGet<{ sessions: Array<{ sessionId: string }> }>('/api/sessions/list?userId=voice_shell_user')
      const latest = list?.data?.sessions?.[0]
      if (latest) {
        const res = await apiGet<{ messages: Array<{ role: string; content: string; timestamp?: number }> }>(
          `/api/sessions/${encodeURIComponent(latest.sessionId)}`,
        )
        if (res.success && res.data?.messages) handleHistoryResume(res.data.messages, latest.sessionId)
      }
      setResumeBanner(null)
    } catch (e) {
      console.error('[shell] 恢复会话失败:', (e as Error)?.message || e)
      setResumeBanner(null)
    }
  }, [resumeBanner, handleHistoryResume])

  // ── P7 T2 审查: 稳定 onDone 引用，避免每次渲染重启动画 ──
  const handleDissolveDone = useCallback(() => {
    try {
      executeCommand('pushHoloHistory', 'push', 'speak', postSpeakSegment || '(播报)')
    } catch (e) {
      console.error('[shell] 全息历史写入失败:', e)
    }
    setDissolveSource(null)
    setPostSpeakSegment(null)
  }, [postSpeakSegment])

  // 2026-08-14 ag-ui 二次分析: 生成中判定——pending(思考中)或流式气泡在屏时
  // 发送按钮合一为 ⏹ 停止(send/stop 按钮合一, CopilotKit copilot-send-button 语义)
  const isGenerating = flow.pending || streamingAiText !== ''

  // 文本发送：附件随消息携带，发送后清空
  const submitText = useCallback(() => {
    const text = textInput.trim()
    if (!text && attachments.length === 0) return
    const ready = attachments.filter(a => !a.pending)
    handleUserInput(text, ready.map(a => ({ path: a.path, name: a.name, size: a.size, type: a.type })))
    setTextInput('')
    setAttachments(prev => prev.filter(a => a.pending))
  }, [textInput, attachments, handleUserInput])

  return (
    <div className="voice-shell" data-layout={layoutMode} data-chat-collapsed={layoutMode === 'simple' && chatCollapsed ? 'true' : undefined} data-hotspot-open={hotspotPanelOpen ? 'true' : undefined}>
      <AmbientGlow intensity={orbMode === 'listening' ? 1.4 : 1} accent="purple" idle={orbMode === 'idle'} />

      <TaskOrbit />

      <header className="voice-shell-header">
        <div className="voice-shell-brand">
          <span className="voice-shell-brand-crab">🦀</span>
          CrabPaw
        </div>

        {/* P7 Task 10: 历史区 —— 右上角堆叠条，最多 3 条，点击展示摘要卡 */}
        {holoHistory.length > 0 && (
          <div className="holo-history">
            {holoHistory.map((item, idx) => (
              <button
                key={item.ts}
                type="button"
                className={`holo-history-item${expandedHistory === idx ? ' is-expanded' : ''}`}
                onClick={() => setExpandedHistory(expandedHistory === idx ? null : idx)}
                title={item.summary}
              >
                <span className="holo-history-kind">{item.kind === 'weather' ? '☀' : item.kind === 'speak' ? '📣' : '●'}</span>
                <span className="holo-history-summary">{item.summary.slice(0, 16)}{item.summary.length > 16 ? '…' : ''}</span>
                {expandedHistory === idx && (
                  <div className="holo-history-card" onClick={(e) => e.stopPropagation()}>
                    <div className="holo-history-card-kind">{item.kind === 'speak' ? '播报' : item.kind === 'weather' ? '天气' : item.kind}</div>
                    <div className="holo-history-card-text">{item.summary}</div>
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="voice-shell-header-right">
          {/* 2026-08-15 用户反馈: "全效"按钮无用已移除——性能模式库保持默认全效,
              如需降级可在管理舱设置(performance-mode lib 仍被 SceneShell 消费) */}
          {/* 2026-08-31 M3: 布局切换——⭐高级=恢复三栏(诊断/事件日志/工具执行可见) */}
          <button
            type="button"
            className={`voice-shell-console-btn${layoutMode === 'advanced' ? ' is-active' : ''}`}
            onClick={() => setLayoutMode(m => (m === 'advanced' ? 'simple' : 'advanced'))}
            title={layoutMode === 'advanced' ? '回到极简卡片布局' : '高级面板（事件日志/工具执行/服务详情）'}
          >
            <Columns size={13} />
          </button>
          {/* 2026-08-31 M3: 极简态下恢复默认卡片布局 */}
          {layoutMode === 'simple' && (
            <button
              type="button"
              className="voice-shell-console-btn"
              onClick={() => setLayoutResetNonce(n => n + 1)}
              title="恢复默认布局"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {/* 阶段 B: 管理舱按钮——「打开管理舱」即停靠总览（overview）；「系统管理」语义不变，
              设置/插件/技能/用量等 tab 仍在舱内可达（2026-08-12 移除独立 ⚙ 配置按钮） */}
          <button
            type="button"
            className={`voice-shell-console-btn${cockpitVisible ? ' is-active' : ''}`}
            onClick={() => {
              // A2: 历史抽屉由 sheet-state 互斥自动收起(overlay 顶掉)
              setCockpitTab('overview')
              setCockpitNavSection(null)
              setCockpitDebugTab('logs')
              setCockpitVisible(true)
            }}
            title="系统管理（设置/插件/技能/用量）"
          >
            <LayoutDashboard size={13} />
          </button>
          <button
            type="button"
            className="voice-shell-console-btn"
            onClick={() => {
              // A2: 管理舱由 sheet-state 互斥自动收起(overlay 顶掉)
              setHistoryDrawerOpen(true)
            }}
            title="历史会话"
          >
            <History size={13} />
          </button>
          {/* 2026-08-14 T-1: frameless 窗口控制（最小化/最大化/关闭）
              —— DingDong TitleBar 同款, preload electronAPI.window.* */}
          <div className="voice-shell-win-btns">
            <button type="button" className="voice-shell-win-btn" onClick={() => handleWindowAction('minimize')} title="最小化" aria-label="最小化">
              <Minus size={14} />
            </button>
            <button type="button" className="voice-shell-win-btn" onClick={() => handleWindowAction('maximize')} title="最大化/还原" aria-label="最大化/还原">
              <Square size={12} />
            </button>
            <button type="button" className="voice-shell-win-btn voice-shell-win-btn--close" onClick={() => handleWindowAction('close')} title="关闭" aria-label="关闭">
              <X size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* 三栏布局：左栏(消息处理器) | 中栏(对话) | 右栏(监控面板) */}
      <div className="voice-shell-layout">
        {/* 左栏：用户消息处理器 */}
        <aside className="voice-shell-sidebar voice-shell-sidebar--left">
          <AgentLeftPanel
            compact={hotspotPanelOpen}
            wsConnected={monitor.wsConnected}
            transactions={monitor.transactions}
            tools={monitor.toolCalls}
            memory={monitor.memoryCount}
            knowledge={monitor.knowledgeCount ?? '—'}
            decayed={monitor.decayedCount ?? '—'}
            logs={monitor.logs}
            orbMode={orbMode}
            muted={muted}
            volume={orbVolume}
            speechRate={speechRate}
            onToggleMute={toggleMute}
            onSpeechRate={setSpeechRateLevel}
            micMode={micMode}
            onCycleMicMode={cycleMicMode}
            /* 2026-08-19 三栏联动轮: 联动轮次(高亮) + 轮次选择(点击定位) */
            linkedRound={linkedRound ?? undefined}
            onRoundSelect={linkRound}
            onReset={() => {
              // G2: "新对话"与中栏"清空"按钮同口径——清对话卡 + 重置会话引用
              try { setConversation([]); conversationRef.current = [] } catch (err) { console.error('[shell] 新对话清空失败:', err) }
              try { flowRef.current?.newConversation() } catch (err) { console.error('[shell] 新对话重置会话失败:', err) }
            }}
          />
        </aside>

        {/* 中栏：对话布局（2026-08-13 重构：对话界面取代语音球居中布局） */}
        <main className="voice-shell-stage voice-shell-stage--chat">
        {/* 2026-08-13: confront 压暗层——z-6 低于场景卡 7/对话内容 30,
            pointer-events:none 保证不拦截任何交互(参考实现 intent 语义借鉴) */}
        {hasConfront && <div className="voice-shell-confront-scrim" aria-hidden />}
        {/* 保留 orb-halo 径向辉光作为背景层 */}
        <div className="orb-halo" data-mode={orbMode} />

        {/* 2026-08-13: 原语音球 orb-wrap / VoiceOrb / orb-hint / VoiceHintBar 已移除
            （对话布局由下方 voice-shell-chat-* 结构承载）。
            2026-08-13 G9: 残留变量已清理——orbTint/orbVariant/audioLevel 无消费删除；
            orbMode 仍保留以驱动 orb-halo 与顶部状态标签颜色。 */}

        {/* P7 Task 5: 全息场景层 —— SceneShell surface 渲染基座
            多场景同时展示——渲染所有 surfaces(横向卡片墙),而非只取最后一张。
            交互类(choice/form)独占全屏(用户需决策);普通卡片并列展示。
            2026-08-16 实机修复: holo-stage-item 从"非交互 kind → pointerEvents none"
            改为恒 auto——MetricCard 等普通卡片的关闭按钮/链接此前被 pointer-events
            禁用, 卡片"无法关闭"。容器仍为 none(点击穿透对话区), 卡片本身可交互。 */}
        {cardWallSurfaces.length > 0 && (
          <div
            className="holo-stage"
            style={{ pointerEvents: 'none' }}
          >
            {holoExpanded.map(s => (
              <div
                key={s.id}
                className="holo-stage-item"
                data-kind={s.kind}
                style={{ pointerEvents: 'auto' }}
              >
                <SceneSurfaceRenderer surface={s} compact />
              </div>
            ))}
            {/* B1: 超限收纳条——ambient 卡缩略, 点击展开(纯视觉) */}
            {holoStacked.length > 0 && (
              <div className="holo-stage-stack" style={{ pointerEvents: 'auto' }}>
                {holoStacked.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    className="holo-stage-stack-chip"
                    data-kind={s.kind}
                    onClick={() => setHoloStackExpanded(prev => new Set(prev).add(s.id))}
                    title={`展开 ${s.kind}`}
                  >
                    <span className="holo-stage-stack-icon" aria-hidden>◈</span>
                    <span className="holo-stage-stack-text">
                      {String(s.data?.title || s.data?.heading || s.data?.text || s.kind).slice(0, 24)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 2026-08-14: 文章/网页预览类卡片 → 独立阅读面板。
            此前为绝对定位覆盖层(left:24px/top:96px)悬浮在对话窗口上方——
            三栏对话布局下对话区占满舞台, 面板实际盖住消息区并拦截点击。
            现改为 flex 行内静态列: [阅读面板 | 对话列], 对话窗口右移而非被遮盖。 */}
        <div className="voice-shell-chat-row">
          {articleSurfaces.length > 0 && (
            <aside
              className="holo-stage holo-stage--articles"
              style={{ pointerEvents: 'auto' }}
              aria-label="文章阅读面板"
            >
              {articleSurfaces.map(s => (
                <div
                  key={s.id}
                  className="holo-stage-item"
                  data-kind={s.kind}
                  style={{ pointerEvents: 'auto' }}
                >
                  <SceneSurfaceRenderer surface={s} compact />
                </div>
              ))}
            </aside>
          )}

        {/* 思维条（2026-08-14 DingDong 对齐, AG-UI REASONING 语义）——
            仅在有真实思考内容(SSE thinking 事件)时渲染, 展示"正在想什么"的过程
            透明度; 与左栏消息日志(时间线)、右栏工具执行(调用过程)严格区分。
            2026-09-06(用户反馈): 空内容时的"思考中…"占位已删除——对话卡顶栏
            FocusRibbon(thinking 态)承担同一信号, 两处同显即重复。 */}
        {flow.currentThinking && (
          /* 2026-08-19 三栏联动轮: thinking 折叠——长思考(>120 字)默认截断,
             点击展开全文(思考条不占满对话区) */
          <div
            className="holo-phase-hint"
            onClick={() => setThinkingExpanded(v => !v)}
            title={(flow.currentThinking?.length ?? 0) > 120 ? (thinkingExpanded ? '点击收起' : '点击展开全文') : undefined}
          >
            {(() => {
              const t = flow.currentThinking
              if (t.length <= 120 || thinkingExpanded) return t
              return `${t.slice(0, 120)}…`
            })()}
            {(flow.currentThinking?.length ?? 0) > 120 && !thinkingExpanded && (
              <span style={{ color: 'rgba(125, 211, 252, 0.65)', marginLeft: 4 }}>[展开]</span>
            )}
          </div>
        )}

        {/* 恢复横幅——上次对话中断/失败后可无缝继续 */}
        {resumeBanner && (
          <div className="voice-shell-resume-banner">
            <span className="voice-shell-resume-text">
              {resumeBanner.status === 'error' ? '上次对话出现问题' : '上次对话已中断'}
              <span className="voice-shell-resume-time">
                {new Date(resumeBanner.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </span>
            <div className="voice-shell-resume-actions">
              <button type="button" onClick={() => { void handleResumeContinue() }}>继续对话</button>
              <button type="button" onClick={() => {
                try { flowRef.current.newConversation() } catch (e) { console.error('[shell] 新对话失败:', e) }
                setResumeBanner(null)
              }}>新对话</button>
            </div>
          </div>
        )}

        {/* ── 对话界面（2026-08-13 新增） ── */}

        {/* 对话列：顶栏 + 消息区 + 输入区 + 底部提示（与阅读面板同行, flex 右移） */}
        <div
          ref={chatCardRef}
          className="voice-shell-chat-col"
          data-chat-card={layoutMode === 'simple' ? 'true' : undefined}
          style={{ transform: layoutMode === 'simple' && chatDragOffset ? `translate(${chatDragOffset.x}px, ${chatDragOffset.y}px)` : undefined }}
          onPointerDown={chatDragHandlers.onPointerDown}
          onPointerMove={chatDragHandlers.onPointerMove}
          onPointerUp={chatDragHandlers.onPointerUp}
          onPointerCancel={chatDragHandlers.onPointerCancel}
          onLostPointerCapture={chatDragHandlers.onLostPointerCapture}
        >

        {/* 2026-08-15 用户反馈: 组合布局(热点/台风/股票)下语音球区块移到对话
            窗口上方——左栏完全让位, 页面不再因左栏残留 200px 而变形挤压。
            compact 横向小尺寸(96px 球)。 */}
        {hotspotPanelOpen && (
          <div className="voice-shell-orb-top-inline">
            <OrbTopBlock
              orbMode={orbMode}
              muted={muted}
              volume={orbVolume}
              speechRate={speechRate}
              micMode={micMode}
              compact
              onToggleMute={toggleMute}
              onSpeechRate={setSpeechRateLevel}
              onCycleMicMode={cycleMicMode}
            />
          </div>
        )}

        {/* 顶部栏：标题 + 清空按钮 */}
        <div className="voice-shell-chat-topbar">
          <span className="voice-shell-chat-title">💬</span>
          {/* B3: agent 注意带——极简布局下"在干什么/等什么"常驻可见 */}
          <FocusRibbon
            state={focusState}
            toolName={focusRunningTool?.toolName ?? null}
            toolStep={flow.toolEvents.length}
            pendingApprovals={approvalPendingCount}
          />
          <button
            type="button"
            className="voice-shell-chat-clear-btn"
            onClick={() => {
              try { setConversation([]); conversationRef.current = [] } catch (err) { console.error('[shell] 清空对话失败:', err) }
              try { flowRef.current.newConversation() } catch (err) { console.error('[shell] 重置会话失败:', err) }
            }}
            title="清空对话"
          >
            <Brush size={13} />
          </button>
          {layoutMode === 'simple' && (
            <button
              type="button"
              className="voice-shell-chat-clear-btn"
              onClick={() => setChatCollapsed(true)}
              title="收起对话"
            >
              <ChevronDown size={13} />
            </button>
          )}
        </div>

        {/* 对话区：空态提示/快捷建议 or 消息列表 */}
        <div className="voice-shell-chat-area">
          {conversation.length === 0 ? (
            <div className="voice-shell-chat-empty">
              <div className="voice-shell-chat-empty-hint">
                {/* P3(GUI 全量修复 P0): 提示按语音模式三态渲染——旧实现只分
                    pttOnly/其他两态, live(实时)模式唤醒词已禁用却仍提示"说小螃蟹",
                    用户照提示操作必然无反应 */}
                {shellConfig.pttOnly
                  ? '专注模式 · 按住空格键开始说话'
                  : shellConfig.continuousMode
                    ? '实时监听中 · 直接说话即可'
                    : '说「小螃蟹」或直接输入文字开始对话'}
              </div>
              {!shellConfig.pttOnly && (
                <div className="voice-shell-suggest">
                  {SUGGESTED_PROMPTS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="voice-shell-suggest-chip"
                      onClick={() => handleCommandChip(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="voice-shell-chat-messages" ref={chatMessagesRef} onScroll={handleChatScroll}>
              {/* 2026-08-14 ag-ui 二次分析: 移除 tool 角色 filter 死代码(tool 消息已不
                  进对话流, 自 08-14 起由侧栏承载); 消息完成才落卡→时间戳天然"完成后显示"
                  (Kotlin MessageBubble 同口径, 流式中不显示元数据) */}
              {conversation.map(m => (
                <div
                  key={m.ts}
                  className={`chatcard-msg chatcard-msg--${m.role}${linkedRound === m.round ? ' chatcard-msg--linked' : ''}`}
                  data-round={m.round ?? undefined}
                  /* 2026-08-19 三栏联动轮: 点击消息 → 左栏时间线高亮同轮组 + 右栏定位 */
                  onClick={m.round != null ? () => linkRound(m.round as number) : undefined}
                  title={m.role === 'user' ? '点击定位到时间线事件组' : undefined}
                >
                  {m.role === 'ai' ? (
                    <div className="chatcard-msg-avatar chatcard-msg-avatar--ai">
                      <span className="chatcard-msg-avatar-letter">
                        {/^(https?:|local:\/\/|\/)/.test(agentDisplayIcon)
                          ? <img src={agentDisplayIcon} alt="AI" className="chatcard-msg-avatar-img" />
                          : agentDisplayIcon}
                      </span>
                    </div>
                  ) : m.role === 'tool' ? (
                    <span className="chatcard-msg-label chatcard-msg-label--tool">🔧</span>
                  ) : (
                    <span className="chatcard-msg-username chatcard-msg-username--user">{m.channel === 'wecom' ? '企微' : 'YOU'}</span>
                  )}
                  <div className="chatcard-msg-col">
                    {m.role === 'ai' && (
                      <div className="chatcard-msg-name chatcard-msg-name--ai">{agentDisplayName}{m.channel === 'wecom' ? '（企微）' : ''}</div>
                    )}
                    <div className={`chatcard-msg-bubble${m.role === 'tool' ? ' chatcard-msg-bubble--tool' : m.role === 'ai' ? ' chatcard-msg-bubble--md' : ''}`}>
                      {/* 2026-08-21: 用户消息附件——图片缩略图 + 文件 chip，文本之前 */}
                      {m.role === 'user' && m.files && m.files.length > 0 && (
                        <div className="chatcard-attachments">
                          {m.files.map((f, i) => (
                            isImageAttachment(f.name) ? (
                              <img
                                key={`${f.path}-${i}`}
                                src={fileUrlFor(f.path)}
                                alt={f.name}
                                className="chatcard-attachment-img"
                                title={`${f.name}（点击打开原图）`}
                                onClick={() => openAttachmentFile(f)}
                                loading="lazy"
                              />
                            ) : (
                              <button
                                key={`${f.path}-${i}`}
                                type="button"
                                className="chatcard-attachment-file"
                                title={f.path}
                                onClick={() => openAttachmentFile(f)}
                              >
                                📎 {f.name}
                                {formatFileSize(f.size) ? <span className="chatcard-attachment-size"> {formatFileSize(f.size)}</span> : null}
                              </button>
                            )
                          ))}
                        </div>
                      )}
                      {m.role === 'ai'
                        ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: chatMarkdownLink }}>{m.text}</ReactMarkdown>
                        : m.text}
                    </div>
                    {/* 2026-08-14 ag-ui 二次分析: 消息时间戳(完成后才渲染) */}
                    <div className="chatcard-msg-time">
                      {new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                    </div>
                    {m.role === 'ai' && (() => {
                      /* 2026-08-19 三栏联动轮: 该轮工具批(历史/当前)——非空才显示 ⛓ 按钮 */
                      const batch = m.round != null ? getToolBatch(m.round) : null
                      const chainOpen = toolchainOpenTs.has(m.ts)
                      return (
                      <>
                      {/* 2026-08-25 界面对齐(小白龙步骤卡): 本轮工具 mini 徽标——
                          成功✓/失败✕/进行中⏳, 展开 ⛓ 看详情 */}
                      {batch && batch.length > 0 && (
                        <div className="chatcard-msg-runsum">
                          <span className="chatcard-msg-runsum-label">⟫ 本轮工具</span>
                          {batch.slice(0, 4).map((t) => (
                            <span key={t.toolId} className={`chatcard-msg-runsum-item chatcard-msg-runsum-item--${t.status}`}>
                              {t.status === 'error' ? '✕' : t.status === 'running' ? '⏳' : '✓'} {t.toolName}
                            </span>
                          ))}
                          {batch.length > 4 && <span className="chatcard-msg-runsum-more">+{batch.length - 4}</span>}
                        </div>
                      )}
                      <div className="chatcard-msg-actions">
                        {/* ag-ui 二次分析: hover 动作行扩展——复制/重新生成(copilot-regenerate-button) */}
                        <button
                          type="button"
                          className="chatcard-msg-action"
                          onClick={() => handleCopyMessage(m)}
                          title="复制回复"
                          aria-label="复制回复"
                        >📋</button>
                        <button
                          type="button"
                          className="chatcard-msg-action"
                          onClick={() => handleRegenerate(m)}
                          title="重新生成"
                          aria-label="重新生成"
                        >↻</button>
                        {batch && batch.length > 0 && (
                          <button
                            type="button"
                            className={`chatcard-msg-action${chainOpen ? ' is-active' : ''}`}
                            onClick={() => toggleToolchain(m.ts)}
                            title={`查看本轮工具链(${batch.length} 个工具)`}
                            aria-label={`工具链 ${batch.length} 个工具`}
                          >⛓ {batch.length}</button>
                        )}
                        <button
                          type="button"
                          className={`chatcard-msg-action ${feedbackMap.get(m.ts) === 'up' ? 'is-active' : ''}`}
                          onClick={() => handleMessageFeedback(m, 'up')}
                          title="有帮助"
                          aria-label="有帮助"
                        >👍</button>
                        <button
                          type="button"
                          className={`chatcard-msg-action ${feedbackMap.get(m.ts) === 'down' ? 'is-active' : ''}`}
                          onClick={() => handleMessageFeedback(m, 'down')}
                          title="不准确"
                          aria-label="不准确"
                        >👎</button>
                      </div>
                      {/* 2026-08-19 三栏联动轮: 工具链回看面板——该轮全部工具
                          调用/结果(名称/状态/参数/摘要), 消息旁内联展开 */}
                      {chainOpen && batch && batch.length > 0 && (
                        <div className="chatcard-toolchain">
                          {batch.map(t => (
                            <div key={t.toolId} className="chatcard-toolchain-item" data-status={t.status}>
                              <div className="chatcard-toolchain-head">
                                <span className={`chatcard-toolchain-dot chatcard-toolchain-dot--${t.status}`} />
                                <span className="chatcard-toolchain-name">{t.toolName}</span>
                                <span className="chatcard-toolchain-status">
                                  {t.status === 'running' ? '进行中' : t.status === 'error' ? '失败' : '完成'}
                                </span>
                              </div>
                              {t.args && (
                                <div className="chatcard-toolchain-args" title="工具参数">
                                  {t.args.length > 140 ? `${t.args.slice(0, 140)}…` : t.args}
                                </div>
                              )}
                              {t.summary && (
                                <div className="chatcard-toolchain-summary" title="结果摘要">{t.summary}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      </>
                      )
                    })()}
                  </div>
                </div>
              ))}
              {/* 2026-08-14 C-1: 流式回复气泡——增量实时显示 + ▌ 光标, 定稿落卡后自动消失 */}
              {streamingAiText !== '' && (
                <div className="chatcard-msg chatcard-msg--ai chatcard-msg--streaming">
                  <div className="chatcard-msg-avatar chatcard-msg-avatar--ai">
                    <span className="chatcard-msg-avatar-letter">{agentDisplayName.charAt(0)}</span>
                  </div>
                  <div className="chatcard-msg-col">
                    <div className="chatcard-msg-name chatcard-msg-name--ai">{agentDisplayName}</div>
                    <div className="chatcard-msg-bubble chatcard-msg-bubble--md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: chatMarkdownLink }}>{streamingAiText}</ReactMarkdown>
                      <span className="chatcard-stream-cursor" aria-hidden="true">▌</span>
                    </div>
                  </div>
                </div>
              )}
              {/* 2026-08-14(DingDong CardStream 对齐): 工具结果卡片流——内嵌聊天流,
                  四态生命周期(running→done/fail→2.5s 淡出), 与右栏过程卡双轨并存 */}
              <ToolCardStream runs={flow.toolEvents} />
            </div>
          )}
          {/* 2026-08-14 ag-ui 二次分析: 回底浮动按钮——离开底部才出现
              (copilot-scroll-to-bottom 语义, 40px 阈值同 Logs 页口径) */}
          {!chatAtBottom && conversation.length > 0 && (
            <button
              type="button"
              className="voice-shell-chat-gobottom"
              onClick={scrollChatToBottom}
              title="回到底部"
              aria-label="回到底部"
            >⬇</button>
          )}
        </div>

        {/* 输入区：文本输入 + 发送（对齐参考实现图例: 橙点提示 + 橙色渐变发送按钮）
            2026-08-19 P2 接管: 审批请求时输入区被接管——inline 审批卡嵌入输入区
            上方, 输入框/发送按钮禁用直到审批解决(对齐 AG-UI dojo HITL 输入区接管) */}
        <div className="voice-shell-chat-input-area voice-shell-chat-input-area--primary">
          {approvalPendingCount > 0 && (
            <div className="voice-shell-approval-banner">
              <span className="voice-shell-approval-banner-dot" />
              <span className="voice-shell-approval-banner-text">
                工具需要授权 · {approvalPendingCount} 个请求待处理(输入已暂停)
              </span>
            </div>
          )}
          <ApprovalHost variant="inline" onActiveChange={setApprovalPendingCount} />
          {attachments.length > 0 && (
            <div className="vs-attachments">
              {attachments.map((a, i) => (
                <span key={`${a.name}-${i}`} className="vs-attachment-chip" title={a.path || a.name}>
                  📎 {a.name}{a.pending && uploadPct > 0 ? <span className="vs-upload-pct"> {uploadPct}%</span> : null}
                  <button type="button" className="vs-attachment-remove" onClick={() => removeAttachment(i)}>✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="voice-shell-chat-input-row">
            <button
              type="button"
              className="vs-attach-btn vs-attach-btn--round"
              onClick={handlePickFiles}
              disabled={uploading}
              title="上传附件"
              aria-label="上传附件"
            >
              {/* 2026-08-20: emoji 📎 换内联 SVG 回形针——emoji 在小按钮内跨平台
                  渲染粗糙(彩色/位图), SVG stroke 随 currentColor, 与深色主题一致;
                  上传中同图标旋转(不再用 ⏳) */}
              <svg className={`vs-attach-icon${uploading ? ' vs-attach-icon--busy' : ''}`} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <input
              className="voice-shell-chat-input-field"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              /* 2026-08-14 ag-ui 二次分析: IME 组合守卫——拼音候选词确认回车不误发送
                 (isComposing 为真时 Enter 属于输入法选词, 不触发提交)
                 2026-08-19 修复: 改自跟踪 composingRef——原生 isComposing 在组合中途
                 失焦后卡死为 true,回车永远被吞;ref + blur 取消后失焦即恢复可用 */
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => { composingRef.current = false }}
              onBlur={() => { composingRef.current = false }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !composingRef.current) submitText() }}
              /* 2026-08-25 界面对齐: placeholder 随语音模式给出常驻操作提示 */
              placeholder={approvalPendingCount > 0
                ? '审批处理中…'
                : attachments.length > 0 ? '补充说明（可选）…'
                : muted ? '语音已关闭 · 点击左侧语音球开启语音'
                : shellConfig.pttOnly ? '␣ 按住空格键开始说话 · 或输入文字回车发送'
                : shellConfig.continuousMode ? '实时监听中 · 直接说话 · 或输入文字回车发送'
                : '⚡ 输入文字回车发送 · 空格说话或说唤醒词'}
              disabled={uploading || approvalPendingCount > 0}
            />
            {/* 2026-08-14 ag-ui 二次分析: 生成中按钮合一为 ⏹ 停止(发送/停止切换,
                停止后保留已收部分回复——useChatStream.abort 静默返回语义) */}
            <button
              type="button"
              className={`voice-shell-chat-send-btn${isGenerating ? ' voice-shell-chat-send-btn--stop' : ''}`}
              onClick={isGenerating ? flow.stopGenerating : submitText}
              disabled={uploading || approvalPendingCount > 0}
            >
              {isGenerating ? <Square size={12} fill="currentColor" /> : <Send size={16} />}
            </button>
          </div>
          <div className="voice-shell-chat-input-footer">
            <span className="voice-shell-chat-input-footer-dot" />
            {muted
              ? '已静音 · 点击左侧语音球恢复声音'
              : shellConfig.pttOnly
                ? '按住空格键开始说话'
                : shellConfig.continuousMode
                  ? '实时监听中 · 直接说话即可'
                  : '按住空格键开始说话'}
          </div>
        </div>
        </div>
        </div>
      </main>

        {/* 右栏：意识心息 + 行动日志 + 思考工具。
            2026-08-14 G1: 语音球/语速已迁至左栏（DingDong agent-header 对齐），
            右栏恢复纯监控——AgentRightPanel 顶部直接开始。 */}
        <aside className="voice-shell-sidebar voice-shell-sidebar--right">
          <div className="voice-shell-right-panel-wrap">
          <AgentRightPanel
            statusLabel={monitor.wsConnected ? '已连接' : '重连中'}
            lastAction={monitor.lastAction}
            toolRuns={flow.toolEvents}
            activeToolCount={flow.toolEvents.filter(r => r.status === 'running').length}
            online={monitor.wsConnected}
            services={healthServices}
            voiceEngineOk={!voiceEngineFatal}
            heartBeatCount={monitor.heartBeatCount != null ? String(monitor.heartBeatCount) : '—'}
            heartBeatActive={monitor.heartBeatActive}
            /* 2026-08-19 三栏联动轮: 工具卡/步骤行点击 → 定位当前轮(中栏滚动+左栏高亮) */
            onRoundSelect={() => { if (lastUserRoundRef.current != null) linkRound(lastUserRoundRef.current) }}
          />
          </div>
        </aside>
      </div>

      {/* 2026-08-31 M3: 极简三卡片 —— 心跳(左) / 语音球(中) / 对话窗(右, 见 chat-col) */}
      {layoutMode === 'simple' && (
        <>
          <ShellFloatCard
            cardKey="heartbeat"
            title="◉ 心跳"
            width={264}
            defaultOffset={{ x: 24, y: 120 }}
            resetNonce={layoutResetNonce}
            blur="sm"
          >
            <HeartbeatCard
              online={monitor.wsConnected}
              heartBeatActive={monitor.heartBeatActive}
              heartBeatCount={monitor.heartBeatCount}
              services={healthServices ?? undefined}
              voiceEngineOk={!voiceEngineFatal}
              speaking={orbMode === 'speaking'}
            />
          </ShellFloatCard>
          {layoutMode === 'simple' && chatCollapsed && (
            <ShellFloatCard
              cardKey="chat-mini"
              title="💬 对话"
              width={264}
              defaultOffset={{ x: Math.max(8, window.innerWidth - 304), y: 96 }}
              resetNonce={layoutResetNonce}
              blur="sm"
              dragOnButtons
            >
              <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button
                  type="button"
                  className="voice-shell-console-btn"
                  style={{ fontSize: 12 }}
                  onClick={() => setChatCollapsed(false)}
                >
                  ⤢ 展开对话
                </button>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>按住空格说话</span>
              </div>
            </ShellFloatCard>
          )}
          {layoutMode === 'simple' && (
            <SysInfoCard
              logs={monitor.logs}
              toolRuns={flow.toolEvents}
              activeToolCount={flow.toolEvents.filter(r => r.status === 'running').length}
              resetNonce={layoutResetNonce}
            />
          )}
          <ShellFloatCard
            cardKey="orb"
            domId={ORB_FLOAT_DOM_ID}
            title="◉ 语音"
            bare
            width={442}
            defaultOffset={{ x: Math.max(8, (window.innerWidth / 2) - 221), y: 110 }}
            resetNonce={layoutResetNonce}
            blur="sm"
            dragOnButtons
          >
            <div style={{ padding: '6px 0 4px' }}>
              <OrbTopBlock
                orbMode={orbMode}
                muted={muted}
                volume={orbVolume}
                speechRate={speechRate}
                micMode={micMode}
                size={250}
                onToggleMute={toggleMute}
                onSpeechRate={setSpeechRateLevel}
                onCycleMicMode={cycleMicMode}
              />
            </div>
          </ShellFloatCard>
        </>
      )}

      {/* 附件选择（隐藏 input） */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={handleFilesChange}
        accept=".txt,.md,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.json,.html,.png,.jpg,.jpeg,.zip,.mp3,.mp4"
      />

      {/* 2026-08-12: 独立 ⚙ 配置面板已移除——配置功能归入管理舱 settings tab
          （同一完整 Settings 组件，自带 dirty 检查 requestClose） */}
      {/* 阶段 B: 管理舱浮层（2026-08-19 业务面板退役迁入；2026-08-21「专家·数据」拆分专家/数据两 tab） */}
      <ManagementCockpit
        visible={cockpitVisible}
        initialTab={cockpitTab}
        navSection={cockpitNavSection}
        debugTab={cockpitDebugTab}
        keyword={cockpitKeyword}
        onClose={() => {
          try {
            setCockpitVisible(false)
            setCockpitKeyword(null)   // 搜索直达关键词一次性消费, 防止下次打开面板残留旧过滤
          } catch (err) { console.error('[shell] 管理舱关闭:', err) }
        }}
        onInsertToChat={(text) => {
          // 2026-08-21 实机反馈修复: 专家召唤/示例问答 → 插入输入框草稿, 由用户补充需求后回车发送。
          // 原 P2-5 自动发送已废弃——孤立专家名直接提交会令智能体无从作答。
          if (text) {
            setTextInput((prev) => (prev ? `${prev} ${text}` : text))
          }
        }}
      />


      {/* 语音机制编排（全局，含 PTT/常开/Barge-in） */}
      <VoiceIntegration
        replyEnabled={shellConfig.replyEnabled && !muted}
        muted={muted}
        onUnmuteRequest={unmute}
        ttsPlaying={flow.ttsPlaying}
        continuousMode={shellConfig.continuousMode && !muted}
        wakeWordEnabled={shellConfig.wakeWordEnabled && !muted}
        pttOnly={shellConfig.pttOnly && !muted}
        asrProvider={shellConfig.asrProvider}
        sendMessage={handleUserInput}
        onStateChange={handleStateChange}
      />

      {/* P7 Task 2: 消散沉降动画 —— 播报停留 3s 后触发，canvas 全视口粒子 */}
      <HoloDissolve
        sourceRect={dissolveSource}
        onDone={handleDissolveDone}
      />

      {/* Ctrl+K 全局命令面板 */}
      <CommandPalette />

      {/* P6(GUI 全量修复 P1): 协作轨道恢复挂载(共享播报队列, 空轨道自隐藏) */}
      <CollabOrbit speechQueue={speech} />

      {/* Task 13: 会话历史抽屉 */}
      <SessionDrawer
        open={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        onResume={handleHistoryResume}
      />
    </div>
  )
}
