/**
 * PluginManagerPanel — 面板清单开关冒烟（2026-08-27 面板禁用开关 P2）
 * mock api 层：/api/plugins/assembly + /api/plugin-manager/list + /api/panels/state。
 * 断言全量 10 面板行（含停用面 weather）、状态徽章与开关乐观更新交互。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import PluginManagerPanel from './PluginManagerPanel'
import { apiPost } from '../../lib/api'

// 与后端 DEFAULT_PANELS 一致的 10 个面板（weather 停用态——读取面过滤后仍须出现在清单）
const PANELS = [
  { key: 'music', surface: 'music-player', ui: 'FloatingMusicPlayer', enabled: true },
  { key: 'hotspot', surface: 'hotspot-panel', ui: 'HotspotPanel', enabled: true },
  { key: 'weather', surface: 'weather-panel', ui: 'WeatherPanel', enabled: false },
  { key: 'stock', surface: 'stock-panel', ui: 'StockPanel', enabled: true },
  { key: 'filegen', surface: 'file-panel', ui: 'FileGenPanel', enabled: true },
  { key: 'meeting', surface: 'meeting-panel', ui: 'MeetingPanel', enabled: true },
  { key: 'schedule', surface: 'schedule-panel', ui: 'SchedulePanel', enabled: true },
  { key: 'knowledge', surface: 'kb-panel', ui: 'KnowledgePanel', enabled: true },
  { key: 'commodity', surface: 'commodity-panel', ui: 'CommodityPanel', enabled: true },
  { key: 'businessReport', surface: 'business-panel', ui: 'BusinessReportPanel', enabled: true },
]

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(async (p: string) => {
    if (p === '/api/plugins/assembly') return {
      success: true,
      assembly: { loaded: 8, known: 8, disabled: [], loadedList: [] },
      tree: { summary: null, ok: null },
      panels: [],
      sources: [],
      providers: { llm: [], tts: [], docEngine: [] },
    }
    if (p === '/api/plugin-manager/list') return { success: true, data: { plugins: [] } }
    if (p === '/api/panels/state') return { success: true, data: { panels: PANELS } }
    return { success: true, data: null }
  }),
  apiPost: vi.fn(async () => ({ success: true })),
}))

describe('PluginManagerPanel 面板清单', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('渲染全量 10 面板行（含停用面）+ 状态徽章 + 开关', async () => {
    render(<PluginManagerPanel />)
    await waitFor(() => expect(screen.getByText('stock')).toBeTruthy())
    for (const p of PANELS) expect(screen.getByText(p.key)).toBeTruthy()   // 停用面也列出
    expect(screen.getByText(/9 启用 \/ 10 已知/)).toBeTruthy()            // 清单计数
    expect(screen.getAllByRole('switch').length).toBe(10)                 // 每行一个开关
    expect(screen.getAllByText('停用').length).toBeGreaterThanOrEqual(1)  // weather 停用徽章
    expect(screen.getAllByText('启用').length).toBeGreaterThanOrEqual(9)  // 其余启用徽章
  })

  it('点击开关乐观更新并 POST /api/panels/state', async () => {
    render(<PluginManagerPanel />)
    await waitFor(() => expect(screen.getByText('stock')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: '切换面板 stock' }))
    await waitFor(() => expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/api/panels/state', { key: 'stock', enabled: false }))
    // 乐观更新: stock 行徽章已翻转为停用（无需刷新）
    await waitFor(() => expect(screen.getAllByText('停用').length).toBeGreaterThanOrEqual(2))
  })
})
