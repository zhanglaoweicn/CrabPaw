/**
 * log-summary.ts — 日志时间线的回合分组与语义化摘要（2026-09-03 方案A改版）
 *
 * 消费方: AgentLeftPanel(事件日志时间线) + SysInfoCard(日志悬浮卡)。
 * 解决三类排版噪音: ①内部 roundId 暴露 ②工具 调用/完成 两行一对 ③
 * "模型开始推理"等仪式性条目刷屏。折叠摘要与展开步骤清单共用本推导。
 */

export interface LogEntryLike {
  id: string
  type: string
  text: string
  time: string
  desc?: string
  ok?: boolean
  level?: string
  seq?: number
}

/** 内部 ID/仪式性文案清理——round-xxx 等内部标识不该出现在用户视野 */
export function cleanLogText(text: string): string {
  return text
    .replace(/round-[\w-]+/g, '')
    .replace('任务完成', '回答完成')
    .replace(/·\s*·/g, '·')
    .replace(/·\s*$/, '')
    .trim()
}

export interface RoundGroup {
  user?: LogEntryLike
  systems: LogEntryLike[]
  /** 第 N 个 user 开头的组(与对话流轮次一一对应); 无 user 开头的组无 round */
  round?: number
}

/** 轮次分组: 每个 user 条目开一轮, 其后条目入该轮; 无 user 开头的条目自成一组 */
export function groupLogsByRound(logs: LogEntryLike[]): RoundGroup[] {
  const groups: RoundGroup[] = []
  let cur: RoundGroup | null = null
  let roundCount = 0
  for (const l of logs) {
    if (l.type === 'user') {
      roundCount += 1
      cur = { user: l, systems: [], round: roundCount }
      groups.push(cur)
    } else if (cur) {
      cur.systems.push(l)
    } else {
      cur = { systems: [l] }
      groups.push(cur)
    }
  }
  return groups
}

export interface GroupStep {
  kind: 'tool' | 'complete' | 'system'
  name: string
  ok: boolean | null
  time: string
  entry: LogEntryLike
  done: boolean
}

export interface GroupSummary {
  steps: GroupStep[]
  thinkCount: number
  answered: boolean
  failCount: number
  durationText: string
}

/**
 * 回合摘要推导: 把一轮的 system 条目合并成步骤清单——
 * 工具"调用/完成/失败"多行合并为单步骤(状态迁移), 推理条目只计数,
 * complete 条目标记已回答。折叠摘要与展开步骤清单共用本推导。
 */
export function summarizeGroup(g: { user?: LogEntryLike; systems: LogEntryLike[] }): GroupSummary {
  const steps: GroupStep[] = []
  const toolIdx = new Map<string, number>()
  let thinkCount = 0
  let answered = false
  for (const s of g.systems) {
    if (s.type === 'thinking') { thinkCount++; continue }
    if (s.type === 'tool') {
      const m = s.text.match(/^(工具调用|工具完成|工具失败) · (.+)$/)
      const name = m ? m[2].trim() : s.text
      const phase = m ? m[1] : ''
      if (phase === '工具调用') {
        if (!toolIdx.has(name)) {
          steps.push({ kind: 'tool', name, ok: null, time: s.time, entry: s, done: false })
          toolIdx.set(name, steps.length - 1)
        }
        continue
      }
      const ok = phase === '工具失败' ? false : (s.ok ?? true)
      const idx = toolIdx.get(name)
      if (idx == null) {
        steps.push({ kind: 'tool', name, ok, time: s.time, entry: { ...s, text: name }, done: true })
        toolIdx.set(name, steps.length - 1)
      } else {
        const st = steps[idx]
        st.ok = ok
        st.time = s.time
        st.done = true
        if (s.desc && !st.entry.desc) st.entry = { ...st.entry, desc: s.desc }
      }
      continue
    }
    if (s.type === 'complete') {
      answered = true
      steps.push({
        kind: 'complete', name: cleanLogText(s.text) || '回答完成',
        ok: null, time: s.time, entry: { ...s, text: cleanLogText(s.text) }, done: true,
      })
      continue
    }
    steps.push({ kind: 'system', name: cleanLogText(s.text), ok: null, time: s.time, entry: s, done: true })
  }
  const failCount = steps.filter(s => s.kind === 'tool' && s.ok === false).length
  // 耗时: user(或首条)时间 → 末条时间, "HH:MM:SS" 差值
  const firstT = g.user?.time || g.systems[0]?.time
  const lastT = g.systems[g.systems.length - 1]?.time
  let durationText = ''
  if (firstT && lastT && g.systems.length > 0) {
    const p = (t: string) => { const [h, m, s] = t.split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60 + (s || 0) }
    const diff = p(lastT) - p(firstT)
    if (Number.isFinite(diff) && diff >= 1) durationText = diff >= 60 ? `${Math.floor(diff / 60)}m${diff % 60}s` : `${diff}s`
  }
  return { steps, thinkCount, answered, failCount, durationText }
}

/** 折叠摘要行的状态图标/颜色/文案 */
export function groupStatusIcon(sum: GroupSummary): { icon: string; color: string; text: string } {
  const parts: string[] = []
  const toolCount = sum.steps.filter(s => s.kind === 'tool').length
  if (toolCount > 0) parts.push(`${toolCount} 个工具`)
  if (sum.thinkCount > 0) parts.push(`${sum.thinkCount} 轮推理`)
  if (sum.durationText) parts.push(sum.durationText)
  if (sum.answered) {
    const tail = sum.failCount > 0 ? ` · ${sum.failCount} 个工具出错` : ' · 已回答'
    return {
      icon: sum.failCount > 0 ? '◆' : '✓',
      color: sum.failCount > 0 ? 'rgba(251, 191, 36, 0.9)' : 'rgba(134, 239, 172, 0.85)',
      text: (parts.length ? parts.join(' · ') + tail : tail.replace(' · ', '')),
    }
  }
  if (sum.failCount > 0) {
    return { icon: '✗', color: 'rgba(252, 165, 165, 0.9)', text: (parts.join(' · ') || '执行中断') + ' · 已停止' }
  }
  return {
    icon: '●',
    color: 'rgba(103, 232, 249, 0.95)',
    text: parts.length ? parts.join(' · ') + ' · 执行中' : '执行中…',
  }
}
