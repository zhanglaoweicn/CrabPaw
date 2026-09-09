/**
 * ModelConfig TTS 卡 2026-09-09 UX 简化轮:
 *   T1 音色下拉(豆包)提供 M191 贾维斯男声选项——原「贾维斯声线」预设按钮已删,
 *      音色统一由下拉选择(用户反馈:按钮是唯一切换入口,不友好)
 *   T2 不再提供不可达的 edge 伦敦腔选项(被墙网络降级失真)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ModelConfig } from './ModelConfig'

function makeProps(overrides: Record<string, unknown> = {}) {
  const setVoiceConfig = vi.fn()
  const voiceConfig: Record<string, unknown> = {
    ttsProvider: 'doubao',
    doubaoVoice: 'zh_female_xiaohe_uranus_bigtts',
    defaultVoice: 'zh_female_xiaohe_uranus_bigtts',
    ...(overrides as Record<string, unknown>),
  }
  const cfg = { provider: 'doubao', providers: { doubao: {} }, model: '' }
  render(
    <ModelConfig
      modelConfig={{ currentProvider: 'deepseek', providers: { deepseek: { baseUrl: 'x', model: 'y' } } }}
      setModelConfig={vi.fn()}
      imageGenConfig={{ ...cfg }}
      setImageGenConfig={vi.fn()}
      videoGenConfig={{ ...cfg }}
      setVideoGenConfig={vi.fn()}
      visionConfig={{ ...cfg }}
      setVisionConfig={vi.fn()}
      voiceConfig={voiceConfig as any}
      setVoiceConfig={setVoiceConfig as any}
    />
  )
  return { setVoiceConfig }
}

describe('ModelConfig TTS 音色', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** Card 默认折叠(open=false)——展开 TTS 卡后再断言 */
  function openTtsCard() {
    fireEvent.click(screen.getByText('语音合成 TTS'))
  }

  it('T1 音色下拉提供 M191 贾维斯男声(推荐标注)', () => {
    makeProps()
    openTtsCard()
    // 豆包分支的音色 select:直接按选项文本定位(提示文案与选项文本相近,按标签过滤)
    const opt = screen.getAllByText(/M191 贾维斯/).find(el => el.tagName === 'OPTION')!
    const select = opt.closest('select') as HTMLSelectElement
    const values = Array.from(select.options).map(o => o.value)
    expect(values).toContain('zh_male_m191_uranus_bigtts')
    expect(select.value).toBe('zh_female_xiaohe_uranus_bigtts')
  })

  it('T2 不再提供不可达的 edge 伦敦腔选项(被墙网络降级失真)', () => {
    makeProps({ ttsProvider: 'edge', edgeVoice: 'zh-CN-XiaoxiaoNeural', defaultVoice: 'zh-CN-XiaoxiaoNeural' })
    openTtsCard()
    const select = screen.getByText('音色').parentElement!.querySelector('select') as HTMLSelectElement
    const values = Array.from(select.options).map(o => o.value)
    expect(values).not.toContain('en-GB-GuyNeural')
    expect(values).not.toContain('en-GB-RyanNeural')
  })

  it('T3 历史脏数据 edge-tts(后端id)归一为 edge——密钥区/音色下拉不整体消失(U盘验收回归)', () => {
    makeProps({ ttsProvider: 'edge-tts', edgeVoice: 'zh-CN-XiaoxiaoNeural' })
    openTtsCard()
    // 回归背景: Settings 加载兜底曾把 "edge-tts" 填进 voice.ttsProvider, 六个服务商分支全不匹配,
    // 密钥框/音色菜单整体消失。normalizeTtsProvider 归一后 edge 分支(免费无密钥)应正常渲染音色下拉。
    const select = screen.getByText('音色').parentElement!.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('zh-CN-XiaoxiaoNeural')
  })
})
