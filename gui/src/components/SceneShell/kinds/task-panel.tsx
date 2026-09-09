/**
 * TaskPanelCard — 任务面板卡片（kind: task_panel）
 *
 * 视觉：全息 HUD（玻璃拟态 + 扫描线 + 状态灯）+ 状态徽章 + 阶段进度条 +
 * 当前动作 + 展开工具链（技能调用紫色标识）+ 取消按钮。
 * 完成态由父组件 morph 为结果卡（text/metric/image），本卡仅负责过程呈现。
 *
 * 2026-08-03: 技能调用识别——skill_manage/SkillsList/SkillView 显示为技能卡片
 */

import { useState } from 'react'
import type { TaskPanel } from '../../../lib/task-panel-store'
import './task-panel.css'

export interface TaskPanelData extends TaskPanel {}

const STATUS_META: Record<TaskPanelData['status'], { label: string; color: string; cls: string }> = {
  running: { label: '进行中', color: '#f97316', cls: 'tp-dot--running' },
  success: { label: '完成', color: '#4ade80', cls: 'tp-dot--success' },
  error: { label: '失败', color: '#f87171', cls: 'tp-dot--error' },
  cancelled: { label: '已取消', color: '#94a3b8', cls: 'tp-dot--cancelled' },
  // 2026-08-07: 长时间无事件兜底标记(断线/事件丢失)
  stale: { label: '已过期', color: '#fbbf24', cls: 'tp-dot--stale' },
}

// 2026-08-03: 技能相关工具识别 → 显示技能卡片视觉（📦 图标 + 紫色工具名）
const SKILL_TOOLS: Record<string, { icon: string; label: (summary: string) => string }> = {
  skill_manage: {
    icon: '📦',
    label: (s) => {
      const m = /(?:技能|skill)?[:\s]?([a-z0-9_.-]+)/i.exec(s || '')
      return m ? `技能 ${m[1]}` : '技能执行'
    },
  },
  SkillsList: { icon: '📜', label: () => '技能列表' },
  SkillView: { icon: '📖', label: () => '技能加载' },
  execute_skill: { icon: '📦', label: () => '技能执行' },
  executeSkill: { icon: '📦', label: () => '技能执行' },
}

function describeTool(toolName: string, summary: string): { icon: string; label: string; isSkill: boolean } {
  const hit = SKILL_TOOLS[toolName]
  if (hit) return { icon: hit.icon, label: hit.label(summary), isSkill: true }
  return { icon: '🔧', label: toolName, isSkill: false }
}

export function TaskPanelCard({ panel, onCancel, compact = false, onRetry }: { panel: TaskPanelData; onCancel?: (id: string) => void; compact?: boolean; onRetry?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const meta = STATUS_META[panel.status] || STATUS_META.running

  // 2026-08-04: 单行进度条模式（长任务）——图标+标题+进度+取消，克制不占屏。
  // 2026-08-13: dot 随状态换色(原硬编码 running)；error 卡显示重试按钮。
  if (compact) {
    return (
      <div className="tp-card tp-card--compact">
        <span className={`tp-dot ${meta.cls}`} />
        <span className="tp-title">{panel.title}</span>
        <div className="tp-progress tp-progress--compact">
          <div className="tp-progress-fill" style={{ width: `${Math.min(100, Math.max(0, panel.progress))}%` }} />
        </div>
        {panel.status === 'error' && typeof onRetry === 'function' && (
          <button type="button" className="tp-retry-btn" onClick={onRetry} title="重试原任务">↻</button>
        )}
        {typeof onCancel === 'function' && (
          <button type="button" className="tp-cancel-btn" onClick={() => onCancel(panel.id)} title="取消任务">✕</button>
        )}
      </div>
    )
  }

  return (
    <div className="tp-card">
      {/* 标题行 + 状态徽章 */}
      <div className="tp-head">
        <span className="tp-title">
          <span className={`tp-dot ${meta.cls}`} />
          {panel.title}
        </span>
        <span className="tp-badge" style={{ color: meta.color, border: `1px solid ${meta.color}55`, background: `${meta.color}14` }}>
          {meta.label}
        </span>
      </div>

      {/* 阶段步骤（workflow 时显示） */}
      {panel.steps && panel.steps.length > 0 && (
        <div className="tp-steps">
          {panel.steps.map((s, i) => (
            <div
              key={s.name || i}
              className={`tp-step ${s.status === 'done' ? 'tp-step--done' : s.status === 'running' ? 'tp-step--running' : s.status === 'error' ? 'tp-step--error' : 'tp-step--pending'}`}
            >
              <span className="tp-step-mark">{s.status === 'done' ? '✓' : s.status === 'running' ? '◌' : s.status === 'error' ? '✕' : '·'}</span>
              <span>{s.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* 进度条（仅进行中显示；完成态隐藏——内容无用即消失） */}
      {panel.status === 'running' && (
        <div className="tp-progress">
          <div className="tp-progress-fill" style={{ width: `${Math.min(100, Math.max(0, panel.progress))}%` }} />
        </div>
      )}

      {/* 当前动作（仅进行中显示） */}
      {panel.status === 'running' && panel.currentAction && (
        <div className="tp-action">
          <span className="tp-action-caret">▸</span>
          <span>{panel.currentAction}</span>
        </div>
      )}

      {/* 展开工具链 */}
      {panel.toolHistory.length > 0 && (
        <>
          <button
            type="button"
            className="tp-tools-toggle"
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? '收起工具链 ▴' : `工具链 (${panel.toolHistory.length}) ▾`}
          </button>
          {expanded && (
            <div className="tp-tools">
              {panel.toolHistory.map((t) => {
                const desc = describeTool(t.toolName, t.summary)
                return (
                  <div key={`${t.toolName}-${t.ts}`} className={`tp-tool${t.status === 'error' ? ' tp-tool--error' : ''}${desc.isSkill ? ' tp-tool--skill' : ''}`}>
                    <span className="tp-tool-name">
                      {desc.icon} {desc.label}
                    </span>
                    <span className="tp-tool-summary" title={t.summary}>{t.summary}</span>
                    <span className={t.status === 'error' ? 'tp-tool-status--err' : t.status === 'running' ? 'tp-tool-status tp-tool-status--running' : 'tp-tool-status'}>
                      {t.status === 'error' ? '✕' : t.status === 'running' ? '◌' : '✓'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* 操作：取消 / 失败重试 */}
      {panel.status === 'running' && typeof onCancel === 'function' && (
        <div className="tp-cancel">
          <button
            type="button"
            className="tp-cancel-btn"
            onClick={() => onCancel(panel.id)}
          >
            取消任务
          </button>
        </div>
      )}
      {panel.status === 'error' && typeof onRetry === 'function' && (
        <div className="tp-cancel">
          <button
            type="button"
            className="tp-retry-btn tp-retry-btn--full"
            onClick={onRetry}
          >
            重试原任务
          </button>
        </div>
      )}
    </div>
  )
}
