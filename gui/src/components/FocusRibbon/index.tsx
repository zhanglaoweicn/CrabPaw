/**
 * FocusRibbon — agent 注意带(B3 2026-09-05)
 *
 * 极简布局(data-layout='simple')下左右栏(AgentLeftPanel/AgentRightPanel)整体
 * display:none——用户除 orb 四态色外看不到 agent 在执行什么工具、是否在等拍板、
 * 花销如何。本组件以一行细带常驻对话卡顶栏, 补齐"执行层"可见性:
 *   waiting   等你处理 · N 项待审批(琥珀, 脉冲)
 *   acting    正在执行 <工具> · 第 N 步(全息青, 脉冲)
 *   speaking  正在回复(蓝)
 *   thinking  思考中(橙, 与 orb thinking 同色系)
 *   listening 在听(绿)
 *   idle      待命(灰, 最暗)
 * 数据全部来自既有通道(flow.toolEvents / approvalPendingCount), 经
 * deriveAgentFocus 纯函数推导, 零新增后端。视觉语言对齐 orb 四态配色,
 * 不新增噪点——idle 态整体降透明度, 与背景融为一体。
 */
import type { AgentFocusState } from '../../lib/voice-orb-state'
import './styles.css'

export interface FocusRibbonProps {
  state: AgentFocusState
  /** acting 态: 正在执行的工具名(flow.toolEvents 最后一个 running 项) */
  toolName?: string | null
  /** acting 态: 本轮已发生的工具事件数(含当前) */
  toolStep?: number
  /** waiting 态: 待审批数量 */
  pendingApprovals?: number
}

function buildLabel(state: AgentFocusState, toolName?: string | null, toolStep = 0, pendingApprovals = 0): string {
  switch (state) {
    case 'waiting':
      return pendingApprovals > 1 ? `等你处理 · ${pendingApprovals} 项待审批` : '等你处理 · 待审批'
    case 'acting': {
      const tool = toolName || '工具'
      return toolStep > 1 ? `正在执行 ${tool} · 第 ${toolStep} 步` : `正在执行 ${tool}`
    }
    case 'speaking':
      return '正在回复'
    case 'thinking':
      return '思考中'
    case 'listening':
      return '在听'
    case 'idle':
    default:
      return '待命'
  }
}

export function FocusRibbon({ state, toolName, toolStep = 0, pendingApprovals = 0 }: FocusRibbonProps) {
  return (
    <span className={`focus-ribbon focus-ribbon--${state}`} data-state={state} role="status" aria-live="polite">
      <span className="focus-ribbon-dot" aria-hidden />
      <span className="focus-ribbon-label">{buildLabel(state, toolName, toolStep, pendingApprovals)}</span>
    </span>
  )
}

export default FocusRibbon
