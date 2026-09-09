import { describe, expect, it, vi } from 'vitest'
import { COCKPIT_SEARCH_SECTIONS, buildCockpitSearchIndex } from './cockpit-navigation'

// 动态 import('./api') 在 vitest 模块注册表内同样被 mock 接管
vi.mock('./api', () => ({ apiGet: vi.fn() }))

describe('COCKPIT_SEARCH_SECTIONS', () => {
  it('覆盖 5 个常用目标', () => {
    const labels = COCKPIT_SEARCH_SECTIONS.map(s => s.label)
    expect(labels).toEqual(expect.arrayContaining(['模型配置', '安全配置', '消息通道', '语音设置', '数据备份']))
  })
})

describe('buildCockpitSearchIndex', () => {
  it('单组失败静默跳过: 动态组全挂时设置小节仍完整在场', async () => {
    const { apiGet } = await import('./api')
    ;(apiGet as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const items = await buildCockpitSearchIndex()
    expect(items.length).toBe(COCKPIT_SEARCH_SECTIONS.length)
    expect(items.map(i => i.id)).toEqual(expect.arrayContaining(['section-model', 'section-security']))
    expect(items.every(i => i.hint === '设置')).toBe(true)
  }, 15000)
})
