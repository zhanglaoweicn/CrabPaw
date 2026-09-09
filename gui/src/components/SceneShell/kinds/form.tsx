/**
 * FormCard — 表单卡片
 *
 * 用户填写后通过 pushIntent(name='submit') 回流给 Agent。
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Send } from 'lucide-react'
import { getPerformanceMode } from '../../../lib/performance-mode'

/* ─── 激光烧刻 keyframes 注入 ─── */
let laserKeyframesInjected = false
function ensureLaserKeyframes() {
  if (laserKeyframesInjected || typeof document === 'undefined') return
  laserKeyframesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes laser-reveal-line {
      from { opacity: 0; transform: translateY(6px); filter: brightness(2); }
      to   { opacity: 1; transform: translateY(0); filter: brightness(1); }
    }
    @keyframes laser-glow-trail {
      0%   { text-shadow: 0 0 8px rgba(99,102,241,0.8), 0 0 16px rgba(99,102,241,0.4); }
      60%  { text-shadow: 0 0 4px rgba(99,102,241,0.4), 0 0 8px rgba(99,102,241,0.2); }
      100% { text-shadow: 0 0 1px rgba(99,102,241,0.1); }
    }
    @keyframes laser-cursor-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.2; }
    }
    @media (prefers-reduced-motion: reduce) {
      .laser-line, .laser-glow, .laser-cursor {
        animation: none !important;
      }
    }
  `
  document.head.appendChild(style)
}

/** 激光烧刻文本行组件：逐行 opacity/translateY stagger + 光晕拖尾 */
function LaserText({
  text,
  streaming,
  lineCountChanged,
}: {
  text: string
  streaming?: boolean
  lineCountChanged?: boolean
}) {
  const prevLineCountRef = useRef(0)

  useEffect(() => { ensureLaserKeyframes() }, [])

  const lines = text ? text.split('\n') : []
  const currentCount = lines.length
  const animate = streaming || lineCountChanged

  // 跟踪行数变化
  useEffect(() => {
    prevLineCountRef.current = currentCount
  }, [currentCount])

  if (!text) return null

  return (
    <div>
      {lines.map((line, i) => {
        const isNew = animate && i >= prevLineCountRef.current
        const delay = streaming ? Math.min(i * 120, 2000) : isNew ? Math.min((i - prevLineCountRef.current + 1) * 100, 2000) : 0

        return (
          <div
            key={`${i}-${line.length}`}
            className={`laser-line${animate ? ' laser-glow' : ''}`}
            style={{
              fontSize: '14px', color: '#cbd5e1', lineHeight: 1.5,
              padding: '1px 0',
              opacity: animate ? 0 : 1,
              animation: animate
                ? `laser-reveal-line 350ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) ${delay}ms both`
                : undefined,
              // 最新行（最后一行）加光晕拖尾
              ...(i === lines.length - 1 && streaming ? {
                textShadow: '0 0 6px rgba(99,102,241,0.5)',
                animation: animate
                  ? `laser-reveal-line 350ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) ${delay}ms both, laser-glow-trail 1.5s ease ${delay}ms`
                  : undefined,
              } : {}),
            } as React.CSSProperties}
          >
            {line || ' '}
          </div>
        )
      })}
      {/* 流式输出时：闪烁光标 */}
      {streaming && (
        <span
          className="laser-cursor"
          style={{
            display: 'inline-block', width: '2px', height: '13px',
            background: 'rgba(129,140,248,0.9)',
            marginLeft: '1px', verticalAlign: 'text-bottom',
            animation: 'laser-cursor-blink 0.8s step-end infinite',
            boxShadow: '0 0 6px rgba(129,140,248,0.5)',
          }}
        />
      )}
    </div>
  )
}

/* ─── 种草光谱柱 keyframes 注入 ─── */
let heatSpectrumKeyframesInjected = false
function ensureHeatSpectrumKeyframes() {
  if (heatSpectrumKeyframesInjected || typeof document === 'undefined') return
  heatSpectrumKeyframesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes heat-spectrum-breathe {
      0%, 100% { opacity: 0.5; filter: brightness(1); }
      50%      { opacity: 0.85; filter: brightness(1.35); }
    }
    @keyframes heat-spectrum-fill {
      from { transform: scaleY(0); }
      to   { transform: scaleY(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .heat-spectrum-bar {
        animation: none !important;
      }
    }
  `
  document.head.appendChild(style)
}

/** 种草光谱柱：右侧竖柱，暖橙→玫红渐变随 heatLevel 变色呼吸 */
function HeatSpectrumBar({ level }: { level: number }) {
  const isLowPerf = getPerformanceMode() === 'low'
  const clamped = Math.min(5, Math.max(1, Math.round(level)))

  useEffect(() => { ensureHeatSpectrumKeyframes() }, [])

  // 颜色插值：level 1 = 暖橙 #f97316，level 5 = 玫红 #ec4899
  const t = (clamped - 1) / 4
  const r = Math.round(249 + (236 - 249) * t)
  const g = Math.round(115 + (72 - 115) * t)
  const b = Math.round(22 + (153 - 22) * t)
  const heatColor = `rgb(${r},${g},${b})`

  return (
    <div
      className="heat-spectrum-bar"
      style={{
        width: 5,
        minHeight: '40px',
        alignSelf: 'stretch',
        borderRadius: 3,
        background: `linear-gradient(to top, #f97316, ${heatColor}, #ec4899)`,
        opacity: isLowPerf ? 0.55 : undefined,
        animation: isLowPerf
          ? undefined
          : 'heat-spectrum-fill 450ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) both, heat-spectrum-breathe 2.8s ease-in-out 450ms infinite',
        transformOrigin: 'bottom',
        boxShadow: `0 0 10px ${heatColor}50`,
        flexShrink: 0,
      }}
    />
  )
}

export interface FormField {
  name: string
  label: string
  type: 'text' | 'number' | 'select' | 'toggle'
  options?: string[]
  default?: any
}

export interface FormData {
  prompt?: string
  fields: FormField[]
  submit?: string
  streaming?: boolean       // 流式输出时启用激光烧刻动效
  heatLevel?: number        // 1-5 种草程度，驱动右侧光谱柱变色
}

export function FormCard({ data, surfaceId, sendIntent }: {
  data: FormData
  surfaceId: string
  sendIntent: (id: string, name: string, intentData: any) => void
}) {
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {}
    for (const f of data.fields) {
      init[f.name] = f.default !== undefined ? f.default : (f.type === 'toggle' ? false : '')
    }
    return init
  })

  // 激光烧刻：跟踪行数变化
  const prevLineCountRef = useRef(0)
  const currentLineCount = data.prompt ? data.prompt.split('\n').length : 0
  const lineCountChanged = currentLineCount !== prevLineCountRef.current
  useEffect(() => {
    prevLineCountRef.current = currentLineCount
  }, [currentLineCount])

  const handleChange = useCallback((name: string, value: any) => {
    setValues(prev => ({ ...prev, [name]: value }))
  }, [])

  const handleSubmit = useCallback(() => {
    sendIntent(surfaceId, 'submit', { fields: values })
  }, [surfaceId, values, sendIntent])

  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'stretch',
      padding: '12px 14px',
      borderRadius: '14px',
      background: 'rgba(24,24,36,0.92)',
      backdropFilter: 'blur(20px)',
      border: '1px solid rgba(129,140,248,0.2)',
      minWidth: 220,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {data.prompt && (
          <div style={{ marginBottom: 10 }}>
            <LaserText
              text={data.prompt}
              streaming={data.streaming}
              lineCountChanged={lineCountChanged}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.fields.map(f => (
            <div key={f.name}>
              <label style={{ fontSize: 14, color: '#94a3b8', display: 'block', marginBottom: 3 }}>
                {f.label}
              </label>

              {f.type === 'text' && (
                <input
                  type="text"
                  value={values[f.name] || ''}
                  onChange={e => handleChange(f.name, e.target.value)}
                  style={{
                    width: '100%', padding: '4px 8px',
                    borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.04)', color: '#e2e8f0',
                    fontSize: 14, outline: 'none',
                  }}
                />
              )}

              {f.type === 'number' && (
                <input
                  type="number"
                  value={values[f.name] ?? ''}
                  onChange={e => handleChange(f.name, e.target.value)}
                  style={{
                    width: '100%', padding: '4px 8px',
                    borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.04)', color: '#e2e8f0',
                    fontSize: 14, outline: 'none',
                  }}
                />
              )}

              {f.type === 'select' && (
                <select
                  value={values[f.name] || ''}
                  onChange={e => handleChange(f.name, e.target.value)}
                  style={{
                    width: '100%', padding: '4px 8px',
                    borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.04)', color: '#e2e8f0',
                    fontSize: 14, outline: 'none',
                  }}
                >
                  <option value="">-- 选择 --</option>
                  {(f.options || []).map(o => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              )}

              {f.type === 'toggle' && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  {/* 无障碍：div onClick → button role=switch aria-checked（键盘可达） */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!!values[f.name]}
                    aria-label={f.label}
                    onClick={() => handleChange(f.name, !values[f.name])}
                    style={{
                      width: 32, height: 18, borderRadius: 9,
                      background: values[f.name] ? '#6366f1' : 'rgba(255,255,255,0.1)',
                      position: 'relative', transition: 'background 0.2s',
                      border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: 2,
                      left: values[f.name] ? 16 : 2,
                      width: 14, height: 14, borderRadius: '50%',
                      background: '#fff',
                      transition: 'left 0.2s',
                      pointerEvents: 'none', display: 'block',
                    }} />
                  </button>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>
                    {values[f.name] ? '是' : '否'}
                  </span>
                </label>
              )}
            </div>
          ))}
        </div>

        <button onClick={handleSubmit} style={{
          marginTop: 10, width: '100%',
          padding: '6px 12px', borderRadius: 8,
          background: 'linear-gradient(135deg, #6366f1, #818cf8)',
          border: 'none', color: '#fff',
          fontSize: 11, fontWeight: 600,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}>
          <Send size={12} />
          {data.submit || '提交'}
        </button>
      </div>

      {/* 种草光谱柱：仅当 heatLevel 存在时渲染 */}
      {data.heatLevel != null && (
        <HeatSpectrumBar level={data.heatLevel} />
      )}
    </div>
  )
}
