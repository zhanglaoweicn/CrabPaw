/**
 * MeetingPanel — 会议记录面板（2026-08-18）
 *
 * 面对面谈话记录场景：说「开始记录」→ 自动弹出纪要卡片并开始录音 →
 * 实时转写显示在卡片内（只进卡片，不进 AI 对话流）→ 说「结束记录」或
 * 点按钮 → 自动总结生成纪要（摘要+核心要点）→ 卡片内可查看历史纪要。
 *
 * 架构：FileGenPanel 宿主骨架（useSceneClient('meeting-panel') + dismissed +
 * useSse + registerCommandHost('meetingPanel') + 可见性广播 + close 三件套）
 * + 视频卡片布局（2026-08-19 重做：MediaStage 同构——左侧贴边滑入大卡，
 * 顶部标题栏 + 内容区 + 底部操作行三段式；宽度 min(56vw, 860px)，非浮动小卡）。
 * 存储走后端持久化（POST/GET /api/meetings 系列，data/.crabpaw/meetings）。
 * 视图状态机 idle | recording | summarizing | detail | list。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSse } from '../../hooks/useSSE'
import { useSceneClient } from '../../lib/scene-client'
import { SideSheet } from '../SideSheet'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { apiGet, apiPost, apiDelete } from '../../lib/api'
import { useMeetingTranscription, type TranscriptSegment } from '../../hooks/useMeetingTranscription'
import { useMeetingInsights } from '../../hooks/useMeetingInsights'
import { detectMeetingCommand } from '../../lib/voice-panel-commands'
import { loadWakeWords, invalidateWakeWords } from '../../lib/wake-words'
import './styles.css'

export interface MeetingSegment {
  text: string
  time: number
}

export interface MeetingDetail {
  id: string
  title: string
  date: string
  duration: number
  segments: MeetingSegment[]
  status: string
  summary?: string
  keyPoints?: string[]
  bookmarks?: { time: number; at: number }[]
}

export interface MeetingListItem {
  id: string
  title: string
  date: string
  duration: number
  segmentCount: number
  hasSummary: boolean
  status: string
  summary?: string
  keyPoints?: string[]
}

type View = 'idle' | 'recording' | 'summarizing' | 'detail' | 'list'

const VIEW_LABEL: Record<View, string> = {
  idle: '会议录音',
  recording: '会议录制中',
  summarizing: '正在生成纪要',
  detail: '会议纪要',
  list: '历史纪要',
}

/** mm:ss 录制计时（旧 MeetingCard 同款） */
function fmt(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

/** 时长展示：0 秒 → '—'，<1 分 → 'N秒'，否则 'X分Y秒' */
function formatDuration(s: number): string {
  if (!s || s <= 0) return '—'
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m <= 0) return `${sec}秒`
  return `${m}分${sec}秒`
}

/** 日期展示：MM-DD HH:mm */
function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MeetingPanel() {
  const surface = useSceneClient('meeting-panel')
  const [dismissed, setDismissed] = useState(false)
  const dismissedRef = useRef(false)
  dismissedRef.current = dismissed
  const [voiceVisible, setVoiceVisible] = useState(false)
  const [view, setView] = useState<View>('idle')
  // 当前会议（detail/list 共享）
  const [meetingId, setMeetingId] = useState<string | null>(null)
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [history, setHistory] = useState<MeetingListItem[]>([])
  const [error, setError] = useState<string | null>(null)
  // 实时转写（seg-id 替换去重，旧 MeetingCard 逻辑）
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([])
  const [elapsed, setElapsed] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const detailScrollRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 录制态 ref（SSE handler/命令宿主读最新值，避免闭包过期）
  const recordingRef = useRef(false)
  const meetingIdRef = useRef<string | null>(null)
  meetingIdRef.current = meetingId
  // 2026-09-01(D4): 落库数据源改为全量镜像——按 seg id upsert, 不分 final/partial。
  // 旧 allSegmentsRef 仅收 final 段, 而火山尾段永不 final → 尾段内容永不落库。
  const transcriptsMirrorRef = useRef<Map<string, TranscriptSegment>>(new Map())
  // 指令检测防抖: per-seg 文本最后变化时刻（首帧 stableMs=0, 保守不触发裸词通道）
  const lastTextAtRef = useRef<Map<string, number>>(new Map())
  // 唤醒词（config agent.name/wakeWord + 内置兜底, config-updated 失效重载）
  const wakeWordsRef = useRef<string[]>([])
  // P2a: 书签打点（key=seg.id 防同段重推重复打点; time=录制秒）
  const bookmarksRef = useRef<Map<string, { time: number; at: number }>>(new Map())
  const elapsedRef = useRef(0)
  // P2b: 实时智能层——final 段计数 + notify 桥。onTranscript([] deps) 的 WS 回调链
  // (ws.onmessage→emitTranscript→onTranscript) 冻结在开录渲染帧——彼时 meetingId
  // 尚未 set、transcribeState 尚非 recording, 直接引用 insightsNotify 会闭包过期
  // (meetingId=null/enabled=false → 提取永不触发)。经 ref 调最新值, finalizeRef 同款桥。
  const finalsCountRef = useRef(0)
  const insightsNotifyRef = useRef<(finalsCount: number) => void>(() => {})
  // 2026-08-25: 转录指令回路桥——finalizeRecording 定义于 onTranscript 之后,
  // 回调内经 ref 调用(useCallback 不能引用后置 const)
  const finalizeRef = useRef<null | ((opts: { summarize: boolean }) => Promise<void>)>(null)
  const viewRef = useRef<View>('idle')
  viewRef.current = view

  const onTranscript = useCallback((seg: TranscriptSegment) => {
    // 全量镜像 upsert（每帧, 不分 final/partial——finalize 落库数据源）。
    // 停止后到达的迟到帧（如 hookStop flush 的火山尾段重推）不回灌镜像——
    // 防止已被剔除的停止指令子串经 flush 帧重新混入落库 payload。
    if (recordingRef.current) transcriptsMirrorRef.current.set(seg.id, seg)
    // P2b: final 段计数变化 → 通知节流提取（经 ref 桥取最新 notify, 见声明处注释）
    if (seg.isFinal && recordingRef.current) insightsNotifyRef.current(++finalsCountRef.current)
    const lastAt = lastTextAtRef.current.get(seg.id)
    const stableMs = lastAt ? Date.now() - lastAt : 0
    lastTextAtRef.current.set(seg.id, Date.now())

    // 2026-09-01(D1/D2): 每帧检测（含 partial）——火山尾段永不 final, 等待即永漏。
    // 唤醒词通道即时命中; 裸词通道需 final 或 800ms 稳定。
    const hit = detectMeetingCommand(seg.text, {
      final: seg.isFinal,
      stableMs,
      wakeWords: wakeWordsRef.current,
    })
    if (hit && hit.command === 'stop') {
      console.log(`[meeting-panel] 转录命中停止指令: "${hit.matched}"`)
      // D3: 只剔除指令子串, 保留段内真实内容（旧实现按 id 删整段会丢内容）
      const applyCleaned = (cleaned: string) => {
        if (cleaned) {
          const cleanedSeg = { ...seg, text: cleaned }
          transcriptsMirrorRef.current.set(seg.id, cleanedSeg)
          setTranscripts(prev => {
            const next = prev.filter(s => s.id !== seg.id)
            return [...next, cleanedSeg].sort((a, b) => a.audioStartTime - b.audioStartTime)
          })
        } else {
          transcriptsMirrorRef.current.delete(seg.id)
          setTranscripts(prev => prev.filter(s => s.id !== seg.id))
        }
      }
      applyCleaned(hit.cleanedText)
      void finalizeRef.current?.({ summarize: true })
      return
    }
    if (hit && hit.command === 'bookmark') {
      console.log(`[meeting-panel] 转录命中书签指令: "${hit.matched}"`)
      // 剔除指令子串（与 stop 同款, 但不停止录制）
      if (hit.cleanedText) {
        const cleanedSeg = { ...seg, text: hit.cleanedText }
        transcriptsMirrorRef.current.set(seg.id, cleanedSeg)
        setTranscripts(prev => {
          const next = prev.filter(s => s.id !== seg.id)
          return [...next, cleanedSeg].sort((a, b) => a.audioStartTime - b.audioStartTime)
        })
      } else {
        transcriptsMirrorRef.current.delete(seg.id)
        setTranscripts(prev => prev.filter(s => s.id !== seg.id))
      }
      // 去重打点（同段重推同指令只记一次）+ TTS 轻提示
      if (!bookmarksRef.current.has(seg.id)) {
        bookmarksRef.current.set(seg.id, { time: elapsedRef.current, at: Date.now() })
        try {
          window.dispatchEvent(new CustomEvent('crabpaw:speak', { detail: { id: `meeting_bookmark_${seg.id}`, text: '已标记重点' } }))
        } catch (e) { console.warn('[meeting-panel] 书签播报请求失败:', e) }
      }
      return
    }

    setTranscripts(prev => {
      const next = prev.filter(s => s.id !== seg.id)
      return [...next, seg].sort((a, b) => a.audioStartTime - b.audioStartTime)
    })
  }, [])

  const onError = useCallback((err: string) => {
    console.warn('[meeting-panel] 转录错误:', err)
    setError(err)
    // 录制启动失败（如麦克风权限）→ 回空态，会议仍保留（无转写内容）
    if (recordingRef.current) {
      recordingRef.current = false
      setView('idle')
    }
  }, [])

  const { state: transcribeState, startRecording: hookStart, stopRecording: hookStop, cleanup: hookCleanup } = useMeetingTranscription({
    onTranscript,
    onError,
  })

  // P2b: 实时智能层——final 段计数变化时通知节流提取
  const getTranscript = useCallback(() => Array.from(transcriptsMirrorRef.current.values())
    .sort((a, b) => a.audioStartTime - b.audioStartTime).map(s => s.text).join('\n'), [])
  const { insights, status, notify: insightsNotify } = useMeetingInsights({ meetingId, getTranscript, enabled: transcribeState === 'recording' })
  insightsNotifyRef.current = insightsNotify

  const visible = (voiceVisible || !!surface) && !dismissed

  // 组合布局联动（同 FileGenPanel/MediaStageHost 模式）
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'meeting' } }))
    } catch (e) { console.warn('[meeting-panel] 广播可见性事件失败:', e) }
  }, [visible])

  /** 开录：SSE 事件带 meetingId（后端已建会）→ 直接用；否则先 POST 建会 */
  const startRecording = useCallback(async (idFromSse?: string) => {
    if (recordingRef.current) return // 幂等：已录制中
    try {
      // 本地语音命令路径不经 surface/SSE —— 开录即弹卡（dismissed 复位）
      setDismissed(false)
      setVoiceVisible(true)
      let id = idFromSse
      if (!id) {
        const res = await apiPost<{ id: string }>('/api/meetings', {})
        if (!res.success || !res.data) throw new Error(res.error || '创建会议失败')
        id = res.data.id
      }
      meetingIdRef.current = id
      setMeetingId(id)
      setError(null)
      setTranscripts([])
      transcriptsMirrorRef.current.clear()
      lastTextAtRef.current.clear()
      bookmarksRef.current.clear()
      setElapsed(0)
      finalsCountRef.current = 0
      setView('recording')
      recordingRef.current = true
      await hookStart()
    } catch (e: any) {
      console.error('[meeting-panel] 开始录制失败:', e?.message || e)
      setError(e?.message || '开始录制失败')
      recordingRef.current = false
      setView('idle')
    }
  }, [hookStart])

  /**
   * 结束录制。summarize=true → flush 落库后调后端总结（「结束记录」路径）；
   * summarize=false → 仅落库保存（录音中关闭面板路径，不打扰用户）。
   */
  const finalizeRecording = useCallback(async (opts: { summarize: boolean }) => {
    if (!recordingRef.current) return
    recordingRef.current = false
    const id = meetingIdRef.current
    let dur = 0
    try {
      dur = await hookStop()
    } catch (e: any) {
      console.error('[meeting-panel] 停止录制失败:', e?.message || e)
    }
    const finalSegments = Array.from(transcriptsMirrorRef.current.values())
      .filter(s => s.text.trim())
      .sort((a, b) => a.audioStartTime - b.audioStartTime)
    const segs = finalSegments.map(s => ({ text: s.text, time: Math.floor(s.audioStartTime / 1000) }))
    if (id && segs.length > 0) {
      try {
        await apiPost(`/api/meetings/${id}/segments`, {
          segments: segs,
          duration: dur,
          bookmarks: Array.from(bookmarksRef.current.values()),
        })
      } catch (e: any) {
        console.error('[meeting-panel] 转写落库失败:', e?.message || e)
      }
    }
    if (!opts.summarize || !id) return
    setView('summarizing')
    setError(null)
    try {
      const res = await apiPost<{ id: string; summary: string; keyPoints: string[] }>(`/api/meetings/${id}/summarize`, {})
      const d = res.data
      if (res.success && d) {
        setMeeting(prev => ({
          ...(prev || { id, title: '', date: '', duration: 0, segments: [], status: 'done' }),
          id: d.id,
          summary: d.summary,
          keyPoints: d.keyPoints || [],
          status: 'done',
        }))
        setView('detail')
        try {
          window.dispatchEvent(new CustomEvent('crabpaw:speak', {
            detail: { id: `meeting_done_${id}`, text: '会议纪要已生成' },
          }))
        } catch (e) { console.warn('[meeting-panel] 播报请求失败:', e) }
      } else {
        setError(res.error || '总结失败')
        setView('detail')
      }
    } catch (e: any) {
      console.error('[meeting-panel] 总结请求失败:', e?.message || e)
      setError('总结请求失败，请重试')
      setView('detail')
    }
  }, [hookStop])
  // 指令回路桥赋值(引用最新 finalize; 顺序在 onTranscript 使用之后定义, 经 ref 同步)
  finalizeRef.current = finalizeRecording

  /** 重试总结（detail 错误态按钮） */
  const retrySummarize = useCallback(async () => {
    const id = meetingIdRef.current
    if (!id) return
    setView('summarizing')
    setError(null)
    try {
      const res = await apiPost<{ id: string; summary: string; keyPoints: string[] }>(`/api/meetings/${id}/summarize`, {})
      const d = res.data
      if (res.success && d) {
        setMeeting(prev => ({ ...(prev || { id, title: '', date: '', duration: 0, segments: [], status: 'done' }), summary: d.summary, keyPoints: d.keyPoints || [], status: 'done' }))
        setView('detail')
      } else {
        setError(res.error || '总结失败')
        setView('detail')
      }
    } catch (e: any) {
      console.error('[meeting-panel] 总结重试失败:', e?.message || e)
      setError('总结请求失败，请重试')
      setView('detail')
    }
  }, [])

  /** 历史列表（语音「打开会议面板」命令入口——同时复位面板显示） */
  const openHistory = useCallback(async () => {
    setDismissed(false)
    setVoiceVisible(true)
    setView('list')
    setError(null)
    try {
      const res = await apiGet<MeetingListItem[]>('/api/meetings')
      const list = res.data
      if (res.success && Array.isArray(list)) setHistory(list)
      else setError(res.error || '历史列表加载失败')
    } catch (e: any) {
      console.error('[meeting-panel] 历史加载失败:', e?.message || e)
      setError('历史列表加载失败')
    }
  }, [])

  /** 历史详情 */
  const openDetail = useCallback(async (id: string) => {
    setError(null)
    try {
      const res = await apiGet<MeetingDetail>(`/api/meetings/${id}`)
      const d = res.data
      if (res.success && d) {
        setMeeting(d)
        setMeetingId(id)
        setView('detail')
      } else {
        setError(res.error || '会议详情加载失败')
      }
    } catch (e: any) {
      console.error('[meeting-panel] 详情加载失败:', e?.message || e)
      setError('会议详情加载失败')
    }
  }, [])

  /** 删除历史会议 */
  const handleDelete = useCallback(async (id: string) => {
    try {
      const res = await apiDelete(`/api/meetings/${id}`)
      if (res.success) setHistory(prev => prev.filter(m => m.id !== id))
      else setError(res.error || '删除失败')
    } catch (e: any) {
      console.error('[meeting-panel] 删除失败:', e?.message || e)
      setError('删除失败')
    }
  }, [])

  /** close 三件套：dismissed + 移除 surface + panel-state closed（同 FileGenPanel） */
  const handleClose = useCallback(() => {
    setDismissed(true)
    setVoiceVisible(false)
    // 录音中关闭 → 自动停止并保存转写（不自动总结；总结由「结束记录」显式触发）
    if (recordingRef.current) void finalizeRecording({ summarize: false })
    try {
      apiPost('/api/scene/remove', { id: 'meeting-panel' }).catch((e: any) => console.warn('[meeting-panel] 场景移除失败:', e?.message))
      apiPost('/api/scene/panel-state', { panel: 'meeting', state: 'closed' }).catch((e: any) => console.warn('[meeting-panel] 面板状态写入失败:', e?.message))
    } catch (e) { console.error('[meeting-panel] 关闭链路异常:', e) }
  }, [finalizeRecording])

  // 唤醒词加载 + 配置更新失效重载（spec §3.2）
  useEffect(() => {
    let alive = true
    const refresh = () => {
      invalidateWakeWords()
      loadWakeWords().then(w => { if (alive) wakeWordsRef.current = w })
    }
    refresh()
    window.addEventListener('config-updated', refresh)
    return () => {
      alive = false
      window.removeEventListener('config-updated', refresh)
    }
  }, [])

  // SSE 驱动（meeting:start → 开录；meeting:stop → 停止流程；meeting:summary → 展示摘要）
  useSse({
    path: '/events',
    handlers: {
      'meeting:start': (d: any) => {
        if (!d?.meetingId) return
        // 用户说「开始记录」（LLM 路径）→ 后端已建会并广播 → 复活面板直接开录
        setDismissed(false)
        void startRecording(d.meetingId)
      },
      'meeting:stop': (d: any) => {
        if (d?.meetingId && recordingRef.current) {
          void finalizeRecording({ summarize: true })
        }
      },
      'meeting:summary': (d: any) => {
        if (!d?.meetingId) return
        // 总结完成是结果呈现 → 复活面板直接展示（与 FileGenPanel done 语义一致；
        // 用户正看历史列表时不打断）
        // 2026-08-19: SSE 是总结完成的权威信号——HTTP 路径若超时失败(错误条已设),
        // 此处必须清掉,否则"纪要已成功 + 错误条残留"并存(实测主进程 10s 超时触发)。
        setError(null)
        setDismissed(false)
        setMeeting(prev => ({
          ...(prev || { id: d.meetingId, title: '', date: '', duration: 0, segments: [], status: 'done' }),
          id: d.meetingId,
          summary: d.summary || '',
          keyPoints: d.keyPoints || [],
          status: 'done',
        }))
        if (viewRef.current !== 'list') setView('detail')
      },
      'meeting:history': () => {
        // LLM 路径「查看历史」→ 打开历史列表（不新建会议, R1）
        void openHistory()
      },
      'meeting:error': (d: any) => {
        setError(d?.message || '总结失败')
        if (viewRef.current === 'summarizing') setView('detail')
      },
    },
  })

  // 语音/全局接口（恒注册）
  useEffect(() => {
    return registerCommandHost('meetingPanel', {
      startRecording: () => void startRecording(),
      stopRecording: () => void finalizeRecording({ summarize: true }),
      openHistory: () => void openHistory(),
      close: handleClose,
      isRecording: () => recordingRef.current || transcribeState === 'recording',
      isOpen: () => visible,
      // S3.3: 日程卡开录——带日程上下文建会（POST {scheduleId,title}）后开录
      startRecordingForSchedule: (scheduleId: string, title?: string) => {
        void (async () => {
          try {
            setDismissed(false)
            setVoiceVisible(true)
            const res = await apiPost<{ id: string }>('/api/meetings', { scheduleId, title: title || undefined })
            if (!res.success || !res.data) throw new Error(res.error || '创建会议失败')
            await startRecording(res.data.id)
          } catch (e: any) {
            console.error('[meeting-panel] 日程开录失败:', e?.message || e)
            setError(e?.message || '开始录制失败')
          }
        })()
      },
      // S3.3: 日程卡纪要 chip 直达详情
      openMeetingDetail: (meetingId: string) => {
        setDismissed(false)
        setVoiceVisible(true)
        void openDetail(meetingId)
      },
    })
  }, [startRecording, finalizeRecording, openHistory, handleClose, visible, transcribeState, openDetail])

  // 卸载清理
  useEffect(() => {
    return () => { hookCleanup() }
  }, [hookCleanup])

  // 录制计时
  useEffect(() => {
    if (transcribeState === 'recording' && !timerRef.current) {
      timerRef.current = setInterval(() => { setElapsed(t => { const n = t + 1; elapsedRef.current = n; return n }) }, 1000)
    }
    if (transcribeState !== 'recording' && timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [transcribeState])

  // 转写自动滚底
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [transcripts])

  // 录音中关闭（surface 移除/互斥顶掉）→ 保存但不总结
  useEffect(() => {
    if (!visible && recordingRef.current) void finalizeRecording({ summarize: false })
  }, [visible, finalizeRecording])

  return (
    <SideSheet
      open={visible}
      onClose={handleClose}
      name="meeting"
      // 2026-08-19 重做：视频卡片同款宽度 min(75vw, 1920px) + 左侧贴边滑入。
      // 高度不 fitContent——与右侧栏(对话窗口)同高同顶(header 底 76px 起,
      // 底部 16px),左右两块并排等高,见 styles.css .side-sheet--meeting 覆盖。
      width="min(75vw, 1920px)"
    >
      <div className="meeting-panel">
        {/* 标题栏（视频卡片同构：图标 + 标题 + 状态 + 关闭） */}
        <div className="meeting-header">
          <span className="meeting-title-icon">🎙️</span>
          <span className="meeting-title">{view === 'recording' ? '会议录制中' : meeting?.title || VIEW_LABEL[view]}</span>
          {view === 'recording' && <span className="meeting-dot meeting-dot--rec" />}
          <button
            type="button"
            className="meeting-close-btn"
            data-close-btn
            onClick={handleClose}
            aria-label="关闭会议面板"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="meeting-error">
            {error}
            {view === 'detail' && meetingId && (
              <button type="button" className="meeting-error-retry" onClick={() => void retrySummarize()}>
                重试总结
              </button>
            )}
          </div>
        )}

        {/* 内容区（flex-1 滚动，视频卡片同构） */}
        <div className="meeting-body">
          {/* 空态引导 */}
          {view === 'idle' && (
            <div className="meeting-empty">
              <div className="meeting-empty-icon">🗒️</div>
              <div className="meeting-empty-text">面对面谈话记录：开始后实时转写，结束后自动生成纪要</div>
              <div className="meeting-empty-actions">
                <button type="button" className="meeting-btn meeting-btn--primary" onClick={() => void startRecording()}>
                  ▶ 开始记录
                </button>
                <button type="button" className="meeting-btn" onClick={() => void openHistory()}>
                  📂 历史纪要
                </button>
              </div>
            </div>
          )}

          {/* 录制视图：实时转写滚动 + P2b 实时智能层两栏（左转写/右提取） */}
          {view === 'recording' && (
            <div className="meeting-live">
              <div ref={scrollRef} className="meeting-transcript">
                {transcripts.length === 0 ? (
                  <div className="meeting-transcript-empty">
                    {transcribeState === 'starting' ? '正在连接语音服务…' : '等待语音输入…'}
                  </div>
                ) : (() => {
                  // 书签角标: 预计算每个书签命中时段的 seg id（O(m·n) 一次, 避免 map 内每段重算）
                  const markedSegIds = new Set<string>()
                  for (const b of bookmarksRef.current.values()) {
                    const earlier = transcripts.filter(s => Math.floor(s.audioStartTime / 1000) <= b.time)
                    const last = earlier[earlier.length - 1]
                    if (last) markedSegIds.add(last.id)
                  }
                  return (
                    transcripts.map(seg => {
                      const segSec = Math.floor(seg.audioStartTime / 1000)
                      const marked = markedSegIds.has(seg.id)
                      return (
                        <div key={seg.id} data-seg-time={segSec} className={`meeting-seg${seg.isFinal ? '' : ' meeting-seg--partial'}`}>
                          {marked && <span className="meeting-seg-bookmark" title="重点时刻">🔖</span>}
                          {seg.text}
                        </div>
                      )
                    })
                  )
                })()}
              </div>
              <aside className="meeting-insights">
                <div className="meeting-insights-title">🧠 实时要点</div>
                {status === 'running' && <div className="meeting-insights-status">提取中…</div>}
                {insights.todos.length > 0 && (
                  <div className="meeting-insights-group">
                    <div className="meeting-insights-group-title">📌 待办</div>
                    <ul>{insights.todos.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  </div>
                )}
                {insights.decisions.length > 0 && (
                  <div className="meeting-insights-group">
                    <div className="meeting-insights-group-title">⚖️ 决策</div>
                    <ul>{insights.decisions.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  </div>
                )}
                {insights.points.length > 0 && (
                  <div className="meeting-insights-group">
                    <div className="meeting-insights-group-title">✨ 要点</div>
                    <ul>{insights.points.map((t, i) => <li key={i}>{t}</li>)}</ul>
                  </div>
                )}
                {status === 'idle' && !insights.todos.length && !insights.decisions.length && !insights.points.length && (
                  <div className="meeting-insights-status">边说边提取，稍候…</div>
                )}
              </aside>
            </div>
          )}

          {/* 总结中 */}
          {view === 'summarizing' && (
            <div className="meeting-summarizing">
              <span className="meeting-spinner" />
              <div className="meeting-summarizing-text">正在生成会议纪要…</div>
            </div>
          )}

          {/* 详情视图：摘要 + 要点 + 转写 */}
          {view === 'detail' && meeting && (
            <div className="meeting-detail">
              {/* 2026-09-01(R2): 空壳记录诚实空态——旧实现此场景 body 全空白 */}
              {!meeting.summary && meeting.segments.length === 0 && (
                <div className="meeting-empty">
                  <div className="meeting-empty-icon">🕳️</div>
                  <div className="meeting-empty-text">该记录未捕获到语音内容</div>
                  <div className="meeting-empty-sub">录制期间可能未拾音或面板过早关闭</div>
                  <div className="meeting-empty-actions">
                    <button
                      type="button"
                      className="meeting-btn"
                      onClick={() => { void handleDelete(meeting.id).then(() => void openHistory()) }}
                    >
                      删除这条记录
                    </button>
                    <button type="button" className="meeting-btn" onClick={() => void openHistory()}>
                      ← 返回历史
                    </button>
                  </div>
                </div>
              )}
              {/* 2026-08-19: 历史 error/无摘要会议打开 detail 无重试入口——
                  修复前 400 失败(转写为空)落 error 态,点开只有空摘要。有转写即可重试。 */}
              {!meeting.summary && meeting.segments.length > 0 && (
                <div className="meeting-error">
                  {meeting.status === 'error' ? '上次总结失败' : '该会议尚未生成纪要'}
                  <button type="button" className="meeting-error-retry" onClick={() => void retrySummarize()}>
                    重试总结
                  </button>
                </div>
              )}
              {meeting.summary && (
                <div className="meeting-block">
                  <div className="meeting-block-title">📋 会议摘要</div>
                  <div className="meeting-block-body">{meeting.summary}</div>
                </div>
              )}
              {meeting.keyPoints && meeting.keyPoints.length > 0 && (
                <div className="meeting-block">
                  <div className="meeting-block-title">🔑 核心要点</div>
                  <ul className="meeting-points">
                    {meeting.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </div>
              )}
              {meeting.bookmarks && meeting.bookmarks.length > 0 && (
                <div className="meeting-block">
                  <div className="meeting-block-title">🔖 重点时刻</div>
                  <div className="meeting-bookmarks">
                    {meeting.bookmarks.map((b, i) => (
                      <button
                        key={i}
                        type="button"
                        className="meeting-bookmark-chip"
                        onClick={() => {
                          const container = detailScrollRef.current
                          if (!container) return
                          const nodes = container.querySelectorAll<HTMLElement>('[data-seg-time]')
                          let target: HTMLElement | null = null
                          for (const n of nodes) { if (Number(n.dataset.segTime) <= b.time) target = n; else break }
                          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                      >
                        {fmt(b.time)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {meeting.segments.length > 0 && (
                <div className="meeting-block">
                  <div className="meeting-block-title">
                    📝 完整转写
                    <span className="meeting-block-meta">共 {meeting.segments.length} 段 · {formatDuration(meeting.duration)}</span>
                  </div>
                  <div className="meeting-transcript" ref={detailScrollRef}>
                    {meeting.segments.map((seg, i) => (
                      <div key={i} className="meeting-seg meeting-seg--done">
                        <span className="meeting-seg-time">{fmt(seg.time)}</span>
                        {seg.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 历史列表 */}
          {view === 'list' && (
            <div className="meeting-list">
              {history.length === 0 ? (
                <div className="meeting-empty-text">还没有会议记录，点「开始记录」录一场吧</div>
              ) : (
                history.map(m => (
                  <div key={m.id} className="meeting-list-item" onClick={() => void openDetail(m.id)}>
                    <div className="meeting-list-main">
                      <div className="meeting-list-title">
                        {m.title}
                        {m.status === 'recording' && <span className="meeting-list-badge">录制中</span>}
                        {m.status === 'summarizing' && <span className="meeting-list-badge meeting-list-badge--warn">总结中</span>}
                        {m.status === 'interrupted' && <span className="meeting-list-badge meeting-list-badge--muted">已中断</span>}
                      </div>
                      <div className="meeting-list-meta">
                        {formatDate(m.date)} · {m.segmentCount} 段 · {formatDuration(m.duration)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="meeting-list-delete"
                      aria-label={`删除 ${m.title}`}
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); void handleDelete(m.id) }}
                    >
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 底部操作行（视频卡片同构：分隔线 + 操作/控制） */}
        {(view === 'recording' || view === 'detail' || view === 'list') && (
          <div className="meeting-footer">
            {view === 'recording' && (
              <>
                <span className="meeting-timer">{fmt(elapsed)}</span>
                <button
                  type="button"
                  className="meeting-btn meeting-btn--stop"
                  disabled={transcribeState === 'starting' || transcribeState === 'stopping'}
                  onClick={() => void finalizeRecording({ summarize: true })}
                  title="停止记录并生成纪要"
                >
                  {transcribeState === 'stopping' ? '停止中…' : '■ 结束记录'}
                </button>
              </>
            )}
            {view === 'detail' && (
              <>
                <button type="button" className="meeting-btn" onClick={() => void openHistory()}>📂 历史纪要</button>
                <button type="button" className="meeting-btn meeting-btn--primary" onClick={() => void startRecording()}>▶ 再记一场</button>
              </>
            )}
            {view === 'list' && (
              <button type="button" className="meeting-btn" onClick={() => { setView('idle'); setMeetingId(null); }}>← 返回</button>
            )}
          </div>
        )}
      </div>
    </SideSheet>
  )
}

export default MeetingPanel
