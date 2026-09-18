/**
 * WebBrowsePanel — 应用内网页浏览浮层（常驻宿主，App 挂载）
 *
 * 访客页由主进程 WebContentsView 承载（原生层，盖在一切 React 内容之上），
 * React 只画 46px 工具栏 + 透明占位矩形，并把占位矩形上报主进程 setBounds。
 * 打开入口：任意组件 dispatch `crabpaw:webpanel-open` {url,title}
 * （第一批接线方：SceneShell WebPreviewCard 的"应用内打开"按钮）。
 *
 * 安全：访客页独立内存 partition/sandbox/无 preload，导航限 http/https，
 * 弹窗与下载转发系统浏览器——闸门全部在主进程（electron/main/web-browse.ts）。
 * 注意：WebContentsView 覆盖区域内 React 事件不可达，故工具栏在覆盖区外（顶部）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  WEBPANEL_OPEN_EVENT,
  computePanelRect,
  guestBounds,
  isWebPanelNavigableUrl,
  sanitizeWebPanelState,
  displayTitle,
  type WebPanelAction,
  type WebPanelOpenDetail,
  type WebPanelState,
} from '../../lib/web-browse'

const BTN_STYLE: React.CSSProperties = {
  flexShrink: 0, width: '26px', height: '26px', borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)',
  color: '#cbd5e1', fontSize: '13px', lineHeight: 1,
  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 0,
}

function isBtnDisabled(disabled: boolean): React.CSSProperties {
  return disabled ? { opacity: 0.35, cursor: 'default' } : {}
}

export function WebBrowsePanel() {
  const [open, setOpen] = useState(false)
  const [openUrl, setOpenUrl] = useState('')
  const [cardTitle, setCardTitle] = useState('')
  const [state, setState] = useState<WebPanelState | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // 打开事件：任意组件 dispatch → 校验 URL → 主进程 show → 本地浮层渲染
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<WebPanelOpenDetail>).detail
      if (!detail || !isWebPanelNavigableUrl(detail.url)) {
        console.warn('[WebBrowsePanel] 忽略非法/缺失 URL 的打开请求:', detail?.url)
        return
      }
      if (!computePanelRect(window.innerWidth, window.innerHeight)) return // 视口过小
      setOpenUrl(detail.url)
      setCardTitle(typeof detail.title === 'string' ? detail.title : '')
      setState(null)
      setOpen(true)
      window.electronAPI?.webPanel?.show?.(detail.url)?.catch?.((err: unknown) => {
        console.warn('[WebBrowsePanel] show 失败:', err instanceof Error ? err.message : String(err))
      })
    }
    window.addEventListener(WEBPANEL_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(WEBPANEL_OPEN_EVENT, onOpen)
  }, [])

  // 主进程状态推送（导航/标题/加载态）
  useEffect(() => {
    const api = window.electronAPI?.webPanel
    if (!api?.onState) return
    return api.onState((raw: unknown) => setState(sanitizeWebPanelState(raw)))
  }, [])

  // 矩形上报：挂载后/窗口尺寸变化/占位区尺寸变化（ResizeObserver 兜住 devtools 开合等）
  useEffect(() => {
    if (!open) return
    const api = window.electronAPI?.webPanel
    if (!api?.setBounds) return
    let raf = 0
    const report = () => {
      raf = 0
      const panel = computePanelRect(window.innerWidth, window.innerHeight)
      if (!panel) return
      api.setBounds(guestBounds(panel)).catch((err: Error) => {
        console.warn('[WebBrowsePanel] setBounds 失败:', err?.message || err)
      })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(report) }
    schedule()
    const ro = new ResizeObserver(schedule)
    if (contentRef.current) ro.observe(contentRef.current)
    window.addEventListener('resize', schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [open])

  const close = useCallback(() => {
    setOpen(false)
    window.electronAPI?.webPanel?.close?.()?.catch?.((err: unknown) => {
      console.warn('[WebBrowsePanel] close 失败:', err instanceof Error ? err.message : String(err))
    })
  }, [])

  // 卸载兜底：销毁访客页防残留
  useEffect(() => () => {
    window.electronAPI?.webPanel?.close?.()?.catch?.(() => { /* 静默兜底 */ })
  }, [])

  // Esc 关闭（输入框聚焦时豁免——访客页内按键不经过 React，天然不触发）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const ae = document.activeElement
      if (ae instanceof HTMLElement && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  const doAction = useCallback((action: WebPanelAction) => {
    window.electronAPI?.webPanel?.action?.(action)?.catch?.((err: unknown) => {
      console.warn('[WebBrowsePanel] action 失败:', action, err instanceof Error ? err.message : String(err))
    })
  }, [])

  if (!open) return null
  const panel = computePanelRect(window.innerWidth, window.innerHeight)
  if (!panel) return null

  const shownUrl = state?.url || openUrl
  const shownTitle = displayTitle(cardTitle || state?.title, shownUrl)
  const loading = state?.isLoading !== false // 未收到首帧状态前按加载中处理

  return (
    <div
      data-testid="web-browse-panel"
      style={{
        position: 'fixed', zIndex: 12000,
        left: panel.x, top: panel.y, width: panel.width, height: panel.height,
        display: 'flex', flexDirection: 'column',
        background: 'rgba(24,24,36,0.92)', backdropFilter: 'blur(16px)',
        border: '1px solid rgba(99,102,241,0.28)', borderRadius: '14px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)', overflow: 'hidden',
      }}
    >
      {/* 工具栏（WebContentsView 覆盖区之外，可交互） */}
      <div style={{
        height: 46, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: '6px', padding: '0 10px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', position: 'relative',
      }}>
        <button type="button" title="后退" aria-label="后退" style={{ ...BTN_STYLE, ...isBtnDisabled(!state?.canGoBack) }} onClick={() => doAction('back')}>←</button>
        <button type="button" title="前进" aria-label="前进" style={{ ...BTN_STYLE, ...isBtnDisabled(!state?.canGoForward) }} onClick={() => doAction('forward')}>→</button>
        <button type="button" title={loading ? '停止' : '刷新'} aria-label={loading ? '停止' : '刷新'} style={BTN_STYLE} onClick={() => doAction(loading ? 'stop' : 'reload')}>{loading ? '✕' : '⟳'}</button>
        <span
          title={shownUrl}
          style={{
            flex: 1, minWidth: 0, textAlign: 'center', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>{shownTitle}</span>
          <span style={{ fontSize: '9px', color: '#666', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shownUrl}</span>
        </span>
        <button type="button" title="用系统浏览器打开" aria-label="用系统浏览器打开" style={BTN_STYLE} onClick={() => doAction('open-external')}>↗</button>
        <button type="button" title="关闭" aria-label="关闭浏览面板" style={BTN_STYLE} onClick={close}>✕</button>
        {/* 加载指示条 */}
        {loading && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: -1, height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(99,102,241,0.8), transparent)',
            backgroundSize: '50% 100%',
            animation: 'wp-loading-shimmer 1.2s ease-in-out infinite',
          }} />
        )}
      </div>

      {/* 占位区：被主进程 WebContentsView 精确覆盖（矩形经 guestBounds 上报） */}
      <div ref={contentRef} role="region" aria-label="网页内容" style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}
