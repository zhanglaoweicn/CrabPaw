/**
 * ModelConfig 语音卡回归测试
 *   2026-09-09 UX 简化轮: T1 音色下拉提供 M191 贾维斯男声; T2 不提供不可达的 edge 伦敦腔
 *   2026-09-17 TTS/ASR 合并轮: 两卡收编为「语音服务（豆包）」单卡——统一密钥(TTS/ASR 共写
 *   doubaoKey+volcAsrApiKey)、仅豆包音色下拉; 厂商选择/多厂商凭证 UI 移除。
 *   旧 T3(U盘验收: 脏数据 edge-tts 不应使密钥区消失)语义平移: 无论 ttsProvider 脏成什么样,
 *   合并卡的密钥框与音色下拉恒渲染(不再依赖 provider 分支)。
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

describe('ModelConfig 语音服务（豆包）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** 合并卡默认展开(open)——仅当内容未渲染(被折叠)时才点击标题展开 */
  function openVoiceCard() {
    if (!screen.queryByPlaceholderText('豆包语音 API Key（TTS/ASR/实时对话共用）')) {
      fireEvent.click(screen.getByText('语音服务（豆包）'))
    }
  }

  it('T1 音色下拉提供 M191 贾维斯男声(推荐标注)', () => {
    makeProps()
    openVoiceCard()
    // 豆包分支的音色 select:直接按选项文本定位(提示文案与选项文本相近,按标签过滤)
    const opt = screen.getAllByText(/M191 贾维斯/).find(el => el.tagName === 'OPTION')!
    const select = opt.closest('select') as HTMLSelectElement
    const values = Array.from(select.options).map(o => o.value)
    expect(values).toContain('zh_male_m191_uranus_bigtts')
    expect(select.value).toBe('zh_female_xiaohe_uranus_bigtts')
  })

  it('T2 统一密钥写入 doubaoKey + volcAsrApiKey 两个字段(TTS/ASR 共用)', () => {
    const { setVoiceConfig } = makeProps()
    openVoiceCard()
    const keyInput = screen.getByPlaceholderText('豆包语音 API Key（TTS/ASR/实时对话共用）') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: 'test-key-123' } })
    expect(setVoiceConfig).toHaveBeenCalledWith(
      expect.objectContaining({ volcAsrApiKey: 'test-key-123', doubaoKey: 'test-key-123' })
    )
  })

  it('T3 历史脏数据(edge-tts 等)不再影响渲染——合并卡恒渲染密钥框与音色下拉(U盘验收回归平移)', () => {
    makeProps({ ttsProvider: 'edge-tts', edgeVoice: 'zh-CN-XiaoxiaoNeural' })
    openVoiceCard()
    // 回归背景: Settings 加载兜底曾把 "edge-tts" 填进 voice.ttsProvider, 旧多厂商分支全不匹配
    // 导致密钥框/音色菜单整体消失。合并卡不再按 provider 分支, 恒渲染。
    expect(screen.getByPlaceholderText('豆包语音 API Key（TTS/ASR/实时对话共用）')).toBeTruthy()
    const select = screen.getByText('音色').parentElement!.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('zh_female_xiaohe_uranus_bigtts')
  })

  it('T4 不再提供 edge 伦敦腔等非豆包音色选项(收编豆包单通道)', () => {
    makeProps({ ttsProvider: 'edge', edgeVoice: 'zh-CN-XiaoxiaoNeural' })
    openVoiceCard()
    const select = screen.getByText('音色').parentElement!.querySelector('select') as HTMLSelectElement
    const values = Array.from(select.options).map(o => o.value)
    expect(values).not.toContain('en-GB-GuyNeural')
    expect(values).not.toContain('en-GB-RyanNeural')
    expect(values.every(v => v.startsWith('zh_'))).toBe(true)
  })
})
