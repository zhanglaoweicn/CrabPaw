import { useState } from 'react'
import { Eye, EyeOff, Settings2 } from 'lucide-react'
import { PROVIDER_ENDPOINTS } from '../../constants/providers'

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
  // 2026-09-17: TTS/ASR 收编豆包单通道——厂商选择与多厂商凭证 UI 已移除,
  // 统一密钥在「语音服务（豆包）」卡片。ttsProvider 保留 state 透传(后端引擎
  // 有豆包优先序, 有 Key 时自动走豆包), 页面不再提供切换。
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

      {/* 2026-09-17: TTS/ASR 合并单卡——豆包语音一把密钥同时驱动 TTS/ASR/实时双工通道,
          消除"两处填密钥"(用户要求只保留豆包通道)。其余厂商字段移除, 后端读取路径不变。 */}
      <Card title="语音服务（豆包）" desc="TTS · ASR · 实时对话统一密钥" icon="🗣️" open>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
          一把密钥同时用于语音合成(TTS)、语音识别(ASR)与实时语音对话。音色用于传统通道播报与试听；
          实时对话通道使用模型自带音色，无需在此配置。传统链路推荐 <strong>M191 贾维斯（男声）</strong>。
        </div>
        <KeyInput
          value={voiceConfig.volcAsrApiKey || voiceConfig.doubaoKey || ''}
          show={showKeys}
          onChange={v => setVoiceConfig({ ...voiceConfig, volcAsrApiKey: v, doubaoKey: v })}
          placeholder="豆包语音 API Key（TTS/ASR/实时对话共用）"
        />
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
        {/* 2026-09-17: 实时通道模型音色——与 TTS 音色相互独立, 仅实时模型支持的精品音色 */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
          <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>实时音色</span>
          <select value={voiceConfig.realtimeVoice || 'zh_female_vv_jupiter_bigtts'} onChange={e => setVoiceConfig({ ...voiceConfig, realtimeVoice: e.target.value })}
            style={{ flex: 1, border: 'none', background: 'var(--bg-input)', color: 'var(--text-primary)', padding: '9px 12px', fontSize: 12, outline: 'none', cursor: 'pointer' }}>
            <option value="zh_female_vv_jupiter_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>VV (女声·默认)</option>
            <option value="zh_female_xiaohe_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>小何 (温暖女声)</option>
            <option value="zh_male_yunzhou_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>云舟 (沉稳男声)</option>
            <option value="zh_male_xiaotian_uranus_bigtts" style={{ background: 'var(--bg-card)', color: 'var(--text-primary)' }}>小天 (阳光男声)</option>
          </select>
        </div>
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

function KeyInput({ value, show, onChange, placeholder = '粘贴 API Key' }: { value: string; show: boolean; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', marginBottom: 8, border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-primary)', fontSize: 12 }}>
      <span style={{ flex: '0 0 70px', padding: '9px 12px', color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', borderRadius: '9px 0 0 9px' }}>API Key</span>
      <input type={show ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)}
        onFocus={e => { if (e.target.value.includes('***')) e.target.select() }}
        placeholder={placeholder} spellCheck={false} autoComplete="off"
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
