/** @jest-environment jsdom */
/**
 * OrbTopBlock 球上手势单测（2026-09-24 用户反馈："点球没反应、无法静音"）
 *
 * 锁住三条语义：
 *   轻点球（未静音）→ 开始听 / 打断播报
 *   轻点球（静音）  → 开启语音（不留死角：球永远可用）
 *   按住球 ≥220ms   → 走 ptt 命令宿主的 start（一体机没有键盘，这是唯一入口）
 */
import { render, fireEvent, act } from '@testing-library/react'
import { OrbTopBlock } from './OrbTopBlock'
import { registerCommandHost } from '../../lib/ui-command-registry'

const baseProps = {
  orbMode: 'listening' as const,
  volume: 0,
  speechRate: 'default' as const,
  micMode: 'default' as const,
}

/** 轻点 = 按下后立刻抬起（低于按住阈值） */
function tap(ball: HTMLElement) {
  fireEvent.pointerDown(ball, { clientX: 0, clientY: 0, button: 0, pointerType: 'touch' })
  fireEvent.pointerUp(ball, { clientX: 0, clientY: 0, pointerType: 'touch' })
}

describe('OrbTopBlock 球上手势', () => {
  test('未静音：轻点 → 开始听 / 打断（不静音）', () => {
    const onTapTalk = vi.fn()
    const onToggleMute = vi.fn()
    const { container } = render(
      <OrbTopBlock {...baseProps} muted={false} onTapTalk={onTapTalk} onToggleMute={onToggleMute} />,
    )
    const ball = container.querySelector('button.voice-shell-orb-click') as HTMLElement
    expect(ball).toBeTruthy()
    tap(ball)
    expect(onTapTalk).toHaveBeenCalledTimes(1)
    expect(onToggleMute).not.toHaveBeenCalled()
  })

  test('静音：轻点 → 开启语音（此前点球无任何反应，用户被困在静音里）', () => {
    const onTapTalk = vi.fn()
    const onToggleMute = vi.fn()
    const { container } = render(
      <OrbTopBlock {...baseProps} muted onTapTalk={onTapTalk} onToggleMute={onToggleMute} />,
    )
    const ball = container.querySelector('button.voice-shell-orb-click') as HTMLElement
    tap(ball)
    expect(onToggleMute).toHaveBeenCalledTimes(1)
    expect(onTapTalk).not.toHaveBeenCalled()
  })

  test('按住 ≥220ms → ptt.start（触摸 PTT 入口）', async () => {
    vi.useFakeTimers()
    const start = vi.fn()
    const stop = vi.fn()
    const unregister = registerCommandHost('ptt', { start, stop, active: () => false })
    const { container } = render(<OrbTopBlock {...baseProps} muted={false} />)
    const ball = container.querySelector('button.voice-shell-orb-click') as HTMLElement
    fireEvent.pointerDown(ball, { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' })
    await act(async () => { vi.advanceTimersByTime(260) })
    expect(start).toHaveBeenCalledTimes(1)
    fireEvent.pointerUp(ball, { clientX: 10, clientY: 10, pointerType: 'touch' })
    expect(stop).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    unregister()
  })

  test('按下后移动超过阈值 → 取消按住（让位给卡片拖动，不误开麦）', async () => {
    vi.useFakeTimers()
    const start = vi.fn()
    const unregister = registerCommandHost('ptt', { start, stop: vi.fn(), active: () => false })
    const { container } = render(<OrbTopBlock {...baseProps} muted={false} />)
    const ball = container.querySelector('button.voice-shell-orb-click') as HTMLElement
    fireEvent.pointerDown(ball, { clientX: 10, clientY: 10, button: 0, pointerType: 'mouse' })
    fireEvent.pointerMove(ball, { clientX: 40, clientY: 10, pointerType: 'mouse' })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(start).not.toHaveBeenCalled()
    vi.useRealTimers()
    unregister()
  })

  test('静音态显示可操作提示与「已静音」标签（让静音开关可被发现）', () => {
    const { container } = render(<OrbTopBlock {...baseProps} muted onToggleMute={() => {}} />)
    expect(container.textContent).toContain('点一下球开启')
    expect(container.textContent).toContain('已静音')
  })
})
