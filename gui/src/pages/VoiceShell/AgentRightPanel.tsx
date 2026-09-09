import { useState } from 'react'
import { HeartBeatEcg } from '../../components/HeartBeatEcg'
import {
  Network,
  GitBranch,
  Sparkles,
  Radio,
  Gauge,
  Database,
} from 'lucide-react'
// Task 7 审查修复(2026-08-18): 步骤 chip 数据源——AG-UI RUN/STEP 生命周期
import { useTurnState } from '../../hooks/useTurnState'
// Plan 实体(Plan/Artifact 深化轮): 执行计划投影——SSE plan:updated 实时刷新
import { useSse } from '../../hooks/useSSE'

/** plan:updated 事件负载（后端 plan-store._publicPlan） */
interface PlanProjection {
  planId: string
  runId: string
  title: string
  revision: number
  steps: Array<{ index: number; text: string; status: 'pending' | 'running' | 'done' | 'failed'; note?: string }>
  progress: { done: number; total: number }
  ts: number
}

const PLAN_STEP_STYLE: Record<PlanProjection['steps'][number]['status'], { icon: string; color: string }> = {
  done: { icon: '✓', color: 'rgba(134, 239, 172, 0.9)' },
  running: { icon: '●', color: 'rgba(103, 232, 249, 1)' },
  failed: { icon: '✗', color: 'rgba(252, 165, 165, 0.95)' },
  pending: { icon: '○', color: 'rgba(203, 213, 225, 0.45)' },
}

/**
 * PlanSection — 执行计划进度投影（Agent 右板）。
 * 模型经 PlanCreate/PlanUpdate 维护计划，后端 plan-store 广播 plan:updated；
 * 本组件为纯订阅端：无计划时整块不渲染，不占右板空间。
 * 2026-09-03 交互补齐: ①可收缩(折叠成单行摘要, 点箭头展开) ②步骤区最大高度
 * 180px 内部滚动(最多 20 步的计划不再挤压下方工具执行卡)。
 */
function PlanSection() {
  const [plan, setPlan] = useState<PlanProjection | null>(null)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  useSse({
    path: '/events',
    handlers: {
      'plan:updated': (data: any) => {
        if (!data?.runId || !Array.isArray(data?.steps) || data.steps.length === 0) return
        setPlan(data as PlanProjection)
      },
    },
  })
  if (!plan) return null
  const done = plan.progress.done
  const total = plan.progress.total
  const current = plan.steps.find(s => s.status === 'running')
  return (
    <div
      data-testid="plan-section"
      style={{
        margin: '8px 10px 4px',
        border: '1px solid rgba(56, 189, 248, 0.18)',
        borderRadius: '10px',
        padding: planCollapsed ? '6px 10px' : '8px 10px',
        background: 'rgba(56, 189, 248, 0.06)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <button
          type="button"
          onClick={() => setPlanCollapsed(v => !v)}
          title={planCollapsed ? '展开执行计划' : '折叠执行计划'}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 5,
            background: 'none', border: 'none', padding: 0, cursor: 'pointer', minWidth: 0,
          }}
        >
          <span style={{ color: 'rgba(148, 163, 184, 0.7)', fontSize: 9, flexShrink: 0 }}>
            {planCollapsed ? '▸' : '▾'}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(147, 197, 253, 0.95)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            📋 执行计划 · {plan.title}
          </span>
        </button>
        <span style={{ fontSize: 10, color: 'rgba(148, 163, 184, 0.9)', flexShrink: 0 }}>
          v{plan.revision} · {done}/{total}
        </span>
      </div>
      {planCollapsed ? (
        current && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 4, fontSize: 10.5, minWidth: 0 }}>
            <span style={{ color: 'rgba(103, 232, 249, 1)', flexShrink: 0 }}>●</span>
            <span style={{ color: 'rgba(203, 213, 225, 0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {current.text}
            </span>
          </div>
        )
      ) : (
        <div style={{
          marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3,
          maxHeight: 180, overflowY: 'auto',
        }}>
          {plan.steps.map((s) => {
            const st = PLAN_STEP_STYLE[s.status] || PLAN_STEP_STYLE.pending
            return (
              <div key={s.index} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, lineHeight: 1.5 }}>
                <span style={{ width: 14, textAlign: 'center', color: st.color, flexShrink: 0 }}>{st.icon}</span>
                <span style={{
                  flex: 1,
                  color: st.color,
                  textDecoration: s.status === 'done' ? 'line-through' : 'none',
                  wordBreak: 'break-all',
                }}>
                  {s.text}
                  {s.note && <span style={{ fontSize: 10, color: 'rgba(251, 191, 36, 0.75)', marginLeft: 4 }}>{s.note}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export interface RightPanelProps {
  statusLabel?: string
  nodes?: string
  connections?: string
  tokPerSec?: string
  recallPerHour?: string
  extractPerHour?: string
  heartBeatCount?: string
  heartBeatMinutes?: string
  lastAction?: string
  /** 2026-08-14: 意识心跳活跃标志(30s 内有活动, 后端 heartbeat 事件)——ECG 脉冲/呼吸基线切换 */
  heartBeatActive?: boolean
  /** 工具执行状态卡: flow.toolEvents(running/done/error) */
  toolRuns?: Array<{
    toolId: string; toolName: string; status: 'running' | 'done' | 'error'; summary?: string
    args?: string
    result?: string
  }>
  /** 2026-08-14 ag-ui 二次分析: 进行中工具数(running 计数)——驱动"执行中"徽标 */
  activeToolCount?: number
  /** 2026-08-14: 连接态(SSE)——"心跳在线"横幅的真实状态源 */
  online?: boolean
  /** 2026-08-15: 服务连接状态(/health services 块 + 语音引擎 KWS 状态) */
  services?: HealthServices | null
  /** 2026-08-15: 语音引擎(KWS 子进程)是否正常——fatal 时显示"异常" */
  voiceEngineOk?: boolean
  /** 2026-08-19 三栏联动轮: 工具卡/步骤行点击 → 定位当前轮(中栏滚动+左栏高亮) */
  onRoundSelect?: () => void
}

/** 2026-08-15: /health services 响应形状(后端 handleHealth 扩展) */
export interface HealthServices {
  ai?: { configured?: boolean }
  wecom?: { configured?: boolean; connected?: boolean }
  lark?: { configured?: boolean; connected?: boolean }
}

// 2026-08-14: 默认空数组(数据诚实化——父级始终显式传真实数据,无假日志兜底)

/* ─── 顶部标题栏 ─── */
function TopHeader() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 14px 8px',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          display: 'inline-block',
          width: '7px',
          height: '7px',
          borderRadius: '50%',
          background: '#f59e0b',
          boxShadow: '0 0 8px rgba(245, 158, 11, 0.8)',
        }} />
        <span style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '1px',
          color: 'rgba(191, 236, 255, 0.7)',
        }}>CONSCIOUS HEARTBEAT</span>
      </div>
      <span style={{
        fontSize: '10px',
        letterSpacing: '1.5px',
        color: 'rgba(148, 163, 184, 0.5)',
      }}>LIVE LOOP</span>
    </div>
  )
}

/* ─── 6列状态指标栏 ─── */
// 2026-08-14 G5 R-1: 无真实数据源的指标默认值改 '—'（DingDong 无源时同款诚实显示,
// 此前 55/65/3.2/10·23.5/4·0.3 全为硬编码演示假账）
function StatusMetricsRow({
  statusLabel = '已连接',
  nodes = '—',
  connections = '—',
  tokPerSec = '—',
  recallPerHour = '—',
  extractPerHour = '—',
}: Required<Pick<RightPanelProps,
  'statusLabel' | 'nodes' | 'connections' | 'tokPerSec' | 'recallPerHour' | 'extractPerHour'>>) {
  // P6(GUI 全量修复 P1): 无数据源列折叠——旧实现五列恒'—'占位(半屏死区),
  // 只剩真实的状态列与工具执行区
  const metrics = [
    { icon: <Radio size={12} />, label: '主服务', value: statusLabel, dot: true },
    { icon: <GitBranch size={12} />, label: '节点', value: nodes, dot: false },
    { icon: <Network size={12} />, label: '连接', value: connections, dot: false },
    { icon: <Gauge size={12} />, label: 'TOK/S', value: tokPerSec, dot: false },
    { icon: <Sparkles size={12} />, label: '召回/H', value: recallPerHour, dot: false },
    { icon: <Database size={12} />, label: '抽取/H', value: extractPerHour, dot: false },
  ].filter((m) => m.value !== '—')

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '6px 14px 10px',
      /* G8 Task 10: amber 收敛——分隔线改青系 */
      borderBottom: '1px solid rgba(56, 189, 248, 0.12)',
      margin: '0 10px',
      flexShrink: 0,
    }}>
      {metrics.map((m) => (
        <div key={m.label} style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: '2px',
          flex: 1,
          minWidth: 0,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            fontSize: '10px',
            color: 'rgba(148, 163, 184, 0.6)',
          }}>
            {m.icon}
            <span>{m.label}</span>
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
          }}>
            {m.dot && (
              <span style={{
                display: 'inline-block',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: '#f59e0b',
                boxShadow: '0 0 6px rgba(245, 158, 11, 0.7)',
              }} />
            )}
            <span style={{
              fontSize: '11px',
              fontWeight: 600,
              /* G8 Task 10: amber 收敛——指标数值色改青系（amber 只留给状态语义） */
              color: 'rgba(191, 236, 255, 0.9)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {m.value}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/* 注: 原 generateECGPath(SVG 静态 path) 已被 Canvas 实时滚动动画替代（P1-图例1 2026-08-14）。
   PQRST 波形逻辑已内联进 HeartbeatSection RAF 主循环的 pqrstCycle 构造数组。 */

/* ─── 心跳图表区 ─── */
// 2026-08-14 G5 R-2: 心跳计数/BPM 无真实源 → 默认 '—'（此前 32/68 硬编码假值,
// 且 68 实为 BPM 被误标"分钟"——无源时单位不渲染, 不再造假账）
/* ─── 2026-08-15: 多服务连接状态行（用户要求——主服务已在指标栏, 此处渠道/语音/AI）─── */
function ServiceStatusBlock({ services, voiceEngineOk }: {
  services?: HealthServices | null
  voiceEngineOk?: boolean
}) {
  // 渠道行: 按配置显示(未配置不占行)——企微/飞书, 连接态来自桥状态文件
  const channelRows: Array<{ name: string; connected: boolean }> = []
  if (services?.wecom?.configured) channelRows.push({ name: '企微', connected: services.wecom.connected === true })
  if (services?.lark?.configured) channelRows.push({ name: '飞书', connected: services.lark.connected === true })

  const row = (name: string, state: 'ok' | 'warn' | 'err', value: string) => (
    <div key={name} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
      <span style={{
        display: 'inline-block', width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0,
        background: state === 'ok' ? '#34d399' : state === 'warn' ? '#f59e0b' : '#ef4444',
        boxShadow: state === 'ok' ? '0 0 5px rgba(52, 211, 153, 0.7)' : state === 'warn' ? '0 0 5px rgba(245, 158, 11, 0.7)' : '0 0 5px rgba(239, 68, 68, 0.7)',
      }} />
      <span style={{ fontSize: '10px', color: 'rgba(148, 163, 184, 0.7)', flexShrink: 0 }}>{name}</span>
      <span style={{
        fontSize: '10px', fontWeight: 500, marginLeft: 'auto',
        color: state === 'ok' ? 'rgba(110, 231, 183, 0.9)' : state === 'warn' ? 'rgba(251, 191, 36, 0.9)' : 'rgba(248, 113, 113, 0.9)',
      }}>{value}</span>
    </div>
  )

  const rows: React.ReactNode[] = []
  for (const c of channelRows) rows.push(row(c.name, c.connected ? 'ok' : 'warn', c.connected ? '已连接' : '未连接'))
  rows.push(row('语音引擎', voiceEngineOk === false ? 'err' : 'ok', voiceEngineOk === false ? '异常' : '已启动'))
  if (services && services.ai !== undefined) {
    rows.push(row('AI 模型', services.ai.configured ? 'ok' : 'warn', services.ai.configured ? '已配置' : '未配置'))
  }

  if (rows.length === 0) return null

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      columnGap: '14px',
      rowGap: '3px',
      padding: '4px 14px 8px',
      flexShrink: 0,
    }}>
      {rows}
    </div>
  )
}

function HeartbeatSection({
  heartBeatCount = '—',
  lastAction = '—',
  online = true,
  heartBeatActive = false,
}: Required<Pick<RightPanelProps, 'heartBeatCount' | 'lastAction'>> & { online?: boolean; heartBeatActive?: boolean }) {
  const hasData = heartBeatCount !== '—'

  return (
    <div style={{
      padding: '10px 14px 12px',
      borderBottom: '1px solid rgba(56, 189, 248, 0.1)',
      flexShrink: 0,
      margin: '0 6px',
    }}>
      {/* 标题行 */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginBottom: '4px',
      }}>
        <div>
          <div style={{
            fontSize: '10px',
            letterSpacing: '1.5px',
            color: 'rgba(148, 163, 184, 0.45)',
            fontWeight: 600,
          }}>HEARTBEAT</div>
          <div style={{
            fontSize: '16px',
            fontWeight: 700,
            color: 'rgba(56, 189, 248, 0.95)',
            letterSpacing: '1px',
            marginTop: '-1px',
          }}>意识心跳</div>
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          {/* 2026-08-15 DingDong 对齐: 状态胶囊 + BPM 大数字(活动 96 / 静息 68)。
              心跳专用琥珀色(生命信号), 与连接态青色分离——一望即分 */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 10px',
            borderRadius: '12px',
            background: 'rgba(251, 191, 36, 0.08)',
            border: '1px solid rgba(251, 191, 36, 0.18)',
            marginBottom: '2px',
          }}>
            <span style={{
              display: 'inline-block',
              width: '5px',
              height: '5px',
              borderRadius: '50%',
              background: heartBeatActive ? '#fbbf24' : 'rgba(148, 163, 184, 0.6)',
              boxShadow: heartBeatActive ? '0 0 6px rgba(251, 191, 36, 0.8)' : 'none',
              animation: heartBeatActive ? 'heartbeat-pulse 1.2s ease-in-out infinite' : 'none',
            }} />
            <span style={{
              fontSize: '10px',
              color: online ? 'rgba(251, 191, 36, 0.9)' : 'rgba(248, 113, 113, 0.9)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {!online
                ? '离线'
                : !hasData
                  ? '等待心跳'
                  : heartBeatActive
                    ? '活跃'
                    : '静息'}
            </span>
          </div>
          {hasData && (
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '2px',
              marginBottom: '2px',
            }}>
              <span style={{
                fontSize: '17px',
                fontWeight: 700,
                color: heartBeatActive ? '#fbbf24' : 'rgba(148, 163, 184, 0.55)',
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.5px',
              }}>{heartBeatActive ? 96 : 68}</span>
              <span style={{
                fontSize: '9px',
                color: 'rgba(148, 163, 184, 0.5)',
              }}>BPM</span>
            </div>
          )}
        </div>
      </div>

      {/* ECG画布（Canvas 实时滚动; 无数据时平坦虚线 + 提示）
          2026-08-15 DingDong 对齐: 淡琥珀底渐变(监护仪纸带感) */}
      <HeartBeatEcg active={heartBeatActive} hasData={hasData} online={online} />

      {/* 底部数字行 */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: '6px',
        padding: '0 2px',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '4px',
        }}>
          <span style={{
            fontSize: '13px',
            fontWeight: 700,
            color: 'rgba(125, 211, 252, 0.95)',
            fontVariantNumeric: 'tabular-nums',
          }}>{heartBeatCount}</span>
          {heartBeatCount !== '—' && (
            <span style={{
              fontSize: '10px',
              color: 'rgba(148, 163, 184, 0.6)',
            }}>次心跳</span>
          )}
        </div>
        <span style={{
          fontSize: '10px',
          color: 'rgba(148, 163, 184, 0.5)',
        }}>{lastAction}</span>
      </div>
    </div>
  )
}

/* ─── 心跳在线底部状态栏 ───
   2026-08-14(诚实化): 此前恒显"心跳在线"——无真实状态支撑的假在线。
   现绑定真实连接态(SSE 连接, 即 wsConnected): 在线=青蓝脉冲, 断连=红色"连接中断"。 */
function HeartbeatOnlineBar({ online }: { online: boolean }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '8px 14px',
      borderTop: '1px solid rgba(56, 189, 248, 0.08)',
      background: 'rgba(15, 20, 32, 0.4)',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span style={{
          display: 'inline-block',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: online ? '#38bdf8' : '#f87171',
          boxShadow: online ? '0 0 6px rgba(56, 189, 248, 0.8)' : '0 0 6px rgba(248, 113, 113, 0.8)',
          animation: online ? 'heartbeat-pulse 1.2s ease-in-out infinite' : 'none',
        }} />
        <span style={{
          fontSize: '10px',
          color: online ? 'rgba(125, 211, 252, 0.85)' : 'rgba(248, 113, 113, 0.9)',
        }}>{online ? '心跳在线' : '连接中断'}</span>
      </div>
      <span style={{
        fontSize: '10px',
        color: 'rgba(148, 163, 184, 0.55)',
      }}>{online ? '周期唤醒 · 持续思考' : '等待重连…'}</span>
    </div>
  )
}

/* ─── 本轮工具执行状态卡（2026-08-15 合并后右栏唯一过程区块） ─── */
// 数据源: flow.toolEvents(running/done/error)。2026-08-14 ag-ui 二次分析:
// 参数行点击展开全文(原 80 字单行截断不可读)。2026-08-15 左右日志合并后,
// 本区块独立为右栏"当前进行中"视图, 自带头部与执行中徽标。
/* ─── 2026-08-19 三栏联动轮: 步骤时间轴(M4) ───
   数据源: useTurnState.steps(STEP_STARTED 开/STEP_FINISHED 关, 前端算耗时)。
   点击步骤行 → 定位当前轮(父级 onRoundSelect: 中栏滚动 + 左栏高亮)。
   默认展示最近 3 步, 展开看全量——长 run 步骤数可到几十。 */
function StepTimeline({ steps, onRoundSelect }: {
  steps: import('../../hooks/useTurnState').TurnStepInfo[]
  onRoundSelect?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? steps : steps.slice(-3)
  if (steps.length === 0) return null
  const fmt = (ms?: number) => {
    if (ms == null) return ''
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }
  return (
    <div style={{
      padding: '0 12px 6px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      borderBottom: '1px solid rgba(56, 189, 248, 0.06)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10,
        fontWeight: 600,
        color: 'rgba(148, 163, 184, 0.55)',
        letterSpacing: '0.05em',
      }}>
        <span>步骤时间轴</span>
        <span style={{ fontSize: 9, color: 'rgba(148, 163, 184, 0.4)' }}>
          {steps.length} 步 · {steps.reduce((n, s) => n + s.toolCalls, 0)} 工具
        </span>
        {steps.length > 3 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? '收起' : '展开全部步骤'}
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              padding: '0 6px',
              borderRadius: 999,
              cursor: 'pointer',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(148, 163, 184, 0.7)',
            }}
          >
            {expanded ? '收起' : `+${steps.length - 3}`}
          </button>
        )}
      </div>
      {visible.slice().reverse().map(s => (
        <button
          type="button"
          key={s.stepIndex}
          onClick={() => onRoundSelect?.()}
          title="点击定位到该轮的对话与工具过程"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            textAlign: 'left',
            background: 'none',
            border: 'none',
            padding: '2px 4px',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 10,
            color: 'rgba(191, 236, 255, 0.85)',
          }}
        >
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: s.status === 'running'
              ? 'rgba(52, 211, 153, 0.95)'
              : s.status === 'error'
                ? 'rgba(248, 113, 113, 0.95)'
                : 'rgba(148, 163, 184, 0.55)',
            boxShadow: s.status === 'running' ? '0 0 6px rgba(52,211,153,0.8)' : 'none',
            animation: s.status === 'running' ? 'heartbeat-pulse 1.4s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontWeight: 600, flexShrink: 0 }}>步骤 {s.stepIndex}</span>
          <span style={{ color: 'rgba(148, 163, 184, 0.7)' }}>
            {s.status === 'running' ? '执行中…' : fmt(s.durationMs)}
          </span>
          {s.toolCalls > 0 && (
            <span style={{ color: 'rgba(168, 85, 247, 0.85)', fontVariantNumeric: 'tabular-nums' }}>
              {s.toolCalls} 工具
            </span>
          )}
          {s.status === 'error' && (
            <span style={{ color: '#f87171', fontWeight: 600, marginLeft: 'auto' }}>失败</span>
          )}
        </button>
      ))}
    </div>
  )
}

function ToolRunSection({ runs, activeToolCount = 0, onRoundSelect }: {
  runs: NonNullable<RightPanelProps['toolRuns']>
  activeToolCount?: number
  onRoundSelect?: () => void
}) {
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set())
  const toggleArgs = (toolId: string) => {
    setExpandedArgs(prev => {
      const next = new Set(prev)
      if (next.has(toolId)) next.delete(toolId)
      else next.add(toolId)
      return next
    })
  }
  // Task 7 审查修复(2026-08-18): 步骤 chip 内联于本标题行; ToolRunSection
  // 全应用仅挂载一次(VoiceShell 右栏), useTurnState 于此恰好一份订阅
  const turnState = useTurnState()
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      borderTop: '1px solid rgba(56, 189, 248, 0.08)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        padding: '10px 14px 6px',
        fontSize: '11px',
        fontWeight: 600,
        color: 'rgba(191, 236, 255, 0.8)',
        letterSpacing: '0.06em',
        flexShrink: 0,
      }}>
        <span>本轮工具执行</span>
        {turnState.running && (
          <span className="voice-shell-step-chip" title={`run ${turnState.runId ?? ''}`}>步骤 {turnState.step}</span>
        )}
        {activeToolCount > 0 && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 9,
            padding: '1px 7px',
            borderRadius: 999,
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            color: '#34d399',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#34d399', animation: 'heartbeat-pulse 1.2s ease-in-out infinite' }} />
            {activeToolCount} 个执行中
          </span>
        )}
      </div>
      {/* 2026-08-19 三栏联动轮: 步骤时间轴(点击定位当前轮) */}
      <StepTimeline steps={turnState.steps} onRoundSelect={onRoundSelect} />
      <div style={{
        overflowY: 'auto',
        padding: '0 12px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {runs.length === 0 && (
          <div style={{ fontSize: 10, color: 'rgba(148, 163, 184, 0.45)', padding: '4px 2px' }}>
            暂无工具调用
          </div>
        )}
        {runs.slice(-6).reverse().map(r => {
          const expanded = expandedArgs.has(r.toolId)
          return (
          <div
            key={r.toolId}
            /* 2026-08-19 三栏联动轮: 工具卡点击 → 定位当前轮(中栏滚动+左栏高亮) */
            onClick={() => onRoundSelect?.()}
            title="点击定位到该轮的对话"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '5px 8px',
              borderRadius: 5,
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.04)',
              cursor: 'pointer',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                flexShrink: 0,
                background: r.status === 'running'
                  ? 'rgba(52, 211, 153, 0.95)'
                  : r.status === 'error'
                    ? 'rgba(248, 113, 113, 0.95)'
                    : 'rgba(148, 163, 184, 0.55)',
                boxShadow: r.status === 'running' ? '0 0 6px rgba(52,211,153,0.8)' : 'none',
                animation: r.status === 'running' ? 'heartbeat-pulse 1.4s ease-in-out infinite' : 'none',
              }} />
              <span style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11,
                color: 'rgba(228, 240, 255, 0.85)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'monospace',
              }}>
                {r.toolName}
              </span>
              <span style={{
                flexShrink: 0,
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'rgba(255,255,255,0.05)',
                color: r.status === 'running'
                  ? 'rgba(52, 211, 153, 0.9)'
                  : r.status === 'error'
                    ? 'rgba(248, 113, 113, 0.9)'
                    : 'rgba(148, 163, 184, 0.7)',
              }}>
                {r.status === 'running' ? '进行中' : r.status === 'error' ? '失败' : '完成'}
              </span>
            </div>
            {r.args && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleArgs(r.toolId) }}
                title={expanded ? '点击收起参数' : '点击展开完整参数'}
                style={{
                  cursor: 'pointer',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  fontFamily: 'monospace',
                  fontSize: 10,
                  lineHeight: 1.5,
                  color: expanded ? 'rgba(191, 236, 255, 0.85)' : 'rgba(148, 163, 184, 0.6)',
                  overflow: 'hidden',
                  whiteSpace: expanded ? 'pre-wrap' : 'nowrap',
                  textOverflow: expanded ? undefined : 'ellipsis',
                  maxHeight: expanded ? 120 : undefined,
                  overflowY: expanded ? 'auto' : undefined,
                  paddingLeft: 13,
                  wordBreak: 'break-all',
                }}
              >
                {expanded ? r.args : (r.args.length > 80 ? `${r.args.slice(0, 80)}…` : r.args)}
                {expanded && <span style={{ color: 'rgba(125, 211, 252, 0.6)', marginLeft: 6 }}>[收起]</span>}
              </button>
            )}
            {r.status === 'running' ? (
              <div style={{ fontSize: 10, color: 'rgba(52, 211, 153, 0.6)', fontStyle: 'italic' }}>
                执行中…
              </div>
            ) : r.summary ? (
              <div style={{
                fontSize: 10,
                lineHeight: 1.4,
                color: r.status === 'error' ? 'rgba(248, 113, 113, 0.85)' : 'rgba(148, 163, 184, 0.75)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}>
                {r.summary}
              </div>
            ) : null}
          </div>
          )
        })}
      </div>
    </div>
  )
}

export function AgentRightPanel({
  statusLabel = '已连接',
  nodes = '—',
  connections = '—',
  tokPerSec = '—',
  recallPerHour = '—',
  extractPerHour = '—',
  heartBeatCount = '—',
  lastAction = '—',
  heartBeatActive = false,
  toolRuns = [],
  activeToolCount = 0,
  online = false,
  services = null,
  voiceEngineOk = true,
  onRoundSelect,
}: RightPanelProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      width: '100%',
      background: 'rgba(12, 16, 26, 0.95)',
      border: '1px solid rgba(56, 189, 248, 0.12)',
      borderRadius: '12px',
      overflow: 'hidden',
      backdropFilter: 'blur(18px)',
      WebkitBackdropFilter: 'blur(18px)',
    }}>
      <TopHeader />
      <StatusMetricsRow
        statusLabel={statusLabel}
        nodes={nodes}
        connections={connections}
        tokPerSec={tokPerSec}
        recallPerHour={recallPerHour}
        extractPerHour={extractPerHour}
      />
      {/* 2026-08-15 用户要求: 多服务连接状态行——主服务已并入上方指标,
          此处展示渠道(按配置)/语音引擎/AI 模型 */}
      <ServiceStatusBlock services={services} voiceEngineOk={voiceEngineOk} />
      <HeartbeatSection
        heartBeatCount={heartBeatCount}
        lastAction={lastAction}
        online={online}
        heartBeatActive={heartBeatActive}
      />
      {/* Plan 实体(Plan/Artifact 深化轮): 执行计划进度投影——模型 PlanCreate/PlanUpdate
          驱动, plan:updated SSE 实时刷新; 无计划时不渲染 */}
      <PlanSection />
      {/* 2026-08-15 左右日志合并: 历史类区块(行动日志/思考与工具)并入左栏
          全量事件时间线——右栏聚焦"当前进行中": 本轮工具执行过程卡。
          2026-08-19 三栏联动轮: onRoundSelect 透传(工具卡/步骤行点击定位) */}
      <ToolRunSection runs={toolRuns} activeToolCount={activeToolCount} onRoundSelect={onRoundSelect} />
      <HeartbeatOnlineBar online={online} />
    </div>
  )
}
