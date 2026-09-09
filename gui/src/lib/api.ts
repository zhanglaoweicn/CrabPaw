type ApiCredentials = {
  port: number
  baseUrl: string
  token?: string
}

import { toUserFriendlyError } from './error-handler'

/** 2026-08-08(审计 P1): 请求超时专用异常——与调用方取消(AbortError)区分。
 * 旧实现 fetch 超时 abort 被一律判为"用户取消"(aborted:true),调用方静默处理,
 * 无错误提示无重试;timeout 的友好映射永远不可达。 */
export class ApiTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiTimeoutError'
  }
}

let cachedCredentials: ApiCredentials | null = null
let credentialRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCredentialRefresh() {
  if (credentialRefreshTimer) {
    clearTimeout(credentialRefreshTimer)
  }
  credentialRefreshTimer = setTimeout(() => {
    cachedCredentials = null
  }, 30000)
}

export async function getCredentials(): Promise<ApiCredentials> {
  if (cachedCredentials && cachedCredentials.baseUrl) {
    return cachedCredentials
  }

  if (window.electronAPI?.api?.credentials) {
    try {
      const electronCreds = await window.electronAPI.api.credentials()
      if (electronCreds && electronCreds.baseUrl) {
        cachedCredentials = {
          port: electronCreds.port || 38767,
          baseUrl: electronCreds.baseUrl || 'http://localhost:38767',
          token: electronCreds.token || undefined,
        }
        scheduleCredentialRefresh()
        return cachedCredentials
      }
    } catch (e) {
      console.warn('Failed to get Electron credentials:', e)
    }
  }

  const defaultCreds: ApiCredentials = {
    port: 38767,
    baseUrl: 'http://localhost:38767',
  }

  // 2026-08-05 fix: 浏览器(非 Electron)模式此前永远拿不到 token——
  // ASR/PTT WS 的 ?token= 为空被后端 401 拦截。改为从后端
  // localhost-only 的 /api/auth/bootstrap 引导端点取 token 并缓存。
  try {
    const base = defaultCreds.baseUrl
    const resp = await fetch(`${base}/auth/bootstrap`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      // 2026-08-08(审计 P1): 引导 fetch 无超时——后端 TCP 挂起时 getCredentials
      // 永不 resolve,所有依赖请求无限挂起。5s 超时后回落无 token 路径。
      signal: AbortSignal.timeout(5000),
    })
    if (resp.ok) {
      const data = await resp.json()
      if (data && data.success && data.token) {
        cachedCredentials = { ...defaultCreds, token: data.token }
        scheduleCredentialRefresh()
        return cachedCredentials
      }
    }
  } catch (e) {
    console.warn('[api] bootstrap token fetch failed (fallback to tokenless):', e)
  }

  cachedCredentials = defaultCreds
  return defaultCreds
}

export function clearCredentialsCache() {
  cachedCredentials = null
  if (credentialRefreshTimer) {
    clearTimeout(credentialRefreshTimer)
    credentialRefreshTimer = null
  }
}

/**
 * In Electron dev mode (Vite proxy available), return the same-origin URL
 * to avoid CORS preflight for direct fetch() calls (e.g. TTS streaming).
 * NOTE: do NOT change getApiBaseUrl() itself — it is also used to derive
 * WebSocket URLs via getWsBase(), and the Vite proxy only supports WebSocket
 * for /voice/cloud specifically.
 */
export function getFetchOrigin(): string {
  if (isElectron() && typeof window !== 'undefined') {
    const o = window.location.origin
    if (o.startsWith('http://localhost') || o.startsWith('http://127.0.0.1')) return o
  }
  return ''
}

export async function getApiBaseUrl(): Promise<string> {
  // Non-Electron mode: detect runtime environment to determine API address
  if (!isElectron()) {
    // Vite dev mode: connect directly to backend (CORS enabled),
    // avoiding Vite proxy config (paths like /chat may not be proxied)
    try {
      if ((import.meta as unknown as { env: { DEV?: boolean } }).env?.DEV) {
        const port = 38767
        return `http://localhost:${port}`
      }
    } catch (e: any) { /* ignore — import.meta.env not available */ console.warn('[api] getApiBaseUrl DEV check failed:', e?.message || e) }
    // Production: if current page is served by backend, use same origin; otherwise default port
    if (typeof window !== 'undefined' && window.location.origin) {
      const origin = window.location.origin
      // If origin doesn't look like a Vite dev port (5173/5174), use it directly
      if (!/:51[0-9]{2}$/.test(origin)) {
        return origin
      }
    }
  }
  const creds = await getCredentials()
  return creds.baseUrl
}

/**
 * 2026-08-04: 获取带鉴权的完整 API URL。
 * Electron 模式(S4 安全设计:渲染进程不暴露 token,api:credentials 无 token)
 * → 走 api:streamUrl IPC 将 token 注入 URL 查询参数(后端鉴权中间件认 query token,
 * 与 SSE/音乐同款机制);非 Electron → 拼接 baseUrl(调用方用 getApiHeaders 走 header)。
 */
export async function resolveApiUrl(endpoint: string): Promise<string> {
  if (typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) {
    // 2026-08-08(审计 P2): streamUrl IPC 异常不裸抛——与 apiUpload 一致映射为失败结果
    try {
      const info = await window.electronAPI.api.streamUrl(endpoint)
      return info.url
    } catch (e: any) {
      console.warn('[api] resolveApiUrl streamUrl 获取失败:', e?.message || e)
    }
  }
  const baseUrl = await getApiBaseUrl()
  return `${baseUrl}${endpoint}`
}

export async function getApiHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  // A4 fix: 复用 getCredentials 缓存获取 token，不再单独 IPC 调用
  const creds = await getCredentials()
  if (creds.token) {
    headers['X-Api-Key'] = creds.token
  }
  return headers
}

export interface ApiResult<T = any> {
  success: boolean
  data?: T
  error?: string
  aborted?: boolean
}

/**
 * Extract business data from apiGet result.
 * Electron proxy path: result.data is the response without {success} wrapper.
 * Fetch path: result already contains the response body (may include {success}), extract relevant fields.
 */
export function extractApiData<T>(result: ApiResult<T>): T | null {
  if (result.data !== undefined) return result.data
  const { success, error, ...rest } = result as ApiResult<T> & Record<string, unknown>
  return Object.keys(rest).length > 0 ? rest as T : null
}

async function electronProxy<T = any>(method: string, endpoint: string, body?: any, signal?: AbortSignal): Promise<{ success: boolean; data?: T; error?: string; status?: number; aborted?: boolean }> {
  if (!window.electronAPI?.api?.proxy) {
    return { success: false, error: 'Electron proxy unavailable' }
  }
  // 2026-08-07: signal 上的 abort 监听在 settle 后移除(防监听器泄漏)
  let onAbort: (() => void) | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await Promise.race([
      window.electronAPI.api.proxy(method, endpoint, body),
      new Promise<never>((_, reject) => {
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
        onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        signal?.addEventListener('abort', onAbort, { once: true })
        // 2026-08-08(审计 P1): 主进程代理无超时——主进程 proxy 挂起则
        // apiGet/apiPost 永久挂起。60s 超时(G10 审计: Electron proxy 路径长任务 15s 过短)。
        timeoutTimer = setTimeout(() => reject(new ApiTimeoutError(`Electron proxy 超时(60s): ${endpoint}`)), 60000)
      }),
    ])
    return result
  } catch (e: any) {
    // 2026-08-07: abort 语义——调用方取消时返回 aborted 标记(与 fetch 路径一致),
    // 避免错误信息被 toUserFriendlyError 误映射成普通失败
    if (e?.name === 'AbortError' || signal?.aborted) {
      return { success: false, error: '请求已取消', aborted: true }
    }
    // 2026-08-08: 超时 → 'timeout' 键让 toUserFriendlyError 映射为友好提示
    if (e?.name === 'ApiTimeoutError') {
      console.warn('[api] electronProxy 超时:', endpoint)
      return { success: false, error: 'timeout' }
    }
    return { success: false, error: e.message || String(e) }
  } finally {
    if (onAbort && signal) {
      signal.removeEventListener('abort', onAbort)
    }
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}

/**
 * 2026-08-07: 统一 fetch 请求封装——apiGet/apiPost/apiDelete/apiUpload 的 fetch 分支共用:
 * - 网络/超时异常 → {success:false, error} + toUserFriendlyError 友好映射
 * - AbortError → {success:false, aborted:true}(调用方取消,不视为失败)
 * - 401 → 清理凭据缓存并返回友好错误
 * 保证四个 api* 函数返回契约(ApiResult)一致。
 */
async function requestFetch<T = any>(
  endpoint: string,
  opts: { method: string; headers?: Record<string, string>; body?: unknown; formData?: FormData; signal?: AbortSignal; label?: string; url?: string }
): Promise<ApiResult<T>> {
  try {
    const baseUrl = opts.url || (await getApiBaseUrl())
    let headers = opts.headers || (await getApiHeaders())
    if (opts.formData) {
      // 删除 Content-Type 让浏览器自动设置 multipart boundary
      headers = { ...headers }
      delete headers['Content-Type']
    }
    const res = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
      method: opts.method,
      headers,
      body: opts.formData || (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: opts.signal,
    })

    if (res.status === 401) {
      clearCredentialsCache()
      return { success: false, error: toUserFriendlyError('401') }
    }

    if (!res.ok) {
      let errorMsg = `API error: ${res.status}`
      try {
        const errData = await res.json()
        errorMsg = errData.message || errData.error || errorMsg
      } catch (e: any) { console.warn(`[api] ${opts.label || 'API'} 错误响应 JSON 解析失败:`, e?.message || e) }
      return { success: false, error: toUserFriendlyError(errorMsg) }
    }

    const jsonData = await res.json()
    if (jsonData && typeof jsonData === 'object' && 'success' in jsonData) {
      const { success, error, data: innerData, ...rest } = jsonData
      // 优先使用内层 data 字段（若存在），避免双层嵌套
      const effectiveData = innerData !== undefined ? innerData : rest
      return {
        success,
        data: (effectiveData && typeof effectiveData === 'object' && Object.keys(effectiveData).length > 0) ? (effectiveData as T) : undefined,
        error,
      }
    }
    return { success: true, data: jsonData }
  } catch (e: any) {
    if (e?.name === 'AbortError' || opts.signal?.aborted) {
      return { success: false, error: '请求已取消', aborted: true }
    }
    // 2026-08-08(审计 P1): 超时不再被当作"用户取消"静默吞掉——单独映射友好提示
    if (e?.name === 'ApiTimeoutError') {
      console.warn(`[api] ${opts.label || 'API'} 请求超时:`, e?.message || e)
      return { success: false, error: toUserFriendlyError('timeout') }
    }
    console.error(`[api] ${opts.label || 'API'} 请求失败:`, e)
    return { success: false, error: toUserFriendlyError(e) }
  }
}

export async function apiGet<T = any>(endpoint: string, options?: { signal?: AbortSignal }): Promise<ApiResult<T>> {
  if (window.electronAPI?.api?.proxy) {
    const result = await electronProxy('GET', endpoint, undefined, options?.signal)
    if (result.status === 401) {
      clearCredentialsCache()
      return { success: false, error: toUserFriendlyError('401') }
    }
    if (!result.success) {
      // 2026-08-07: 透传 abort 标记(调用方取消不是业务失败)
      if (result.aborted) return { success: false, error: result.error, aborted: true }
      return { success: false, error: toUserFriendlyError(result.error || `API error: ${result.status}`) }
    }
    return { success: true, data: result.data }
  }

  // 非 Electron: fetch 分支(统一 requestFetch——含超时/401/错误映射/abort 语义)
  return requestFetch<T>(endpoint, { method: 'GET', signal: options?.signal, label: 'apiGet' })
}

export async function apiPost<T = any>(endpoint: string, data: any, method: 'POST' | 'PUT' | 'PATCH' = 'POST', signal?: AbortSignal): Promise<ApiResult<T>> {
  if (window.electronAPI?.api?.proxy) {
    const result = await electronProxy(method, endpoint, data, signal)
    
    if (result.status === 401) {
      clearCredentialsCache()
      return { success: false, error: toUserFriendlyError('401') }
    }
    if (!result.success) {
      // 2026-08-07: 透传 abort 标记(调用方取消不是业务失败)
      if (result.aborted) return { success: false, error: result.error, aborted: true }
      return { success: false, error: toUserFriendlyError(result.error || `API error: ${result.status}`) }
    }
    return { success: true, data: result.data }
  }

  // A2 fix: 与 apiGet 统一返回 ApiResult<T>——fetch 分支走统一 requestFetch(含超时/401/错误映射/abort)
  return requestFetch<T>(endpoint, { method, body: data, signal, label: 'apiPost' })
}

export async function apiPut<T = any>(endpoint: string, data: any, signal?: AbortSignal): Promise<ApiResult<T>> {
  return apiPost<T>(endpoint, data, 'PUT', signal)
}

export async function apiPatch<T = any>(endpoint: string, data: any, signal?: AbortSignal): Promise<ApiResult<T>> {
  return apiPost<T>(endpoint, data, 'PATCH', signal)
}

export async function apiDelete<T = any>(endpoint: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  if (window.electronAPI?.api?.proxy) {
    const result = await electronProxy('DELETE', endpoint, undefined, signal)
    if (result.status === 401) {
      clearCredentialsCache()
      return { success: false, error: toUserFriendlyError('401') }
    }
    if (!result.success) {
      // 2026-08-07: 透传 abort 标记(调用方取消不是业务失败)
      if (result.aborted) return { success: false, error: result.error, aborted: true }
      return { success: false, error: toUserFriendlyError(result.error || `API error: ${result.status}`) }
    }
    return { success: true, data: result.data }
  }

  // fetch 分支走统一 requestFetch(含超时/401/错误映射/abort 语义)
  return requestFetch<T>(endpoint, { method: 'DELETE', signal, label: 'apiDelete' })
}

export async function apiUpload<T = any>(endpoint: string, formData: FormData): Promise<ApiResult<T>> {
  // A3 fix: Electron 模式下通过 streamUrl 获取带认证的 URL
  if (window.electronAPI?.api?.streamUrl) {
    try {
      const streamInfo = await window.electronAPI.api.streamUrl(endpoint)
      // 2026-08-07: 统一走 requestFetch(url 覆盖)——含超时/401/错误映射/abort 语义
      return await requestFetch<T>(endpoint, { url: streamInfo.url, method: 'POST', formData, label: 'apiUpload' })
    } catch (e: any) {
      // 2026-08-07: streamUrl IPC 异常同样映射为失败结果(不再裸抛)
      console.error('[api] apiUpload streamUrl 获取失败:', e)
      return { success: false, error: toUserFriendlyError(e) }
    }
  }

  // A3 fix: 非 Electron 模式添加认证头(formData 时 requestFetch 自动删除 Content-Type 让浏览器设置 boundary)
  return requestFetch<T>(endpoint, { method: 'POST', formData, label: 'apiUpload' })
}

/** Fetch wrapper with timeout support */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  // A1 fix: 合并调用方的 AbortSignal 与超时 AbortController
  const controller = new AbortController()
  const callerSignal = options.signal
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  // 如果调用方传入了 signal，监听其 abort 事件
  const onCallerAbort = () => {
    clearTimeout(timer)
    controller.abort()
  }
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort()
    } else {
      callerSignal.addEventListener('abort', onCallerAbort)
    }
  }

  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    return response
  } catch (e: any) {
    // 2026-08-08(审计 P1): 超时与调用方取消区分——超时抛 ApiTimeoutError,
    // 调用方不再把超时静默当"用户取消"(无提示无重试)
    if (timedOut) throw new ApiTimeoutError(`请求超时(${timeoutMs}ms): ${url}`)
    throw e
  } finally {
    clearTimeout(timer)
    // 2026-08-08(审计 P2): 调用方 abort 监听器 settle 后移除——Memory 页复用
    // 同一 controller.signal 多次 apiGet,旧实现监听器累积(once 仅 abort 时清理)
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort)
    }
  }
}

export function isElectron(): boolean {
  return !!window.electronAPI
}

/**
 * WebSocket base URL（与 API base 同源，HTTP→WS、HTTPS→WSS）。
 * 用于 SceneStore 实时订阅。
 */
export async function getWsBase(): Promise<string> {
  const apiBase = await getApiBaseUrl()
  if (apiBase.startsWith('https://')) return 'wss://' + apiBase.slice(8)
  if (apiBase.startsWith('http://')) return 'ws://' + apiBase.slice(7)
  return 'ws://' + apiBase
}

function toWebSocketUrl(url: string): string {
  // 防御: streamUrl IPC 返回异常(白名单拒绝/主进程错误)时 url 可能为 undefined,
  // 直接抛 startsWith 崩溃——退回无 token 直连让 WS 层报 401 而非 TypeError
  if (!url || typeof url !== 'string') return ''
  if (url.startsWith('https://')) return 'wss://' + url.slice(8)
  if (url.startsWith('http://')) return 'ws://' + url.slice(7)
  return url
}

export async function getAuthenticatedWsUrl(endpoint: string): Promise<string> {
  if (window.electronAPI?.api?.streamUrl) {
    const streamInfo = await window.electronAPI.api.streamUrl(endpoint)
    return toWebSocketUrl(streamInfo.url)
  }

  const creds = await getCredentials()
  const wsBase = await getWsBase()
  const separator = endpoint.includes('?') ? '&' : '?'
  return `${wsBase}${endpoint}${creds.token ? `${separator}token=${encodeURIComponent(creds.token)}` : ''}`
}
