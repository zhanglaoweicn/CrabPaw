/**
 * WebPreviewCard — 全息画框内嵌网页预览
 *
 * 数据形状：{ url: string, title?: string }
 * - iframe sandbox="allow-scripts"（严禁 allow-same-origin，参照 FileBrowser 沙箱先例）
 * - url 校验仅允许 http/https 协议
 * - 加载失败占位（onError 处理，禁空 catch）
 * - 底部粒子浇筑 v1 用 CSS 渐显代替
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { getPerformanceMode } from '../../../lib/performance-mode'

/* ─── 数据接口 ─── */
export interface WebPreviewData {
  url: string
  title?: string
  pour?: boolean           // 海报底部浇筑粒子动画
}

/* ─── URL 白名单校验 ─── */
// 2026-08-06: 放行 file:——MarkdownToHTML 生成本地 HTML 后推送 file:// 预览
// 2026-08-08 fix: Electron webSecurity 下 iframe 无法加载 file://(硬性禁止),
// MarkdownToHTML 已改推 local://(main 进程 protocol.handle('local') 放行 DATA_DIR)
const ALLOWED_PROTOCOLS = ['http:', 'https:', 'local:']

function isValidUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return ALLOWED_PROTOCOLS.includes(url.protocol)
  } catch {
    console.warn('[WebPreview] URL 校验失败:', raw)
    return false
  }
}

/* ─── 模块级 keyframes ─── */
let wpKeyframesInjected = false
function ensureWpKeyframes() {
  if (wpKeyframesInjected || typeof document === 'undefined') return
  wpKeyframesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes wp-frame-glow {
      0%, 100% { box-shadow: 0 0 8px rgba(99,102,241,0.3), inset 0 0 8px rgba(99,102,241,0.05); }
      50%      { box-shadow: 0 0 16px rgba(99,102,241,0.5), inset 0 0 12px rgba(99,102,241,0.1); }
    }
    @keyframes wp-particle-rise {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 0.6; transform: translateY(0); }
    }
    @keyframes wp-loading-shimmer {
      0%   { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .wp-frame-glow, .wp-particle-rise, .wp-loading-shimmer {
        animation: none !important;
      }
    }
  `
  document.head.appendChild(style)
}

/* ─── 海报浇筑粒子接口 ─── */
interface PourParticle {
  x: number
  y: number
  vy: number
  opacity: number
  size: number
}

/* ─── 海报浇筑粒子：canvas 底部 ~60 粒子上升浇筑，2s 渐隐 ─── */
function PourParticles({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const isLowPerf = getPerformanceMode() === 'low'

  useEffect(() => {
    if (!active || isLowPerf) return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = rect.width || 300
    const h = 40

    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    ctx.scale(dpr, dpr)

    // 初始化 ~60 粒子
    const particles: PourParticle[] = []
    for (let i = 0; i < 60; i++) {
      particles.push({
        x: Math.random() * w,
        y: h + Math.random() * 12,       // 从底部或略下方开始
        vy: -(0.3 + Math.random() * 1.0), // 上升速度
        opacity: 0.35 + Math.random() * 0.45,
        size: 1.2 + Math.random() * 2.4,
      })
    }

    const startTime = performance.now()
    const DURATION = 2000

    const animate = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / DURATION, 1)

      ctx.clearRect(0, 0, w, h)

      let aliveCount = 0
      for (const p of particles) {
        // 粒子上升，速度随时间略有衰减
        p.y += p.vy * (1 - progress * 0.4)
        const life = 1 - progress
        if (life <= 0) continue
        aliveCount++

        ctx.globalAlpha = p.opacity * life
        ctx.fillStyle = '#a5b4fc'
        ctx.shadowColor = 'rgba(165,180,252,0.5)'
        ctx.shadowBlur = 3
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1

      if (aliveCount > 0 && progress < 1) {
        rafRef.current = requestAnimationFrame(animate)
      }
    }

    rafRef.current = requestAnimationFrame(animate)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [active, isLowPerf])

  if (!active) return null

  // 低性能模式：静态渐隐色条（P7.5-T2 降级策略）
  if (isLowPerf) {
    return (
      <div style={{
        marginTop: 8, height: 20,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        gap: 2,
      }}>
        {Array.from({ length: 24 }).map((_, i) => (
          <div
            key={i}
            style={{
              width: 2,
              height: `${4 + Math.sin(i * 0.55 + 0.8) * 5}px`,
              borderRadius: 1,
              background: 'rgba(165,180,252,0.3)',
              opacity: 0.55,
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%',
        height: 40,
        marginTop: 8,
        display: 'block',
        borderRadius: '0 0 8px 8px',
      }}
      aria-label="海报浇筑粒子"
    />
  )
}

/* ─── WebPreviewCard ─── */
export function WebPreviewCard({ data, onClose }: { data?: WebPreviewData; onClose?: () => void }) {
  const [iframeLoading, setIframeLoading] = useState(true)
  const [iframeError, setIframeError] = useState(false)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { ensureWpKeyframes() }, [])

  // 兜底：无数据或 URL 无效
  const urlValid = data?.url && isValidUrl(data.url)

  // 清理错误超时定时器
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, [])

  // 8s 超时兜底：iframe onError 不是标准事件，跨域/拒绝嵌入不触发 → 主动检测
  useEffect(() => {
    if (!urlValid || !iframeLoading) return
    const timer = setTimeout(() => {
      setIframeLoading(false)
      setIframeError(true)
      console.warn('[WebPreview] iframe 加载超时(8s 兜底):', data?.url)
    }, 8000)
    return () => clearTimeout(timer)
  }, [urlValid, iframeLoading, data?.url])

  const handleIframeLoad = useCallback(() => {
    // 清理 error 定时器：load 已触发，延迟 3s 的错误判定不再需要（防 load 后误报失败）
    if (errorTimerRef.current) { clearTimeout(errorTimerRef.current); errorTimerRef.current = null }
    setIframeLoading(false)
    setIframeError(false)
  }, [])

  // iframe onError 回调：超时后备（sandbox 无 allow-same-origin 时部分站点可能拒绝嵌入）
  const handleIframeError = useCallback(() => {
    // 延迟 3s 判断：如果是加载慢而非真正错误，load 事件会清除
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null
      setIframeLoading(false)
      setIframeError(true)
      console.warn('[WebPreview] iframe 加载超时或失败:', data?.url)
    }, 3000)
  }, [data?.url])

  if (!data || !data.url) {
    return (
      <div style={{
        padding: '14px 18px', borderRadius: '14px', minWidth: 200,
        background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)',
        border: '1px dashed rgba(255,255,255,0.10)',
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', textAlign: 'center' }}>
          ⚠ 数据不完整 — 缺少 URL
        </div>
      </div>
    )
  }

  if (!urlValid) {
    return (
      <div style={{
        padding: '14px 18px', borderRadius: '14px', minWidth: 200,
        background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)',
        border: '1px solid rgba(239,68,68,0.15)',
      }}>
        <div style={{ fontSize: 14, color: '#ef4444', marginBottom: 4, fontWeight: 600 }}>
          🚫 不安全的 URL
        </div>
        <div style={{ fontSize: 14, color: '#888', wordBreak: 'break-all' }}>
          仅允许 http/https 协议: {data.url.slice(0, 60)}{data.url.length > 60 ? '…' : ''}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: '10px', borderRadius: '14px', minWidth: 240, maxWidth: 400,
      background: 'rgba(24,24,36,0.90)', backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
    }}>
      {/* 标题栏 + 关闭按钮（2026-08-12: 此前卡片忽略 onClose 无关闭按钮） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        marginBottom: '8px', padding: '0 2px',
      }}>
        {data.title && (
          <span style={{
            fontSize: '15px', fontWeight: 600, color: '#cbd5e1', flex: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            🖼 {data.title}
          </span>
        )}
        {onClose && (
          <button
            type="button"
            title="关闭"
            onClick={onClose}
            aria-label="关闭预览"
            style={{
              flexShrink: 0, width: '22px', height: '22px', borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)',
              color: 'var(--text-muted, #999)', fontSize: '12px', lineHeight: 1,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        )}
      </div>

      {/* 全息画框 — 2026-08-12: 16:10 小窗格改可读高度（文章阅读），内部滚动 */}
      <div
        className="wp-frame-glow"
        style={{
          position: 'relative', width: '100%', height: 'min(44vh, 440px)',
          borderRadius: '10px', overflow: 'hidden',
          border: '1px solid rgba(99,102,241,0.2)',
          background: '#0a0a0f',
          animation: 'wp-frame-glow 3s ease-in-out infinite',
        }}
      >
        {/* 加载中骨架屏 */}
        {iframeLoading && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0a0a0f',
          }}>
            <div style={{
              width: '60%', height: '6px', borderRadius: '3px',
              background: 'linear-gradient(90deg, rgba(99,102,241,0.1), rgba(99,102,241,0.3), rgba(99,102,241,0.1))',
              backgroundSize: '200% 100%',
              animation: 'wp-loading-shimmer 1.5s ease-in-out infinite',
            }} />
          </div>
        )}

        {/* 错误占位 */}
        {iframeError && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 1,
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: '6px',
            background: 'rgba(10,10,15,0.95)',
          }}>
            <span style={{ fontSize: 14, color: '#f59e0b', fontWeight: 600 }}>
              ⚡ 预览加载失败
            </span>
            <span style={{ fontSize: 9, color: '#666', maxWidth: '80%', textAlign: 'center', wordBreak: 'break-all' }}>
              该页面可能拒绝嵌入，或 sandbox 限制导致无法加载
            </span>
          </div>
        )}

        {/* iframe — sandbox 白名单不含 allow-same-origin，安全第一 */}
        <iframe
          src={data.url}
          style={{
            width: '100%', height: '100%', border: 0,
            background: '#fff',
          }}
          sandbox="allow-scripts"
          title={data.title || data.url}
          onLoad={handleIframeLoad}
          onError={handleIframeError}
        />
      </div>

      {/* 海报浇筑粒子：仅当 pour 字段存在且为 true 时渲染 */}
      {data.pour && <PourParticles active={true} />}

      {/* URL 底部标注 */}
      <div style={{
        fontSize: '8px', color: '#555', marginTop: '6px',
        textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {data.url}
      </div>
    </div>
  )
}
