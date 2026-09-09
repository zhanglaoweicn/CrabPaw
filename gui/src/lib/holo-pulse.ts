/**
 * holo-pulse — TTS 段脉冲辅助（P7 Task9）
 *
 * 纯函数：根据段索引和 KPI 数量轮换高亮目标
 * - 0 段 → KPI 0
 * - 段数 > KPI 数 → 取模轮换
 * - kpiCount=0 → 兜底返回 0（无 KPI 不报错）
 */

/** TTS 段脉冲信号（由 useVoiceReply 写入 window.__ttsSegmentPulse） */
export interface TtsSegmentPulse {
  segmentIndex: number
  active: boolean
}

/**
 * 计算当前脉冲应高亮哪个 KPI（取模轮换）
 * @param segmentIndex 当前段索引（0-based）
 * @param kpiCount 页面上的 KPI 数量
 * @returns 应高亮的 KPI 索引（0-based），kpiCount<=0 时兜底返回 0
 */
export function pulseTarget(segmentIndex: number, kpiCount: number): number {
  if (kpiCount <= 0) return 0
  // M3: Math.abs 防御负 index——JS 负 % 正返回负余数，取绝对值保证 0..kpiCount-1
  return Math.abs(segmentIndex) % kpiCount
}
