/**
 * useVoiceChatFlow — VoiceShell 的「对话流 → 语音播报」接线
 *
 * 参照 Dashboard 的接线模式：useChatStream 发送 → 流式 chunk 喂给
 * useVoiceReply 的 beginStreamingTTS/feedStreamingTTS → 句子级 TTS 播放。
 * 抽取为独立 hook 供 VoiceShell 使用，避免复制 Dashboard 的 2800 行。
 *
 * 签名差异 vs 原始计划（以真实源文件为准）：
 * - useChatStream.send 需要 {message, userId, conversationId}
 * - onChunk 回调签名: (content, accumulated) — accumulated 喂给 feedStreamingTTS
 * - onStreamEnd（非 onDone）
 * - beginStreamingTTS 需要 (voiceConfig, options) — voiceConfig 必传
 * - feedStreamingTTS 接受累积全文，内部自行计算增量
 * - state.ttsActive 可能未设置（由 useVoiceReply 管理 window.__ttsActive），
 *   因此 ttsPlaying 合并 state.ttsActive 与本地 isSpeaking
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStream } from './useChatStream'
import { useVoiceReply, type VoiceConfig } from './useVoiceReply'
import { useVoiceState } from '../contexts/VoiceStateContext'
import { useSse } from './useSSE'
import { apiPost } from '../lib/api'

export function useVoiceChatFlow(
  voiceConfig: VoiceConfig,
  muted = false,
  onPhase?: (event: { phase: string; summary?: string; detail?: string; progress?: number }) => void,
) {
  const chatStream = useChatStream()
  const { state } = useVoiceState()
  const [transcript, setTranscript] = useState('')
  const [aiText, setAiText] = useState('')
  const [isSpeaking, setIsSpeaking] = useState(false)
  // 2026-08-04: 字幕式回复 — TTS 当前播放句（播一段显示一段，说完即消失）
  const [speakingSegment, setSpeakingSegment] = useState('')
  // P5.5: 思考中信号 — 已发送且未开始回复流（球体 thinking 态）
  const [pending, setPending] = useState(false)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 2026-08-07: 本轮回复流是否已结束（onStreamEnd/onError 置 true, sendText 置 false）——
  // 供消费方判断"回复完整"再落对话卡片。此前消费方以"TTS 播放间隙"判断,
  // PTT 打断 TTS 时半截 aiText 被 push,回复完整后再 push 一次 → 卡片内容重复分段
  const [replyCompleted, setReplyCompleted] = useState(false)
  // 2026-08-13 P2-1: 本轮流内工具调用记录(供右栏"工具执行"过程卡渲染)。
  // 与 aiText 同一代际:sendText 清空 + 回调 gen 守卫 + 落卡同 effect,三重防串轮。
  // 2026-08-14: 新增 summary——onToolResult 回填结果摘要(前 80 字),
  // 使工具执行区块展示"调用→结果"完整过程(AG-UI TOOL_CALL/RESULT 语义)。
  const [toolEvents, setToolEvents] = useState<Array<{
    toolId: string; toolName: string; status: 'running' | 'done' | 'error'
    /** 2026-08-14: 结果摘要(done=结果前 80 字 / error=错误文案),运行中为空 */
    summary?: string
    /** 2026-08-14(DingDong ToolRunPanel 对齐): 工具调用参数(原始 JSON,卡片/右栏截断展示) */
    args?: string
    /** 2026-08-14(DingDong 卡片系统对齐): 工具结果全文(前 600 字)——中栏卡片渲染数据源 */
    result?: string
  }>>([])
  // 2026-08-14: 当前思考内容(SSE thinking 事件,完整离散状态消息)——供中栏"思维条"
  // 实时展示(AG-UI REASONING 语义)。sendText 清空,onThinking 更新。
  const [currentThinking, setCurrentThinking] = useState('')

  // P5.5: pending 兜底 — 发送后 10s 未收到回复流则回落（防卡 thinking）
  useEffect(() => {
    if (!pending) return
    pendingTimerRef.current = setTimeout(() => setPending(false), 10000)
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    }
  }, [pending])

  const convIdRef = useRef<string | null>(null)
  const userIdRef = useRef('voice_shell_user')
  const voiceConfigRef = useRef(voiceConfig)
  voiceConfigRef.current = voiceConfig
  // P2 修复: 流代际守卫——连续 sendText 时旧流回调(onStreamEnd/onError)
  // 可能在新流启动后方到达,误终结新流的 TTS。每次 sendText 递增 generation,
  // 回调闭包捕获自己的代际,非当前代直接返回。
  const generationRef = useRef(0)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  // 2026-09-06 断线补投: 本轮开始时刻 + 流式已收文本同步镜像——
  // run:finished 补投判定用(事件晚于本轮开始 且 已渲染文本不含该回复 → 流没送到)
  const genStartedAtRef = useRef(0)
  const aiTextRef = useRef('')

  const {
    beginStreamingTTS,
    feedStreamingTTS,
    finalizeStreamingTTS,
    interruptTTS,
    playStreamingTTS,
  } = useVoiceReply()

  // 2026-08-13 P2-4: 会话 id 确保——优先后端 sess_*(消息按会话落库/恢复),
  // 失败回退本地 voice-* id。调用方不 await 也无破坏(async 兼容同步调用)。
  const ensureConversationId = useCallback(async () => {
    if (convIdRef.current) return convIdRef.current
    try {
      const res = await apiPost<{ success?: boolean; sessionId?: string }>('/api/sessions', { userId: userIdRef.current })
      if (res?.success && res.data?.sessionId) {
        convIdRef.current = res.data.sessionId
        return res.data.sessionId
      }
      console.warn('[flow] 会话创建响应异常,回退本地 id:', res)
    } catch (e) {
      console.warn('[flow] 会话创建失败,回退本地 id:', (e as Error)?.message || e)
    }
    convIdRef.current = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return convIdRef.current
  }, [])

  // 2026-08-13 P2-4: 恢复指定会话(会话历史"继续对话")
  const resumeConversation = useCallback((sessionId: string) => {
    convIdRef.current = sessionId
  }, [])

  // 2026-08-13 P2-4: 新对话(清空会话引用,下次发送重新创建)
  const newConversation = useCallback(() => {
    convIdRef.current = null
  }, [])

  // 2026-08-04: 支持附件——文本对话配套文件上传(后端 /chat files 字段,注入消息提示 LLM 读取)
  const sendText = useCallback(async (text: string, files?: Array<{ path: string; name: string; type?: string; size?: number }>) => {
    setAiText('')
    setPending(true)
    setReplyCompleted(false)
    // 2026-08-13 P2-1: 本轮流内工具记录清空(与代际同周期)
    setToolEvents([])
    // 2026-08-14: 新轮次清空当前思考(思维条随轮次重置)
    setCurrentThinking('')
    // P2: 递增流代际——旧流回调(onStreamEnd/onError)捕获自己的 gen,
    // 非当前代直接 return,防止旧流终结新流的 TTS
    const gen = ++generationRef.current
    // 2026-09-06 断线补投锚点: 本轮开始时刻(旧轮 run:finished 据此跳过)
    genStartedAtRef.current = Date.now()
    aiTextRef.current = ''

    // 2026-08-13 P2-4: conversationId 打通——优先从后端创建 sess_* 会话
    // (消息按会话落库、历史按会话过滤);后端不可用时回退本地 voice-* id
    await ensureConversationId()
    // 2026-08-04 P1: start 事件缺失兜底标记——每次发送重置
    ;(window as any).__ttsStreamStarted = false

    // 2026-08-04 P1: 流式 TTS 启动 options 共享(onStreamStart 与 onChunk 惰性启动共用)
    const ttsOptions = {
      // 字幕式回复 — 当前播放句喂给字幕（播一段显示一段）
      onSegmentStart: (seg?: string) => {
        if (generationRef.current !== gen) return
        setIsSpeaking(true)
        if (seg) setSpeakingSegment(seg)
      },
      onComplete: () => {
        if (generationRef.current !== gen) return
        // P5(GUI 全量修复): 流结束清除标记——speech-queue 归因播报守卫靠它
        // 识别"主回复流进行中"(含合成间隙), 流结束必须放行否则播报永久排队
        try { ;(window as any).__ttsStreamStarted = false } catch (e) { console.warn('[shell] 清流标记失败:', e) }
        setIsSpeaking(false)
        setSpeakingSegment('')
      },
      onInterrupted: () => {
        if (generationRef.current !== gen) return
        try { ;(window as any).__ttsStreamStarted = false } catch (e) { console.warn('[shell] 清流标记失败:', e) }
        setIsSpeaking(false)
        setSpeakingSegment('')
      },
    }

    // 2026-08-13 审查 P1: 发送失败不再静默——fetch 异常在此捕获(此前 unhandled
    // rejection 无任何 UI 反馈,用户看到"点击没反应")。错误文案进 aiText,
    // 落卡 effect 渲染为 AI 气泡,与 onError 同款反馈风格。
    try {
      await chatStream.send(
      {
        message: text,
        files: files && files.length > 0 ? files : undefined,
        userId: userIdRef.current,
        conversationId: convIdRef.current,
      },
      {
        onStreamStart: (_info) => {
          if (generationRef.current !== gen) return
          // 2026-08-15 S14(审计 P1): start 帧不再清 pending——后端在 chatStream
          // 之前就发 start 帧, 而真正的思考时间(记忆组装+LLM 首 token 1-3s)
          // 落在此后; 此前球体提前变聆听态, 思考不可见。pending 改由首个
          // 非空 chunk 清除(onChunk), 10s 兜底定时器保留。
          // P2: muted 时跳过 TTS 合成/播放——消除静音切换瞬间的 TTS 闪播
          if (mutedRef.current) return
          ;(window as any).__ttsStreamStarted = true
          const vc = voiceConfigRef.current
          if (vc.replyEnabled || vc.continuousMode) {
            try {
              beginStreamingTTS(vc, ttsOptions)
            } catch (e) {
              console.error('[shell] beginStreamingTTS:', e)
            }
          }
        },
        onChunk: (_content: string, accumulated: string) => {
          if (generationRef.current !== gen) return
          // 2026-09-06 断线补投: 同步镜像已收文本(run:finished 健康路径判定用,
          // 不走 setState——其异步性会与 run:finished 到达顺序竞态)
          aiTextRef.current = accumulated
          // 2026-08-14 修复: 回复内容开始后清空思维条——后端 thinking 事件均先于
          // 首 chunk(start 之后、回复流期间不再有 thinking), 不清空则
          // "正在理解您的问题…" 悬挂到流结束仍显示(用户反馈)
          // 2026-08-15 S14: 首 chunk 到达才清 pending——思考期球体保持 thinking 态
          if (accumulated.trim()) {
            setCurrentThinking('')
            setPending(false)
          }
          setAiText(accumulated)
          try {
            // 2026-08-04 P1 修复:start 事件缺失时 TTS 完全静默——后端未发 start
            // 事件(chunk 直接到)时 sttsActive 恒 false,feed 静默 return。
            // 首 chunk 到达且未启动 → 惰性启动流式 TTS
            if (!(window as any).__ttsStreamStarted) {
              // P2: muted 时跳过惰性启动——消除静音切换瞬间的 TTS 闪播
              if (mutedRef.current) return
              ;(window as any).__ttsStreamStarted = true
              const vc = voiceConfigRef.current
              if ((vc.replyEnabled || vc.continuousMode) && accumulated && accumulated.trim().length > 0) {
                try {
                  beginStreamingTTS(vc, ttsOptions)
                } catch (e) {
                  console.error('[shell] 惰性 beginStreamingTTS:', e)
                }
              }
            }
            feedStreamingTTS(accumulated)
          } catch (e) {
            console.error('[shell] feedStreamingTTS:', e)
          }
        },
        onStreamEnd: (_info) => {
          if (generationRef.current !== gen) return
          setReplyCompleted(true)
          // 兜底: 空回复/无 chunk 路径也清空, 防思维条悬挂。
          // 2026-08-15 S14: 同步清 pending(此前由 onStreamStart 承担)
          setPending(false)
          setCurrentThinking('')
          try {
            finalizeStreamingTTS()
          } catch (e) {
            console.error('[shell] finalizeStreamingTTS:', e)
          }
        },
        onError: (content: string) => {
          if (generationRef.current !== gen) return
          setPending(false)
          setCurrentThinking('')
          setReplyCompleted(true)
          console.error('[shell] chat 流错误:', content)
          setAiText(prev => prev + (prev ? '\n' : '') + '（出错了，请重试）')
          try {
            finalizeStreamingTTS()
          } catch (e) {
            console.error('[shell] onError finalizeStreamingTTS:', e)
            try {
              interruptTTS()
            } catch (e2) {
              console.error('[shell] onError interruptTTS:', e2)
            }
          }
        },
        // P7 Task 4: 阶段 TTS 播报——透传后端 phase 事件给 VoiceShell 消费
        onPhase,
        // 2026-08-13 P2-1: 工具调用记录进对话流(均过 gen 守卫防串轮)
        onToolCall: (item) => {
          if (generationRef.current !== gen) return
          setToolEvents(prev => [...prev, {
            toolId: item.toolId,
            toolName: item.toolName || '工具调用',
            status: 'running',
            // 2026-08-14: 参数透传(此前丢弃)——右栏/卡片展示"调用了什么"
            args: item.toolArgs || undefined,
          }])
        },
        onToolResult: (r) => {
          if (generationRef.current !== gen) return
          const status = r.success ? 'done' : 'error'
          // 2026-08-14: 结果摘要——done 取 result 前 80 字,error 取错误文案(无则留空)
          const summary = (r.result && r.result.trim())
            ? r.result.trim().replace(/\s+/g, ' ').slice(0, 80)
            : undefined
          // 2026-08-14: 结果全文(截 600 字,防超大结果撑爆渲染)供中栏卡片渲染
          const result = (r.result && r.result.trim()) ? r.result.trim().slice(0, 600) : undefined
          setToolEvents(prev => {
            // 按 toolId 回填;找不到(乱序/丢事件)用 toolName 追加兜底
            const idx = prev.findIndex(t => t.toolId === r.toolId && t.status === 'running')
            if (idx >= 0) {
              const next = [...prev]
              next[idx] = { ...next[idx], status, summary, result }
              return next
            }
            if (!r.toolName) return prev
            return [...prev, { toolId: r.toolId, toolName: r.toolName, status, summary, result }]
          })
        },
        // 2026-08-14: 当前思考(SSE thinking 完整离散状态消息)——中栏思维条数据源
        onThinking: (content) => {
          if (generationRef.current !== gen) return
          if (content) setCurrentThinking(content)
        },
      }
    )
    } catch (e) {
      // 2026-08-13 审查 P1: 连接失败/认证失败/非 200——原路径异常外泄成
      // unhandled rejection,pending 恒 true 直到 10s 兜底,无任何用户反馈
      console.error('[flow] 消息发送失败:', e)
      setPending(false)
      setCurrentThinking('')
      setReplyCompleted(true)
      setAiText((prev) => (prev ? prev + '\n' : '') + `⚠️ 发送失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [chatStream, beginStreamingTTS, feedStreamingTTS, finalizeStreamingTTS, interruptTTS, onPhase])

  const stopSpeaking = useCallback(() => {
    try {
      interruptTTS()
    } catch (e) {
      console.error('[shell] interruptTTS:', e)
    }
  }, [interruptTTS])

  // 2026-08-14 ag-ui 二次分析: 停止生成（ag-ui send/stop 按钮合一语义）。
  // useChatStream.abort 此前存在但未暴露——用户无法中途停止回复。
  // abort 后 useChatStream 静默返回（保留已收内容, useChatStream.ts 167-169），
  // onStreamEnd 不触发——必须在此亲自终结状态:
  //   pending 回落 + replyCompleted 置位(部分回复经 VoiceShell 落卡 effect 定稿) +
  //   清思维条 + 置 __ttsStreamStarted 防 finally flush 惰性重启 TTS + 立即停 TTS。
  const stopGenerating = useCallback(() => {
    try {
      chatStream.abort()
    } catch (e) {
      console.error('[flow] 中止回复流失败:', e)
    }
    try {
      ;(window as any).__ttsStreamStarted = true
    } catch (e) {
      console.warn('[flow] 设置流标记失败:', e)
    }
    setPending(false)
    setCurrentThinking('')
    setReplyCompleted(true)
    try {
      interruptTTS()
    } catch (e) {
      console.error('[flow] 停止生成时停 TTS 失败:', e)
    }
  }, [chatStream, interruptTTS])

  // ── 2026-09-06 断线补投: run:finished 全文兜底 ──────────────────────
  // 实机：/chat 流式连接在请求中途断开(渲染层重连,后端日志"断连但 run 继续")→
  // 服务端 run 继续跑完、回复落库并广播 run:finished(带全文)，但 /chat 流已死
  // 且前端此前无任何消费方 → 用户看到"发了消息没有回复，就结束了"。
  // 订阅 run:finished：事件晚于本轮开始 且 已渲染文本不含该回复(流没送到)→
  // 把全文补进 aiText 走既有落卡/TTS 管线。健康路径(流式送达)凭内容匹配跳过。
  useSse({
    handlers: {
      'run:finished': (data: any) => {
        try {
          if (!data || data.status !== 'finished') return
          if (data.userId && userIdRef.current && data.userId !== userIdRef.current) return
          const content = String(data.content || '')
          if (!content.trim()) return
          // 只补投"本轮开始之后"完成的 run——防旧轮 run:finished 串进新一轮。
          // genStartedAtRef=0(刚挂载/页面重载后)放行:服务端完成时若 SSE 已重连
          // 且监听已挂载,重载丢失的回复同样补得回来。
          if (genStartedAtRef.current && Number(data.ts || 0) < genStartedAtRef.current - 5000) return
          const norm = (s: string) => String(s).replace(/\s+/g, '')
          const rendered = norm(aiTextRef.current)
          const full = norm(content)
          if (rendered) {
            // 流式已把同内容送到(健康路径)→ 不重复渲染
            if (rendered.includes(full.slice(0, 120))) return
            // 已渲染文本与该回复无关(新一轮自己的内容)→ 不混入
            if (!full.startsWith(rendered.slice(0, 120))) return
            // 否则 = 渲染到一半断流 → 全文补齐
          }
          console.warn('[flow] 检测到回复流断连、回复已在服务端完成——补投全文')
          setPending(false)
          setCurrentThinking('')
          setAiText(content)
          try {
            if (!mutedRef.current) {
              const vc = voiceConfigRef.current
              if ((vc.replyEnabled || vc.continuousMode) && !(window as any).__ttsStreamStarted) {
                ;(window as any).__ttsStreamStarted = true
                try {
                  beginStreamingTTS(vc, {
                    onSegmentStart: (seg?: string) => { setIsSpeaking(true); if (seg) setSpeakingSegment(seg) },
                    onComplete: () => {
                      try { ;(window as any).__ttsStreamStarted = false } catch { /* ignore */ }
                      setIsSpeaking(false)
                      setSpeakingSegment('')
                    },
                    onInterrupted: () => {
                      try { ;(window as any).__ttsStreamStarted = false } catch { /* ignore */ }
                      setIsSpeaking(false)
                      setSpeakingSegment('')
                    },
                  })
                } catch (e) {
                  console.error('[flow] 补投 beginStreamingTTS:', e)
                }
              }
              feedStreamingTTS(content)
              finalizeStreamingTTS()
            }
          } catch (e) {
            console.error('[flow] 补投 TTS 失败:', e)
          }
          setReplyCompleted(true)
        } catch (e) {
          console.warn('[flow] run:finished 补投失败:', e)
        }
      },
    },
  })

  return {
    sendText,
    stopSpeaking,
    // 2026-08-14 ag-ui 二次分析: 停止生成(abort + 终态固化)
    stopGenerating,
    playStreamingTTS,
    transcript,
    setTranscript,
    aiText,
    speakingSegment,
    isSpeaking,
    pending,
    replyCompleted,
    // 2026-08-13: 消息反馈(P0-3)定位键——getter 暴露会话 id,不引入 state 避免重渲染
    getConversationId: () => convIdRef.current,
    // 2026-08-13 P2-1: 本轮流内工具调用记录(供右栏"工具执行"过程卡)
    toolEvents,
    // 2026-08-14: 当前思考内容(供中栏"思维条"实时展示)
    currentThinking,
    // 2026-08-13 P2-4: 会话生命周期控制
    resumeConversation,
    newConversation,
    voiceSessionState: state.voiceSessionState,
    voiceSessionActive: state.voiceSessionActive,
    ttsPlaying: state.ttsActive || isSpeaking,
  }
}
