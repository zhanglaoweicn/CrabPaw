/**
 * chat-handler 回归测试
 *
 * 2026-08-13 P2-4 引入的 TDZ bug:handleChat 在 line 807 将 userId 解构重命名为
 * requestUserId,但会话创建块(812/817)仍引用 userId——而 let userId 声明在其后
 * (line 830)→ 前端带 sess_* conversationId 时每次 POST /chat 抛
 * "Cannot access 'userId' before initialization" → 500 → 语音/文字全链路无回复。
 */
jest.mock('./http-utils', () => ({
  readRequestBody: jest.fn(),
  readJsonBody: jest.fn(),
  sendError: jest.fn(),
  sendJson: jest.fn(),
}))

// 2026-08-14 数据链审计 C1: mock memory-system——测试不触碰真实 data/ 目录,
// 只验证 chat-handler 的会话落库接线(路径/导出形态/调用参数)。
jest.mock('../core/memory-system', () => ({
  memoryManager: {
    getOrCreateSession: jest.fn(async () => ({ sessionId: 'sess_test_abc123' })),
    flushSession: jest.fn(async () => true),
    sessions: new Map(),
  },
}))


// 2026-08-15 审查返工 Important-1: mock run-store——流路径测试走到 finishRun 时
// 不写 data/checkpoints 真实文件(CheckpointStore 落盘)。
jest.mock('../core/run-store', () => ({
  getRunStore: jest.fn(() => ({ save: jest.fn(() => true), load: jest.fn(() => null) })),
}))

const { handleChat } = require('./chat-handler')
const { readJsonBody, sendError, sendJson } = require('./http-utils')
const { memoryManager } = require('../core/memory-system')

function makeReqRes() {
  const req = { url: '/chat', method: 'POST', headers: {} }
  const res = {}
  return { req, res }
}

beforeEach(() => {
  jest.clearAllMocks()
})

test('sess_* conversationId 不触发 userId TDZ——流程正常走到后续检查', async () => {
  readJsonBody.mockResolvedValue({ message: '你好', conversationId: 'sess_test_abc123' })
  const { req, res } = makeReqRes()

  // security 拒绝:让流程在会话创建块之后以 403 终止(避免进入聊天分发/网络)
  await handleChat(req, res, {
    appConfig: { chatChannel: 'none' },
    security: {
      checkUserAuthorization: async () => ({ authorized: false, reason: 'deny-test' }),
    },
  })

  // 若 TDZ 复现:handleChat 的 catch 会 sendError(500, 'Cannot access userId...')
  expect(sendError).not.toHaveBeenCalledWith(expect.anything(), 500, expect.stringContaining('Cannot access'))
  expect(sendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('deny-test'))
})

test('无 conversationId 时流程不受影响', async () => {
  readJsonBody.mockResolvedValue({ message: '你好' })
  const { req, res } = makeReqRes()

  await handleChat(req, res, {
    appConfig: { chatChannel: 'none' },
    security: {
      checkUserAuthorization: async () => ({ authorized: false, reason: 'deny-test' }),
    },
  })

  expect(sendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('deny-test'))
})

test('非 sess_ 前缀 conversationId 不触发会话创建', async () => {
  readJsonBody.mockResolvedValue({ message: '你好', conversationId: 'plain_id' })
  const { req, res } = makeReqRes()

  await handleChat(req, res, {
    appConfig: { chatChannel: 'none' },
    security: {
      checkUserAuthorization: async () => ({ authorized: false, reason: 'deny-test' }),
    },
  })

  expect(sendError).toHaveBeenCalledWith(expect.anything(), 403, expect.stringContaining('deny-test'))
})

// 2026-08-14 数据链审计 C1 回归: 旧实现 require('./memory/memory-manager') 从 src/handlers
// 解析 → MODULE_NOT_FOUND 被 catch 吞 → getOrCreateSession 永不被调用 → sessionId 恒 null。
test('sess_* conversationId 触发 memoryManager.getOrCreateSession(落库接线不降级)', async () => {
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  readJsonBody.mockResolvedValue({ message: '你好', conversationId: 'sess_test_abc123', userId: 'voice_shell_user' })
  const { req, res } = makeReqRes()

  await handleChat(req, res, {
    appConfig: { chatChannel: 'none' },
    security: {
      checkUserAuthorization: async () => ({ authorized: false, reason: 'deny-test' }),
    },
  })

  // 路径/导出形态正确: getOrCreateSession 被调用且参数为 (conversationId, requestUserId)
  expect(memoryManager.getOrCreateSession).toHaveBeenCalledWith('sess_test_abc123', 'voice_shell_user')
  // 未走"会话创建/续用失败(降级 null)"分支
  expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('会话创建/续用失败'), expect.anything())
  warnSpy.mockRestore()
})

// 2026-08-14 数据链审计 C1: 真实模块层面验证——require 路径可解析且导出 memoryManager 单例,
// 杜绝再次出现 MODULE_NOT_FOUND/导出形态不匹配(如 getMemoryManager() 这种不存在的方法)。
test('memory-system 真实模块可解析且导出 memoryManager 单例', () => {
  const real = jest.requireActual('../core/memory-system')
  expect(real).toBeTruthy()
  expect(typeof real.memoryManager.getOrCreateSession).toBe('function')
  expect(typeof real.memoryManager.addMessage).toBe('function')
  expect(typeof real.memoryManager.flushSession).toBe('function')
})

// ── 2026-08-14 GUI 全量修复 P1: AG-UI resume 契约(interrupts.mdx) ──────

function makeApprovalCtx(respondImpl) {
  return {
    appConfig: { chatChannel: 'none' },
    security: { approval: { respond: respondImpl || jest.fn(async () => ({ success: true })) } },
  }
}

test('run-store require 路径已修复(../core/run-store)——终态广播不再被 MODULE_NOT_FOUND 吞掉', () => {
  const real = jest.requireActual('../core/run-store')
  expect(real).toBeTruthy()
  expect(typeof real.getRunStore).toBe('function')
  expect(real.RUN_STATUSES.has('finished')).toBe(true)
})

test('resume-only 请求: 翻译为 approval.respond 并返回 per-item 结果', async () => {
  const respond = jest.fn(async () => ({ success: true }))
  readJsonBody.mockResolvedValue({
    resume: [{ interruptId: 'req1', status: 'resolved', payload: { approved: true } }],
    conversationId: 'sess_test_abc123',
  })
  const { req, res } = makeReqRes()

  await handleChat(req, res, makeApprovalCtx(respond))

  // approve-with-edits 语义: approved=true → respond(requestId, true, 'once')
  expect(respond).toHaveBeenCalledWith('req1', true, 'once', { conversationId: 'sess_test_abc123' })
  // resume-only → 直接返回, 不进入 LLM 流
  expect(sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
    success: true,
    resume: [{ interruptId: 'req1', success: true }],
  }))
  expect(sendError).not.toHaveBeenCalled()
})

test('resume cancelled → respond(false); 拒绝在 payload 内(approved:false)', async () => {
  const respond = jest.fn(async () => ({ success: true }))
  readJsonBody.mockResolvedValue({
    resume: [{ interruptId: 'req-cancel', status: 'cancelled' }],
  })
  const { req, res } = makeReqRes()

  await handleChat(req, res, makeApprovalCtx(respond))

  expect(respond).toHaveBeenCalledWith('req-cancel', false, 'once', expect.anything())
  expect(sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
    resume: [{ interruptId: 'req-cancel', success: true }],
  }))
})

test('approve-with-edits: editedArgs 全量替换进 options.editedCommand', async () => {
  const respond = jest.fn(async () => ({ success: true }))
  readJsonBody.mockResolvedValue({
    resume: [{
      interruptId: 'req-edit', status: 'resolved',
      payload: { approved: true, editedArgs: 'echo safe', scope: 'session', conversationId: 'sess_x' },
    }],
  })
  const { req, res } = makeReqRes()

  await handleChat(req, res, makeApprovalCtx(respond))

  expect(respond).toHaveBeenCalledWith('req-edit', true, 'session', {
    editedCommand: 'echo safe', conversationId: 'sess_x',
  })
})

test('重复 resume 幂等: 第二次 alreadyResolved, respond 不再被调', async () => {
  const respond = jest.fn(async () => ({ success: true }))
  readJsonBody.mockResolvedValue({
    resume: [{ interruptId: 'req-idem', status: 'resolved', payload: { approved: true } }],
  })

  const { req: req1, res: res1 } = makeReqRes()
  await handleChat(req1, res1, makeApprovalCtx(respond))
  expect(respond).toHaveBeenCalledTimes(1)

  const { req: req2, res: res2 } = makeReqRes()
  await handleChat(req2, res2, makeApprovalCtx(respond))

  expect(respond).toHaveBeenCalledTimes(1) // 未再调 respond
  expect(sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
    resume: [{ interruptId: 'req-idem', success: true, alreadyResolved: true }],
  }))
})

test('resume 非法条目 → 结构化错误, 不抛异常', async () => {
  readJsonBody.mockResolvedValue({ resume: [{ interruptId: 'req-bad', status: 'bogus' }] })
  const { req, res } = makeReqRes()

  await handleChat(req, res, makeApprovalCtx())

  expect(sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
    resume: [expect.objectContaining({ interruptId: 'req-bad', success: false })],
  }))
})

test('approval 系统不可用 → 结构化错误', async () => {
  readJsonBody.mockResolvedValue({ resume: [{ interruptId: 'req-na', status: 'resolved', payload: { approved: true } }] })
  const { req, res } = makeReqRes()

  await handleChat(req, res, { appConfig: { chatChannel: 'none' }, security: {} })

  expect(sendJson).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
    resume: [expect.objectContaining({ interruptId: 'req-na', success: false, error: 'Approval system unavailable' })],
  }))
})

// ── 2026-08-15 D1(审计 P0): 断连中止服务端 LLM ──────
// req.on('close') 在请求体读完('end')后即触发(晚于监听注册)→ cleanup 永不执行。
// 修复: res.on('close') + writableFinished 区分正常结束与提前断连。

const { _attachDisconnectCleanup } = require('./chat-handler')

function makeEventTargets() {
  const handlers = {}
  const req = { on: jest.fn((ev, cb) => { handlers['req:' + ev] = cb }) }
  const res = { writableFinished: false, on: jest.fn((ev, cb) => { handlers['res:' + ev] = cb }) }
  return { req, res, handlers }
}

test('P0-1: res close 且响应未完成 → onCleanup 被调(中止服务端 LLM)', () => {
  const { req, res, handlers } = makeEventTargets()
  const onCleanup = jest.fn()
  _attachDisconnectCleanup({ req, res, onCleanup })

  handlers['res:close']() // 连接销毁且响应未写完 → 提前断连 → cleanup(abort)
  expect(onCleanup).toHaveBeenCalledTimes(1)

  handlers['req:aborted']() // HTTP/1 客户端主动中断路径保留
  expect(onCleanup).toHaveBeenCalledTimes(2)
})

test('P0-1: res close 且响应已完成(writableFinished=true) → 不 abort(正常结束)', () => {
  const { req, res, handlers } = makeEventTargets()
  res.writableFinished = true
  const onCleanup = jest.fn()
  _attachDisconnectCleanup({ req, res, onCleanup })

  handlers['res:close']() // 正常结束: 响应已写完, 不应触发 cleanup
  expect(onCleanup).not.toHaveBeenCalled()
})

// ── 2026-08-15 审查返工 Important-1: idleAbort 一次性 latch 误杀整轮 ──────
// 计时器只在收到 chunk 时重置; 工具执行 >120s 无 chunk → 超时 abort 把合并信号
// 永久 latch → 工具完成后下一轮 fetch 立即 AbortError → 整轮"用户中断"。
// 修复: 超时 abort 后 handler 换新 controller; ai.js 每轮 fetch 经 getIdleSignal()
// 取当前信号合并(已 abort 的旧信号不再参与后续轮次)。

function makeStreamChatCtx(chatStreamImpl) {
  return {
    appConfig: { chatChannel: 'none', user: {} },
    security: {
      checkUserAuthorization: async () => ({ authorized: true }),
      detectPromptInjection: () => ({ blocked: false }),
    },
    ai: {
      chatStream: chatStreamImpl,
      setSubAgentCallback: jest.fn(),
    },
  }
}

function makeStreamReqRes() {
  const req = { url: '/chat', method: 'POST', headers: {}, on: jest.fn() }
  const res = {
    writableFinished: false,
    writeHead: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    on: jest.fn(),
  }
  return { req, res }
}

test('Important-1: 空闲超时 abort 后换新 controller——后续轮次 fetch 不被 latch 误杀', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] })
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

  let captured
  let resolveStream
  const streamPromise = new Promise((r) => { resolveStream = r })
  const chatStream = jest.fn((_cfg, _skills, _uid, _msg, onChunk, options) => {
    captured = { onChunk, options }
    return streamPromise
  })

  readJsonBody.mockResolvedValue({ message: '你好', stream: true })
  const { req, res } = makeStreamReqRes()
  const p = handleChat(req, res, makeStreamChatCtx(chatStream))

  for (let i = 0; i < 30 && !captured; i++) await flush()
  expect(captured).toBeTruthy()
  expect(typeof captured.options.getIdleSignal).toBe('function')

  // 请求发起即启动空闲计时; 初始信号未 abort
  const sig1 = captured.options.getIdleSignal()
  expect(sig1.aborted).toBe(false)

  // 收到 chunk → 重置计时器(controller 对象不变, 计时器重新武装)
  captured.onChunk({ content: '第一段', done: false })
  expect(captured.options.getIdleSignal()).toBe(sig1)

  // 工具执行 >120s 无 chunk → 超时 abort 当前信号
  jest.advanceTimersByTime(120000)
  expect(sig1.aborted).toBe(true)

  // 超时后 handler 已换新 controller: 工具完成后的下一轮 fetch 取到未 abort 信号
  const sig2 = captured.options.getIdleSignal()
  expect(sig2).not.toBe(sig1)
  expect(sig2.aborted).toBe(false)

  // 下一轮 chunk → 计时器重新武装; 再 120s 无 chunk → 既有"中止当前读取"语义保持
  captured.onChunk({ content: '第二轮', done: false })
  jest.advanceTimersByTime(120000)
  expect(sig2.aborted).toBe(true)

  resolveStream('')
  await p
  warnSpy.mockRestore()
  jest.useRealTimers()
})
