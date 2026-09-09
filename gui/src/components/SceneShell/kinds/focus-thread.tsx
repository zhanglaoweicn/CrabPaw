/**
 * FocusThreadCard — 焦点线程卡片
 */

import { Target, CheckCircle2, Circle, Clock, AlertTriangle } from 'lucide-react'

export interface FocusThreadItem {
  label: string
  done: boolean
}

export interface FocusThread {
  id: string
  title: string
  status: 'pending' | 'active' | 'done' | 'blocked' | 'snoozed'
  progress?: number
  dueAt?: number | null
  items?: FocusThreadItem[]
}

export interface FocusThreadData {
  title?: string
  threads: FocusThread[]
}

const STATUS_CONFIG: Record<string, { icon: typeof Target; color: string; label: string }> = {
  active:  { icon: Target, color: '#22c55e', label: '活跃' },
  pending: { icon: Circle, color: '#94a3b8', label: '待办' },
  done:    { icon: CheckCircle2, color: '#6366f1', label: '完成' },
  blocked: { icon: AlertTriangle, color: '#f59e0b', label: '阻塞' },
  snoozed: { icon: Clock, color: '#64748b', label: '搁置' },
}

export function FocusThreadCard({ data }: { data: FocusThreadData }) {
  const threads = data.threads || []

  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: '12px',
      background: 'rgba(24,24,36,0.88)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      minWidth: 220,
    }}>
      {data.title && (
        <div style={{ fontSize: 14, color: '#818cf8', fontWeight: 600, marginBottom: 8 }}>
          🎯 {data.title}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {threads.slice(0, 6).map(t => {
          const cfg = STATUS_CONFIG[t.status] || STATUS_CONFIG.pending
          const Icon = cfg.icon
          const total = (t.items || []).length

          return (
            <div key={t.id} style={{
              padding: '6px 8px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${cfg.color}22`,
              borderLeft: `2px solid ${cfg.color}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: total > 0 ? 4 : 0 }}>
                <Icon size={12} style={{ color: cfg.color }} />
                <span style={{ fontSize: 14, color: '#e2e8f0', fontWeight: 500, flex: 1 }}>
                  {t.title}
                </span>
                <span style={{
                  fontSize: 8, padding: '1px 5px', borderRadius: 4,
                  background: `${cfg.color}18`, color: cfg.color, fontWeight: 600,
                }}>
                  {cfg.label}
                </span>
              </div>

              {/* Progress bar */}
              {t.progress !== undefined && t.progress > 0 && (
                <div style={{ marginLeft: 18, marginTop: 2 }}>
                  <div style={{ height: 2, borderRadius: 1, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 1,
                      background: cfg.color,
                      width: `${Math.min(100, t.progress)}%`,
                      transition: 'width 0.3s',
                    }} />
                  </div>
                </div>
              )}

              {/* Subtask items */}
              {total > 0 && (
                <div style={{ marginLeft: 18, marginTop: 4 }}>
                  {(t.items || []).slice(0, 4).map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '1px 0' }}>
                      {item.done
                        ? <CheckCircle2 size={8} style={{ color: '#22c55e' }} />
                        : <Circle size={8} style={{ color: '#475569' }} />
                      }
                      <span style={{
                        fontSize: 14, color: item.done ? '#64748b' : '#94a3b8',
                        textDecoration: item.done ? 'line-through' : 'none',
                      }}>
                        {item.label}
                      </span>
                    </div>
                  ))}
                  {total > 4 && (
                    <div style={{ fontSize: 8, color: '#475569', marginLeft: 12 }}>
                      +{total - 4} 项
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
