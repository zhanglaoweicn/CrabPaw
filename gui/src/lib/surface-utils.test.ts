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
  DISMISS_STATE_KEY,
  MAX_DISMISSED,
  isCardWallKind,
  loadDismissedKeys,
  saveDismissedKeys,
  fingerprintOf,
  loadDismissStore,
  saveDismissStore,
  isDismissed,
  markDismissed,
  clearDismissed,
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

/**
 * 关闭状态机 v2（2026-09-30）——本组用例直接对应"说关了没关"线上反馈。
 *
 * 缺陷复现（改造前）：关闭记录只按 `id@JSON(data)` 记账，数据一刷新指纹就变，
 * 于是用户明确关掉的卡片在下一次 upsert 时必然复活。天气/股票这类**稳定 id
 * 原地刷新**的卡片因此每轮刷新都弹回来。
 */
describe('surface-utils 关闭状态机 v2（SurfaceId / Revision / Lifecycle 分离）', () => {
  beforeEach(() => {
    const store = makeStorage()
    Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
  })

  test('【核心】用户明确关闭后，同 id 数据刷新不得复活', () => {
    let store = loadDismissStore()
    const v1Card = { id: 'weather-Beijing', data: { temp: 20 }, intent: 'inform' }
    store = markDismissed(store, v1Card, 'permanent')
    expect(isDismissed(store, v1Card)).toBe(true)
    // 定时刷新：同 id、新数据（改造前正是这里复活）
    const v2Card = { id: 'weather-Beijing', data: { temp: 27 }, intent: 'inform' }
    expect(isDismissed(store, v2Card)).toBe(true)
    // 再刷新一次也不能复活（防"抖动着回来"）
    expect(isDismissed(store, { id: 'weather-Beijing', data: { temp: 31 }, intent: 'inform' })).toBe(true)
  })

  test('指纹级过期保持原语义：数据变化即可再现（不扩大关闭范围）', () => {
    let store = loadDismissStore()
    const card = { id: 'doc-123', data: { title: 'a' }, intent: 'inform' }
    store = markDismissed(store, card, 'fingerprint')
    expect(isDismissed(store, card)).toBe(true)
    // 同 id 新内容（新文章）→ 旧指纹不遮蔽
    expect(isDismissed(store, { id: 'doc-123', data: { title: 'b' }, intent: 'inform' })).toBe(false)
  })

  test('唯一例外：confront 风险升级可突破永久关闭（内容变化时）', () => {
    let store = loadDismissStore()
    const calm = { id: 'receivable-panel', data: { overdue: 5 }, intent: 'confront' }
    store = markDismissed(store, calm, 'permanent')
    expect(isDismissed(store, calm)).toBe(true)
    // 同一份内容再推 → 仍关闭（不抖动）
    expect(isDismissed(store, { id: 'receivable-panel', data: { overdue: 5 }, intent: 'confront' })).toBe(true)
    // 风险升级（内容变化）→ 允许重新弹出
    expect(isDismissed(store, { id: 'receivable-panel', data: { overdue: 8 }, intent: 'confront' })).toBe(false)
  })

  test('inform 卡内容变化也不突破永久关闭（例外只给 confront）', () => {
    let store = loadDismissStore()
    store = markDismissed(store, { id: 'stock-panel', data: { p: 1 } }, 'permanent')
    expect(isDismissed(store, { id: 'stock-panel', data: { p: 99 }, intent: 'inform' })).toBe(true)
  })

  test('clearDismissed 撤销两种账（语音"打开X"要走这条路）', () => {
    let store = loadDismissStore()
    const card = { id: 'typhoon-panel', data: { name: 'x' } }
    store = markDismissed(store, card, 'permanent')
    store = markDismissed(store, card, 'fingerprint')
    expect(isDismissed(store, card)).toBe(true)
    store = clearDismissed(store, 'typhoon-panel')
    expect(isDismissed(store, card)).toBe(false)
    expect(isDismissed(store, { id: 'typhoon-panel', data: { name: 'y' } })).toBe(false)
  })

  test('跨"重启"（重新 load）后永久关闭仍生效', () => {
    let store = loadDismissStore()
    store = markDismissed(store, { id: 'weather-Beijing', data: { t: 1 } }, 'permanent')
    saveDismissStore(store)
    const reloaded = loadDismissStore()
    expect(isDismissed(reloaded, { id: 'weather-Beijing', data: { t: 2 } })).toBe(true)
    expect(reloaded.permanent.has('weather-Beijing')).toBe(true)
  })

  test('v1 记录迁移为指纹级（不把历史记录升级成"永久关闭"）', () => {
    // v1 里存的是 id@fingerprint；迁移后必须仍只在同指纹下生效
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify([fingerprintOf('doc-1', { t: 'a' })]))
    const store = loadDismissStore()
    expect(isDismissed(store, { id: 'doc-1', data: { t: 'a' } })).toBe(true)
    expect(isDismissed(store, { id: 'doc-1', data: { t: 'b' } })).toBe(false)
    expect(store.permanent.size).toBe(0)
  })

  test('落盘后清掉 v1 键，避免两套记录长期并存产生判定歧义', () => {
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(['x@y']))
    saveDismissStore(loadDismissStore())
    expect(localStorage.getItem(DISMISS_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(DISMISS_STATE_KEY)).not.toBeNull()
  })

  test('两份账各自截断到 MAX_DISMISSED（防 localStorage 膨胀）', () => {
    let store = loadDismissStore()
    for (let i = 0; i < MAX_DISMISSED + 20; i++) {
      store = markDismissed(store, { id: `perm-${i}`, data: null }, 'permanent')
      store = markDismissed(store, { id: `fp-${i}`, data: i }, 'fingerprint')
    }
    saveDismissStore(store)
    const reloaded = loadDismissStore()
    expect(reloaded.permanent.size).toBe(MAX_DISMISSED)
    expect(reloaded.fingerprint.size).toBe(MAX_DISMISSED)
    // 丢最旧、留最近
    expect(reloaded.permanent.has('perm-0')).toBe(false)
    expect(reloaded.permanent.has(`perm-${MAX_DISMISSED + 19}`)).toBe(true)
  })

  test('v2 记录损坏 → 空状态且不抛（防白屏）', () => {
    localStorage.setItem(DISMISS_STATE_KEY, '{broken')
    const store = loadDismissStore()
    expect(store.permanent.size).toBe(0)
    expect(store.fingerprint.size).toBe(0)
  })

  test('标记关闭不修改入参（setState 需要不可变更新）', () => {
    const store = loadDismissStore()
    const before = store.permanent.size
    const next = markDismissed(store, { id: 'a', data: 1 }, 'permanent')
    expect(store.permanent.size).toBe(before)   // 原状态未被改写
    expect(next.permanent.has('a')).toBe(true)
    expect(next).not.toBe(store)                // 返回新对象
  })
})
