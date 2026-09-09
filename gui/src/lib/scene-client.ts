/**
 * useSceneClient — 订阅 SceneStore（SCENE-PROTOCOL v1）
 *
 * 任何业务页面都可以用这个 hook 订阅特定的 surface，**不再直接 fetch 业务 API**。
 *
 * 用法：
 *   const nodeGraph = useSceneClient('home.memory_graph')
 *   if (nodeGraph) render(nodeGraph)
 *
 * v1 协议（SCENE-PROTOCOL §1-§3）：
 *   1. connect → 发 hello (caps: scene/patch/morph)
 *   2. 收 welcome + scene 全量
 *   3. 收 scene.patch 增量（带 base 间隙检测）
 *   4. 漏帧时自动发 resync(reason='gap') → 收全量 scene
 *   5. 断线 2s 后自动重连
 *
 * Legacy 兼容：server 若用 AUTO 模式，先发 scene:connected + scene:snapshot，
 *   客户端也支持这种格式（无 hello/welcome，直接收 scene:snapshot）。
 */

import { useEffect, useState } from 'react'
import { apiGet, apiPost, getAuthenticatedWsUrl, extractApiData } from './api'
// P4(GUI 全量修复, G7): SSE 并入 sse-hub 单连接
import { subscribeSse } from './sse-hub'

// ── 进程内 surface 缓存（多个组件共享） ──
const surfaceCache = new Map<string, { surface: any; rev: number; dataRev: number }>()
const subscribers = new Map<string, Set<(s: any) => void>>()
let manifestSubs = new Set<(manifest: any[]) => void>()
let connectedWs: WebSocket | null = null
let pongTimer: any = null
let manifestRev = 0
// 重连定时器句柄（模块级保存，stopSceneClient 可清除，防止重连复活连接）
let retryWsTimer: ReturnType<typeof setTimeout> | null = null
// 停止标记：stopSceneClient 后 tryConnect* 直接返回，不再建立/重连任何连接
let stopped = false

// v1 协议状态
let clientRev = 0          // 客户端已应用的最大 rev
let protocolMode: 'v1' | 'legacy' | 'pending' = 'pending'

// P2-9: 场景纪元——服务端每重推一次全量 scene（初始连接/重启重连/间隙 resync）纪元 +1。
// 后端重启后 scene-store rev 归零重推同数据，旧局部状态（如 VoiceShell dismissedIds）
// 会误命中而让场景卡不重现；订阅纪元可感知"场景世界已重置"并清理。
let epochCounter = 0
const epochSubs = new Set<() => void>()

function notifyEpoch() {
  epochCounter++
  for (const cb of epochSubs) {
    try { cb() } catch (e) { console.warn('[scene-client] epoch callback error:', e) }
  }
}

function notifySurface(id: string, surface: any) {
  const subs = subscribers.get(id)
  if (!subs) return
  for (const cb of subs) {
    try { cb(surface) } catch (e) { console.warn('[scene-client] notifySurface callback error:', e) }
  }
}

function notifyAll() {
  for (const [id, subs] of subscribers.entries()) {
    const entry = surfaceCache.get(id)
    const surface = entry ? entry.surface : null
    for (const cb of subs) {
      try { cb(surface) } catch (e) { console.warn('[scene-client] notifySurface callback error:', e) }
    }
  }
  // notify manifest
  const manifest: any[] = []
  for (const [id, entry] of surfaceCache.entries()) {
    if (entry.surface) {
      manifest.push({
        id,
        kind: entry.surface.kind,
        dataSummary: summarizeData(entry.surface.data),
        intent: entry.surface.intent || 'inform',
      })
    }
  }
  for (const cb of manifestSubs) {
    try { cb(manifest) } catch (e) { console.warn('[scene-client] notifyAll manifest callback error:', e) }
  }
}

function summarizeData(data: any): string {
  if (data == null) return ''
  if (typeof data === 'string') return data.length > 80 ? data.slice(0, 77) + '...' : data
  if (typeof data === 'number' || typeof data === 'boolean') return String(data)
  if (Array.isArray(data)) return `[${data.length} items]`
  if (typeof data === 'object') {
    const keys = Object.keys(data)
    if (keys.length === 0) return '{}'
    if (keys.length <= 3) return '{' + keys.map(k => `${k}:${summarizeData(data[k])}`).join(', ') + '}'
    return `{${keys.length} keys}`
  }
  return String(data).slice(0, 80)
}

async function refreshFromHttp() {
  try {
    const result = await apiGet<any>('/api/scene')
    const snap = extractApiData<any>(result) || (result as any)
    if (snap && (snap.ok || snap.surfaces !== undefined)) {
      const surfaces = (snap.surfaces || []) as any[]
      const incoming = new Map<string, any>()
      for (const s of surfaces) {
        if (s && s.id) incoming.set(s.id, s)
      }
      // remove disappeared
      for (const id of Array.from(surfaceCache.keys())) {
        if (!incoming.has(id)) {
          surfaceCache.delete(id)
          notifySurface(id, null)
        }
      }
      // upsert new — compare data_rev to avoid HTTP poll overwriting newer WS patch data
      for (const [id, s] of incoming.entries()) {
        const existing = surfaceCache.get(id)
        const incomingDataRev = s.data_rev || 0
        if (existing && existing.dataRev > incomingDataRev) continue
        surfaceCache.set(id, { surface: s, rev: snap.rev || 0, dataRev: incomingDataRev })
        notifySurface(id, s)
      }
      // manifestRev 只单调递增，避免回退
      if ((snap.rev || 0) > manifestRev) manifestRev = snap.rev || 0
      clientRev = Math.max(clientRev, snap.rev || 0)
      notifyAll()
    }
  } catch (e) {
    console.warn('[scene-client] refreshFromHttp error:', e)
  }
}

/**
 * 处理 v1 scene 消息
 */
function handleV1Scene(surfaces: any[], rev: number) {
  surfaceCache.clear()
  for (const s of (surfaces || [])) {
    if (s && s.id) surfaceCache.set(s.id, { surface: s, rev, dataRev: s.data_rev || 0 })
  }
  manifestRev = rev
  clientRev = rev
  notifyAll()
  // 全量 scene = 场景纪元切换（后端重启/重连/间隙 resync 均走此路径）
  notifyEpoch()
}

/**
 * 处理 v1 scene.patch 增量
 */
function handleV1Patch(ops: any[], rev: number, base: number) {
  // 间隙检测：base 不等于 clientRev 说明漏帧
  if (base !== clientRev) {
    // 触发 resync (server 收到后会发全量 scene)
    if (connectedWs && connectedWs.readyState === WebSocket.OPEN && protocolMode === 'v1') {
      try {
        connectedWs.send(JSON.stringify({ v: 1, type: 'resync', reason: 'gap' }))
      } catch (e) { console.warn('[scene-client] resync send error:', e) }
    }
    return
  }
  for (const op of (ops || [])) {
    if (op.op === 'upsert' && op.surface) {
      surfaceCache.set(op.id, { surface: op.surface, rev, dataRev: op.surface.data_rev || 0 })
      notifySurface(op.id, op.surface)
    } else if (op.op === 'remove') {
      surfaceCache.delete(op.id)
      notifySurface(op.id, null)
    }
  }
  clientRev = rev
  manifestRev = rev
  notifyAll()
}

function tryConnectWs() {
  // 停止标记：stopSceneClient 后不再建立连接（含 await 期间的竞态）
  if (stopped) return
  if (connectedWs && connectedWs.readyState === WebSocket.OPEN) return
  try {
    // 始终直连后端（getWsBase → ws://localhost:38767）
    // Vite WS 代理对 /scene 握手不稳定，直连更可靠
    const wsUrlPromise = getAuthenticatedWsUrl('/scene')
    wsUrlPromise.then((wsUrl) => {
      // await 期间可能已 stop——复查停止标记，避免复活连接
      if (stopped) return
      // 脱敏：URL 含 ?token=xxx，禁止原样落日志（凭据泄露）
      console.log('[scene-client] 连接 WebSocket:', wsUrl.replace(/[?&]token=[^&]*/gi, '$1token=***'))
      const ws = new WebSocket(wsUrl)
      connectedWs = ws
      ws.onopen = () => {
        // 尝试 v1 握手 (SCENE-PROTOCOL v1 §2)
        try {
          ws.send(JSON.stringify({
            v: 1,
            type: 'hello',
            shell: 'crabpaw-gui',
            shellVersion: '2.3.0',
            caps: ['scene', 'patch', 'morph'],
            rev: clientRev,
          }))
        } catch (e) { console.warn('[scene-client] hello send error:', e) }
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)

          // v1 协议
          if (msg.v === 1) {
            if (msg.type === 'welcome') {
              protocolMode = 'v1'
              // B8 fix: 重连后收到 Welcome 时检查 rev，不匹配触发 resync（防止状态漂移）
              if (msg.rev !== undefined && msg.rev !== clientRev) {
                if (ws.readyState === WebSocket.OPEN) {
                  try {
                    ws.send(JSON.stringify({ v: 1, type: 'resync', reason: 'welcome_rev_mismatch' }))
                  } catch (e) { console.warn('[scene-client] welcome resync send error:', e) }
                }
              }
              // 启动双向 ping/pong (SCENE-PROTOCOL §3.5)
              // 2026-08-28 审计 E2: welcome 可能重入(resync 重发场景)——先清旧 interval
              // 防双倍 ping, 否则 pongTimer 被覆盖且旧 interval 泄漏至连接关闭。
              if (pongTimer) { clearInterval(pongTimer); pongTimer = null }
              pongTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  try { ws.send(JSON.stringify({ v: 1, type: 'ping' })) } catch (e) { console.warn('[scene-client] ping send error:', e) }
                }
              }, 25000)
            } else if (msg.type === 'scene') {
              handleV1Scene(msg.surfaces || [], msg.rev || 0)
            } else if (msg.type === 'scene.patch') {
              handleV1Patch(msg.ops || [], msg.rev || 0, msg.base || 0)
            } else if (msg.type === 'scene:resync-ack') {
              // 全量 scene 会在下一帧到达
            } else if (msg.type === 'pong') {
              // 探活成功
            } else if (msg.type === 'scene:error') {
              console.warn('[scene-client] server error:', msg.error)
            }
            return
          }

          // legacy 兼容
          if (msg.type === 'scene:connected') {
            protocolMode = 'legacy'
          } else if (msg.type === 'scene:snapshot') {
            handleV1Scene(msg.surfaces || [], msg.rev || 0)
          } else if (msg.type === 'scene:patch' && Array.isArray(msg.ops)) {
            // legacy patch 无 base 字段，假设连续
            handleV1Patch(msg.ops || [], msg.rev || 0, clientRev)
          }
        } catch (e) { console.warn('[scene-client] ws.onmessage parse error:', e) }
      }

      ws.onclose = () => {
        connectedWs = null
        protocolMode = 'pending'
        if (pongTimer) { clearInterval(pongTimer); pongTimer = null }
        // 自动重连（stop 后不再调度；句柄模块级保存，stopSceneClient 可清除）
        if (stopped) return
        if (retryWsTimer) clearTimeout(retryWsTimer)
        retryWsTimer = setTimeout(() => { retryWsTimer = null; tryConnectWs() }, 2000)
      }
      ws.onerror = () => {
        try { ws.close() } catch (e) { console.warn('[scene-client] ws.close on error:', e) }
      }
    }).catch((err) => {
      console.warn('[scene-client] WS connection failed:', err)
    })
  } catch (e) {
    console.warn('[scene-client] tryConnectWs error:', e)
  }
}

/** SSE 兜底监听 */
// P4(GUI 全量修复, G7): SSE 通道并入 sse-hub 单连接——不再自建裸 EventSource。
// scene:change 的解析逻辑原样保留, 订阅句柄由 unsubSceneSse 保存供 stop 清理。
let unsubSceneSse: (() => void) | null = null

/**
 * 纯函数：SSE scene:change 是否应被消费（2026-08-25 根因修复）。
 *
 * 根因：每次 scene 变更后端同时广播 WS scene.patch（带 base=server.lastRev）与
 * SSE scene:change；GUI 两个 handler 都消费且都推进 clientRev。WS/SSE 是两条独立
 * 连接、跨通道到达顺序不保证——SSE 先到时 clientRev 已推进到 rev N，后到的 WS
 * patch base=N-1 ≠ N → 客户端判"漏帧" → resync → 全量 scene →
 * surfaceCache.clear()+notifyEpoch() → 场景树整树重建（用户可见"界面一闪一闪"）。
 * 会话内每回合多次 scene 变更（工具卡/面板态/副刊）→ 每回合至少触发一次重排。
 *
 * 修复语义：SSE 是纯兜底通道——WS 主通道在线时忽略（不消费不推进 clientRev）；
 * 降级/重放防护：rev ≤ clientRev 的旧事件不再应用。
 */
export function shouldConsumeSseScene(payload: any, opts: { mode: string; wsOpen: boolean; clientRev: number }): boolean {
  if (!payload) return false
  if (opts.mode === 'v1' && opts.wsOpen) return false
  if (typeof payload.rev === 'number' && payload.rev <= opts.clientRev) return false
  return true
}

function handleSceneChange(payload: any) {
  if (!shouldConsumeSseScene(payload, {
    mode: protocolMode,
    wsOpen: !!(connectedWs && connectedWs.readyState === WebSocket.OPEN),
    clientRev,
  })) {
    return
  }
  if (payload && Array.isArray(payload.ops)) {
    for (const op of payload.ops) {
      if (op.op === 'upsert' && op.surface) {
        surfaceCache.set(op.id, { surface: op.surface, rev: payload.rev || 0, dataRev: op.surface.data_rev || 0 })
        notifySurface(op.id, op.surface)
      } else if (op.op === 'remove') {
        surfaceCache.delete(op.id)
        notifySurface(op.id, null)
      }
    }
    clientRev = Math.max(clientRev, payload.rev || 0)
    manifestRev = clientRev
    notifyAll()
  }
}

function tryConnectSSE() {
  // 停止标记：stopSceneClient 后不再建立连接
  if (stopped) return
  if (unsubSceneSse) return
  unsubSceneSse = subscribeSse('/events', 'scene:change', (data) => {
    try { handleSceneChange(data) } catch (e) { console.warn('[scene-client] SSE scene:change 处理错误:', e) }
  })
}

/** 启动 SceneClient 进程内广播 */
// 2026-08-28 审计 E1: 原 `if (pollTimer) return` 幂等守卫失效——P4 删除常驻轮询后
// pollTimer 恒 null, 重复调用会重复 tryConnectWs/tryConnectSSE。改专用 started 标记。
let sceneClientStarted = false
export function startSceneClient() {
  if (sceneClientStarted) return
  sceneClientStarted = true
  // 支持 stop 后再次 start（重置停止标记）
  stopped = false
  // 首次 HTTP 快照（仅启动一次——P4: 删 5s 常驻轮询, WS 2s 重连 + hub SSE 退避
  // 重连双通道已覆盖增量; 保留启动快照保证首屏有数据）
  refreshFromHttp()
  // WS 优先订阅增量
  tryConnectWs()
  // SSE 兜底（经 sse-hub 单连接, 与其余 9 个订阅者共享一条 /events）
  tryConnectSSE()
}

/** 停止 SceneClient，清理所有定时器和连接（页面导航/关闭时调用） */
export function stopSceneClient() {
  // 停止标记先行：tryConnect* 的 onclose/onerror 重连回调与 await 竞态全部失效
  stopped = true
  if (pongTimer) { clearInterval(pongTimer); pongTimer = null }
  // 清除重连定时器句柄——防止重连回调复活已停止的连接
  if (retryWsTimer) { clearTimeout(retryWsTimer); retryWsTimer = null }
  if (connectedWs) {
    try { connectedWs.close() } catch (e) { console.warn('[scene-client] stopSceneClient ws.close error:', e) }
    connectedWs = null
  }
  // P4: SSE 经 sse-hub——注销订阅(引用计数归零时 hub 自动关连接)
  if (unsubSceneSse) {
    try { unsubSceneSse() } catch (e) { console.warn('[scene-client] stopSceneClient sse 注销 error:', e) }
    unsubSceneSse = null
  }
  protocolMode = 'pending'
  sceneClientStarted = false
}

// 页面关闭时自动清理 pongTimer 和 WS 连接
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { stopSceneClient() })
}

/** 主动获取一个 surface（同步读缓存，触发订阅后能拿到） */
export function readSceneSurface(id: string): any {
  return surfaceCache.get(id)?.surface || null
}

/** 主动 upsert（用 WS 路径，HTTP 兜底） */
export async function sceneUpsert(id: string, data: any) {
  return apiPost('/api/scene/upsert', { id, data })
}

/** 主动 remove */
export async function sceneRemove(id: string) {
  return apiPost('/api/scene/remove', { id })
}

/** 主动 clear */
export async function sceneClear() {
  return apiPost('/api/scene/clear', {})
}

/** 推送 intent（UI → Agent） */
export async function sceneIntent(surfaceId: string, name: string, data: any) {
  return apiPost('/api/scene/intent', { surfaceId, name, data })
}

/** 推送 v1 协议 intent（直接走 WS；断线/发送失败时回落 HTTP sceneIntent） */
export function sceneIntentV1(surfaceId: string, name: string, data: any) {
  if (connectedWs && connectedWs.readyState === WebSocket.OPEN && protocolMode === 'v1') {
    try {
      connectedWs.send(JSON.stringify({
        v: 1, type: 'intent',
        surface: surfaceId, name, data: data || {},
        ts: Date.now(),
      }))
      return true
    } catch (e) {
      console.warn('[scene-client] sceneIntentV1 send error, 回落 HTTP:', e)
      // 发送异常（如 socket 已半关闭）→ 走 HTTP 兜底
      sceneIntent(surfaceId, name, data).catch(err =>
        console.warn('[scene-client] sceneIntentV1 HTTP 回落失败:', err))
      return false
    }
  }
  // WS 未就绪（断线/legacy 模式）→ 回落 HTTP sceneIntent（组件交互不因断线失效）
  sceneIntent(surfaceId, name, data).catch(err =>
    console.warn('[scene-client] sceneIntentV1 HTTP 回落失败:', err))
  return false
}

/**
 * 订阅指定 id 的 surface。返回最新值（可能为 null）。
 */
export function useSceneClient(surfaceId: string): any {
  const [surface, setSurface] = useState<any>(() => surfaceCache.get(surfaceId)?.surface || null)

  useEffect(() => {
    // 重新读一次缓存
    const cached = surfaceCache.get(surfaceId)?.surface || null
    if (cached !== surface) setSurface(cached)

    if (!subscribers.has(surfaceId)) subscribers.set(surfaceId, new Set())
    const sub = (s: any) => setSurface(s)
    subscribers.get(surfaceId)!.add(sub)
    return () => {
      subscribers.get(surfaceId)?.delete(sub)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId])

  return surface
}

/**
 * 订阅所有 surface（manifest）。用于全局 view。
 */
export function useSceneManifest(): { manifest: any[]; rev: number; surfaceMap: Map<string, any> } {
  const [manifest, setManifest] = useState<any[]>([])
  const [rev, setRev] = useState(0)

  useEffect(() => {
    const cb = () => {
      const m: any[] = []
      for (const [id, entry] of surfaceCache.entries()) {
        if (entry.surface) {
          m.push({
            id,
            kind: entry.surface.kind,
            dataSummary: summarizeData(entry.surface.data),
            intent: entry.surface.intent || 'inform',
          })
        }
      }
      setManifest(m)
      setRev(manifestRev)
    }
    manifestSubs.add(cb)
    cb()
    return () => { manifestSubs.delete(cb) }
  }, [])

  return { manifest, rev, surfaceMap: surfaceCache as any }
}

/**
 * 订阅场景纪元（服务端全量重推 scene 时 +1，见 handleV1Scene）。
 * 用于清理基于场景数据的本地状态（如 VoiceShell 的 dismiss 记录，P2-9）。
 */
export function useSceneEpoch(): number {
  const [epoch, setEpoch] = useState<number>(epochCounter)

  useEffect(() => {
    const cb = () => setEpoch(epochCounter)
    epochSubs.add(cb)
    cb()
    return () => { epochSubs.delete(cb) }
  }, [])

  return epoch
}

/**
 * 订阅所有 surface 的完整数据（含 kind/data/intent）。用于 SceneShell 动画计算。
 */
export function useSceneSurfaces(): { surfaces: any[]; rev: number } {
  const [surfaces, setSurfaces] = useState<any[]>([])
  const [rev, setRev] = useState(0)

  useEffect(() => {
    const cb = () => {
      const list: any[] = []
      for (const [id, entry] of surfaceCache.entries()) {
        if (entry.surface) {
          list.push({ id, ...entry.surface })
        }
      }
      setSurfaces(list)
      setRev(manifestRev)
    }
    manifestSubs.add(cb)
    cb()
    return () => { manifestSubs.delete(cb) }
  }, [])

  return { surfaces, rev }
}

/** 导出协议状态供 UI 调试 */
export function getSceneClientState() {
  return {
    protocolMode,
    clientRev,
    surfaceCount: surfaceCache.size,
    wsConnected: connectedWs?.readyState === WebSocket.OPEN,
  }
}
