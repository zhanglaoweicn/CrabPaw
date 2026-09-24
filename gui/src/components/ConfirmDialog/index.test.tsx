/** @jest-environment jsdom */
/**
 * ConfirmDialog — Esc 关闭 / 焦点圈闭 / dialog 语义 / 初始焦点（2026-09-22 可访问性修复）
 *
 * 实机验证代价高（所有触发点都是破坏性的删除/覆盖），故用单测锁定行为。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { ConfirmDialog } from './index'

function setup(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  const view = render(
    <ConfirmDialog
      open
      title="删除确认"
      message="确定要删除这个文件吗？"
      confirmLabel="删除"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...props}
    />,
  )
  return { onCancel, onConfirm, ...view }
}

describe('ConfirmDialog', () => {
  it('open=false 时不渲染任何内容', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="t" message="m" onCancel={() => {}} onConfirm={() => {}} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('提供 dialog 语义（读屏知道弹了个框，且标题被关联）', () => {
    setup()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelId = dialog.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(document.getElementById(labelId as string)?.textContent).toBe('删除确认')
  })

  it('初始焦点落在「取消」——破坏性按钮不该是默认焦点', () => {
    setup()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
  })

  it('Esc 触发取消，且不触发确认', () => {
    const { onCancel, onConfirm } = setup()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Tab 在框内循环：从最后一项回到第一项', () => {
    setup()
    const closeBtn = screen.getByRole('button', { name: '关闭' })
    const confirmBtn = screen.getByRole('button', { name: '删除' })
    // 焦点在最后一项（确认）时按 Tab → 回到框内第一项（关闭），而不是跑出弹框
    confirmBtn.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(closeBtn)
  })

  it('Shift+Tab 反向循环：从第一项回到最后一项', () => {
    setup()
    const closeBtn = screen.getByRole('button', { name: '关闭' })
    const confirmBtn = screen.getByRole('button', { name: '删除' })
    closeBtn.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirmBtn)
  })

  it('点击遮罩取消；点击弹框内部不取消', () => {
    const { onCancel } = setup()
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
