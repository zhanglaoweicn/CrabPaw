/**
 * SideSheet 关闭后 display:none 行为测试（2026-09-02 幽灵遮盖修复）
 *
 * 关闭态此前仅 opacity/visibility 隐藏（常驻挂载），面板内 GPU 层（Leaflet
 * canvas/backdrop-filter）偶发被合成器"画"回屏幕 → 面板关闭后顶栏消失/对话卡
 * 被盖。修复：关闭过渡(0.45s)结束后 display:none 彻底移出渲染树；打开立即恢复。
 */
import { act } from '@testing-library/react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { SideSheet } from './index'

afterEach(() => {
  vi.useRealTimers()
})

describe('SideSheet 关闭后彻底移出渲染树', () => {
  it('关闭过渡期间仍可见(动画保留), 500ms 后 display:none', async () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <SideSheet open onClose={() => {}} name="test">
        <div>content</div>
      </SideSheet>,
    )
    const sheet = container.querySelector('.side-sheet') as HTMLElement
    expect(sheet).toBeTruthy()
    expect(sheet.style.display).not.toBe('none')

    rerender(
      <SideSheet open={false} onClose={() => {}} name="test">
        <div>content</div>
      </SideSheet>,
    )
    // 过渡期(0.45s)内未到 display:none——CSS 过渡动画保留
    expect(sheet.style.display).not.toBe('none')

    await act(async () => { vi.advanceTimersByTime(600) })
    expect(sheet.style.display).toBe('none')
  })

  it('display:none 后重新打开 → 立即恢复渲染', async () => {
    vi.useFakeTimers()
    const { container, rerender } = render(
      <SideSheet open={false} onClose={() => {}} name="test2">
        <div>content</div>
      </SideSheet>,
    )
    let sheet = container.querySelector('.side-sheet') as HTMLElement
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(sheet.style.display).toBe('none')

    rerender(
      <SideSheet open onClose={() => {}} name="test2">
        <div>content</div>
      </SideSheet>,
    )
    sheet = container.querySelector('.side-sheet') as HTMLElement
    expect(sheet.style.display).not.toBe('none')
    expect(container.textContent).toContain('content')
  })
})
