import { PANEL_REGISTRY } from './ui-panels.generated'
import { KIND_REGISTRY, getPanelKeyBySurface } from '../kinds'

describe('ui-panels.generated（Phase 3c 面板清单生成产物）', () => {
  it('14 个内置+产品+业务卡面板注册齐全（与后端 panel-registry 同步）', () => {
    const keys = Object.keys(PANEL_REGISTRY).sort()
    expect(keys).toEqual(['approvals', 'businessBriefing', 'businessReport', 'commodity', 'contractExpiry', 'customerView', 'filegen', 'hotspot', 'knowledge', 'meeting', 'music', 'receivable', 'schedule', 'stock', 'stockAlert', 'supplierProfile', 'typhoon', 'weather'])
  })

  it('stock/weather 卡片带数据源声明', () => {
    expect(PANEL_REGISTRY.stock).toMatchObject({ surface: 'stock-panel', ui: 'StockPanel', dataSource: 'stock' })
    expect(PANEL_REGISTRY.weather.dataSource).toBe('weather')
  })

  it('surface↔key 映射防回归（老五处硬编码断链病）', () => {
    expect(PANEL_REGISTRY.filegen.surface).toBe('file-panel')
    expect(PANEL_REGISTRY.meeting.surface).toBe('meeting-panel')
    expect(PANEL_REGISTRY.schedule.surface).toBe('schedule-panel')
  })
})

// B1-3: 面板注册表每条必须能解析到 SceneShell 的组件映射——新面板后端注册后
// 生成物先于接线出现, 此门禁保证「接线缺失」在测试层就爆炸而非运行时静默。
describe('B1-3: PANEL_REGISTRY 面板键消费门禁（SceneShell 接线）', () => {
  it('PANEL_REGISTRY 每个键必须在 KIND_REGISTRY 有渲染配置', () => {
    const panelKeys = Object.keys(PANEL_REGISTRY)
    const missing = panelKeys.filter(k => !KIND_REGISTRY[k])
    expect(missing).toEqual([])
  })

  it('getPanelKeyBySurface 按 surface id 反查面板键', () => {
    expect(getPanelKeyBySurface('music-player')).toBe('music')
    expect(getPanelKeyBySurface('file-panel')).toBe('filegen')
    expect(getPanelKeyBySurface('stock-panel')).toBe('stock')
    expect(getPanelKeyBySurface('business-panel')).toBe('businessReport')
    expect(getPanelKeyBySurface('no-such-surface')).toBeNull()
  })
})
