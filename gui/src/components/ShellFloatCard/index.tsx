/**
 * ShellFloatCard — 首页浮动玻璃卡壳（2026-08-31 M1）
 *
 * 三卡片（心跳/语音球/对话窗）通用基座：
 * - fixed 定位 + translate 偏移，draggable，位置 localStorage 按卡持久化
 * - 玻璃样式：rgba 深空基底 + 细描边 + 内发光（大卡默认无 blur——规避 MediaStage
 *   blur+视频合成层黑屏事故；小卡可 blur="sm"(8px)/"md"(12px)）
 * - resetNonce 变更 → 清持久化并回默认偏移（"恢复默认布局"用）
 * - 交互豁免：按钮/输入/滚动区 [data-no-drag] 按下不拖动（useDraggable 默认规则）
 */
import { useEffect, useRef, useState } from 'react'
import { useDraggable } from '../../lib/useDraggable'
import './styles.css'

export interface ShellFloatCardProps {
  /** 持久化键后缀: localStorage['voice-shell.card.<cardKey>'] */
  cardKey: string
  children: React.ReactNode
  /** 固定宽度（字符串 CSS 宽度或数字 px） */
  width?: string | number
  zIndex?: number | string
  className?: string
  style?: React.CSSProperties
  /** 顶部标题栏（兼拖拽柄区域；不传则不显示顶栏） */
  title?: string
  /** 2026-09-05: 可选 DOM 标识——外部组件(如 CollabOrbit)需量取本卡实时位置时使用 */
  domId?: string
  /** 持久化为空时的默认偏移（相对 fixed 锚点 0,0） */
  defaultOffset?: { x: number; y: number }
  /** 玻璃模糊档：默认 none（大型卡禁用 blur 防合成层黑屏） */
  blur?: 'none' | 'sm' | 'md'
  /** 2026-08-31: 卡内交互元素(按钮等)也允许拖动——按下移动=拖, 原地点击=按钮语义 */
  dragOnButtons?: boolean
  /** 2026-08-31: 裸卡态——去边线/底色/投影(如语音球透明化试验) */
  bare?: boolean
  /** "恢复默认布局"非ce——变更时清持久化回默认 */
  resetNonce?: number
}

export function ShellFloatCard({
  cardKey,
  children,
  width,
  zIndex = 'var(--z-float-card)',
  className = '',
  style,
  title,
  domId,
  defaultOffset = { x: 24, y: 24 },
  blur = 'none',
  dragOnButtons = false,
  bare = false,
  resetNonce = 0,
}: ShellFloatCardProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const storageKey = `voice-shell.card.${cardKey}`

  const readStored = (): { x: number; y: number } | null => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const p = JSON.parse(raw)
        if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
      }
    } catch { /* 损坏/不可用 → 默认 */ }
    return null
  }

  const [offset, setOffset] = useState<{ x: number; y: number } | null>(() => readStored())
  /** 用户拖动产生偏移后为 true——持久化仅写用户拖动值（防重置后回写） */
  const dirtyRef = useRef(false)

  const { dragging, handlers } = useDraggable({
    enabled: true,
    offset,
    onOffsetChange: (o) => { dirtyRef.current = true; setOffset(o) },
    panelRef,
    dragOnButtons,
  })

  // 位置持久化（拖动中不写盘——结束时写；仅写用户拖动的值）
  useEffect(() => {
    if (!dirtyRef.current) return
    if (!offset || dragging) return
    try { localStorage.setItem(storageKey, JSON.stringify(offset)) } catch { /* 忽略 */ }
  }, [offset, dragging, storageKey])

  // 恢复默认布局：清持久化 + 回默认
  useEffect(() => {
    if (resetNonce === 0) return
    try { localStorage.removeItem(storageKey) } catch { /* 忽略 */ }
    dirtyRef.current = false
    setOffset({ ...defaultOffset })
  }, [resetNonce, storageKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const effectiveOffset = offset ?? defaultOffset
  const cssWidth = typeof width === 'number' ? `${width}px` : width

  return (
    <div
      ref={panelRef}
      id={domId}
      data-testid="shell-float-card"
      className={`sfc${bare ? ' sfc--bare' : ''}${dragging ? ' sfc--dragging' : ''} sfc--blur-${blur} ${className}`}
      style={{
        width: cssWidth,
        zIndex,
        ...style,
        transform: `translate(${effectiveOffset.x}px, ${effectiveOffset.y}px)`,
        cursor: dragging ? 'grabbing' : 'grab',
      }}
      {...handlers}
    >
      {title ? (
        <div className="sfc-title">
          <span className="sfc-title-text">{title}</span>
          <span className="sfc-grip" aria-hidden="true">⠿</span>
        </div>
      ) : null}
      <div className="sfc-body">{children}</div>
    </div>
  )
}

export default ShellFloatCard
