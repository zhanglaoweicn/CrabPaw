/**
 * FocusRibbon 渲染测试(B3 2026-09-05)——注意带状态词/数据行简语
 */
import { render, screen } from '@testing-library/react'
import { FocusRibbon } from './index'

describe('FocusRibbon 注意带', () => {
  test('acting 态显示工具名与步数', () => {
    render(<FocusRibbon state="acting" toolName="WeatherQuery" toolStep={3} />)
    expect(screen.getByText('正在执行 WeatherQuery · 第 3 步')).toBeTruthy()
    expect(document.querySelector('.focus-ribbon--acting')).toBeTruthy()
  })

  test('acting 首步不显示步数', () => {
    render(<FocusRibbon state="acting" toolName="Read" toolStep={1} />)
    expect(screen.getByText('正在执行 Read')).toBeTruthy()
  })

  test('waiting 态显示待审批数, 多项带计数', () => {
    render(<FocusRibbon state="waiting" pendingApprovals={2} />)
    expect(screen.getByText('等你处理 · 2 项待审批')).toBeTruthy()
    render(<FocusRibbon state="waiting" pendingApprovals={1} />)
    expect(screen.getByText('等你处理 · 待审批')).toBeTruthy()
  })

  test('idle 待命最暗融入背景, aria-live 供读屏', () => {
    render(<FocusRibbon state="idle" />)
    expect(screen.getByText('待命')).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
  })
})
