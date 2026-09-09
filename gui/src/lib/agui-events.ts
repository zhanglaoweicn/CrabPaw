/**
 * agui-events — AG-UI 标准事件类型化订阅层(2026-08-18 协议化轮)
 *
 * 后端 agui-adapter.js 已把旧事件双名广播为 AG-UI 标准帧(event: <TYPE>),
 * 本模块把这些帧以类型安全的方式暴露给 React 层:
 *   - AGUI_EVENT 枚举与后端 AGUI 常量一一对应
 *   - subscribeAgui(type, cb) 惰性挂接 sse-hub(首个订阅者触发, 12 个标准名一次挂全)
 *   - 帧自动补 type 字段, seq 透传(供去重/审计)
 * 未知事件不订阅即忽略(对应 dsh"客户端对未知事件文档化默认忽略"纪律)。
 */
import { subscribeSse } from './sse-hub'

export const AGUI_EVENT = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  TEXT_MESSAGE_CHUNK: 'TEXT_MESSAGE_CHUNK',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  ACTIVITY_DELTA: 'ACTIVITY_DELTA',
  CUSTOM: 'CUSTOM',
} as const
export type AguiEventName = (typeof AGUI_EVENT)[keyof typeof AGUI_EVENT]

export interface AguiFrame {
  type: string
  runId?: string
  threadId?: string
  [key: string]: unknown
}

type AguiListener = (frame: AguiFrame, seq?: number) => void

const listeners = new Map<string, Set<AguiListener>>()
let unsubs: Array<() => void> = []

function ensureSubscribed() {
  if (unsubs.length > 0) return
  unsubs = Object.values(AGUI_EVENT).map((name) =>
    subscribeSse('/events', name, (data, seq) => {
      const frame = { ...(data ?? {}), type: name } as AguiFrame
      const set = listeners.get(name)
      if (!set) return
      for (const fn of Array.from(set)) {
        try { fn(frame, seq) } catch (e) { console.error(`[agui-events] ${name} 监听器异常:`, e) }
      }
    }),
  )
}

export function subscribeAgui(type: AguiEventName, cb: AguiListener): () => void {
  ensureSubscribed()
  let set = listeners.get(type)
  if (!set) { set = new Set(); listeners.set(type, set) }
  set.add(cb)
  return () => { set?.delete(cb) }
}
