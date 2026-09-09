/**
 * SideSheet — 侧滑面板基座（参考实现 hotspot-panel 交互模式复刻）
 *
 * 对照参考实现 styles.css 2731-2868 / hotspot.js 356-410：
 * - 常驻挂载：关闭不卸载，width 0→var(--sheet-width) 双向 0.45s cubic-bezier(0.4,0,0.2,1)
 *   + opacity 0.35s ease + pointer-events 切换；
 * - 启动序列：每次打开重挂 is-booting（先移除再 rAF，对应 replayHotspotBoot 强制 reflow），
 *   子区块标 sheet-boot class + 内联 --boot-delay 变量，错峰 glitch 闪入 + 信号扫光；
 * - 布局联动：body 挂 side-sheet-open + --sheet-width（sheet-state），VoiceShell 聊天列右移；
 * - 互斥：registerSheet/activateSheet（sheet-state），打开一个自动关闭其他；
 * - prefers-reduced-motion 下动画禁用（styles.css 内处理）。
 */
import { useEffect, useRef, useState } from 'react'
import { activateSheet, closeSheet, registerSheet, setSheetDocument } from './sheet-state'
import { computeCenterOffset } from './geometry'
import { useDraggable } from '../../lib/useDraggable'
import './styles.css'

export interface SideSheetProps {
  open: boolean
  onClose: () => void
  /** 面板名：'hotspot' | 'weather' | 'music' —— 互斥键 + body class side-sheet-<name> */
  name: string
  /** CSS 宽度，默认 min(56vw, 860px)；与 body --sheet-width 同步供布局联动 */
  width?: string
  /** 2026-08-14: 高度内容自适应浮动卡模式——天气/音乐等轻量卡片用。
   *  默认全高(top/bottom 16 贴边)；fitContent 高度随内容,垂直顶部对齐 */
  fitContent?: boolean
  zIndex?: number | string
  /** 2026-08-15: 可拖动模式——空白区(按钮/输入框/滚动区 data-no-drag 豁免)按下拖动,
   *  面板经 transform 偏移, 位置由调用方持有(可 localStorage 持久化)。互斥/动画不变 */
  draggable?: boolean
  dragOffset?: { x: number; y: number }
  onDragOffsetChange?: (o: { x: number; y: number }) => void
  /** 2026-08-15: 打开时自动居中（draggable 模式）——open 变 true 后等宽度过渡稳定
   *  (~500ms, 对齐 0.45s) 量面板实际尺寸, 经 onDragOffsetChange 下发居中偏移;
   *  拖动中不重算(用户偏移优先), 本次显示内不持久化(重开自动重新居中)。 */
  centerOnOpen?: boolean
  /** 2026-08-15: 打开后固定 N ms 自动触发 onClose（无关闭动作兜底）；
   *  open 变 false/卸载时清理计时器, 重开自动重计时。 */
  autoCloseMs?: number
  children: React.ReactNode
}

export function SideSheet({ open, onClose, name, width = 'min(56vw, 860px)', fitContent = false, zIndex = 'var(--z-sheet)', draggable = false, dragOffset, onDragOffsetChange, centerOnOpen = false, autoCloseMs, children }: SideSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  // 启动序列：每次打开重放（先移除再 rAF 重挂）
  const [booting, setBooting] = useState(false)
  useEffect(() => {
    if (!open) { setBooting(false); return }
    setBooting(false)
    const raf = requestAnimationFrame(() => setBooting(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  // 2026-09-02 偶发"幽灵遮盖"修复: 关闭过渡(0.45s)结束后 display:none 彻底移出渲染树。
  // 此前关闭态仅 opacity/visibility 隐藏(常驻挂载)——面板内的 GPU 层(台风 Leaflet
  // 地图 canvas、backdrop-filter 玻璃)可能被合成器保留, 偶发把整层"画"回屏幕:
  // 症状为面板关闭后应用顶栏消失/对话卡被暗色层盖住。display:none 后 GPU 层必然销毁。
  // 打开瞬间恢复(早于宽度过渡), 开合动画不受影响。
  const [fullyClosed, setFullyClosed] = useState(!open)
  useEffect(() => {
    if (open) { setFullyClosed(false); return }
    const t = setTimeout(() => setFullyClosed(true), 500)
    return () => clearTimeout(t)
  }, [open])

  // 2026-08-15: 可拖动模式——pointer capture 拖动, transform 偏移。
  // 按钮/输入框/滚动区(data-no-drag)按下不启动拖拽, 交互不受影响。
  // 2026-08-31 M1: 拖动逻辑抽取至共享 useDraggable(行为逐字对齐), 此处仅保留
  // centerOnOpen 用到的 userDraggedRef 标记 + 转发。
  const userDraggedRef = useRef(false)
  const { dragging, handlers } = useDraggable({
    enabled: draggable && open,
    offset: dragOffset,
    onOffsetChange: (o) => { userDraggedRef.current = true; onDragOffsetChange?.(o) },
    panelRef,
  })

  // onClose 用 ref 持有：registerSheet 只注册一次，回调恒取最新
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // 2026-08-15: centerOnOpen——每次 open→true 等宽度过渡稳定后量面板尺寸, 下发居中偏移。
  // 拖动进行中不重算(用户偏移优先); 仅本次显示生效, 不持久化(重开自动重新居中)。
  const centeredOnceRef = useRef(false)
  useEffect(() => {
    if (!open || !centerOnOpen || !draggable || !onDragOffsetChange) return
    centeredOnceRef.current = false
    userDraggedRef.current = false
    const t = setTimeout(() => {
      if (dragging || userDraggedRef.current) return  // 拖动进行中或本窗已拖过不重算
      const el = panelRef.current
      if (!el || centeredOnceRef.current) return
      centeredOnceRef.current = true
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (w === 0 || h === 0) return
      onDragOffsetChange(computeCenterOffset(window.innerWidth, window.innerHeight, w, h))
    }, 500)
    return () => clearTimeout(t)
  }, [open, centerOnOpen, draggable, onDragOffsetChange, dragging])

  // 2026-08-15: autoCloseMs——打开后固定 N ms 自动触发 onClose（无关闭动作兜底）。
  // open→false(用户提前关闭/互斥顶掉/卸载)计时器随之清除, 无双重关闭。
  useEffect(() => {
    if (!open || !autoCloseMs) return
    const t = setTimeout(() => onCloseRef.current(), autoCloseMs)
    return () => clearTimeout(t)
  }, [open, autoCloseMs])

  // 互斥 + body 联动
  useEffect(() => {
    if (!open) return
    setSheetDocument(document as any)
    const unregister = registerSheet(name, () => onCloseRef.current())
    activateSheet(name, width)
    return () => { closeSheet(name); unregister() }
  }, [open, name, width])

  // Esc 关闭（对齐参考实现各模式退出习惯；音乐面板自带 Esc 处理，幂等不冲突）
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 焦点管理（规格 §2 可访问性）：打开时关闭按钮获得初始焦点（原版为普通 div，本次补足）
  // 各面板关闭按钮需带 data-close-btn 属性（见 Task 4/5/6）
  // 2026-08-15 P2-12: aria-modal="true" 补焦点圈闭——打开时记录入口焦点(关闭归还),
  // Tab 循环圈闭在面板内, 防焦点逃逸到背景内容(此前 Tab 可 Tab 出面板)。
  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const prevFocus = document.activeElement as HTMLElement | null
    const target = panel?.querySelector<HTMLElement>('[data-close-btn]')
    // 2026-08-19 修复: 输入中不抢焦点——打开即 focus 关闭按钮会打断聊天输入框的组合
    // 输入(输入法 compositionend 不触发 → 原生 isComposing 卡死 → 之后回车永远被吞,
    // 只能鼠标点发送)。无障碍初始焦点仅在没有正在输入时执行。
    const typing = prevFocus && (prevFocus.tagName === 'INPUT' || prevFocus.tagName === 'TEXTAREA')
    if (target && !typing) target.focus()

    const trapFocus = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      if (!panel) return
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const ae = document.activeElement
      if (e.shiftKey) {
        if (ae === first || !panel.contains(ae)) { e.preventDefault(); last.focus() }
      } else {
        if (ae === last || !panel.contains(ae)) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', trapFocus, true)
    return () => {
      document.removeEventListener('keydown', trapFocus, true)
      try {
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
          prevFocus.focus()
        }
      } catch (e) { console.warn('[SideSheet] 焦点归还失败:', e) }
    }
  }, [open])

  return (
    <div
      ref={panelRef}
      className={`side-sheet side-sheet--${name}${booting ? ' is-booting' : ''}${dragging ? ' is-dragging' : ''}`}
      data-open={open}
      data-fit-content={fitContent ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} 面板`}
      style={{
        zIndex,
        display: fullyClosed ? 'none' : undefined,
        cursor: draggable && open ? (dragging ? 'grabbing' : 'grab') : undefined,
        transform: draggable && dragOffset && (dragOffset.x !== 0 || dragOffset.y !== 0)
          ? `translate(${dragOffset.x}px, ${dragOffset.y}px)`
          : undefined,
      }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onLostPointerCapture={handlers.onLostPointerCapture}
    >
      {children}
    </div>
  )
}

export default SideSheet
