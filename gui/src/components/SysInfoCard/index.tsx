/**
 * SysInfoCard — 系统信息卡（2026-08-31 M6）
 *
 * 心跳卡正下方、默认缩起。展开后两头:
 *   - 事件日志(系统日志流, 与左栏同源 LogEntry)
 *   - 工具执行(本轮工具调用, 与右栏同源 toolEvents)
 * 玻璃卡壳 ShellFloatCard, 可拖动; 缩起/展开持久化。
 */
import { useEffect, useState } from 'react'
import { ShellFloatCard } from '../ShellFloatCard'
// 2026-09-03 方案A改版(回合摘要卡): 与 AgentLeftPanel 共用的回合分组/语义化摘要
import {
  cleanLogText,
  groupLogsByRound,
  groupStatusIcon,
  summarizeGroup,
} from '../../lib/log-summary'


export interface SysLogEntry {
  id: string
  type: string
  text: string
  time: string
  desc?: string
  ok?: boolean
  level?: string
  seq?: number
}

export interface SysToolRun {
  toolId?: string
  toolName: string
  status: 'running' | 'done' | 'error'
  summary?: string
}

export interface SysInfoCardProps {
  logs: SysLogEntry[]
  toolRuns?: SysToolRun[]
  activeToolCount?: number
  /** 透传 ShellFloatCard resetNonce——变更时清位置持久化回默认（2026-09-07：
   *  此前写死 0，"恢复默认布局"对其余三卡生效唯独日志卡拖后无法复位） */
  resetNonce?: number
}

const LOG_ICON: Record<string, string> = {
  user: '💬', thinking: '🧠', tool: '🔧', complete: '✔', system: 'ℹ',
}

export function SysInfoCard({ logs, toolRuns = [], activeToolCount = 0, resetNonce = 0 }: SysInfoCardProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('voice-shell.sysinfo.collapsed') !== '0' } catch { return true }
  })
  const [tab, setTab] = useState<'logs' | 'tools'>('logs')
  // 方案A改版: 回合折叠覆盖(用户点箭头写入); 默认态 = 仅最新回合展开
  const [collapseOverride, setCollapseOverride] = useState<Map<string, boolean>>(new Map())
  useEffect(() => {
    try { localStorage.setItem('voice-shell.sysinfo.collapsed', collapsed ? '1' : '0') } catch { /* 忽略 */ }
  }, [collapsed])

  const recent = logs.slice(-60)
  const running = toolRuns.filter(t => t.status === 'running').length
  // 方案A: 轮次分组 + 每组摘要(折叠态一行语义/展开态合并步骤)
  const groups = groupLogsByRound(recent)
  const toggleGroup = (key: string, collapsedNow: boolean) => {
    setCollapseOverride(prev => {
      const next = new Map(prev)
      next.set(key, !collapsedNow)
      if (next.size > 40) {
        const first = next.keys().next().value
        if (first !== undefined) next.delete(first)
      }
      return next
    })
  }

  return (
    <ShellFloatCard
      cardKey="sysinfo"
      title="📟 日志"
      width={264}
      defaultOffset={{ x: 24, y: 420 }}
      resetNonce={resetNonce}
      blur="sm"
      dragOnButtons
    >
      {collapsed ? (
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button
            type="button"
            className="voice-shell-console-btn"
            style={{ fontSize: 12 }}
            onClick={() => setCollapsed(false)}
          >
            ⤢ 展开
          </button>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
            {logs.length} 条日志 · {toolRuns.length} 次工具{activeToolCount > 0 ? ` · ${activeToolCount} 执行中` : ''}
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', height: 300, padding: '0 10px 8px' }}>
          <div style={{ display: 'flex', gap: 6, margin: '6px 0' }}>
            <button
              type="button"
              className={`voice-shell-console-btn${tab === 'logs' ? ' is-active' : ''}`}
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={() => setTab('logs')}
            >
              事件日志
            </button>
            <button
              type="button"
              className={`voice-shell-console-btn${tab === 'tools' ? ' is-active' : ''}`}
              style={{ fontSize: 11, padding: '3px 10px' }}
              onClick={() => setTab('tools')}
            >
              工具执行{running > 0 ? ` (${running})` : ''}
            </button>
            <button
              type="button"
              className="voice-shell-console-btn"
              style={{ fontSize: 11, padding: '3px 10px', marginLeft: 'auto' }}
              onClick={() => setCollapsed(true)}
              title="收起"
            >
              ▾ 收起
            </button>
          </div>
          {tab === 'logs' ? (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {groups.length === 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>暂无日志</span>}
              {groups.map((g, gi) => {
                const groupKey = g.user?.id || g.systems[0]?.id || `g${gi}`
                const isLatest = gi === groups.length - 1
                const folded = collapseOverride.has(groupKey) ? collapseOverride.get(groupKey)! : !isLatest
                const sum = summarizeGroup(g)
                const status = groupStatusIcon(sum)
                // 展开态步骤: 工具(合并)+完成; 系统 info 行不进步骤, warn/error 保留
                const stepsToRender = sum.steps.filter(s => s.kind !== 'system' || s.entry.level === 'error' || s.entry.level === 'warn')
                return (
                  <div key={groupKey} style={{
                    borderRadius: 6,
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.04)',
                    padding: '3px 5px',
                    display: 'flex', flexDirection: 'column', gap: 1,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(groupKey, folded)}
                        title={folded ? '展开该轮事件' : '折叠该轮事件'}
                        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 9, flexShrink: 0, width: 11 }}
                      >
                        {folded ? '▸' : '▾'}
                      </button>
                      <span aria-hidden="true">{LOG_ICON[g.user?.type || ''] || 'ℹ'}</span>
                      <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: g.user ? 600 : 400 }}>
                        {cleanLogText(g.user?.text || g.systems[0]?.text || '')}
                      </span>
                      <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', fontSize: 10 }}>
                        {g.user?.time || g.systems[0]?.time}
                      </span>
                    </div>
                    {folded ? (
                      g.systems.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 0 1px 16px', fontSize: 10 }}>
                          <span style={{ color: status.color, flexShrink: 0 }}>{status.icon}</span>
                          <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.text}</span>
                        </div>
                      )
                    ) : (
                      stepsToRender.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginLeft: 10, paddingLeft: 7, borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
                          {stepsToRender.map((st, i) => (
                            <div key={`${groupKey}-s${i}`} style={{ display: 'flex', gap: 5, alignItems: 'baseline', fontSize: 10.5, lineHeight: 1.4 }} title={st.entry.desc || undefined}>
                              <span style={{ flexShrink: 0, color: st.ok === false ? '#f87171' : st.done ? '#4ade80' : '#fbbf24' }}>
                                {st.done ? (st.ok === false ? '✗' : '✓') : '●'}
                              </span>
                              <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                                {st.kind === 'complete' ? `✨ ${st.name}` : st.name}
                              </span>
                              <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums', fontSize: 9.5 }}>{st.time}</span>
                            </div>
                          ))}
                        </div>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {toolRuns.length === 0 && <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center', padding: 12 }}>暂无工具调用</span>}
              {toolRuns.slice(-12).reverse().map((t, i) => (
                <div key={`${t.toolId || t.toolName}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                  <span
                    className="system-status-dot"
                    style={{
                      width: 6, height: 6, flexShrink: 0,
                      background: t.status === 'done' ? '#4ade80' : t.status === 'error' ? '#f87171' : '#fbbf24',
                      boxShadow: t.status === 'running' ? '0 0 6px rgba(251,191,36,0.8)' : 'none',
                      borderRadius: '50%',
                    }}
                  />
                  <span style={{ color: 'var(--text-primary)' }}>{t.toolName}</span>
                  <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {t.status === 'running' ? '执行中' : (t.summary || t.status)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </ShellFloatCard>
  )
}

export default SysInfoCard
