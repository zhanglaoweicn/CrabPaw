/**
 * CollabOrbit — 协作轨道图（P4）
 * 语音球 = 主 Agent；子 Agent 卫星卡沿轨道展开（人设图标/名称/独立进度），完成一颗亮一颗。
 * 数据源：/events 广播 subagent:start/end（useSse 先例同 TaskPanelHost）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSse } from '../../hooks/useSSE'
import { useSpeechQueue } from '../../hooks/useSpeechQueue'
import { orbitReducer, toReviewData, computeOrbitLayout, ORB_FLOAT_DOM_ID, type ExpertReviewData, type OrbitAgent, type OrbitState } from '../../lib/collab-orbit'
import { isTerminalCollabStatus } from './collab-terminal'
import { resolvePersona } from '../../lib/expert-persona'
import { ExpertReviewCard } from '../SceneShell/kinds/expert-review'

const CARD_W = 150
const GAP = 10

// 本地 keyframes：定义随组件挂载注入（此前依赖 VoiceShell/styles.css 的 shell-dot-breathe，跨文件耦合）
const COLLAB_DOT_BREATHE_CSS = `
@keyframes collab-dot-breathe {
  0%, 100% { opacity: 0.55; transform: scale(0.9); }
  50% { opacity: 1; transform: scale(1.1); }
}`

function StatusDot({ agent }: { agent: OrbitAgent }) {
  const color = agent.status === 'done' ? '#4caf50' : agent.status === 'error' ? '#f44336' : '#f97316'
  return (
    <span style={{
      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
      background: color,
      boxShadow: `0 0 10px ${color}`,
      animation: agent.status === 'running' ? 'collab-dot-breathe 2s ease-in-out infinite' : undefined,
    }} />
  )
}

/** 结束指定成员卡(按记名 archetype 精确匹配, LIFO)——无对应卡时静默忽略 */
function endMember(s: OrbitState, member: string, success: boolean): OrbitState {
  return orbitReducer(s, { type: 'subagent:end', archetype: `member:${member}`, success, duration: 0, ts: Date.now() })
}

export function CollabOrbit({ speechQueue }: {
  /** P5.5: 共享播报队列（VoiceShell 层实例，含 canSpeak 守卫），避免双队列双音（必传，tree 内唯一调用方已注入） */
  speechQueue: ReturnType<typeof useSpeechQueue>
}) {
  const [state, setState] = useState<OrbitState>({ agents: [] })
  // 2026-09-05: 成员卡跟随语音球浮卡位置(球可拖动+持久化, 写死坐标必然相撞)
  const [orbRect, setOrbRect] = useState<{ left: number; top: number; width: number; height: number; bottom: number } | null>(null)
  const [review, setReview] = useState<ExpertReviewData | null>(null)
  const mountedRef = useRef(true)
  const reviewSentRef = useRef(false)
  // 2026-09-07: 纪要不再在球下渲染——对话窗口已有(结论态归对话)，本组件只保留
  // hasSummaryRef 用于跳过通用"已汇总"合并报(部门例会由 VoiceShell 播纪要结论)
  const hasSummaryRef = useRef(false)
  // 2026-09-06 三态分离: ①智囊团成员卡一句话立场(collab:progress done 摘录)
  const [memberExcerpts, setMemberExcerpts] = useState<Record<string, string>>({})
  // ②产物态让位——SideSheet(文档卡等)打开时 body 挂 side-sheet-open，
  //   浮卡自动折叠为迷你胶囊，文档卡关闭自动展开（MutationObserver 监听）
  const [sheetOpen, setSheetOpen] = useState(false)
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setSheetOpen(document.body?.classList?.contains('side-sheet-open') ?? false)
    })
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    setSheetOpen(document.body?.classList?.contains('side-sheet-open') ?? false)
    return () => mo.disconnect()
  }, [])

  // P5 语音归因：先完成先报（subagent:end 入队）+ 结论合并报（allDone 入队）；不打断主对话
  // P5.5: 使用 VoiceShell 注入的共享队列（面板确认播报同队列，防双音）
  const speech = speechQueue

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 量球卡实时矩形: 挂载/窗口缩放即时量; 拖动是 transform 变化不触发 resize——
  // 有成员卡期间 800ms 低频跟随(量一次 getBoundingClientRect 开销可忽略)
  useEffect(() => {
    const measure = () => {
      const el = document.getElementById(ORB_FLOAT_DOM_ID)
      if (!el) { setOrbRect(null); return }
      const r = el.getBoundingClientRect()
      setOrbRect({ left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom })
    }
    measure()
    window.addEventListener('resize', measure)
    const timer = setInterval(measure, 800)
    return () => { window.removeEventListener('resize', measure); clearInterval(timer) }
  }, [])

  useSse({
    path: '/events',
    handlers: useMemo(() => ({
      'subagent:start': (d: any) => {
        setState(s => orbitReducer(s, { type: 'subagent:start', archetype: d?.archetype || 'orchestrator', task: d?.task || '', ts: d?.timestamp ?? Date.now() }))
      },
      'subagent:end': (d: any) => {
        setState(s => orbitReducer(s, { type: 'subagent:end', archetype: d?.archetype || 'orchestrator', success: d?.success !== false, duration: d?.duration || 0, ts: d?.timestamp ?? Date.now() }))
        // 先完成先报（规格 §7.1）：完成后立即语音归因播报；失败则播报失败文案
        const p = resolvePersona(d?.archetype || 'orchestrator')
        const dur = ((d?.duration || 0) / 1000).toFixed(1)
        const isSuccess = d?.success !== false
        speech.enqueue({
          id: `done_${d?.timestamp ?? Date.now()}_${d?.archetype || ''}`,
          text: isSuccess
            ? `${p.label}汇报：${d?.task ? `"${d.task}"` : '任务'}已完成，耗时 ${dur} 秒。`
            : `${p.label}汇报：${d?.task ? `"${d.task}"` : '任务'}执行失败，耗时 ${dur} 秒。`,
          kind: isSuccess ? 'expert-done' : 'expert-error',
        })
      },
      'collab:started': (d: any) => {
        hasSummaryRef.current = false
        setState(s => orbitReducer(s, { type: 'subagent:start', archetype: 'orchestrator', task: `协作启动：${d?.goal || ''}`, ts: Date.now() }))
      },
      // 2026-09-05: 成员卡按 expertName 记名(卡面直接显示专家名, 不再是含糊的
      // "研究员 执行中"); queued 不建卡(排队≠执行); 整场终态 finishAll 强收,
      // 修「例会早已结束、成员卡永远停在执行中且永不收球」。
      'collab:progress': (d: any) => {
        const st = d?.status
        const member = `${d?.expertName || '专家'}`
        if (st === 'done') {
          setState(s => endMember(s, member, true))
          // 2026-09-06: 一句话立场——成员结果首行进成员卡（智囊团卡形态）
          const excerpt = String(d?.excerpt || '').trim()
          if (excerpt) setMemberExcerpts(m => ({ ...m, [member]: excerpt }))
        } else if (isTerminalCollabStatus(st)) {
          setState(s => endMember(s, member, false))
        } else if (st === 'running') {
          setState(s => orbitReducer(s, { type: 'subagent:start', archetype: `member:${member}`, task: `${member} · 协作任务`, ts: Date.now() }))
        }
        // queued: 排队不建卡
      },
      'collab:completed': (d: any) => {
        // 2026-09-06: 捕获协作/例会产出(summary)——渲染到语音球下方纪要卡
        hasSummaryRef.current = !!String(d?.summary || '').trim()
        setState(s => orbitReducer(s, { type: 'finishAll', success: true, ts: Date.now() }))
      },
      'collab:error': (_d: any) => setState(s => orbitReducer(s, { type: 'finishAll', success: false, ts: Date.now() })),
    }), []),
  })

  // 全部完成 4s 后自动收球（v1：视觉淡出，不触发会话语义）
  const allDone = state.agents.length > 0 && state.agents.every(a => a.status !== 'running')
  // 新一批 agent 启动时，重置 review 发送标记
  useEffect(() => {
    if (state.agents.some(a => a.status === 'running')) {
      reviewSentRef.current = false
    }
  }, [state.agents])
  useEffect(() => {
    if (!allDone) return
    // 依赖 state 每次变更会重置 4s 定时器——全部完成期间 state 不再变化，行为正确
    // 聚合评审投票卡数据（仅首次触发，避免重复 set）
    if (!reviewSentRef.current) {
      setReview(toReviewData(state, ''))
      reviewSentRef.current = true
      // 结论合并报（规格 §7.1）：全部完成 → 合并播报结论。
      // 2026-09-06: 有纪要(collab:completed 携带 summary)时跳过——部门例会场景
      // VoiceShell 轮询会用主持音色播报纪要结论，此处再报即双通道重复(叠音源)。
      if (!hasSummaryRef.current) {
        const doneCount = state.agents.filter(a => a.status === 'done').length
        const failCount = state.agents.filter(a => a.status === 'error').length
        const totalMs = Math.max(...state.agents.map(a => a.endTs || a.startTs)) - Math.min(...state.agents.map(a => a.startTs))
        speech.enqueue({
          id: `summary_${Date.now()}`,
          text: failCount > 0
            ? `${doneCount} 位专家完成，${failCount} 位失败，结果已汇总。`
            : `${state.agents.length} 位专家均已完成，共耗时 ${(totalMs / 1000).toFixed(1)} 秒，结果已汇总。`,
          kind: 'summary',
        })
      }
    }
    const t = setTimeout(() => {
      if (mountedRef.current) {
        // B7: 收球只清本协作的播报(done_/summary_),不动共享队列其他来源
        // (面板确认 panel_/阶段播报 phase_)——旧实现 speech.reset() 会误清它们
        speech.clearByPrefix('done_')
        speech.clearByPrefix('summary_')
        // 2026-08-08(审计 P1): 收球同步清空评审卡——旧实现只 setState({agents:[]}),
        // review 保留,下一批协作开始时旧批次 ExpertReviewCard 携带过期数据重现
        setReview(null)
        setState({ agents: [] })
      }
    }, 4000)
    return () => clearTimeout(t)
  }, [allDone, state])

  // 成员卡布局(跟随语音球浮卡)——纯计算, 不依赖 DOM 副作用
  const layout = computeOrbitLayout(orbRect, window.innerHeight, state.agents.length)

  // 空轨道且无纪要 → 不渲染（克制：无焦点不显示）
  // NOTE: 条件 return 必须在所有 hooks 之后（React hooks 规则）
  if (state.agents.length === 0) return null

  // 2026-09-06 三态分离: SideSheet(文档卡等产物面板)打开 → 过程浮卡折叠为
  // 迷你胶囊（产物态独占注意力）；关闭自动展开。纪要卡不受折叠影响（结论态）。
  const doneCount = state.agents.filter(a => a.status === 'done').length
  const errCount = state.agents.filter(a => a.status === 'error').length
  const runCount = state.agents.filter(a => a.status === 'running').length
  const collapsed = sheetOpen && state.agents.length > 0

  if (collapsed) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: COLLAB_DOT_BREATHE_CSS }} />
        <div style={{
          position: 'fixed', left: layout.left, top: layout.top, transform: layout.transform,
          zIndex: 'var(--z-cockpit)', pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: GAP,
        }}>
          <div className="glass-panel" style={{ padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 8, width: 'fit-content' }}>
            <span style={{ fontSize: 12 }}>📋</span>
            <span style={{ fontSize: 11, color: '#ccc', whiteSpace: 'nowrap' }}>
              例会进行中 · 完成 {doneCount}{errCount > 0 ? ` · 失败 ${errCount}` : ''}{runCount > 0 ? ` · ${runCount} 位分析中` : ''}
            </span>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: COLLAB_DOT_BREATHE_CSS }} />
      <div style={{
        // 2026-09-05: 位置=语音球卡正下方居中(computeOrbitLayout 跟随球卡实时矩形,
        // 球下空间不足自动改球上方); zIndex 与管理舱同档——协作期临时状态卡恒在
        // 可拖动浮动卡(z=70)之上, 例会结束自动收球消失, 不长期占压其他卡
        position: 'fixed',
        left: layout.left,
        top: layout.top,
        bottom: layout.bottom,
        transform: layout.transform,
        maxHeight: layout.maxHeight,
        zIndex: 'var(--z-cockpit)',
        overflow: 'hidden',
        display: 'flex', flexDirection: layout.columnDown ? 'column' : 'column-reverse', gap: GAP,
        pointerEvents: 'none',
      }}>
        {state.agents.map((agent) => {
          const p = resolvePersona(agent.archetype)
          // 2026-09-06: 智囊团形态——成员完成后卡面显示"一句话立场"(结果摘录)
          const memberName = agent.archetype.startsWith('member:') ? agent.archetype.slice(7) : null
          const stance = memberName ? memberExcerpts[memberName] : null
          return (
            <div key={agent.id} className="glass-panel" style={{
              width: CARD_W, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
              opacity: agent.status === 'running' ? 1 : 0.75,
              transition: 'opacity 0.4s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StatusDot agent={agent} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#eee', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.label}</span>
              </div>
              <div style={{ fontSize: 10, color: stance ? '#a8b3c8' : '#888', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden' }}>
                {stance || agent.task || (agent.status === 'done' ? `完成 · ${((agent.duration || 0) / 1000).toFixed(1)}s` : '…')}
              </div>
            </div>
          )
        })}
        {/* 任务进度行——不新造任务卡，一行汇总成员完成度 */}
        {state.agents.length > 1 && (
          <div className="glass-panel" style={{ width: CARD_W, padding: '7px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 10, color: '#888', whiteSpace: 'nowrap' }}>🧭 进度</span>
            <span style={{ fontSize: 11, color: '#bbb', whiteSpace: 'nowrap' }}>
              完成 {doneCount}{errCount > 0 ? ` · 失败 ${errCount}` : ''}{runCount > 0 ? ` · ${runCount} 位分析中` : ' · 全部落定'}
            </span>
          </div>
        )}
        {review && (
          <ExpertReviewCard
            data={review}
            /* onAsk 省略：CollabOrbit 不持有 VoiceShell 输入框句柄，v1 追问按钮不渲染（onAsk=undefined） */
          />
        )}
      </div>
    </>
  )
}
