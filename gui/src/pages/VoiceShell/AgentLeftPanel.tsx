import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  MessageCircle,
  Cpu,
  Database,
  Clock,
  Gauge,
  BookOpen,
  Trash2,
  Info,
} from 'lucide-react'
import { OrbTopBlock } from './OrbTopBlock'
// 2026-08-19 三栏联动轮: 回放条数据源——sse-hub 帧缓冲快照(纯数据, 无订阅副作用)
import { getSseReplayBuffer, type SseReplayFrame } from '../../lib/sse-hub'
// 2026-09-03 方案A改版(回合摘要卡): 回合分组/工具合并/语义化摘要——与 SysInfoCard 共用
import {
  cleanLogText,
  groupLogsByRound,
  groupStatusIcon,
  summarizeGroup,
} from '../../lib/log-summary'

interface AgentLeftPanelProps {
  /** 2026-08-15: 名称展示已删除(仅留"用户消息处理器"标题)——prop 保留兼容, 不再渲染 */
  transactions?: number
  tools?: number
  /** 2026-08-15: Constraint 指标删除——参考实现遗留占位, 无真实数据源(恒 '—') */
  memory?: number | '—'
  knowledge?: number | '—'
  decayed?: number | '—'
  /** G7: 外部日志流（真实 SSE 数据）覆盖内部占位日志 */
  logs?: LogEntry[]
  onReset?: () => void
  /** G1: 语音球 + 语速三档（2026-08-14 自右栏迁移至此, DingDong 对齐） */
  orbMode?: 'idle' | 'listening' | 'thinking' | 'speaking'
  muted?: boolean
  /** 2026-08-24: 能量电平——绿态静态/动态波动幅度 */
  volume?: number
  speechRate?: 'low' | 'default' | 'high'
  onToggleMute?: () => void
  onSpeechRate?: (rate: 'low' | 'default' | 'high') => void
  /** 2026-08-14: 语音模式三态（DingDong MicModeButton 对齐）:
   *  default=唤醒词+空格 / focus=仅空格(专注) / live=连续对话(实时监听) */
  micMode?: 'default' | 'focus' | 'live'
  onCycleMicMode?: () => void
  /** 2026-08-15: 名称旁"实时"徽标已删除(用户反馈与下方语音模式"实时"状态重复)——
   *  本 prop 保留接口兼容, 组件不再消费 */
  wsConnected?: boolean
  /** 2026-08-14 P2-热点70%组合布局: 紧凑模式——只保留语音球区(orb-top),
   *  隐藏认知参谋头/状态/统计/日志区, 宽度收窄。热点面板占左 70% 时右侧
   *  剩余空间给 [语音球 | 对话窗口+输入框] 组合 */
  compact?: boolean
  /** 2026-08-19 三栏联动轮: 被联动高亮的轮次(第 N 个 user 开头的组)——null=不高亮 */
  linkedRound?: number | null
  /** 2026-08-19 三栏联动轮: 轮次组点击 → 父级联动(中栏滚动+右栏定位) */
  onRoundSelect?: (round: number) => void
}

interface LogEntry {
  id: string
  type: 'user' | 'thinking' | 'tool' | 'complete' | 'system'
  text: string
  time: string
  /** 2026-08-14(DingDong SystemEvent.desc 对齐): 详情行(工具结果/错误文案) */
  desc?: string
  /** 2026-08-14(DingDong tool_ok/tool_fail 对齐): 工具成败——成功=绿"成功"徽标, 失败=红"失败"徽标 */
  ok?: boolean
  /** 2026-08-14 P0-图例3: 系统日志分级(info/warn/error/debug) */
  level?: 'info' | 'warn' | 'error' | 'debug'
  /** 2026-08-19 三栏联动轮: SSE 帧 seq(回放条定位键) */
  seq?: number
}

export function AgentLeftPanel({
  transactions = 24,
  tools = 8,
  memory = '—',
  knowledge = '—',
  decayed = '—',
  logs: externalLogs,
  onReset,
  orbMode = 'idle',
  muted = false,
  volume,
  speechRate = 'default',
  onToggleMute,
  onSpeechRate,
  micMode = 'default',
  onCycleMicMode,
  wsConnected,
  compact = false,
  linkedRound = null,
  onRoundSelect,
}: AgentLeftPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>(externalLogs || [])
  // 2026-08-14 ag-ui 二次分析: "仅重要事件"过滤(系统 warn/error)——长时间线里
  // 错误/警告易被淹没, 一键只看重要系统事件(纯本地视图过滤, 不落库)
  // 2026-08-19 三栏联动轮: 扩展为三档过滤器——全部 / 工具 / 重要
  const [filterMode, setFilterMode] = useState<'all' | 'tools' | 'important'>('all')
  // 2026-08-19 三栏联动轮: 轮次组折叠(用户显式覆盖 Map<组 key, 是否折叠>)
  // 2026-09-03 方案A改版(回合摘要卡): 默认态改为"仅最新回合展开,历史回合折叠成
  // 一行摘要"——旧默认全展开导致长流水噪音。Map 为用户显式覆盖(点箭头写入),
  // 无覆盖时按默认态走; 新回合开始时旧回合自动落入折叠摘要, 无需清理。
  const [collapseOverride, setCollapseOverride] = useState<Map<string, boolean>>(new Map())
  // 组折叠/展开——组 key 为组内首条 user 条目的 id; collapsedNow 为当前生效态
  const toggleGroup = (key: string, collapsedNow: boolean) => {
    setCollapseOverride(prev => {
      const next = new Map(prev)
      next.set(key, !collapsedNow)
      // 防泄漏: 覆盖项超 60 条时丢弃最早的
      if (next.size > 60) {
        const first = next.keys().next().value
        if (first !== undefined) next.delete(first)
      }
      return next
    })
  }
  // ── 2026-08-19 三栏联动轮: seq 回放条(P3 时间旅行落地版) ──
  // sse-hub 帧缓冲(300 帧环形)是纯数据快照——滑杆回看历史帧(事件名/seq/载荷),
  // 拖动时左栏时间线滚动定位到 seq 匹配的时间条目(真实帧重放, 非伪造快照)。
  // 范围裁剪说明: 仅时间线视图回放+定位, 不重建对话流/右栏状态(三栏全状态
  // 重建需 reducer 化全部面板状态, 收益/复杂度比低)。
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayIdx, setReplayIdx] = useState(-1) // -1 = 实时(滑杆指向最新帧)
  const [replayFrames, setReplayFrames] = useState<SseReplayFrame[]>([])
  useEffect(() => {
    if (!replayOpen) return
    // 2026-08-28: 缓冲末 seq 未变时不再 setState——避免无新帧也每秒整栏重渲染
    let lastSeq: number | null = null
    const tick = () => {
      const frames = getSseReplayBuffer('/events')
      const newest = frames.length > 0 ? frames[frames.length - 1].seq : null
      if (newest !== lastSeq) {
        lastSeq = newest
        setReplayFrames(frames)
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [replayOpen])
  // 回放定位: 拖动滑杆 → 时间线滚动到 seq 匹配条目(无精确匹配取最近低于)
  useEffect(() => {
    if (!replayOpen || replayIdx < 0 || replayIdx >= replayFrames.length || !timelineRef.current) return
    const seq = replayFrames[replayIdx]?.seq
    if (seq == null) return
    const el = timelineRef.current
    let target: HTMLElement | null = null
    // 精确匹配优先, 降级: 最近低于目标 seq 的条目(帧与日志条目非一一对应)
    for (let s = seq; s >= 0 && !target; s--) {
      target = el.querySelector<HTMLElement>(`[data-log-seq="${s}"]`)
    }
    if (target) target.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [replayIdx, replayFrames, replayOpen])

  // G7: 外部日志流驱动（真实 SSE 数据）——空流显示空态，不回退假日志（数据诚实化）
  // 2026-08-14(DingDong 80 条对齐): 显示量 6 → 50(父级已环形裁剪至 50)
  useEffect(() => {
    if (externalLogs && externalLogs.length > 0) setLogs(externalLogs.slice(-50))
  }, [externalLogs])

  // 2026-08-15 左右日志合并(用户确认): 左栏升级为"全量事件时间线"——user/思考/
  // 工具/完成/system 全类型。此前只收 user+system(空洞), 且与右栏行动日志
  // 无本质区别; 现右栏删除历史区块只留"本轮进行中", 左栏回答"刚才发生了什么"。
  // 2026-08-19 三栏联动轮: 三档过滤——全部 / 工具(工具调用+结果) / 重要(warn/error)
  const displayLogs = filterMode === 'important'
    ? logs.filter(l => l.level === 'error' || l.level === 'warn')
    : filterMode === 'tools'
      ? logs.filter(l => l.type === 'tool')
      : logs

  // ── 2026-08-15 参考实现移植: AI 活动状态派生行 ──
  // 参考实现 ai-activity 区(app.js:1046-1121): 纯前端从事件流记账,
  // 1s 定时重算, 60s 窗口三态(忙碌→刚完成→空闲)。信号 = 全量日志里的
  // tool/thinking(开始干活) 与 complete(干完), 不依赖后端新增事件。
  const lastActivityAtRef = useRef(0)
  const [activity, setActivity] = useState<{ state: 'idle' | 'busy' | 'done'; label: string; detail: string }>(
    { state: 'idle', label: '空闲', detail: '' },
  )
  useEffect(() => {
    const latest = externalLogs && externalLogs.length > 0 ? externalLogs[externalLogs.length - 1] : null
    if (latest && (latest.type === 'tool' || latest.type === 'thinking' || latest.type === 'complete')) {
      lastActivityAtRef.current = Date.now()
    }
  }, [externalLogs])
  useEffect(() => {
    const t = setInterval(() => {
      const since = Date.now() - lastActivityAtRef.current
      if (lastActivityAtRef.current > 0 && since < 15000) {
        setActivity({ state: 'busy', label: '执行中', detail: '正在处理任务…' })
      } else if (lastActivityAtRef.current > 0 && since < 60000) {
        setActivity({ state: 'done', label: '刚完成', detail: `${Math.round(since / 1000)}s 前停止` })
      } else {
        setActivity({ state: 'idle', label: '空闲', detail: '' })
      }
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // 轮次分组(2026-09-03 方案A改版): 共享模块 groupLogsByRound——每个 user 条目
  // 开一轮(ThoughtStream beginRound 语义), round = 第 N 个 user 组, 与对话流对应
  const groups = groupLogsByRound(displayLogs)
  // 联动高亮: 第 linkedRound 个 user 组(对话流点击消息 → 此组高亮)
  const linkedGroupIdx = useMemo(() => {
    if (linkedRound == null) return null
    let count = 0
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].user) { count += 1; if (count === linkedRound) return i }
    }
    return null
  }, [linkedRound, groups])
  // 联动滚动: linkedRound 变化时左栏滚动到对应组(对话流/右栏定位回传)
  const timelineRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (linkedGroupIdx == null || !timelineRef.current) return
    const el = timelineRef.current
    const target = el.querySelector<HTMLElement>(`[data-timeline-group="${linkedGroupIdx}"]`)
    if (target) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [linkedGroupIdx])

  // G2: 新对话——不再回填 DEFAULT_LOGS 占位日志（保留真实 SSE 日志流），
  // 对话卡清空由父级 onReset 与中栏"清空"按钮同口径完成
  const handleReset = useCallback(() => {
    onReset?.()
  }, [onReset])

  return (
    <div
      style={{
        width: compact ? 180 : 'var(--voice-shell-sidebar-w)',
        minWidth: compact ? 180 : undefined,
        height: '100%',
        background: 'rgba(12, 18, 30, 0.95)',
        border: '1px solid rgba(56, 189, 248, 0.15)',
        borderRadius: 14,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: 'rgba(243, 245, 251, 0.9)',
        fontSize: 12,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      {/* 2026-08-15 用户要求: "认知参谋"/名称头像全部删除, 仅保留"用户消息处理器"
          作为左栏标题(字号放大)—— compact 模式隐藏 */}
      {!compact && (
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid rgba(56, 189, 248, 0.12)' }}>
        <span style={{
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: 'rgba(243, 245, 251, 0.95)',
        }}>用户消息处理器</span>
      </div>
      )}

      {/* G1: 语音球 + 语速三档（DingDong 对齐——头像行 → 语音球 → 状态行 → 指标行。
          2026-08-14 自右栏顶部迁移至此, 点击球切换静音, 语速写入 config.voice.speed。
          2026-08-15: 抽为 OrbTopBlock 共用组件——组合布局下同块内联到对话窗上方,
          常规态仍在此纵向渲染 200px 球。 */}
      <OrbTopBlock
        orbMode={orbMode}
        muted={muted}
        volume={volume}
        speechRate={speechRate}
        micMode={micMode}
        compact={compact}
        onToggleMute={onToggleMute}
        onSpeechRate={onSpeechRate}
        onCycleMicMode={onCycleMicMode}
      />

      {/* 状态行 —— compact 模式隐藏 */}
      {!compact && (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid rgba(56, 189, 248, 0.08)',
        }}
      >
        <StatItem icon={<Gauge size={13} />} label="事务" value={transactions} color="#38bdf8" />
        <StatItem icon={<Cpu size={13} />} label="工具" value={tools} color="#a855f7" />
      </div>
      )}

      {/* 统计行 —— compact 模式隐藏 */}
      {!compact && (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 12px',
          padding: '8px 16px',
          borderBottom: '1px solid rgba(56, 189, 248, 0.08)',
          flexShrink: 0,
        }}
      >
        {/* 2026-08-15: Constraint 行删除(无真实数据源); Decayed 已接真实数据
            (记忆衰减引擎累计衰减数, 30s 轮询) */}
        <MetricRow icon={<Database size={12} />} label="Memory" value={memory} dotColor="#38bdf8" />
        <MetricRow icon={<BookOpen size={12} />} label="Knowledge" value={knowledge} dotColor="#a855f7" />
        <MetricRow icon={<Trash2 size={12} />} label="Decayed" value={decayed} dotColor="#f87171" />
      </div>
      )}

      {/* 事件日志时间线（2026-08-15 左右日志合并: 全量事件——用户发言/思考/工具/
          完成/系统, 轮次分组; 右栏删除历史区块只留"本轮进行中", 左右不再双显。
          —— compact 模式隐藏） */}
      {!compact && (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* 2026-08-15 参考实现移植: AI 活动状态行(ai-activity 区)——纯前端
            60s 窗口三态派生, 忙碌=蓝+脉冲点, 刚完成/空闲=灰 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 16px 2px',
          fontSize: 10,
        }} data-state={activity.state}>
          <span style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: activity.state === 'busy' ? '#38bdf8' : 'rgba(148, 163, 184, 0.4)',
            boxShadow: activity.state === 'busy' ? '0 0 6px rgba(56, 189, 248, 0.8)' : 'none',
            animation: activity.state === 'busy' ? 'heartbeat-pulse 1.2s ease-in-out infinite' : 'none',
          }} />
          <span style={{
            color: activity.state === 'busy' ? 'rgba(125, 211, 252, 0.95)' : 'rgba(148, 163, 184, 0.75)',
            fontWeight: 600,
          }}>{activity.label}</span>
          {activity.detail && (
            <span style={{
              color: 'rgba(148, 163, 184, 0.55)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}>{activity.detail}</span>
          )}
          {/* 连接状态点(参考 live 圆点脉冲)——断线红色 */}
          <span
            title={wsConnected === false ? '连接中断' : '服务已连接'}
            style={{
              display: 'inline-block',
              width: 5,
              height: 5,
              borderRadius: '50%',
              flexShrink: 0,
              background: wsConnected === false ? '#ef4444' : '#34d399',
              boxShadow: wsConnected === false ? '0 0 5px rgba(239, 68, 68, 0.7)' : '0 0 5px rgba(52, 211, 153, 0.6)',
              animation: wsConnected === false ? 'none' : 'heartbeat-pulse 2s ease-in-out infinite',
            }}
          />
        </div>
        {/* 2026-08-25 界面对齐(小白龙「星球节点图/图谱调节」入口): 记忆图谱小结按钮——
            跳转管理舱记忆页(与语音/命令面板同款 crabpaw:open-cockpit 通道) */}
        {!compact && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              padding: '6px 16px 2px',
            }}
          >
            <button
              type="button"
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                padding: '5px 0',
                fontSize: 11,
                borderRadius: 6,
                border: '1px solid rgba(56, 189, 248, 0.18)',
                background: 'rgba(56, 189, 248, 0.06)',
                color: 'rgba(125, 211, 252, 0.85)',
                cursor: 'pointer',
              }}
              onClick={() => {
                try {
                  window.dispatchEvent(new CustomEvent('crabpaw:open-cockpit', { detail: { tab: 'memory' } }))
                } catch (e) { console.error('[shell] 打开记忆图谱失败:', e) }
              }}
              title="记忆图谱 / 记忆进化 / 快照（管理舱记忆页）"
            >
              🧠 记忆图谱
            </button>
          </div>
        )}
        <div
          style={{
            padding: '6px 16px 4px',
            fontSize: 11,
            fontWeight: 600,
            color: 'rgba(148, 163, 184, 0.6)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>事件日志</span>
          {/* 2026-08-14(DingDong syslog-count 对齐): 实时计数徽标 */}
          <span
            style={{
              fontSize: 9,
              fontWeight: 500,
              padding: '0 6px',
              borderRadius: 999,
              background: 'rgba(56, 189, 248, 0.12)',
              border: '1px solid rgba(56, 189, 248, 0.2)',
              color: 'rgba(125, 211, 252, 0.8)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0',
              textTransform: 'none',
            }}
          >
            {logs.length}
          </span>
          {/* 2026-08-14 ag-ui 二次分析: 仅重要事件开关(系统 warn/error 过滤)
              2026-08-19 三栏联动轮: 扩展为三档过滤器(全部/工具/重要) */}
          <button
            type="button"
            onClick={() => setFilterMode(v => v === 'all' ? 'tools' : v === 'tools' ? 'important' : 'all')}
            title="过滤: 全部 → 仅工具 → 仅警告/错误"
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              fontWeight: 500,
              padding: '1px 8px',
              borderRadius: 999,
              cursor: 'pointer',
              letterSpacing: '0.02em',
              textTransform: 'none',
              background: filterMode === 'important' ? 'rgba(245, 158, 11, 0.14)'
                : filterMode === 'tools' ? 'rgba(168, 85, 247, 0.14)'
                  : 'rgba(255,255,255,0.04)',
              border: filterMode === 'important'
                ? '1px solid rgba(245, 158, 11, 0.35)'
                : filterMode === 'tools'
                  ? '1px solid rgba(168, 85, 247, 0.35)'
                  : '1px solid rgba(255,255,255,0.08)',
              color: filterMode === 'important' ? 'rgba(251, 191, 36, 0.9)'
                : filterMode === 'tools' ? 'rgba(196, 181, 253, 0.9)'
                  : 'rgba(148, 163, 184, 0.7)',
            }}
          >
            {filterMode === 'important' ? '仅重要 ✓' : filterMode === 'tools' ? '仅工具 ✓' : '全部'}
          </button>
          {/* 2026-08-19 三栏联动轮: 全部折叠/展开(长时间线收纳)
              2026-09-03 方案A改版: 语义为"历史全折叠/全展开"(最新回合始终展开) */}
          <button
            type="button"
            onClick={() => {
              setCollapseOverride(prev => {
                const next = new Map(prev)
                const collapseAll = !(prev.size > 0 && [...prev.values()].every(Boolean))
                for (const g of groups) {
                  const key = g.user?.id ?? g.systems[0]?.id
                  if (key) next.set(key, collapseAll)
                }
                return next
              })
            }}
            title={[...collapseOverride.values()].every(Boolean) && collapseOverride.size > 0 ? '全部展开' : '全部折叠'}
            style={{
              fontSize: 9,
              fontWeight: 500,
              padding: '1px 6px',
              borderRadius: 999,
              cursor: 'pointer',
              letterSpacing: '0.02em',
              textTransform: 'none',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(148, 163, 184, 0.7)',
            }}
          >
            {[...collapseOverride.values()].every(Boolean) && collapseOverride.size > 0 ? '展开' : '折叠'}
          </button>
          {/* 2026-08-19 三栏联动轮: 回放条开关(P3——seq 帧回放定位) */}
          <button
            type="button"
            onClick={() => setReplayOpen(v => !v)}
            title={replayOpen ? '退出回放(回到实时)' : '回放历史事件帧(seq 定位)'}
            style={{
              fontSize: 9,
              fontWeight: 500,
              padding: '1px 6px',
              borderRadius: 999,
              cursor: 'pointer',
              letterSpacing: '0.02em',
              textTransform: 'none',
              background: replayOpen ? 'rgba(168, 85, 247, 0.16)' : 'rgba(255,255,255,0.04)',
              border: replayOpen ? '1px solid rgba(168, 85, 247, 0.4)' : '1px solid rgba(255,255,255,0.08)',
              color: replayOpen ? 'rgba(216, 180, 254, 0.95)' : 'rgba(148, 163, 184, 0.7)',
            }}
          >
            {replayOpen ? '回放 ✓' : '回放'}
          </button>
        </div>
        <div
          ref={timelineRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 12px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {groups.length === 0 ? (
            <div
              style={{
                padding: '16px 8px',
                textAlign: 'center',
                color: 'rgba(148, 163, 184, 0.5)',
                fontSize: 11,
              }}
            >
              {filterMode === 'important' ? '暂无警告/错误事件' : filterMode === 'tools' ? '暂无工具事件' : '暂无消息日志'}
            </div>
          ) : (
            /* 2026-08-15 参考实现移植: 轮次分组——每个 user 条目开一轮卡片,
               后续 system 条目入轮(ThoughtStream beginRound 语义), 平铺改分组。
               2026-08-19 三栏联动轮: 组卡片可点击(联动对话流/右栏) + 折叠 +
               linkedRound 高亮(青色描边)
               2026-09-03 方案A改版(回合摘要卡): 默认仅最新回合展开,历史回合
               折叠为一行语义摘要; 展开态为合并后的步骤清单(工具 调用+完成
               合一行、内部 roundId 不出现、推理条目并入摘要行)。 */
            groups.map((g, gi) => {
              const groupKey = g.user?.id || g.systems[0]?.id || `g${gi}`
              const isLatest = gi === groups.length - 1
              const collapsed = collapseOverride.has(groupKey) ? collapseOverride.get(groupKey)! : !isLatest
              const linked = linkedGroupIdx === gi
              const sum = summarizeGroup(g)
              const status = groupStatusIcon(sum)
              // 展开态步骤: 工具(合并)+完成; 系统 info 行不进步骤(噪音), warn/error 保留
              const stepsToRender = sum.steps.filter(s => s.kind !== 'system' || s.entry.level === 'error' || s.entry.level === 'warn')
              return (
              <div
                key={groupKey}
                data-timeline-group={gi}
                onClick={() => { if (g.round != null) onRoundSelect?.(g.round) }}
                title={g.round != null ? '点击定位到对话与工具过程' : undefined}
                style={{
                  borderRadius: 8,
                  background: linked ? 'rgba(56, 189, 248, 0.06)' : 'rgba(255, 255, 255, 0.02)',
                  border: linked
                    ? '1px solid rgba(56, 189, 248, 0.5)'
                    : '1px solid rgba(255, 255, 255, 0.04)',
                  borderLeft: g.user ? '2px solid rgba(56, 189, 248, 0.35)' : '2px solid rgba(148, 163, 184, 0.2)',
                  padding: '4px 6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  cursor: g.round != null ? 'pointer' : 'default',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                {g.user && (
                  <LogItem
                    key={g.user.id}
                    entry={g.user as LogEntry}
                    prominent
                    collapseChevron={g.systems.length > 0}
                    collapsed={collapsed}
                    onToggleCollapse={() => toggleGroup(groupKey, collapsed)}
                  />
                )}
                {collapsed ? (
                  g.systems.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 3px 26px', fontSize: 10.5, lineHeight: 1.4 }}>
                      <span style={{ color: status.color, flexShrink: 0 }}>{status.icon}</span>
                      <span style={{ color: 'rgba(203, 213, 225, 0.75)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {status.text}
                      </span>
                    </div>
                  )
                ) : (
                  stepsToRender.length > 0 && (
                    <div style={{
                      display: 'flex', flexDirection: 'column', gap: 1,
                      padding: '0 0 2px 10px', marginLeft: 14,
                      borderLeft: '2px solid rgba(56, 189, 248, 0.12)',
                    }}>
                      {stepsToRender.map((st, i) => {
                        if (st.kind === 'system') return <LogItem key={st.entry.id} entry={st.entry as LogEntry} />
                        const synthetic: LogEntry = {
                          id: `${groupKey}-s${i}`,
                          type: st.kind === 'complete' ? 'complete' : 'tool',
                          text: st.name,
                          time: st.time,
                          ok: st.ok ?? undefined,
                          desc: st.entry.desc,
                          seq: st.entry.seq,
                        }
                        return <LogItem key={synthetic.id} entry={synthetic} />
                      })}
                    </div>
                  )
                )}
              </div>
              )
            })
          )}
        </div>
      </div>
      )}

      {/* ── 2026-08-19 三栏联动轮: seq 回放条(P3)——帧滑杆 + 载荷详情 + 时间线定位 ── */}
      {!compact && replayOpen && (
        <div style={{
          padding: '6px 12px 8px',
          borderTop: '1px solid rgba(168, 85, 247, 0.15)',
          background: 'rgba(168, 85, 247, 0.03)',
          flexShrink: 0,
        }}>
          {replayFrames.length === 0 ? (
            <div style={{ fontSize: 10, color: 'rgba(148, 163, 184, 0.6)', padding: '2px 0' }}>
              暂无帧缓冲(等待事件…)
            </div>
          ) : (() => {
            const idx = replayIdx >= 0 && replayIdx < replayFrames.length ? replayIdx : replayFrames.length - 1
            const frame = replayFrames[idx]
            return (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'rgba(216, 180, 254, 0.95)',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    flexShrink: 0,
                  }}>帧回放</span>
                  {replayIdx >= 0 ? (
                    <button
                      type="button"
                      onClick={() => setReplayIdx(-1)}
                      title="回到实时(最新帧)"
                      style={{
                        marginLeft: 'auto',
                        fontSize: 9,
                        padding: '1px 8px',
                        borderRadius: 999,
                        cursor: 'pointer',
                        background: 'rgba(56, 189, 248, 0.1)',
                        border: '1px solid rgba(56, 189, 248, 0.3)',
                        color: 'rgba(125, 211, 252, 0.9)',
                      }}
                    >
                      回到实时
                    </button>
                  ) : (
                    <span style={{ marginLeft: 'auto', fontSize: 9, color: 'rgba(148, 163, 184, 0.5)' }}>
                      最新帧(实时)
                    </span>
                  )}
                </div>
                <input
                  type="range"
                  min={0}
                  max={replayFrames.length - 1}
                  value={idx}
                  onChange={(e) => setReplayIdx(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#a855f7', margin: '2px 0' }}
                  aria-label="回放帧滑杆"
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{
                    fontSize: 9,
                    color: 'rgba(216, 180, 254, 0.8)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    seq {frame.seq} · {frame.event} ·{' '}
                    {new Date(frame.at).toLocaleTimeString('zh-CN', { hour12: false })}
                  </span>
                  <span style={{
                    fontSize: 9,
                    lineHeight: 1.4,
                    color: 'rgba(125, 211, 252, 0.85)',
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                    maxHeight: 44,
                    overflowY: 'auto',
                  }}>
                    {(() => {
                      try { return JSON.stringify(frame.data).slice(0, 180) } catch { return String(frame.data).slice(0, 180) }
                    })()}
                  </span>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* 底部控制 —— compact 模式隐藏 */}
      {!compact && (
      <div
        style={{
          padding: '10px 16px',
          borderTop: '1px solid rgba(56, 189, 248, 0.12)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
        }}
      >
        {/* G2: 重置节点 → 新对话（清对话卡, 保留真实日志） */}
        <button
          onClick={handleReset}
          title="新对话"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            width: '100%',
            padding: '7px 12px',
            borderRadius: 8,
            border: '1px solid rgba(56, 189, 248, 0.3)',
            background: 'rgba(56, 189, 248, 0.08)',
            color: '#7dd3fc',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'all 0.2s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(56, 189, 248, 0.16)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'rgba(56, 189, 248, 0.08)'
          }}
        >
          <MessageCircle size={13} />
          新对话
        </button>
      </div>
      )}
    </div>
  )
}

function StatItem({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode
  label: string
  value: number
  color: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color, display: 'flex', alignItems: 'center' }}>{icon}</span>
      <div>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'rgba(243, 245, 251, 0.95)', lineHeight: 1.1 }}>
          {value}
        </div>
        <div style={{ fontSize: 10, color: 'rgba(148, 163, 184, 0.6)', letterSpacing: '0.04em' }}>
          {label}
        </div>
      </div>
    </div>
  )
}

function MetricRow({
  icon,
  label,
  value,
  dotColor,
}: {
  icon: React.ReactNode
  label: string
  /** 2026-08-14: 支持 '—'(无真实数据源的诚实显示, 与右栏指标口径一致) */
  value: number | '—'
  dotColor: string
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          flexShrink: 0,
          boxShadow: `0 0 6px ${dotColor}`,
        }}
      />
      <span style={{ color: 'rgba(148, 163, 184, 0.7)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {icon}
        {label}
      </span>
      <span
        style={{
          marginLeft: 'auto',
          color: 'rgba(243, 245, 251, 0.9)',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  )
}

const LOG_ICON: Record<LogEntry['type'], React.ReactNode> = {
  user: <MessageCircle size={11} />,
  thinking: <Cpu size={11} />,
  tool: <Database size={11} />,
  complete: <Clock size={11} />,
  system: <Info size={11} />,
}

const LOG_COLOR: Record<LogEntry['type'], string> = {
  user: '#38bdf8',
  thinking: '#f59e0b',
  tool: '#a855f7',
  complete: '#34d399',
  system: '#64748b',
}

// (回合摘要推导已迁移 gui/src/lib/log-summary.ts, 与 SysInfoCard 共用)
const LEVEL_COLOR: Record<NonNullable<LogEntry['level']>, string> = {
  info: 'rgba(125, 211, 252, 0.85)',
  warn: '#f59e0b',
  error: '#ef4444',
  debug: '#94a3b8',
}

function LogItem({ entry, prominent = false, collapseChevron = false, collapsed = false, onToggleCollapse }: {
  entry: LogEntry
  prominent?: boolean
  /** 2026-08-19 三栏联动轮: 组折叠箭头(有 system 条目时才渲染) */
  collapseChevron?: boolean
  collapsed?: boolean
  onToggleCollapse?: () => void
}) {
  // 2026-08-15: desc 详情默认折叠, 点击展开(参考工具 detail chevron 交互)
  const [expanded, setExpanded] = useState(false)
  // 2026-08-14 P0-图例3：system 类型用 level 颜色覆盖基色（error=红, warn=橙）
  const baseColor = LOG_COLOR[entry.type] || '#64748b'
  const color = entry.type === 'system' && entry.level
    ? (LEVEL_COLOR[entry.level] as string).includes('rgba') ? '#38bdf8' : LEVEL_COLOR[entry.level]
    : baseColor
  // 2026-08-14(DingDong tag-ok/tag-err 对齐): 工具成败徽标——仅 tool 类型且有 ok 标志时渲染
  const tag: 'ok' | 'err' | null = entry.type === 'tool' && entry.ok != null ? (entry.ok ? 'ok' : 'err') : null
  // 2026-08-14 ag-ui 二次分析: 系统 warn/error 左侧强调条 + 微染色背景——
  // 错误/警告在长时间线中可被一眼定位(语义色 + alpha, 不新增色相)
  const isImportant = entry.type === 'system' && (entry.level === 'error' || entry.level === 'warn')
  const accentColor = entry.type === 'system' && entry.level === 'error'
    ? '#ef4444'
    : entry.type === 'system' && entry.level === 'warn'
      ? '#f59e0b'
      : null
  return (
    <div
      data-log-seq={entry.seq ?? undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '5px 8px',
        borderRadius: 6,
        background: isImportant
          ? (entry.level === 'error' ? 'rgba(239, 68, 68, 0.05)' : 'rgba(245, 158, 11, 0.05)')
          : 'rgba(255, 255, 255, 0.02)',
        border: '1px solid rgba(255, 255, 255, 0.04)',
        borderLeft: accentColor ? `2px solid ${accentColor}` : undefined,
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      {/* 标题行: 折叠箭头 + 图标 + 文本 + 成败徽标 + 时间 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {collapseChevron && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleCollapse?.() }}
            title={collapsed ? '展开该轮事件' : '折叠该轮事件'}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'rgba(148, 163, 184, 0.6)',
              fontSize: 9,
              flexShrink: 0,
              width: 12,
            }}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
        <span style={{ color, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {LOG_ICON[entry.type]}
        </span>
        <span style={{ flex: 1, color: 'rgba(228, 240, 255, 0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: prominent ? 12 : 11, fontWeight: prominent ? 600 : 400 }}>
          {cleanLogText(entry.text)}
        </span>
        {tag && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 9,
              padding: '0 5px',
              borderRadius: 999,
              background: tag === 'ok' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
              border: tag === 'ok' ? '1px solid rgba(16, 185, 129, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)',
              color: tag === 'ok' ? '#34d399' : '#f87171',
            }}
          >
            {tag === 'ok' ? '成功' : '失败'}
          </span>
        )}
        <span
          style={{
            flexShrink: 0,
            fontSize: 10,
            color: 'rgba(148, 163, 184, 0.55)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {entry.time}
        </span>
      </div>
      {/* 2026-08-14(DingDong desc 对齐): 详情行——工具结果/错误文案。
          2026-08-15: 默认折叠 2 行, 点击展开全文(参考工具 detail chevron 交互) */}
      {entry.desc && (
        <div
          onClick={() => setExpanded(v => !v)}
          title={expanded ? '收起' : '展开详情'}
          // 2026-08-15 a11y: 详情行展开 div onClick 无键盘可达——补
          // role/tabIndex/keydown(Enter/Space) 与展开态语义
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setExpanded(v => !v)
            }
          }}
          style={{
            fontSize: 10,
            lineHeight: 1.45,
            color: 'rgba(148, 163, 184, 0.7)',
            paddingLeft: 19,
            cursor: 'pointer',
            overflow: 'hidden',
            display: expanded ? 'block' : '-webkit-box',
            WebkitLineClamp: expanded ? undefined : 2,
            WebkitBoxOrient: expanded ? undefined : 'vertical',
          }}
        >
          <span style={{ marginRight: 3, color: 'rgba(148, 163, 184, 0.45)' }}>{expanded ? '▾' : '▸'}</span>
          {entry.desc}
        </div>
      )}
    </div>
  )
}