/**
 * useDraggable — 抽取自 SideSheet 的共享拖动 hook（2026-08-31 M1）
 * 行为契约（与 SideSheet 原实现完全一致）:
 *   T1 忽略选择器内的元素按下不启动拖动
 *   T2 拖动移动并钳制在视口内(左/上 8px 可触及, 右/下 vw-40)
 *   T3 pointercancel 结束拖动; 无 offset 时从 0 起算
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useRef } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { useDraggable } from './useDraggable'

function Harness({ enabled = true, offset = undefined as any, onOffsetChange = vi.fn(), ignoreSelector = 'button, input, [data-no-drag]' }: any) {
  const ref = useRef<HTMLDivElement>(null)
  const { dragging, handlers } = useDraggable({ enabled, offset, onOffsetChange, panelRef: ref, ignoreSelector })
  return (
    <div ref={ref} data-testid="panel" {...handlers}>
      <div data-testid="blank" style={{ width: 200, height: 100 }} />
      <button data-testid="btn">x</button>
      <div data-testid="nodrag" data-no-drag>nd</div>
      <span data-testid="dragging-flag">{dragging ? 'dragging' : 'idle'}</span>
    </div>
  )
}

function startMove(el: HTMLElement, x0: number, y0: number, x1: number, y1: number) {
  fireEvent.pointerDown(el, { clientX: x0, clientY: y0, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: x1, clientY: y1, pointerId: 1 })
  fireEvent.pointerUp(el, { pointerId: 1 })
}

/** jsdom 无布局——在元素上固定面板测量值, 钳制计算可测 */
function fixSize(el: HTMLElement, w: number, h: number) {
  Object.defineProperty(el, 'offsetWidth', { value: w, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: h, configurable: true })
}

describe('useDraggable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T1 忽略选择器内的元素按下不启动拖动', () => {
    const onOffsetChange = vi.fn()
    const { getByTestId } = render(<Harness onOffsetChange={onOffsetChange} />)
    fireEvent.pointerDown(getByTestId('btn'), { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(getByTestId('btn'), { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(getByTestId('btn'), { pointerId: 1 })
    expect(onOffsetChange).not.toHaveBeenCalled()
    expect(getByTestId('dragging-flag').textContent).toBe('idle')
  })

  it('T2 拖动产生偏移并按视口钳制', () => {
    const onOffsetChange = vi.fn()
    const { getByTestId } = render(<Harness onOffsetChange={onOffsetChange} />)
    const panel = getByTestId('panel')
    fixSize(panel, 300, 120)
    // 原点 100,100 → +300,+300 = 400,400 < 视口界, 原样生效
    startMove(panel, 100, 100, 400, 400)
    expect(onOffsetChange).toHaveBeenLastCalledWith({ x: 300, y: 300 })
    // 超出右/下界 → 钳制到 vw-40 / vh-40 (1024-40, 768-40)
    startMove(panel, 0, 0, 5000, 5000)
    expect(onOffsetChange).toHaveBeenLastCalledWith({ x: 1024 - 40, y: 768 - 40 })
    // 向左越界 → 钳制到 8-w (面板宽300 → -292), 8-h (120 → -112)
    startMove(panel, 100, 100, -9999, -9999)
    expect(onOffsetChange).toHaveBeenLastCalledWith({ x: 8 - 300, y: 8 - 120 })
  })

  it('T3 pointercancel 结束拖动', () => {
    const onOffsetChange = vi.fn()
    const { getByTestId } = render(<Harness onOffsetChange={onOffsetChange} />)
    const panel = getByTestId('panel')
    fixSize(panel, 300, 120)
    fireEvent.pointerDown(panel, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(panel, { clientX: 50, clientY: 50, pointerId: 1 }) // 1 次偏移
    fireEvent.pointerCancel(panel, { pointerId: 1 })
    fireEvent.pointerMove(panel, { clientX: 200, clientY: 200, pointerId: 1 }) // cancel 后不再累计
    expect(onOffsetChange).toHaveBeenCalledTimes(1)
    expect(onOffsetChange).toHaveBeenLastCalledWith({ x: 50, y: 50 })
  })

  it('T3b enabled=false 不启动拖动', () => {
    const onOffsetChange = vi.fn()
    const { getByTestId } = render(<Harness enabled={false} onOffsetChange={onOffsetChange} />)
    startMove(getByTestId('panel'), 0, 0, 200, 200)
    expect(onOffsetChange).not.toHaveBeenCalled()
  })
})
