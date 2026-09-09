import { isDevMode, setDevMode } from './dev-mode'

// node jest 环境无 localStorage（gui/jest.config.js testEnvironment: 'node'）——
// 注入最小内存 polyfill，使 dev-mode 测试与环境无关
const _storage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => _storage.get(k) ?? null,
  setItem: (k: string, v: string) => { _storage.set(k, String(v)) },
  removeItem: (k: string) => { _storage.delete(k) },
}

describe('dev-mode（阶段 B 开发者模式开关）', () => {
  beforeEach(() => {
    try { localStorage.removeItem('crabpaw_dev_mode') } catch (e) {
      /* localStorage 不可用时忽略 */
      console.warn('[dev-mode.test.ts] 空 catch 补日志:', e instanceof Error ? e.message : e);
    }

  })
  test('默认关闭', () => {
    expect(isDevMode()).toBe(false)
  })
  test('开启后为 true', () => {
    setDevMode(true)
    expect(isDevMode()).toBe(true)
  })
  test('关闭后为 false', () => {
    setDevMode(true)
    setDevMode(false)
    expect(isDevMode()).toBe(false)
  })
})
