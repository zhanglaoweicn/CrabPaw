import { useCallback, useRef } from 'react'
import { getApiBaseUrl, getApiHeaders, clearCredentialsCache, getCredentials } from '../lib/api'
import { normalizeAguiChatEvent } from '../lib/agui-chat-normalize'

/** 工具调用状态条目（与 Dashboard 已有结构对齐） */
export interface ToolCallItem {
  status: 'running' | 'done' | 'error'
  toolName: string
  toolArgs?: string
  toolId: string
  toolResult?: string
}

/** 生成的媒体文件 */
export interface GeneratedFile {
  type: string
  path: string
  name?: string
  size?: number
  mdSourcePath?: string
}

export interface ChatStreamRequest {
  message: string
  files?: Array<{ path: string; name: string; type?: string; size?: number }>
  userId: string
  conversationId: string | null | undefined
  projectId?: string | null | undefined
}

export interface SubagentEvent {
  status: 'start' | 'end'
  agentId: string
  archetype: string
  tier?: string
  task?: string
  outputPreview?: string
}

export interface ChatStreamCallbacks {
  /** 文本流式增量（reply） */
  onChunk?: (content: string, accumulated: string) => void
  /**
   * 思考状态消息(2026-08-14 审计 M1 核实后端语义):后端 /chat SSE 的 thinking 事件
   * 是完整离散状态消息(如"正在理解您的问题..."/阶段标签),非增量 delta。
   * content=本条消息,accumulated=当前最新状态消息(全量替换语义)。
   */
  onThinking?: (content: string, accumulated: string) => void
  /** 工具调用开始 */
  onToolCall?: (item: ToolCallItem) => void
  /** 工具调用结果 */
  onToolResult?: (item: { toolId: string; success: boolean; result?: string; cardState?: string; resultPayload?: { success: boolean; error: string | null; content: string } | null; toolName?: string }) => void
  /** 子智能体生命周期事件 */
  onSubagent?: (event: SubagentEvent) => void
  /** 生成的文件 */
  onFileGenerated?: (file: GeneratedFile) => void
  /** 服务端主动错误 */
  onError?: (content: string) => void
  /** 2026-08-15 D8: 服务端中止标记(用户停止/断连/空闲超时 abort 路径统一发) */
  onInterrupted?: (roundId: string | null) => void
  /** 路由决策事件 — 任务分流信息 */
  onRoute?: (info: { isMultiAgent: boolean; complexity?: string; archetype?: string; reason?: string }) => void
  /** 评估阶段开始/结束 — LLM 正在反思工具结果以决定下一步 */
  onReflecting?: (event: { type: 'start' | 'end'; cycle: number; mode?: string }) => void
  /** 流式开始 — 后端返回 start 事件时触发，携带 speak 等附加信息 */
  onStreamStart?: (info: { speak?: boolean; mode?: string; plainReply?: boolean }) => void
  /** 流式结束 — 后端返回 done 事件时触发 */
  onStreamEnd?: (info: { content: string; speak?: boolean }) => void
  /** 循环检测警告 — 后端 loop_warning 事件 */
  onLoopWarning?: (event: { level: string; tool?: string; count?: number; message?: string }) => void
  /** 阶段切换 — 后端 phase 事件 (plan/research/code/review/reflect) */
  onPhase?: (event: { phase: string; summary?: string; detail?: string; progress?: number }) => void
}

export interface ChatStreamResult {
  reply: string
  thinking: string
  requestId: string
}

/** 内部事件协议：与后端 /chat SSE 协议保持一致 */
type ServerEvent =
  | { type: 'chunk'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'start'; content: string; speak?: boolean; mode?: string; plainReply?: boolean }
  | { type: 'done'; content: string; speak?: boolean }
  // 2026-08-15 D8: interrupted 事件入类型——后端 abort 路径统一发(此前落 default
  // 静默丢弃, 前端"知道停了"全凭自己 abort + stopGenerating 手动固化状态)
  | { type: 'interrupted'; roundId?: string }
  | { type: 'tool_call'; toolName?: string; toolArgs?: string; toolId?: string; cardState?: string }
  | { type: 'tool_result'; toolId: string; success: boolean; result?: string; cardState?: string; resultPayload?: { success: boolean; error: string | null; content: string } | null; toolName?: string }
  | { type: 'subagent'; status: 'start' | 'end'; agentId: string; archetype: string; tier?: string; task?: string; outputPreview?: string }
  | { type: 'file_generated'; file: GeneratedFile }
  | { type: 'error'; content?: string }
  | { type: 'route'; isMultiAgent: boolean; complexity?: string; archetype?: string; reason?: string }
  | { type: 'eval_start'; cycle?: number; mode?: string }
  | { type: 'eval_done'; cycle?: number; mode?: string }
  | { type: 'loop_warning'; level: 'hint' | 'hard' | 'blocked'; tool?: string; count?: number; message?: string }
  | { type: 'phase'; phase: string; summary?: string; detail?: string; progress?: number }

/**
 * 统一 chat 流式 hook
 * - 通过 fetch + ReadableStream 解析 SSE（与 /events 不同，这里是 POST）
 * - 自动处理 Electron 凭据注入、401 凭据清理、错误信息还原
 * - 使用 RAF 节流合并多个 chunk，避免每 token 一次 setState
 */
export function useChatStream() {
  /** RAF 节流合并器：用于把高频 token 合并到下一帧渲染 */
  const pendingFlushRef = useRef<number | null>(null)
  /** 中断控制器：新消息到达时中止当前流 */
  const abortRef = useRef<AbortController | null>(null)
  /** 最近一次 send 的 userId——显式取消 API 需要(B3) */
  const lastUserIdRef = useRef<string>('gui_user')

  /** 2026-08-01: 用户主动停止当前流式回复（停止生成按钮） */
  const abort = useCallback(() => {
    const controller = abortRef.current
    abortRef.current = null
    // B3(Runtime差距分析): 停止 = 显式取消。先 POST /api/request/cancel 置位服务端
    // cancelRequested(后台 run 终态记 cancelled),再本地断流。若只断本地流,服务端
    // 按 B4 continue 策略会把断连当刷新,run 继续执行——停止按钮将失效。
    const finish = () => { try { controller?.abort('user-stop') } catch { /* already aborted */ } }
    ;(async () => {
      try {
        let base = ''
        let headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) {
          const info = await window.electronAPI.api.streamUrl('/api/request/cancel')
          const origin = window.location.origin
          if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
            const u = new URL(info.url)
            base = `${origin}${u.pathname}`
          } else {
            base = info.url
            headers['X-Electron'] = 'true'
          }
        } else {
          base = `${await getApiBaseUrl()}/api/request/cancel`
          headers = { ...headers, ...(await getApiHeaders()) }
        }
        // 1.5s 兜底: 取消 API 不可达时仍执行本地断流(服务端 run 由空闲超时兜底)
        await Promise.race([
          fetch(base, { method: 'POST', headers, body: JSON.stringify({ userId: lastUserIdRef.current }) }),
          new Promise((r) => setTimeout(r, 1500)),
        ])
      } catch (e) {
        console.warn('[ChatStream] 显式取消请求失败(仍执行本地断流):', e)
      } finally {
        finish()
      }
    })()
  }, [])

  const send = useCallback(async (req: ChatStreamRequest, cb: ChatStreamCallbacks = {}): Promise<ChatStreamResult> => {
    // 新消息到达 → 中断当前正在进行的流式请求
    if (abortRef.current) { abortRef.current.abort('new-message'); abortRef.current = null }
    lastUserIdRef.current = req.userId || 'gui_user'
    const controller = new AbortController()
    abortRef.current = controller
    
    let streamUrl: string
    let streamHeaders: Record<string, string>
    if (typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) {
      const streamInfo = await window.electronAPI.api.streamUrl('/chat')
      // Use Vite proxy (same origin) in dev to avoid CORS preflight failure
      const origin = window.location.origin
      if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        const u = new URL(streamInfo.url)
        streamUrl = `${origin}${u.pathname}${u.search}`
        streamHeaders = { 'Content-Type': 'application/json' }
      } else {
        streamUrl = streamInfo.url
        streamHeaders = {
          'Content-Type': 'application/json',
          'X-Electron': 'true',
        }
      }
    } else {
      const baseUrl = await getApiBaseUrl()
      const headers = await getApiHeaders()
      streamUrl = `${baseUrl}/chat`
      streamHeaders = headers
    }

    console.log(`[Chat] Request: ${streamUrl.replace(/[?&]token=[^&]*/gi, '$1token=***')}`, { isElectron: !!(typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) })

    // SSE 强化：传入 X-Request-Id 便于排查
    const requestId = `gui-${Date.now()}-${crypto.randomUUID().slice(2, 8)}`

    // 多重尝试连接
    let res: Response
    try {
      res = await fetch(streamUrl, {
        method: 'POST',
        headers: { ...streamHeaders, 'X-Request-Id': requestId },
        signal: controller.signal,
        body: JSON.stringify({
          message: req.message,
          stream: true,
          files: req.files && req.files.length > 0 ? req.files : undefined,
          userId: req.userId,
          conversationId: req.conversationId,
          projectId: req.projectId ?? undefined,
        }),
      })
    } catch (firstError: any) {
      if (firstError.name === 'AbortError' || controller.signal.aborted) {
        return { reply: '', thinking: '', requestId }
      }
      // 第一次尝试失败，尝试直连后端；保留原请求的路径与认证信息，避免降级成无鉴权请求
      console.warn(`[Chat] First connection attempt failed (${streamUrl}):`, firstError.message)
      // 2026-08-07: fallback 目标从 getCredentials().baseUrl 推导(不再硬编码 localhost:38767)
      let fallbackUrl = ''
      try {
        const creds = await getCredentials()
        if (creds?.baseUrl) {
          fallbackUrl = streamUrl.replace(/^https?:\/\/[^/]+/, creds.baseUrl.replace(/\/+$/, ''))
        }
      } catch (credsErr: any) {
        console.warn('[Chat] 获取 fallback 凭据失败，跳过直连重试:', credsErr?.message || credsErr)
      }
      if (fallbackUrl && fallbackUrl !== streamUrl) {
        console.log(`[Chat] Retrying direct: ${fallbackUrl}`)
        try {
          res = await fetch(fallbackUrl, {
            method: 'POST',
            headers: { ...streamHeaders, 'X-Request-Id': requestId + '-fb' },
            body: JSON.stringify({
              message: req.message,
              stream: true,
              files: req.files && req.files.length > 0 ? req.files : undefined,
              userId: req.userId,
              conversationId: req.conversationId,
              projectId: req.projectId ?? undefined,
            }),
          })
          console.log(`[Chat] Direct fallback succeeded`)
        } catch (fallbackError: any) {
          if (fallbackError.name === 'AbortError') return { reply: '', thinking: '', requestId }
          throw new Error(`Service connection failed (tried ${streamUrl} and ${fallbackUrl}): ${fallbackError.message}`)
        }
      } else {
        throw new Error(`Service connection failed (${streamUrl}): please verify the server is running`)
      }
    }

    if (res.status === 401) {
      clearCredentialsCache()
      throw new Error('认证失败，请重新启动服务')
    }
    if (!res.ok) {
      let errorDetail = `HTTP ${res.status}`
      try {
        const errData = await res.json()
        errorDetail = errData.message || errData.error || errorDetail
      } catch {
        try {
        errorDetail = await res.text()
        } catch {
        // 2026-08-14 审计: 空 catch 补日志
        console.warn('[ChatStream] 读取错误响应体失败,保留 HTTP 状态码:', res.status)
        }
      }
      throw new Error(errorDetail)
    }

    const reader = res.body?.getReader()
    if (!reader) {
      throw new Error('浏览器不支持流式响应')
    }

    const decoder = new TextDecoder()
    let fullReply = ''
    let fullThinking = ''
    let buffer = ''
    // HC1: multi-line SSE data buffer — accumulate data: lines that don't parse as JSON yet
    let dataBuffer = ''

    // RAF 节流刷新：合并连续 chunk 到下一帧
    const scheduleFlush = () => {
      if (pendingFlushRef.current == null && cb.onChunk) {
        pendingFlushRef.current = requestAnimationFrame(() => {
          pendingFlushRef.current = null
          cb.onChunk?.('', fullReply)
        })
      }
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      // 2026-08-15 D11(审计 P2): 空闲超时与后端对齐 45s→120s——工具长静默期
      // (大文件写入/长搜索)前端不再抢先断流(服务端注释明说 45s 原值因此被抬到
      // 120s, 前端未同步); 配合 D1 停止按钮已能真正终止服务端流
      idleTimer = setTimeout(() => { controller.abort('stream-idle') }, 120000)
      idleTimer.unref?.()
    }
    resetIdle()

    try {
      while (true) {
        const { done, value } = await reader.read()
        resetIdle()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) {
            // HC1: non-data line resets the multi-line data buffer
            dataBuffer = ''
            continue
          }
          const payload = line.slice(6)
          // HC1: buffer multi-line data — try parsing accumulated payload first
          const candidate = dataBuffer ? dataBuffer + payload : payload
          let evt: ServerEvent
          try {
            evt = JSON.parse(candidate)
            dataBuffer = '' // successfully parsed, reset buffer
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e
            // HC1: incomplete JSON — buffer and try on next data line
            dataBuffer = candidate
            continue
          }

          // 2026-08-25: AG-UI 大写帧(RUN_STARTED/TEXT_MESSAGE_CHUNK…)→ legacy 形状,
          // 此前仅小写 switch 处理,大写帧全落 unhandled(回答已到但界面不更新)。
          const _agui = normalizeAguiChatEvent(evt)
          if (_agui.kind === 'ignore') { console.debug('[ChatStream] AG-UI 帧忽略:', _agui.source); continue }
          evt = _agui.evt as ServerEvent
          switch (evt.type) {
            case 'start':
              cb.onStreamStart?.({
                speak: evt.speak,
                mode: evt.mode,
                plainReply: evt.plainReply,
              })
              break
            case 'done':
              if (evt.content) fullReply = evt.content
              cb.onStreamEnd?.({ content: evt.content, speak: evt.speak })
              break
            case 'interrupted':
              // 2026-08-15 D8: 后端中止标记(用户停止/服务端 abort)——abort 后
              // onStreamEnd 不触发, 由消费方(stopGenerating)固化终态; 此处
              // 仅透传事件给订阅者(可做"已停止"UI 反馈), 不重复终结状态
              cb.onInterrupted?.(evt.roundId || null)
              break
            case 'chunk':
              if (evt.content) {
                fullReply += evt.content
                scheduleFlush()
              }
              break
            case 'thinking':
              if (evt.content) {
                // 2026-08-14 审计 M1: 后端 thinking 事件为完整离散状态消息(非增量 delta,
                // 见 src/core/ai.js onChunk({type:'thinking'}) 一次性发送 + chat-handler 直传),
                // 故此处为"全量替换"语义——fullThinking 恒为最新一条状态消息。
                fullThinking = evt.content
                cb.onThinking?.(evt.content, fullThinking)
              }
              break
            case 'tool_call':
              cb.onToolCall?.({
                status: 'running',
                toolName: evt.toolName || '工具调用',
                toolArgs: evt.toolArgs || '',
                toolId: evt.toolId || '',
              })
              break
            case 'tool_result':
              cb.onToolResult?.({
                toolId: evt.toolId,
                success: evt.success,
                result: evt.result,
                cardState: evt.cardState,
                resultPayload: evt.resultPayload,
                // 2026-08-13 P2-1: 补 toolName——此前丢弃,前端工具消息回填兜底需要
                toolName: evt.toolName || '',
              })
              break
            case 'file_generated':
              if (evt.file) cb.onFileGenerated?.(evt.file)
              break
            case 'subagent':
              cb.onSubagent?.({
                status: evt.status,
                agentId: evt.agentId,
                archetype: evt.archetype,
                tier: evt.tier,
                task: evt.task,
                outputPreview: evt.outputPreview,
              })
              break
            case 'route':
              cb.onRoute?.({ isMultiAgent: (evt as any).useMultiAgent ?? (evt as any).isMultiAgent, complexity: evt.complexity, archetype: evt.archetype, reason: evt.reason })
              break
            case 'eval_start':
              cb.onReflecting?.({ type: 'start', cycle: evt.cycle || 0, mode: evt.mode })
              break
            case 'eval_done':
              cb.onReflecting?.({ type: 'end', cycle: evt.cycle || 0, mode: evt.mode })
              break
            case 'error':
              cb.onError?.(evt.content || '流式响应错误')
              return { reply: fullReply, thinking: fullThinking, requestId }
            case 'loop_warning':
              cb.onLoopWarning?.({ level: evt.level, tool: evt.tool, count: evt.count, message: evt.message })
              break
            case 'phase':
              cb.onPhase?.({ phase: evt.phase, summary: evt.summary, detail: evt.detail, progress: evt.progress })
              break
            default:
              console.debug('[ChatStream] unhandled event:', (evt as any).type)
          }
        }
      }
    } catch (readError: any) {
      if (readError.name === 'AbortError' || controller.signal.aborted) {
        // 用户主动停止或超时中止——静默，保留已接收内容
        return { reply: fullReply, thinking: fullThinking, requestId }
      }
      throw readError
    } finally {
      // 确保 abort 后 RAF/定时器总是被清理，防止残留写旧流
      if (idleTimer) clearTimeout(idleTimer)

      // 流结束后最终刷新
      if (pendingFlushRef.current != null) {
        cancelAnimationFrame(pendingFlushRef.current)
        pendingFlushRef.current = null
        cb.onChunk?.('', fullReply)
      }
    }

    return { reply: fullReply, thinking: fullThinking, requestId }
  }, [])

  return { send, abort }
}
