import { useState } from 'react'
import { Eye, EyeOff, Settings2 } from 'lucide-react'
import { PROVIDER_ENDPOINTS, normalizeTtsProvider } from '../../constants/providers'

interface ModelConfigProps {
  modelConfig: any; setModelConfig: (v: any) => void
  imageGenConfig: any; setImageGenConfig: (v: any) => void
  videoGenConfig: any; setVideoGenConfig: (v: any) => void
  visionConfig: any; setVisionConfig: (v: any) => void
  voiceConfig: any; setVoiceConfig: (v: any) => void
  onNavigateMCP?: () => void
}

export function ModelConfig({
  modelConfig, setModelConfig,
  imageGenConfig, setImageGenConfig,
  videoGenConfig, setVideoGenConfig,
  visionConfig, setVisionConfig,
  voiceConfig, setVoiceConfig,
  onNavigateMCP: _onNavigateMCP,
}: ModelConfigProps) {
  // 2026-09-10 U 盘验收修复: voice.ttsProvider 可能被历史数据写成后端 id "edge-tts"(非法枚举),
// 导致六个服务商分支全部落空——密钥框/音色下拉整体消失。渲染前统一归一。
const ttsProvider = normalizeTtsProvider(voiceConfig.ttsProvider)
const [showKeys, setShowKeys] = useState(false)

  const providerList = (cap: string) => PROVIDER_ENDPOINTS.filter(p => (p.capabilities as any)[cap])

  // 兼容旧配置：doubao → volcengine_standard
  const normProvider = (id: string) => id === 'doubao' ? 'volcengine_standard' : id

  return (
    <div className="theme-card p-6">
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Settings2 className="w-5 h-5 theme-accent" />模型配置
      </h3>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button onClick={() => setShowKeys(!showKeys)} className="text-xs px-3 py-1 rounded theme-btn theme-btn-secondary flex items-center gap-1">
          {showKeys ? <EyeOff size={12} /> : <Eye size={12} />}{showKeys ? '隐藏' : '显示'} API Key
        </button>
      </div>

      <Card title="对话模型" desc="日常对话和推理" icon="💬" open>
        {/* Provider select */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
          <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>提供商</span>
          <select value={normProvider(modelConfig.currentProvider)} onChange={e => {
              const newProvider = e.target.value
              const ep = PROVIDER_ENDPOINTS.find(p => p.id === newProvider)
              setModelConfig({ ...modelConfig, currentProvider: newProvider, defaultModel: ep?.defaultModel || '' })
            }}
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
            {providerList('chat').map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {/* Key */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
          <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>API Key</span>
          <input type={showKeys ? 'text' : 'password'} value={modelConfig.providers[modelConfig.currentProvider]?.apiKey || ''}
            onChange={e => { const np = { ...modelConfig.providers }; np[modelConfig.currentProvider] = { ...np[modelConfig.currentProvider], apiKey: e.target.value }; setModelConfig({ ...modelConfig, providers: np }) }}
            onFocus={e => { if (e.target.value.includes('***')) e.target.select() }}
            placeholder="粘贴 API Key" spellCheck={false} autoComplete="off"
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
        </div>
        {/* Model */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
          <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>模型</span>
          <input type="text" value={modelConfig.providers[modelConfig.currentProvider]?.model || ''}
            onChange={e => { const np = { ...modelConfig.providers }; np[modelConfig.currentProvider] = { ...np[modelConfig.currentProvider], model: e.target.value }; setModelConfig({ ...modelConfig, providers: np, defaultModel: e.target.value }) }}
            placeholder="模型 ID" spellCheck={false}
            style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          常用: deepseek-v4-flash-vision-exp · deepseek-v4-pro · deepseek-v4-flash
        </div>
      </Card>

      <Card title="视觉理解" desc="识别和分析图片内容" icon="👁️">
        <ProviderSelect value={normProvider(visionConfig.provider)} providers={providerList('vision')} onChange={v => setVisionConfig({ ...visionConfig, provider: v })} />
        <KeyInput value={visionConfig.providers[visionConfig.provider]?.apiKey || ''} show={showKeys}
          onChange={v => { const np = { ...visionConfig.providers }; np[visionConfig.provider] = { ...np[visionConfig.provider], apiKey: v }; setVisionConfig({ ...visionConfig, providers: np }) }} />
        <ModelInput value={visionConfig.providers[visionConfig.provider]?.model || ''}
          onChange={v => { const np = { ...visionConfig.providers }; np[visionConfig.provider] = { ...np[visionConfig.provider], model: v }; setVisionConfig({ ...visionConfig, providers: np }) }} />
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>常用: doubao-seed-1-6-vision · qwen-vl-plus · glm-4v-flash</div>
      </Card>

      <Card title="图片生成" desc="根据文字描述生成图片" icon="🎨">
        <ProviderSelect value={normProvider(imageGenConfig.provider)} providers={providerList('image')} onChange={v => setImageGenConfig({ ...imageGenConfig, provider: v })} />
        <KeyInput value={imageGenConfig.providers[imageGenConfig.provider]?.apiKey || ''} show={showKeys}
          onChange={v => { const np = { ...imageGenConfig.providers }; np[imageGenConfig.provider] = { ...np[imageGenConfig.provider], apiKey: v }; setImageGenConfig({ ...imageGenConfig, providers: np }) }} />
        <ModelInput value={imageGenConfig.providers[imageGenConfig.provider]?.model || ''}
          onChange={v => { const np = { ...imageGenConfig.providers }; np[imageGenConfig.provider] = { ...np[imageGenConfig.provider], model: v }; setImageGenConfig({ ...imageGenConfig, providers: np }) }} />
      </Card>

      <Card title="视频生成" desc="根据文字或图片生成视频" icon="🎬">
        <ProviderSelect value={normProvider(videoGenConfig.provider)} providers={providerList('video')} onChange={v => setVideoGenConfig({ ...videoGenConfig, provider: v })} />
        <KeyInput value={videoGenConfig.providers[videoGenConfig.provider]?.apiKey || ''} show={showKeys}
          onChange={v => { const np = { ...videoGenConfig.providers }; np[videoGenConfig.provider] = { ...np[videoGenConfig.provider], apiKey: v }; setVideoGenConfig({ ...videoGenConfig, providers: np }) }} />
        <ModelInput value={videoGenConfig.providers[videoGenConfig.provider]?.model || ''}
          onChange={v => { const np = { ...videoGenConfig.providers }; np[videoGenConfig.provider] = { ...np[videoGenConfig.provider], model: v }; setVideoGenConfig({ ...videoGenConfig, providers: np }) }} />
      </Card>

      <Card title="语音合成 TTS" desc="文字转语音" icon="🔊">
        {/* 2026-08-31: 贾维斯声线预设——豆包 M191 中文男声+从容口吻(style 豆包生效)。
            初版为 edge 伦敦腔(en-GB-GuyNeural), 实测本网络 edge 被墙熔断(isEdgeBlocked)
            → 引擎跳 edge 降级豆包小鹤女声, 预设失真; M191 合成实测成功(1.73s)。 */}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          音色在下方「音色」下拉中选择（切换 TTS 服务商后列表会跟随变化）。选豆包 TTS 推荐
          <strong> M191 贾维斯（男声）</strong>；音色试听可到 设置 → 语音设置。
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
          <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>提供商</span>
          <select value={ttsProvider} onChange={e => {
              const p = e.target.value
              // 切到 openai/qwen 时把 defaultVoice 置为该厂商默认音色（后端按厂商校验音色，非法值会回退厂商默认）
              const providerDefaultVoice: Record<string, string> = { openai: 'alloy', qwen: 'zhichu' }
              setVoiceConfig({ ...voiceConfig, ttsProvider: p, ...(providerDefaultVoice[p] ? { defaultVoice: providerDefaultVoice[p] } : {}) })
            }}
            style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
            <option value="doubao" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>豆包 TTS (火山引擎 seed-tts-2.0)</option>
            <option value="volcano" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>火山 TTS (基础版)</option>
            <option value="edge" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Edge TTS (系统自带)</option>
            <option value="sapi" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>SAPI (Windows)</option>
            <option value="openai" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>OpenAI TTS</option>
            <option value="qwen" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>通义千问 TTS</option>
          </select>
        </div>
        {/* 豆包 TTS 凭证 */}
        {ttsProvider === 'doubao' && (
          <>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>API Key</span>
              <input type={showKeys ? 'text' : 'password'} value={voiceConfig.doubaoKey || ''} onChange={e => setVoiceConfig({ ...voiceConfig, doubaoKey: e.target.value })} placeholder="豆包 TTS API Key" spellCheck={false} autoComplete="off"
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>App ID</span>
              <input type="text" value={voiceConfig.doubaoAppId || ''} onChange={e => setVoiceConfig({ ...voiceConfig, doubaoAppId: e.target.value })} placeholder="可选" spellCheck={false} autoComplete="off"
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>Access Key</span>
              <input type={showKeys ? 'text' : 'password'} value={voiceConfig.doubaoAccessKey || ''} onChange={e => setVoiceConfig({ ...voiceConfig, doubaoAccessKey: e.target.value })} placeholder="可选" spellCheck={false} autoComplete="off"
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
            </div>
          </>
        )}
        {/* 火山引擎 TTS 凭证 */}
        {ttsProvider === 'volcano' && (
          <>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>App ID</span>
              <input type="text" value={voiceConfig.volcanoAppId || ''} onChange={e => setVoiceConfig({ ...voiceConfig, volcanoAppId: e.target.value })} placeholder="火山引擎 App ID" spellCheck={false} autoComplete="off"
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
            </div>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>Token</span>
              <input type={showKeys ? 'text' : 'password'} value={voiceConfig.volcanoToken || ''} onChange={e => setVoiceConfig({ ...voiceConfig, volcanoToken: e.target.value })} placeholder="火山引擎 Access Token" spellCheck={false} autoComplete="off"
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
            </div>
          </>
        )}
        {/* OpenAI TTS 凭证（后端从 voice.openaiApiKey 读取） */}
        {ttsProvider === 'openai' && (
          <>
            <KeyInput value={voiceConfig.openaiApiKey || ''} show={showKeys} onChange={v => setVoiceConfig({ ...voiceConfig, openaiApiKey: v })} />
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>音色</span>
              <select value={voiceConfig.defaultVoice || 'alloy'} onChange={e => setVoiceConfig({ ...voiceConfig, defaultVoice: e.target.value })}
                style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
                <option value="alloy" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Alloy</option>
                <option value="echo" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Echo</option>
                <option value="fable" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Fable</option>
                <option value="onyx" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Onyx</option>
                <option value="nova" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Nova</option>
                <option value="shimmer" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Shimmer</option>
              </select>
            </div>
          </>
        )}
        {/* 通义千问 TTS 凭证（后端从 voice.qwenApiKey 读取） */}
        {ttsProvider === 'qwen' && (
          <>
            <KeyInput value={voiceConfig.qwenApiKey || ''} show={showKeys} onChange={v => setVoiceConfig({ ...voiceConfig, qwenApiKey: v })} />
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>音色</span>
              <select value={voiceConfig.defaultVoice || 'zhichu'} onChange={e => setVoiceConfig({ ...voiceConfig, defaultVoice: e.target.value })}
                style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
                <option value="zhichu" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>知初 (zhichu)</option>
                <option value="zhitian" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>知甜 (zhitian)</option>
                <option value="zhiyan" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>知燕 (zhiyan)</option>
                <option value="zhimi" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>知米 (zhimi)</option>
              </select>
            </div>
          </>
        )}
        {ttsProvider === 'doubao' && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
            <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>音色</span>
            <select value={voiceConfig.doubaoVoice || 'zh_female_xiaohe_uranus_bigtts'} onChange={e => setVoiceConfig({ ...voiceConfig, doubaoVoice: e.target.value })}
              style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
              <option value="zh_female_xiaohe_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>晓鹤 (女声)</option>
              <option value="zh_female_shuangkuaisisi_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>爽快斯斯 (女声)</option>
              <option value="zh_female_tianmeixiaoyuan_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>甜美校园 (女声)</option>
              <option value="zh_male_m191_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>M191 贾维斯（男声·推荐）</option>
            </select>
          </div>
        )}
        {ttsProvider === 'volcano' && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
            <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>音色</span>
            <select value={voiceConfig.volcanoVoice || 'BV001_streaming'} onChange={e => setVoiceConfig({ ...voiceConfig, volcanoVoice: e.target.value })}
              style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
              <option value="BV001_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV001 通用女声</option>
              <option value="BV002_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV002 通用男声</option>
              <option value="BV003_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV003 温柔女声</option>
              <option value="BV004_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV004 成熟男声</option>
              <option value="BV005_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV005 沉稳男声</option>
              <option value="BV006_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV006 可爱女声</option>
              <option value="BV007_streaming" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>BV007 成熟女声</option>
              <option value="zh_female_qingxin" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>清新 (女声)</option>
            </select>
          </div>
        )}
        {(ttsProvider === 'edge' || ttsProvider === 'sapi') && (
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
            <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>音色</span>
            <select value={voiceConfig.edgeVoice || 'zh-CN-XiaoxiaoNeural'} onChange={e => setVoiceConfig({ ...voiceConfig, edgeVoice: e.target.value, defaultVoice: e.target.value })}
              style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
              <option value="zh-CN-XiaoxiaoNeural" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>晓晓 (女声)</option>
              <option value="zh-CN-YunxiNeural" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>云希 (男声)</option>
              <option value="zh-CN-XiaoyiNeural" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>晓伊 (女声)</option>
            </select>
          </div>
        )}
      </Card>

      <Card title="语音识别 ASR" desc="语音转文字" icon="🎤">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
          <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>提供商</span>
          <select value={voiceConfig.asrProvider || 'volcengine'} onChange={e => setVoiceConfig({ ...voiceConfig, asrProvider: e.target.value })}
            style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
            <option value="volcengine" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>火山引擎 ASR</option>
            <option value="aliyun" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>阿里云百炼 ASR (FunASR)</option>
            <option value="browser" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>浏览器内置</option>
          </select>
        </div>
        {(voiceConfig.asrProvider || 'volcengine') === 'volcengine' && (
          <KeyInput value={voiceConfig.volcAsrApiKey || ''} show={showKeys} onChange={v => setVoiceConfig({ ...voiceConfig, volcAsrApiKey: v })} />
        )}
        {voiceConfig.asrProvider === 'aliyun' && (
          <>
          <KeyInput value={voiceConfig.aliyunApiKey || ''} show={showKeys} onChange={v => setVoiceConfig({ ...voiceConfig, aliyunApiKey: v })} />
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
            <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>模型</span>
            <select value={voiceConfig.aliyunModel || 'fun-asr-realtime-2026-02-28'} onChange={e => setVoiceConfig({ ...voiceConfig, aliyunModel: e.target.value })}
              style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
              <option value="fun-asr-realtime-2026-02-28" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>fun-asr-realtime-2026-02-28</option>
              <option value="fun-asr-realtime-2025-11-07" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>fun-asr-realtime-2025-11-07</option>
              <option value="paraformer-realtime-v2" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>paraformer-realtime-v2</option>
            </select>
          </div>
          </>
        )}
        {(voiceConfig.asrProvider || 'volcengine') === 'volcengine' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>App Key</span>
              <input type="text" value={voiceConfig.volcAsrAppKey || ''} onChange={e => setVoiceConfig({ ...voiceConfig, volcAsrAppKey: e.target.value })} placeholder="App Key（可选）" style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
              <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>资源 ID</span>
              <select value={voiceConfig.volcAsrResourceId || 'volc.seedasr.sauc.duration'} onChange={e => setVoiceConfig({ ...voiceConfig, volcAsrResourceId: e.target.value })}
                style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
                <option value="volc.seedasr.sauc.duration" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>Seed ASR 2.0 (流式语音识别2.0)</option>
                <option value="volc.bigasr.sauc.duration" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>豆包大模型 ASR (旧版 bigmodel)</option>
              </select>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

// ── helpers ──

function Card({ title, desc, icon, children, open = false }: any) {
  const [show, setShow] = useState(open)
  return (
    <div style={{ marginBottom: 10, border: '1px solid var(--border-primary)', borderRadius: 14, overflow: 'hidden', background: 'var(--bg-secondary)' }}>
      <div onClick={() => setShow(!show)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', cursor: 'pointer', background: 'var(--bg-tertiary)' }}>
        <span style={{ fontSize: 15 }}>{icon}</span>
        <div style={{ flex: 1 }}><span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span><span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>{desc}</span></div>
        <span style={{ color: 'var(--text-muted)', fontSize: 10, transform: show ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
      </div>
      {show && <div style={{ padding: '4px 10px 10px' }}>{children}</div>}
    </div>
  )
}

function ProviderSelect({ value, providers, onChange }: { value: string; providers: any[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
      <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>提供商</span>
      <select value={value} onChange={e => onChange(e.target.value)} style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
        {providers.map((p: any) => <option key={p.id} value={p.id} style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>{p.name}</option>)}
      </select>
    </div>
  )
}

function KeyInput({ value, show, onChange }: { value: string; show: boolean; onChange: (v: string) => void }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
      <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>API Key</span>
      <input type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)}
        onFocus={e => { if (e.target.value.includes('***')) e.target.select() }}
        placeholder="粘贴 API Key" spellCheck={false} autoComplete="off"
        style={{ flex: 1, border: 'none', background: 'transparent', color: value ? 'var(--text-primary)' : 'var(--text-muted)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
    </div>
  )
}

function ModelInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
      <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>模型</span>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder="模型 ID" spellCheck={false}
        style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none' }} />
    </div>
  )
}
