/**
 * voice-auto-send 门控纯函数测试(GUI 全量修复 P2)
 *
 * P0 回归锚点: 唤醒词模式下唤醒会话窗口内必须放行自动发送
 * (旧实现 getAutoSend=effectiveContinuous 恒 false → 唤醒后说话永不发送)。
 */
import { isWakeActive, shouldAutoSend } from './voice-auto-send'

describe('isWakeActive', () => {
  test('sleeping/dismissing 之外均为唤醒活跃期', () => {
    expect(isWakeActive('sleeping')).toBe(false)
    expect(isWakeActive('dismissing')).toBe(false)
    expect(isWakeActive('waking')).toBe(true)
    expect(isWakeActive('listening')).toBe(true)
    expect(isWakeActive('recognizing')).toBe(true)
    expect(isWakeActive('processing')).toBe(true)
    expect(isWakeActive('speaking')).toBe(true)
  })
})

describe('shouldAutoSend', () => {
  test('连续模式恒 true(原有行为不变)', () => {
    expect(shouldAutoSend({ pttHolding: false, effectiveContinuous: true, effectiveWakeWord: false, wakeActive: false })).toBe(true)
  })

  test('P0 主路径: 唤醒词模式 + 唤醒窗口内 → true', () => {
    expect(shouldAutoSend({ pttHolding: false, effectiveContinuous: false, effectiveWakeWord: true, wakeActive: true })).toBe(true)
  })

  test('唤醒词模式但窗口外(sleeping) → false(60s 退场/手动 dismiss)', () => {
    expect(shouldAutoSend({ pttHolding: false, effectiveContinuous: false, effectiveWakeWord: true, wakeActive: false })).toBe(false)
  })

  test('pttOnly(effectiveWakeWord=false) 恒 false, 即使 wakeActive', () => {
    expect(shouldAutoSend({ pttHolding: false, effectiveContinuous: false, effectiveWakeWord: false, wakeActive: true })).toBe(false)
  })

  test('pttHolding 短路一切', () => {
    expect(shouldAutoSend({ pttHolding: true, effectiveContinuous: true, effectiveWakeWord: true, wakeActive: true })).toBe(false)
  })
})
