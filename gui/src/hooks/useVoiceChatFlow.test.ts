// 思维条生命周期测试（node 环境, 无 jsdom/renderer）——沿用 useAgentMonitor.test 的
// "mock 依赖 + 直测" 模式: mock react 原语(useState/useRef/useCallback/useEffect)后
// 直接执行 useVoiceChatFlow 函数体, 捕获 chatStream.send 的回调对象, 按真实 SSE
// 事件顺序(start→thinking→chunk→end)驱动 onThinking/onChunk/onStreamEnd/onError,
// 验证 currentThinking 不会被悬挂。
//
// state 槽位按 useState 调用顺序(改动 useVoiceChatFlow 的 state 定义前先核对本表):
// 0 transcript / 1 aiText / 2 isSpeaking / 3 speakingSegment / 4 pending /
// 5 replyCompleted / 6 toolEvents / 7 currentThinking
const mockStateSlots: Array<{ value: unknown; set: (v: unknown) => void }> = []

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const slot = { value: init, set: (v: unknown) => { slot.value = v } }
    mockStateSlots.push(slot)
    return [slot.value, slot.set]
  },
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
}))

const mockSend = vi.fn()
const mockAbort = vi.fn()
vi.mock('./useChatStream', () => ({ useChatStream: () => ({ send: mockSend, abort: mockAbort }) }))
vi.mock('./useVoiceReply', () => ({
  useVoiceReply: () => ({
    beginStreamingTTS: vi.fn(),
    feedStreamingTTS: vi.fn(),
    finalizeStreamingTTS: vi.fn(),
    interruptTTS: vi.fn(),
    playStreamingTTS: vi.fn(),
  }),
}))
vi.mock('../contexts/VoiceStateContext', () => ({
  useVoiceState: () => ({ state: { voiceSessionState: 'idle', voiceSessionActive: false, ttsActive: false } }),
}))
vi.mock('../lib/api', () => ({ apiPost: async () => ({ success: true, data: { sessionId: 'sess_1' } }) }))

import { useVoiceChatFlow } from './useVoiceChatFlow'

const THINKING_SLOT = 7
const currentThinking = () => mockStateSlots[THINKING_SLOT]?.value as string
// 2026-08-14 ag-ui 二次分析: stopGenerating 终态断言用的槽位
const PENDING_SLOT = 4
const REPLY_DONE_SLOT = 5

describe('useVoiceChatFlow 思维条生命周期（回复流终结必须清空 currentThinking, 防悬挂）', () => {
  let sendOpts: Record<string, (...args: any[]) => void> = {}

  beforeEach(() => {
    mockStateSlots.length = 0
    sendOpts = {}
    mockSend.mockReset()
    mockSend.mockImplementation(async (_msg: unknown, opts: unknown) => { Object.assign(sendOpts, opts) })
    mockAbort.mockReset()
    ;(globalThis as any).window = { __ttsStreamStarted: false }
  })

  const flow = () => useVoiceChatFlow({ replyEnabled: false, continuousMode: false } as any, false)

  test('thinking 事件更新思维条内容', async () => {
    const f = flow()
    await f.sendText('今天行情怎么样')
    sendOpts.onThinking('正在理解您的问题...')
    expect(currentThinking()).toBe('正在理解您的问题...')
  })

  test('回复内容开始（首 chunk）后思维条清空——防「正在理解您的问题」悬挂到流结束', async () => {
    const f = flow()
    await f.sendText('今天行情怎么样')
    sendOpts.onThinking('正在理解您的问题...')
    expect(currentThinking()).toBe('正在理解您的问题...')
    sendOpts.onChunk('你', '你好')
    expect(currentThinking()).toBe('')
  })

  test('onStreamEnd 兜底清空（空回复/无 chunk 路径）', async () => {
    const f = flow()
    await f.sendText('hi')
    sendOpts.onThinking('正在理解您的问题...')
    sendOpts.onStreamEnd({})
    expect(currentThinking()).toBe('')
  })

  test('onError 清空', async () => {
    const f = flow()
    await f.sendText('hi')
    sendOpts.onThinking('正在理解您的问题...')
    sendOpts.onError('boom')
    expect(currentThinking()).toBe('')
  })

  test('sendText 发送异常（catch 路径）后保持清空', async () => {
    mockSend.mockRejectedValueOnce(new Error('network'))
    const f = flow()
    await f.sendText('hi')
    expect(currentThinking()).toBe('')
  })

  // ── 2026-08-14 ag-ui 二次分析: stopGenerating（send/stop 按钮合一语义）──
  // abort 后 useChatStream 静默返回（onStreamEnd 不触发）, flow 必须亲自终结:
  // pending 回落 + replyCompleted 置位(部分回复落卡) + 清思维条 + 置
  // __ttsStreamStarted=true(防 finally flush 惰性重启 TTS) + 停 TTS。
  test('stopGenerating 中止流: abort 被调用 + pending 回落 + 思维条清空 + 回复定稿', async () => {
    const f = flow()
    await f.sendText('你好')
    sendOpts.onThinking('正在理解您的问题...')
    // 2026-08-15 S14: 首 chunk 即清 pending(思考期可见性修正)——此处先断言
    // onChunk 前 pending=true(思考中), chunk 后回落
    expect(mockStateSlots[PENDING_SLOT].value).toBe(true)
    sendOpts.onChunk('你', '你好')
    expect(mockStateSlots[PENDING_SLOT].value).toBe(false)
    expect(mockStateSlots[REPLY_DONE_SLOT].value).toBe(false)

    f.stopGenerating()

    expect(mockAbort).toHaveBeenCalledTimes(1)
    expect(mockStateSlots[PENDING_SLOT].value).toBe(false)
    expect(mockStateSlots[REPLY_DONE_SLOT].value).toBe(true)
    expect(currentThinking()).toBe('')
    // 防 finally flush 惰性重启 TTS
    expect((globalThis as any).window.__ttsStreamStarted).toBe(true)
  })

  test('S14: 首 chunk 前保持 thinking 态（start 帧不清 pending）', async () => {
    const f = flow()
    await f.sendText('思考一下再回答')
    expect(mockStateSlots[PENDING_SLOT].value).toBe(true)
    // start 帧到达(旧语义在此清 pending)——S14 后仍保持 thinking
    sendOpts.onStreamStart({})
    expect(mockStateSlots[PENDING_SLOT].value).toBe(true)
    // 首个非空 chunk 才回落
    sendOpts.onChunk('好', '好的')
    expect(mockStateSlots[PENDING_SLOT].value).toBe(false)
  })

  test('stopGenerating 在无进行中流时调用也安全（幂等, 不抛错）', async () => {
    const f = flow()
    expect(() => f.stopGenerating()).not.toThrow()
    // 幂等: 重复停止不重复 abort 副作用外仍安全
    expect(() => f.stopGenerating()).not.toThrow()
  })
})

// ─── 2026-09-06 断线补投: run:finished 全文兜底 ───
// 实机：/chat 流式连接中途断开 → 服务端 run 继续完成并广播 run:finished(带全文)，
// 前端此前无消费方 → "发了消息没有回复"。补投判定：事件晚于本轮开始 且 已渲染
// 文本不含该回复(流没送到) → 全文进 aiText 走既有落卡/TTS 管线；健康路径跳过。
const sseState = vi.hoisted(() => ({ handlers: {} as Record<string, (d: any) => void> }))
vi.mock('./useSSE', () => ({
  useSse: (opts: any) => { sseState.handlers = (opts?.handlers || {}) as any },
}))

describe('断线补投（run:finished 全文兜底, 2026-09-06）', () => {
  // flow/sendOpts 助手在首个 describe 内部,此处重建同款(直调 hook + 捕获回调)
  const AI_SLOT = 1
  const REPLY_SLOT = 5
  const flowLocal = () => useVoiceChatFlow({ replyEnabled: false, continuousMode: false } as any, false)
  let localOpts: Record<string, (...args: any[]) => void> = {}
  const aiTextNow = () => mockStateSlots[AI_SLOT]?.value as string
  const replyDone = () => mockStateSlots[REPLY_SLOT]?.value as boolean

  beforeEach(() => {
    mockStateSlots.length = 0
    sseState.handlers = {}
    localOpts = {}
    mockSend.mockReset()
    mockSend.mockImplementation(async (_msg: unknown, opts: unknown) => { Object.assign(localOpts, opts) })
    ;(globalThis as any).window = { __ttsStreamStarted: false }
  })

  test('流断连未收到任何 chunk → run:finished 全文补投（aiText 终结 + replyCompleted）', async () => {
    const f = flowLocal()
    await f.sendText('生成一个网页')
    expect(aiTextNow()).toBe('')
    sseState.handlers['run:finished']({ status: 'finished', userId: 'voice_shell_user', ts: Date.now(), content: '你想生成什么主题的网页？' })
    expect(aiTextNow()).toBe('你想生成什么主题的网页？')
    expect(replyDone()).toBe(true)
  })

  test('健康路径（流式已送达同内容）→ 跳过，不重复渲染', async () => {
    const f = flowLocal()
    await f.sendText('生成一个网页')
    localOpts.onChunk('你想', '你想生成什么主题的网页？')
    sseState.handlers['run:finished']({ status: 'finished', userId: 'voice_shell_user', ts: Date.now(), content: '你想生成什么主题的网页？' })
    expect(aiTextNow()).toBe('你想生成什么主题的网页？') // 保持流式累积值
    expect(replyDone()).toBe(false) // 未被补投终结（等 onStreamEnd 正常终结）
  })

  test('部分送达（渲染到一半断流）→ 全文补齐', async () => {
    const f = flowLocal()
    await f.sendText('生成一个网页')
    localOpts.onChunk('你想', '你想生成什么')
    sseState.handlers['run:finished']({ status: 'finished', userId: 'voice_shell_user', ts: Date.now(), content: '你想生成什么主题的网页？' })
    expect(aiTextNow()).toBe('你想生成什么主题的网页？')
    expect(replyDone()).toBe(true)
  })

  test('旧轮 run:finished（早于本轮开始超 5s）→ 跳过，不串轮', async () => {
    const f = flowLocal()
    await f.sendText('生成一个网页')
    sseState.handlers['run:finished']({ status: 'finished', userId: 'voice_shell_user', ts: Date.now() - 60000, content: '上一轮的回复' })
    expect(aiTextNow()).toBe('')
    expect(replyDone()).toBe(false)
  })

  test('error/interrupt 终态或空 content → 跳过', async () => {
    const f = flowLocal()
    await f.sendText('生成一个网页')
    sseState.handlers['run:finished']({ status: 'error', userId: 'voice_shell_user', ts: Date.now(), content: 'x' })
    sseState.handlers['run:finished']({ status: 'finished', userId: 'voice_shell_user', ts: Date.now(), content: '' })
    expect(aiTextNow()).toBe('')
  })
})
