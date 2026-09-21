/**
 * types — VoiceShell 对话流共享类型（2026-09-21 从 index.tsx 组件内提升，纯搬运）
 *
 * 此前 ChatMsg 族定义在 VoiceShell 函数体内，导致拆分消息渲染组件时类型
 * 无法跨文件共享。FlowToolEvent 原为 `(typeof flow.toolEvents)[number]`，
 * 提升后改用 hook 返回类型推导——两者类型等价（flow 即 useVoiceChatFlow 返回值）。
 */
import type { useVoiceChatFlow } from '../../hooks/useVoiceChatFlow'

export interface ChatMsgFile { path: string; name: string; size?: number; type?: string }
// 2026-09-07: channel——消息来源通道标记（'wecom'=企业微信同步镜像），气泡带通道徽标
// 2026-09-20: speaker——圆桌会专家署名（对话流内直接以专家身份出气泡，不建独立卡）
export interface RtSpeaker { name: string; dept?: string; round?: number }
// 2026-09-21 创新-B: 结构化决策卡——例会/圆桌会收口进对话流不再是纯文本,
// 结论正文+任务清单+行动按钮分栏渲染(过程态气泡流/结论态决策卡/产物态文件卡三态分离)
export interface RtDecisionCard { text: string; tasks: Array<{ owner: string; task: string }> }
export interface ChatMsg { role: 'user' | 'ai' | 'tool'; text: string; ts: number; toolId?: string; round?: number; files?: ChatMsgFile[]; channel?: 'wecom' | 'lark'; speaker?: RtSpeaker; decision?: RtDecisionCard }

/** 单条工具事件（flow.toolEvents 元素）——工具链回看面板数据源 */
export type FlowToolEvent = ReturnType<typeof useVoiceChatFlow>['toolEvents'][number]

/** useVoiceChatFlow 返回实例——对话消息域 hook 的注入参数 */
export type VoiceChatFlow = ReturnType<typeof useVoiceChatFlow>

/** pushChat 签名单源——index.tsx 的 useCallback 与 useRoundtableChat hook 共用 */
export type PushChatFn = (
  role: 'user' | 'ai' | 'tool',
  text: string,
  toolId?: string,
  round?: number,
  files?: ChatMsgFile[],
  channel?: 'wecom' | 'lark',
  speaker?: RtSpeaker,
  decision?: RtDecisionCard,
) => void
