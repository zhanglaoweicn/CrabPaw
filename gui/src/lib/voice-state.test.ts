import { VoiceStateMachine, isLegalTransition, type VoiceSessionState } from './voice-state'

describe('VoiceStateMachine', () => {
  it('合法转换生效', () => {
    const m = new VoiceStateMachine('idle')
    expect(m.setState('listening')).toBe(true)
    expect(m.current).toBe('listening')
  })
  it('同状态转换是 no-op 返回 true', () => {
    const m = new VoiceStateMachine('idle')
    expect(m.setState('idle')).toBe(true)
  })
  it('strict 模式非法转换抛错', () => {
    const m = new VoiceStateMachine('idle', { strict: true })
    // 注意: wake_listening 是 idle 的合法出边(真实转换表),取 idle→media_paused(表外)为非法示例
    expect(() => m.setState('media_paused' as VoiceSessionState)).toThrow()
    expect(() => m.setState('idle')).not.toThrow() // 非法失败后状态不变
  })
  it('非 strict 模式非法转换返回 false 并停留原状态', () => {
    const m = new VoiceStateMachine('idle', { strict: false })
    const orig = console.error
    console.error = () => {}
    try {
      expect(m.setState('media_paused' as VoiceSessionState)).toBe(false)
      expect(m.current).toBe('idle')
    } finally { console.error = orig }
  })
  it('force 可绕过守卫', () => {
    const m = new VoiceStateMachine('idle', { strict: true })
    expect(m.setState('speaking', { force: true })).toBe(true)
    expect(m.current).toBe('speaking')
  })
  it('speaking→media_paused 合法(S8 媒体挂起: suspendShared 先置 speaking 再置 media_paused)', () => {
    const m = new VoiceStateMachine('speaking', { strict: true })
    expect(m.setState('media_paused')).toBe(true)
    expect(m.current).toBe('media_paused')
  })
  it('speaking→wake_listening 非法转换仍被拦(负例)', () => {
    const m = new VoiceStateMachine('speaking', { strict: true })
    expect(() => m.setState('wake_listening')).toThrow()
    expect(m.current).toBe('speaking')
  })
})

describe('isLegalTransition 回归', () => {
  it('idle→speaking 良性时序仍合法', () => {
    expect(isLegalTransition('idle', 'speaking')).toBe(true)
  })
  it('speaking→media_paused 合法(S8 媒体挂起补边)', () => {
    expect(isLegalTransition('speaking', 'media_paused')).toBe(true)
  })
  it('media_paused→idle 恢复路径合法(resumeAfterMedia)', () => {
    expect(isLegalTransition('media_paused', 'idle')).toBe(true)
  })
})
