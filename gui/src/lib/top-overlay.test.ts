/**
 * top-overlay 单元测试（2026-08-12）
 * jest testEnvironment 为 node，无 jsdom → 用假 document 验证 data-top-overlay 计数逻辑。
 */
import { setTopOverlay, clearTopOverlay } from './top-overlay'

describe('top-overlay 计数与 data-top-overlay 同步', () => {
  let dataset: Record<string, string | undefined>

  beforeEach(() => {
    dataset = {}
    ;(global as any).document = { documentElement: { dataset } }
    // 保证模块级 Set 从空开始（前一个用例残留清理见 afterEach）
    clearTopOverlay('weather')
    clearTopOverlay('hotspot')
  })

  afterEach(() => {
    clearTopOverlay('weather')
    clearTopOverlay('hotspot')
  })

  it('单个浮层打开 → data-top-overlay 为该 key', () => {
    setTopOverlay('weather')
    expect(dataset.topOverlay).toBe('weather')
  })

  it('两个浮层同时打开 → multiple；逐个关闭 → 恢复单值/移除', () => {
    setTopOverlay('weather')
    setTopOverlay('hotspot')
    expect(dataset.topOverlay).toBe('multiple')

    clearTopOverlay('weather')
    expect(dataset.topOverlay).toBe('hotspot')

    clearTopOverlay('hotspot')
    expect('topOverlay' in dataset).toBe(false)
  })

  it('重复注册同一 key 幂等（计数不重复累加）', () => {
    setTopOverlay('weather')
    setTopOverlay('weather')
    expect(dataset.topOverlay).toBe('weather')

    clearTopOverlay('weather')
    expect('topOverlay' in dataset).toBe(false)
  })

  it('注销未注册的 key 不影响当前状态', () => {
    setTopOverlay('hotspot')
    clearTopOverlay('weather') // 未注册
    expect(dataset.topOverlay).toBe('hotspot')
  })

  it('document 缺失时抛出被捕获并 console.error（不崩溃）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(global as any).document = undefined
    expect(() => setTopOverlay('weather')).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
