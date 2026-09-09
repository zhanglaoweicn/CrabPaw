/**
 * surface-utils 单测 — 弹卡治理轮（2026-08-20）
 *
 * 锁定三条防线:
 *   1. isCardWallKind: text/info 纯文本 kind 不进对话窗口卡片墙
 *   2. load/saveDismissedKeys: dismiss 记录持久化跨重启保留
 *   3. MAX_DISMISSED 截断防 localStorage 膨胀
 */
import {
  CARD_WALL_PLAIN_TEXT_KINDS,
  DISMISS_STORAGE_KEY,
  MAX_DISMISSED,
  isCardWallKind,
  loadDismissedKeys,
  saveDismissedKeys,
} from './surface-utils'

/** localStorage 内存实现 */
function makeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
    _map: m,
  }
}

describe('surface-utils 弹卡治理', () => {
  beforeEach(() => {
    const store = makeStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
  })

  // ── 防线 2: 卡片墙 kind 过滤 ──

  test('text/info 纯文本 kind 不进卡片墙,其余 kind 放行', () => {
    for (const kind of CARD_WALL_PLAIN_TEXT_KINDS) {
      expect(isCardWallKind(kind)).toBe(false)
    }
    // 功能性/意图化卡片全部放行
    for (const kind of ['document', 'web-preview', 'contract', 'hotspot', 'stocks', 'chart', 'choice', 'form', 'weather', 'music', 'typhoon', 'metric', 'video']) {
      expect(isCardWallKind(kind)).toBe(true)
    }
  })

  test('kind 缺失/空串 → 不进卡片墙（防未定义 kind 的裸 surface 弹卡）', () => {
    expect(isCardWallKind(undefined)).toBe(false)
    expect(isCardWallKind('')).toBe(false)
  })

  // ── 防线 3: dismiss 持久化 ──

  test('save 后 load 还原（模拟重启: 同数据卡保持关闭）', () => {
    saveDismissedKeys(new Set(['doc-1@{"title":"a"}', 'doc-2@{"title":"b"}']))
    const restored = loadDismissedKeys()
    expect(restored.has('doc-1@{"title":"a"}')).toBe(true)
    expect(restored.has('doc-2@{"title":"b"}')).toBe(true)
    expect(restored.size).toBe(2)
  })

  test('空存储 → 空集', () => {
    expect(loadDismissedKeys().size).toBe(0)
  })

  test('损坏 JSON → 空集且不抛（防白屏）', () => {
    localStorage.setItem(DISMISS_STORAGE_KEY, '{broken json')
    expect(loadDismissedKeys().size).toBe(0)
  })

  test('MAX_DISMISSED 截断: 超出丢最旧,保留最近 300 条', () => {
    const keys = new Set(Array.from({ length: MAX_DISMISSED + 50 }, (_, i) => `doc-${i}@x`))
    saveDismissedKeys(keys)
    const restored = loadDismissedKeys()
    expect(restored.size).toBe(MAX_DISMISSED)
    // 丢最旧 50 条: doc-0..doc-49 消失, doc-50 起保留
    expect(restored.has('doc-0@x')).toBe(false)
    expect(restored.has(`doc-${MAX_DISMISSED - 1}@x`)).toBe(true)
  })

  test('setItem 抛错(配额满) → 不抛,仅告警', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
    Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true })
    expect(() => saveDismissedKeys(new Set(['a@b']))).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
