/**
 * Metric Card — 指标卡片（带趋势 + 段脉冲高亮）
 *
 * P7 Task9：消费 window.__ttsSegmentPulse 信号，active 时对第 pulseTarget 个 KPI
 * 加 .kpi-pulse class（CSS 辉光动画，段切换轮换）。
 * 支持单 KPI（data.{value,label}）和多 KPI（data.items）两种格式。
 */

import { useState, useEffect } from 'react'
import { pulseTarget } from '../../../lib/holo-pulse'

export interface MetricData {
  value: string | number
  label: string
  unit?: string
  trend?: 'up' | 'down' | 'flat' | 'stable'
  subtitle?: string
}

const TREND_ICON: Record<string, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
  stable: '→',
}
const TREND_COLOR: Record<string, string> = {
  up: '#4ade80',
  down: '#f87171',
  flat: '#888',
  stable: '#888',
}

export function MetricCard({ data, onClose }: { data: MetricData & { items?: MetricData[] }; onClose?: () => void }) {
  // 支持多 KPI：items 数组优先，否则包成单元素数组
  const kpis: MetricData[] = Array.isArray(data.items) && data.items.length > 0
    ? data.items
    : [data]

  const [pulseIdx, setPulseIdx] = useState(-1)

  // 轮询段脉冲信号：active 时按取模轮换高亮，非 active 时清除
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const pulse = (window as any).__ttsSegmentPulse as
          | { segmentIndex: number; active: boolean }
          | undefined
        if (pulse?.active) {
          setPulseIdx(pulseTarget(pulse.segmentIndex, kpis.length))
        } else {
          setPulseIdx(-1)
        }
      } catch (e) {
        console.error('[metric] 脉冲信号读取失败:', (e as any)?.message || e)
        // 信号读取异常 → 清除高亮（防御）
        setPulseIdx(-1)
      }
    }, 100)
    return () => clearInterval(timer)
  }, [kpis.length])

  return (
    <div style={{
      padding: '16px',
      borderRadius: '12px',
      background: 'rgba(24,24,36,0.88)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
      minWidth: '140px',
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
      {kpis.map((kpi, i) => (
        <div key={i} style={i > 0 ? { marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '8px' } : undefined}>
          {kpi.unit && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted, #888)', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {kpi.unit}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <span
              className={i === pulseIdx ? 'kpi-pulse' : ''}
              style={{
                fontSize: '28px',
                fontWeight: 300,
                color: i === pulseIdx ? '#ffd700' : 'var(--text-primary, #eee)',
                lineHeight: 1.2,
                transition: 'color 0.3s ease, text-shadow 0.3s ease',
              }}
            >
              {kpi.value}
            </span>
            {kpi.trend && (
              <span style={{
                fontSize: '16px',
                color: TREND_COLOR[kpi.trend] || '#888',
                fontWeight: 500,
              }}>
                {TREND_ICON[kpi.trend] || ''}
              </span>
            )}
          </div>
          <div style={{ fontSize: '14px', color: 'var(--text-muted, #aaa)', marginTop: '4px' }}>
            {kpi.label}
          </div>
          {kpi.subtitle && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted, #777)', marginTop: '4px' }}>
              {kpi.subtitle}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
