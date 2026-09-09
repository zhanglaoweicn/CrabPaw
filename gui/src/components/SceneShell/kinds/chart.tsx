/**
 * ChartCard — 图表卡片
 *
 * 支持类型：
 *   - line / bar / pie：沿用原契约，datasets = [{ label, data, color? }]
 *   - candlestick：K线蜡烛图（A 股惯例：红涨绿跌）
 *     数据契约：labels: string[]（日期，ohlc[i] 与 labels[i] 一一对应）
 *              ohlc: Array<{ o: number; h: number; l: number; c: number }>（开/高/低/收）
 *     着色：c > o 红 #f43f5e（涨）；c < o 绿 #10b981（跌）；c === o 灰蓝 #94a3b8（平）
 *     datasets 在 candlestick 模式下可为空（不渲染图例，改用 红涨/绿跌 提示）。
 * 空数据/非法数据（ohlc 缺失或全部数值无效）→ 画布居中占位「暂无K线数据」，不崩溃。
 */

import { useEffect, useRef } from 'react'

export interface Candle {
  /** 开盘价 open */
  o: number
  /** 最高价 high */
  h: number
  /** 最低价 low */
  l: number
  /** 收盘价 close */
  c: number
}

export interface ChartData {
  title?: string
  type: 'line' | 'bar' | 'pie' | 'candlestick'
  labels: string[]
  /** line/bar/pie 数据系列；candlestick 模式下可为空（走 ohlc） */
  datasets?: Array<{ label: string; data: number[]; color?: string }>
  /** candlestick 专用：OHLC 蜡烛数据，与 labels 一一对应 */
  ohlc?: Candle[]
  /** 2026-08-16: K线水平标注线（candlestick 专用，如买卖点支撑/压力位） */
  markLines?: Array<{ value: number; label: string; color: string }>
}

const PALETTE = ['#6366f1', '#22d3ee', '#f59e0b', '#ef4444', '#22c55e', '#a78bfa', '#fb7185']

// A 股惯例：红涨绿跌（区别于欧美绿涨红跌）
const CANDLE_UP = '#f43f5e'   // 涨：红
const CANDLE_DOWN = '#10b981' // 跌：绿
const CANDLE_FLAT = '#94a3b8' // 平：灰蓝

// 2026-08-15: 尺寸参数化——场景卡默认 280×160, 大面板(股票行情)可传大尺寸
export function ChartCard({ data, width = 280, height = 160 }: { data: ChartData; width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const datasets = data.datasets || []

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width = width
    const h = canvas.height = height
    const pad = { top: 20, right: 16, bottom: 28, left: 40 }
    const pw = w - pad.left - pad.right
    const ph = h - pad.top - pad.bottom

    ctx.clearRect(0, 0, w, h)

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (ph * i) / 4
      ctx.beginPath()
      ctx.moveTo(pad.left, y)
      ctx.lineTo(w - pad.right, y)
      ctx.stroke()
    }

    const allValues = datasets.flatMap(d => d.data)
    const max = Math.max(...allValues, 1)
    const xStep = pw / Math.max(data.labels.length - 1, 1)

    // Candlestick chart（A 股惯例：红涨绿跌）
    if (data.type === 'candlestick') {
      const candles = (data.ohlc || []).filter(c => c && [c.o, c.h, c.l, c.c].every(Number.isFinite))
      if (candles.length === 0) {
        ctx.fillStyle = '#94a3b8'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('暂无K线数据', w / 2, h / 2)
        return
      }
      const vals = candles.flatMap(c => [c.h, c.l, c.o, c.c])
      const min = Math.min(...vals)
      const maxV = Math.max(...vals)
      const range = maxV - min || 1
      const n = candles.length
      const slotW = pw / n
      const bodyW = Math.max(3, Math.min(10, slotW * 0.55))
      const yOf = (v: number) => pad.top + ph - ((v - min) / range) * ph

      candles.forEach((c, i) => {
        const x = pad.left + slotW * i + slotW / 2
        const color = c.c > c.o ? CANDLE_UP : c.c < c.o ? CANDLE_DOWN : CANDLE_FLAT
        // 影线（high → low）
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, yOf(c.h))
        ctx.lineTo(x, yOf(c.l))
        ctx.stroke()
        // 实体（open ↔ close）
        const yTop = yOf(Math.max(c.o, c.c))
        const bodyH = Math.max(1, Math.abs(yOf(c.o) - yOf(c.c)))
        ctx.fillStyle = color
        ctx.fillRect(x - bodyW / 2, yTop, bodyW, bodyH)
      })

      // 2026-08-16: 买卖点水平虚线（支撑/压力位可视化；值越界不画）
      const markLines = data.markLines || []
      if (markLines.length > 0) {
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'right'
        markLines.forEach((ml) => {
          const v = Number(ml.value)
          if (!Number.isFinite(v) || v < min || v > maxV) return
          const y = yOf(v)
          ctx.setLineDash([5, 4])
          ctx.strokeStyle = ml.color
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.moveTo(pad.left, y)
          ctx.lineTo(w - pad.right, y)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = ml.color
          ctx.fillText(`${ml.label} ${v.toFixed(2)}`, w - pad.right - 2, y - 3)
        })
      }

      // 横轴：最多 ~7 个均匀刻度（30 根日期全画会挤成一团）
      const labelEvery = Math.max(1, Math.ceil(candles.length / 7))
      ctx.fillStyle = '#94a3b8'
      ctx.font = '8px sans-serif'
      ctx.textAlign = 'center'
      candles.forEach((_c, i) => {
        if (i % labelEvery !== 0 && i !== candles.length - 1) return
        const x = pad.left + slotW * i + slotW / 2
        const label = String(data.labels[i] ?? '')
        ctx.fillText(label.length > 6 ? label.slice(0, 6) + '…' : label, x, h - 4)
      })
      return
    }

    // Bar chart
    if (data.type === 'bar') {
      const barW = Math.min(16, (pw / data.labels.length) * 0.6 / datasets.length)
      datasets.forEach((ds, di) => {
        const color = ds.color || PALETTE[di % PALETTE.length]
        ctx.fillStyle = color
        ds.data.forEach((v, i) => {
          const barH = (v / max) * ph
          const x = pad.left + xStep * i - (datasets.length * barW) / 2 + di * barW
          const y = pad.top + ph - barH
          const r = Math.min(3, barW / 2)
          roundRect(ctx, x, y, barW, barH, r, true)
        })
      })
    }

    // Line chart
    if (data.type === 'line') {
      datasets.forEach((ds, di) => {
        const color = ds.color || PALETTE[di % PALETTE.length]
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.beginPath()
        ds.data.forEach((v, i) => {
          const x = pad.left + xStep * i
          const y = pad.top + ph - (v / max) * ph
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.stroke()

        // Dots
        ctx.fillStyle = color
        ds.data.forEach((v, i) => {
          const x = pad.left + xStep * i
          const y = pad.top + ph - (v / max) * ph
          ctx.beginPath()
          ctx.arc(x, y, 3, 0, Math.PI * 2)
          ctx.fill()
        })
      })
    }

    // Pie chart
    if (data.type === 'pie') {
      const cx = w / 2
      const cy = h / 2 + 5
      const r = Math.min(pw, ph) / 2 - 4
      const total = allValues.reduce((a, b) => a + b, 0)
      let angle = -Math.PI / 2
      const dataset = datasets[0]
      if (dataset) {
        dataset.data.forEach((v, i) => {
          const slice = (v / total) * Math.PI * 2
          const color = PALETTE[i % PALETTE.length]
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.arc(cx, cy, r, angle, angle + slice)
          ctx.closePath()
          ctx.fill()
          angle += slice
        })
      }
    }

    // Labels
    ctx.fillStyle = '#94a3b8'
    ctx.font = '8px sans-serif'
    ctx.textAlign = 'center'
    data.labels.forEach((label, i) => {
      const x = pad.left + xStep * i
      const y = h - 4
      ctx.fillText(label.length > 5 ? label.slice(0, 5) + '…' : label, x, y)
    })
  }, [data, width, height])

  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: '12px',
      background: 'rgba(24,24,36,0.88)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {data.title && (
        <div style={{ fontSize: 14, color: '#818cf8', fontWeight: 600, marginBottom: 4 }}>
          📊 {data.title}
        </div>
      )}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={data.title ? `图表：${data.title}` : '数据图表'}
        style={{ width, height }}
      />
      {data.type === 'candlestick' ? (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 8, color: '#94a3b8' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: CANDLE_UP }} /> 涨
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 8, color: '#94a3b8' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: CANDLE_DOWN }} /> 跌
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 4 }}>
          {datasets.map((ds, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 8, color: '#94a3b8' }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: ds.color || PALETTE[i % PALETTE.length] }} />
              {ds.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: boolean) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
  if (fill) ctx.fill()
}
