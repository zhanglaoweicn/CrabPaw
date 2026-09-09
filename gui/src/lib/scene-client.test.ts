import { shouldConsumeSseScene } from './scene-client'

describe('scene-client SSE 兜底门控（2026-08-25 双通道重排根因修复）', () => {
  it('WS v1 主通道在线 → SSE scene:change 一律忽略（不消费不推进 clientRev）', () => {
    const payload = { rev: 101, ops: [{ op: 'upsert', id: 's1', surface: { id: 's1' } }] }
    expect(shouldConsumeSseScene(payload, { mode: 'v1', wsOpen: true, clientRev: 100 })).toBe(false)
  })

  it('WS 断了 → SSE 兜底消费（fallback 语义保留）', () => {
    const payload = { rev: 101, ops: [] }
    expect(shouldConsumeSseScene(payload, { mode: 'v1', wsOpen: false, clientRev: 100 })).toBe(true)
  })

  it('降级/重放防护：rev ≤ clientRev 的旧事件不再应用', () => {
    const stale = { rev: 100, ops: [] }
    expect(shouldConsumeSseScene(stale, { mode: 'v1', wsOpen: false, clientRev: 100 })).toBe(false)
    const newer = { rev: 101, ops: [] }
    expect(shouldConsumeSseScene(newer, { mode: 'legacy', wsOpen: false, clientRev: 100 })).toBe(true)
  })

  it('空 payload 防御：不消费', () => {
    expect(shouldConsumeSseScene(null, { mode: 'v1', wsOpen: false, clientRev: 0 })).toBe(false)
    expect(shouldConsumeSseScene(undefined, { mode: 'v1', wsOpen: false, clientRev: 0 })).toBe(false)
  })
})
