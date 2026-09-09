import { useCallback, useEffect, useRef, useState } from 'react'
import { apiPost } from '../lib/api'

export interface MeetingInsights { todos: string[]; decisions: string[]; points: string[] }

const MIN_FINALS_DELTA = 8      // 新增 final 段阈值
const MIN_INTERVAL_MS = 30_000  // 最小提取间隔

/**
 * useMeetingInsights — 实时智能层（P2b, spec §5.2）。
 * 节流: finals 增量 ≥8 或（有新增且距上次 ≥30s）; in-flight 守卫;
 * 失败静默降级（保持上次快照, 不弹错误条——会议录制不被打扰）。
 */
export function useMeetingInsights(opts: {
  meetingId: string | null
  getTranscript: () => string
  enabled: boolean
}) {
  const { meetingId, getTranscript, enabled } = opts
  const [insights, setInsights] = useState<MeetingInsights>({ todos: [], decisions: [], points: [] })
  const [status, setStatus] = useState<'idle' | 'running'>('idle')
  const inFlightRef = useRef(false)
  const lastRunAtRef = useRef(0)
  const lastFinalsRef = useRef(0)

  // meetingId 变化（新会议开录/停止）→ 快照与节流计数全量重置, 防上一场提取结果残留
  useEffect(() => {
    setInsights({ todos: [], decisions: [], points: [] })
    lastFinalsRef.current = 0
    lastRunAtRef.current = 0
  }, [meetingId])

  const run = useCallback(async () => {
    if (!meetingId || inFlightRef.current) return
    inFlightRef.current = true
    setStatus('running')
    try {
      const res = await apiPost<MeetingInsights>(`/api/meetings/${meetingId}/insights`, { transcript: getTranscript().slice(-8000) })
      if (res.success && res.data) setInsights({ todos: res.data.todos || [], decisions: res.data.decisions || [], points: res.data.points || [] })
    } catch (e: any) {
      console.warn('[meeting-insights] 提取失败(静默保持上次快照):', e?.message || e)
    } finally {
      inFlightRef.current = false
      setStatus('idle')
      lastRunAtRef.current = Date.now()
    }
  }, [meetingId, getTranscript])

  /** 每当 final 段计数变化时由 MeetingPanel 调用 */
  const notify = useCallback((finalsCount: number) => {
    if (!enabled || inFlightRef.current) return
    const delta = finalsCount - lastFinalsRef.current
    if (delta <= 0) return
    const now = Date.now()
    if (delta >= MIN_FINALS_DELTA || now - lastRunAtRef.current >= MIN_INTERVAL_MS) {
      lastFinalsRef.current = finalsCount
      void run()
    }
  }, [enabled, run])

  return { insights, status, notify }
}
