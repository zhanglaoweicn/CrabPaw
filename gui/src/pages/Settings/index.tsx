import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { toast } from 'sonner'
import { useConfirm } from '../../components/useConfirm'
import {
  User,
  Users,
  Shield,
  RefreshCw,
  Save,
  Settings2,
  Archive,
  MessageSquare,
  AlertTriangle,
  RotateCcw,
  Volume2,
  Search,
  Palette,
  Store,
  Image as ImageIcon
} from 'lucide-react'
import { apiGet, apiPost, apiPatch, apiDelete, clearCredentialsCache, resolveApiUrl } from '../../lib/api'
import { useTheme } from '../../contexts/ThemeContext'
import { SettingsAppearance } from '../../components/SettingsSections/Appearance'
import { isDevMode, setDevMode } from '../../lib/dev-mode'
import { SettingsBackup } from '../../components/SettingsSections/Backup'
import {
  DEFAULT_PROVIDERS,
  DEFAULT_IMAGE_PROVIDERS,
  DEFAULT_VIDEO_PROVIDERS,
  DEFAULT_VISION_PROVIDERS,
  PROVIDER_ENDPOINTS,
} from '../../constants/providers'
import { ModelConfig } from '../../components/ModelConfig'
import { ModelMarketplace } from '../../components/ModelMarketplace'
import { UserSection, ProfileSection, ChannelSection, SecuritySection, SearchSection, VoiceSection, UpdateSection, PosterSection } from './sections'

export interface SettingsHandle {
  hasUnsavedChanges: boolean
}

type SettingsProps = {
  navSection?: string | null
  onNavConsumed?: () => void
  /** G1: 未保存状态对外广播——宿主(如 VoiceShell 配置面板)关闭前确认。
   *  lazy 组件不透传 ref,用回调比 ref 可靠。可选,不影响 Dashboard 现有用法。 */
  onDirtyChange?: (dirty: boolean) => void
}

const SettingsComponent = (props: SettingsProps, ref: React.Ref<SettingsHandle>) => {
  const { navSection, onNavConsumed } = props
  const { theme, accentColor, setTheme, setAccentColor } = useTheme()

  // 脱敏工具函数：mask apiKey/token/appSecret 等敏感字段
  const maskSecrets = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj
    if (Array.isArray(obj)) return obj.map(maskSecrets)
    const masked: any = {}
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase()
      if (typeof v === 'string' && v.length > 0 && (
        lower.includes('key') || lower.includes('token') || lower.includes('secret') ||
        lower.includes('appid') || lower.includes('accesskey')
      )) {
        masked[k] = v.length <= 8 ? '***' : v.substring(0, 4) + '***' + v.substring(v.length - 4)
      } else if (typeof v === 'object' && v !== null) {
        masked[k] = maskSecrets(v)
      } else {
        masked[k] = v
      }
    }
    return masked
  }

  const [saving, setSaving] = useState(false)
  const [showApiKeys, setShowApiKeys] = useState<Record<string, boolean>>({})
  // Profile 状态
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; description: string; icon: string; createdAt: number | null; isDefault: boolean }>>([])
  const [activeProfile, setActiveProfile] = useState('default')
  const [newProfileName, setNewProfileName] = useState('')
  const [newProfileDesc, setNewProfileDesc] = useState('')
  const [newProfileIcon, setNewProfileIcon] = useState('🤖')
  const [profileLoading, setProfileLoading] = useState(false)
  // Tools 工具集开关状态
  const [isRefreshing, setIsRefreshing] = useState(false)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)

  // 响应外部导航（如 Gateway ?Settings?
  const [activeSection, setActiveSection] = useState<string>('user')

  // 2026-08-19 审计修复: 依赖 [] → [navSection]——管理舱此前以 key 强制重挂配合消费清空
  // section,导致导航定位 1 帧后闪回默认页(key 变化触发卸载重挂,activeSection 回初始值)。
  // 去 key 后由本 effect 承载重复定位:消费后 navSection=null 时条件不成立不动作;再次导航重新定位。
  useEffect(() => {
    if (navSection) {
      setActiveSection(navSection)
      onNavConsumed?.()
    }
  }, [navSection])
  
  const [userConfig, setUserConfig] = useState({
    name: '',
    callMe: '',
    timezone: 'Asia/Shanghai',
    notes: '',
    larkUserId: '',
    wecomUserId: '',
    syncMode: 'gui_user' as 'gui_user' | 'lark_sync' | 'wecom_sync'
  })

  const [assistantConfig, setAssistantConfig] = useState({
    name: 'CrabPaw',
    emoji: '🦀',
    vibe: '专业、简洁',
    systemPrompt: '你是一个智能助手'
  })

  const [modelConfig, setModelConfig] = useState({
    currentProvider: 'deepseek',
    defaultModel: 'deepseek',
    toolProfile: 'coding',
    providers: DEFAULT_PROVIDERS as Record<string, { baseUrl: string; apiKey: string; model: string }>
  })

  const [larkConfig, setLarkConfig] = useState({
    appId: '',
    appSecret: ''
  })

  const [wecomConfig, setWecomConfig] = useState({
    corpId: '',
    botId: '',
    secret: ''
  })

  const [chatChannel, setChatChannel] = useState<'none' | 'lark' | 'wecom'>('none')
  
  const [securityConfig, setSecurityConfig] = useState({
    enableWhitelist: false,
    allowedUsers: [] as string[],
    level: 'standard' as string,
    approvalMode: 'smart' as string,
    promptInjectionEnabled: true,
    filesystemEnabled: true,
    sessionIsolationEnabled: true,
    // 2026-08-28 发布项: 远程技能安装默认关闭（技能=本机信任域）
    remoteInstallEnabled: false
  })
  const LEVEL_TO_BACKEND: Record<string, string> = {
    low: 'disabled', medium: 'standard', high: 'strict',
    disabled: 'disabled', standard: 'standard', strict: 'strict',
  }
  const BACKEND_TO_LEVEL: Record<string, string> = {
    disabled: 'low', standard: 'medium', strict: 'high',
    basic: 'low', paranoid: 'high',
  }

  const [searchQuery, setSearchQuery] = useState('')
  const [diffDialog, setDiffDialog] = useState<{ open: boolean; profileId: string; profileName: string; diffs: Array<{ key: string; value1: any; value2: any; type: string }> } | null>(null)
  const [editDialog, setEditDialog] = useState<{ open: boolean; id: string; name: string; description: string; icon: string } | null>(null)
  const [fallbackConfig, setFallbackConfig] = useState({
    fallbackModel: {
      provider: '',
      model: '',
      baseUrl: '',
    },
    auxiliary: {
      vision: { provider: 'auto', model: '' },
      compression: { provider: 'auto', model: '' },
    }
  })

  const [voiceConfig, setVoiceConfig] = useState({
    replyEnabled: true,
    ttsProvider: "edge-tts" as string,
    defaultVoice: "zh-CN-XiaoxiaoNeural",
    speed: 1.0,
    doubaoKey: "",
    doubaoAccessKey: "",
    doubaoAppId: "",
    doubaoResourceId: "",
    doubaoVoice: "zh_female_xiaohe_uranus_bigtts",
    asrProvider: "volcengine",
    volcAsrApiKey: "",
    volcAsrAppKey: "",
    volcAsrAccessKey: "",
    volcAsrResourceId: "",
    lang: "zh",
    micDeviceId: "",
    continuousMode: false,
    wakeWordEnabled: true,
    voiceThreshold: 0.008,
    ttsFxEnabled: true,
    outputDeviceId: "",
    volcanoAppId: "",
    volcanoToken: "",
    volcanoVoice: "BV001_streaming",
    aliyunApiKey: "",
    aliyunModel: "fun-asr-realtime-2026-02-28",
    asrLang: "zh",
  })

  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([])

  // 枚举音频设备（先请求权限确保 label 完整）
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
      if (stream) stream.getTracks().forEach(t => t.stop())
    } catch { console.warn('[Settings] getUserMedia 权限请求失败') }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setMicDevices(devices.filter(d => d.kind === 'audioinput'))
      setAudioOutputs(devices.filter(d => d.kind === 'audiooutput'))
    } catch { console.warn('[Settings] enumerateDevices 枚举设备失败') }
  }, [])

  useEffect(() => {
    refreshDevices()
    const handler = () => refreshDevices()
    navigator.mediaDevices?.addEventListener('devicechange', handler)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', handler)
  }, [refreshDevices])

  // 开机自启：进入时读取状态；切换时写入（与 SetupWizard kiosk 步骤同 IPC）
  useEffect(() => {
    const w = window.electronAPI
    if (!w?.app?.autostart) return
    let cancelled = false
    w.app.autostart.get().then((on: boolean) => {
      if (!cancelled) setAutostartOn(!!on)
    }).catch((e: any) => {
      console.error('[Settings] 读取开机自启状态失败:', e?.message || e)
    })
    return () => { cancelled = true }
  }, [])

  const toggleAutostart = async () => {
    const w = window.electronAPI
    if (!w?.app?.autostart) return
    setAutostartBusy(true)
    setAutostartError('')
    try {
      const on = await w.app.autostart.set(!autostartOn)
      setAutostartOn(!!on)
    } catch (e: any) {
      console.error('[Settings] 设置开机自启失败:', e?.message || e)
      setAutostartError('设置失败，请重试')
    } finally {
      setAutostartBusy(false)
    }
  }

  const [searchConfig, setSearchConfig] = useState({
    tavilyApiKey: '',
    bingApiKey: '',
    baiduApiKey: '',
  })

  const [imageGenConfig, setImageGenConfig] = useState({
    provider: 'doubao',
    model: 'doubao-seedream-5-0-260128',
    providers: DEFAULT_IMAGE_PROVIDERS as Record<string, { baseUrl: string; apiKey: string; model: string }>
  })

  const [videoGenConfig, setVideoGenConfig] = useState({
    provider: 'doubao',
    model: 'Doubao-Seedance-1.5-pro',
    providers: DEFAULT_VIDEO_PROVIDERS as Record<string, { baseUrl: string; apiKey: string; model: string }>
  })

  const [visionConfig, setVisionConfig] = useState({
    provider: 'doubao',
    model: 'doubao-seed-vision',
    providers: DEFAULT_VISION_PROVIDERS as Record<string, { baseUrl: string; apiKey: string; model: string }>
  })

  const [updateConfig, setUpdateConfig] = useState({
    updateUrl: '',
    autoCheck: true,
    lastCheck: ''
  })
  
  const [updateStatus, setUpdateStatus] = useState<{
    checking: boolean
    hasUpdate: boolean
    latestVersion: string
    currentVersion: string
    error: string
  }>({
    checking: false,
    hasUpdate: false,
    latestVersion: '',
    currentVersion: '1.0.0',
    error: ''
  })
  
  const [backups, setBackups] = useState<Array<{
    name: string
    size: number
    createdAt: string
  }>>([])
  const [backupLoading, setBackupLoading] = useState(false)
  
  const [loadError, setLoadError] = useState<string>('')
  // 2026-08-12: 开机自启开关（electronAPI.app.autostart，Web 预览环境隐藏）
  const [autostartOn, setAutostartOn] = useState<boolean | null>(null)
  const [autostartBusy, setAutostartBusy] = useState(false)
  const [autostartError, setAutostartError] = useState('')
  // M1 fix: confirmDialog 已合并到 useConfirm（askConfirm），消除双确认机制并存
  const { confirmNode, askConfirm } = useConfirm()
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const initialLoadDone = useRef(false)
  const prevSaving = useRef(saving)
  const initialConfigSnapshot = useRef<string>('')
  // 基准快照就绪信号: 每次对齐后递增,驱动 dirty effect 主动对比一次
  // (2026-08-19 审计修复: 快照捕获用 ref 不触发渲染,对比曾依赖"下次渲染"而可能永不
  // 发生或发生在错误时机;改为 state 信号显式驱动)
  const [snapshotReady, setSnapshotReady] = useState(0)

  // 获取当前配置快照
  const getConfigSnapshot = useCallback(() => {
    return JSON.stringify({
      modelConfig, userConfig, assistantConfig, larkConfig, wecomConfig,
      chatChannel, securityConfig, voiceConfig, updateConfig, imageGenConfig, videoGenConfig, visionConfig,
      fallbackConfig, searchConfig
    })
  }, [modelConfig, userConfig, assistantConfig, larkConfig, wecomConfig, chatChannel, securityConfig, voiceConfig, updateConfig, imageGenConfig, videoGenConfig, visionConfig, fallbackConfig, searchConfig])

  // 2026-08-19 审计修复(第二轮): 异步回调必须读最新渲染帧的快照——
  // loadConfigs().then 闭包捕获的是 R0 渲染帧的 getConfigSnapshot(useCallback 引用),
  // 后续渲染不会更新闭包;若对齐循环直接用它,快照恒为默认值 → 加载后渲染对比恒不等
  // → 未修改也恒 dirty("保存所有 *"常亮 + 切 tab 恒弹确认)。
  // ref 每次渲染同步最新引用,异步对齐循环经 ref 读取永远是最新 state。
  const getConfigSnapshotRef = useRef(getConfigSnapshot)
  getConfigSnapshotRef.current = getConfigSnapshot

  useEffect(() => {
    mountedRef.current = true
    loadConfigs().then(() => {
      initialLoadDone.current = true
      // 2026-08-19 审计修复: 快照对齐循环(经 ref 读最新渲染帧)——旧实现 setTimeout(0)
      // 一次性捕获且闭包持有 R0 帧的 getConfigSnapshot,快照恒为默认值 → 加载后对比恒
      // 不等 → 未修改也恒 dirty。对齐循环: 捕获(经 ref=最新 state) → snapshotReady 主动
      // 驱动对比 → 若 setState 渲染晚于宏任务(React 18 并发调度),下一次对齐(50ms)时
      // ref 已指向加载后值 → 收敛。≤3 次(150ms)内基准=加载后稳定值,无修改恒 false。
      const align = (attempt = 0) => {
        initialConfigSnapshot.current = getConfigSnapshotRef.current()
        setSnapshotReady(v => v + 1)
        if (attempt < 2) setTimeout(() => align(attempt + 1), 50)
      }
      setTimeout(() => align(0), 0)
    })
    loadBackups()
    loadAppVersion()
    loadProfiles()

    return () => {
      mountedRef.current = false
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [])

  // 监听外部导航事件（如 Gateway ?Settings?
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.tab === 'settings' && detail?.section) {
        setActiveSection(detail.section)
      }
    }
    window.addEventListener('crabpaw:navigate', handler)
    return () => window.removeEventListener('crabpaw:navigate', handler)
  }, [])

  // 比较当前配置和基准快照: 配置 state 变化(引用变化)或快照对齐(activeAlign)时触发。
  // 对齐完成后(≤150ms 收敛)基准=加载后值,无修改则恒 false;用户真实修改 setState →
  // 引用变化 → 对比不等 → true。
  useEffect(() => {
    if (!initialLoadDone.current || !initialConfigSnapshot.current) return
    setHasUnsavedChanges(getConfigSnapshot() !== initialConfigSnapshot.current)
  }, [getConfigSnapshot, snapshotReady])

  // G1: 未保存状态对外广播（onDirtyChange）——lazy 组件不透传 ref，回调更可靠
  useEffect(() => {
    props.onDirtyChange?.(hasUnsavedChanges)
  }, [hasUnsavedChanges])

  useEffect(() => {
    if (prevSaving.current && !saving) {
      setHasUnsavedChanges(false)
      // 保存成功后更新初始快照
      initialConfigSnapshot.current = getConfigSnapshot()
    }
    prevSaving.current = saving
  }, [saving, getConfigSnapshot])

  // 页面离开/关闭时提示未保存更改（仅弹一次，避免死循环）
  const closeWarned = useRef(false)
  useEffect(() => {
    if (!hasUnsavedChanges) { closeWarned.current = false; return }
    const handler = (e: BeforeUnloadEvent) => {
      if (closeWarned.current) return // Already warned, don't block again
      closeWarned.current = true
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnsavedChanges])

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges
  }), [hasUnsavedChanges, setActiveSection])

  const loadAppVersion = async () => {
    try {
      if (window.electronAPI?.app?.getVersion) {
        const version = await window.electronAPI.app.getVersion()
        setUpdateStatus(prev => ({ ...prev, currentVersion: version }))
      }
    } catch (_e) {

      // 获取版本号失败，静默处理

      console.warn('[index.tsx] 空 catch 补日志:', _e instanceof Error ? _e.message : _e);
    }

  }

  const loadConfigs = async (isManualRefresh: boolean = false) => {
    const controller = new AbortController()
    abortRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    
    if (isManualRefresh) {
      setIsRefreshing(true)
    }
    
    try {
      const [configResult, userConfigResult, fallbackResult] = await Promise.all([
        apiGet('/config', { signal: controller.signal }),
        apiGet('/config/user', { signal: controller.signal }),
        apiGet('/api/fallback/status', { signal: controller.signal }).catch(() => ({ success: false })),
      ])
      
      if (!mountedRef.current) return
      
      // Prefer Electron IPC for reliable disk read (no API masking/intermediary issues)
      let config = null
      if (window.electronAPI?.config?.get) {
        try {
          config = await window.electronAPI.config.get()
          console.log('[Settings] Loaded config from Electron IPC, wecom:', config?.wecom?.botId ? 'botId=' + config.wecom.botId.substring(0,8) + '...' : 'no botId')
        } catch (_) { console.warn('[Settings] Electron IPC config.get 调用失败') }
      }
      // Fallback to API if IPC unavailable
      if (!config) {
        config = configResult.success ? configResult.data : null
        console.log('[Settings] Loaded config from API, wecom:', config?.wecom?.botId ? 'botId=' + config.wecom.botId.substring(0,8) + '...' : 'no botId')
      }

      // 2026-08-31 修复(密钥显示陈旧/首开为空): 模型/图像/视频 provider key 的单一
      // 事实源是 .api_keys.json(加密存储), config.json 不再落盘 key——IPC 直读文件
      // 拿不到新保存的 key(会显示遗留明文旧值)。用后端内存态(GET /config, redact
      // 掩码)覆盖 key 展示; 同时规避 IPC 撞上后端 atomicWrite 写入窗口读到空/半份
      // 配置导致首次打开为空的问题。
      const apiConfig: any = configResult.success ? (configResult as any).data : null
      if (config && apiConfig) {
        const overlayKeys = (section: string) => {
          const src = apiConfig?.[section]?.providers as Record<string, { apiKey?: string }> | undefined
          const dst = (config as any)?.[section]?.providers as Record<string, { apiKey?: string }> | undefined
          if (!src || !dst) return
          for (const [k, v] of Object.entries(src)) {
            if (dst[k] && typeof v?.apiKey === 'string' && v.apiKey) dst[k].apiKey = v.apiKey
          }
        }
        overlayKeys('models')
        overlayKeys('imageGeneration')
        overlayKeys('videoGeneration')
        overlayKeys('visionGeneration')
        // 2026-09-09 修复(复用后端时密钥显示为空): search/voice/lark/wecom 的密钥与模型
        // provider key 同类——打包版复用后端时, IPC 文件读拿到的是主进程数据目录的旧副本,
        // 后端内存态(GET /config, redact 掩码)才是生效值。密钥字段用后端值覆盖后再渲染,
        // 否则设置页保存成功但重新打开显示为空(百度搜索 key 实测踩坑)。
        if (config && apiConfig) {
          const overlayField = (section: string, field: string) => {
            const src = (apiConfig as any)?.[section]?.[field]
            if (typeof src !== 'string' || !src) return
            const dstRoot = config as any
            if (!dstRoot[section]) dstRoot[section] = {}
            dstRoot[section][field] = src
          }
          for (const f of ['tavilyApiKey', 'bingApiKey', 'baiduApiKey']) overlayField('search', f)
          for (const f of ['doubaoKey', 'doubaoAccessKey', 'volcAsrApiKey', 'volcAsrAppKey', 'volcAsrAccessKey', 'volcanoToken', 'openaiApiKey', 'qwenApiKey', 'aliyunApiKey']) overlayField('voice', f)
          overlayField('lark', 'appSecret')
          overlayField('wecom', 'secret')
        }
      }

      // User/assistant config: prefer API, fall back to IPC-merged data from config object
      let userConfigData = userConfigResult.success ? userConfigResult.data : null
      if (!userConfigData && config?.user) {
        userConfigData = config.user
        console.log('[Settings] Using IPC user config fallback')
      }
      if (!config?.agent && config?.agent === undefined) {
        // agent already set above from config.agent
      }

      if (config) {
        if (config.agent) {
          setAssistantConfig(prev => ({ ...prev, ...config.agent }))
        }
        if (config.models) {
          const loadedProviders = config.models.providers || {}
          const mergedProviders = { ...DEFAULT_PROVIDERS }

          for (const [key, value] of Object.entries(loadedProviders as Record<string, Record<string, unknown>>)) {
            mergedProviders[key] = {
              ...(mergedProviders[key] || {}),
              ...(value as Record<string, unknown>)
            }
          }

          setModelConfig({
            currentProvider: config.models.currentProvider || 'deepseek',
            defaultModel: config.models.defaultModel || PROVIDER_ENDPOINTS.find(p => p.id === config.models.currentProvider)?.defaultModel || 'deepseek-chat',
            toolProfile: config.models.toolProfile || 'coding',
            providers: mergedProviders
          })
        }
        if (config.lark) {
          setLarkConfig({
            appId: config.lark.appId || '',
            appSecret: config.lark.appSecret || ''
          })
        }
        if (config.wecom) {
          setWecomConfig({
            corpId: config.wecom.corpId || '',
            botId: config.wecom.botId || '',
            secret: config.wecom.secret || ''
          })
        }
        if (config.chatChannel) {
          const ch = Array.isArray(config.chatChannel) ? config.chatChannel[0] : config.chatChannel
          setChatChannel((ch || 'none') as 'none' | 'lark' | 'wecom')
        }
        if (config.enableWhitelist !== undefined) {
          setSecurityConfig(prev => ({ ...prev, enableWhitelist: config.enableWhitelist }))
        }
        if (config.allowedUsers) {
          setSecurityConfig(prev => ({ ...prev, allowedUsers: config.allowedUsers }))
        }
        if (config.security) {
          const rawLevel = config.security.level || 'medium'
          let mappedLevel = LEVEL_TO_BACKEND[rawLevel] || rawLevel
          // 兜底：未知值回退到 standard，避免 UI 下拉框无匹配项
          const VALID_UI_LEVELS = ['disabled', 'standard', 'strict']
          if (!VALID_UI_LEVELS.includes(mappedLevel)) {
            console.warn('[Settings] 未知安全等级 "' + rawLevel + '" → 映射为 "standard"，原始值已保留在 level 字段')
            mappedLevel = 'standard'
          }
          setSecurityConfig(prev => ({
            ...prev,
            level: mappedLevel,
            approvalMode: config.security.approval?.mode || 'smart',
            promptInjectionEnabled: config.security.promptInjection?.enabled !== false,
            filesystemEnabled: config.security.filesystem?.enabled !== false,
            sessionIsolationEnabled: config.security.sessionIsolation?.enabled !== false,
            remoteInstallEnabled: config.security.remoteInstall?.enabled === true
          }))
        }
        if (config.update) {
          setUpdateConfig(prev => ({
            ...prev,
            updateUrl: config.update.url || '',
            autoCheck: config.update.autoCheck !== false,
            lastCheck: config.update.lastCheck || ''
          }))
        }
        if (config.imageGeneration) {
          const loadedProviders = config.imageGeneration.providers || {}
          const mergedProviders = { ...DEFAULT_IMAGE_PROVIDERS }
          for (const [key, value] of Object.entries(loadedProviders as Record<string, Record<string, unknown>>)) {
            mergedProviders[key] = { ...(mergedProviders[key] || {}), ...(value as Record<string, unknown>) }
          }
          setImageGenConfig({
            provider: config.imageGeneration.provider || 'doubao',
            model: config.imageGeneration.model || 'doubao-seedream-5-0-260128',
            providers: mergedProviders
          })
        }
        if (config.videoGeneration) {
          const loadedProviders = config.videoGeneration.providers || {}
          const mergedProviders = { ...DEFAULT_VIDEO_PROVIDERS }
          for (const [key, value] of Object.entries(loadedProviders as Record<string, Record<string, unknown>>)) {
            mergedProviders[key] = { ...(mergedProviders[key] || {}), ...(value as Record<string, unknown>) }
          }
          setVideoGenConfig({
            provider: config.videoGeneration.provider || 'doubao',
            model: config.videoGeneration.model || 'Doubao-Seedance-1.5-pro',
            providers: mergedProviders
          })
        }
        if (config.visionGeneration) {
          const loadedProviders = config.visionGeneration.providers || {}
          const mergedProviders = { ...DEFAULT_VISION_PROVIDERS }
          for (const [key, value] of Object.entries(loadedProviders as Record<string, Record<string, unknown>>)) {
            mergedProviders[key] = { ...(mergedProviders[key] || {}), ...(value as Record<string, unknown>) }
          }
          setVisionConfig({
            provider: config.visionGeneration.provider || 'doubao',
            model: config.visionGeneration.model || 'doubao-seed-vision',
            providers: mergedProviders
          })
        }
        
        if (config.voice) {
          console.log('🔊 加载语音配置:', config.voice)
          setVoiceConfig(prev => ({
            ...prev,
            replyEnabled: config.voice.replyEnabled ?? true,
            asrProvider: config.voice.asrProvider || 'volcengine',
            volcAsrApiKey: config.voice.volcAsrApiKey || "",
            volcAsrResourceId: config.voice.volcAsrResourceId || "",
            volcAsrAppKey: config.voice.volcAsrAppKey || "",
            volcAsrAccessKey: config.voice.volcAsrAccessKey || "",
            doubaoKey: config.voice.doubaoKey || "",
            doubaoAccessKey: config.voice.doubaoAccessKey || "",
            doubaoAppId: config.voice.doubaoAppId || "",
            doubaoVoice: config.voice.doubaoVoice || "zh_female_xiaohe_uranus_bigtts",
            doubaoResourceId: config.voice.doubaoResourceId || "",
            volcanoAppId: config.voice.volcanoAppId || "",
            volcanoToken: config.voice.volcanoToken || "",
            volcanoVoice: config.voice.volcanoVoice || "BV001_streaming",
            ttsProvider: config.voice.ttsProvider || config.voice.ttsMode || 'edge-tts',
            defaultVoice: config.voice.defaultVoice || 'zh-CN-XiaoxiaoNeural',
            speed: config.voice.speed ?? 1.0,
            micDeviceId: config.voice.micDeviceId || "",
            outputDeviceId: config.voice.outputDeviceId || "",
            lang: config.voice.lang || 'zh',
            continuousMode: config.voice.continuousMode ?? false,
            wakeWordEnabled: config.voice.wakeWordEnabled ?? true,
            voiceThreshold: config.voice.voiceThreshold ?? 0.008,
            ttsFxEnabled: config.voice.ttsFxEnabled ?? true,
            aliyunApiKey: config.voice.aliyunApiKey || "",
            aliyunModel: config.voice.aliyunModel || "fun-asr-realtime-2026-02-28",
            asrLang: config.voice.asrLang || config.voice.lang || 'zh',
          }))
        } else {
          console.log('🔊 未找到语音配置，使用默认值')
        }
        if (config.search) {
          setSearchConfig({
            tavilyApiKey: config.search.tavilyApiKey || '',
            bingApiKey: config.search.bingApiKey || '',
            baiduApiKey: config.search.baiduApiKey || '',
          });
        }
      }
      
      // 加载 Fallback 配置
      if (fallbackResult && (fallbackResult as { success?: boolean; data?: any }).success && (fallbackResult as { success?: boolean; data?: any }).data) {
        const fallbackData = (fallbackResult as { success?: boolean; data?: any }).data
        const stats = fallbackData.stats || {}
        if (stats.fallbackModel) {
          setFallbackConfig(prev => ({
            ...prev,
            fallbackModel: {
              provider: stats.fallbackModel.provider || '',
              model: stats.fallbackModel.model || '',
              baseUrl: stats.fallbackModel.baseUrl || '',
            }
          }))
        }
        if (stats.auxiliary) {
          setFallbackConfig(prev => ({
            ...prev,
            auxiliary: {
              vision: stats.auxiliary.vision || prev.auxiliary.vision,
              compression: stats.auxiliary.compression || prev.auxiliary.compression,
            }
          }))
        }
      }
      
      if (userConfigData) {
        setUserConfig(prev => ({
          ...prev,
          name: userConfigData.name || '',
          callMe: userConfigData.callMe || '',
          timezone: userConfigData.timezone || 'Asia/Shanghai',
          notes: userConfigData.notes || '',
          larkUserId: userConfigData.larkUserId || '',
          wecomUserId: userConfigData.wecomUserId || '',
          syncMode: userConfigData.syncMode || 'gui_user'
        }))
      }
      
      setLoadError('')
    } catch (e: any) {
      if (!mountedRef.current) return
      const errorMsg = e?.message || ''
      let errorText = '加载配置失败: 未知错误'
      if (e.name === 'AbortError') {
        errorText = '加载超时，请检查服务是否正常运行'
      } else if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
        errorText = '认证失败，请检查服务是否正常运行'
      } else if (errorMsg.includes('fetch') || errorMsg.includes('network')) {
        errorText = '网络连接失败，请检查服务是否启动'
      } else {
        errorText = `加载配置失败: ${errorMsg || '未知错误'}`
      }
      setLoadError(errorText)
    } finally {
      clearTimeout(timeoutId)
      if (abortRef.current === controller) {
        abortRef.current = null
      }
      if (mountedRef.current) {
        setIsRefreshing(false)
      }
    }
  }

  const saveAllConfigs = useCallback(async () => {
    if (saving) return
    // Validate current provider API key: trim whitespace and reject empty strings for non-masked keys
    const cpKey = modelConfig.currentProvider
    const cp = modelConfig.providers[cpKey]
    if (cp?.apiKey && !cp.apiKey.includes('***')) {
      const trimmed = cp.apiKey.trim()
      if (trimmed === '') {
        toast.error(`${cpKey} API Key 不能为空或纯空格`)
        return
      }
      if (trimmed.length < 8) {
        toast.error(`${cpKey} API Key 长度不足（至少 8 字符）`)
        return
      }
    }
    // Validate lark/wecom secrets
    if (larkConfig.appSecret && !larkConfig.appSecret.includes('***')) {
      const trimmed = larkConfig.appSecret.trim()
      if (trimmed === '') { toast.error('飞书 App Secret 不能为空或纯空格'); return }
    }
    if (wecomConfig.secret && !wecomConfig.secret.includes('***')) {
      const trimmed = wecomConfig.secret.trim()
      if (trimmed === '') { toast.error('企业微信 Secret 不能为空或纯空格'); return }
    }
    if (loadError && !(await askConfirm({ title: '配置加载错误', message: '配置加载时出现错误，保存可能覆盖已有配置导致数据丢失。\n\n确定要继续保存吗？', confirmLabel: '继续保存', danger: true }))) return
    console.log('🔊 开始保存配置，当前 voiceConfig:', maskSecrets(voiceConfig))
    setSaving(true)
    try {
      const providersToSave: Record<string, { baseUrl: string; model: string; apiKey?: string }> = {}
      
      for (const [key, provider] of Object.entries(modelConfig.providers)) {
        providersToSave[key] = {
          baseUrl: provider.baseUrl,
          model: provider.model
        }
        if (provider.apiKey && !provider.apiKey.includes("***") && provider.apiKey.trim() !== '') {
          providersToSave[key].apiKey = provider.apiKey
        }
      }
      
      const larkToSave = { ...larkConfig }
      if (larkToSave.appSecret && (larkToSave.appSecret.includes("***") || larkToSave.appSecret.trim() === '')) {
        delete (larkToSave as { appSecret?: string }).appSecret
      }
      
      const wecomToSave = { ...wecomConfig }
      if (wecomToSave.secret && (wecomToSave.secret.includes("***") || wecomToSave.secret.trim() === '')) {
        delete (wecomToSave as { secret?: string }).secret
      }

      const imageProvidersToSave: Record<string, { baseUrl: string; model: string; apiKey?: string }> = {}
      for (const [key, provider] of Object.entries(imageGenConfig.providers)) {
        imageProvidersToSave[key] = {
          baseUrl: provider.baseUrl,
          model: provider.model
        }
        if (provider.apiKey && !provider.apiKey.includes("***") && provider.apiKey.trim() !== '') {
          imageProvidersToSave[key].apiKey = provider.apiKey
        }
      }

      const videoProvidersToSave: Record<string, { baseUrl: string; model: string; apiKey?: string }> = {}
      for (const [key, provider] of Object.entries(videoGenConfig.providers)) {
        videoProvidersToSave[key] = {
          baseUrl: provider.baseUrl,
          model: provider.model
        }
        if (provider.apiKey && !provider.apiKey.includes("***") && provider.apiKey.trim() !== '') {
          videoProvidersToSave[key].apiKey = provider.apiKey
        }
      }

      const visionProvidersToSave: Record<string, { baseUrl: string; model: string; apiKey?: string }> = {}
      for (const [key, provider] of Object.entries(visionConfig.providers)) {
        visionProvidersToSave[key] = {
          baseUrl: provider.baseUrl,
          model: provider.model
        }
        if (provider.apiKey && !provider.apiKey.includes("***") && provider.apiKey.trim() !== '') {
          visionProvidersToSave[key].apiKey = provider.apiKey
        }
      }

      await Promise.all([
        apiPost('/config/user', userConfig),
        apiPost('/config', {
          agent: assistantConfig,
          models: {
            currentProvider: modelConfig.currentProvider,
            defaultModel: modelConfig.defaultModel,
            toolProfile: modelConfig.toolProfile,
            providers: providersToSave
          },
          lark: larkToSave,
          wecom: wecomToSave,
          chatChannel,
          enableWhitelist: securityConfig.enableWhitelist,
          allowedUsers: securityConfig.allowedUsers,
          security: {
            level: BACKEND_TO_LEVEL[securityConfig.level] || securityConfig.level,
            userWhitelist: {
              enabled: securityConfig.enableWhitelist,
              allowAll: !securityConfig.enableWhitelist
            },
            approval: {
              enabled: securityConfig.approvalMode !== 'off',
              mode: securityConfig.approvalMode
            },
            filesystem: {
              enabled: securityConfig.filesystemEnabled
            },
            promptInjection: {
              enabled: securityConfig.promptInjectionEnabled
            },
            sessionIsolation: {
              enabled: securityConfig.sessionIsolationEnabled
            }
          },
          update: {
            url: updateConfig.updateUrl,
            autoCheck: updateConfig.autoCheck,
            lastCheck: updateConfig.lastCheck
          },
          imageGeneration: {
            provider: imageGenConfig.provider,
            model: imageGenConfig.providers[imageGenConfig.provider]?.model || imageGenConfig.model,
            providers: imageProvidersToSave
          },
          videoGeneration: {
            provider: videoGenConfig.provider,
            model: videoGenConfig.providers[videoGenConfig.provider]?.model || videoGenConfig.model,
            providers: videoProvidersToSave
          },
          visionGeneration: {
            provider: visionConfig.provider,
            model: visionConfig.providers[visionConfig.provider]?.model || visionConfig.model,
            providers: visionProvidersToSave
          },
          voice: voiceConfig,
          search: searchConfig,

        }),
        
        // 2026-08-27 审计 A1: 仅当 fallback 区实际变化才 POST——此前无条件提交,
        // 而回显形态与后端 getStats 不匹配时 fallbackConfig 恒为空对象,
        // 每次「保存所有」会把 .env 的 FALLBACK_*/AUX_* 清空(未编辑的数据丢失)。
        // 基于初始快照比对: 未改动则不触碰后端。
        (() => {
          try {
            const snap = JSON.parse(initialConfigSnapshot.current || '{}') as Record<string, unknown>
            const unchanged = JSON.stringify(snap.fallbackConfig) === JSON.stringify(fallbackConfig)
            return unchanged
              ? Promise.resolve({ success: true, skipped: true })
              : apiPost('/api/fallback/config', fallbackConfig)
          } catch {
            return apiPost('/api/fallback/config', fallbackConfig)
          }
        })(),
        apiPost('/api/security/config', {
          level: securityConfig.level,
          approval: { enabled: securityConfig.approvalMode !== 'off', mode: securityConfig.approvalMode },
          userWhitelist: { enabled: securityConfig.enableWhitelist, allowAll: !securityConfig.enableWhitelist, users: securityConfig.allowedUsers },
          // 2026-08-28 发布项: 远程技能安装开关（后端持久化 appConfig.security.remoteInstall）
          remoteInstall: { enabled: securityConfig.remoteInstallEnabled },
        }).catch((e: any) => {
          console.error('保存安全配置失败:', e?.message || e)
        }),
      ])
      console.log('🔊 保存语音配置:', maskSecrets(voiceConfig))
      clearCredentialsCache()
      window.dispatchEvent(new CustomEvent('config-updated'))
      window.dispatchEvent(new CustomEvent('config-updated-voice'))
      if (window.electronAPI?.config?.reloadBridges) {
        try {
          await window.electronAPI.config.reloadBridges()
        } catch (_) { console.warn('[Settings] Electron IPC reloadBridges 调用失败') }
      }
      toast.success('配置已保存')
    } catch (e: any) {
      const errMsg = String(e?.message || e)
      if (errMsg.includes('ECONNREFUSED') || errMsg.includes('fetch') || errMsg.includes('network') || errMsg.includes('连接')) {
        toast.error('保存失败：后端服务未启动，请先在首页点击「启动服务」')
      } else {
        toast.error('保存失败: ' + errMsg)
      }
    } finally {
      setSaving(false)
    }
  }, [saving, modelConfig, larkConfig, wecomConfig, userConfig, assistantConfig, chatChannel, securityConfig, updateConfig, imageGenConfig, videoGenConfig, visionConfig, voiceConfig])
  const toggleApiKeyVisibility = (providerId: string) => {
    setShowApiKeys(prev => ({ ...prev, [providerId]: !prev[providerId] }))
  }


  // Profile 管理
  const loadProfiles = useCallback(async () => {
    try {
      const result = await apiGet('/api/profiles')
      if (result.success) {
        setProfiles(result.data?.profiles || [])
        setActiveProfile(result.data?.activeProfile || 'default')
      }
    } catch (e: any) { console.error('加载Profiles失败:', e) }
  }, [])


  const createProfile = async () => {
    if (!newProfileName.trim()) return
    setProfileLoading(true)
    try {
      const result = await apiPost('/api/profiles', { name: newProfileName.trim(), description: newProfileDesc.trim(), icon: newProfileIcon })
      if (result.success) {
        toast.success(`Profile "${newProfileName}" 已创建`)
        setNewProfileName(''); setNewProfileDesc(''); setNewProfileIcon('🤖')
        await loadProfiles()
      } else {
        toast.error(result.error || '创建失败')
      }
    } catch (e: any) { toast.error('创建失败') }
    finally { setProfileLoading(false) }
  }

  const switchProfile = async (profileId: string) => {
    if (profileId === activeProfile) return
    try {
      const result = await apiGet(`/api/profiles/${profileId}/diff`)
      if (result.success && result.data?.diff && result.data.diff.length > 0) {
        setDiffDialog({ open: true, profileId, profileName: profiles.find(p => p.id === profileId)?.name || profileId, diffs: result.data.diff })
        return
      }
    } catch (_) { console.warn('[Settings] profile diff 查询失败') }
    await doSwitchProfile(profileId)
  }

  const doSwitchProfile = async (profileId: string) => {
    setProfileLoading(true)
    try {
      const result = await apiPost('/api/profiles/switch', { profileId })
      if (result.success) {
        setActiveProfile(profileId)
        toast.success(`已切换到 ${result.data?.profileName || profileId}`)
        clearCredentialsCache()
        window.dispatchEvent(new CustomEvent('config-updated'))
      window.dispatchEvent(new CustomEvent('config-updated-voice'))
        await loadConfigs()
      } else { toast.error(result.error || '切换失败') }
    } catch (e: any) { toast.error('切换失败') }
    finally { setProfileLoading(false) }
  }

  const deleteProfile = async (profileId: string) => {
    const meta = profiles.find(p => p.id === profileId)
    const isActive = profileId === activeProfile
    // M1 fix: 合并到 useConfirm（askConfirm），消除 confirmDialog 与 useConfirm 并存
    if (!(await askConfirm({
      title: '删除 Profile',
      message: isActive ? `"${meta?.name || profileId}" 是当前活跃的 Profile，删除后将自动切换到默认配置。` : '确定删除该Profile？此操作不可撤销',
      confirmLabel: '删除',
      danger: true,
    }))) return
    try {
      const result = await apiDelete(`/api/profiles/${profileId}`)
      if (result.success) {
        toast.success(result.data?.message || '已删除')
        if (result.data?.switchedToDefault) setActiveProfile('default')
        await loadProfiles()
      } else { toast.error(result.error || '删除失败') }
    } catch { toast.error('删除失败') }
  }

  const openEditDialog = (profile: { id: string; name: string; description: string; icon: string }) => {
    setEditDialog({ open: true, id: profile.id, name: profile.name, description: profile.description, icon: profile.icon || '🤖' })
  }

  const saveEditProfile = async () => {
    if (!editDialog) return
    setProfileLoading(true)
    try {
      const result = await apiPatch(`/api/profiles/${editDialog.id}`, { name: editDialog.name, description: editDialog.description, icon: editDialog.icon })
      if (result.success) { toast.success('已更新'); setEditDialog(null); await loadProfiles() }
      else { toast.error(result.error || '更新失败') }
    } catch (e: any) { toast.error('更新失败') }
    finally { setProfileLoading(false) }
  }

  const cloneProfile = async (profileId: string) => {
    setProfileLoading(true)
    const meta = profiles.find(p => p.id === profileId)
    try {
      const newName = (meta?.name || 'Profile') + ' (克隆)'
      const result = await apiPost(`/api/profiles/${profileId}/clone`, { name: newName })
      if (result.success) { toast.success('已克隆'); await loadProfiles() }
      else { toast.error(result.error || '克隆失败') }
    } catch (e: any) { toast.error('克隆失败') }
    finally { setProfileLoading(false) }
  }

  const exportProfile = async (profileId: string) => {
    try {
      // Electron 模式走 streamUrl 注入 token（渲染进程不暴露 token），浏览器模式走 header 认证
      const url = await resolveApiUrl(`/api/profiles/${profileId}/export`)
      const resp = await fetch(url)
      if (!resp.ok) { toast.error('导出失败: ' + resp.status); return }
      const blob = await resp.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl; a.download = `profile-${profileId}.json`; a.click()
      URL.revokeObjectURL(objUrl)
      toast.success('已导出')
    } catch (e: any) { console.error('导出Profile失败:', e); toast.error('导出失败') }
  }

  const importProfileFromFile = async (file: File) => {
    try {
      const text = await file.text()
      JSON.parse(text)
      setProfileLoading(true)
      const fileName = file.name.replace(/\.json$/i, '')
      const result = await apiPost('/api/profiles/import', { name: fileName, json: text, force: false })
      if (result.success) { toast.success(`已导入 "${result.data?.profile?.name || fileName}"`); await loadProfiles() }
      else { toast.error(result.error || '导入失败') }
    } catch (e: any) { if (e.message?.includes('已存在')) toast.error('该名称已存在'); else toast.error('导入失败: JSON 格式错误') }
    finally { setProfileLoading(false) }
  }


  const loadBackups = async () => {
    try {
      const result = await apiGet('/api/backup/list')
      if (result.success && result.data) {
        setBackups(result.data.backups || [])
      }
    } catch (_e) {

      // 加载备份列表失败，静默处理

      console.warn('[index.tsx] 空 catch 补日志:', _e instanceof Error ? _e.message : _e);
    }

  }

  const createBackup = async () => {
    setBackupLoading(true)
    try {
      const result = await apiPost('/api/backup/create', {})
      if (result.success) {
        toast.success(`备份已创建: ${result.data?.backupName || ''}`)
        loadBackups()
      } else {
        toast.error('创建备份失败')
      }
    } catch (e) {
      toast.error('创建备份失败: ' + String(e))
    } finally {
      setBackupLoading(false)
    }
  }

  const downloadBackup = async (name: string) => {
    try {
      const url = await resolveApiUrl(`/api/backup/download?name=${encodeURIComponent(name)}`)
      const resp = await fetch(url)
      if (!resp.ok) { toast.error('下载备份失败: ' + resp.status); return }
      const blob = await resp.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl; a.download = name; a.click()
      URL.revokeObjectURL(objUrl)
    } catch (e: any) { console.error('下载备份失败:', e); toast.error('下载备份失败: ' + (e?.message || '未知错误')) }
  }

  const restoreBackup = async (name: string) => {
    // M1 fix: 合并到 useConfirm（askConfirm）
    if (!(await askConfirm({
      title: '恢复备份',
      message: `确定要从 ${name} 恢复吗？当前数据将被覆盖。`,
      confirmLabel: '恢复',
      danger: true,
    }))) return
    setBackupLoading(true)
    try {
      const result = await apiPost('/api/backup/restore', { name })
      if (result.success) {
        toast.success('恢复成功，页面将重新加载配置')
        loadBackups()
        loadConfigs()
      } else {
        toast.error('恢复失败')
      }
    } catch (e) {
      toast.error('恢复失败: ' + String(e))
    } finally {
      setBackupLoading(false)
    }
  }

  const deleteBackup = async (name: string) => {
    // M1 fix: 合并到 useConfirm（askConfirm）
    if (!(await askConfirm({
      title: '删除备份',
      message: `确定要删除备份 ${name} 吗？此操作不可撤销。`,
      confirmLabel: '删除',
      danger: true,
    }))) return
    try {
      const result = await apiPost('/api/backup/delete', { name })
      if (result.success) {
        toast.success('备份已删除')
        loadBackups()
      }
    } catch (e) {
      toast.error('删除失败: ' + String(e))
    }
  }

  const checkForUpdate = async () => {
    if (!updateConfig.updateUrl) {
      toast.error('请先填写更新地址')
      return
    }

    setUpdateStatus(prev => ({ ...prev, checking: true, error: '' }))
    
    try {
      const response = await fetch(`${updateConfig.updateUrl}/version.json`, {
        signal: AbortSignal.timeout(10000)
      })
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      const latestVersion = data.version || '0.0.0'
      const currentVersion = updateStatus.currentVersion
      
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0
      
      setUpdateStatus(prev => ({
        ...prev,
        checking: false,
        hasUpdate,
        latestVersion,
        error: ''
      }))
      
      setUpdateConfig(prev => ({
        ...prev,
        lastCheck: new Date().toISOString()
      }))
      
      if (hasUpdate) {
        toast.success(`发现新版本 ${latestVersion}`)
      } else {
        toast.success('已是最新版本')
      }
    } catch (e: any) {
      setUpdateStatus(prev => ({
        ...prev,
        checking: false,
        error: e.message || '检查更新失败'
      }))
      toast.error('检查更新失败: ' + String(e))
    }
  }

  const compareVersions = (a: string, b: string): number => {
    const clean = (v: string) => v.replace(/^v/i, '').replace(/-.*$/, '')
    const partsA = clean(a).split('.').map(p => parseInt(p, 10) || 0)
    const partsB = clean(b).split('.').map(p => parseInt(p, 10) || 0)
    
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0
      const numB = partsB[i] || 0
      if (numA > numB) return 1
      if (numA < numB) return -1
    }
    return 0
  }

  const downloadUpdate = () => {
    if (updateConfig.updateUrl) {
      window.open(`${updateConfig.updateUrl}/download`, '_blank')
    }
  }

  if (isRefreshing) {
    return (
      <div className="flex flex-col">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-bold theme-text-primary">设置</h2>
            <p className="text-sm mt-1 theme-text-muted">配置模型、用户信息和备份管理</p>
          </div>
          <button disabled className="flex items-center gap-2 px-4 py-2 theme-accent-bg text-white rounded-lg opacity-50">
            <Save className="w-4 h-4" />
            保存所有
          </button>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center justify-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{animationDelay:"0ms"}}></div><div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{animationDelay:"150ms"}}></div><div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{animationDelay:"300ms"}}></div><span className="text-xs theme-text-muted ml-1">加载配置中</span></div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex tab-content-enter">
      {confirmNode}
      {/* Settings Sidebar */}
      <div className="w-52 shrink-0 overflow-y-auto py-3 px-3" style={{ borderRight: '1px solid var(--border-primary)' }}>
        
        {[
          { group: '', items: [
            { id: 'user', icon: User, label: '用户与智能体' },
            { id: 'profile', icon: Users, label: 'Profile 配置' },
            { id: 'channel', icon: MessageSquare, label: '消息通道' },
            { id: 'poster', icon: ImageIcon, label: '品牌资产包' },
          ]},
          { group: '模型', items: [
            { id: 'model', icon: Settings2, label: '模型配置' },
          ]},
          { group: '系统', items: [
            { id: 'security', icon: Shield, label: '安全配置' },
            { id: 'voice', icon: Volume2, label: '语音设置' },
            { id: 'update', icon: RefreshCw, label: '更新设置' },
          ]},
          { group: '个性化', items: [
            { id: 'appearance', icon: Palette, label: '外观主题' },
          ]},
          { group: '维护', items: [
            { id: 'backup', icon: Archive, label: '数据备份' },
            { id: 'search', icon: Search, label: '搜索配置' },
          ]},
        ].map(group => (
          <div key={group.group} className="mb-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider theme-text-muted px-2 mb-1.5">{group.group}</div>
            {group.items.map(item => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-sm rounded-lg transition-colors text-left ${
                  activeSection === item.id
                    ? 'theme-bg-active theme-accent font-medium'
                    : 'theme-text-secondary hover:theme-bg-hover hover:theme-text-primary'
                }`}
              >
                <item.icon className={`w-4 h-4 shrink-0 ${activeSection === item.id ? 'theme-accent' : ''}`} />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col p-6">
      <div className="flex justify-between items-center mb-6">
        <div className="sr-only">
          <h2 className="text-xl font-bold theme-text-primary">设置</h2>
          <p className="text-sm mt-1 theme-text-muted">配置模型、用户信息和备份管理</p>
        </div>
        <div className="flex items-center gap-3">
          {loadError && (
            <button
              onClick={() => loadConfigs(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-[var(--color-error)] theme-color-error hover:bg-[var(--color-error-bg)] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              重试加载
            </button>
          )}
          {/* 2026-08-27 审计 A2: 「丢弃更改」——放弃未保存修改, 重拉上次保存的配置 */}
          {hasUnsavedChanges && (
            <button
              onClick={() => loadConfigs(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm theme-btn-ghost border border-[var(--color-error)]/30 theme-color-error hover:bg-[var(--color-error-bg)] transition-colors"
              title="放弃未保存的修改，恢复为上次保存的配置"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              丢弃更改
            </button>
          )}

          <button
            onClick={saveAllConfigs}
            disabled={saving}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors disabled:opacity-50 ${
              hasUnsavedChanges 
                ? 'theme-btn-primary' 
                : 'theme-btn-ghost'
            }`}
            style={hasUnsavedChanges ? { boxShadow: '0 0 0 2px var(--color-accent)' } : {}}
          >
            <Save className="w-4 h-4" />
            {saving ? <><RefreshCw className='w-4 h-4 animate-spin inline mr-1' />保存中...</> : hasUnsavedChanges ? '💾 保存所有 *' : '保存所有'}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 p-3 rounded-lg flex items-center gap-3 bg-[var(--color-error-bg)] border border-[var(--color-error)]/30">
          <AlertTriangle className="w-5 h-5 theme-color-error flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm theme-color-error">{loadError}</p>
          </div>
          <button
            onClick={() => loadConfigs(true)}
            className="text-sm px-3 py-1 rounded border border-[var(--color-error)]/50 theme-color-error hover:bg-[var(--color-error-bg)] transition-colors"
          >
            重试
          </button>
        </div>
      )}

      <div>
        <UserSection activeSection={activeSection} userConfig={userConfig} setUserConfig={setUserConfig} assistantConfig={assistantConfig} setAssistantConfig={setAssistantConfig} />
        <PosterSection activeSection={activeSection} />

        <ProfileSection
          activeSection={activeSection}
          profiles={profiles}
          activeProfile={activeProfile}
          profileLoading={profileLoading}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          newProfileName={newProfileName}
          setNewProfileName={setNewProfileName}
          newProfileDesc={newProfileDesc}
          setNewProfileDesc={setNewProfileDesc}
          newProfileIcon={newProfileIcon}
          setNewProfileIcon={setNewProfileIcon}
          onSwitchProfile={switchProfile}
          onDeleteProfile={deleteProfile}
          onOpenEditDialog={openEditDialog}
          onCloneProfile={cloneProfile}
          onExportProfile={exportProfile}
          onImportProfileFromFile={importProfileFromFile}
          onCreateProfile={createProfile}
        />

        <ChannelSection
          activeSection={activeSection}
          chatChannel={chatChannel}
          setChatChannel={setChatChannel}
          larkConfig={larkConfig}
          setLarkConfig={setLarkConfig}
          wecomConfig={wecomConfig}
          setWecomConfig={setWecomConfig}
          userConfig={userConfig}
          setUserConfig={setUserConfig}
        />

        {activeSection === 'model' && <>
          <ModelConfig
            modelConfig={modelConfig} setModelConfig={setModelConfig}
            imageGenConfig={imageGenConfig} setImageGenConfig={setImageGenConfig}
            videoGenConfig={videoGenConfig} setVideoGenConfig={setVideoGenConfig}
            visionConfig={visionConfig} setVisionConfig={setVisionConfig}
            voiceConfig={voiceConfig} setVoiceConfig={setVoiceConfig}
          />
          <div className="theme-card p-6 mt-4">
            <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
              <Store className="w-5 h-5 theme-accent" />模型市场
            </h3>
            <p className="text-xs theme-text-muted mb-3">浏览 11+ 主流 AI 提供商预设，一键应用配置</p>
            <ModelMarketplace onApply={(preset, model) => {
              const pid = preset.id
              setModelConfig(prev => ({
                ...prev,
                currentProvider: pid,
                defaultModel: model.id,
                providers: {
                  ...prev.providers,
                  [pid]: {
                    ...(prev.providers[pid] || { baseUrl: preset.apiUrl, apiKey: '', model: model.id }),
                    baseUrl: preset.apiUrl,
                    model: model.id,
                  }
                }
              }))
              toast.success(`已应用 ${preset.name} · ${model.name}`)
            }} />
          </div>
        </>}

        <div>
        <SecuritySection activeSection={activeSection} securityConfig={securityConfig} setSecurityConfig={setSecurityConfig} />

        <SearchSection activeSection={activeSection} searchConfig={searchConfig} setSearchConfig={setSearchConfig} showApiKeys={showApiKeys} onToggleApiKeyVisibility={toggleApiKeyVisibility} />

        <VoiceSection activeSection={activeSection} voiceConfig={voiceConfig} setVoiceConfig={setVoiceConfig} micDevices={micDevices} audioOutputs={audioOutputs} onRefreshDevices={refreshDevices} />

        <UpdateSection activeSection={activeSection} updateConfig={updateConfig} setUpdateConfig={setUpdateConfig} updateStatus={updateStatus} onCheckUpdate={checkForUpdate} onDownloadUpdate={downloadUpdate} />

        <div style={{ display: activeSection === 'backup' ? 'block' : 'none' }}>
          <SettingsBackup
            backups={backups}
            loading={backupLoading}
            onCreate={createBackup}
            onDownload={downloadBackup}
            onRestore={restoreBackup}
            onDelete={deleteBackup}
          />
        </div>
        <div style={{ display: activeSection === 'appearance' ? 'block' : 'none' }}>
          <SettingsAppearance
            theme={theme}
            accentColor={accentColor}
            setTheme={setTheme}
            setAccentColor={setAccentColor}
          />
        </div>
        {/* 2026-08-12: 开机自启开关——仅 Electron 桌面端可用（Web 预览环境隐藏） */}
        {window.electronAPI?.app?.autostart && (
          <div className="theme-card p-6">
            <h3 className="font-medium mb-2 flex items-center gap-2 theme-text-primary">
              <Settings2 className="w-5 h-5 theme-accent" />
              开机自启
            </h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autostartOn === true}
                disabled={autostartBusy || autostartOn === null}
                onChange={toggleAutostart}
                className="accent-[var(--accent-primary)]"
              />
              <span className="text-sm theme-text-secondary">开机后自动启动 CrabPaw（登录自动进入）</span>
            </label>
            {autostartError && <div style={{ fontSize: 12, color: 'var(--color-error)', marginTop: 8 }}>{autostartError}</div>}
          </div>
        )}
        {/* 阶段 B: 开发者模式开关——常驻显示（不被 activeSection 门控），
            保证调试入口可逆：关闭后管理舱调试页签隐藏，但仍可从设置重新开启 */}
        <div className="theme-card p-6">
          <h3 className="font-medium mb-2 flex items-center gap-2 theme-text-primary">
            <Settings2 className="w-5 h-5 theme-accent" />
            开发者模式
          </h3>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              defaultChecked={isDevMode()}
              onChange={(e) => {
                try { setDevMode(e.target.checked) } catch (err) { console.error('[settings] 开发者模式切换失败:', err) }
              }}
              className="accent-[var(--accent-primary)]"
            />
            <span className="text-sm theme-text-secondary">显示调试功能（日志/状态/网关/记忆/语音诊断）</span>
          </label>
        </div>
      {/* M1 fix: ConfirmDialog 已合并到 useConfirm（confirmNode 在顶部渲染） */}
      {/* 编辑 Profile 对话框 */}
      {editDialog?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditDialog(null)}>
          <div className="theme-card p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-medium theme-text-primary mb-4">编辑 Profile</h3>
            <div className="space-y-4">
              <div><label className="block text-xs mb-1 theme-text-muted">图标</label><input type="text" value={editDialog.icon} onChange={e => setEditDialog({ ...editDialog, icon: e.target.value })} className="theme-input text-center text-lg w-16" maxLength={2} /></div>
              <div><label className="block text-xs mb-1 theme-text-muted">名称</label><input type="text" value={editDialog.name} onChange={e => setEditDialog({ ...editDialog, name: e.target.value })} className="theme-input" /></div>
              <div><label className="block text-xs mb-1 theme-text-muted">描述</label><input type="text" value={editDialog.description} onChange={e => setEditDialog({ ...editDialog, description: e.target.value })} className="theme-input" /></div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setEditDialog(null)} className="px-4 py-2 rounded-lg border border-[var(--border-primary)] theme-text-secondary hover:theme-bg-hover transition-colors">取消</button>
              <button onClick={saveEditProfile} disabled={!editDialog.name.trim() || profileLoading} className="px-4 py-2 rounded-lg theme-accent-bg text-white hover:opacity-90 transition-colors disabled:opacity-50">{profileLoading ? '保存中...' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
      {/* 切换确认对话框 */}
      {diffDialog?.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDiffDialog(null)}>
          <div className="theme-card p-6 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-medium theme-text-primary mb-1">切换 Profile</h3>
            <p className="text-sm theme-text-secondary mb-4">切换到 <strong>"{diffDialog.profileName}"</strong>，以下配置将变更：</p>
            {diffDialog.diffs.length > 0 ? (
              <div className="flex-1 overflow-y-auto space-y-1 mb-4">
                {diffDialog.diffs.map((d, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-lg theme-bg-tertiary text-xs">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${d.type === 'added' ? 'bg-green-500/20 text-green-500' : d.type === 'removed' ? 'bg-red-500/20 text-red-500' : 'bg-yellow-500/20 text-yellow-500'}`}>{d.type === 'added' ? '新增' : d.type === 'removed' ? '移除' : '变更'}</span>
                    <div className="flex-1 min-w-0"><code className="font-mono theme-text-primary block truncate">{d.key}</code><div className="theme-text-muted mt-0.5 leading-tight">{d.type === 'added' ? <span>{String(d.value2).substring(0, 60)}</span> : d.type === 'removed' ? <span className="line-through opacity-60">{String(d.value1).substring(0, 60)}</span> : <span>{String(d.value1).substring(0, 40)} → {String(d.value2).substring(0, 40)}</span>}</div></div>
                  </div>
                ))}
              </div>
            ) : <p className="text-sm theme-text-muted mb-4">配置无差异，可直接切换</p>}
            <div className="flex justify-end gap-3 pt-3 border-t theme-border">
              <button onClick={() => setDiffDialog(null)} className="px-4 py-2 rounded-lg border border-[var(--border-primary)] theme-text-secondary hover:theme-bg-hover transition-colors">取消</button>
              <button onClick={async () => { const id = diffDialog.profileId; setDiffDialog(null); await doSwitchProfile(id) }} disabled={profileLoading} className="px-4 py-2 rounded-lg theme-accent-bg text-white hover:opacity-90 transition-colors disabled:opacity-50">确认切换</button>
            </div>
          </div>
        </div>
      )}
        </div>
      </div>
        </div>
      </div>
    </div>
  )
}

export const Settings = forwardRef(SettingsComponent) as React.ForwardRefExoticComponent<SettingsProps & React.RefAttributes<SettingsHandle>>
