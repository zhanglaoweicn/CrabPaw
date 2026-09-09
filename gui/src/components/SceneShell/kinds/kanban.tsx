/**
 * KanbanCard — 看板组件 / 甘特进度条（场景九日程 kinds 专门化）
 */

/* ── 模块级 keyframes 注入（一次，安全兼容 SSR/jsdom） ── */
if (typeof document !== 'undefined') {
  const styleId = 'kanban-kind-keyframes'
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      @keyframes scene-gantt-glow {
        0% { background-position: 0% 0; }
        100% { background-position: 200% 0; }
      }
      @keyframes scene-risk-pulse {
        0%, 100% {
          opacity: 1;
          text-shadow: 0 0 4px rgba(239, 68, 68, 0.4), 0 0 8px rgba(239, 68, 68, 0.15);
        }
        50% {
          opacity: 0.6;
          text-shadow: 0 0 14px rgba(239, 68, 68, 0.75), 0 0 28px rgba(239, 68, 68, 0.25);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .kb-gantt-fill { animation: none !important; }
        .kb-risk-icon { animation: none !important; }
      }
    `
    document.head.appendChild(style)
  }
}

export interface KanbanCard {
  id: string
  title: string
  tags?: string[]
  dueAt?: number
  color?: string
}

export interface KanbanColumn {
  id: string
  title: string
  cards: KanbanCard[]
}

/** 甘特进度条——单个任务 */
export interface GanttTask {
  name: string
  /** 进度百分比 0-100；非法值 clamp 兜底 */
  progress: number
  /** 风险标记——true 时显示红色 ⚠️ 脉冲 */
  risk?: boolean
}

export interface KanbanData {
  title?: string
  columns: KanbanColumn[]
  /** 甘特进度条模式——任务列表；存在时在看板下方渲染甘特条 */
  tasks?: GanttTask[]
}

const COLUMN_COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#22c55e', '#a78bfa', '#fb7185', '#38bdf8']

/** progress 值 clamp 到 0-100；NaN/Infinity 兜底为 0 */
function clampProgress(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, v))
}

export function KanbanCard({ data, onClose }: { data: KanbanData; onClose?: () => void }) {
  const columns = data.columns || []
  const tasks: GanttTask[] | undefined = data.tasks

  /* ── 甘特进度条（tasks 存在时渲染） ── */
  const ganttSection = tasks && tasks.length > 0 ? (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
      {/* 甘特标题 */}
      <div style={{
        fontSize: 14,
        color: '#818cf8',
        fontWeight: 600,
        marginBottom: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}>
        <span>📊 进度</span>
      </div>

      {/* 任务进度条列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tasks.map((task, i) => {
          const pct = clampProgress(task.progress)
          const hasRisk = task.risk === true
          return (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              {/* 任务名 */}
              <span style={{
                fontSize: 14,
                color: '#cbd5e1',
                minWidth: 60,
                maxWidth: 90,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}>
                {task.name}
              </span>

              {/* 进度条容器 */}
              <div style={{
                flex: 1,
                height: 6,
                borderRadius: 3,
                background: 'rgba(255,255,255,0.06)',
                overflow: 'hidden',
                position: 'relative',
              }}>
                {/* 渐变填充条 */}
                <div
                  className="kb-gantt-fill"
                  style={{
                    height: '100%',
                    borderRadius: 3,
                    width: `${pct}%`,
                    background: hasRisk
                      ? 'linear-gradient(90deg, #f97316, #ef4444, #f97316)'
                      : 'linear-gradient(90deg, #6366f1, #22d3ee, #a78bfa)',
                    backgroundSize: '200% 100%',
                    animation: 'scene-gantt-glow 2.4s linear infinite',
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>

              {/* 百分比数字 */}
              <span style={{
                fontSize: 8,
                color: hasRisk ? '#f87171' : '#94a3b8',
                fontWeight: 600,
                minWidth: 26,
                textAlign: 'right',
                flexShrink: 0,
                fontFamily: '"Cascadia Code", Consolas, monospace',
              }}>
                {Math.round(pct)}%
              </span>

              {/* 风险标记 */}
              {hasRisk && (
                <span
                  className="kb-risk-icon"
                  style={{
                    fontSize: 11,
                    color: '#ef4444',
                    flexShrink: 0,
                    animation: 'scene-risk-pulse 1.4s ease-in-out infinite',
                    lineHeight: 1,
                  }}
                  title="风险任务"
                >
                  ⚠️
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  ) : null

  /* ── 原有看板列渲染（不变） ── */
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: '14px',
      background: 'rgba(24,24,36,0.88)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      minWidth: 260,
      maxWidth: 400,
      overflowX: 'auto',
      position: 'relative',
    }}>
      {onClose && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 6,
            border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.06)',
            color: 'var(--text-muted, #999)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, zIndex: 2,
          }}
          title="关闭"
        >✕</button>
      )}
      {data.title && (
        <div style={{ fontSize: 14, color: '#818cf8', fontWeight: 600, marginBottom: 8 }}>
          📋 {data.title}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {columns.map((col, ci) => {
          const color = COLUMN_COLORS[ci % COLUMN_COLORS.length]
          return (
            <div key={col.id} style={{
              flex: '0 0 auto',
              minWidth: 120, maxWidth: 140,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid rgba(255,255,255,0.04)`,
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '5px 8px',
                fontSize: 14, fontWeight: 700, color,
                borderBottom: `1px solid ${color}22`,
                background: `${color}11`,
              }}>
                {col.title}
                <span style={{ float: 'right', opacity: 0.6, fontSize: 8 }}>
                  {col.cards.length}
                </span>
              </div>
              <div style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {col.cards.slice(0, 6).map(card => (
                  <div key={card.id} style={{
                    padding: '5px 7px',
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.04)',
                    borderLeft: `2px solid ${card.color || color}`,
                  }}>
                    <div style={{ fontSize: 14, color: '#e2e8f0', lineHeight: 1.3 }}>
                      {card.title}
                    </div>
                    {(card.tags || []).length > 0 && (
                      <div style={{ display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap' }}>
                        {(card.tags || []).slice(0, 3).map(tag => (
                          <span key={tag} style={{
                            fontSize: 7, padding: '1px 4px',
                            borderRadius: 3, background: `${color}18`, color,
                          }}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {card.dueAt && (
                      <div style={{ fontSize: 7, color: '#64748b', marginTop: 2 }}>
                        {new Date(card.dueAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                      </div>
                    )}
                  </div>
                ))}
                {col.cards.length > 6 && (
                  <div style={{ fontSize: 8, color: '#475569', textAlign: 'center', padding: 2 }}>
                    +{col.cards.length - 6} 项
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 甘特进度条（tasks 存在时才渲染——缺字段时行为不变） */}
      {ganttSection}
    </div>
  )
}
