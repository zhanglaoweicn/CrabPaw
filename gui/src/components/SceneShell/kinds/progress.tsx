/**
 * ProgressCard — 环状进度弧 + 滚动日志 + 激光扫描线
 *
 * 数据形状：{ percent: number, logs: string[], scan?: boolean }
 * - 左下：canvas 2D 弧线随 percent 渐变描边（冷色→暖色）
 * - 右侧：日志列表逐条浮现动画
 * - 中央：激光扫描线（scan=true 时 CSS linear-gradient 平移）
 */

import { useEffect, useRef, useState } from 'react'
import { getPerformanceMode } from '../../../lib/performance-mode'

/* ─── 数据接口 ─── */
export interface ProgressStep {
  label: string
  status: 'done' | 'active' | 'pending'
}

export interface ProgressData {
  percent?: number       // 0-100（前端契约 v1）
  progress?: number      // 0-100（兼容后端 SceneProgress / install-software 的 {label, progress, text} 契约）
  logs?: string[]        // 日志行
  text?: string          // 兼容：logs 缺失时作为单条日志
  label?: string         // 兼容：卡片标题（如"正在安装 Node.js"）
  scan?: boolean         // 是否显示激光扫描线
  steps?: ProgressStep[] // 流程步骤条（2026-09-07 Remotion 渲染流程化；缺省不渲染，向后兼容）
}

/* ─── 模块级 keyframes 注入 ─── */
let progressKeyframesInjected = false
function ensureProgressKeyframes() {
  if (progressKeyframesInjected || typeof document === 'undefined') return
  progressKeyframesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes progress-log-enter {
      from { opacity: 0; transform: translateX(12px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes progress-scan-line {
      0%   { top: 0%; }
      100% { top: 100%; }
    }
    @keyframes progress-glow-pulse {
      0%, 100% { opacity: 0.6; }
      50%      { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      .progress-log-line, .progress-scan-line {
        animation: none !important;
      }
    }
  `
  document.head.appendChild(style)
}

/* ─── canvas 环状进度弧 ─── */
function ProgressArc({ percent }: { percent: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = 90
  const half = size / 2
  const radius = half - 6
  // 弧线从 225°（左下）顺时针到 -45°（右下），即从左下象限开始
  const startAngle = Math.PI * 1.25   // 225°
  const sweep = Math.PI * 1.5          // 270° 总跨度
  const clamped = Math.min(100, Math.max(0, percent))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, size, size)

    // 背景弧（暗色底）
    ctx.beginPath()
    ctx.arc(half, half, radius, startAngle, startAngle + sweep, false)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.stroke()

    if (clamped <= 0) return

    // 进度弧渐变：冷蓝(0%)→紫→暖金(100%)
    const endAngle = startAngle + (sweep * clamped / 100)

    // linearGradient 近似弧线渐变（兼容所有浏览器）
    const linearGrad = ctx.createLinearGradient(0, 0, size, size)
    if (clamped < 50) {
      linearGrad.addColorStop(0, '#3b82f6')
      linearGrad.addColorStop(1, '#8b5cf6')
    } else if (clamped < 80) {
      linearGrad.addColorStop(0, '#3b82f6')
      linearGrad.addColorStop(0.5, '#8b5cf6')
      linearGrad.addColorStop(1, '#f59e0b')
    } else {
      linearGrad.addColorStop(0, '#8b5cf6')
      linearGrad.addColorStop(0.5, '#f59e0b')
      linearGrad.addColorStop(1, '#ef4444')
    }

    ctx.beginPath()
    ctx.arc(half, half, radius, startAngle, endAngle, false)
    ctx.strokeStyle = linearGrad
    ctx.lineWidth = 5
    ctx.lineCap = 'round'
    ctx.stroke()

    // 末端光点
    const tipX = half + radius * Math.cos(endAngle)
    const tipY = half + radius * Math.sin(endAngle)
    ctx.beginPath()
    ctx.arc(tipX, tipY, 4, 0, Math.PI * 2)
    ctx.fillStyle = clamped >= 80 ? '#f59e0b' : clamped >= 50 ? '#8b5cf6' : '#3b82f6'
    ctx.shadowColor = clamped >= 80 ? '#f59e0b' : '#8b5cf6'
    ctx.shadowBlur = 8
    ctx.fill()
    ctx.shadowBlur = 0
  }, [percent, clamped])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', flexShrink: 0 }}
      aria-label={`进度 ${clamped}%`}
    />
  )
}

/* ─── ProgressCard 主组件 ─── */

/**
 * 2026-08-14 审计: 日志行稳定 key——内容 hash + 全量数组绝对位置。
 * 原 key={i} 基于 slice(-8) 窗口的索引,追加新日志时所有行 key 平移,
 * CSS enter 动画全量重播(闪烁)。绝对位置 + 内容 hash 保证既有行 key 不变,
 * 新行才播入场动画。
 */
function logLineKey(log: string, absoluteIndex: number): string {
  let h = 0
  for (let i = 0; i < log.length; i++) h = (h * 31 + log.charCodeAt(i)) | 0
  return `${absoluteIndex}-${log.length}-${h}`
}

export function ProgressCard({ data }: { data?: ProgressData }) {
  const [visibleLogs, setVisibleLogs] = useState<string[]>([])
  const shownCountRef = useRef(0)

  useEffect(() => { ensureProgressKeyframes() }, [])

  // 契约兼容归一化：后端 SceneProgress/install-software 发 {label, progress, text}，
  // 前端 v1 契约是 {percent, logs}——percent = progress，text 兜底为单条日志
  const percent = data?.percent ?? data?.progress
  const logs: string[] = data?.logs || (data?.text ? [data.text] : [])

  // 日志内容指纹：依赖内容而非数组引用——后端每次推送可能新建数组，
  // 引用变化但内容相同时会重复触发 effect，导致日志闪烁
  const logsFingerprint = logs.join('\n')

  // 日志逐条浮现：每次 logs 变化时，逐条延迟显示
  // 用 shownCountRef 追踪已显示条数，避免闭包中 visibleLogs.length 陈旧引用
  useEffect(() => {
    if (logs.length === 0) {
      setVisibleLogs([])
      shownCountRef.current = 0
      return
    }
    const startCount = shownCountRef.current
    // 初始显示已有的
    setVisibleLogs(logs.slice(0, Math.max(1, startCount)))
    // 后续逐条追加
    const timers: ReturnType<typeof setTimeout>[] = []
    for (let i = startCount; i < logs.length; i++) {
      const idx = i
      const t = setTimeout(() => {
        setVisibleLogs(prev => {
          if (prev.length <= idx) {
            shownCountRef.current = Math.max(shownCountRef.current, idx + 1)
            return [...prev, logs[idx]]
          }
          return prev
        })
      }, (i - startCount + 1) * 350)
      timers.push(t)
    }
    return () => { timers.forEach(clearTimeout) }
  }, [logsFingerprint])

  // 兜底空数据
  if (percent === undefined) {
    return (
      <div style={{
        padding: '14px 16px', borderRadius: '14px', minWidth: 200,
        background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)',
        border: '1px dashed rgba(255,255,255,0.10)',
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', textAlign: 'center' }}>
          ⚠ 数据不完整 — 无法渲染进度
        </div>
      </div>
    )
  }

  const clamped = Math.min(100, Math.max(0, percent))

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '10px',
      padding: '14px 16px', borderRadius: '14px', minWidth: 260, maxWidth: 380,
      background: 'rgba(24,24,36,0.90)', backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* 激光扫描线（可选；低性能模式关闭） */}
      {data?.scan && getPerformanceMode() === 'high' && (
        <div
          className="progress-scan-line"
          style={{
            position: 'absolute', left: 0, width: '100%', height: '2px',
            background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.7), transparent)',
            boxShadow: '0 0 12px rgba(59,130,246,0.4)',
            animation: 'progress-scan-line 2.5s linear infinite',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}

      {/* 标题（兼容后端 SceneProgress label 字段，如"正在安装 Node.js"） */}
      {data?.label ? (
        <div style={{ fontSize: 13, fontWeight: 600, color: '#dbe0ff', lineHeight: 1.4, paddingLeft: 2 }}>{data.label}</div>
      ) : null}

      {/* 流程步骤条（流程化：✓已完成 / ◉进行中发光 / ○待办） */}
      {data?.steps && data.steps.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', paddingLeft: 2 }}>
          {data.steps.map((s) => (
            <div
              key={s.label}
              style={{
                display: 'flex', alignItems: 'center', gap: '5px',
                fontSize: 10.5, lineHeight: 1, padding: '4px 9px', borderRadius: 999,
                whiteSpace: 'nowrap',
                ...(s.status === 'done' ? {
                  color: '#7dd3fc',
                  background: 'rgba(56,189,248,0.10)',
                  border: '1px solid rgba(56,189,248,0.35)',
                } : s.status === 'active' ? {
                  color: '#e0f2fe', fontWeight: 600,
                  background: 'rgba(56,189,248,0.16)',
                  border: '1px solid rgba(56,189,248,0.65)',
                  boxShadow: '0 0 10px rgba(56,189,248,0.35)',
                  animation: 'progress-glow-pulse 1.6s ease-in-out infinite',
                } : {
                  color: 'rgba(255,255,255,0.32)',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.10)',
                }),
              }}
            >
              <span>{s.status === 'done' ? '✓' : s.status === 'active' ? '◉' : '○'}</span>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* 进度弧 + 日志 主体行 */}
      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
      {/* 左侧：环状进度弧 + 百分比数字 */}
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '4px', flexShrink: 0,
      }}>
        <ProgressArc percent={clamped} />
        <span style={{
          fontSize: '14px', fontWeight: 700,
          color: clamped >= 80 ? '#f59e0b' : clamped >= 50 ? '#8b5cf6' : '#3b82f6',
          animation: 'progress-glow-pulse 2s ease-in-out infinite',
        }}>
          {clamped}%
        </span>
      </div>

      {/* 右侧：滚动发光日志 */}
      <div style={{
        flex: 1, minWidth: 0, maxHeight: 140, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: '3px',
      }}>
        {visibleLogs.length === 0 && (
          <div style={{ fontSize: 10, color: '#666', fontStyle: 'italic' }}>
            等待日志…
          </div>
        )}
        {visibleLogs.slice(-8).map((log, i) => {
          // 绝对位置 = 窗口起始偏移 + 窗口内索引,追加新日志时既有行 key 保持不变
          const windowStart = Math.max(0, visibleLogs.length - 8)
          return (
          <div
            key={logLineKey(log, windowStart + i)}
            className="progress-log-line"
            style={{
              fontSize: '14px', color: '#a5b4fc', lineHeight: 1.4,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              padding: '2px 4px', borderRadius: '3px',
              background: 'rgba(99,102,241,0.06)',
              borderLeft: '2px solid rgba(99,102,241,0.25)',
              opacity: 0,
              animation: `progress-log-enter 300ms ease both`,
              animationDelay: '0ms',
              textShadow: '0 0 6px rgba(129,140,248,0.3)',
            }}
          >
            {log}
          </div>
          )
        })}
      </div>
      </div>
    </div>
  )
}
