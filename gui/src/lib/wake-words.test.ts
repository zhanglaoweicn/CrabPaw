import { beforeEach, describe, expect, test, vi } from 'vitest'
import { loadWakeWords, invalidateWakeWords, BUILTIN_WAKE_WORDS } from './wake-words'

// mock api 层（真实 api.ts 含 import.meta.env, 与 FileGenPanel 测试同款拦截）
vi.mock('./api', () => ({ apiGet: vi.fn() }))
import { apiGet } from './api'

type ConfigGetter = () => Promise<any>

function setElectronConfig(getter: ConfigGetter | null) {
  ;(globalThis as any).window = (globalThis as any).window || {}
  ;(globalThis as any).window.electronAPI = getter ? { config: { get: vi.fn(getter) } } : undefined
}

beforeEach(() => {
  invalidateWakeWords()
  vi.clearAllMocks()
})

describe('loadWakeWords', () => {
  test('IPC 优先: agent.name + wakeWord 数组 + 内置词合并去重', async () => {
    setElectronConfig(async () => ({ agent: { name: '小龙女' }, wakeWord: ['小螃蟹', '你好助手'] }))
    const words = await loadWakeWords()
    expect(words).toContain('小龙女')
    expect(words).toContain('你好助手')
    for (const b of BUILTIN_WAKE_WORDS) expect(words).toContain(b)
    // 去重
    expect(words.filter(w => w === '小龙女').length).toBe(1)
  })

  test('IPC 不可用降级 HTTP /config', async () => {
    setElectronConfig(null)
    vi.mocked(apiGet).mockResolvedValue({ success: true, data: { agent: { name: '贾维斯' } } })
    const words = await loadWakeWords()
    expect(words).toContain('贾维斯')
    expect(apiGet).toHaveBeenCalledWith('/config')
  })

  test('配置全缺失时返回内置词兜底', async () => {
    setElectronConfig(async () => ({}))
    const words = await loadWakeWords()
    expect(words.length).toBeGreaterThan(0)
    for (const b of BUILTIN_WAKE_WORDS) expect(words).toContain(b)
  })

  test('缓存生效: 二次调用不重复读配置', async () => {
    setElectronConfig(async () => ({ agent: { name: '小龙女' } }))
    await loadWakeWords()
    await loadWakeWords()
    // IPC getter 只被调一次（mock 计数经 electronAPI 包装验证）
    const getter = (globalThis as any).window.electronAPI.config.get
    expect(getter).toHaveBeenCalledTimes(1)
  })

  test('invalidateWakeWords 后重新加载', async () => {
    let name = '旧名'
    setElectronConfig(async () => ({ agent: { name } }))
    expect(await loadWakeWords()).toContain('旧名')
    invalidateWakeWords()
    name = '新名'
    expect(await loadWakeWords()).toContain('新名')
  })
})
