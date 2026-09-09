/**
 * agui-chat-normalize — /chat 流内 AG-UI 大写帧 → 前端 legacy 事件形状
 *
 * 2026-08-25 修复（交互"输入无反应"实锤）：后端 agui-adapter 在 /chat 流内
 * 双发 AG-UI 标准帧（RUN_STARTED / TEXT_MESSAGE_CHUNK / TOOL_CALL_* …），但
 * useChatStream 的 switch 只处理小写 legacy 名——大写帧全部落入
 * "unhandled event" → LLM 回答已到达而界面永不更新。
 * 本模块为纯函数：AG-UI 帧 → legacy 形状（字段搬移 + thinking 增量标记 +
 * interrupted 中断映射 + CUSTOM 解包），未知/非 AG-UI 帧透传（兼容旧双发流）。
 */
import { AGUI_EVENT } from './agui-events'

export type NormalizeResult =
  | { kind: 'handled'; evt: Record<string, unknown>; source: string }
  | { kind: 'ignore'; source: string }
  | { kind: 'passthrough'; evt: Record<string, unknown>; source: string }

function idOf(evt: any): Record<string, unknown> {
  return { runId: evt?.runId, threadId: evt?.threadId }
}

function handled(type: string, fields: Record<string, unknown>, source: string): NormalizeResult {
  return { kind: 'handled', evt: { type, ...fields }, source }
}

export function normalizeAguiChatEvent(evt: any): NormalizeResult {
  const t = evt && evt.type
  if (typeof t !== 'string' || !(t in AGUI_EVENT)) {
    // 非 AG-UI（或 legacy 帧）：走既有 switch 原样处理（双发兼容）
    return { kind: 'passthrough', evt, source: t || '' }
  }

  switch (t as string) {
    case AGUI_EVENT.RUN_STARTED:
      return handled('start', { speak: undefined, mode: 'chat', plainReply: evt.input ? String(evt.input) : undefined, ...idOf(evt) }, t)
    case AGUI_EVENT.TEXT_MESSAGE_CHUNK: {
      // AG-UI 侧 thinking 帧 messageId 以 '-think' 结尾且为增量 delta（客户端 append）；
      // legacy 'thinking' 语义为全量替换——用 _delta 标记让消费方合并。
      const isThinking = String(evt?.messageId || '').endsWith('-think')
      return handled(isThinking ? 'thinking' : 'chunk', { content: evt?.delta ?? evt?.content ?? '', _delta: true, ...idOf(evt) }, t)
    }
    case AGUI_EVENT.TOOL_CALL_START:
      return handled('tool_call', { toolId: evt.toolCallId, toolName: evt.toolCallName || '工具调用', toolArgs: '', ...idOf(evt) }, t)
    case AGUI_EVENT.TOOL_CALL_ARGS:
      return handled('tool_call', { toolId: evt.toolCallId, toolName: '工具调用', toolArgs: evt?.delta ?? '', _appendArgs: true, ...idOf(evt) }, t)
    case AGUI_EVENT.TOOL_CALL_RESULT:
      return handled('tool_result', { toolId: evt.toolCallId, success: true, result: evt?.content ?? '', ...idOf(evt) }, t)
    case AGUI_EVENT.RUN_FINISHED:
      if (evt?.outcome && evt.outcome.type === 'interrupt') {
        return handled('interrupted', { roundId: evt.runId, ...idOf(evt) }, t)
      }
      return handled('done', { content: evt?.delta ?? evt?.content ?? '', ...idOf(evt) }, t)
    case AGUI_EVENT.RUN_ERROR:
      return handled('error', { error: evt?.message || 'run error', ...idOf(evt) }, t)
    case AGUI_EVENT.CUSTOM:
      // CUSTOM 包裹原 legacy 类型（name 即原类型）——解包透传
      return { kind: 'passthrough', evt: { ...evt, type: evt.name }, source: evt?.name || 'custom' }
    default:
      // STEP_STARTED/STEP_FINISHED/ACTIVITY_DELTA/TOOL_CALL_END：无 legacy 对应，安静忽略
      return { kind: 'ignore', source: t }
  }
}
