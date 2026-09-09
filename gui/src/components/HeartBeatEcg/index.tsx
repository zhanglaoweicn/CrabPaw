/**
 * HeartBeatEcg — 心电图画布
 *
 * 监护仪式 PQRST 波形：环形缓冲滚动、按状态注入搏动、无数据平坦虚线 + 覆盖提示。
 * props: active/hasData/online/speaking。
 *
 * 2026-09-02 观感重做（用户反馈"跳动不明显"）：
 * - 根因：旧滚动速度 4.4px/s，96BPM 每 625ms 一次触发会在上一搏动只推进
 *   ~2.7px 时覆盖 pending 波形 → R 尖峰永远画不完，只剩缓慢 P 波隆起。
 * - 滚动 4.4 → 56px/s（280px 缓冲 ≈ 5s 历史），cyclePx 34 → 28
 *   （56px/s 下 28px = 500ms，恰与说话态 120BPM 周期吻合，搏动不再被截断）。
 * - 波幅加大：P14/Q10/S16/T22（旧 10/7/13/16），R 峰 0.55H。
 * - 语音播放同步：speaking 时 120BPM + 非 R 波幅 ×1.2 + 高亮辉光——
 *   "它在说话，心跳更快更用力"。
 */
import { useEffect, useRef } from 'react'

export interface HeartBeatEcgProps {
  /** 活跃(近 30s 有任务) → 琥珀高亮 + 96BPM 搏动；静息则 68BPM 平基线 */
  active: boolean
  /** 是否已收到过心跳(无数据 = 平坦虚线 + 等待提示) */
  hasData: boolean
  /** SSE 连接态(断线红色提示) */
  online: boolean
  /** 语音播放中 → 120BPM + 波幅 ×1.2 + 辉光增强（与 TTS 同步的心跳隐喻） */
  speaking?: boolean
  /** canvas 可视化高度(px)，默认 90 */
  height?: number
}

export function HeartBeatEcg({ active, hasData, online, speaking = false, height = 90 }: HeartBeatEcgProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // ECG 滚动缓冲: 每个像素点 1 个 y 值(相对 canvas 内部高)
  const bufferRef = useRef<{ values: number[]; head: number; lastTrigger: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  const hasDataRef = useRef(hasData)
  const onlineRef = useRef(online)
  const speakingRef = useRef(speaking)
  const H = height
  const W = 280

  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { hasDataRef.current = hasData }, [hasData])
  useEffect(() => { onlineRef.current = online }, [online])
  useEffect(() => { speakingRef.current = speaking }, [speaking])

  useEffect(() => {
    if (!bufferRef.current) {
      bufferRef.current = {
        values: new Array(W).fill(H * 0.66),
        head: 0,
        lastTrigger: -Infinity,
      }
    }
    const buf = bufferRef.current
    const cvs = canvasRef.current
    if (!cvs) return
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
    cvs.width = W * dpr
    cvs.height = H * dpr
    const ctx = cvs.getContext('2d')
    if (!ctx) return // jsdom/无 2d 环境: 静默降级
    ctx.scale(dpr, dpr)

    // 基线/R 峰预算（H=64 与 90 均不出画布）：
    // 基线 0.66H；R 峰 0.55H（不随 speaking 放大，防出顶）；P/T/Q/S 随 speaking ×mul
    const BASELINE_F = 0.66
    const R_AMP_F = 0.55

    /** 预生成 1 个 PQRST 周期的波形偏移（mul 只放大 P/T/Q/S） */
    const buildCycle = (mul: number) => {
      const cyclePx = 28
      const offs = new Array(cyclePx).fill(0)
      const pStart = Math.round(cyclePx * 0.10)
      const pPeak = Math.round(cyclePx * 0.15)
      const pEnd = Math.round(cyclePx * 0.22)
      for (let x = pStart; x <= pPeak; x++) {
        const t = (x - pStart) / (pPeak - pStart)
        offs[x] = -Math.sin(t * Math.PI) * 14 * mul
      }
      for (let x = pPeak + 1; x <= pEnd; x++) {
        const t = (x - pPeak) / (pEnd - pPeak)
        offs[x] = -Math.sin((1 - t) * Math.PI) * 14 * mul
      }
      const qStart = pEnd
      const qTrough = Math.round(cyclePx * 0.34)
      const qEnd = Math.round(cyclePx * 0.36)
      for (let x = qStart; x <= qTrough; x++) {
        const t = (x - qStart) / (qTrough - qStart)
        offs[x] = t * 10 * mul
      }
      for (let x = qTrough + 1; x <= qEnd; x++) {
        const t = (x - qTrough) / (qEnd - qTrough)
        offs[x] = (10 - t * 10) * mul
      }
      const rPeak = Math.round(cyclePx * 0.40)
      const rEnd = Math.round(cyclePx * 0.44)
      const rAmp = H * R_AMP_F
      for (let x = qEnd; x <= rPeak; x++) {
        const t = (x - qEnd) / Math.max(1, rPeak - qEnd)
        offs[x] = -t * rAmp
      }
      for (let x = rPeak + 1; x <= rEnd; x++) {
        const t = (x - rPeak) / (rEnd - rPeak)
        offs[x] = -(1 - t) * rAmp
      }
      const sTrough = Math.round(cyclePx * 0.47)
      const sEnd = Math.round(cyclePx * 0.50)
      for (let x = rEnd + 1; x <= sTrough; x++) {
        const t = (x - rEnd) / (sTrough - rEnd)
        offs[x] = t * 16 * mul
      }
      for (let x = sTrough + 1; x <= sEnd; x++) {
        const t = (x - sTrough) / (sEnd - sTrough)
        offs[x] = (16 - t * 16) * mul
      }
      const tStart = Math.round(cyclePx * 0.62)
      const tPeak = Math.round(cyclePx * 0.72)
      const tEnd = Math.round(cyclePx * 0.82)
      for (let x = tStart; x <= tPeak; x++) {
        const t = (x - tStart) / (tPeak - tStart)
        offs[x] = -Math.sin(t * Math.PI) * 22 * mul
      }
      for (let x = tPeak + 1; x <= tEnd; x++) {
        const t = (x - tPeak) / (tEnd - tPeak)
        offs[x] = -Math.sin((1 - t) * Math.PI) * 22 * mul
      }
      return offs
    }

    const pushY = (yOffset: number) => {
      buf.values[buf.head] = H * BASELINE_F + yOffset
      buf.head = (buf.head + 1) % buf.values.length
    }

    let lastFrameTs = performance.now()
    // 56px/s：280px 缓冲 ≈ 5s 历史；28px 周期 = 500ms，与 120BPM 说话态同频
    const scrollSpeedPxPerSec = 56
    let remainder = 0

    const drawGrid = () => {
      ctx.clearRect(0, 0, W, H)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)'
      ctx.lineWidth = 0.5
      for (let i = 1; i <= 5; i++) {
        const y = (H / 6) * i
        ctx.beginPath()
        ctx.moveTo(0, y); ctx.lineTo(W, y)
        ctx.stroke()
      }
    }

    const drawWave = () => {
      const mid = H * BASELINE_F
      const useGradient = (activeRef.current || speakingRef.current) && hasDataRef.current
      let strokeStyle: string | CanvasGradient = 'rgba(96, 165, 250, 0.4)'
      let lineWidth = 1.2
      if (!hasDataRef.current) {
        strokeStyle = 'rgba(96, 165, 250, 0.25)'
        lineWidth = 1
      } else if (useGradient) {
        const grad = ctx.createLinearGradient(0, 0, W, 0)
        grad.addColorStop(0, 'rgba(96, 165, 250, 0.15)')
        grad.addColorStop(0.3, 'rgba(96, 165, 250, 0.95)')
        grad.addColorStop(0.7, 'rgba(96, 165, 250, 0.95)')
        grad.addColorStop(1, 'rgba(96, 165, 250, 0.85)')
        strokeStyle = grad
        lineWidth = speakingRef.current ? 2 : 1.8
      }
      if (useGradient) {
        ctx.shadowColor = speakingRef.current ? 'rgba(96, 165, 250, 0.75)' : 'rgba(96, 165, 250, 0.5)'
        ctx.shadowBlur = speakingRef.current ? 14 : 10
      } else {
        ctx.shadowBlur = 0
      }
      ctx.strokeStyle = strokeStyle
      ctx.lineWidth = lineWidth
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (!hasDataRef.current) {
        ctx.setLineDash([4, 6])
        ctx.moveTo(0, mid)
        ctx.lineTo(W, mid)
      } else {
        ctx.setLineDash([])
        for (let i = 0; i < W; i++) {
          const idx = (buf.head + i) % W
          const y = buf.values[idx]
          if (i === 0) ctx.moveTo(i, y)
          else ctx.lineTo(i, y)
        }
      }
      ctx.stroke()
      ctx.setLineDash([])
      ctx.shadowBlur = 0
    }

    const tick = (now: number) => {
      const dtMs = now - lastFrameTs
      lastFrameTs = now

      // 2026-08-31 修复(心电图变一条线): 永远搏动——说话 120BPM / 活跃 96BPM / 静息 68BPM。
      // 触发时按当前 speaking 状态重建波形（mul 生效），56px/s 下 28px 周期恰好
      // 在下一触发前走完，搏动不再被覆盖截断。
      if (hasDataRef.current) {
        const bpm = speakingRef.current ? 120 : activeRef.current ? 96 : 68
        const periodMs = 60000 / bpm
        if (now - buf.lastTrigger > periodMs) {
          buf.lastTrigger = now
          const mul = speakingRef.current ? 1.2 : 1
          ;(buf as any)._pending = buildCycle(mul).map((offset, atPx) => ({ atPx, offset }))
          ;(buf as any)._pendingHead = 0
        }
      }

      const pxToMoveF = (dtMs / 1000) * scrollSpeedPxPerSec + remainder
      let pxToMove = Math.floor(pxToMoveF)
      remainder = pxToMoveF - pxToMove
      if (pxToMove > 16) pxToMove = 16

      for (let i = 0; i < pxToMove; i++) {
        let off = 0
        const pending = (buf as any)._pending as any[] | undefined
        if (pending && pending.length) {
          const pHead = (buf as any)._pendingHead as number
          if (pHead < pending.length) {
            off = pending[pHead].offset
            ;(buf as any)._pendingHead = pHead + 1
          } else {
            ;(buf as any)._pending = undefined
          }
        }
        pushY(off)
      }

      drawGrid()
      drawWave()

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [H, W])

  return (
    <div style={{
      background: 'linear-gradient(180deg, rgba(96, 165, 250, 0.04), rgba(8, 18, 32, 0.4))',
      borderRadius: '6px',
      border: '1px solid rgba(96, 165, 250, 0.1)',
      padding: '4px 2px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: H, display: 'block' }} />
      {!hasData && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          color: online ? 'rgba(148, 163, 184, 0.55)' : 'rgba(248, 113, 113, 0.7)',
          letterSpacing: '0.5px',
          pointerEvents: 'none',
        }}>
          {online ? '连接正常 · 等待任务' : '连接中断 · 重连中'}
        </div>
      )}
    </div>
  )
}

export default HeartBeatEcg
