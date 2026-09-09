/**
 * useTurnState — 订阅 AG-UI RUN/STEP 生命周期, 暴露当前轮次状态
 * (2026-08-18 协议化轮; 数据源: turn-tracker 派生的 STEP_STARTED/FINISHED + RUN_*)
 *
 * 2026-08-19 三栏联动轮扩展:
 * - steps: 步骤历史数组(STEP_STARTED 开 / STEP_FINISHED 关, 前端按 startedAt 算耗时——
 *   后端 STEP_FINISHED 载荷无 duration 字段)
 * - toolCalls: TOOL_CALL_START 计入当前活跃步骤(步骤串行, 每 run 至多一个 running 步骤)
 * - RUN_ERROR 把 running 步骤标为 error 终态
 * 旧三字段(running/step/runId)语义保持不变, ToolRunSection 步骤 chip 无需改动。
 */
import { useEffect, useState } from 'react'
import { subscribeAgui, AGUI_EVENT } from '../lib/agui-events'

export interface TurnStepInfo {
  stepIndex: number
  status: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  /** STEP_FINISHED 时刻 - startedAt(毫秒) */
  durationMs?: number
  /** 本步骤内 TOOL_CALL_START 计数 */
  toolCalls: number
}

export interface TurnState {
  running: boolean
  step: number
  runId: string | null
  steps: TurnStepInfo[]
}

/** 把某步骤置为终态(幂等——finish 只生效一次) */
function finishStep(steps: TurnStepInfo[], stepIndex: number, status: 'done' | 'error', now: number): TurnStepInfo[] {
  const idx = steps.findIndex(s => s.stepIndex === stepIndex)
  if (idx < 0) return steps
  const s = steps[idx]
  if (s.status !== 'running') return steps
  const next = [...steps]
  next[idx] = {
    ...s,
    status,
    finishedAt: now,
    durationMs: Math.max(0, now - s.startedAt),
  }
  return next
}

/** 把全部 running 步骤置为终态(终态事件兜底, 防步骤悬挂 running) */
function finishAllRunning(steps: TurnStepInfo[], status: 'done' | 'error', now: number): TurnStepInfo[] {
  let changed = false
  const next = steps.map(s => {
    if (s.status !== 'running') return s
    changed = true
    return { ...s, status, finishedAt: now, durationMs: Math.max(0, now - s.startedAt) }
  })
  return changed ? next : steps
}

export function useTurnState(): TurnState {
  const [state, setState] = useState<TurnState>({ running: false, step: 0, runId: null, steps: [] })
  useEffect(() => {
    const unsubs = [
      subscribeAgui(AGUI_EVENT.RUN_STARTED, (f) => {
        const now = Date.now()
        const runId = f.runId ?? null
        const first: TurnStepInfo = {
          stepIndex: 1,
          status: 'running',
          startedAt: now,
          toolCalls: 0,
        }
        setState({ running: true, step: 1, runId, steps: [first] })
      }),
      subscribeAgui(AGUI_EVENT.STEP_STARTED, (f) => {
        // typeof 守卫收窄局部 const(索引签名访问的收窄不进内层闭包, 故先落局部变量)
        const stepIndex = f.stepIndex
        if (typeof stepIndex !== 'number') return
        const now = Date.now()
        setState(s => {
          // 已存在(重发/跨 run 复用)则不重复开
          if (s.steps.some(st => st.stepIndex === stepIndex)) return s
          const next: TurnStepInfo = { stepIndex, status: 'running', startedAt: now, toolCalls: 0 }
          return { ...s, running: true, step: stepIndex, steps: [...s.steps, next] }
        })
      }),
      subscribeAgui(AGUI_EVENT.STEP_FINISHED, (f) => {
        const stepIndex = f.stepIndex
        if (typeof stepIndex !== 'number') return
        const now = Date.now()
        setState(s => {
          const steps = finishStep(s.steps, stepIndex, 'done', now)
          return steps === s.steps ? s : { ...s, steps }
        })
      }),
      // TOOL_CALL_START 计入当前活跃(running)步骤——步骤串行, 取"最后一条" running
      // (RUN_STARTED 预建的步骤 1 在 STEP_STARTED 覆盖前可能仍 running, findIndex 会错归旧步骤)
      subscribeAgui(AGUI_EVENT.TOOL_CALL_START, () => {
        setState(s => {
          if (!s.running) return s
          let idx = -1
          for (let i = s.steps.length - 1; i >= 0; i--) {
            if (s.steps[i].status === 'running') { idx = i; break }
          }
          if (idx < 0) return s
          const next = [...s.steps]
          next[idx] = { ...next[idx], toolCalls: next[idx].toolCalls + 1 }
          return { ...s, steps: next }
        })
      }),
      subscribeAgui(AGUI_EVENT.RUN_FINISHED, () => {
        const now = Date.now()
        setState(s => {
          const steps = finishAllRunning(s.steps, 'done', now)
          return { ...s, running: false, steps }
        })
      }),
      subscribeAgui(AGUI_EVENT.RUN_ERROR, () => {
        const now = Date.now()
        setState(s => {
          const steps = finishAllRunning(s.steps, 'error', now)
          return { ...s, running: false, steps }
        })
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [])
  return state
}
