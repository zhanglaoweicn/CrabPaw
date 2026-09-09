/**
 * 协作轨道聚合（P4）— /events 的 subagent:start/end 事件 → 轨道卫星卡状态。
 * 纯 reducer，可 jest。事件形状见 subagent-tools.js（真实广播）。
 */
export interface OrbitAgent {
  id: string
  archetype: string
  task: string
  status: 'running' | 'done' | 'error'
  success?: boolean
  duration?: number
  startTs: number
  endTs?: number
}

export interface OrbitState { agents: OrbitAgent[] }

export type OrbitAction =
  | { type: 'subagent:start'; archetype: string; task: string; ts: number }
  | { type: 'subagent:end'; archetype: string; success: boolean; duration: number; ts: number }
  /** 协作整场终态(2026-09-05): collab:completed/error 时强收全部滞留成员卡——
   *  此前只 end orchestrator, 成员卡(researcher)永远停在 running, 收球条件永不满足 */
  | { type: 'finishAll'; success: boolean; ts: number }

// M1 (P4 残留): idSeq 模块级可变 — reducer 技术不纯, 但单进程 UI 无并发, v1 接受 (台账记录)
let idSeq = 0

export function orbitReducer(state: OrbitState, action: OrbitAction): OrbitState {
  switch (action.type) {
    case 'subagent:start': {
      const agent: OrbitAgent = {
        id: `orb_${action.ts}_${idSeq++}`,
        archetype: action.archetype,
        task: action.task || '',
        status: 'running',
        startTs: action.ts,
      }
      return { agents: [...state.agents, agent] }
    }
    case 'subagent:end': {
      // 按最近启动的 running 同 archetype 匹配（反向查找，LIFO）
      let idx = -1
      for (let i = state.agents.length - 1; i >= 0; i--) {
        if (state.agents[i].archetype === action.archetype && state.agents[i].status === 'running') {
          idx = i
          break
        }
      }
      if (idx === -1) return state // end 无对应 start → 忽略
      const agents = state.agents.slice()
      agents[idx] = {
        ...agents[idx],
        status: action.success ? 'done' : 'error',
        success: action.success,
        duration: action.duration,
        endTs: action.ts,
      }
      return { agents }
    }
    case 'finishAll': {
      if (!state.agents.some(a => a.status === 'running')) return state
      const agents = state.agents.slice()
      for (let i = 0; i < agents.length; i++) {
        if (agents[i].status === 'running') {
          agents[i] = { ...agents[i], status: action.success ? 'done' : 'error', success: action.success, duration: 0, endTs: action.ts }
        }
      }
      return { agents }
    }
    default:
      return state
  }
}

export function selectActiveCount(state: OrbitState): number {
  return state.agents.filter(a => a.status === 'running').length
}

/* ─── 成员卡布局(2026-09-05): 跟随语音球浮卡 ───
   球卡可拖动且 offset 按 cardKey 持久化——成员卡写死坐标必然与它相撞。
   布局纯函数: 量球卡实时矩形 → 停在球正下方居中; 球下空间不足时改球上方;
   球卡不在(DOM 未挂载)时回退左栏固定槽。 */

export const ORB_FLOAT_DOM_ID = 'voice-orb-float'

export interface OrbitRectLike { left: number; top: number; width: number; height: number; bottom: number }
export interface OrbitLayout {
  left: number
  top?: number
  bottom?: number
  transform: string
  maxHeight: number
  /** true=从上往下堆(球下方), false=从下往上堆(球上方/回退槽) */
  columnDown: boolean
}

export function computeOrbitLayout(
  orb: OrbitRectLike | null,
  innerHeight: number,
  cardCount: number,
): OrbitLayout {
  const fallbackMax = Math.round(innerHeight * 0.42)
  if (!orb || orb.width <= 0) {
    return { left: 24, bottom: 340, transform: 'none', maxHeight: fallbackMax, columnDown: false }
  }
  const centerX = orb.left + orb.width / 2
  const belowTop = orb.bottom + 12
  const roomBelow = innerHeight - belowTop - 24
  // 卡堆高度估算: 每成员卡约 64px + 评审卡/汇总余量, 封顶 40vh
  const est = Math.min(Math.max(cardCount * 64 + 80, 160), Math.round(innerHeight * 0.4))
  if (roomBelow >= Math.min(est, 220)) {
    return { left: centerX, top: belowTop, transform: 'translateX(-50%)', maxHeight: Math.max(160, roomBelow), columnDown: true }
  }
  return {
    left: centerX,
    top: orb.top - 12,
    transform: 'translate(-50%, -100%)',
    maxHeight: Math.max(160, Math.min(est, orb.top - 36)),
    columnDown: false,
  }
}

export function orbitStartTs(state: OrbitState): number | null {
  if (state.agents.length === 0) return null
  return Math.min(...state.agents.map(a => a.startTs))
}

/** 评审投票卡数据（kind expert_review）— 全部完成才可合成 */
export interface ExpertReviewData {
  agents: { id?: string; name: string; status: string; duration?: number }[]
  conclusion: string
  ts: number
}

export function toReviewData(state: OrbitState, conclusion = ''): ExpertReviewData | null {
  if (state.agents.length === 0 || state.agents.some(a => a.status === 'running')) return null
  return {
    agents: state.agents.map(a => ({
      id: a.id,                // 唯一键（同名 archetype 并行时 key={a.name} 会冲突）
      name: a.archetype,          // 前端渲染时经 resolvePersona 映射为中文名
      status: a.status,
      duration: a.duration,
    })),
    conclusion,
    ts: Math.max(...state.agents.map(a => a.endTs || a.startTs)),
  }
}
