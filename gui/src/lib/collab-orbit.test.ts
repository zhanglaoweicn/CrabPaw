import { computeOrbitLayout, orbitReducer, ORB_FLOAT_DOM_ID, selectActiveCount, toReviewData, type OrbitState } from './collab-orbit'

const base: OrbitState = { agents: [] }

describe('orbitReducer (P4 协作轨道)', () => {
  it('start → running 卫星卡', () => {
    const s = orbitReducer(base, { type: 'subagent:start', archetype: 'researcher', task: '调研', ts: 1000 })
    expect(s.agents).toHaveLength(1)
    expect(s.agents[0]).toMatchObject({ archetype: 'researcher', task: '调研', status: 'running' })
  })

  it('end → done 点亮（成功）', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'critic', task: '评审', ts: 1000 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'critic', success: true, duration: 2500, ts: 2000 })
    expect(s.agents[0].status).toBe('done')
    expect(s.agents[0].success).toBe(true)
    expect(s.agents[0].duration).toBe(2500)
  })

  it('同 archetype 并发——end 闭合最近启动的 running（LIFO）', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'researcher', task: 'A', ts: 1 })
    s = orbitReducer(s, { type: 'subagent:start', archetype: 'researcher', task: 'B', ts: 2 })
    expect(s.agents).toHaveLength(2)
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'researcher', success: true, duration: 1, ts: 3 })
    // LIFO: end 闭合最近启动的 running（最后一个匹配的），即 task B
    expect(s.agents[0].status).toBe('running')
    expect(s.agents[1].status).toBe('done')
  })

  it('end success:false → status error', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'writer', task: 'W', ts: 1 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'writer', success: false, duration: 500, ts: 2 })
    expect(s.agents[0].status).toBe('error')
    expect(s.agents[0].success).toBe(false)
  })

  it('end 无对应 start → 忽略（防噪声）', () => {
    const s = orbitReducer(base, { type: 'subagent:end', archetype: 'ghost', success: true, duration: 1, ts: 1 })
    expect(s.agents).toHaveLength(0)
  })

  it('selectActiveCount 只计 running', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'planner', task: 'P', ts: 1 })
    s = orbitReducer(s, { type: 'subagent:start', archetype: 'writer', task: 'W', ts: 2 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'planner', success: true, duration: 1, ts: 3 })
    expect(selectActiveCount(s)).toBe(1)
  })

  it('toReviewData: 全部完成 → 投票卡数据（结论合成区占位）', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'researcher', task: 'A', ts: 1 })
    s = orbitReducer(s, { type: 'subagent:start', archetype: 'critic', task: 'B', ts: 2 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'researcher', success: true, duration: 800, ts: 3 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'critic', success: true, duration: 1200, ts: 4 })
    const data = toReviewData(s, '结论：可执行')
    expect(data).not.toBeNull()
    expect(data!.agents).toHaveLength(2)
    expect(data!.agents[0]).toMatchObject({ name: 'researcher', status: 'done' })
    expect(data!.conclusion).toBe('结论：可执行')
  })

  it('toReviewData: 仍有 running → null（不提前合成）', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'planner', task: 'P', ts: 1 })
    expect(toReviewData(s)).toBeNull()
  })

  it('toReviewData: 同 archetype 并行完成 → 每行携带唯一 id（ExpertReviewCard key 消重）', () => {
    let s = orbitReducer(base, { type: 'subagent:start', archetype: 'researcher', task: 'A', ts: 1 })
    s = orbitReducer(s, { type: 'subagent:start', archetype: 'researcher', task: 'B', ts: 2 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'researcher', success: true, duration: 800, ts: 3 })
    s = orbitReducer(s, { type: 'subagent:end', archetype: 'researcher', success: true, duration: 1200, ts: 4 })
    const data = toReviewData(s)!
    expect(data.agents).toHaveLength(2)
    // 同名专家并行：两行 name 相同，id 必须互异（否则 key={a.name} React 冲突）
    expect(data.agents[0].name).toBe('researcher')
    expect(data.agents[1].name).toBe('researcher')
    const ids = data.agents.map(a => a.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('computeOrbitLayout (2026-09-05 成员卡跟随语音球浮卡)', () => {
  const H = 900
  const orb = { left: 419, top: 110, width: 442, height: 300, bottom: 410 }

  test('球卡不在 → 回退左栏固定槽(bottom 340)', () => {
    const l = computeOrbitLayout(null, H, 3)
    expect(l.left).toBe(24)
    expect(l.bottom).toBe(340)
    expect(l.columnDown).toBe(false)
  })

  test('球下空间充足 → 停在球正下方居中, 自上而下堆', () => {
    const l = computeOrbitLayout(orb, H, 3)
    expect(l.left).toBe(orb.left + orb.width / 2)
    expect(l.top).toBe(orb.bottom + 12)
    expect(l.transform).toBe('translateX(-50%)')
    expect(l.columnDown).toBe(true)
    expect(l.maxHeight).toBeGreaterThan(0)
  })

  test('球贴近视口底部(下方无空间) → 改到球上方, 自下而上堆', () => {
    const lowOrb = { left: 419, top: 700, width: 442, height: 160, bottom: 860 }
    const l = computeOrbitLayout(lowOrb, H, 3)
    expect(l.top).toBe(lowOrb.top - 12)
    expect(l.transform).toBe('translate(-50%, -100%)')
    expect(l.columnDown).toBe(false)
    expect(l.maxHeight).toBeGreaterThan(0)
  })

  test('ORB_FLOAT_DOM_ID 导出(ShellFloatCard domId 与 CollabOrbit 量取共用单一来源)', () => {
    expect(ORB_FLOAT_DOM_ID).toBe('voice-orb-float')
  })
})
