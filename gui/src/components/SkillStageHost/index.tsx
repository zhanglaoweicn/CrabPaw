/**
 * SkillStageHost — 技能执行全息卡（2026-08-04）
 *
 * 表现层:任何技能执行(skill_manage action=execute)以居中浮动全息卡呈现——
 * 技能 emoji + 名称 + "处理中…"(不冒充进度)+ 完成 ✓ / 失败 ✕ 状态。
 * 数据源:后端 executeSkillAdvanced 广播 skill:started/completed/error(不改技能系统本身)。
 *
 * 2026-08-12(P1-5): 移除 2.5s 盲推进步骤动画——executor 无真实阶段回调,旧实现
 * 每 2.5s 点亮下一步(可能 3/5 时突然完成),视觉进度与真实执行无关。
 * 现改为:执行中步骤列表保持全灰 + "处理中…"脉冲文字,完成/失败事件到达时照常显示 ✓/✕ 与摘要。
 *
 * 分工:
 * - 文档类技能(document 类别)→ DocReader 全屏生成舱接管(此组件忽略,不重复显示)
 * - 其余技能 → 本组件全息卡(非打断,完成 6s / 失败 15s 自动淡出)
 * 关闭:语音"关闭技能卡"(voice-panel-commands kind:skill)或点击 ✕
 */

import { useEffect, useRef, useState } from 'react'
import { useSse } from '../../hooks/useSSE'
import { registerCommandHost } from '../../lib/ui-command-registry'
import './styles.css'

interface SkillStage {
  skill: string
  displayName: string
  emoji: string
  category: string
  steps: string[]
  status: 'running' | 'success' | 'error'
  summary?: string
  error?: string
  outputPath?: string
  durationMs?: number
}

// 文档类技能由 DocReader 全屏舱接管
const DOC_CATEGORY_RE = /document|doc|report|presentation|article|word|pdf|ppt|html/i

const STATUS_META = {
  running: { label: '执行中', cls: 'skill-stage-badge--running' },
  success: { label: '完成', cls: 'skill-stage-badge--success' },
  error: { label: '失败', cls: 'skill-stage-badge--error' },
} as const

export function SkillStageHost() {
  const [stage, setStage] = useState<SkillStage | null>(null)
  const [entered, setEntered] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 记录关闭时的 skill：延迟移除回调按 skill 身份匹配，防止误清新技能卡
  const stageRef = useRef<SkillStage | null>(null)
  stageRef.current = stage

  const closeStage = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    setEntered(false)
    // 记录关闭时的 skill（从 ref 读取最新值，window 注册的 close 闭包无陈旧问题）
    const closingSkill = stageRef.current?.skill ?? null
    setTimeout(() => {
      // 仅当当前卡仍是关闭时的 skill 才移除——新技能卡不受影响
      setStage(prev => (prev && prev.skill === closingSkill) ? null : prev)
    }, 300)
  }

  // 语音/全局关闭接口
  useEffect(() => {
    // A1: 经 ui-command-registry 注册(旧 window.__skillStage 退役)
    const unregisterSkill = registerCommandHost('skillStage', { close: closeStage })
    return () => { unregisterSkill() }
  }, [])

  // 2026-08-12(P1-5): 移除 2.5s 盲推进步骤动画——executor 无真实阶段回调,
  // 视觉进度与真实执行无关。执行中只显示"处理中…",不冒充进度。

  // 完成 6s / 失败 15s 自动淡出
  useEffect(() => {
    if (!stage || stage.status === 'running') return
    const ms = stage.status === 'success' ? 6000 : 15000
    closeTimerRef.current = setTimeout(() => closeStage(), ms)
    return () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current) }
  }, [stage?.status, stage?.skill])

  useSse({
    path: '/events',
    handlers: {
      'skill:started': (data: any) => {
        if (!data?.skill) return
        // 文档类技能由 DocReader 全屏舱接管,不重复显示
        if (DOC_CATEGORY_RE.test(String(data?.category || ''))) return
        const steps = Array.isArray(data?.steps) && data.steps.length > 0 ? data.steps : ['准备阶段', '执行生成', '输出结果']
        setStage({
          skill: data.skill,
          displayName: data.displayName || data.skill,
          emoji: data.emoji || '📦',
          category: String(data?.category || ''),
          steps,
          status: 'running',
        })
        setEntered(true)
      },
      'skill:completed': (data: any) => {
        setStage(prev => prev && prev.skill === data?.skill
          ? { ...prev, status: 'success', summary: data?.summary, outputPath: data?.outputPath, durationMs: data?.durationMs }
          : prev)
      },
      'skill:error': (data: any) => {
        setStage(prev => prev && prev.skill === data?.skill
          ? { ...prev, status: 'error', error: data?.error, durationMs: data?.durationMs }
          : prev)
      },
    },
  })

  if (!stage) return null

  const meta = STATUS_META[stage.status]

  return (
    <div className={`skill-stage${entered ? ' skill-stage--enter' : ' skill-stage--exit'}`}>
      <div className="skill-stage-card">
        {/* 全息扫描线 */}
        <div className="skill-stage-scan" />
        {/* 顶部高光 */}
        <div className="skill-stage-glow" />

        {/* 头部:emoji + 名称 + 状态徽章 + 关闭 */}
        <div className="skill-stage-head">
          <span className="skill-stage-emoji">{stage.emoji}</span>
          <span className="skill-stage-title">{stage.displayName}</span>
          <span className={`skill-stage-badge ${meta.cls}`}>{meta.label}</span>
          <button type="button" className="skill-stage-close" onClick={closeStage} title="关闭技能卡">✕</button>
        </div>

        {/* 执行中:"处理中…"(脉冲,不冒充进度)+ 步骤列表全灰(不点亮具体步骤) */}
        {stage.status === 'running' && (
          <>
            <div className="skill-stage-processing">◌ 处理中…</div>
            <div className="skill-stage-steps">
              {stage.steps.map(s => (
                <div key={s} className="skill-stage-step">
                  <span className="skill-stage-step-icon">○</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* 完成:大 ✓ + 摘要 */}
        {stage.status === 'success' && (
          <div className="skill-stage-result">
            <div className="skill-stage-check skill-stage-check--ok">✓</div>
            <div className="skill-stage-result-text">
              {stage.summary || '技能执行完成'}
              {stage.outputPath ? <div className="skill-stage-path">{stage.outputPath}</div> : null}
            </div>
          </div>
        )}

        {/* 失败:大 ✕ + 错误 */}
        {stage.status === 'error' && (
          <div className="skill-stage-result skill-stage-result--error">
            <div className="skill-stage-check skill-stage-check--err">✕</div>
            <div className="skill-stage-result-text">{stage.error || '技能执行失败'}</div>
          </div>
        )}
      </div>
      <div className="skill-stage-hint">语音"关闭技能卡"可关闭</div>
    </div>
  )
}
