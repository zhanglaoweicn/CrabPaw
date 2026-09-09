import { useEffect, useRef } from 'react'
import { subscribeSse, subscribeSseStatus } from '../lib/sse-hub'

/**
 * SSE 事件处理器映射。key 为服务端推送的事件名，value 接收已 JSON.parse 的 data。
 * 2026-08-19 三栏联动轮: 第二参数 seq 透传(时间线回放定位)——旧 handler 忽略即可, 向后兼容。
 */
export type SseEventHandlers = Record<string, (data: any, seq?: number) => void>

interface UseSseOptions {
  /** 事件路径，如 '/events'。默认 '/events' */
  path?: string
  /** 事件名 → 处理函数 */
  handlers: SseEventHandlers
  /** 最大重试次数，默认 10 */
  maxRetry?: number
  /** 基础重试延迟（ms），默认 2000（指数退避，上限 60s） */
  baseDelayMs?: number
  /** 连接建立/断开/重试的日志回调 */
  onStatus?: (status: 'open' | 'error' | 'giveup', info?: { url?: string; retry?: number; delay?: number; error?: unknown }) => void
}

interface ResolvedApi {
  baseUrl: string
  headers: Record<string, string>
}

/**
 * 统一 SSE 连接 hook —— 薄壳(P4 GUI 全量修复, G7 遗留项)
 *
 * 连接逻辑已下沉到 lib/sse-hub 模块级单例: 9 个订阅者共享同一条 /events 连接
 * (Electron 一条 IPC 流/浏览器一个 EventSource), 引用计数管理生命周期。
 * 本 hook 只负责: 挂载时把 handlers 注册进 hub, 卸载时注销; onStatus 转发。
 *
 * 语义保持(旧实现契约不变):
 * - handlers 变化不重建连接——事件到来时读 handlersRef 最新闭包
 * - onStatus: open/error/giveup 三态; 新订阅者立即收到当前状态(补发)
 * - maxRetry/baseDelayMs: 首个订阅者参数生效(hub 组级)
 */
export function useSse({
  path = '/events',
  handlers,
  maxRetry = 10,
  baseDelayMs = 2000,
  onStatus,
}: UseSseOptions) {
  // 始终引用最新的 handlers/onStatus，避免订阅包装闭包陈旧
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  useEffect(() => {
    const unsubs: (() => void)[] = []
    // 包装器读 ref 最新值——hub 侧存的 fn 保持稳定, 组件 re-render 不重订阅
    for (const event of Object.keys(handlersRef.current)) {
      unsubs.push(subscribeSse(path, event, (data, seq) => {
        const fn = handlersRef.current[event]
        if (fn) fn(data, seq)
      }, { maxRetry, baseDelayMs }))
    }
    unsubs.push(subscribeSseStatus(path, (status, info) => {
      onStatusRef.current?.(status, info)
    }))
    return () => {
      for (const unsub of unsubs) {
        try { unsub() } catch (err) { console.warn('[useSSE] 注销失败:', err) }
      }
    }
    // path/maxRetry/baseDelayMs 变化才重订阅(handlers 变化走 ref, 与旧实现一致)
  }, [path, maxRetry, baseDelayMs])
}

/** 兼容导出（保持与原 Dashboard 内联实现的视觉一致） */
export type { ResolvedApi }
