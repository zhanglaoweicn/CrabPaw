import { normalizeAguiChatEvent } from './agui-chat-normalize'

describe('agui-chat-normalize（/chat 流 AG-UI 帧 → legacy，2026-08-25 交互无响应修复）', () => {
  it('RUN_STARTED → start', () => {
    const r = normalizeAguiChatEvent({ type: 'RUN_STARTED', runId: 'r1', threadId: 't1', input: '你好' })
    expect(r.kind).toBe('handled')
    const e = (r as any).evt
    expect(e.type).toBe('start')
    expect(e.plainReply).toBe('你好')
  })

  it('TEXT_MESSAGE_CHUNK → chunk（delta 增量）', () => {
    const r = normalizeAguiChatEvent({ type: 'TEXT_MESSAGE_CHUNK', delta: '内容', messageId: 'r1-msg' })
    const e = (r as any).evt
    expect(e.type).toBe('chunk')
    expect(e.content).toBe('内容')
    expect(e._delta).toBe(true)
  })

  it('thinking 帧（messageId 以 -think 结尾）→ thinking + delta 标记', () => {
    const r = normalizeAguiChatEvent({ type: 'TEXT_MESSAGE_CHUNK', delta: '思考', messageId: 'r1-think' })
    const e = (r as any).evt
    expect(e.type).toBe('thinking')
    expect(e.content).toBe('思考')
    expect(e._delta).toBe(true)
  })

  it('TOOL_CALL_START / ARGS / RESULT 字段搬移（success 默认 true）', () => {
    const start = normalizeAguiChatEvent({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'Bash' })
    expect((start as any).evt).toMatchObject({ type: 'tool_call', toolId: 'tc1', toolName: 'Bash' })
    const args = normalizeAguiChatEvent({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: 'ls' })
    expect((args as any).evt).toMatchObject({ type: 'tool_call', toolId: 'tc1', toolArgs: 'ls', _appendArgs: true })
    const result = normalizeAguiChatEvent({ type: 'TOOL_CALL_RESULT', toolCallId: 'tc1', content: 'ok' })
    expect((result as any).evt).toMatchObject({ type: 'tool_result', toolId: 'tc1', success: true, result: 'ok' })
  })

  it('RUN_FINISHED：success → done；interrupt → interrupted', () => {
    const done = normalizeAguiChatEvent({ type: 'RUN_FINISHED', runId: 'r1', outcome: { type: 'success' } })
    expect((done as any).evt.type).toBe('done')
    const intr = normalizeAguiChatEvent({ type: 'RUN_FINISHED', runId: 'r1', outcome: { type: 'interrupt' } })
    expect((intr as any).evt.type).toBe('interrupted')
  })

  it('RUN_ERROR → error', () => {
    const r = normalizeAguiChatEvent({ type: 'RUN_ERROR', message: 'boom' })
    expect((r as any).evt).toMatchObject({ type: 'error', error: 'boom' })
  })

  it('STEP_STARTED/ACTIVITY_DELTA/TOOL_CALL_END → 安静忽略', () => {
    expect(normalizeAguiChatEvent({ type: 'STEP_STARTED' }).kind).toBe('ignore')
    expect(normalizeAguiChatEvent({ type: 'ACTIVITY_DELTA' }).kind).toBe('ignore')
    expect(normalizeAguiChatEvent({ type: 'TOOL_CALL_END' }).kind).toBe('ignore')
  })

  it('CUSTOM 解包出原 legacy 类型（如 phase）', () => {
    const r = normalizeAguiChatEvent({ type: 'CUSTOM', name: 'phase', value: { a: 1 } })
    expect(r.kind).toBe('passthrough')
    expect((r as any).evt.type).toBe('phase')
  })

  it('legacy 小写帧（双发兼容）→ 透传不改写', () => {
    const r = normalizeAguiChatEvent({ type: 'chunk', content: '旧' })
    expect(r.kind).toBe('passthrough')
    expect((r as any).evt.content).toBe('旧')
  })
})
