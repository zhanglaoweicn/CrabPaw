// useSSE → ../lib/api 含 Vite 专属 import.meta 语法,node 测试环境无法解析,双 mock 隔离
vi.mock('./useSSE', () => ({ useSse: () => undefined }))
vi.mock('../lib/api', () => ({ apiGet: async () => ({ success: false, error: 'jest' }) }))

import {
  applyActivityEvent,
  applyTurnCompleteEvent,
  createInitialLogState,
  extractMemoryCount,
  runSnapshotToLastAction,
  MONITOR_MAX_LOGS,
} from './useAgentMonitor'

/**
 * G7 退化方案：useSse 依赖 EventSource/Electron IPC 不便在 node 测试环境 mock，
 * 日志生成逻辑抽为纯函数（applyActivityEvent / applyTurnCompleteEvent）直接单测。
 * 服务端事件结构核实自 src/core/activity-stream.js（TYPE 白名单 + _broadcastSSE）。
 */
describe('useAgentMonitor 纯函数 (G7 日志归约)', () => {
  test('tool_executing → tool 日志 + 工具名去重', () => {
    let s = createInitialLogState()
    s = applyActivityEvent(s, { type: 'tool_executing', toolName: 'web_search' }, '14:00:00')
    expect(s.logs).toHaveLength(1)
    expect(s.logs[0].type).toBe('tool')
    expect(s.logs[0].text).toContain('web_search')
    expect(s.logs[0].id).toBe('0')
    expect(s.toolNames).toEqual(['web_search'])

    // 同名工具第二次调用不重复计数
    s = applyActivityEvent(s, { type: 'tool_executing', toolName: 'web_search' }, '14:00:01')
    s = applyActivityEvent(s, { type: 'tool_executing', toolName: 'fetch_doc' }, '14:00:02')
    expect(s.toolNames).toEqual(['web_search', 'fetch_doc'])
    expect(s.toolNames.length).toBe(2)
  })

  test('thinking/tool_result/response/message_received 类型映射', () => {
    let s = createInitialLogState()
    s = applyActivityEvent(s, { type: 'thinking', summary: '模型开始推理' }, '14:01:00')
    expect(s.logs[0].type).toBe('thinking')
    expect(s.logs[0].text).toBe('模型开始推理')

    s = applyActivityEvent(s, { type: 'tool_result', toolName: 'read_file' }, '14:01:01')
    expect(s.logs[1].type).toBe('tool')
    expect(s.logs[1].text).toContain('read_file')

    s = applyActivityEvent(s, { type: 'response', roundId: 'round-1' }, '14:01:02')
    expect(s.logs[2].type).toBe('complete')
    expect(s.logs[2].text).toContain('round-1')

    s = applyActivityEvent(s, { type: 'message_received' }, '14:01:03')
    expect(s.logs[3].type).toBe('user')
    expect(s.logs[3].text).toBe('用户消息已接收')
  })

  test('数值验证轮: 事务=message_received 帧数, 工具=tool_executing 帧数(ack/preparing/result 不重复计)', () => {
    let s = createInitialLogState()
    expect(s.transactions).toBe(0)
    expect(s.toolCalls).toBe(0)

    // 两次用户消息 → 事务 2
    s = applyActivityEvent(s, { type: 'message_received' }, '14:10:00')
    s = applyActivityEvent(s, { type: 'message_received' }, '14:10:01')
    expect(s.transactions).toBe(2)

    // 同一次调用: ack + preparing + executing + result → 仅 executing 计 1
    s = applyActivityEvent(s, { type: 'tool_ack', toolName: 'web_search' }, '14:10:02')
    expect(s.toolCalls).toBe(0)
    s = applyActivityEvent(s, { type: 'tool_preparing', toolName: 'web_search' }, '14:10:03')
    expect(s.toolCalls).toBe(0)
    s = applyActivityEvent(s, { type: 'tool_executing', toolName: 'web_search' }, '14:10:04')
    expect(s.toolCalls).toBe(1)
    s = applyActivityEvent(s, { type: 'tool_result', toolName: 'web_search' }, '14:10:05')
    expect(s.toolCalls).toBe(1)

    // 第二次调用 executing → 2; 失败路径 error(带 toolName)不重复计
    s = applyActivityEvent(s, { type: 'tool_executing', toolName: 'fetch_doc' }, '14:10:06')
    expect(s.toolCalls).toBe(2)
    s = applyActivityEvent(s, { type: 'error', toolName: 'fetch_doc' }, '14:10:07')
    expect(s.toolCalls).toBe(2)

    // 计数不随日志 50 条裁剪回拨
    for (let i = 0; i < MONITOR_MAX_LOGS + 5; i++) {
      s = applyActivityEvent(s, { type: 'thinking', summary: `think-${i}` }, '14:11:00')
    }
    expect(s.toolCalls).toBe(2)
    expect(s.transactions).toBe(2)
  })

  test('tool_result 也计入工具去重计数', () => {
    let s = createInitialLogState()
    s = applyActivityEvent(s, { type: 'tool_result', toolName: 'write_doc' }, '14:02:00')
    expect(s.toolNames).toEqual(['write_doc'])
  })

  test('error 事件: 带 toolName → tool 失败, 否则任务出错', () => {
    let s = createInitialLogState()
    s = applyActivityEvent(s, { type: 'error', toolName: 'web_search' }, '14:03:00')
    expect(s.logs[0].type).toBe('tool')
    expect(s.logs[0].text).toContain('工具失败')
    s = applyActivityEvent(s, { type: 'error' }, '14:03:01')
    expect(s.logs[1].type).toBe('complete')
    expect(s.logs[1].text).toBe('任务出错')
  })

  test('日志窗口上限 MONITOR_MAX_LOGS, 滑动保留最新', () => {
    let s = createInitialLogState()
    const N = MONITOR_MAX_LOGS + 2
    for (let i = 0; i < N; i++) {
      s = applyActivityEvent(s, { type: 'thinking', summary: `think-${i}` }, '14:04:00')
    }
    expect(s.logs).toHaveLength(MONITOR_MAX_LOGS)
    expect(s.logs[0].text).toBe('think-2')
    expect(s.logs[s.logs.length - 1].text).toBe(`think-${N - 1}`)
    expect(s.nextId).toBe(N) // id 单调不回拨
  })

  test('tool_result → ok:true + desc 详情行(DingDong 对齐)', () => {
    let s = createInitialLogState()
    s = applyActivityEvent(s, { type: 'tool_result', toolName: 'web_search', detail: '找到 3 个结果' }, '14:07:00')
    expect(s.logs[0].type).toBe('tool')
    expect(s.logs[0].ok).toBe(true)
    expect(s.logs[0].desc).toBe('找到 3 个结果')
    // detail 缺失时 desc 回落 summary
    s = applyActivityEvent(s, { type: 'tool_result', toolName: 'read_file', summary: '已读取 file.txt' }, '14:07:01')
    expect(s.logs[1].desc).toBe('已读取 file.txt')
  })

  test('error 带 toolName → ok:false + 错误 desc', () => {
    let s = createInitialLogState()
    s = applyActivityEvent(s, { type: 'error', toolName: 'web_search', summary: '网络超时' }, '14:08:00')
    expect(s.logs[0].type).toBe('tool')
    expect(s.logs[0].ok).toBe(false)
    expect(s.logs[0].desc).toBe('网络超时')
  })

  test('高频/噪音事件(stream_chunk/tts_playing debug)不产生日志; tts_playing info 产生 system 日志', () => {
    const s0 = createInitialLogState()
    // stream_chunk 始终静默(token 级高频)
    const s1 = applyActivityEvent(s0, { type: 'stream_chunk' }, '14:05:00')
    expect(s1).toBe(s0)
    // tts_playing debug 级静默(逐句高频)
    const s2 = applyActivityEvent(s1, { type: 'tts_playing', level: 'debug' }, '14:05:00')
    expect(s2).toBe(s0)
    // 2026-08-14 P0-图例3: tts_playing 无 level(默认 info) → system 日志(带分级)
    const s3 = applyActivityEvent(s2, { type: 'tts_playing', summary: '正在播报回复' }, '14:05:01')
    expect(s3.logs).toHaveLength(1)
    expect(s3.logs[0].type).toBe('system')
    expect(s3.logs[0].level).toBe('info')
    expect(s3.logs[0].text).toContain('语音播放')
    // null 事件静默
    const s4 = applyActivityEvent(s3, null, '14:05:02')
    expect(s4).toBe(s3)
  })

  test('turn_complete → complete 日志; status=error → 任务失败', () => {
    const s0 = createInitialLogState()
    const s1 = applyTurnCompleteEvent(s0, { roundId: 'round-9', status: 'done' }, '14:06:00')
    expect(s1.logs).toHaveLength(1)
    expect(s1.logs[0].type).toBe('complete')
    expect(s1.logs[0].text).toContain('任务完成')
    expect(s1.logs[0].text).toContain('round-9')

    const s2 = applyTurnCompleteEvent(s1, { roundId: 'round-9', status: 'error' }, '14:06:01')
    expect(s2.logs[1].text).toContain('任务失败')
  })

  test('interrupt activity → 🛑 中断日志 (2026-08-15 T7 累积F)', () => {
    const s0 = createInitialLogState()
    const s1 = applyActivityEvent(s0, { type: 'interrupt', roundId: 'round-7', summary: '对话已中断' }, '14:06:30')
    expect(s1.logs).toHaveLength(1)
    expect(s1.logs[0].type).toBe('complete')
    expect(s1.logs[0].text).toContain('🛑')
    expect(s1.logs[0].text).toContain('round-7')
    expect(s1.logs[0].text).not.toContain('任务完成')
  })

  test('turn_complete status=interrupted → 不显示「任务完成」 (2026-08-15 T7 累积F)', () => {
    const s0 = createInitialLogState()
    const s1 = applyTurnCompleteEvent(s0, { roundId: 'round-8', status: 'interrupted' }, '14:07:00')
    expect(s1.logs).toHaveLength(1)
    expect(s1.logs[0].text).toContain('🛑')
    expect(s1.logs[0].text).toContain('中断')
    expect(s1.logs[0].text).not.toContain('任务完成')
    expect(s1.logs[0].text).not.toContain('任务失败')
  })

  test('runSnapshotToLastAction 状态映射', () => {
    expect(runSnapshotToLastAction(null)).toBeNull()
    expect(runSnapshotToLastAction(undefined)).toBeNull()
    expect(runSnapshotToLastAction({ status: 'finished' })).toBe('上次任务已完成')
    expect(runSnapshotToLastAction({ status: 'error' })).toBe('上次任务出错')
    expect(runSnapshotToLastAction({ status: 'interrupted' })).toBe('上次任务已中断')
    expect(runSnapshotToLastAction({ status: 'running', roundId: 'r9' })).toBe('运行中 · r9')
  })

  test('extractMemoryCount 从 notebook.totalMemories 提取', () => {
    expect(extractMemoryCount({ notebook: { totalMemories: 42 } })).toBe(42)
    expect(extractMemoryCount({ notebook: { totalMemories: 0 } })).toBe(0)
    expect(extractMemoryCount({ notebook: {} })).toBeNull()
    expect(extractMemoryCount({ totalMemories: 10 })).toBeNull() // 计数不在顶层
    expect(extractMemoryCount(null)).toBeNull()
    expect(extractMemoryCount(undefined)).toBeNull()
  })
})
