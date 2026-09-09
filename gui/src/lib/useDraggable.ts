/**
 * useDraggable — 共享拖动 hook（2026-08-31 M1 自 SideSheet:55-89 抽取）
 *
 * 行为与 SideSheet 原实现逐字对齐:
 *   - 指针捕获拖动, 偏移经 onOffsetChange 受控上抛(位置由调用方持有/持久化)
 *   - ignoreSelector 内的元素按下不启动拖拽(按钮/输入/滚动区 data-no-drag 豁免)
 *   - 视口钳制: 左/上界 8-w 保证留 8px 可触及, 右/下界 vw-40 / vh-40(与 geometry.ts 镜像)
 *   - enabled=false 完全禁用; pointercancel/lostpointercapture 同 up 结束
 */
import { useRef, useState } from 'react'

export interface UseDraggableOptions {
  /** 拖动是否启用 */
  enabled: boolean
  /** 受控偏移（可为 null/undefined=0,0） */
  offset?: { x: number; y: number } | null
  /** 偏移变化回调（拖动过程中持续触发） */
  onOffsetChange?: (o: { x: number; y: number }) => void
  /** 面板引用——钳制需量面板尺寸(取 offsetWidth/Height) */
  panelRef: React.RefObject<HTMLElement | null>
  /** 按下豁免选择器(默认 SideSheet 同款) */
  ignoreSelector?: string
  /** 2026-08-31: 交互元素(按钮等)也允许拖动——按下移动>3px 视为拖动并抑制随后的
   *  click(原地点击仍触发按钮语义)。语音球卡等"整个卡都是按钮"的场景用。 */
  dragOnButtons?: boolean
}

export function useDraggable({
  enabled,
  offset,
  onOffsetChange,
  panelRef,
  ignoreSelector = 'button, input, select, textarea, a, [data-no-drag]',
  dragOnButtons = false,
}: UseDraggableOptions) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  /** 本次 pointerdown 后是否已越过拖拽阈值(移动>3px)——用于抑制 click */
  const movedRef = useRef(false)
  const suppressClickRef = useRef(false)
  /** click 在 pointerup 之后派发——用时间窗限制抑制有效期(防拖后误吞下一下点击) */
  const suppressAtRef = useRef(0)

  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled) return
    const t = e.target as HTMLElement
    if (!dragOnButtons && t.closest(ignoreSelector)) return
    movedRef.current = false
    suppressClickRef.current = false
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offset?.x ?? 0,
      origY: offset?.y ?? 0,
    }
    setDragging(true)
    // 2026-08-31 修复(点击展开没反应): 不在 pointerdown 立即 setPointerCapture——
    // 浏览器会把后续 click 重定向到捕获元素, 按钮内点击被劫持(jsdom 不模拟此语义)。
    // 改为越过 3px 阈值(确认为拖动)时才捕获。
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    e.preventDefault()
    if (!movedRef.current) {
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (Math.abs(dx) + Math.abs(dy) < 3) return // 未达拖动阈值: 等待确定意图
      movedRef.current = true
      suppressClickRef.current = true
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    // 面板尺寸感知 clamp: 左/上界 8-w 保证留 8px 可触及, 右/下界 vw-40（镜像 geometry.ts 8-w）
    const clampX = (v: number) => {
      const w = panelRef.current?.offsetWidth ?? window.innerWidth - 32
      return Math.max(8 - w, Math.min(v, window.innerWidth - 40))
    }
    const clampY = (v: number) => {
      const h = panelRef.current?.offsetHeight ?? window.innerHeight - 32
      return Math.max(8 - h, Math.min(v, window.innerHeight - 40))
    }
    onOffsetChange?.({ x: clampX(d.origX + e.clientX - d.startX), y: clampY(d.origY + e.clientY - d.startY) })
  }

  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
    if (suppressClickRef.current) suppressAtRef.current = Date.now()
  }

  /** 拖动后抑制 click(防止按钮语义触发)——捕获阶段拦截 + 600ms 时间窗 */
  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClickRef.current && Date.now() - suppressAtRef.current < 600) {
      e.preventDefault()
      e.stopPropagation()
    }
    suppressClickRef.current = false
  }

  return {
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onClickCapture,
    },
  }
}
