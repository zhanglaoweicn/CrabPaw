/**
 * sse-hub — 单连接 SSE 总线(GUI 全量修复 P4, G7 遗留项)
 *
 * 旧实现: 9 处独立 useSse({path:'/events'}) 各建一条连接(Electron 下各经一条
 * IPC api:sse 流)——10 条并行连接。本 hub 把连接收敛为按 path 分组的单例:
 * 首个订阅者建立连接, 末个订阅者注销时关闭; 事件按名多播到 Set<fn>
 * (activity/file_generated 有双消费者, 必须多播而非单 handler)。
 *
 * 语义保持:
 * - 哑管道——事件名零转换(AG-UI 大写事件名 RUN_STARTED 等原样穿透)
 * - Electron 优先 api:sse IPC(一次 invoke + 全局 sseOnData 按 streamId 过滤),
 *   浏览器回退 EventSource
 * - 指数退避重连(复制 useSSE 原逻辑: 防重复调度/60s 上限/maxRetry)
 * - onStatus 补发: 新订阅者立即收到当前连接状态(useAgentMonitor wsConnected 依赖)
 * - per-fn try/catch 错误隔离(一个 handler 抛错不影响其他)
 */

export type SseHubStatus = 'open' | 'error' | 'giveup'

export interface SseHubStatusInfo {
  url?: string
  retry?: number
  delay?: number
  error?: unknown
}

import { getApiBaseUrl } from './api'

type Handler = (data: any, seq?: number) => void
type StatusCb = (status: SseHubStatus, info?: SseHubStatusInfo) => void

interface HubGroup {
  path: string
  listeners: Map<string, Set<Handler>>
  statusListeners: Set<StatusCb>
  maxRetry: number
  baseDelayMs: number
  status: SseHubStatus | null
  // 连接资源
  streamId: string | null
  eventSource: EventSource | null
  /** P4: 连接建立中(异步 invoke/await 期间防二次触发) */
  connecting: boolean
  retryCount: number
  /** 2026-08-18 AG-UI 协议化: 已消费的最大帧 seq(重连 since 携带 + 帧级去重) */
  lastSeq: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
  ipcCleanups: (() => void)[]
  /** 2026-08-19 三栏联动轮: 帧环形缓冲(P3 时间线回放数据源)——
   *  去重后记录(seq/事件名/载荷/到达时刻), 上限 REPLAY_BUFFER_MAX, 环形裁剪最旧 */
  replayBuffer: SseReplayFrame[]
}

/** 回放帧快照(时间线回放条消费——纯数据, 不含函数引用, 可安全跨组件传递) */
export interface SseReplayFrame {
  seq: number
  event: string
  data: unknown
  at: number
}

/** 帧缓冲上限(与后端 REPLAY_MAX=500 同量级; 前端仅回放定位用, 300 足够) */
export const REPLAY_BUFFER_MAX = 300

// ── 全局 IPC 监听(每 path 一组; 首连注册, 末连注销) ──
const groups = new Map<string, HubGroup>()
let globalIpcBound = false
let ipcUnsubs: (() => void)[] = []

const RESERVED_SSE_EVENTS = new Set(['error', 'open', 'message'])

function createGroup(path: string, maxRetry: number, baseDelayMs: number): HubGroup {
  return {
    path,
    listeners: new Map(),
    statusListeners: new Set(),
    maxRetry,
    baseDelayMs,
    status: null,
    connecting: false,
    streamId: null,
    eventSource: null,
    retryCount: 0,
    lastSeq: 0,
    reconnectTimer: null,
    closed: false,
    ipcCleanups: [],
    replayBuffer: [],
  }
}

function emitStatus(group: HubGroup, status: SseHubStatus, info?: SseHubStatusInfo) {
  group.status = status
  for (const cb of group.statusListeners) {
    try { cb(status, info) } catch (e) { console.warn('[sse-hub] status 回调异常:', e) }
  }
}

/** 服务端 id: <seq> 行解析(EventSource lastEventId 为 string, IPC 帧为 number) */
const parseSeq = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

function dispatchEvent(group: HubGroup, event: string, rawData: string, seq?: number) {
  if (event === 'connected') {
    // 后端重启对账: 服务端 seq 归零重计, 客户端旧 lastSeq 作废防黑障
    // (connected 帧不带 id:, 不参与 seq 去重, 仅作对账信号)
    try {
      const c = JSON.parse(rawData)
      if (typeof c.seq === 'number' && c.seq < group.lastSeq) group.lastSeq = 0
    } catch (e) { console.warn('[sse-hub] connected 帧解析失败:', e) }
  }
  const set = group.listeners.get(event)
  if (!set || set.size === 0) return
  // 2026-08-18 AG-UI 协议化: seq 去重(重放帧与直播帧交界防重)
  if (seq != null) {
    if (seq <= group.lastSeq) return
    group.lastSeq = seq
  }
  let parsed: any
  try {
    parsed = JSON.parse(rawData)
  } catch (parseErr) {
    console.warn('[sse-hub] JSON 解析失败:', String(rawData).slice(0, 120), parseErr)
    return
  }
  // 2026-08-19 三栏联动轮: 帧缓冲记录(环形裁剪)——回放条读此快照定位历史事件
  if (seq != null && typeof seq === 'number') {
    group.replayBuffer.push({ seq, event, data: parsed, at: Date.now() })
    if (group.replayBuffer.length > REPLAY_BUFFER_MAX) {
      group.replayBuffer.splice(0, group.replayBuffer.length - REPLAY_BUFFER_MAX)
    }
  }
  // per-fn 隔离: 一个 handler 抛错不影响其他订阅者
  for (const fn of Array.from(set)) {
    try { fn(parsed, seq) } catch (e) { console.error(`[sse-hub] 事件 ${event} 处理器异常:`, e) }
  }
}

function cleanupGroup(group: HubGroup) {
  if (group.reconnectTimer) {
    clearTimeout(group.reconnectTimer)
    group.reconnectTimer = null
  }
  if (group.eventSource) {
    group.eventSource.close()
    group.eventSource = null
  }
  if (group.streamId && typeof window !== 'undefined' && window.electronAPI?.api?.sseClose) {
    window.electronAPI.api.sseClose(group.streamId).catch((e: any) => console.warn('[sse-hub] sseClose 失败:', e?.message || e))
    group.streamId = null
  }
  group.ipcCleanups.forEach(fn => { try { fn() } catch (err) { console.warn('[sse-hub] IPC cleanup 失败:', err) } })
  group.ipcCleanups = []
}

function scheduleRetry(group: HubGroup) {
  if (group.closed) return
  if (group.retryCount < group.maxRetry) {
    // 防重复调度(旧实现注释: sseOnEnd/onerror/catch 多入口并发会双触发连接)
    if (group.reconnectTimer) {
      clearTimeout(group.reconnectTimer)
      group.reconnectTimer = null
    }
    const delay = Math.min(group.baseDelayMs * Math.pow(2, group.retryCount), 60000)
    group.retryCount++
    emitStatus(group, 'error', { retry: group.retryCount, delay })
    group.reconnectTimer = setTimeout(() => { group.reconnectTimer = null; connectGroup(group) }, delay)
  } else {
    emitStatus(group, 'giveup', { retry: group.retryCount })
  }
}

function connectGroup(group: HubGroup) {
  if (group.closed) return
  if (group.connecting) return
  group.connecting = true
  cleanupGroup(group)
  const finishConnect = () => { group.connecting = false }
  group.ipcCleanups.push(finishConnect) // 借用 cleanup 统一复位(简单可靠)

  // ── Electron IPC 路径: 主进程代连 ──
  if (typeof window !== 'undefined' && window.electronAPI?.api?.sse) {
    // Task 4: 重连携带 since(服务端重放 seq > since 的帧); Task 6 主进程消费
    try {
      window.electronAPI.api.sse({ endpoint: group.path, since: group.lastSeq || undefined })
        .then((result: any) => {
          if (group.closed) return
          if (!result?.success) {
            group.connecting = false
            console.warn('[sse-hub] api:sse 连接失败:', result?.error)
            scheduleRetry(group)
            return
          }
          group.streamId = result.streamId
          group.connecting = false
          bindGlobalIpc()
          group.retryCount = 0
          emitStatus(group, 'open')
        })
        .catch((err: any) => {
          if (group.closed) return
          group.connecting = false
          console.warn('[sse-hub] api:sse 异常:', err?.message || err)
          scheduleRetry(group)
        })
    } catch (e) {
      // Task 6 前 preload validateString 对非 string 同步抛异常——捕获后退避重试, 不楔死 group
      if (group.closed) return
      group.connecting = false
      console.error('[sse-hub] IPC 连接失败(退避重试):', e && (e as Error).message)
      scheduleRetry(group)
    }
    return
  }

  // ── 浏览器/回退路径: EventSource ──
  const connectEs = async () => {
    let url: string
    if (typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) {
      const streamInfo = await window.electronAPI.api.streamUrl(group.path)
      if (group.closed) return
      url = streamInfo.url
    } else {
      const baseUrl = await getApiBaseUrl()
      if (group.closed) return
      url = `${baseUrl}${group.path}`
    }
    // Task 4: 断线重连补拉——携带 since(服务端重放 seq > since 的帧)
    const since = group.lastSeq > 0 ? `since=${group.lastSeq}` : ''
    url = since ? (url.includes('?') ? `${url}&${since}` : `${url}?${since}`) : url
    if (group.closed) return
    const es = new EventSource(url)
    group.connecting = false
    group.eventSource = es
    // 当前所有已订阅事件注册 addEventListener(后续新订阅由 subscribe 补注册)
    for (const [event] of group.listeners) {
      if (RESERVED_SSE_EVENTS.has(event)) continue
      es.addEventListener(event, (e: MessageEvent) => dispatchEvent(group, event, String(e.data), parseSeq(e.lastEventId)))
    }
    es.onerror = (err) => {
      es.close()
      if (group.eventSource === es) group.eventSource = null
      emitStatus(group, 'error', { error: err })
      if (!group.closed) scheduleRetry(group)
    }
    es.onopen = () => {
      group.retryCount = 0
      emitStatus(group, 'open', { url })
    }
  }
  connectEs().catch((err) => {
    if (group.closed) return
    group.connecting = false
    emitStatus(group, 'error', { error: err })
    scheduleRetry(group)
  })
}

/** 全局 IPC 监听注册(惰性——首个 group 连接成功时绑定一次) */
function bindGlobalIpc() {
  if (globalIpcBound || typeof window === 'undefined') return
  const api = window.electronAPI?.api
  if (!api) return
  const unsubData = api.sseOnData?.(({ streamId, data, event, seq }: { streamId: string; data: string; event?: string; seq?: number }) => {
    const group = Array.from(groups.values()).find(g => g.streamId === streamId)
    if (!group) return
    dispatchEvent(group, event || 'message', data, seq)
  })
  const unsubEnd = api.sseOnEnd?.(({ streamId }: { streamId: string }) => {
    const group = Array.from(groups.values()).find(g => g.streamId === streamId)
    if (!group) return
    emitStatus(group, 'error', { error: new Error('SSE stream ended') })
    if (!group.closed) scheduleRetry(group)
  })
  const unsubError = api.sseOnError?.(({ streamId, error }: { streamId: string; error: string }) => {
    const group = Array.from(groups.values()).find(g => g.streamId === streamId)
    if (!group) return
    console.warn('[sse-hub] SSE 错误:', error)
    emitStatus(group, 'error', { error: new Error(error) })
    if (!group.closed) scheduleRetry(group)
  })
  if (unsubData) ipcUnsubs.push(unsubData)
  if (unsubEnd) ipcUnsubs.push(unsubEnd)
  if (unsubError) ipcUnsubs.push(unsubError)
  globalIpcBound = true
}

function unbindGlobalIpc() {
  if (!globalIpcBound) return
  ipcUnsubs.forEach(fn => { try { fn() } catch (e) { console.warn('[sse-hub] IPC 全局解绑失败:', e) } })
  ipcUnsubs = []
  globalIpcBound = false
}

/** 该 path 的 group 是否已无任何订阅者(连接/状态) */
function hasNoSubscribers(group: HubGroup): boolean {
  if (group.statusListeners.size > 0) return false
  for (const set of group.listeners.values()) {
    if (set.size > 0) return false
  }
  return true
}

function closeGroupIfEmpty(group: HubGroup) {
  if (!hasNoSubscribers(group)) return
  group.closed = true
  cleanupGroup(group)
  groups.delete(group.path)
  // 全局 IPC 仅当没有任何 active group 时才解绑
  const anyActive = Array.from(groups.values()).some(g => !g.closed && !hasNoSubscribers(g))
  if (!anyActive) unbindGlobalIpc()
}

/**
 * 订阅事件。返回取消函数。
 * @param maxRetry/baseDelayMs 仅首个订阅者生效(组级连接参数)
 */
export function subscribeSse(
  path: string,
  event: string,
  fn: Handler,
  opts: { maxRetry?: number; baseDelayMs?: number } = {},
): () => void {
  let group = groups.get(path)
  if (!group) {
    group = createGroup(path, opts.maxRetry ?? 10, opts.baseDelayMs ?? 2000)
    groups.set(path, group)
  }
  if (group.closed) {
    group.closed = false
    group.retryCount = 0
    groups.set(path, group)
  }
  let set = group.listeners.get(event)
  if (!set) {
    set = new Set()
    group.listeners.set(event, set)
    // EventSource 路径下补注册新事件(连接已建立时)
    if (group.eventSource && !RESERVED_SSE_EVENTS.has(event)) {
      const es = group.eventSource
      es.addEventListener(event, (e: MessageEvent) => dispatchEvent(group, event, String(e.data), parseSeq(e.lastEventId)))
    }
  }
  set.add(fn)

  // 首次订阅者触发连接
  if (!group.streamId && !group.eventSource && !group.connecting && group.retryCount === 0 && !group.reconnectTimer) {
    connectGroup(group)
  }

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    const s = group!.listeners.get(event)
    if (s) {
      s.delete(fn)
      if (s.size === 0) group!.listeners.delete(event)
    }
    closeGroupIfEmpty(group!)
  }
}

/** 订阅连接状态(新订阅者立即补发当前状态)。返回取消函数。 */
export function subscribeSseStatus(path: string, cb: StatusCb): () => void {
  let group = groups.get(path)
  if (!group) {
    group = createGroup(path, 10, 2000)
    groups.set(path, group)
  }
  if (group.closed) {
    group.closed = false
    group.retryCount = 0
    groups.set(path, group)
  }
  group.statusListeners.add(cb)
  // 补发当前状态(useAgentMonitor wsConnected 依赖此语义)
  if (group.status) {
    try { cb(group.status) } catch (e) { console.warn('[sse-hub] 状态补发回调异常:', e) }
  }
  if (!group.streamId && !group.eventSource && !group.connecting && group.retryCount === 0 && !group.reconnectTimer) {
    connectGroup(group)
  }

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    group!.statusListeners.delete(cb)
    closeGroupIfEmpty(group!)
  }
}

/** 2026-08-19 三栏联动轮: 读取指定 path 的帧缓冲快照(回放条轮询消费, 无订阅副作用) */
export function getSseReplayBuffer(path: string): SseReplayFrame[] {
  const group = groups.get(path)
  return group ? group.replayBuffer : []
}

/** 调试/测试: 当前活跃连接数 */
export function getSseHubActiveGroups(): number {
  return Array.from(groups.values()).filter(g => !g.closed && (!!g.streamId || !!g.eventSource)).length
}

/** 测试/清理: 关闭全部连接并重置状态 */
export function resetSseHub() {
  for (const group of groups.values()) {
    group.closed = true
    cleanupGroup(group)
  }
  groups.clear()
  unbindGlobalIpc()
}

// HMR/页面卸载兜底: 防止残留连接
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', resetSseHub)
}
