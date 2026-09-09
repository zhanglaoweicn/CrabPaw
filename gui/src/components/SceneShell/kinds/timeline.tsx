/**
 * TimelineCard — 时间线卡片 / 日历锁格（场景九日程 kinds 专门化）
 */

import { Clock, Lock } from 'lucide-react'

/* ── 模块级 keyframes 注入（一次，安全兼容 SSR/jsdom） ── */
if (typeof document !== 'undefined') {
  const styleId = 'timeline-kind-keyframes'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      @keyframes scene-lock-glow {
        0%, 100% {
          box-shadow:
            0 0 0 1px rgba(59, 130, 246, 0.25),
            0 0 6px rgba(59, 130, 246, 0.08);
          border-color: rgba(59, 130, 246, 0.25);
        }
        50% {
          box-shadow:
            0 0 0 2px rgba(59, 130, 246, 0.55),
            0 0 16px rgba(59, 130, 246, 0.28);
          border-color: rgba(59, 130, 246, 0.65);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .tl-slot--locked {
          animation: none !important;
        }
      }
    `
    document.head.appendChild(style)
  }
}

export interface TimelineEvent {
  timestamp: number
  title: string
  description?: string
  icon?: string
  color?: string
}

/** 日历锁格——单个时间段 */
export interface TimelineSlot {
  time: string
  title: string
  locked?: boolean
}

export interface TimelineData {
  title?: string
  events: TimelineEvent[]
  /** 日历锁格模式——日期（如 "2026-08-04"） */
  date?: string
  /** 日历锁格模式——时间段列表；存在时切换为日历网格渲染 */
  slots?: TimelineSlot[]
  /** 当前焦点时间（如 "14:00"），匹配格高亮 */
  focusTime?: string
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function TimelineCard({ data }: { data: TimelineData }) {
  /* ── 日历锁格模式：date + slots 均存在时走日历网格渲染 ── */
  if (data.date && data.slots && data.slots.length > 0) {
    return (
      <div style={{
        padding: '10px 14px',
        borderRadius: '12px',
        background: 'rgba(24,24,36,0.88)',
        backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.06)',
        minWidth: 200,
        maxWidth: 320,
      }}>
        {/* 日期标题 */}
        <div style={{
          fontSize: 15,
          fontWeight: 700,
          color: '#818cf8',
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <Clock size={12} style={{ display: 'inline' }} />
          {data.date}
          {data.title && (
            <span style={{ fontSize: 10, fontWeight: 400, color: '#94a3b8', marginLeft: 4 }}>
              {data.title}
            </span>
          )}
        </div>

        {/* 时间段网格 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.slots.map((slot, i) => {
            const isLocked = slot.locked === true
            const isFocus = data.focusTime && slot.time === data.focusTime
            return (
              <div
                key={i}
                className={isLocked ? 'tl-slot--locked' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 8,
                  border: `1px solid ${
                    isFocus ? 'rgba(99, 102, 241, 0.45)' : 'rgba(255,255,255,0.05)'
                  }`,
                  background: isFocus
                    ? 'rgba(99, 102, 241, 0.12)'
                    : 'rgba(255,255,255,0.02)',
                  transition: 'box-shadow 0.3s ease, border-color 0.3s ease',
                  /* 锁定格蓝色光圈动画 */
                  ...(isLocked && {
                    animation: 'scene-lock-glow 1.8s ease-in-out infinite',
                  }),
                }}
              >
                {/* 锁定图标 */}
                {isLocked && (
                  <Lock size={10} style={{ color: '#60a5fa', flexShrink: 0 }} />
                )}
                {/* 时间标签 */}
                <span style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: isLocked ? '#93c5fd' : '#64748b',
                  minWidth: 36,
                  fontFamily: '"Cascadia Code", Consolas, monospace',
                }}>
                  {slot.time}
                </span>
                {/* 标题 */}
                <span style={{
                  fontSize: 14,
                  color: isFocus ? '#e2e8f0' : '#cbd5e1',
                  fontWeight: isFocus ? 600 : 400,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {slot.title}
                </span>
                {/* focusTime 高亮标记 */}
                {isFocus && (
                  <span style={{
                    fontSize: 8,
                    color: '#818cf8',
                    fontWeight: 700,
                    background: 'rgba(99, 102, 241, 0.18)',
                    padding: '1px 5px',
                    borderRadius: 4,
                    flexShrink: 0,
                  }}>
                    当前
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  /* ── 降级：原有时间线渲染（slots 不存在时行为不变） ── */
  const events = data.events || []

  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: '12px',
      background: 'rgba(24,24,36,0.88)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      minWidth: 200,
    }}>
      {data.title && (
        <div style={{ fontSize: 14, color: '#818cf8', fontWeight: 600, marginBottom: 8 }}>
          <Clock size={10} style={{ display: 'inline', marginRight: 4 }} />
          {data.title}
        </div>
      )}
      <div style={{ position: 'relative', marginLeft: 8 }}>
        {/* Vertical line */}
        <div style={{
          position: 'absolute', left: 3, top: 4, bottom: 4,
          width: 1, background: 'rgba(255,255,255,0.08)',
        }} />
        {events.slice(0, 8).map((e, i) => (
          <div key={i} style={{ position: 'relative', paddingLeft: 16, paddingBottom: i < events.length - 1 ? 10 : 0 }}>
            <div style={{
              position: 'absolute', left: -1, top: 4,
              width: 7, height: 7, borderRadius: '50%',
              background: e.color || '#6366f1',
              border: '2px solid rgba(24,24,36,0.88)',
            }} />
            <div style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 600, lineHeight: 1.3 }}>
              {e.icon && <span style={{ marginRight: 4 }}>{e.icon}</span>}
              {e.title}
            </div>
            <div style={{ fontSize: 8, color: '#64748b' }}>{formatTime(e.timestamp)}</div>
            {e.description && (
              <div style={{ fontSize: 14, color: '#94a3b8', marginTop: 2, lineHeight: 1.3 }}>{e.description}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
