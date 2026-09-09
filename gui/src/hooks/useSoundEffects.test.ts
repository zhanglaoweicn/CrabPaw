/**
 * useSoundEffects 总闸回归 2026-08-31:
 *   T1 关闭后 playBootAmbience 须静音(此前它不读 _enabled——开机氛围音无视开关)
 *   T2 关闭后 playSound 零发声; 开启后发声
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { playSound, playBootAmbience, setSoundEnabled } from './useSoundEffects'

let createdOsc = 0
class FakeOsc {
  type = ''
  frequency = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }
  connect() {}
  start() {}
  stop() {}
}
class FakeGain {
  gain = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
  connect() {}
}
class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createOscillator() { createdOsc++; return new FakeOsc() }
  createGain() { return new FakeGain() }
  resume() { return Promise.resolve() }
}

describe('useSoundEffects 总闸', () => {
  beforeEach(() => {
    createdOsc = 0
    Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true })
    Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true })
    setSoundEnabled(true)
  })
  afterEach(() => {
    setSoundEnabled(true)
  })

  it('T1 关闭时开机氛围音不发声', () => {
    setSoundEnabled(false)
    playBootAmbience(0.1)
    expect(createdOsc).toBe(0)
  })

  it('T2 playSound 受总闸控制: 关=0 开=1', () => {
    setSoundEnabled(false)
    playSound('voice-start')
    expect(createdOsc).toBe(0)
    setSoundEnabled(true)
    playSound('voice-start')
    expect(createdOsc).toBe(1)
  })
})
