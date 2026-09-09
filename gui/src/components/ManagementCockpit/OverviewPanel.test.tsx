/**
 * OverviewPanel — 总览主屏渲染冒烟（2026-08-27 管理舱全轮 A3）
 * mock api 层；断言六张健康卡核心数值/激活专家/今日成本/MCP 区块渲染。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { apiGet } from '../../lib/api'
import OverviewPanel from './OverviewPanel'

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(async () => ({ success: true, data: {
    plugins: { loaded: 6, known: 8, disabled: [], panels: 10, dataSources: 5 },
    usage: { todayCostCny: 12.3, monthCostCny: 45.6, totalRequests: 1730, totalCostCny: 56.7 },
    skills: { total: 2, active: 1, disabled: 1, totalMerged: 0 },
    experts: { total: 2, activeName: '专家甲' },
    mcp: { total: 3, connected: 2, error: 1 },
    backend: { pid: 1, nodeVersion: 'v22', uptime: 100, memHeapMb: 50 },
    sources: {},
  } })),
}))

describe('OverviewPanel', () => {
  it('渲染六张健康卡与告警', async () => {
    render(<OverviewPanel onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('插件')).toBeTruthy())
    expect(screen.getByText(/\d+ \/ 8/)).toBeTruthy()   // loaded/known
    expect(screen.getByText(/专家甲/)).toBeTruthy()      // 激活专家
    expect(screen.getByText(/¥12.30/)).toBeTruthy()      // 今日成本
    expect(screen.getAllByText(/MCP/i).length).toBeGreaterThan(0)
  })

  it('单源降级（plugins=null）时插件卡显示「降级」而非「正常」徽章', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({
      success: true,
      data: {
        plugins: null,
        usage: { todayCostCny: 12.3, monthCostCny: 45.6, totalRequests: 1730, totalCostCny: 56.7 },
        skills: { total: 2, active: 1, disabled: 1, totalMerged: 0 },
        experts: { total: 2, activeName: '专家甲' },
        mcp: { total: 3, connected: 2, error: 1 },
        backend: { pid: 1, nodeVersion: 'v22', uptime: 100, memHeapMb: 50 },
        sources: {},
      },
    })
    render(<OverviewPanel onNavigate={() => {}} />)
    await waitFor(() => expect(screen.getByText('降级')).toBeTruthy())
    const pluginCard = screen.getByText('插件').closest('button')
    expect(pluginCard).not.toBeNull()
    expect(within(pluginCard as HTMLElement).queryByText('正常')).toBeNull()
  })

  it('MCP 告警条存在且点击后 onNavigate 收到 mcp', async () => {
    const handled: string[] = []
    render(<OverviewPanel onNavigate={(t) => handled.push(t)} />)
    await waitFor(() => expect(screen.getByText(/1 个 MCP 服务报错/)).toBeTruthy())
    fireEvent.click(screen.getByText(/1 个 MCP 服务报错/))
    expect(handled).toEqual(['mcp'])
  })

  it('快捷操作含「消息通道」，点击后直达 settings 的 channel 分区', async () => {
    const nav: Array<[string, string | null | undefined]> = []
    render(<OverviewPanel onNavigate={(t, s) => nav.push([t, s])} />)
    await waitFor(() => expect(screen.getByText('插件')).toBeTruthy())
    fireEvent.click(screen.getByText('消息通道'))
    expect(nav).toEqual([['settings', 'channel']])
  })
})
