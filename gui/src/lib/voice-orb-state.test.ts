import { deriveAgentFocus, deriveOrbMode, deriveOrbVolume } from './voice-orb-state'

describe('deriveOrbMode (2026-08-24 球态语义统一)', () => {
  const base = {
    muted: false,
    ttsPlaying: false,
    isSpeaking: false,
    queuePlaying: false,
    pending: false,
    voiceSessionActive: false,
    wakeArmed: false,
    continuousMode: false,
    pttOnly: false,
  }

  test('全部关闭 → 白色静态 (idle，此后不再有蓝灰 muted 态)', () => {
    expect(deriveOrbMode(base)).toBe('idle')
  })

  test('muted=语音总开关：即使会话/策略仍标活跃，球必须是白——关闭优先', () => {
    expect(deriveOrbMode({
      ...base, muted: true,
      ttsPlaying: true, pending: true, voiceSessionActive: true, wakeArmed: true,
    })).toBe('idle')
  })

  test('发声 (TTS/播报) → speaking 蓝', () => {
    expect(deriveOrbMode({ ...base, ttsPlaying: true })).toBe('speaking')
    expect(deriveOrbMode({ ...base, isSpeaking: true })).toBe('speaking')
    expect(deriveOrbMode({ ...base, queuePlaying: true })).toBe('speaking')
    // 发声时即使 LLM 仍 pending（播报 + 思考并存）也以发声优先
    expect(deriveOrbMode({ ...base, ttsPlaying: true, pending: true })).toBe('speaking')
  })

  test('LLM 处理中 → thinking 橙', () => {
    expect(deriveOrbMode({ ...base, pending: true })).toBe('thinking')
  })

  test('实时模式连续监听：会话激活但无声 → 绿色静态 (listening)', () => {
    expect(deriveOrbMode({ ...base, continuousMode: true })).toBe('listening')
    expect(deriveOrbMode({ ...base, continuousMode: true, voiceSessionActive: true })).toBe('listening')
  })

  test('PTT 模式待命（未会话激活）→ 绿色静态', () => {
    expect(deriveOrbMode({ ...base, pttOnly: true })).toBe('listening')
  })

  test('唤醒词启用（Armed）待机 → 绿色静态——语音开启态恒绿', () => {
    expect(deriveOrbMode({ ...base, wakeArmed: true })).toBe('listening')
  })

  test('会话激活（唤醒词命中后/PTT 按住）→ listening 绿', () => {
    expect(deriveOrbMode({ ...base, voiceSessionActive: true })).toBe('listening')
  })
})

describe('deriveOrbVolume (音量只驱动幅度，不切换 mode)', () => {
  test('muted 时恒 0——关闭态绝不呼吸/波动', () => {
    expect(deriveOrbVolume({ muted: true, voiceSessionActive: true, asrLevel: 0.8, kwsLevel: 0.5 })).toBe(0)
  })
  test('会话激活用 ASR 侧能量', () => {
    expect(deriveOrbVolume({ muted: false, voiceSessionActive: true, asrLevel: 0.42, kwsLevel: 0.9 })).toBe(0.42)
  })
  test('待机用 KWS 侧能量', () => {
    expect(deriveOrbVolume({ muted: false, voiceSessionActive: false, asrLevel: null, kwsLevel: 0.3 })).toBe(0.3)
  })
  test('无电平源 → 0', () => {
    expect(deriveOrbVolume({ muted: false, voiceSessionActive: false, asrLevel: null, kwsLevel: null })).toBe(0)
  })
})

describe('deriveAgentFocus (B3 2026-09-05 注意带状态)', () => {
  const base = {
    pendingApprovals: 0,
    toolRunning: 0,
    muted: false,
    ttsPlaying: false,
    isSpeaking: false,
    queuePlaying: false,
    pending: false,
    voiceSessionActive: false,
    wakeArmed: false,
    continuousMode: false,
    pttOnly: false,
  }

  test('待审批最高优先——需要用户拍板压过一切进行中状态', () => {
    expect(deriveAgentFocus({
      ...base, pendingApprovals: 1,
      toolRunning: 2, ttsPlaying: true, pending: true,
    })).toBe('waiting')
  })

  test('工具执行中 → acting——即使语音关闭(muted)也必须显示工作在跑', () => {
    expect(deriveAgentFocus({ ...base, toolRunning: 1 })).toBe('acting')
    expect(deriveAgentFocus({ ...base, toolRunning: 3, muted: true })).toBe('acting')
    // 执行压过思考/播报(进展信息 > 常态背景)
    expect(deriveAgentFocus({ ...base, toolRunning: 1, pending: true, ttsPlaying: true })).toBe('acting')
  })

  test('播报/思考/在听/待命与 orb 四态同优先级语义', () => {
    expect(deriveAgentFocus({ ...base, ttsPlaying: true, pending: true })).toBe('speaking')
    expect(deriveAgentFocus({ ...base, pending: true })).toBe('thinking')
    expect(deriveAgentFocus({ ...base, continuousMode: true })).toBe('listening')
    expect(deriveAgentFocus({ ...base, wakeArmed: true })).toBe('listening')
    expect(deriveAgentFocus(base)).toBe('idle')
  })

  test('muted 且无执行/审批 → idle(关闭态不显示监听)', () => {
    expect(deriveAgentFocus({ ...base, muted: true, wakeArmed: true })).toBe('idle')
  })
})
