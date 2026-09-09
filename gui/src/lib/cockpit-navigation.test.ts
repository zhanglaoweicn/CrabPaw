import { describe, expect, it } from 'vitest'
import { COCKPIT_TAB_MAP, COCKPIT_TARGET_MAP, resolveCockpitTab } from './cockpit-navigation'

describe('cockpit tab 导航映射（2026-08-21 审计 P0-1）', () => {
  it('mcp 键直达 mcp tab（2026-08-21 MCP 提升「连接」）', () => {
    expect(resolveCockpitTab('mcp')).toBe('mcp')
    expect(resolveCockpitTab('mcp', COCKPIT_TARGET_MAP)).toBe('mcp')
  })

  it('单数 expert 键直达 expert tab（错位修复）', () => {
    expect(resolveCockpitTab('expert')).toBe('expert')
    expect(resolveCockpitTab('expert', COCKPIT_TARGET_MAP)).toBe('expert')
  })

  it('旧复数键 experts 兼容兜底', () => {
    expect(COCKPIT_TAB_MAP['experts']).toBe('expert')
  })

  it('数据 tab 删除后：data/business 键不再映射（2026-08-21）', () => {
    expect(COCKPIT_TAB_MAP['data']).toBeUndefined()
    expect(COCKPIT_TAB_MAP['business']).toBeUndefined()
    expect(resolveCockpitTab('data')).toBe('settings')
  })

  it('未知键回落 settings（不静默丢到别处）', () => {
    expect(resolveCockpitTab('whatever')).toBe('settings')
  })

  it('TARGET_MAP 覆盖 debug 直达（logs/status/gateway/memory）', () => {
    for (const t of ['logs', 'status', 'gateway', 'memory']) {
      expect(resolveCockpitTab(t, COCKPIT_TARGET_MAP)).toBe('debug')
    }
  })

  it('TAB_MAP 不含 debug 键（open-cockpit 路径原行为）', () => {
    expect(COCKPIT_TAB_MAP['logs']).toBeUndefined()
  })
})
