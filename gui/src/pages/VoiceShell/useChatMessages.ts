/**
 * useChatMessages — 对话消息状态域（2026-09-21 P2-1 第四批从 index.tsx 搬出）
 *
 * 状态搬家：conversation 域（消息列表/pushChat/轮次 refs/反馈 map）+ 企微对话
 * 镜像订阅 + 回复落卡 effect（lastAiPushedRef 定稿去重）+ 工具批历史（对话流
 * 工具链回看数据源）+ 三栏联动轮（linkedRound 定位/中栏滚动）+ 流式文本增量
 * （streamingAiText）+ 消息反馈上报。
 *
 * flow 以参数注入（本域多处依赖 flow.aiText/toolEvents/getConversationId，
 * 而 handleUserInput 留在宿主组件并依赖本 hook 返回的 pushChat——注入打断循环）。
 * 接口约定与原实现逐字一致：state 初始值、effect 依赖数组、console 文案均不变。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiPost } from '../../lib/api'
import { subscribeSse } from '../../lib/sse-hub'
import type { ChatMsg, ChatMsgFile, RtSpeaker, RtDecisionCard, FlowToolEvent, VoiceChatFlow } from './types'

// 2026-08-13: ts 定位键单例——pushChat/handleHistoryResume/holoHistory 共用。
// 此前 pushChat 仅检查与前一条 ts 碰撞,3 条以上同毫秒连发仍产生重复 key。
// 序号保证同毫秒内递增唯一 + 单调不回拨。
let chatTsLast = 0
let chatTsSeq = 0
export function nextChatTs(): number {
  const now = Date.now()
  chatTsLast = Math.max(now, chatTsLast)
  return chatTsLast + chatTsSeq++
}

export function useChatMessages(flow: VoiceChatFlow) {
  const [conversation, setConversation] = useState<ChatMsg[]>([])
  const conversationRef = useRef<ChatMsg[]>([])
  // 2026-08-19 三栏联动轮: 轮次序号 + 最近一轮(用户消息落轮次, AI 落卡沿用)
  const roundSeqRef = useRef(0)
  const lastUserRoundRef = useRef<number | null>(null)
  // 2026-08-13: 消息反馈(P0-3)——按 ts 记录已反馈状态,失败回滚保持可点
  const [feedbackMap, setFeedbackMap] = useState<Map<number, 'up' | 'down'>>(new Map())
  const pushChat = useCallback((role: 'user' | 'ai' | 'tool', text: string, toolId?: string, round?: number, files?: ChatMsgFile[], channel?: 'wecom' | 'lark', speaker?: RtSpeaker, decision?: RtDecisionCard) => {
    const clean = text?.trim() || ''
    if (!clean && (!files || files.length === 0)) return
    // 2026-08-13: ts 定位键——nextChatTs 单调唯一(点赞/点踩按 ts 定位,
    // 同 ms 任意数量连发不碰撞;此前仅查前一条,3 条以上同 ms 仍重复)
    const ts = nextChatTs()
    const next = [...conversationRef.current, { role, text: clean, ts, toolId, round, files: files && files.length > 0 ? files : undefined, channel, speaker, decision }]
    conversationRef.current = next
    setConversation(next)
  }, [])

  // ── 2026-09-07: 企微对话同步进对话窗口 ──
  // wecom_sync 模式下后端广播 wecom_message / wecom_reply（chat-handler 步骤 9.5/15）。
  // 此前 GUI 无消费方：TaskPanelHost 只显示带附件的"收到企微文档"卡，纯文本对话在
  // 桌面端无处可见（用户实测"没看到桌面端与企微同步对话内容"）。此处把企微用户消息
  // 与 AI 回复镜像为带"企微"通道徽标的对话气泡（仅独立模式不广播，故无重复风险）。
  useEffect(() => {
    const unsubMsg = subscribeSse('/events', 'wecom_message', (data: any) => {
      if (!data?.content) return
      const fileTag = data.file?.name
        ? `（附件：${data.fileCount && data.fileCount > 1 ? `${data.file.name} 等 ${data.fileCount} 个` : data.file.name}）`
        : ''
      pushChat('user', `${data.content}${fileTag}`, undefined, undefined, undefined, 'wecom')
    })
    const unsubReply = subscribeSse('/events', 'wecom_reply', (data: any) => {
      if (!data?.content) return
      pushChat('ai', data.content, undefined, undefined, undefined, 'wecom')
    })
    return () => { unsubMsg(); unsubReply() }
  }, [pushChat])

  // 2026-08-07: 新增 replyCompleted 条件——此前仅靠"TTS 播放间隙"判断,
  // PTT 打断 TTS 时半截 aiText 被 push,回复完整后再 push → 卡片内容重复分段
  // （用户反馈"一个回答分了几次回答,每次一段逐步增多"根因）。
  const lastAiPushedRef = useRef('')
  useEffect(() => {
    const aiTextNow = flow.aiText || ''
    // 回复流未结束或 TTS 播放中或仍在 pending → 等完成
    if (!flow.replyCompleted || flow.ttsPlaying || flow.isSpeaking || flow.pending) return
    // 2026-08-14(用户反馈): 工具调用记录不再进对话卡——工具逻辑已由侧栏承载
    // (右栏"工具执行"状态卡 flow.toolEvents)。对话窗口保持纯消息线程(AG-UI 语义:
    // message thread 与 tool events 分离)。无 AI 文本的纯工具任务不落对话卡。
    if (!aiTextNow.trim()) return
    // 避免重复 push（同一条 aiText 只 push 一次）
    if (lastAiPushedRef.current === aiTextNow) return
    lastAiPushedRef.current = aiTextNow
    // 2026-08-19 三栏联动轮: AI 落卡带轮次(最近一轮的 round, 与时间线/工具批对齐)
    pushChat('ai', aiTextNow, undefined, lastUserRoundRef.current ?? undefined)
    // 新对话开始时 reset（aiText 清空时）
    if (!aiTextNow) lastAiPushedRef.current = ''
  }, [flow.aiText, flow.replyCompleted, flow.ttsPlaying, flow.isSpeaking, flow.pending, flow.toolEvents, pushChat])

  // ── 2026-08-19 三栏联动轮: 工具批历史(对话流工具链回看数据源) ──
  // flow.toolEvents 每轮清空重填(sendText 清空)——清空即旧批收官, 归档到轮次。
  // 归档轮次: 清空发生在下一轮 sendText 后(round 已递增), 旧批属上一轮。
  // 上限 20 批(环形裁剪, 防长会话无界增长)。
  const toolBatchesRef = useRef<Array<{ round: number; events: FlowToolEvent[] }>>([])
  const activeBatchRef = useRef<FlowToolEvent[] | null>(null)
  useEffect(() => {
    const cur = flow.toolEvents
    if (cur.length === 0) {
      if (activeBatchRef.current && activeBatchRef.current.length > 0) {
        const batchRound = Math.max(1, (lastUserRoundRef.current ?? 1) - 1)
        toolBatchesRef.current = [...toolBatchesRef.current, { round: batchRound, events: activeBatchRef.current }].slice(-20)
      }
      activeBatchRef.current = null
    } else {
      activeBatchRef.current = cur
    }
  }, [flow.toolEvents])
  /** 按轮取工具批(当前轮优先, 历史次之)——工具链回看按钮数据源 */
  const getToolBatch = useCallback((round: number) => {
    if (round === lastUserRoundRef.current && activeBatchRef.current) return activeBatchRef.current
    return toolBatchesRef.current.find(b => b.round === round)?.events ?? null
  }, [])

  // ── 2026-08-19 三栏联动轮: 工具链展开(Set<消息 ts>——AI 消息旁 ⛓ 按钮) ──
  const [toolchainOpenTs, setToolchainOpenTs] = useState<Set<number>>(new Set())
  const toggleToolchain = useCallback((ts: number) => {
    setToolchainOpenTs(prev => {
      const next = new Set(prev)
      if (next.has(ts)) next.delete(ts)
      else next.add(ts)
      return next
    })
  }, [])

  // ── 2026-08-19 三栏联动轮: 联动轮次(时间线/对话流/右栏三向高亮+定位) ──
  const [linkedRound, setLinkedRound] = useState<number | null>(null)
  /** 联动定位: 高亮三栏对应轮 + 中栏滚动到该轮 user 消息(主动定位打破回底) */
  const linkRound = useCallback((round: number) => {
    setLinkedRound(round)
    const el = chatMessagesRef.current
    if (!el) return
    const roundEl = el.querySelector<HTMLElement>(`[data-round="${round}"]`)
    if (!roundEl) return
    roundEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
    chatAtBottomRef.current = false
    setChatAtBottom(false)
  }, [])

  // ── 2026-08-14 C-1 修复: 流式回复文本增量可见 ──
  // flow.aiText 在流式过程（onChunk → setAiText(accumulated)）中持续累积,
  // 此前只在"回复完成 + TTS 播完"后由上方 effect 落卡——静音模式整段流期间
  // 中栏零可见文本(10-30s 静默)。现在流式中直接渲染为带 ▌ 光标的流式气泡;
  // 定稿条件满足后上方 effect 落卡(lastAiPushedRef 更新)→ 依赖 conversation
  // 重算, 气泡随定稿消失, 不闪烁不重复。TTS 播报中文本保持可见(气泡存在)。
  const streamingAiText = useMemo(() => {
    const t = flow.aiText || ''
    if (!t) return ''
    if (lastAiPushedRef.current === t) return '' // 已定稿落卡
    return t
  }, [flow.aiText, flow.replyCompleted, flow.ttsPlaying, flow.isSpeaking, flow.pending, conversation])

  // 流式气泡随 chunk 增量更新 → 自动滚到底部保持最新文本可见
  // 2026-08-14 ag-ui 二次分析: 自动滚动尊重用户上翻(读历史时不被拽回底部,
  // Kotlin MessageList 同口径); 离开底部显示回底按钮(copilot-scroll-to-bottom 语义)
  const chatMessagesRef = useRef<HTMLDivElement | null>(null)
  const chatAtBottomRef = useRef(true)
  const [chatAtBottom, setChatAtBottom] = useState(true)
  const handleChatScroll = useCallback(() => {
    const el = chatMessagesRef.current
    if (!el) return
    // 与 Logs 页同阈值: 距底部 <40px 视为"在底部"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    chatAtBottomRef.current = atBottom
    setChatAtBottom(atBottom)
  }, [])
  const scrollChatToBottom = useCallback(() => {
    const el = chatMessagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    chatAtBottomRef.current = true
    setChatAtBottom(true)
  }, [])
  useEffect(() => {
    const el = chatMessagesRef.current
    if (el && chatAtBottomRef.current) el.scrollTop = el.scrollHeight
  }, [conversation, streamingAiText])

  // 2026-08-13: 消息反馈(P0-3)——点赞/点踩落 audit-log,反哺模型调优
  const handleMessageFeedback = useCallback((m: ChatMsg, rating: 'up' | 'down') => {
    if (feedbackMap.has(m.ts)) return
    setFeedbackMap(prev => { const next = new Map(prev); next.set(m.ts, rating); return next })
    apiPost('/api/chat/message-feedback', {
      conversationId: flow.getConversationId(),
      messageTs: m.ts,
      rating,
      text: m.text.slice(0, 500),
    }).catch((err) => {
      console.error('[shell] 消息反馈发送失败:', err)
      setFeedbackMap(prev => { const next = new Map(prev); next.delete(m.ts); return next })
    })
  }, [feedbackMap, flow])

  return {
    conversation,
    setConversation,
    conversationRef,
    pushChat,
    roundSeqRef,
    lastUserRoundRef,
    lastAiPushedRef,
    feedbackMap,
    handleMessageFeedback,
    getToolBatch,
    toolchainOpenTs,
    toggleToolchain,
    linkedRound,
    linkRound,
    chatMessagesRef,
    chatAtBottom,
    handleChatScroll,
    scrollChatToBottom,
    streamingAiText,
  }
}
