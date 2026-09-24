/**
 * useRoundtable — 圆桌会前端状态机（SSE 驱动）+ 多音色顺序播报
 *
 * 2026-09-20 二次重构（用户实测反馈）：会议过程与内容**直接以对话气泡进对话流**，
 * 不再渲染独立圆桌卡——本 hook 只负责三件事：
 *   ①SSE roundtable:* → 回调（onStatement/onIntervention/onConclusion/onDocument/onEnded），
 *     由 VoiceShell pushChat 落成普通消息（专家署名气泡/老板右侧气泡）；
 *   ②多音色顺序播报队列（文本永远是真值，合成失败降级纯文字不阻塞会议）；
 *   ③会议进行中状态 + "正在输入" + 静音开关（realtime 双工通道自动静音防双音）。
 *
 * 插话通道：不设独立输入框——会议进行中老板在主输入框/语音说的话，由后端
 * chat-handler 守卫转交会场（interveneRoundtable），SSE 回来即普通用户气泡。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSse } from './useSSE'
import { apiPost } from '../lib/api'

export interface RtParticipant {
  id: string
  name: string
  title?: string
  icon?: string
  department?: string
  voice?: string
}

export interface RtStatement {
  seq: number
  round: number
  expertId: string
  expertName: string
  icon?: string
  department?: string
  voice?: string
  text: string
  failed?: boolean
  ts: number
}

export interface RtIntervention {
  seq: number
  text: string
  ts: number
}

export interface RtConclusion {
  text: string
  tasks: Array<{ owner: string; task: string }>
}

export interface RtDocument {
  name: string
  path: string
  size?: number
}

/** 部门七色（对话流专家头像着色用） */
const DEPT_COLORS: Record<string, string> = {
  finance: '#e91e63',
  marketing: '#ff9800',
  sales: '#4caf50',
  hr_admin: '#9c27b0',
  tech_digital: '#03a9f4',
  legal: '#795548',
  strategy_invest: '#5c6bc0',
}

export function rtDeptColor(dept?: string): string {
  return (dept && DEPT_COLORS[dept]) || '#607d8b'
}

/** 后端实际广播的阶段序列（src/core/experts/roundtable.js 的 _setPhase 调用点） */
export const RT_PHASES = ['round1', 'round2', 'synthesis', 'document', 'done'] as const

/**
 * 阶段 → 人话（2026-09-22 体验层）。
 *
 * 背景：后端从第一天就在广播 `roundtable:phase`（round1/round2/synthesis/
 * document/done），但前端 useRoundtable 从未订阅——老板看到的只有"进行中"
 * 一条横幅，不知道进行到哪、还剩几轮。这里把已有事件翻成人话。
 */
export function rtPhaseLabel(phase?: string, round?: number): string {
  switch (phase) {
    case 'round1': return '第 1 轮 · 各自陈述'
    case 'round2': return '第 2 轮 · 交叉质询'
    case 'synthesis': return '主持人收口'
    case 'document': return '生成会议纪要'
    case 'done': return '已结束'
    default: return round ? `第 ${round} 轮` : ''
  }
}

/** 阶段在序列中的位置（0-based）；未知阶段返回 -1——不编造进度 */
export function rtPhaseIndex(phase?: string): number {
  return RT_PHASES.indexOf(phase as (typeof RT_PHASES)[number])
}

interface RtSpeechJob {
  key: string
  text: string
  voice: string
}

export interface RoundtableCallbacks {
  /** realtime 双工通道占用时传 true——本场自动静音（防双音） */
  initialMuted?: boolean
  /** 一条专家发言 → 专家署名气泡 */
  onStatement?: (s: RtStatement) => void
  /** 一条老板插话（SSE 回声，含语音路径转交的）→ 用户气泡 */
  onIntervention?: (it: RtIntervention) => void
  /** 主持收口 → 结论+任务清单消息（第二个参数为主持人，供署名） */
  onConclusion?: (c: RtConclusion, host: RtParticipant | null) => void
  /** 会前实算数据简报 → 系统提示行（专家引用数字的来源，透明过程的一部分） */
  onBrief?: (text: string) => void
  /** 纪要文档生成 → 系统提示行（文件卡由 file_generated 既有机制承载） */
  onDocument?: (doc: RtDocument) => void
  /** 会议结束（status: done|error） */
  onEnded?: (status: string, error?: string | null) => void
}

export function useRoundtableMeetings(options: RoundtableCallbacks = {}) {
  const cbRef = useRef(options)
  cbRef.current = options
  const hostRef = useRef<RtParticipant | null>(null)
  const membersRef = useRef<RtParticipant[]>([])

  const [running, setRunning] = useState(false)
  const [goal, setGoal] = useState('')
  const [typing, setTyping] = useState<{ name: string; dept?: string } | null>(null)
  const [muted, setMuted] = useState(options.initialMuted ?? false)
  // 2026-09-22 体验层: 会议阶段与到场情况。
  // 后端一直在广播 roundtable:phase（round1/round2/synthesis/document/done），
  // 此前前端无人订阅——老板只看到"进行中"，不知道进行到哪、几位专家已发过言。
  const [phase, setPhase] = useState<string>('')
  const [roster, setRoster] = useState<RtParticipant[]>([])
  const [spokenCount, setSpokenCount] = useState(0)
  const spokenRef = useRef<Set<string>>(new Set())
  // 2026-09-23 中止能力: 当前会议 id（取消要带 id）+ 中止请求已发出（按钮转"中止中…"，
  // 直到 roundtable:ended 到达才复位）
  const [meetingId, setMeetingId] = useState<string>('')
  const [cancelling, setCancelling] = useState(false)
  const meetingIdRef = useRef<string>('')
  const mutedRef = useRef(options.initialMuted ?? false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<RtSpeechJob[]>([])
  const drainingRef = useRef(false)

  const stopPlayback = useCallback(() => {
    queueRef.current = []
    try { audioRef.current?.pause() } catch { /* 已释放 */ }
    audioRef.current = null
  }, [])

  // realtime 等外部静音诉求变化时同步（含播放中的立即打断）
  useEffect(() => {
    mutedRef.current = options.initialMuted ?? false
    if (mutedRef.current) {
      queueRef.current = []
      try { audioRef.current?.pause() } catch { /* 已释放 */ }
      audioRef.current = null
      setMuted(true)
    }
  }, [options.initialMuted])

  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return
    drainingRef.current = true
    try {
      while (queueRef.current.length > 0) {
        if (mutedRef.current) { queueRef.current = []; break }
        const job = queueRef.current.shift() as RtSpeechJob
        try {
          const provider = /uranus|bigtts|zh_(fe)?male/i.test(job.voice) ? 'doubao' : undefined
          const res = await apiPost<{ audioBase64?: string; audioFormat?: string }>('/api/voice/tts', {
            text: job.text, voice: job.voice, provider, speed: 1.0,
          })
          const b64 = res && res.data && res.data.audioBase64
          if (!mutedRef.current && b64) {
            await new Promise<void>((resolve) => {
              const fmt = (res.data && res.data.audioFormat) || 'mp3'
              const audio = new Audio(`data:audio/${fmt};base64,${b64}`)
              audioRef.current = audio
              audio.onended = () => resolve()
              audio.onerror = () => resolve()
              audio.play().catch(() => resolve())
            })
          }
        } catch { /* 语音合成失败→降级纯文字，不阻塞会议 */ }
        audioRef.current = null
      }
    } finally {
      drainingRef.current = false
    }
  }, [])

  const enqueueSpeech = useCallback((meetingId: string, s: RtStatement) => {
    if (mutedRef.current || !s.voice || !s.text || s.failed) return
    queueRef.current.push({ key: `${meetingId}:${s.seq}`, text: s.text, voice: s.voice })
    void drainQueue()
  }, [drainQueue])

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current
    mutedRef.current = next
    setMuted(next)
    if (next) stopPlayback()
  }, [stopPlayback])

  const intervene = useCallback(async (meetingId: string, text: string): Promise<boolean> => {
    try {
      const res = await apiPost<{ ok?: boolean }>(`/api/experts/roundtable/${meetingId}/intervene`, { text })
      return Boolean(res && res.success)
    } catch {
      return false
    }
  }, [])

  /**
   * 中止本场圆桌会（2026-09-23）。
   *
   * 语义：不删已产生的发言，只让后面的专家不再开口——正在发言的那位会把话说完
   * （单条 LLM 调用不可中断）。所以按钮文案是"中止"而非"立即停止"，且发出请求后
   * 转"中止中…"直到 roundtable:ended 到达，不假装已经停了。
   */
  const cancel = useCallback(async (): Promise<boolean> => {
    const id = meetingIdRef.current
    if (!id) return false
    setCancelling(true)
    try {
      const res = await apiPost<{ ok?: boolean }>(`/api/experts/roundtable/${id}/cancel`, {})
      if (!(res && res.success)) {
        setCancelling(false)   // 未被受理（已结束/不存在）→ 恢复按钮，允许再试
        return false
      }
      return true
    } catch (e) {
      console.warn('[Roundtable] 中止请求失败:', e)
      setCancelling(false)
      return false
    }
  }, [])

  useSse({
    path: '/events',
    handlers: useMemo(() => ({
      'roundtable:started': (d: any) => {
        if (!d || !d.meetingId) return
        hostRef.current = d.host || null
        membersRef.current = Array.isArray(d.members) ? d.members : []
        setRunning(true)
        setGoal(d.goal || '')
        setTyping(null)
        // 2026-09-22: 到场名单与计数重置（新一场会从头算）
        setRoster(membersRef.current)
        spokenRef.current = new Set()
        setSpokenCount(0)
        setPhase('')
        // 2026-09-23: 记录会议 id（中止要用）并复位中止态
        meetingIdRef.current = d.meetingId
        setMeetingId(d.meetingId)
        setCancelling(false)
      },
      // 2026-09-22 体验层: 阶段推进（round1 → round2 → synthesis → document → done）
      'roundtable:phase': (d: any) => {
        if (!d?.meetingId) return
        setPhase(d.phase || '')
      },
      'roundtable:typing': (d: any) => {
        if (!d?.meetingId) return
        const member = membersRef.current.find((m) => m.id === d.expertId)
        setTyping({ name: d.expertName || '', dept: member?.department })
      },
      'roundtable:statement': (d: any) => {
        if (!d?.meetingId || !d.statement) return
        setTyping(null)
        const st = d.statement as RtStatement
        // 2026-09-22: 已发言专家去重计数（同一专家两轮发言只算一位到场）
        if (st.expertId) {
          spokenRef.current.add(st.expertId)
          setSpokenCount(spokenRef.current.size)
        }
        // 第3轮=主持收口：对话流由 roundtable:conclusion 统一落"✅ 会议收口"消息，
        // 这里不再以普通发言气泡重复（2026-09-20 检查纪要文档发现的重复问题同源）；语音照播
        if ((st.round ?? 0) < 3) cbRef.current.onStatement?.(st)
        enqueueSpeech(d.meetingId, st)
      },
      'roundtable:intervention': (d: any) => {
        if (d?.meetingId && d.intervention) cbRef.current.onIntervention?.(d.intervention as RtIntervention)
      },
      'roundtable:brief': (d: any) => {
        if (d?.meetingId && d.text) cbRef.current.onBrief?.(d.text as string)
      },
      'roundtable:conclusion': (d: any) => {
        if (d?.meetingId && d.conclusion) cbRef.current.onConclusion?.(d.conclusion as RtConclusion, hostRef.current)
      },
      'roundtable:document': (d: any) => {
        if (d?.meetingId && d.document) cbRef.current.onDocument?.(d.document as RtDocument)
      },
      'roundtable:ended': (d: any) => {
        if (!d?.meetingId) return
        setRunning(false)
        setTyping(null)
        setPhase('done')
        setCancelling(false)
        cbRef.current.onEnded?.(d.status || 'done', d.error ?? null)
      },
      'roundtable:error': (d: any) => {
        if (!d?.meetingId) return
        setRunning(false)
        setTyping(null)
        setPhase('done')
        setCancelling(false)
        cbRef.current.onEnded?.('error', d.message ?? null)
      },
    }), [enqueueSpeech]),
  })

  return {
    running, goal, typing, muted, toggleMuted, intervene,
    phase, roster, spokenCount,
    // 2026-09-23 中止能力
    meetingId, cancel, cancelling,
  }
}
