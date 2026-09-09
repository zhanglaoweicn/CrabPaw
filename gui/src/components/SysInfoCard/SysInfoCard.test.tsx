/**
 * SysInfoCard — 系统信息卡（心跳卡下方，默认缩起）
 *   T1 默认缩起: 显示"系统信息"标题 + 展开按钮 + 数量摘要
 *   T2 展开后出现 事件日志/工具执行 页签 + 日志列表
 *   T3 收起/展开状态持久化 (localStorage voice-shell.sysinfo.collapsed)
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SysInfoCard } from './index'

const logs = [
  { id: '1', type: 'user', text: '你好', time: '12:00:01', seq: 1 },
  { id: '2', type: 'tool', text: '搜索', time: '12:00:02', seq: 2, desc: 'StockQuery', ok: true },
]
const toolRuns: any[] = [
  { toolId: 't1', toolName: 'StockQuery', status: 'done', summary: '查询成功' },
  { toolId: 't2', toolName: 'BilibiliSearch', status: 'running', summary: '搜索中' },
]

describe('SysInfoCard', () => {
  beforeEach(() => localStorage.clear())

  it('T1 默认缩起: 标题+展开+摘要', () => {
    render(<SysInfoCard logs={logs} toolRuns={toolRuns} activeToolCount={1} />)
    // 2026-09-03: 标题已从"系统信息"改版为"日志"(近期提交)
    expect(screen.getAllByText(/日志/).length).toBeGreaterThan(0)
    expect(screen.getByText(/展开/)).toBeTruthy()
    expect(screen.getByText(/2 条日志/)).toBeTruthy()
    expect(screen.getByText(/2 次工具/)).toBeTruthy()
  })

  // 2026-09-03 方案A改版: 回合摘要 + 工具合并 + 内部 ID 隐藏
  it('T4 方案A: 工具调用/完成合并为一行, 内部 roundId 不展示', () => {
    const noisy: any[] = [
      { id: 'a', type: 'user', text: '查台风', time: '12:00:01', seq: 1 },
      { id: 'b', type: 'tool', text: '工具调用 · ShowTyphoon', time: '12:00:02', seq: 2 },
      { id: 'c', type: 'tool', text: '工具完成 · ShowTyphoon', time: '12:00:03', seq: 3, ok: true },
      { id: 'd', type: 'complete', text: '回复完成 · round-1788426267-abcd', time: '12:00:04', seq: 4 },
    ]
    render(<SysInfoCard logs={noisy} />)
    fireEvent.click(screen.getByText(/展开/))
    // 合并后 ShowTyphoon 只出现一次(不再是 调用/完成 两行)
    expect(screen.getAllByText(/ShowTyphoon/).length).toBe(1)
    // 内部 roundId 不出现; 完成行语义化(去掉 round 尾巴)
    expect(screen.queryByText(/round-1788/)).toBeNull()
    expect(screen.getByText(/回复完成/)).toBeTruthy()
  })

  it('T2 展开后页签与日志列表', () => {
    render(<SysInfoCard logs={logs} toolRuns={toolRuns} activeToolCount={1} />)
    fireEvent.click(screen.getByText(/展开/))
    expect(screen.getByText('事件日志')).toBeTruthy()
    expect(screen.getByText(/你好/)).toBeTruthy()
    fireEvent.click(screen.getByText(/工具执行/))
    expect(screen.getByText(/StockQuery/)).toBeTruthy()
  })

  it('T3 收起状态持久化', () => {
    const { rerender } = render(<SysInfoCard logs={logs} toolRuns={toolRuns} activeToolCount={1} />)
    fireEvent.click(screen.getByText(/展开/))
    expect(localStorage.getItem('voice-shell.sysinfo.collapsed')).toBe('0')
    rerender(<SysInfoCard logs={logs} toolRuns={toolRuns} activeToolCount={1} />)
    expect(screen.getByText('事件日志')).toBeTruthy()
  })

  // 2026-09-07 回归: 此前 ShellFloatCard resetNonce 写死 0——"恢复默认布局"对
  // 心跳/对话/语音球生效唯独日志卡拖后无法复位。透传 prop 后必须与基座同语义。
  it('T5 resetNonce 透传: 拖动落盘后变更 nonce → 清持久化回默认偏移', () => {
    const { getByTestId, rerender } = render(<SysInfoCard logs={logs} />)
    const card = getByTestId('shell-float-card')
    Object.defineProperty(card, 'offsetWidth', { value: 264, configurable: true })
    Object.defineProperty(card, 'offsetHeight', { value: 200, configurable: true })
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(card, { clientX: 130, clientY: 120, pointerId: 1 })
    fireEvent.pointerUp(card, { pointerId: 1 })
    expect(JSON.parse(localStorage.getItem('voice-shell.card.sysinfo') || 'null')).toEqual({ x: 30, y: 20 })
    rerender(<SysInfoCard logs={logs} resetNonce={1} />)
    expect(localStorage.getItem('voice-shell.card.sysinfo')).toBeFalsy()
    expect(card.style.transform).toContain('24px') // defaultOffset.x = 24
  })
})
