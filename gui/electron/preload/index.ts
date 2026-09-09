import { contextBridge, ipcRenderer } from 'electron'

// S12 fix: IPC 输入验证辅助函数
function validateString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`)
  }
  // 防止超长输入（最大 64KB）
  if (value.length > 65536) {
    throw new Error(`Invalid ${name}: exceeds maximum length`)
  }
  return value
}

function validateObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected object`)
  }
  return value as Record<string, unknown>
}

function validateOptionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected object or undefined`)
  }
  return value as Record<string, unknown>
}

function validateBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid ${name}: expected boolean`)
  }
  return value
}

// 2026-08-15: api.proxy body 大小上限(1MB)——防超大请求体经主进程无界转发
const PROXY_BODY_MAX_BYTES = 1024 * 1024

function validateProxyBody(value: unknown): Record<string, unknown> | undefined {
  const obj = validateOptionalObject(value, 'body')
  if (obj !== undefined) {
    let size = 0
    try {
      size = new TextEncoder().encode(JSON.stringify(obj)).length
    } catch (e) {
      console.error('[preload] body 序列化失败(可能含循环引用):', e instanceof Error ? e.message : String(e))
      throw new Error('Invalid body: serialization failed')
    }
    if (size > PROXY_BODY_MAX_BYTES) {
      throw new Error('Invalid body: exceeds maximum size (1MB)')
    }
  }
  return obj
}

function validateOptionalChannelOpts(value: unknown): { channel?: string | string[] } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid opts: expected object')
  }
  const obj = value as Record<string, unknown>
  if (obj.channel !== undefined) {
    // channel 支持 string 或 string[]（多通道配置），与 main 进程 handler 对齐
    const isString = typeof obj.channel === 'string'
    const isStringArray = Array.isArray(obj.channel) && obj.channel.every(c => typeof c === 'string')
    if (!isString && !isStringArray) {
      throw new Error('Invalid opts.channel: expected string or string[]')
    }
  }
  return obj as { channel?: string | string[] }
}

contextBridge.exposeInMainWorld('electronAPI', {
  api: {
    credentials: () => ipcRenderer.invoke('api:credentials'),
    proxy: (method: string, endpoint: string, body?: any) => {
      validateString(method, 'method')
      validateString(endpoint, 'endpoint')
      return ipcRenderer.invoke('api:proxy', { method, endpoint, body: validateProxyBody(body) })
    },
    streamUrl: (endpoint: string) => {
      validateString(endpoint, 'endpoint')
      return ipcRenderer.invoke('api:streamUrl', endpoint)
    },
    // T1.2: api:sse — 主进程代连 SSE（渲染层拿不到 token）
    // Task 6: 对象形 { endpoint, since? }——重连时 since 经主进程转 Last-Event-ID 头
    sse: (opts: { endpoint: string; since?: number }) => {
      const safeOpts = validateObject(opts, 'opts')
      validateString(safeOpts.endpoint, 'endpoint')
      if (safeOpts.since !== undefined && (typeof safeOpts.since !== 'number' || safeOpts.since <= 0)) {
        throw new Error('Invalid since: expected positive number')
      }
      return ipcRenderer.invoke('api:sse', { endpoint: safeOpts.endpoint, since: safeOpts.since })
    },
    sseClose: (streamId: string) => {
      validateString(streamId, 'streamId')
      return ipcRenderer.invoke('api:sse:close', { streamId })
    },
    // SSE 事件监听器（渲染层通过 IPC 接收主进程推送的 sse:data/sse:end/sse:error 事件）
    sseOnData: (callback: (payload: { streamId: string; data: string; event: string; seq?: number }) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: { streamId: string; data: string; event: string; seq?: number }) => callback(payload)
      ipcRenderer.on('sse:data', handler)
      return () => { ipcRenderer.removeListener('sse:data', handler) }
    },
    sseOnEnd: (callback: (payload: { streamId: string }) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: { streamId: string }) => callback(payload)
      ipcRenderer.on('sse:end', handler)
      return () => { ipcRenderer.removeListener('sse:end', handler) }
    },
    sseOnError: (callback: (payload: { streamId: string; error: string }) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: { streamId: string; error: string }) => callback(payload)
      ipcRenderer.on('sse:error', handler)
      return () => { ipcRenderer.removeListener('sse:error', handler) }
    },
  },
  // S2.2(2026-09-02): OS 系统通知——提醒到点由主进程弹横幅, 点击聚焦主窗口
  notify: (opts: { title: string; body?: string }) => {
    const safeOpts = validateObject(opts, 'opts')
    validateString(safeOpts.title, 'opts.title')
    return ipcRenderer.invoke('os:notify', { title: safeOpts.title, body: typeof safeOpts.body === 'string' ? safeOpts.body : '' })
  },
  service: {
    start: (opts?: { channel?: string | string[] }) => ipcRenderer.invoke('service:start', validateOptionalChannelOpts(opts)),
    stop: () => ipcRenderer.invoke('service:stop'),
    status: () => ipcRenderer.invoke('service:status'),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (config: any) => ipcRenderer.invoke('config:set', validateObject(config, 'config')),
    check: () => ipcRenderer.invoke('config:check'),
    reloadBridges: () => ipcRenderer.invoke('config:reload-bridges'),
    user: {
      get: () => ipcRenderer.invoke('config:user:get'),
      set: (config: any) => ipcRenderer.invoke('config:user:set', validateObject(config, 'config')),
    },
    assistant: {
      get: () => ipcRenderer.invoke('config:assistant:get'),
      set: (config: any) => ipcRenderer.invoke('config:assistant:set', validateObject(config, 'config')),
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    restart: () => ipcRenderer.invoke('window:restart'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    /** 2026-08-25 界面自检员: 窗口截图(dataURL) */
    screenshot: () => ipcRenderer.invoke('shell:screenshot'),
    isMinimized: () => ipcRenderer.invoke('window:isMinimized'),
    restore: () => ipcRenderer.invoke('window:restore'),
  },
  file: {
    open: (filePath: string) => ipcRenderer.invoke('file:open', validateString(filePath, 'filePath')),
    readBase64: (filePath: string) => ipcRenderer.invoke('file:read-base64', validateString(filePath, 'filePath')),
  },
  app: {
    getVersion: () => ipcRenderer.invoke('app:version'),
    checkUpdate: (updateUrl: string) => ipcRenderer.invoke('app:checkUpdate', validateString(updateUrl, 'updateUrl')),
    autostart: {
      get: () => ipcRenderer.invoke('app:autostart:get'),
      set: (enabled: boolean) => ipcRenderer.invoke('app:autostart:set', validateBoolean(enabled, 'enabled')),
    },
    bootMusic: {
      getPath: () => ipcRenderer.invoke('app:boot-music:path'),
    },
  },
  voice: {
    play: (filePath: string) => ipcRenderer.invoke('voice:play', validateString(filePath, 'filePath')),
    stop: () => ipcRenderer.invoke('voice:stop'),
    togglePause: () => ipcRenderer.invoke('voice:toggle-pause'),
    readAudioFile: (fp: string) => ipcRenderer.invoke('voice:read-audio', validateString(fp, 'filePath')),
    setDuck: (ducked: boolean) => ipcRenderer.invoke('voice:setDuck', validateBoolean(ducked, 'ducked')),
    onStopped: (callback: () => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = () => callback()
      ipcRenderer.on('voice:stopped', handler)
      return () => { ipcRenderer.removeListener('voice:stopped', handler) }
    },
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', validateString(url, 'url')),
    // 2026-08-21: 对话附件本地文件打开——openExternal 仅放行 https/http，
    // 本地文件须走 openPath（主进程路径白名单校验，见 shell:openPath handler）
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', validateString(filePath, 'filePath')),
  },
  browser: {
    onOpenTab: (callback: (url: string) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, url: string) => callback(url)
      ipcRenderer.on('browser:open-tab', handler)
      return () => { ipcRenderer.removeListener('browser:open-tab', handler) }
    },
  },
  splash: {
    onProgress: (callback: (event: any) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, data: any) => callback(data)
      ipcRenderer.on('splash:progress', handler)
      return () => { ipcRenderer.removeListener('splash:progress', handler) }
    },
    // 2026-08-03: 渲染就绪握手——前端订阅完成后再开始发进度事件，
    // 否则 dev 模式 vite 加载慢时事件全丢（五项永远"等待中"）
    ready: () => {
      ipcRenderer.send('splash:renderer-ready')
    },
  },
  wake: {
    setKeyword: (word: string | string[]) => {
      // 2026-08-06: 支持多唤醒词数组
      if (!Array.isArray(word)) {
        validateString(word, 'word')
        word = [word]
      } else if (word.length === 0) {
        throw new Error('word 不能为空数组')
      }
      return ipcRenderer.invoke('wake:set-keyword', word)
    },
    onHit: (callback: (payload: { keyword: string }) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: { keyword: string }) => callback(payload)
      ipcRenderer.on('wake:hit', handler)
      return () => { ipcRenderer.removeListener('wake:hit', handler) }
    },
    onStatus: (callback: (payload: any) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: any) => callback(payload)
      ipcRenderer.on('wake:status', handler)
      return () => { ipcRenderer.removeListener('wake:status', handler) }
    },
    // 2026-08-03: 麦克风占用切换——ASR 会话激活时暂停 KWS 采集（避免并发抢 mic）
    // F7: 改 invoke——等待主进程确认 probe 已完成切换再 resolve,消除抢麦竞态
    setMicEnabled: (enabled: boolean) => {
      return ipcRenderer.invoke('wake:mic-enabled', enabled)
    },
    // 2026-08-04: 窗口化音频能量检测(移植 LiveKit audiolevel)——语音球能量驱动
    onAudioLevel: (callback: (payload: { level: number; active: boolean }) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: { level: number; active: boolean }) => callback(payload)
      ipcRenderer.on('wake:audio-level', handler)
      return () => { ipcRenderer.removeListener('wake:audio-level', handler) }
    },
    // 2026-08-15: 语音能量打断(barge-in)——TTS 播放窗口内说任何话即可打断
    setBargeinWindow: (v: boolean) => {
      return ipcRenderer.invoke('wake:bargein-window', v)
    },
    onSpeechBargein: (callback: (payload: { rms: number; baseline: number }) => void) => {
      if (typeof callback !== 'function') throw new Error('Invalid callback: expected function')
      const handler = (_: any, payload: { rms: number; baseline: number }) => callback(payload)
      ipcRenderer.on('wake:speech-bargein', handler)
      return () => { ipcRenderer.removeListener('wake:speech-bargein', handler) }
    },
  },
})
