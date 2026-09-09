import { getTtsState, subscribeTtsState, setTtsActive, setTtsAudioElement, setTtsDucked } from './tts-state'

describe('tts-state 单一写入模块', () => {
  beforeEach(() => { setTtsActive('__test__', false) })

  it('setTtsActive 切换 owner', () => {
    expect(setTtsActive('stts', true)).toBe(true)
    expect(getTtsState().active).toBe(true)
    expect(getTtsState().owner).toBe('stts')
    expect(setTtsActive('stts', false)).toBe(true)
    expect(getTtsState().active).toBe(false)
  })
  it('owner 守卫：非 owner 不能清除他人状态', () => {
    setTtsActive('stts', true)
    expect(setTtsActive('speech-queue', false)).toBe(false) // 拒绝清除
    expect(getTtsState().active).toBe(true)
    expect(setTtsActive('stts', false)).toBe(true)
  })
  it('订阅通知触发', () => {
    const seen: Array<{ active: boolean }> = []
    const unsub = subscribeTtsState((s) => seen.push({ active: s.active }))
    setTtsActive('stts', true)
    unsub()
    setTtsAudioElement(null as unknown as HTMLAudioElement)
    expect(seen.length).toBe(1)
    expect(seen[0].active).toBe(true)
  })
  it('字段写入', () => {
    setTtsDucked(true)
    expect(getTtsState().ducked).toBe(true)
  })
})
