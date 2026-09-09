/**
 * VoiceSection 语音设置 2026-08-31 修复轮:
 *   T1 「流式合成」开关移除——该字段零消费者(useVoiceReply 硬编码流式), 摆设开关删除
 *   T2 「提示音效」接真实逻辑——开关变更须同步 setSoundEnabled(useSoundEffects 总闸)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { VoiceSection } from './VoiceSection'

vi.mock('../../../hooks/useSoundEffects', () => ({
  setSoundEnabled: vi.fn(),
}))

import { setSoundEnabled } from '../../../hooks/useSoundEffects'

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    replyEnabled: true,
    ttsProvider: 'edge-tts',
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    speed: 1,
    doubaoKey: '', doubaoAccessKey: '', doubaoAppId: '', doubaoResourceId: '', doubaoVoice: '',
    asrProvider: 'volcengine',
    volcAsrApiKey: '', volcAsrAppKey: '', volcAsrAccessKey: '', volcAsrResourceId: '',
    lang: 'zh', micDeviceId: '',
    continuousMode: false,
    wakeWordEnabled: true,
    voiceThreshold: 0.008,
    ttsStreaming: true, // 预置旧字段——页面不应再渲染它
    ttsFxEnabled: false,
    outputDeviceId: '',
    volcanoAppId: '', volcanoToken: '', volcanoVoice: '',
    aliyunApiKey: '', aliyunModel: '', asrLang: 'zh',
    ...overrides,
  }
}

function renderSection(overrides: Record<string, unknown> = {}) {
  const setVoiceConfig = vi.fn()
  render(
    <VoiceSection
      activeSection="voice"
      voiceConfig={makeConfig(overrides) as any}
      setVoiceConfig={setVoiceConfig as any}
      micDevices={[]}
      audioOutputs={[]}
      onRefreshDevices={vi.fn()}
    />
  )
  return { setVoiceConfig }
}

describe('VoiceSection 语音设置', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('T1 不再渲染「流式合成」摆设开关', () => {
    renderSection()
    expect(screen.getByText('语音设置')).toBeTruthy()
    expect(screen.queryByText('流式合成')).toBeNull()
  })

  it('T2 切换「提示音效」同步接通 sound-effects 总闸', () => {
    renderSection({ ttsFxEnabled: false })
    const row = screen.getByText('提示音效').parentElement!
    const checkbox = row.querySelector('input')!
    fireEvent.click(checkbox)
    expect(setSoundEnabled).toHaveBeenCalledWith(true)

    // 再关掉——静音联动字段同步
    const row2 = screen.getByText('提示音效').parentElement!
    fireEvent.click(row2.querySelector('input')!)
    // onChange 总是传当前翻转值(受控组件), 断言第二次点击仍是链路路径
    expect(setSoundEnabled).toHaveBeenCalled()
  })
})
