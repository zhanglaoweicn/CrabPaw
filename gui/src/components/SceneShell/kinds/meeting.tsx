/**
 * MeetingRecordingCard — 会议录音/纪要卡片
 *
 * Agent 通过 SceneSet(id, { kind: 'meeting_recording', data: { title, status, duration, speakers[], transcript[] } }) 控制。
 */

import { useState, useMemo } from 'react'
import { Mic, Clock, Users, FileText } from 'lucide-react'

export interface MeetingSpeaker {
  name: string
  time?: string
  text: string
}

export interface MeetingRecordingData {
  title: string
  status: 'recording' | 'transcribing' | 'summarizing' | 'done'
  duration?: number         // 秒
  speakerCount?: number
  speakers?: MeetingSpeaker[]
  summary?: string
  keywords?: string[]
}

export function MeetingRecordingCard({ data }: { data: MeetingRecordingData }) {
  const [expanded, setExpanded] = useState(false)

  const statusInfo = useMemo(() => {
    switch (data.status) {
      case 'recording': return { label: '录制中', color: '#ef4444', pulse: true }
      case 'transcribing': return { label: '转写中', color: '#f59e0b', pulse: true }
      case 'summarizing': return { label: '摘要生成中', color: '#8b5cf6', pulse: true }
      case 'done': return { label: '已完成', color: '#22c55e', pulse: false }
      default: return { label: data.status || '等待中', color: '#94a3b8', pulse: false }
    }
  }, [data.status])

  const formatTime = (sec?: number) => {
    if (!sec || sec < 0) return '00:00'
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  return (
    <div
      onClick={() => data.status === 'done' && setExpanded(e => !e)}
      style={{
        padding: '12px 14px',
        borderRadius: '14px',
        background: 'rgba(24,24,42,0.92)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(99,102,241,0.2)',
        borderLeft: `3px solid ${statusInfo.color}`,
        minWidth: 200,
        cursor: data.status === 'done' ? 'pointer' : 'default',
        transition: 'all 0.4s cubic-bezier(0.22,0.61,0.36,1)',
      }}
    >
      {/* Status + Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ position: 'relative' }}>
          <Mic size={14} style={{ color: statusInfo.color }} />
          {statusInfo.pulse && (
            <div style={{
              position: 'absolute', top: -2, right: -2,
              width: 6, height: 6, borderRadius: '50%',
              background: statusInfo.color,
              animation: 'pulse 1.5s ease-in-out infinite',
            }} />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>
            {data.title}
          </div>
        </div>
        <span style={{
          fontSize: 8, padding: '1px 6px', borderRadius: 4,
          background: `${statusInfo.color}22`, color: statusInfo.color,
          fontWeight: 600,
        }}>
          {statusInfo.label}
        </span>
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 12, fontSize: 9 }}>
        {data.duration !== undefined && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#94a3b8' }}>
            <Clock size={10} /> {formatTime(data.duration)}
          </span>
        )}
        {data.speakerCount !== undefined && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#94a3b8' }}>
            <Users size={10} /> {data.speakerCount} 人
          </span>
        )}
      </div>

      {/* Summary (when done + expanded) */}
      {expanded && data.status === 'done' && (
        <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
          {data.summary && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                <FileText size={10} style={{ color: '#818cf8' }} />
                <span style={{ fontSize: 14, color: '#818cf8', fontWeight: 600 }}>会议摘要</span>
              </div>
              <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.5 }}>
                {data.summary}
              </div>
            </div>
          )}

          {data.keywords && data.keywords.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {data.keywords.map((kw, i) => (
                <span key={i} style={{
                  fontSize: 8, padding: '1px 6px',
                  borderRadius: 4, background: '#6366f122', color: '#a5b4fc',
                }}>
                  {kw}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
