import { useEffect, useRef, useState } from 'react'
import { useSse } from './useSSE'
import { apiGet } from '../lib/api'

/** 左栏消息日志条目（与 AgentLeftPanel LogEntry 形状对齐） */
export interface MonitorLog {
  id: string
  time: string
  type: 'user' | 'thinking' | 'tool' | 'complete' | 'system'
  text: string
  /** 2026-08-14(DingDong SystemEvent.desc 对齐): 详情行(工具结果/错误文案, 最多 3 行截断) */
  desc?: string
  /** 2026-08-14(DingDong tool_ok/tool_fail 分离对齐): 工具成败标志——true=成功绿徽标, false=失败红徽标 */
  ok?: boolean
  /** 2026-08-14 P0-图例3: 系统日志分级(后端 activity-stream.js LEVEL) */
  level?: 'info' | 'warn' | 'error' | 'debug'
  /** 2026-08-19 三栏联动轮: SSE 帧 seq(回放条定位键——该条目对应的可重放帧序号) */
  seq?: number
}

/**
 * /events SSE `activity` 事件负载（src/core/activity-stream.js _broadcastSSE 白名单字段）。
 * 服务端 TYPE 实际值:
 *   message_received / thinking / tool_ack / tool_preparing / tool_executing /
 *   tool_result / stream_chunk / response / turn_complete / tts_playing / system / error / interrupt
 */
export interface MonitorActivityEvent {
  type?: string
  toolName?: string
  summary?: string
  detail?: string
  roundId?: string
  status?: string
  level?: string
}

/** SSE `turn_complete` 独立事件负载（非 activity 事件名） */
export interface MonitorTurnCompleteEvent {
  roundId?: string
  status?: string
}

/**
 * SSE `heartbeat` 独立事件负载（2026-08-14: src/core/activity-stream.js
 * broadcastHeartbeat 每 15s 广播——真实活动感知的意识心跳, 驱动右栏 ECG）
 */
export interface MonitorHeartbeatEvent {
  /** 最近 30s 内是否有活动事件(对话/工具/思考/TTS) */
  active?: boolean
  timestamp?: number
}

/** /api/runs/active 返回的 run 终态快照（src/core/run-store.js） */
export interface MonitorRunSnapshot {
  roundId?: string
  status?: string
  ts?: number
}

/** 日志归约状态（纯函数输入/输出，便于单测） */
export interface MonitorLogState {
  logs: MonitorLog[]
  toolNames: string[]
  nextId: number
  /**
   * 2026-08-19 数值验证轮: 事务计数 = message_received 帧数(一次用户消息 = 一次事务)。
   * 此前 UI「事务」误接 flow.toolEvents.length(当前轮工具事件, sendText 每轮清空归零)。
   */
  transactions: number
  /**
   * 2026-08-19 数值验证轮: 工具调用次数 = tool_executing 帧数。
   * 发射源唯一(ai.js onToolStart 每调用恰一条; orchestrator 无生产调用点;
   * ack/preparing/result 不重复计)。此前 UI「工具」误用 toolNames.length(去重种类数)。
   */
  toolCalls: number
}

// 2026-08-14(DingDong System Event Log 80 条对齐): 6 → 50——此前只保留 6 条,
// 长对话事件时间线大量丢失;50 条环形裁剪(与右栏无关联, 上限安全)
export const MONITOR_MAX_LOGS = 50

export function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function createInitialLogState(): MonitorLogState {
  return { logs: [], toolNames: [], nextId: 0, transactions: 0, toolCalls: 0 }
}

/**
 * 归约单条 SSE activity 事件 → 新日志状态（纯函数）。
 * 映射: message_received→user, thinking→thinking, tool_ack/tool_preparing/tool_executing
 *       →tool(工具名去重), tool_result→tool, response→complete, error→tool 失败/任务出错。
 * stream_chunk/tts_playing/system 等高频或噪音事件不产生日志（返回原 state）。
 */
export function applyActivityEvent(
  state: MonitorLogState,
  evt: MonitorActivityEvent | null | undefined,
  time: string,
  /** 2026-08-19 三栏联动轮: SSE 帧 seq(可选——回放定位键, 缺省不写入) */
  seq?: number,
): MonitorLogState {
  const type = evt?.type
  let entry: MonitorLog | null = null
  let toolName = ''

  switch (type) {
    case 'message_received':
      entry = { id: '', time, type: 'user', text: evt?.summary || '用户消息已接收' }
      break
    case 'thinking':
      entry = { id: '', time, type: 'thinking', text: evt?.summary || '思考中…' }
      break
    case 'tool_ack':
    case 'tool_preparing':
    case 'tool_executing':
      toolName = evt?.toolName || ''
      entry = { id: '', time, type: 'tool', text: `工具调用 · ${toolName}` }
      break
    case 'tool_result':
      toolName = evt?.toolName || ''
      // 2026-08-14(DingDong desc 对齐): 详情行取后端 detail(结果正文, activity-stream
      // recordToolEvent result phase 传入)或 summary 兜底;ok 标志驱动"成功"徽标
      entry = {
        id: '', time, type: 'tool', text: `工具完成 · ${toolName}`,
        ok: true,
        desc: evt?.detail || evt?.summary || undefined,
      }
      break
    case 'response':
      entry = { id: '', time, type: 'complete', text: `回复完成 · ${evt?.roundId || ''}` }
      break
    case 'interrupt':
      // 2026-08-15 T7(累积F): 后端 TYPE.INTERRUPT(用户中断/连接断开, 🛑 语义)——此前
      // default 分支静默丢弃。与 error 同呈现(终态条目, 不标 ok)。
      entry = {
        id: '', time, type: 'complete',
        text: `🛑 对话已中断 · ${evt?.roundId || ''}`,
        desc: evt?.summary || evt?.detail || undefined,
      }
      break
    case 'error':
      if (evt?.toolName) {
        toolName = evt.toolName
        entry = {
          id: '', time, type: 'tool', text: `工具失败 · ${toolName}`,
          ok: false,
          desc: evt?.detail || evt?.summary || undefined,
        }
      } else {
        entry = { id: '', time, type: 'complete', text: '任务出错' }
      }
      break
    case 'system':
    case 'tts_playing':
    case 'stream_chunk': {
      // P0-图例3：system / tts / stream_chunk 归入系统日志(带分级),不再 default 静默丢弃
      const evtLevel = (evt?.level as MonitorLog['level']) || 'info'
      // stream_chunk / tts_playing 是 DEBUG 级高频事件,不进日志,避免刷屏
      if (type === 'stream_chunk' || (type === 'tts_playing' && evtLevel === 'debug')) return state
      const prefixMap: Record<string, string> = {
        system: '系统',
        tts_playing: '语音播放',
      }
      entry = {
        id: '',
        time,
        type: 'system',
        level: evtLevel,
        text: `${prefixMap[type] || '事件'} · ${evt?.summary || type}`,
        desc: evt?.detail || undefined,
      }
      break
    }
    case 'turn_complete':
      return state // turn_complete 走独立 applyTurnCompleteEvent 分支
      // 2026-08-15: 删除上方重复的 case 'tool_ack'(已在前文 tool 分组处理, 不可达分支)
    default:
      // 未知类型但带 error level=error → 仍记一条系统错误(不静默丢)
      if (evt?.level === 'error' || evt?.level === 'warn') {
        entry = {
          id: '',
          time,
          type: 'system',
          level: evt.level as MonitorLog['level'],
          text: `${evt?.summary || type}`,
          desc: evt?.detail || undefined,
        }
      } else {
        return state
      }
  }

  entry.id = String(state.nextId)
  // 2026-08-19 三栏联动轮: seq 透传(回放条按 seq 定位时间线条目)
  if (seq != null && typeof seq === 'number') entry.seq = seq
  const next: MonitorLogState = {
    ...state,
    nextId: state.nextId + 1,
    logs: [...state.logs, entry].slice(-MONITOR_MAX_LOGS),
    toolNames: toolName && !state.toolNames.includes(toolName)
      ? [...state.toolNames, toolName]
      : state.toolNames,
    // 2026-08-19 数值验证轮: 计数归约(纯函数, 可单测)——仅特定帧计, 不随日志裁剪回拨
    transactions: state.transactions + (type === 'message_received' ? 1 : 0),
    toolCalls: state.toolCalls + (type === 'tool_executing' ? 1 : 0),
  }
  return next
}

/**
 * 归约 turn_complete SSE 事件（独立事件名，非 activity 负载）。
 * status: done / error（src/core/activity-stream.js _resolveRound）。
 */
export function applyTurnCompleteEvent(
  state: MonitorLogState,
  evt: MonitorTurnCompleteEvent | null | undefined,
  time: string,
): MonitorLogState {
  // 2026-08-15 T7(累积F): _resolveRound 终态含 'interrupted'(P2-9)——此前恒显示
  // 「任务完成」。中断终态显示 🛑 文案, 不显示「任务完成」。
  const interrupted = evt?.status === 'interrupted'
  const failed = evt?.status === 'error'
  const text = interrupted
    ? `🛑 对话已中断 · ${evt?.roundId || ''}`
    : `${failed ? '任务失败' : '任务完成'} · ${evt?.roundId || ''}`
  const entry: MonitorLog = {
    id: String(state.nextId),
    time,
    type: 'complete',
    text,
  }
  return {
    ...state,
    nextId: state.nextId + 1,
    logs: [...state.logs, entry].slice(-MONITOR_MAX_LOGS),
  }
}

/** run 快照 → lastAction 文案（null 表示不更新） */
export function runSnapshotToLastAction(run: MonitorRunSnapshot | null | undefined): string | null {
  if (!run) return null
  switch (run.status) {
    case 'finished': return '上次任务已完成'
    case 'error': return '上次任务出错'
    case 'interrupted': return '上次任务已中断'
    default: return run.roundId ? `运行中 · ${run.roundId}` : '运行中'
  }
}

/** /api/memory/stats 响应 → 记忆总数（stats 顶层展开，计数在 notebook.totalMemories） */
export function extractMemoryCount(stats: unknown): number | null {
  const count = (stats as { notebook?: { totalMemories?: unknown } } | null | undefined)?.notebook?.totalMemories
  return typeof count === 'number' && Number.isFinite(count) ? count : null
}

/** /api/memory/stats 响应 → 知识条目数（2026-08-14: notebook.enhancedFactCount 优先,
 * 降级 enhancedEntityCount——左栏 Knowledge 指标真实数据源,替代硬编码 0) */
export function extractKnowledgeCount(stats: unknown): number | null {
  const nb = (stats as { notebook?: { enhancedFactCount?: unknown; enhancedEntityCount?: unknown } } | null | undefined)?.notebook
  const fact = nb?.enhancedFactCount
  if (typeof fact === 'number' && Number.isFinite(fact)) return fact
  const entity = nb?.enhancedEntityCount
  return typeof entity === 'number' && Number.isFinite(entity) ? entity : null
}

/** /api/memory/stats 响应 → 记忆衰减数（2026-08-15: 顶层 decayedCount,
 * 来自记忆衰减引擎 MemoryDecayEngine._decayStats.totalDecayed——
 * 左栏 Decayed 指标真实数据源,替代硬编码 '—') */
export function extractDecayedCount(stats: unknown): number | null {
  const count = (stats as { decayedCount?: unknown } | null | undefined)?.decayedCount
  return typeof count === 'number' && Number.isFinite(count) ? count : null
}

/**
 * 2026-08-13 G7 审计修复: 左右栏真实数据源——
 * - SSE `activity`(tool 系列/thinking/response/message_received/error) + `turn_complete` → 消息日志
 * - GET /api/memory/stats → memory 计数（30s 轮询）
 * - GET /api/runs/active?userId=voice_shell_user → 最近运行状态（15s 轮询）
 */
export function useAgentMonitor() {
  const [logState, setLogState] = useState<MonitorLogState>(createInitialLogState)
  const [memoryCount, setMemoryCount] = useState(0)
  // 2026-08-14: Knowledge 指标——与 memoryCount 同源轮询(notebook.enhancedFactCount)
  const [knowledgeCount, setKnowledgeCount] = useState<number | null>(null)
  // 2026-08-15: Decayed 指标——同源轮询(顶层 decayedCount, 记忆衰减引擎累计)
  const [decayedCount, setDecayedCount] = useState<number | null>(null)
  const [lastAction, setLastAction] = useState<string>('—')
  // 2026-08-14 意识心跳: 事件计数(null=尚未收到事件 → 前端显 '—')+ 最近活跃标志。
  // 数据源: /events SSE heartbeat 事件(后端 15s 广播, 活动感知)
  const [heartBeatCount, setHeartBeatCount] = useState<number | null>(null)
  const [heartBeatActive, setHeartBeatActive] = useState(false)
  // 2026-08-14 G5 R-1: 连接态真实接线——此前 useState(true) 硬编码,断线也恒显"已连接"。
  // 用 /events SSE 连接态(useSse onStatus)作为后端连通性代理: open→true, error(重连中)/giveup→false。
  const [wsConnected, setWsConnected] = useState(false)
  // 2026-08-15 合规: activity.id 去重集合(后端 _broadcastSSE 已补 id 白名单)
  const seenActivityIdsRef = useRef<Set<string>>(new Set())

  useSse({
    path: '/events',
    handlers: {
      activity: (data: MonitorActivityEvent, seq?: number) => {
        const time = nowTime()
        // 2026-08-15 合规: 按 activity.id 去重(后端广播已补 id)——重连补发/重复
        // 帧不再产生重复日志条目; 有界 Set 防内存无界(500 条环)
        const evtId = (data as { id?: unknown })?.id
        if (typeof evtId === 'string' && evtId) {
          if (seenActivityIdsRef.current.has(evtId)) return
          seenActivityIdsRef.current.add(evtId)
          if (seenActivityIdsRef.current.size > 500) {
            const oldest = seenActivityIdsRef.current.values().next().value
            if (oldest) seenActivityIdsRef.current.delete(oldest)
          }
        }
        setLogState(prev => applyActivityEvent(prev, data, time, seq))
      },
      turn_complete: (data: MonitorTurnCompleteEvent) => {
        const time = nowTime()
        setLogState(prev => applyTurnCompleteEvent(prev, data, time))
      },
      // 2026-08-14 意识心跳: 计数累计 + 活跃标志(驱动右栏 ECG 波形)
      heartbeat: (data: MonitorHeartbeatEvent) => {
        setHeartBeatCount(prev => (prev ?? 0) + 1)
        setHeartBeatActive(data?.active === true)
      },
    },
    onStatus: (status) => {
      if (status === 'open') setWsConnected(true)
      else setWsConnected(false)
    },
  })

  // 2026-08-15: 启动历史回填——页面重载后 /events 无快照重放, 内存日志归零
  // ("消息日志没数据"根因)。挂载时从 /panels/activity 拉最近 50 条活动按序重建,
  // 时间取活动 timestamp; id 入去重集合防与 SSE 补发重复。
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const res = await apiGet<{ activities?: MonitorActivityEvent[] }>('/panels/activity?limit=50')
        if (stopped) return
        const acts = res?.data?.activities
        if (!Array.isArray(acts) || acts.length === 0) return
        setLogState(prev => {
          let next = prev
          for (const a of acts) {
            const evtId = (a as { id?: unknown })?.id
            if (typeof evtId === 'string' && evtId) {
              if (seenActivityIdsRef.current.has(evtId)) continue
              seenActivityIdsRef.current.add(evtId)
            }
            const ts = (a as { timestamp?: unknown })?.timestamp
            const t = new Date(typeof ts === 'number' ? ts : Date.now())
            const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
            next = applyActivityEvent(next, a, time)
          }
          return next
        })
      } catch (e) {
        console.warn('[agent-monitor] 活动历史回填失败:', (e as Error)?.message || e)
      }
    }
    load()
    return () => { stopped = true }
  }, [])

  // memory stats 轮询（30s）——memory 计数 + knowledge 计数同源提取
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const res = await apiGet('/api/memory/stats')
        if (stopped) return
        const count = extractMemoryCount(res?.data)
        if (count !== null) setMemoryCount(count)
        const knowledge = extractKnowledgeCount(res?.data)
        if (knowledge !== null) setKnowledgeCount(knowledge)
        const decayed = extractDecayedCount(res?.data)
        if (decayed !== null) setDecayedCount(decayed)
      } catch (e) {
        console.warn('[agent-monitor] memory stats 拉取失败:', (e as Error)?.message || e)
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 30000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  // runs/active 拉取 lastAction（15s）
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const res = await apiGet<{ run?: MonitorRunSnapshot | null }>('/api/runs/active?userId=voice_shell_user')
        if (stopped) return
        const label = runSnapshotToLastAction(res?.data?.run)
        if (label) setLastAction(label)
      } catch (e) {
        console.warn('[agent-monitor] runs/active 拉取失败:', (e as Error)?.message || e)
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 15000)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  return {
    logs: logState.logs,
    // 2026-08-19 数值验证轮: 工具调用次数(executing 帧)替代 toolCount(去重种类数)
    toolCalls: logState.toolCalls,
    transactions: logState.transactions,
    memoryCount,
    knowledgeCount,
    decayedCount,
    lastAction,
    wsConnected,
    // 2026-08-14 意识心跳: count 可为 null(未收到事件 → 前端 '—'), active 驱动 ECG
    heartBeatCount,
    heartBeatActive,
  }
}
