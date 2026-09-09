/**
 * performance-mode 单元测试
 * 覆盖：localStorage 读写、自动检测边界、默认行为
 */

import { getPerformanceMode, setPerformanceMode, STORAGE_KEY } from './performance-mode'

// 每个测试前重置 mock 状态
function resetMocks() {
  // 模拟 localStorage
  const store: Record<string, string> = {}
  ;(global as any).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    get length() { return Object.keys(store).length },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
    key: (index: number) => Object.keys(store)[index] ?? null,
  }
  // 重置自动检测相关全局变量
  ;(global as any).navigator = { hardwareConcurrency: 8 }
  ;(global as any).window = { devicePixelRatio: 1 }
}

describe('performance-mode', () => {
  beforeEach(() => {
    resetMocks()
    // 清空 localStorage 确保每次测试干净
    ;(global as any).localStorage.clear()
  })

  // ═══════════════════════════════════════════════
  // setPerformanceMode
  // ═══════════════════════════════════════════════
  describe('setPerformanceMode', () => {
    test('setPerformanceMode("low") 写入 localStorage', () => {
      setPerformanceMode('low')
      expect((global as any).localStorage.getItem(STORAGE_KEY)).toBe('low')
    })

    test('setPerformanceMode("high") 写入 localStorage', () => {
      setPerformanceMode('high')
      expect((global as any).localStorage.getItem(STORAGE_KEY)).toBe('high')
    })

    test('覆盖已有值', () => {
      setPerformanceMode('low')
      setPerformanceMode('high')
      expect((global as any).localStorage.getItem(STORAGE_KEY)).toBe('high')
    })
  })

  // ═══════════════════════════════════════════════
  // getPerformanceMode — 用户手动设置优先
  // ═══════════════════════════════════════════════
  describe('getPerformanceMode — localStorage 优先', () => {
    test('localStorage 存 low → 返回 low', () => {
      ;(global as any).localStorage.setItem(STORAGE_KEY, 'low')
      // 即使硬件性能高，也以用户设置为准
      ;(global as any).navigator = { hardwareConcurrency: 16 }
      ;(global as any).window = { devicePixelRatio: 1 }
      expect(getPerformanceMode()).toBe('low')
    })

    test('localStorage 存 high → 返回 high', () => {
      ;(global as any).localStorage.setItem(STORAGE_KEY, 'high')
      // 即使硬件性能低，也以用户设置为准
      ;(global as any).navigator = { hardwareConcurrency: 2 }
      expect(getPerformanceMode()).toBe('high')
    })
  })

  // ═══════════════════════════════════════════════
  // 自动检测规则
  // ═══════════════════════════════════════════════
  describe('自动检测规则', () => {
    test('hardwareConcurrency < 4 → low', () => {
      ;(global as any).navigator = { hardwareConcurrency: 2 }
      ;(global as any).window = { devicePixelRatio: 1 }
      expect(getPerformanceMode()).toBe('low')
    })

    test('hardwareConcurrency >= 4 且 dpr <= 1.5 → high', () => {
      ;(global as any).navigator = { hardwareConcurrency: 8 }
      ;(global as any).window = { devicePixelRatio: 1 }
      expect(getPerformanceMode()).toBe('high')
    })

    test('dpr > 1.5 且 hardwareConcurrency < 6 → low（高分屏 + 中低核）', () => {
      ;(global as any).navigator = { hardwareConcurrency: 4 }
      ;(global as any).window = { devicePixelRatio: 2 }
      expect(getPerformanceMode()).toBe('low')
    })

    test('dpr > 1.5 但 hardwareConcurrency >= 6 → high（高分屏 + 充足算力）', () => {
      ;(global as any).navigator = { hardwareConcurrency: 8 }
      ;(global as any).window = { devicePixelRatio: 2 }
      expect(getPerformanceMode()).toBe('high')
    })

    test('边界：hardwareConcurrency = 4, dpr = 1.5 → high（不触发）', () => {
      ;(global as any).navigator = { hardwareConcurrency: 4 }
      ;(global as any).window = { devicePixelRatio: 1.5 }
      expect(getPerformanceMode()).toBe('high')
    })

    test('边界：hardwareConcurrency = 3, dpr = 1 → low（低核）', () => {
      ;(global as any).navigator = { hardwareConcurrency: 3 }
      ;(global as any).window = { devicePixelRatio: 1 }
      expect(getPerformanceMode()).toBe('low')
    })

    test('边界：hardwareConcurrency = 5, dpr = 1.6 → low（dpr > 1.5 + 核 < 6）', () => {
      ;(global as any).navigator = { hardwareConcurrency: 5 }
      ;(global as any).window = { devicePixelRatio: 1.6 }
      expect(getPerformanceMode()).toBe('low')
    })
  })

  // ═══════════════════════════════════════════════
  // 异常处理
  // ═══════════════════════════════════════════════
  describe('异常处理', () => {
    test('localStorage 损坏不抛异常，回退自动检测', () => {
      ;(global as any).localStorage.getItem = () => { throw new Error('quota exceeded') }
      ;(global as any).navigator = { hardwareConcurrency: 8 }
      ;(global as any).window = { devicePixelRatio: 1 }
      expect(getPerformanceMode()).toBe('high')
    })

    test('localStorage setItem 抛异常不中断', () => {
      ;(global as any).localStorage.setItem = () => { throw new Error('quota exceeded') }
      // 不应抛出
      expect(() => setPerformanceMode('low')).not.toThrow()
    })

    test('navigator 不存在（SSR/node）→ 默认 high', () => {
      delete (global as any).navigator
      delete (global as any).window
      expect(getPerformanceMode()).toBe('high')
    })

    test('hardwareConcurrency 为 undefined → 默认 4 不触发 low', () => {
      ;(global as any).navigator = { hardwareConcurrency: undefined }
      ;(global as any).window = { devicePixelRatio: 1 }
      // undefined || 4 = 4，不 < 4，所以 high
      expect(getPerformanceMode()).toBe('high')
    })

    test('devicePixelRatio 为 undefined → 默认 1', () => {
      ;(global as any).navigator = { hardwareConcurrency: 3 }
      ;(global as any).window = { devicePixelRatio: undefined }
      // cores=3 < 4 → low
      expect(getPerformanceMode()).toBe('low')
    })
  })
})
