/**
 * holo-phase — P7 Task 4 阶段 TTS 阈值播报
 *
 * 后端 phase 事件携带 progress（5 阶段映射: plan=20/research=40/execute=60/review=80/deliver=99），
 * 前端在 30/60/90 三个阈值各播报一次（每阈值只播一次，保证不重复）。
 */

/** 按 progress 返回下一个未消费的阈值（30/60/90）；若无则返回 null */
export function nextPhaseThreshold(progress: number, done: Set<number>): number | null {
  for (const t of [30, 60, 90]) {
    if (progress >= t && !done.has(t)) return t
  }
  return null
}

/**
 * phase → 场景映射，用于 phaseText 选择专属文案
 * research/execute/deliver 属于数据分析类场景，返回 'data'
 * plan/review 及其他 phase 无专属文案，返回 undefined 走中性文案
 */
export function sceneFromPhase(phase: string): string | undefined {
  const DATA_PHASES: Record<string, string> = {
    research: 'data',
    execute: 'data',
    deliver: 'data',
  }
  return DATA_PHASES[phase]
}

/** 阈值 → 中文播报文案；scene 可选，无场景时用中性文案 */
export function phaseText(threshold: number, scene?: string): string {
  // 数据类场景：更具体的分析口吻
  const isDataScene = scene === 'data' || scene === 'analytics' || scene === 'dashboard'

  switch (threshold) {
    case 30:
      return isDataScene ? '正在识别数据维度...' : '进度 30%，正在分析中...'
    case 60:
      return isDataScene ? '发现季节性波动，继续深挖...' : '进度 60%，已有初步发现...'
    case 90:
      return isDataScene ? '即将完成，正在汇总关键结论...' : '进度 90%，即将完成...'
    default:
      return `进度 ${threshold}%`
  }
}
