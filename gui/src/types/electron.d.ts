import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electronAPI?: ElectronAPI & {
      api: {
        credentials: () => Promise<{
          port: number
          baseUrl: string
          token?: string
        }>
        proxy: (method: string, endpoint: string, body?: any) => Promise<{
          success: boolean
          status?: number
          data?: any
          error?: string
        }>
        streamUrl: (endpoint: string) => Promise<{
          url: string
        }>
        sse: (opts: { endpoint: string; since?: number }) => Promise<{ success: boolean; streamId?: string; error?: string }>
        sseClose: (streamId: string) => Promise<{ success: boolean; error?: string }>
        sseOnData: (callback: (payload: { streamId: string; data: string; event: string; seq?: number }) => void) => (() => void)
        sseOnEnd: (callback: (payload: { streamId: string }) => void) => (() => void)
        sseOnError: (callback: (payload: { streamId: string; error: string }) => void) => (() => void)
      }
      notify: (opts: { title: string; body?: string }) => Promise<{ success: boolean; error?: string }>
      service: {
        start: (opts?: { channel?: string | string[] }) => Promise<{ success: boolean; error?: string }>
        stop: () => Promise<{ success: boolean; error?: string }>
        status: () => Promise<{ server: boolean; larkBridge: boolean; wecomBridge: boolean }>
      }
      config: {
        get: () => Promise<Config | null>
        set: (config: Config) => Promise<{ success: boolean; error?: string }>
        check: () => Promise<boolean>
        reloadBridges: () => Promise<{ success: boolean; chatChannel?: string; error?: string }>
        user: {
          get: () => Promise<UserConfig | null>
          set: (config: UserConfig) => Promise<{ success: boolean; error?: string }>
        }
        assistant: {
          get: () => Promise<AssistantConfig | null>
          set: (config: AssistantConfig) => Promise<{ success: boolean; error?: string }>
        }
}
      window: {
        minimize: () => Promise<void>
        maximize: () => Promise<void>
        close: () => Promise<void>
        restart: () => Promise<void>
        isMaximized: () => Promise<boolean>
        isMinimized: () => Promise<boolean>
        restore: () => Promise<void>
      }
      file: {
        open: (filePath: string) => Promise<{ success: boolean; error?: string }>
        readBase64: (filePath: string) => Promise<{
          success: boolean
          data?: string
          mime?: string
          size?: number
          name?: string
          error?: string
        }>
      }
      app: {
        getVersion: () => Promise<string>
        checkUpdate: (updateUrl: string) => Promise<{
          success: boolean
          hasUpdate?: boolean
          currentVersion?: string
          latestVersion?: string
          downloadUrl?: string
          releaseNotes?: string
          error?: string
        }>
        autostart: {
          get: () => Promise<boolean>
          set: (enabled: boolean) => Promise<boolean>
        }
        bootMusic: {
          getPath: () => Promise<string | null>
        }
      }
      voice: {
        play: (filePath: string) => Promise<boolean>
        stop: () => Promise<boolean>
        togglePause: () => Promise<boolean>
        readAudioFile: (filePath: string) => Promise<any>
        setDuck: (ducked: boolean) => Promise<boolean>
        onStopped: (callback: () => void) => (() => void) | undefined
      }
      shell: {
        openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
      }
      browser: {
        onOpenTab: (callback: (url: string) => void) => (() => void)
      }
      splash: {
        onProgress: (callback: (event: SplashProgressEvent) => void) => (() => void) | undefined
        ready: () => void
      }
      wake: {
        setKeyword: (word: string | string[]) => Promise<{ ok: boolean; error?: string }>
        onHit: (callback: (payload: { keyword: string }) => void) => () => void
        onStatus: (callback: (payload: any) => void) => () => void
        setMicEnabled: (enabled: boolean) => Promise<boolean>
        // 2026-08-04: 窗口化能量检测(移植 LiveKit audiolevel)——语音球能量驱动
        onAudioLevel: (callback: (payload: { level: number; active: boolean }) => void) => () => void
        // 2026-08-15: 语音能量打断(barge-in)——TTS 播放窗口内说任何话即可打断
        setBargeinWindow: (v: boolean) => Promise<boolean>
        onSpeechBargein: (callback: (payload: { rms: number; baseline: number }) => void) => () => void
      }
    }
  }
}

export interface Config {
  lark?: {
    appId: string
    appSecret: string
  }
  wecom?: {
    botId: string
    secret: string
    corpId?: string
  }
  chatChannel?: 'none' | 'lark' | 'wecom'
  setupCompleted?: boolean
  wakeWord?: string | string[]
  defaultModel?: string
  security?: Record<string, any>
  imageGeneration?: Record<string, any>
  videoGeneration?: Record<string, any>
  visionGeneration?: Record<string, any>
  voice?: Record<string, any>
  search?: Record<string, any>
  models?: {
    currentProvider: string
    defaultModel?: string
    toolProfile?: Record<string, any>
    providers: Record<string, {
      baseUrl: string
      apiKey: string
      model: string
    }>
  }
  agent?: {
    name: string
    emoji: string
    creature: string
    vibe: string
    systemPrompt: string
  }
  user?: {
    name: string
    callMe: string
    timezone: string
    notes: string
  }
  schedule?: {
    enabled: boolean
    tasks: ScheduleTask[]
  }
  adminUsers?: string[]
  enableWhitelist?: boolean
  allowedUsers?: string[]
  update?: {
    url: string
    autoCheck: boolean
    lastCheck: string
  }
}

export interface UserConfig {
  name?: string
  callMe?: string
  timezone?: string
  notes?: string
  larkUserId?: string
  wecomUserId?: string
  syncMode?: 'gui_user' | 'lark_sync' | 'wecom_sync'
}

export interface AssistantConfig {
  name?: string
  emoji?: string
  creature?: string
  vibe?: string
  systemPrompt?: string
}

export interface ScheduleTask {
  id: string
  name: string
  cron: string
  action: string
  params?: Record<string, any>
  channels?: string[]
  requireConfirmation?: boolean
  enabled: boolean
}

export interface SplashProgressEvent {
  step: 'backend' | 'lark-bridge' | 'wecom-bridge' | 'sse-connect' | 'done'
  status: 'starting' | 'ready' | 'skipped' | 'error'
  message?: string
}
