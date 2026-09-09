import { useState, useEffect, useRef, useMemo } from 'react'
import { Eye, EyeOff, Check, Loader2 } from 'lucide-react'
import { apiPost } from '../../lib/api'
import { getEndpoint } from '../../constants/providers'

// 2026-09-09: 从统一提供商目录派生(单一事实源)——此前向导自带硬编码表, 模型默认值
// 与 providers.ts 漂移(deepseek-chat 上游已停用仍被向导选中; 智谱仍给 glm-4-flash)
function detected(id: string, description: string): DetectedProvider {
  const ep = getEndpoint(id)
  if (!ep) throw new Error(`未知提供商: ${id}`)
  return { id: ep.id, name: ep.name, model: ep.defaultModel, baseUrl: ep.baseUrl, description }
}

// ─── API Key 自动识别 ──────────────────────────────────────

interface DetectedProvider {
  id: string
  name: string
  model: string
  baseUrl: string
  description: string
}

function detectProviderFromKey(key: string): DetectedProvider | null {
  if (!key || key.length < 8) return null

  const body = key.replace(/^sk-/, '')  // 去掉 sk- 前缀后的部分

  // 火山引擎/豆包: UUID 格式 (8-4-4-4-12)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return detected('volcengine_standard', '自动识别: 火山引擎 API')
  }

  // 智谱: 包含 . 的 key (GLM 格式: id.secret)
  if (/^[a-zA-Z0-9]{20,40}\.[a-zA-Z0-9]{8,16}$/.test(key)) {
    return detected('zhipu', '自动识别: 智谱 AI API')
  }

  // OpenAI: sk-proj- 或 sk-svcacct- 或 sk-admin- 前缀
  if (/^sk-(proj|svcacct|admin)-[a-zA-Z0-9]{20,}/.test(key)) {
    return { id: 'openai_standard', name: 'OpenAI', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', description: '自动识别: OpenAI API' }
  }

  // MiniMax: eyJ 开头 (JWT token)
  if (/^eyJ[a-zA-Z0-9+/=]{50,}/.test(key)) {
    return detected('minimax', '自动识别: MiniMax API')
  }

  // ── sk- 前缀的 key：按长度和特征区分 ──

  if (/^sk-/.test(key)) {
    // DeepSeek: sk- + 纯字母数字，典型长度 32~64 位
    // 特征：body 只含 [a-zA-Z0-9]，长度 ≥32
    // 注意：DeepSeek key 长度不固定，32~64 都有可能，必须优先于通义千问判断
    if (body.length >= 32 && /^[a-zA-Z0-9]+$/.test(body)) {
      return detected('deepseek', '自动识别: DeepSeek API')
    }

    // 通义千问: sk- + 较短的 key，body 长度 < 32
    if (body.length > 0 && body.length < 32 && /^[a-zA-Z0-9]+$/.test(body)) {
      return detected('aliyun_standard', '自动识别: 通义千问 API')
    }

    // 其他 sk- 前缀：默认 DeepSeek（兼容 OpenAI 格式）
    return detected('deepseek', '自动识别: 兼容 OpenAI 格式 (默认 DeepSeek)')
  }

  return null
}

// ─── STT/ASR 自动识别 ─────────────────────────────────────

interface DetectedASR {
  id: string
  label: string
  configFields: Array<{ key: string; label: string; placeholder: string }>
  defaults: Record<string, string>
}

function detectASRProvider(key: string): DetectedASR | null {
  if (!key || key.length < 10) return null

  // 火山引擎 ASR: UUID 格式
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    return {
      id: 'volcengine',
      label: '火山引擎 ASR',
      configFields: [
        { key: 'volcAsrApiKey', label: 'API Key', placeholder: '已自动填入' },
        { key: 'volcAsrResourceId', label: 'Resource ID', placeholder: 'volc.seedasr.sauc.duration' },
      ],
      defaults: { volcAsrResourceId: 'volc.seedasr.sauc.duration' }
    }
  }

  // 阿里云 ASR: sk- 长 key（后端契约 voice.aliyunApiKey，见 voice-asr-handler.js）
  if (/^sk-[a-zA-Z0-9]{20,}$/.test(key)) {
    return {
      id: 'aliyun',
      label: '阿里云 ASR',
      configFields: [
        { key: 'aliyunApiKey', label: 'API Key', placeholder: '已自动填入' },
      ],
      defaults: {}
    }
  }

  // 腾讯 ASR: AKID 开头
  if (/^AKID/i.test(key)) {
    return {
      id: 'tencent',
      label: '腾讯云 ASR',
      configFields: [
        { key: 'tencentSecretId', label: 'SecretId', placeholder: '已自动填入' },
        { key: 'tencentSecretKey', label: 'SecretKey', placeholder: '' },
        { key: 'tencentAppId', label: 'AppId', placeholder: '' },
      ],
      defaults: {}
    }
  }

  return null
}

// ─── TTS 自动识别 ──────────────────────────────────────────

interface DetectedTTS {
  id: string
  label: string
  configFields: Array<{ key: string; label: string; placeholder: string }>
  defaults: Record<string, string>
  voiceOptions: Array<{ value: string; label: string }>
  defaultVoice: string
  /** true 表示识别到厂商但后端 TTS 不支持，仅提示、不写入配置 */
  unsupported?: boolean
}

function detectTTSProvider(key: string): DetectedTTS | null {
  if (!key || key.length < 6) return null

  // 豆包 TTS: 通用长 key (火山引擎 token)
  if (key.length >= 20 && !key.startsWith('sk-') && !key.startsWith('eyJ')) {
    return {
      id: 'doubao',
      label: '豆包 TTS (火山引擎)',
      configFields: [
        { key: 'doubaoKey', label: 'API Key (AppId:Token)', placeholder: '已自动填入' },
        { key: 'doubaoResourceId', label: 'Resource ID', placeholder: 'seed-tts-2.0' },
      ],
      defaults: { doubaoResourceId: 'seed-tts-2.0', ttsProvider: 'doubao' },
      voiceOptions: [
        { value: 'zh_female_xiaohe_uranus_bigtts', label: '晓鹤 (女声)' },
        { value: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快斯斯 (女声)' },
        { value: 'zh_male_m191_uranus_bigtts', label: 'M191 (男声)' },
        { value: 'zh_male_xiaoma_uranus_bigtts', label: '小马 (男声)' },
      ],
      defaultVoice: 'zh_female_xiaohe_uranus_bigtts',
    }
  }

  // OpenAI TTS: sk- 前缀（后端契约 voice.openaiApiKey，见 tts/index.js _getProviderConfig）
  if (/^sk-/.test(key) && key.length > 30) {
    return {
      id: 'openai',
      label: 'OpenAI TTS',
      configFields: [
        { key: 'openaiApiKey', label: 'API Key', placeholder: '已自动填入' },
      ],
      defaults: { ttsProvider: 'openai' },
      voiceOptions: [
        { value: 'alloy', label: 'Alloy' },
        { value: 'echo', label: 'Echo' },
        { value: 'fable', label: 'Fable' },
        { value: 'onyx', label: 'Onyx' },
        { value: 'nova', label: 'Nova' },
        { value: 'shimmer', label: 'Shimmer' },
      ],
      defaultVoice: 'alloy',
    }
  }

  // MiniMax: JWT token (eyJ) —— 后端 TTS 无 minimax 提供商（tts/index.js TTS_PROVIDERS），
  // 识别到但标记 unsupported：仅提示，不写入配置（避免误判为可用 TTS 凭证）
  if (/^eyJ/.test(key)) {
    return {
      id: 'unsupported',
      label: 'MiniMax（不支持语音合成）',
      configFields: [],
      defaults: {},
      voiceOptions: [],
      defaultVoice: '',
      unsupported: true,
    }
  }

  return null
}

// ─── sk- 前缀 Key 的可选 Provider 列表 ──────────────────────

const SK_PROVIDER_OPTIONS: DetectedProvider[] = [
  detected('deepseek', 'DeepSeek'),
  detected('aliyun_standard', '通义千问'),
  { id: 'kimi', name: 'Kimi', model: 'moonshot-v1-128k', baseUrl: 'https://api.moonshot.cn/v1', description: 'Kimi' },
]

// ─── 组件 ──────────────────────────────────────────────────

interface SetupWizardProps {
  onComplete: () => void
  onStartService: () => Promise<void>
}

export function SetupWizard({ onComplete, onStartService }: SetupWizardProps) {
  // LLM
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [agentName, setAgentName] = useState('')
  const [detected, setDetected] = useState<DetectedProvider | null>(null)
  const [manualProvider, setManualProvider] = useState<string | null>(null)  // 用户手动覆盖 provider
  const detectTimer = useRef<ReturnType<typeof setTimeout>>()

  // STT
  const [sttKey, setSttKey] = useState('')
  const [showSttKey, setShowSttKey] = useState(false)
  const [sttDetected, setSttDetected] = useState<DetectedASR | null>(null)
  const [sttExtra, setSttExtra] = useState<Record<string, string>>({})

  // TTS
  const [ttsKey, setTtsKey] = useState('')
  const [showTtsKey, setShowTtsKey] = useState(false)
  const [ttsDetected, setTtsDetected] = useState<DetectedTTS | null>(null)
  const [ttsExtra, setTtsExtra] = useState<Record<string, string>>({})
  const [ttsVoice, setTtsVoice] = useState('')

  // Channel
  const [chatChannel, setChatChannel] = useState<'none' | 'lark' | 'wecom'>('none')
  const [larkAppId, setLarkAppId] = useState('')
  const [larkAppSecret, setLarkAppSecret] = useState('')
  const [wecomBotId, setWecomBotId] = useState('')
  const [wecomSecret, setWecomSecret] = useState('')
  const [wecomCorpId, setWecomCorpId] = useState('')

  // Custom endpoint
  const [showCustom, setShowCustom] = useState(false)
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')

  // Step
  const [step, setStep] = useState<'apikey' | 'wakeword' | 'taste' | 'kiosk'>('apikey')

  // Wake word
  const [wakeWord, setWakeWord] = useState('小螃蟹') // 品牌默认唤醒词
  const [testingWakeWord, setTestingWakeWord] = useState(false)
  const [wakeTestResult, setWakeTestResult] = useState<{ hits: number } | null>(null)
  const testHitsRef = useRef(0)
  const wakeTestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeOnHitUnsubRef = useRef<(() => void) | null>(null)
  const [wakeSaveError, setWakeSaveError] = useState('')

  // ── P5 音色试听 ──
  const [tasteVoice, setTasteVoice] = useState('zh-CN-XiaoxiaoNeural')
  const [tastePlaying, setTastePlaying] = useState(false)
  const [tasteError, setTasteError] = useState<string | null>(null)
  const tasteAudioRef = useRef<HTMLAudioElement | null>(null)

  const playTasteVoice = async () => {
    setTasteError(null)
    try {
      const res = await apiPost('/api/voice/tts', { text: '你好，我是 CrabPaw。有什么可以帮您？', voice: tasteVoice, speed: 1.0 })
      const data: any = res?.data
      if (!data || !data.audioBase64) {
        setTasteError('音色合成失败，请重试')
        return
      }
      setTastePlaying(true)
      if (tasteAudioRef.current) tasteAudioRef.current.pause()
      const audio = new Audio(`data:audio/${data.audioFormat || 'mp3'};base64,${data.audioBase64}`)
      tasteAudioRef.current = audio
      audio.onended = () => { setTastePlaying(false) }
      audio.onerror = () => { setTastePlaying(false); setTasteError('播放失败，请重试') }
      await audio.play()
    } catch (e) {
      console.error('[setup] 音色试听失败:', e)
      setTastePlaying(false)
      setTasteError('试听失败，请重试')
    }
  }

  // ── P5 一体机自启 ──
  const [autostartOn, setAutostartOn] = useState(false)
  const [autostartBusy, setAutostartBusy] = useState(false)
  const [autostartError, setAutostartError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const w = window.electronAPI
    if (!w || !w.app || !w.app.autostart) return
    w.app.autostart.get().then((on: boolean) => {
      if (!cancelled) setAutostartOn(!!on)
    }).catch((e: any) => {
      console.error('[setup] 读取自启状态失败:', e?.message || e)
    })
    return () => { cancelled = true }
  }, [])

  const toggleAutostart = async () => {
    const w = window.electronAPI
    if (!w || !w.app || !w.app.autostart) {
      setAutostartError('当前环境不支持自启设置（需 Electron 桌面端）')
      return
    }
    setAutostartBusy(true)
    setAutostartError(null)
    try {
      const on = await w.app.autostart.set(!autostartOn)
      setAutostartOn(!!on)
    } catch (e: any) {
      console.error('[setup] 设置自启失败:', e?.message || e)
      setAutostartError('设置失败，请重试')
    } finally {
      setAutostartBusy(false)
    }
  }

  // Cleanup wake test timer and onHit listener on unmount
  useEffect(() => {
    return () => {
      if (wakeTestTimerRef.current) clearTimeout(wakeTestTimerRef.current)
      if (wakeOnHitUnsubRef.current) { wakeOnHitUnsubRef.current(); wakeOnHitUnsubRef.current = null }
    }
  }, [])

  // State
  const [activating, setActivating] = useState(false)
  const [status, setStatus] = useState('')
  const [statusType, setStatusType] = useState<'ok' | 'err' | ''>('')

  // ── LLM Key 自动检测（防抖） ──
  useEffect(() => {
    if (detectTimer.current) clearTimeout(detectTimer.current)
    if (!apiKey.trim() || apiKey.length < 8) { setDetected(null); setManualProvider(null); return }
    detectTimer.current = setTimeout(() => {
      const d = detectProviderFromKey(apiKey.trim())
      setDetected(d)
      // sk- 前缀的 key 可能有歧义，重置手动选择让用户确认
      if (d && apiKey.trim().startsWith('sk-')) {
        setManualProvider(prev => prev && SK_PROVIDER_OPTIONS.some(p => p.id === prev) ? prev : null)
      } else {
        setManualProvider(null)
      }
    }, 400)
    return () => { if (detectTimer.current) clearTimeout(detectTimer.current) }
  }, [apiKey])

  // ── STT Key 自动检测 ──
  useEffect(() => {
    if (!sttKey.trim() || sttKey.length < 10) { setSttDetected(null); return }
    const d = detectASRProvider(sttKey.trim())
    setSttDetected(d)
    if (d) {
      const init: Record<string, string> = {}
      for (const f of d.configFields) init[f.key] = sttKey.trim()
      if (d.defaults) Object.assign(init, d.defaults)
      setSttExtra(init)
    }
  }, [sttKey])

  // ── TTS Key 自动检测 ──
  useEffect(() => {
    if (!ttsKey.trim() || ttsKey.length < 6) { setTtsDetected(null); return }
    const d = detectTTSProvider(ttsKey.trim())
    setTtsDetected(d)
    if (d && !d.unsupported) {
      const init: Record<string, string> = {}
      for (const f of d.configFields) init[f.key] = ttsKey.trim()
      if (d.defaults) Object.assign(init, d.defaults)
      setTtsExtra(init)
      if (!ttsVoice) setTtsVoice(d.defaultVoice)
    }
  }, [ttsKey])

  // ── 有效 detected：融合自动检测 + 手动覆盖 ──
  const effectiveDetected = useMemo(() => {
    if (!detected) return null
    // sk- 前缀且用户手动选择了 provider
    if (manualProvider && apiKey.trim().startsWith('sk-')) {
      const chosen = SK_PROVIDER_OPTIONS.find(p => p.id === manualProvider)
      if (chosen) return chosen
    }
    return detected
  }, [detected, manualProvider, apiKey])

  const canActivate = () => {
    if (showCustom) return !!customBaseUrl.trim() && !!customModel.trim()
    // 必须识别出厂商（自动检测或手动覆盖）才允许激活——
    // 否则提交的配置没有 models 段，后端无模型可连
    return apiKey.trim().length >= 8 && effectiveDetected != null
  }

  async function activate() {
    if (!canActivate()) {
      // Key 已输入但未能识别厂商：提示用户，不继续提交
      if (!showCustom && !effectiveDetected && apiKey.trim().length >= 8) {
        setStatus('无法识别该 Key 的厂商，请更换 Key 或使用自定义端点')
        setStatusType('err')
      }
      return
    }
    setActivating(true)
    setStatus('正在识别并连接...')
    setStatusType('')

    try {
      // 1. 构建配置
      const configPayload: any = {
        setupCompleted: true,
      }

      if (showCustom) {
        // 自定义端点
        configPayload.models = {
          providers: {
            custom: { baseUrl: customBaseUrl.trim(), apiKey: apiKey.trim() || 'none', model: customModel.trim() }
          },
          currentProvider: 'custom',
          defaultModel: customModel.trim(),
          routing: {
            chat: { provider: 'custom', model: customModel.trim(), fallback: [] },
            reasoning: { provider: 'custom', model: customModel.trim(), fallback: [] },
          }
        }
      } else if (effectiveDetected) {
        // 自动检测到的厂商（可能经用户手动覆盖）
        const providerId = effectiveDetected.id
        configPayload.models = {
          providers: { [providerId]: { baseUrl: effectiveDetected.baseUrl, apiKey: apiKey.trim(), model: effectiveDetected.model } },
          currentProvider: providerId,
          defaultModel: effectiveDetected.model,
          routing: {
            chat: { provider: providerId, model: effectiveDetected.model, fallback: [] },
            reasoning: { provider: providerId, model: effectiveDetected.model, fallback: [] },
          }
        }
      }

      // Agent name
      if (agentName.trim()) {
        configPayload.agent = { name: agentName.trim() }
      }

      // 将 STT / TTS 配置合并到 voice 字段，统一通过一次保存提交
      const voiceConfig: any = {}
      let hasVoice = false
      if (sttDetected && sttKey.trim()) {
        hasVoice = true
        for (const f of sttDetected.configFields) {
          voiceConfig[f.key] = sttExtra[f.key] || ''
        }
        // 后端契约: voice.asrProvider（voice-asr-handler.js:58 / voice-cloud-ws.js:98）
        voiceConfig.asrProvider = sttDetected.id
      }
      if (ttsDetected && ttsKey.trim()) {
        if (ttsDetected.unsupported) {
          // MiniMax 等不支持 TTS 的厂商：仅提示，不写入配置
          setStatus(`语音合成跳过：${ttsDetected.label}。该 Key 无法用于 TTS，请使用豆包/OpenAI/火山引擎的 Key`)
          setStatusType('err')
        } else {
          hasVoice = true
          voiceConfig.ttsProvider = ttsDetected.id
          // 音色持久化契约: 前端 useVoiceReply 读取 voice.defaultVoice（doubao 时读 doubaoVoice），
          // 后端 TTS 引擎按请求参数取音色（tts/index.js synthesize options.voice）
          voiceConfig.defaultVoice = ttsVoice || ttsDetected.defaultVoice
          if (ttsDetected.id === 'doubao') voiceConfig.doubaoVoice = ttsVoice || ttsDetected.defaultVoice
          for (const f of ttsDetected.configFields) {
            voiceConfig[f.key] = ttsExtra[f.key] || ''
          }
        }
      }
      if (hasVoice) {
        // P2(GUI 全量修复 P0): 向导配置好语音后必须开启"语音回复"——后端 config
        // 默认 replyEnabled=false, 不写则首启用户配完 TTS 试听成功进主界面后
        // 说话无任何语音回应(useVoiceReply 直接 skip), 直到手动去设置页打开
        voiceConfig.replyEnabled = true
        configPayload.voice = voiceConfig
      }

      // 消息通道配置
      if (chatChannel !== 'none') {
        if (chatChannel === 'lark' && larkAppId.trim()) {
          configPayload.lark = { appId: larkAppId.trim(), appSecret: larkAppSecret.trim() }
          configPayload.chatChannel = ['lark']
        }
        if (chatChannel === 'wecom' && wecomBotId.trim()) {
          configPayload.wecom = { botId: wecomBotId.trim(), secret: wecomSecret.trim(), corpId: wecomCorpId.trim() }
          configPayload.chatChannel = ['wecom']
        }
      }

      // 保存全部配置（一次调用，IPC 和 HTTP 共用）
      if (window.electronAPI?.config?.set) {
        await window.electronAPI.config.set(configPayload)
      } else {
        await apiPost('/config', configPayload)
      }

      // 启动服务，等后端就绪后再退出向导
      setStatus(effectiveDetected ? `识别成功: ${effectiveDetected.name} · ${effectiveDetected.model}。正在启动服务...` : '配置已保存，正在启动服务...')
      setStatusType('ok')
      await onStartService()
      setStep('wakeword')

    } catch (e: any) {
      setStatus('连接失败: ' + (e.message || '未知错误'))
      setStatusType('err')
    } finally {
      setActivating(false)
    }
  }

  const testWakeWord = () => {
    const w = window.electronAPI
    if (!w || !w.wake) { setWakeTestResult({ hits: 0 }); return }
    setTestingWakeWord(true)
    setWakeTestResult(null)
    setWakeSaveError('')
    testHitsRef.current = 0
    if (wakeOnHitUnsubRef.current) { wakeOnHitUnsubRef.current(); wakeOnHitUnsubRef.current = null }
    const off = w.wake.onHit(() => { testHitsRef.current += 1 })
    wakeOnHitUnsubRef.current = off
    wakeTestTimerRef.current = setTimeout(() => {
      off()
      wakeOnHitUnsubRef.current = null
      setTestingWakeWord(false)
      setWakeTestResult({ hits: testHitsRef.current })
    }, 6000)
  }

  const saveWakeWordAndFinish = async () => {
    setWakeSaveError('')

    // client-side validation: must be 2-6 Chinese characters
    if (!/^[一-龥]{2,6}$/.test(wakeWord)) {
      setWakeSaveError('唤醒词需为 2-6 个汉字')
      return
    }

    try {
      const w = window.electronAPI
      if (!w || !w.wake) {
        setWakeSaveError('唤醒词保存失败：当前环境不支持唤醒词功能')
        return
      }
      // 2026-08-06: 多唤醒词——用户选词 + 品牌默认"小龙女"常驻（老板喊名字自然，品牌词兜底）
      const wakeWords: string[] = [...new Set([wakeWord, '小龙女'])].filter((w): w is string => !!w)
      const res = await w.wake.setKeyword(wakeWords)
      if (res && res.ok === false) {
        setWakeSaveError(res.error || '唤醒词保存失败，请重试')
        return
      }
      if (w && w.config) {
        try {
          await w.config.set({ ...(await w.config.get() || {}), wakeWord: wakeWords })
        } catch (configErr) {
          console.warn('[setup] 唤醒词已设置但配置持久化失败:', configErr)
        }
      } else {
        console.warn('[setup] w.config 不可用，唤醒词仅设置未持久化到配置文件')
      }
      setStep('taste')
    } catch (err) {
      console.error('[setup] 保存唤醒词失败:', err)
      setWakeSaveError('唤醒词保存失败，请重试')
    }
  }

  return (
    <div className="flex items-center justify-center min-h-full p-6 theme-bg-primary">
      <div style={{
        width: 480, maxWidth: '100%', padding: '28px 28px 24px', borderRadius: 18,
        border: '1px solid var(--border-primary)',
        background: 'var(--bg-secondary)',
        boxShadow: '0 24px 80px rgba(0,0,0,0.25)',
      }}>
        <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          {step === 'apikey' ? '激活 CrabPaw' : step === 'wakeword' ? '设置唤醒词' : step === 'taste' ? '试听音色' : '一体机模式'}
        </h1>
        <p style={{ margin: '0 0 22px', fontSize: 13, color: 'var(--text-muted)' }}>
          {step === 'apikey' ? '输入 API Key，自动识别厂商并完成配置。' : step === 'wakeword' ? '唤醒后即可语音对话（如"小螃蟹，今天天气如何"）' : step === 'taste' ? '选一个喜欢的播报音色，点"试听"听效果。' : '开机自启 + 全屏待机，让 CrabPaw 成为你的数字员工。'}
        </p>

        {/* ── API Key 步骤 ── */}
        {step === 'apikey' && (
          <>

        {/* ── LLM Key ── */}
        <Row label="LLM Key">
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canActivate()) activate() }}
              placeholder="粘贴 API Key"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              style={{
                width: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent',
                color: 'var(--text-primary)', padding: '11px 70px 11px 0', fontSize: 14, outline: 'none',
              }}
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-muted)',
              }}
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            {detected && !apiKey.trim().startsWith('sk-') && (
              <span style={{
                position: 'absolute', right: 36, top: '50%', transform: 'translateY(-50%)',
                padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                color: '#7dd8f5', background: 'rgba(100,200,245,0.12)',
                border: '1px solid rgba(100,200,245,0.25)', whiteSpace: 'nowrap',
              }}>
                <Check size={10} style={{ marginRight: 3, verticalAlign: -1 }} />
                {detected.name}
              </span>
            )}
            {/* sk- 前缀的 key 格式有歧义，提供 provider 下拉选择器 */}
            {detected && apiKey.trim().startsWith('sk-') && (
              <select
                value={manualProvider || effectiveDetected?.id || ''}
                onChange={e => setManualProvider(e.target.value)}
                style={{
                  position: 'absolute', right: 36, top: '50%', transform: 'translateY(-50%)',
                  padding: '2px 6px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                  color: '#7dd8f5', background: 'rgba(100,200,245,0.12)',
                  border: '1px solid rgba(100,200,245,0.25)', whiteSpace: 'nowrap',
                  cursor: 'pointer', outline: 'none',
                  appearance: 'none',
                  paddingRight: 18,
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%237dd8f5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 4px center',
                }}
              >
                {SK_PROVIDER_OPTIONS.map(p => (
                  <option key={p.id} value={p.id} style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Row>
        <RowHint>支持 DeepSeek、火山引擎、智谱、通义千问、Kimi、OpenAI 等兼容 API{apiKey.trim().startsWith('sk-') && detected ? ' · 点击右上角标签可切换厂商' : ''}</RowHint>

        {/* ── AI 名称 ── */}
        <Row label="AI 名称">
          <input
            type="text"
            value={agentName}
            onChange={e => setAgentName(e.target.value)}
            maxLength={32}
            placeholder="可选，如：小龙马、Friday"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)',
              padding: '11px 0', fontSize: 14, outline: 'none',
            }}
          />
        </Row>

        {/* ── 可选分隔 ── */}
        <SectionDivider>可选 · 可不填</SectionDivider>

        {/* ── STT ── */}
        <div style={{ marginBottom: 12 }}>
          <Row label="语音识别 Key">
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type={showSttKey ? 'text' : 'password'}
                value={sttKey}
                onChange={e => setSttKey(e.target.value)}
                placeholder="粘贴 Key 自动识别厂商"
                spellCheck={false}
                autoComplete="off"
                style={{
                  width: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent',
                  color: 'var(--text-primary)', padding: '11px 80px 11px 0', fontSize: 14, outline: 'none',
                }}
              />
              <button onClick={() => setShowSttKey(!showSttKey)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                {showSttKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              {sttDetected && (
                <span style={{ position: 'absolute', right: 34, top: '50%', transform: 'translateY(-50%)', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, color: '#7dd8f5', background: 'rgba(100,200,245,0.12)', border: '1px solid rgba(100,200,245,0.25)', whiteSpace: 'nowrap' }}>
                  {sttDetected.label}
                </span>
              )}
            </div>
          </Row>
          {sttDetected?.configFields.filter(f => f.key !== sttDetected.configFields[0].key).map(f => (
            <Row key={f.key} label={f.label}>
              <input type="text" value={sttExtra[f.key] || ''} onChange={e => setSttExtra(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder} spellCheck={false}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '10px 0', fontSize: 13, outline: 'none' }} />
            </Row>
          ))}
        </div>

        {/* ── TTS ── */}
        <div style={{ marginBottom: 16 }}>
          <Row label="语音合成 Key">
            <div style={{ position: 'relative', flex: 1 }}>
              <input
                type={showTtsKey ? 'text' : 'password'}
                value={ttsKey}
                onChange={e => setTtsKey(e.target.value)}
                placeholder="粘贴 Key 自动识别厂商"
                spellCheck={false}
                autoComplete="off"
                style={{
                  width: '100%', boxSizing: 'border-box', border: 'none', background: 'transparent',
                  color: 'var(--text-primary)', padding: '11px 80px 11px 0', fontSize: 14, outline: 'none',
                }}
              />
              <button onClick={() => setShowTtsKey(!showTtsKey)}
                style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                {showTtsKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              {ttsDetected && (
                <span style={{ position: 'absolute', right: 34, top: '50%', transform: 'translateY(-50%)', padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, color: '#7dd8f5', background: 'rgba(100,200,245,0.12)', border: '1px solid rgba(100,200,245,0.25)', whiteSpace: 'nowrap' }}>
                  {ttsDetected.label}
                </span>
              )}
            </div>
          </Row>
          {ttsDetected?.voiceOptions && ttsDetected.voiceOptions.length > 0 && (
            <Row label="音色">
              <select value={ttsVoice} onChange={e => setTtsVoice(e.target.value)}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '10px 0', fontSize: 14, outline: 'none', cursor: 'pointer' }}>
                {ttsDetected.voiceOptions.map(v => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
            </Row>
          )}
          {ttsDetected?.configFields.filter(f => f.key !== ttsDetected.configFields[0].key).map(f => (
            <Row key={f.key} label={f.label}>
              <input type="text" value={ttsExtra[f.key] || ''} onChange={e => setTtsExtra(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder} spellCheck={false}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '10px 0', fontSize: 13, outline: 'none' }} />
            </Row>
          ))}
        </div>

        {/* ── 消息通道（可选） ── */}
        <SectionDivider>消息通道 · 可选</SectionDivider>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {[
            { id: 'none' as const, label: '桌面端', emoji: '🦀' },
            { id: 'lark' as const, label: '飞书', emoji: '🐦' },
            { id: 'wecom' as const, label: '企业微信', emoji: '💼' },
          ].map(c => (
            <button key={c.id} onClick={() => setChatChannel(c.id)}
              style={{
                flex: 1, padding: '10px 0', borderRadius: 10, border: `2px solid ${chatChannel === c.id ? 'var(--accent-primary)' : 'var(--border-primary)'}`,
                background: chatChannel === c.id ? 'rgba(53,114,255,0.1)' : 'var(--bg-primary)',
                color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', fontWeight: chatChannel === c.id ? 600 : 400,
                transition: 'all 0.15s',
              }}>
              <span style={{ marginRight: 4 }}>{c.emoji}</span>{c.label}
            </button>
          ))}
        </div>
        {chatChannel === 'lark' && <>
          <Row label="App ID"><input type="text" value={larkAppId} onChange={e => setLarkAppId(e.target.value)} placeholder="飞书应用 App ID" spellCheck={false} autoComplete="off" style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} /></Row>
          <Row label="App Secret"><input type="password" value={larkAppSecret} onChange={e => setLarkAppSecret(e.target.value)} placeholder="飞书应用 Secret" spellCheck={false} autoComplete="off" style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} /></Row>
        </>}
        {chatChannel === 'wecom' && <>
          <Row label="Corp ID"><input type="text" value={wecomCorpId} onChange={e => setWecomCorpId(e.target.value)} placeholder="企业 CorpID" spellCheck={false} autoComplete="off" style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} /></Row>
          <Row label="Bot ID"><input type="text" value={wecomBotId} onChange={e => setWecomBotId(e.target.value)} placeholder="机器人 Bot ID" spellCheck={false} autoComplete="off" style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} /></Row>
          <Row label="Secret"><input type="password" value={wecomSecret} onChange={e => setWecomSecret(e.target.value)} placeholder="机器人 Secret" spellCheck={false} autoComplete="off" style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} /></Row>
        </>}

        {/* ── 激活按钮 ── */}
        <div style={{ marginBottom: 12 }}>
          <button
            onClick={activate}
            disabled={!canActivate() || activating}
            style={{
              width: '100%', border: 'none', borderRadius: 12,
              background: canActivate() ? 'linear-gradient(135deg, #4f8cff, #3572ff)' : 'var(--bg-tertiary)',
              color: canActivate() ? '#fff' : 'var(--text-muted)',
              padding: '10px 16px', fontSize: 14, fontWeight: 600, cursor: canActivate() ? 'pointer' : 'not-allowed',
              transition: 'transform 0.15s, opacity 0.15s',
            }}
          >
            {activating ? <><Loader2 size={14} style={{ marginRight: 6, animation: 'spin 1s linear infinite' }} />连接中...</> :
              detected ? '激活并进入' : '激活并进入'}
          </button>
        </div>

        {/* ── 状态 ── */}
        {status && (
          <div style={{ fontSize: 13, color: statusType === 'err' ? '#ff8f8f' : statusType === 'ok' ? '#74d89f' : 'var(--text-muted)', minHeight: 20, marginBottom: 8 }}>
            {status}
          </div>
        )}


        {/* ── 自定义端点 ── */}
        <button
          onClick={() => setShowCustom(!showCustom)}
          style={{
            display: 'block', margin: '0 auto', background: 'none', border: 'none',
            fontSize: 12, color: showCustom ? '#74a8ff' : 'var(--text-muted)',
            cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3,
          }}
        >
          {showCustom ? '收起自定义端点' : '或使用本地 / 私有部署模型'}
        </button>

        {showCustom && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--border-primary)', paddingTop: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.06em' }}>自定义端点</div>
            <Row label="Base URL">
              <input type="text" value={customBaseUrl} onChange={e => setCustomBaseUrl(e.target.value)}
                placeholder="如 http://localhost:11434/v1" spellCheck={false}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} />
            </Row>
            <Row label="模型">
              <input type="text" value={customModel} onChange={e => setCustomModel(e.target.value)}
                placeholder="如 llama3.2, qwen2.5, mistral" spellCheck={false}
                onKeyDown={e => { if (e.key === 'Enter' && canActivate()) activate() }}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} />
            </Row>
            <Row label="API Key">
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder="本地模型可留空" spellCheck={false}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text-primary)', padding: '11px 0', fontSize: 14, outline: 'none' }} />
            </Row>
          </div>
        )}

        <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
          配置信息仅保存在本地 config.json，不会上传到任何服务器。<br />
          后续可在 <strong>⚙ 管理舱 → 系统设置</strong> 中修改。
        </p>
        </>
        )}

        {/* ── 唤醒词步骤 ── */}
        {step === 'wakeword' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, paddingTop: 24, paddingBottom: 24 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {['小螃蟹', '你好助手', '聪明助手', '帮我一下'].map(preset => (
                <button
                  key={preset}
                  onClick={() => setWakeWord(preset)}
                  style={{
                    padding: '8px 16px', borderRadius: 8, border: '1px solid',
                    borderColor: wakeWord === preset ? 'var(--accent-primary)' : 'var(--border-primary)',
                    color: wakeWord === preset ? 'var(--accent-primary)' : 'var(--text-primary)',
                    background: 'transparent', fontSize: 14, cursor: 'pointer',
                    transition: 'border-color 0.15s',
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
            <input
              value={wakeWord}
              onChange={e => setWakeWord(e.target.value)}
              maxLength={6}
              placeholder="自定义唤醒词（2-6 个汉字）"
              style={{
                padding: '8px 16px', borderRadius: 8,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-primary)',
                color: 'var(--text-primary)',
                outline: 'none', width: 256, textAlign: 'center', fontSize: 14,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                onClick={testWakeWord}
                disabled={testingWakeWord}
                style={{
                  padding: '8px 16px', borderRadius: 8,
                  background: testingWakeWord ? 'var(--bg-tertiary)' : 'var(--accent-primary)',
                  color: testingWakeWord ? 'var(--text-muted)' : '#fff',
                  border: 'none', fontSize: 13, cursor: testingWakeWord ? 'not-allowed' : 'pointer',
                  opacity: testingWakeWord ? 0.5 : 1,
                }}
              >
                {testingWakeWord ? '聆听中…请说 3 遍' : '测试唤醒词'}
              </button>
              {wakeTestResult !== null && (
                <span style={{
                  fontSize: 13,
                  color: wakeTestResult.hits >= 2 ? '#74d89f' : '#f0c060',
                }}>
                  命中 {wakeTestResult.hits}/3 — {wakeTestResult.hits >= 2 ? '效果好，可继续' : '建议换一个词或换个语调再试'}
                </span>
              )}
            </div>
            {wakeSaveError && (
              <div style={{ fontSize: 13, color: '#ff8f8f', textAlign: 'center' }}>
                {wakeSaveError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
              <button
                onClick={() => setStep('taste')}
                style={{
                  padding: '8px 16px', borderRadius: 8,
                  border: '1px solid var(--border-primary)',
                  background: 'transparent', color: 'var(--text-primary)',
                  fontSize: 13, cursor: 'pointer',
                }}
              >
                跳过
              </button>
              <button
                onClick={saveWakeWordAndFinish}
                style={{
                  padding: '8px 24px', borderRadius: 8,
                  background: 'var(--accent-primary)', color: '#fff',
                  border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {/* P3(GUI 全量修复): 旧文案"完成"误导——点击后还有"试听音色/一体机"
                    两步, 用户以为向导已结束。改"保存并继续"如实描述行为 */}
                保存并继续
              </button>
            </div>
          </div>
        )}

        {/* ── 音色试听步骤（P5 一体机） ── */}
        {step === 'taste' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 16, paddingBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-liaoning-XiaobeiNeural'].map(v => (
                <button
                  key={v}
                  onClick={() => setTasteVoice(v)}
                  style={{
                    padding: '8px 14px', borderRadius: 8, border: '1px solid',
                    borderColor: tasteVoice === v ? 'var(--accent-primary)' : 'var(--border-primary)',
                    color: tasteVoice === v ? 'var(--accent-primary)' : 'var(--text-primary)',
                    background: 'transparent', fontSize: 13, cursor: 'pointer',
                  }}
                >
                  {({ 'zh-CN-XiaoxiaoNeural': '晓晓（女·温和）', 'zh-CN-YunxiNeural': '云希（男·阳光）', 'zh-CN-XiaoyiNeural': '晓伊（女·甜润）', 'zh-CN-YunjianNeural': '云健（男·浑厚）', 'zh-CN-liaoning-XiaobeiNeural': '晓北（东北·亲切）' } as Record<string, string>)[v]}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={playTasteVoice}
                disabled={tastePlaying}
                style={{
                  padding: '8px 20px', borderRadius: 8,
                  background: tastePlaying ? 'var(--bg-tertiary)' : 'var(--accent-primary)',
                  color: tastePlaying ? 'var(--text-muted)' : '#fff',
                  border: 'none', fontSize: 13, cursor: tastePlaying ? 'not-allowed' : 'pointer',
                }}
              >
                {tastePlaying ? '播放中…' : '🔊 试听'}
              </button>
              {tasteError && <span style={{ fontSize: 12, color: '#ff8f8f' }}>{tasteError}</span>}
            </div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 8 }}>
              <button
                onClick={() => setStep('wakeword')}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)',
                  background: 'transparent', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer',
                }}
              >
                上一步
              </button>
              <button
                onClick={() => setStep('kiosk')}
                style={{
                  padding: '8px 24px', borderRadius: 8, background: 'var(--accent-primary)',
                  color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                下一步
              </button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
              试听仅预览，正式音色请在 ⚙ 管理舱 → 系统设置 → 语音中调整
            </p>
          </div>
        )}

        {/* ── 一体机模式步骤（P5） ── */}
        {step === 'kiosk' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 16, paddingBottom: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.6 }}>
              一体机部署提示：
              <ul style={{ margin: '8px 0 0 18px', padding: 0, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.8 }}>
                <li>全屏待机：以 <code>--kiosk</code> 参数启动（部署手册有说明）</li>
                <li>触摸操作：按住屏幕中央的球即可说话（PTT）</li>
                <li>屏幕常亮：kiosk 模式自动保持屏幕不熄</li>
              </ul>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={autostartOn}
                onChange={toggleAutostart}
                disabled={autostartBusy}
              />
              开机自启（登录后自动进入全屏待机）
            </label>
            {autostartError && <span style={{ fontSize: 12, color: '#ff8f8f' }}>{autostartError}</span>}
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 12 }}>
              <button
                onClick={() => setStep('taste')}
                style={{
                  padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-primary)',
                  background: 'transparent', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer',
                }}
              >
                上一步
              </button>
              <button
                onClick={onComplete}
                style={{
                  padding: '8px 24px', borderRadius: 8, background: 'var(--accent-primary)',
                  color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                完成，进入 CrabPaw
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 子组件 ────────────────────────────────────────────────

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', marginBottom: 8,
      border: '1px solid var(--border-primary)', borderRadius: 12,
      background: 'var(--bg-primary)',
    }}>
      <label style={{
        flex: '0 0 78px', margin: 0, padding: '0 8px 0 14px',
        display: 'flex', alignItems: 'center', fontSize: 12,
        color: 'var(--text-muted)', borderRight: '1px solid var(--border-primary)',
        borderRadius: '11px 0 0 11px', background: 'var(--bg-tertiary)',
        lineHeight: 1.3,
      }}>{label}</label>
      {children}
    </div>
  )
}

function RowHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ margin: '0 0 14px 14px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
      {children}
    </div>
  )
}

function SectionDivider({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 14px',
      fontSize: 11, color: 'var(--text-muted)', fontWeight: 500,
    }}>
      <span style={{ flex: 1, height: 1, background: 'var(--border-primary)' }} />
      {children}
      <span style={{ flex: 1, height: 1, background: 'var(--border-primary)' }} />
    </div>
  )
}
