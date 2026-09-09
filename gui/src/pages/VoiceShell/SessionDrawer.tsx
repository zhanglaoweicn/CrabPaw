/**
 * SessionDrawer — 会话历史抽屉（Task 13）
 *
 * 从右侧滑出，展示历史会话列表（按 lastAccessed 倒序），
 * 点击条目加载消息并注入当前对话。
 * Props: {open, onClose, onResume(messages)}
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { apiGet } from '../../lib/api'

interface SessionMeta {
  sessionId: string
  userId?: string
  createdAt?: number
  lastAccessed?: number
  messageCount: number
  projectId?: string | null
  title?: string | null
  summary?: {
    firstMessage?: string
    lastMessage?: string
    messageCount?: number
    createdAt?: number
  } | null
}

interface SessionDrawerProps {
  open: boolean
  onClose: () => void
  // 2026-08-13 P2-4: onResume 携带 sessionId——VoiceShell 续会话上下文
  onResume: (messages: Array<{ role: string; content: string; timestamp?: number }>, sessionId?: string) => void
}

function formatTime(ts?: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `今天 ${time}`
  if (isYesterday) return `昨天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function sessionDisplayTitle(s: SessionMeta): string {
  if (s.title && s.title.trim()) return s.title
  if (s.summary?.firstMessage) {
    const t = s.summary.firstMessage.trim()
    return t.length > 40 ? t.slice(0, 40) + '…' : t
  }
  return s.sessionId?.slice(0, 16) || '(空会话)'
}

export function SessionDrawer({ open, onClose, onResume }: SessionDrawerProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  // onClose 经 ref 持有(调用方传内联箭头, 每渲染新引用)——effect 只依赖 open,
  // 否则父组件重渲染时焦点被反复拉回关闭按钮
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // 2026-08-15 P2-7 a11y 修复: 打开时焦点移入抽屉(关闭按钮), Tab 圈闭在抽屉内,
  // 背景不可 Tab 达; Esc 关闭; 关闭时焦点归还打开前的元素(与 SideSheet 同款)。
  useEffect(() => {
    if (!open) return
    const drawer = drawerRef.current
    const prevFocus = document.activeElement as HTMLElement | null
    const closeBtn = drawer?.querySelector<HTMLElement>('[data-close-btn]')
    if (closeBtn) closeBtn.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !drawer) return
      const focusables = drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const ae = document.activeElement
      if (e.shiftKey) {
        if (ae === first || !drawer.contains(ae)) { e.preventDefault(); last.focus() }
      } else {
        if (ae === last || !drawer.contains(ae)) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      try {
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
          prevFocus.focus()
        }
      } catch (e) { console.warn('[SessionDrawer] 焦点归还失败:', e) }
    }
  }, [open])

  const fetchSessions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 2026-08-13 P2-4: 显式传语音频道 userId——默认 'default' 看不到语音会话
      const res = await apiGet<{ sessions: SessionMeta[]; total: number }>('/api/sessions/list?userId=voice_shell_user')
      if (res.success && res.data) {
        setSessions(res.data.sessions || [])
      } else {
        setError(res.error || '加载会话列表失败')
      }
    } catch (e: any) {
      setError(e?.message || '加载会话列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchSessions()
    }
  }, [open, fetchSessions])

  const handleResume = useCallback(async (sessionId: string) => {
    setLoadingDetail(sessionId)
    try {
      const res = await apiGet<{ messages: Array<{ role: string; content: string; timestamp?: number }> }>(
        `/api/sessions/${encodeURIComponent(sessionId)}`
      )
      const msgs = res.data?.messages
      // 2026-08-14 数据链审计 A7: [] 为 truthy,旧判定会静默清空当前对话;改为长度判定,
      // 空会话给出明确提示而非 onResume([]) 后关闭抽屉
      if (res.success && Array.isArray(msgs) && msgs.length > 0) {
        onResume(msgs, sessionId)
        onClose()
      } else if (res.success && Array.isArray(msgs) && msgs.length === 0) {
        setError('该会话暂无消息，无法恢复')
      } else {
        setError(res.error || '加载消息失败')
      }
    } catch (e: any) {
      setError(e?.message || '加载消息失败')
    } finally {
      setLoadingDetail(null)
    }
  }, [onResume, onClose])

  if (!open) return null

  return (
    <div className="session-drawer-mask" onClick={onClose}>
      <div
        ref={drawerRef}
        className="session-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="历史会话"
      >
        <div className="session-drawer-head">
          <span>历史会话</span>
          <button
            type="button"
            className="session-drawer-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭历史会话"
            data-close-btn
          >
            ✕
          </button>
        </div>

        <div className="session-drawer-body">
          {loading && (
            <div className="session-drawer-loading">加载中…</div>
          )}
          {error && (
            <div className="session-drawer-error">{error}</div>
          )}
          {!loading && !error && sessions.length === 0 && (
            <div className="session-drawer-empty">暂无历史会话</div>
          )}
          {!loading && !error && sessions.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              className={`session-drawer-item${loadingDetail === s.sessionId ? ' is-loading' : ''}`}
              onClick={() => handleResume(s.sessionId)}
              disabled={loadingDetail !== null}
            >
              <div className="session-drawer-item-title">
                {sessionDisplayTitle(s)}
              </div>
              <div className="session-drawer-item-meta">
                <span>{s.messageCount} 条消息</span>
                <span>{formatTime(s.lastAccessed || s.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
