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
import { MorningBriefingStrip } from '../../components/MorningBriefingStrip'
// ── 2026-09-21 P2-1 拆分: 语音配置域/对话类型/单条消息渲染移出主文件 ──
import { useShellVoiceConfig } from './useShellVoiceConfig'
import type { ChatMsg, ChatMsgFile } from './types'
import { ChatMessageItem, ChatEmptyState, StreamingBubble, RtTypingIndicator } from './ChatMessages'
import { ChatInputArea } from './ChatInputArea'
import { useRoundtableChat } from './useRoundtableChat'
import { useChatMessages, nextChatTs } from './useChatMessages'
import { useCommandIntercept } from './useCommandIntercept'
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
import { stripCommandPrefix } from '../../lib/voice-panel-commands'
import { deriveAgentFocus, deriveOrbMode, deriveOrbVolume } from '../../lib/voice-orb-state'
import { interceptLocalVoiceCommand } from '../../lib/voiceCommands'
import { apiGet } from '../../lib/api'
import { useDraggable } from '../../lib/useDraggable'
import { ShellFloatCard } from '../../components/ShellFloatCard'
import { sweepCompositorDeferred } from '../../lib/compositor'
import { HeartbeatCard } from '../../components/HeartbeatCard'
import { SysInfoCard } from '../../components/SysInfoCard'
import { fileUrlFor } from '../../lib/attachment'
import { isCardWallKind, loadDismissedKeys, saveDismissedKeys } from '../../lib/surface-utils'
import { nextPhaseThreshold, phaseText, sceneFromPhase } from '../../lib/holo-phase'
import { Minus, Square, X, Columns, RotateCcw, LayoutDashboard, History, Brush, ChevronDown,  } from 'lucide-react'
import { toast } from 'sonner'
import { ManagementCockpit, type CockpitTab } from '../../components/ManagementCockpit'
import { COCKPIT_TAB_MAP } from '../../lib/cockpit-navigation'
import { activateOverlay, closeSheet } from '../../components/SideSheet/sheet-state'
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
import { FocusRibbon } from '../../components/FocusRibbon'
import { ORB_FLOAT_DOM_ID } from '../../lib/collab-orbit'
import './styles.css'
// 2026-08-19 排版修复: 对话气泡启用 Markdown 渲染(react-markdown + GFM 已在依赖,
// FileGenPanel 同款用法)——此前纯文本直出, LLM 输出的 **加粗**/- 列表/链接
// 原样显示源码字符, 用户看到"没有格式化排版"。

// 2026-09-21 P2-1: chatMarkdownLink 移至 ./ChatMessages（唯一定义点, 本文件 import 使用）
// SHELL_VOICE_KEY 同样来自 ./shellVoiceConfig

// 2026-08-13 key 冲突根治: 模块级单调序号——pushChat/handleHistoryResume/
// holoHistory 共用。此前 pushChat 仅检查与前一条 ts 碰撞,3 条以上同毫秒连发
// 仍产生重复 key(React 警告 "Encountered two children with the same key",
// 可能导致 children 重复/省略)。序号保证同毫秒内递增唯一 + 单调不回拨。
// ── 2026-09-21 P2-1 拆分: ShellVoiceConfig/SHELL_VOICE_DEFAULTS/normalizeVoiceSection/
// voiceSectionForShell/fetchConfigForShell 整域移至 ./shellVoiceConfig（纯搬运零行为变化）

export function VoiceShell() {
  // ── 2026-09-21 P2-1 第三批: 语音配置状态域搬至 ./useShellVoiceConfig（含加载/迁移/
  // 自愈/监听/派生/写入通道，行为逐字一致） ──
  const { shellConfig, muted, dialogChannel, voiceConfig, agentDisplayName, agentDisplayIcon, applyShellConfig } = useShellVoiceConfig()
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

  // 2026-08-14: 语速三档高亮（语速配置已从左栏迁移到右上角语音球下方）
  const [speechRate, setSpeechRate] = useState<'low' | 'default' | 'high'>('default')

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

  // 2026-09-17: 语音对话通道——设置页切换, 缺省 classic(既有链路不动)

  const flow = useVoiceChatFlow(voiceConfig, muted, handlePhase, {
    ttsMode: dialogChannel,
    // realtime: 回复终稿(含断线补投/错误文案)回喂实时模型口播——模型自己有嗓音
    onReplyFinal: (text: string) => {
      const t = (text || '').trim()
      if (!t) return
      const w = window as any
      if (typeof w.__rtVoiceSpeak === 'function') w.__rtVoiceSpeak(t)
    },
    // realtime: 首句流式口播——DeepSeek 回复第一个完整句立即出声(不等全文+工具链)
    onReplySentence: (sentence: string) => {
      const w = window as any
      if (typeof w.__rtVoiceSpeak === 'function') w.__rtVoiceSpeak(sentence)
    },
  })
  // G7: 左右栏真实数据（SSE activity + memory stats + runs/active）
  const monitor = useAgentMonitor()
  // ── 2026-09-21 P2-1 第四批: 对话消息状态域搬至 ./useChatMessages（flow 注入解循环，
  // 返回同名变量, 宿主引用点零改动） ──
  const { conversation, setConversation, conversationRef, pushChat, roundSeqRef, lastUserRoundRef, lastAiPushedRef, feedbackMap, handleMessageFeedback, getToolBatch, toolchainOpenTs, toggleToolchain, linkedRound, linkRound, chatMessagesRef, chatAtBottom, handleChatScroll, scrollChatToBottom, streamingAiText } = useChatMessages(flow)

  // 2026-09-20 圆桌会——会议过程/内容直接以对话气泡进对话流（署名气泡/插话/收口）。
  // realtime 双工激活时自动静音（防双音/半双工原则）。
  const roundtable = useRoundtableChat(pushChat, dialogChannel)

  // ── 2026-08-14 ag-ui 二次分析：右栏双区块日志分区 ──
  // 2026-08-15 左右日志合并: 右栏历史区块(行动日志/思考与工具)并入左栏全量
  // 事件时间线——此处不再计算分区, 右栏仅保留本轮工具过程(flow.toolEvents)。

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
      // 2026-09-22: 专注模式下 dialogChannel 运行时强制 classic(useShellVoiceConfig)——
      // realtime 全双工与「仅按住空格」不兼容(见 hook 内注释)
      applyShellConfig(v => ({ ...v, pttOnly: true, continuousMode: false, wakeWordEnabled: false }))
      enqueue(shellConfig.dialogChannel === 'realtime'
        ? '已切换到专注模式，仅按住空格说话。实时全双工通道与专注模式暂不兼容，已临时使用经典语音通道，退出专注自动恢复'
        : '已切换到专注模式，仅按住空格说话')
    }
  }, [shellConfig.pttOnly, shellConfig.continuousMode, shellConfig.dialogChannel, applyShellConfig])

  // P5.5: 共享播报队列（面板确认播报 + CollabOrbit 协作播报共用，防双音）
  // 2026-08-14: 播报队列跟随用户 TTS 配置(音色/语速)——此前 hook 内硬编码
  // zh-CN-XiaoxiaoNeural/1.0,Settings 修改对面板确认/阶段播报等队列播报不生效
  const speechQueue = useSpeechQueue({ isTtsPlaying: flow.ttsPlaying || flow.isSpeaking, muted, voice: shellConfig.defaultVoice, speed: shellConfig.speed })
  // 2026-09-17: 实时通道——确认播报(面板开关/导航/模式提示/阶段播报)统一改喂
  // 实时模型口播(单一嗓子)。classic 豆包 TTS 队列在实时模式下不再出声,
  // 避免"关卡片是另一个声音"的双通道混音。
  const speech = useMemo(() => {
    if (dialogChannel !== 'realtime') return speechQueue
    return {
      ...speechQueue,
      enqueue: (job: { id: string; text: string; kind?: string }) => {
        const w = window as any
        if (typeof w.__rtVoiceSpeak === 'function') w.__rtVoiceSpeak(job.text)
      },
    }
  }, [speechQueue, dialogChannel])
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
    // 2026-09-17: GPU 幽灵层清扫——场景卡(台风地图 canvas 等)关闭后残留合成层
    // 会"画"回屏幕(实测"关闭卡片后顶部菜单栏消失"三进宫), 与 SideSheet 同款兜底
    sweepCompositorDeferred(600)
  }, [dismissKey])
  const visibleSurfaces = useMemo(
    () => stageSurfaces.filter(s => !dismissedIds.has(dismissKey(s))),
    [stageSurfaces, dismissedIds, dismissKey],
  )
  // 2026-09-22: GPU 幽灵层清扫扩面——此前只挂 dismissSurface(手动关卡)与 SideSheet
  // 关闭, 用户实测"ShowWeather 工具后底部输入区/顶部卡被暗层盖住"仍复现: 场景卡由
  // 后端 scene/remove 或 surface 替换离场时不走 dismiss, 残留合成层无清扫。改为
  // 监听可见 surface 集合——任何 surface 离开渲染(关闭/替换/清空)即延迟清扫,
  // 覆盖全部离场路径(与 dismissSurface 内的清扫幂等, 重复触发无害)。
  const prevSurfaceIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    // 用 surface.id 而非 dismissKey(id@data)——data 更新(天气定时刷新)会变 key,
    // 误判为离场导致周期性无谓清扫; 只有 id 消失才是真离场
    const ids = new Set(visibleSurfaces.map(s => s.id))
    const prev = prevSurfaceIdsRef.current
    prevSurfaceIdsRef.current = ids
    if (prev === null) return // 首帧只建立基线
    for (const k of prev) {
      if (!ids.has(k)) { sweepCompositorDeferred(600); break }
    }
  }, [visibleSurfaces])
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
    // 2026-09-17: 本地关卡桥(实时语音"关闭XX卡片"秒关, 不走 LLM)——
    // kindHint 按口语关键词映射 surface kind; 无匹配/未指定时关最上层。
    const w = window as any
    w.__rtCloseCard = (kindHint?: string): string => {
      const KIND_MAP: Array<{ re: RegExp; kinds: string[]; label: string }> = [
        { re: /文件|文章|文档|doc/i, kinds: ['document', 'web-preview', 'contract'], label: '文件卡片' },
        { re: /台风/, kinds: ['typhoon'], label: '台风卡片' },
        { re: /天气/, kinds: ['weather'], label: '天气卡片' },
        { re: /热点|新闻/, kinds: ['hotspot'], label: '热点卡片' },
        { re: /日程|日历/, kinds: ['schedule'], label: '日程卡片' },
        { re: /知识/, kinds: ['knowledge'], label: '知识库卡片' },
      ]
      if (kindHint) {
        for (const entry of KIND_MAP) {
          if (!entry.re.test(kindHint)) continue
          const closed = entry.kinds.some(k => api.setVisible(k, false))
          return closed ? `已关闭${entry.label}` : `当前没有${entry.label}`
        }
      }
      api.closeTop()
      return '已关闭最上层的卡片'
    }
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
  // 2026-09-21 创新-B: 决策卡"追问"按钮预填后聚焦输入框
  const chatInputRef = useRef<HTMLInputElement>(null)
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

  // 公共输入处理：语音与文本输入共用（专注模式命令 → 面板命令 → 音乐快速关闭 → rearm + 发送）
  // ── 2026-09-21 P2-1 第五批: 本地命令拦截瀑布搬至 ./useCommandIntercept
  // （专注开关/裸关闭/例会确认环/专家召唤/面板大分发/音乐兜底/录制隔离） ──
  const interceptCommand = useCommandIntercept({
    speech, applyShellConfig, pushChat,
    cockpit: {
      visible: cockpitVisible, setVisible: setCockpitVisible,
      setTab: setCockpitTab, setNavSection: setCockpitNavSection, setDebugTab: setCockpitDebugTab,
    },
    setHistoryDrawerOpen,
    visibleSurfaces,
  })

  const handleUserInput = useCallback((text: string, files?: { path: string; name: string }[], voiceContext?: Array<{ text: string }>) => {
    const t = text.trim().toLowerCase()
    // 2026-08-07: 剥离呼唤前缀——用户每句常带"小龙女，…"，前缀污染导致
    // 面板命令全部落 LLM（幻觉播报"已打开"实际没执行 + 4-6s 慢响应）。
    // 剥离后命令匹配命中率大幅提升；剥离失败/无前缀时保持原文本。
    // 2026-08-12 (P1 缺陷 4): 剥离逻辑抽到 lib/stripCommandPrefix（可测）——
    // 补默认唤醒词"小螃蟹"，且唤醒词允许零分隔符连读（"小螃蟹打开股票"无标点也要剥离）。
    const ct = stripCommandPrefix(t)
    if (interceptCommand(t, ct)) return
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
    flow.sendText(text, files, voiceContext)?.catch((err: Error) => {
      console.error('[shell] 消息发送失败(兜底):', err)
    })
    // 2026-08-13: P1-5 重试链路——记录用户消息到最近 running 任务面板
    try { window.dispatchEvent(new CustomEvent('crabpaw:user-sent', { detail: { text } })) } catch (e) { console.error('[shell] 用户消息事件派发失败:', e) }
  }, [flow, interceptCommand])

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
          {/* 2026-09-21 晨报带——零输入信息层: 日程/应收逾期/临期合同/本月营收,
              数据全无时整条隐藏; 点击指标块经 handleCommandChip 直发追问 */}
          <MorningBriefingStrip onAsk={handleCommandChip} />
          {conversation.length === 0 ? (
            <ChatEmptyState
              pttOnly={shellConfig.pttOnly}
              continuousMode={shellConfig.continuousMode}
              onAsk={handleCommandChip}
            />
          ) : (
            <div className="voice-shell-chat-messages" ref={chatMessagesRef} onScroll={handleChatScroll}>
              {/* 2026-08-14 ag-ui 二次分析: 移除 tool 角色 filter 死代码(tool 消息已不
                  进对话流, 自 08-14 起由侧栏承载); 消息完成才落卡→时间戳天然"完成后显示"
                  (Kotlin MessageBubble 同口径, 流式中不显示元数据) */}
              {conversation.map(m => (
                <ChatMessageItem
                  key={m.ts}
                  m={m}
                  linked={linkedRound === m.round}
                  agentDisplayName={agentDisplayName}
                  agentDisplayIcon={agentDisplayIcon}
                  feedback={feedbackMap.get(m.ts)}
                  onLinkRound={linkRound}
                  onOpenAttachment={openAttachmentFile}
                  onFollowUp={() => {
                    setTextInput('关于刚才的结论，我想追问：')
                    chatInputRef.current?.focus()
                  }}
                  getToolBatch={getToolBatch}
                  toolchainOpen={toolchainOpenTs.has(m.ts)}
                  onToggleToolchain={toggleToolchain}
                  onCopy={handleCopyMessage}
                  onRegenerate={handleRegenerate}
                  onFeedback={handleMessageFeedback}
                />
              ))}
              <StreamingBubble agentDisplayName={agentDisplayName} text={streamingAiText} />
              <RtTypingIndicator running={roundtable.running} typing={roundtable.typing} />
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

        {/* 2026-09-21 P2-1: 输入区整体拆至 ./ChatInputArea（JSX 逐字搬移） */}
        <ChatInputArea
          roundtableRunning={roundtable.running}
          roundtableGoal={roundtable.goal || ''}
          roundtableMuted={roundtable.muted}
          onToggleRoundtableMuted={roundtable.toggleMuted}
          approvalPendingCount={approvalPendingCount}
          onApprovalActiveChange={setApprovalPendingCount}
          attachments={attachments}
          uploadPct={uploadPct}
          uploading={uploading}
          onRemoveAttachment={removeAttachment}
          onPickFiles={handlePickFiles}
          textInput={textInput}
          onTextInputChange={setTextInput}
          inputRef={chatInputRef}
          composingRef={composingRef}
          onSubmit={submitText}
          muted={muted}
          pttOnly={shellConfig.pttOnly}
          continuousMode={shellConfig.continuousMode}
          isGenerating={isGenerating}
          onStopGenerating={flow.stopGenerating}
        />
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
        dialogChannel={dialogChannel}
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
