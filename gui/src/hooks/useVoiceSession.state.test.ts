import { VOICE_STATE_TRANSITIONS, isLegalTransition, type VoiceSessionState } from '../lib/voice-state'

describe('VOICE_STATE_TRANSITIONS (P4 状态转换表)', () => {
  const ALL_STATES: VoiceSessionState[] = [
    'idle', 'listening', 'recognizing', 'processing', 'speaking', 'error', 'wake_listening', 'media_paused',
  ]

  test('每个状态都有出边(不死锁)', () => {
    for (const s of ALL_STATES) {
      expect(VOICE_STATE_TRANSITIONS[s]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('转换目标是已定义状态(无悬空引用)', () => {
    for (const s of ALL_STATES) {
      for (const t of VOICE_STATE_TRANSITIONS[s] || []) {
        expect(ALL_STATES).toContain(t)
      }
    }
  })

  test('核心环闭合:idle→listening→recognizing→listening→idle 可达', () => {
    expect(VOICE_STATE_TRANSITIONS.idle).toContain('listening')
    expect(VOICE_STATE_TRANSITIONS.listening).toContain('recognizing')
    expect(VOICE_STATE_TRANSITIONS.recognizing).toContain('listening')
    expect(VOICE_STATE_TRANSITIONS.recognizing).toContain('idle')
  })

  test('error 可恢复(不永久卡死)', () => {
    expect(VOICE_STATE_TRANSITIONS.error).toContain('idle')
    expect(VOICE_STATE_TRANSITIONS.error).toContain('listening')
  })

  test('isLegalTransition 判定', () => {
    expect(isLegalTransition('idle', 'listening')).toBe(true)
    expect(isLegalTransition('listening', 'recognizing')).toBe(true)
    expect(isLegalTransition('error', 'idle')).toBe(true)
    expect(isLegalTransition('speaking', 'processing')).toBe(false) // 非法:说话中不应切处理
    expect(isLegalTransition('idle', 'idle')).toBe(true)            // 同态恒合法
  })
})
