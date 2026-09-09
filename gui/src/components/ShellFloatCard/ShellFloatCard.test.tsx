/**
 * ShellFloatCard — 首页浮动玻璃卡壳 (2026-08-31 M1)
 *   T1 渲染子内容 + 标题栏
 *   T2 拖动更新 localStorage 持久化 (voice-shell.card.<key>)
 *   T3 resetNonce 变更 → 恢复默认偏移并清持久化
 *   T4 交互元素(输入框)按下不启动拖动
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ShellFloatCard } from './index'

describe('ShellFloatCard', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('T1 渲染子内容与标题', () => {
    render(<ShellFloatCard cardKey="test1" title="测试卡">正文</ShellFloatCard>)
    expect(screen.getByText('测试卡')).toBeTruthy()
    expect(screen.getByText('正文')).toBeTruthy()
  })

  it('T2 拖动后位置进入 localStorage', () => {
    const { getByTestId, rerender } = render(
      <ShellFloatCard cardKey="test2" title="卡">
        <div data-testid="body-plain">内容</div>
      </ShellFloatCard>
    )
    const card = getByTestId('shell-float-card')
    // jsdom 无布局——固定尺寸使钳制计算稳定
    Object.defineProperty(card, 'offsetWidth', { value: 300, configurable: true })
    Object.defineProperty(card, 'offsetHeight', { value: 200, configurable: true })
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(card, { clientX: 150, clientY: 130, pointerId: 1 })
    fireEvent.pointerUp(card, { pointerId: 1 })
    const saved = JSON.parse(localStorage.getItem('voice-shell.card.test2') || 'null')
    expect(saved).toEqual({ x: 50, y: 30 })
    // 重挂载后恢复
    rerender(
      <ShellFloatCard cardKey="test2" title="卡">
        <div>内容</div>
      </ShellFloatCard>
    )
    expect(getByTestId('shell-float-card').style.transform).toContain('50px')
  })

  it('T3 resetNonce 恢复默认偏移并清持久化', () => {
    const { getByTestId, rerender } = render(<ShellFloatCard cardKey="test3" title="卡" defaultOffset={{ x: 10, y: 20 }}>x</ShellFloatCard>)
    const card = getByTestId('shell-float-card')
    fireEvent.pointerDown(card, { clientX: 0, clientY: 0, pointerId: 1 })
    fireEvent.pointerMove(card, { clientX: 500, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(card, { pointerId: 1 })
    expect(localStorage.getItem('voice-shell.card.test3')).toBeTruthy()
    rerender(<ShellFloatCard cardKey="test3" title="卡" defaultOffset={{ x: 10, y: 20 }} resetNonce={1}>x</ShellFloatCard>)
    expect(localStorage.getItem('voice-shell.card.test3')).toBeFalsy()
    expect(card.style.transform).toContain('10px')
  })

  it('T4 输入框按下不启动拖动', () => {
    const { getByTestId } = render(
      <ShellFloatCard cardKey="test4" title="卡">
        <input data-testid="ipt" value="" readOnly />
      </ShellFloatCard>
    )
    const ipt = getByTestId('ipt')
    fireEvent.pointerDown(ipt, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(ipt, { clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(ipt, { pointerId: 1 })
    expect(localStorage.getItem('voice-shell.card.test4')).toBeFalsy()
  })

  it('T5 标题栏为拖拽手柄(不再豁免)', () => {
    const { getByText, getByTestId } = render(<ShellFloatCard cardKey="test5" title="手柄">x</ShellFloatCard>)
    const card = getByTestId('shell-float-card')
    Object.defineProperty(card, 'offsetWidth', { value: 300, configurable: true })
    Object.defineProperty(card, 'offsetHeight', { value: 200, configurable: true })
    const title = getByText('手柄')
    fireEvent.pointerDown(title, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(title, { clientX: 50, clientY: 30, pointerId: 1 })
    fireEvent.pointerUp(title, { pointerId: 1 })
    expect(JSON.parse(localStorage.getItem('voice-shell.card.test5') || 'null')).toEqual({ x: 40, y: 20 })
  })

  it('T6 dragOnButtons: 按钮按下移动=拖动, 原地点击=按钮语义', () => {
    const onBtnClick = vi.fn()
    const { getByTestId } = render(
      <ShellFloatCard cardKey="test6" title="卡" dragOnButtons>
        <button data-testid="b" onClick={onBtnClick}>B</button>
      </ShellFloatCard>
    )
    const card = getByTestId('shell-float-card')
    Object.defineProperty(card, 'offsetWidth', { value: 300, configurable: true })
    Object.defineProperty(card, 'offsetHeight', { value: 200, configurable: true })
    const b = getByTestId('b')
    // 原地点击: 按钮语义生效
    fireEvent.pointerDown(b, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerUp(b, { pointerId: 1 })
    fireEvent.click(b)
    expect(onBtnClick).toHaveBeenCalledTimes(1)
    // 移动>3px: 拖动生效且 click 被抑制
    fireEvent.pointerDown(b, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(b, { clientX: 60, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(b, { pointerId: 1 })
    fireEvent.click(b)
    expect(JSON.parse(localStorage.getItem('voice-shell.card.test6') || 'null')).toEqual({ x: 50, y: 30 })
    expect(onBtnClick).toHaveBeenCalledTimes(1)
  })
})
