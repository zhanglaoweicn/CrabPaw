import React, { useState, useRef, useEffect } from 'react'
import { Volume2, RefreshCw, Mic, MicOff } from 'lucide-react'
import { setSoundEnabled } from '../../../hooks/useSoundEffects'

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer" style={{ gap: 6 }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="sr-only peer" />
      <div className="w-9 h-5 rounded-full peer-focus:outline-none transition-colors duration-200 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-[16px]" style={{ backgroundColor: checked ? 'var(--color-accent)' : 'var(--color-border)', position: 'relative' }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: checked ? 'var(--color-accent)' : 'var(--text-muted)', minWidth: 24 }}>
        {checked ? 'ON' : 'OFF'}
      </span>
    </label>
  )
}

interface VoiceSectionProps {
  activeSection: string
  voiceConfig: {
    replyEnabled: boolean
    ttsProvider: string
    defaultVoice: string
    speed: number
    doubaoKey: string
    doubaoAccessKey: string
    doubaoAppId: string
    doubaoResourceId: string
    doubaoVoice: string
    asrProvider: string
    volcAsrApiKey: string
    volcAsrAppKey: string
    volcAsrAccessKey: string
    volcAsrResourceId: string
    lang: string
    micDeviceId: string
    continuousMode: boolean
    wakeWordEnabled: boolean
    voiceThreshold: number
    ttsFxEnabled: boolean
    outputDeviceId: string
    volcanoAppId: string
    volcanoToken: string
    volcanoVoice: string
    aliyunApiKey: string
    aliyunModel: string
    asrLang: string
  }
  setVoiceConfig: React.Dispatch<React.SetStateAction<{
    replyEnabled: boolean
    ttsProvider: string
    defaultVoice: string
    speed: number
    doubaoKey: string
    doubaoAccessKey: string
    doubaoAppId: string
    doubaoResourceId: string
    doubaoVoice: string
    asrProvider: string
    volcAsrApiKey: string
    volcAsrAppKey: string
    volcAsrAccessKey: string
    volcAsrResourceId: string
    lang: string
    micDeviceId: string
    continuousMode: boolean
    wakeWordEnabled: boolean
    voiceThreshold: number
    ttsFxEnabled: boolean
    outputDeviceId: string
    volcanoAppId: string
    volcanoToken: string
    volcanoVoice: string
    aliyunApiKey: string
    aliyunModel: string
    asrLang: string
  }>>
  micDevices: MediaDeviceInfo[]
  audioOutputs: MediaDeviceInfo[]
  onRefreshDevices: () => void
}

export function VoiceSection({ activeSection, voiceConfig, setVoiceConfig, micDevices, audioOutputs, onRefreshDevices }: VoiceSectionProps) {
  // ─── 测试麦克风 ───
  const [testMicActive, setTestMicActive] = useState(false)
  const [testMicLevel, setTestMicLevel] = useState(0)
  const testMicStreamRef = useRef<MediaStream | null>(null)
  const testMicCtxRef = useRef<AudioContext | null>(null)
  // 2026-08-08(审计 P1): rAF 链用 ref 驱动——旧实现 tick 闭包捕获点击时刻的
  // testMicActive(恒 false),首帧后 rAF 链即终止,电平条采集一次后冻结
  const testMicActiveRef = useRef(false)

  const stopTestMic = () => {
    testMicActiveRef.current = false
    try { testMicStreamRef.current?.getTracks().forEach(t => t.stop()) } catch (e) { console.debug('[VoiceSection] stopTestMic: 关闭音频轨道失败', e) }
    try { testMicCtxRef.current?.close() } catch (e) { console.debug('[VoiceSection] stopTestMic: 关闭 AudioContext 失败', e) }
    testMicStreamRef.current = null
    testMicCtxRef.current = null
    setTestMicActive(false)
    setTestMicLevel(0)
  }

  const startTestMic = async () => {
    stopTestMic()
    try {
      const deviceId = voiceConfig.micDeviceId
      const constraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true }
      if (deviceId) (constraints as any).deviceId = { exact: deviceId }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
      testMicStreamRef.current = stream
      const ctx = new AudioContext()
      testMicCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const buf = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (!testMicStreamRef.current || !testMicActiveRef.current) return
        analyser.getByteFrequencyData(buf)
        const avg = buf.reduce((a, v) => a + v, 0) / buf.length
        setTestMicLevel(Math.min(1, avg / 128))
        requestAnimationFrame(tick)
      }
      testMicActiveRef.current = true
      setTestMicActive(true)
      tick()
    } catch (e: any) {
      console.warn('[VoiceSection] 测试麦克风失败:', e?.message || e)
      stopTestMic()
    }
  }

  // cleanup on unmount
  useEffect(() => { return () => stopTestMic() }, [])

  // ── 唤醒词文字编辑（2026-08-12）──────────────────────────────────
  // 当前词来源：config.wakeWord（SetupWizard 保存时写入 config；主进程 set-keyword 也会持久化）
  // 保存途径：w.wake.setKeyword（IPC），校验规则与 SetupWizard 一致（2-6 个汉字）
  const [wakeWordInput, setWakeWordInput] = useState('')
  const [wakeWordError, setWakeWordError] = useState('')
  const [wakeWordLoaded, setWakeWordLoaded] = useState(false)
  const wakeWordRef = useRef('')

  useEffect(() => {
    let cancelled = false
    const w = window.electronAPI
    if (!w || !w.config?.get) { setWakeWordLoaded(true); return }
    w.config.get().then((cfg: any) => {
      if (cancelled) return
      const ww = Array.isArray(cfg?.wakeWord) ? cfg.wakeWord[0] : (typeof cfg?.wakeWord === 'string' ? cfg.wakeWord : '小螃蟹')
      setWakeWordInput(ww)
      wakeWordRef.current = ww
    }).catch((e: any) => {
      console.error('[VoiceSection] 读取唤醒词失败:', e?.message || e)
    }).finally(() => {
      if (!cancelled) setWakeWordLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const saveWakeWord = async () => {
    const word = wakeWordInput.trim()
    if (!/^[一-龥]{2,6}$/.test(word)) { setWakeWordError('唤醒词需为 2-6 个汉字'); return }
    if (word === wakeWordRef.current) { setWakeWordError(''); return }
    const w = window.electronAPI
    if (!w?.wake) { setWakeWordError('当前环境不支持修改唤醒词（需 Electron 桌面端）'); return }
    try {
      // 与 SetupWizard 同款：用户词 + 品牌词"小龙女"常驻（主进程自行持久化到 config.wakeWord）
      const wakeWords = [...new Set([word, '小龙女'])].filter(Boolean)
      const res = await w.wake.setKeyword(wakeWords)
      if (res && res.ok === false) { setWakeWordError(res.error || '唤醒词保存失败，请重试'); return }
      wakeWordRef.current = word
      setWakeWordError('')
    } catch (err) {
      console.error('[VoiceSection] 保存唤醒词失败:', err)
      setWakeWordError('唤醒词保存失败，请重试')
    }
  }
  return (
    <div className="theme-card p-6" style={{ display: activeSection === 'voice' ? 'block' : 'none' }}>
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Volume2 className="w-5 h-5 theme-accent" />
        语音设置
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* ═══ 通用设置 ═══ */}
        <div className="p-4 rounded-lg theme-bg-tertiary">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>通用设置</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>语音回复</span>
            <ToggleSwitch checked={voiceConfig.replyEnabled} onChange={v => setVoiceConfig(prev => ({ ...prev, replyEnabled: v }))} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>开启后 AI 回复自动朗读</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>识别语言</span>
            <select className="theme-input" style={{ flex: 1, maxWidth: 200 }} value={voiceConfig.lang || 'zh'} onChange={e => setVoiceConfig(prev => ({ ...prev, lang: e.target.value }))}>
              <option value="zh">中文</option><option value="en">英文</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>输出设备</span>
            <select className="theme-input" style={{ flex: 1, maxWidth: 300 }} value={voiceConfig.outputDeviceId || ''} onChange={e => setVoiceConfig(prev => ({ ...prev, outputDeviceId: e.target.value }))}>
              <option value="">系统默认</option>
              {audioOutputs.map((d: any) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
            <button onClick={onRefreshDevices} title="刷新设备列表" className="theme-btn-ghost" style={{ padding: '6px', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><RefreshCw className="w-3.5 h-3.5" /></button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>麦克风</span>
            <select className="theme-input" style={{ flex: 1, maxWidth: 300 }} value={voiceConfig.micDeviceId || ''} onChange={e => { const id = e.target.value; setVoiceConfig(prev => ({ ...prev, micDeviceId: id })); try { localStorage.setItem('mic-device-id', id) } catch (lsErr) { console.debug('[VoiceSection] localStorage.setItem 失败', lsErr) } }}>
              <option value="">系统默认</option>
              {micDevices.map((d: any) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
            </select>
            <button onClick={onRefreshDevices} title="刷新设备列表" className="theme-btn-ghost" style={{ padding: '6px', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><RefreshCw className="w-3.5 h-3.5" /></button>
          </div>
          {/* 测试麦克风 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>测试麦克风</span>
            <button
              onClick={testMicActive ? stopTestMic : startTestMic}
              className={testMicActive ? 'theme-btn-ghost' : 'theme-btn-ghost'}
              style={{ padding: '6px 12px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, border: '1px solid var(--color-border)' }}
            >
              {testMicActive ? <><MicOff className="w-3.5 h-3.5" /> 停止</> : <><Mic className="w-3.5 h-3.5" /> 测试</>}
            </button>
            {testMicActive && (
              <div style={{ flex: 1, maxWidth: 200, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, background: testMicLevel > 0.7 ? 'var(--color-error)' : 'var(--color-accent)', width: (testMicLevel * 100) + '%', transition: 'width 80ms linear' }} />
                </div>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 30, textAlign: 'right' }}>{Math.round(testMicLevel * 100)}%</span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>连续对话</span>
            <ToggleSwitch checked={voiceConfig.continuousMode} onChange={v => setVoiceConfig(prev => ({ ...prev, continuousMode: v }))} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>唤醒词</span>
            <ToggleSwitch checked={voiceConfig.wakeWordEnabled} onChange={v => setVoiceConfig(prev => ({ ...prev, wakeWordEnabled: v }))} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>唤醒词内容</span>
            <input
              className="theme-input"
              style={{ flex: 1, maxWidth: 200 }}
              value={wakeWordInput}
              maxLength={6}
              placeholder="2-6 个汉字"
              disabled={!wakeWordLoaded || !window.electronAPI?.wake}
              onChange={e => { setWakeWordInput(e.target.value); setWakeWordError('') }}
              onBlur={saveWakeWord}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>失焦即保存（品牌词"小龙女"常驻）</span>
          </div>
          {wakeWordError && <div style={{ fontSize: 11, color: '#ff8f8f', margin: '-4px 0 10px 132px' }}>{wakeWordError}</div>}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>灵敏度</span>
            <input type="range" min="0.002" max="0.04" step="0.002" value={voiceConfig.voiceThreshold || 0.008} onChange={e => setVoiceConfig(prev => ({ ...prev, voiceThreshold: parseFloat(e.target.value) }))} style={{ flex: 1, maxWidth: 200 }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 32 }}>{voiceConfig.voiceThreshold || 0.008}</span>
          </div>
        </div>

        {/* ═══ TTS 设置 ═══ */}
        <div className="p-4 rounded-lg theme-bg-tertiary">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>语音合成设置</div>
          <p className="text-xs theme-text-muted mb-3">TTS 服务商和 API Key 请在 <strong>模型配置 → TTS</strong> 卡片中设置。</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>提示音效</span>
            {/* 2026-08-31 修复: 此开关此前零消费者(摆设)——接通 useSoundEffects 总闸,
                即刻生效并持久化(localStorage), 保存后 config.voice.ttsFxEnabled 跨启动生效 */}
            <ToggleSwitch checked={voiceConfig.ttsFxEnabled} onChange={v => { setSoundEnabled(v); setVoiceConfig(prev => ({ ...prev, ttsFxEnabled: v })) }} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>语音交互的界面提示音（Jarvis 风格，不影响语音内容）</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>语速</span>
            <input type="range" min="0.5" max="2.0" step="0.1" value={voiceConfig.speed || 1.0} onChange={e => setVoiceConfig(prev => ({ ...prev, speed: parseFloat(e.target.value) }))} style={{ flex: 1, maxWidth: 200 }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28 }}>{voiceConfig.speed || 1.0}x</span>
          </div>
        </div>

        {/* ═══ ASR 设置（简化） ═══ */}
        <div className="p-4 rounded-lg theme-bg-tertiary">
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: 'var(--text-primary)' }}>语音识别设置</div>
          <p className="text-xs theme-text-muted mb-3">ASR 服务商和 API Key 请在 <strong>模型配置 → ASR</strong> 卡片中设置。</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 120, fontSize: 12, color: 'var(--text-secondary)', flexShrink: 0 }}>识别语言</span>
            <select className="theme-input" style={{ flex: 1, maxWidth: 200 }} value={voiceConfig.asrLang || 'zh'} onChange={e => setVoiceConfig(prev => ({ ...prev, asrLang: e.target.value }))}>
              <option value="zh">中文</option><option value="en">英文</option><option value="ja">日语</option><option value="ko">韩语</option>
            </select>
          </div>
        </div>

      </div>
    </div>
  )
}
