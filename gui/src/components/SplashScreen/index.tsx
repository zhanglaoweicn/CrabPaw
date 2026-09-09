/**
 * CrabPaw SplashScreen — 分叉闪屏
 *
 * 首次启动（无配置）：品牌闪屏 → SetupWizard
 * 常规启动（有配置）：品牌闪屏 + 服务加载列表 → 主界面
 *
 * v2: 修复 IPC 事件时序问题 + 增强动画反馈
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { isElectron } from '../../lib/api'
import type { SplashProgressEvent } from '../../types/electron.d'
import { playBootAmbience } from '../../hooks/useSoundEffects'
import './splash.css'

// ── 类型 ──

interface SplashScreenProps {
  checkingConfig: boolean
  isFirstLaunch: boolean  // = showSetupWizard
  onSplashComplete: () => void
}

type SplashPhase = 'brand' | 'loading' | 'fade-out'

interface LoadingStep {
  id: string
  label: string
  status: 'pending' | 'starting' | 'ready' | 'skipped' | 'error'
  message?: string
}

// ── 加载步骤初始值 ──

const DEFAULT_LOADING_STEPS: LoadingStep[] = [
  { id: 'backend',      label: '核心引擎',   status: 'pending' },
  { id: 'lark-bridge',  label: '飞书通道',   status: 'pending' },
  { id: 'wecom-bridge', label: '企业微信',   status: 'pending' },
  { id: 'sse-connect',  label: '实时连接',   status: 'pending' },
  { id: 'voice',        label: '语音引擎',   status: 'pending' },
]

const BRAND_TITLE = 'CRABPAW'

// ── 组件 ──

export function SplashScreen({ checkingConfig, isFirstLaunch, onSplashComplete }: SplashScreenProps) {
  const [phase, setPhase] = useState<SplashPhase>('brand')
  const [steps, setSteps] = useState<LoadingStep[]>(DEFAULT_LOADING_STEPS)
  const completedRef = useRef(false)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ipcSubscribedRef = useRef(false)
  const completeRef = useRef<() => void>(null as unknown as () => void)

  // 标记完成（防止重复调用）
  const complete = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current)
      fallbackTimerRef.current = null
    }
    setPhase('fade-out')
    setTimeout(() => {
      onSplashComplete()
    }, 300)
  }, [onSplashComplete])
  // Keep ref in sync so fallback timer always calls the latest complete
  completeRef.current = complete

  // ── 立即订阅 IPC 事件（不等 loading 阶段）+ 缓冲 ──
  // NOTE: empty deps — uses completeRef to avoid stale subscription on re-render
  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.splash?.onProgress) return
    if (ipcSubscribedRef.current) return
    ipcSubscribedRef.current = true

    const unsubscribe = window.electronAPI.splash.onProgress((event: SplashProgressEvent) => {
      // 立即更新 steps 状态（不再等 loading 阶段）
      setSteps(prev => prev.map(s =>
        s.id === event.step ? { ...s, status: event.status, message: event.message } : s
      ))

      // done 事件 → 延迟 400ms 后完成
      if (event.step === 'done') {
        setTimeout(() => completeRef.current(), 400)
      }
    })

    // 2026-08-03: 渲染就绪握手——订阅完成后通知主进程开始发进度事件，
    // 否则 dev 模式 vite 加载慢时事件全丢（五项永远"等待中"）
    try {
      window.electronAPI.splash.ready()
    } catch (e) {
      console.warn('[splash] 渲染就绪握手失败（主进程 8s 兜底启动）:', e)
    }

    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [])

  // ── 品牌阶段 → 决定走哪条路径 ──
  // NOTE: uses completeRef to avoid resetting on re-render
  useEffect(() => {
    if (checkingConfig) return  // 配置还没加载完，等

    if (isFirstLaunch) {
      // 首次启动：品牌动画 1.5s 后直接完成
      const t = setTimeout(() => completeRef.current(), 1500)
      return () => clearTimeout(t)
    }

    // 常规启动：进入 loading 阶段（缩短品牌动画时间，更快进入服务检测）
    // 2026-08-31 深度检查修复: 非 Electron(纯浏览器)无 splash:progress 进度源,
    // loading 列表会全部 pending 挂到 15s 兜底超时——品牌动画后直接完成,
    // 首启判定仍由 App.loadConfigOnce(HTTP /config)承担
    if (!isElectron()) {
      const t = setTimeout(() => completeRef.current(), 1500)
      return () => clearTimeout(t)
    }

    const t = setTimeout(() => setPhase('loading'), 800)
    return () => clearTimeout(t)
  }, [checkingConfig, isFirstLaunch])

  // ── 兜底超时（15s 防卡死，比 loadConfigOnce 重试总时长稍长） ──
  // NOTE: empty deps — uses completeRef to avoid resetting on every render
  useEffect(() => {
    fallbackTimerRef.current = setTimeout(() => {
      console.warn('[SplashScreen] Fallback timeout, forcing complete')
      completeRef.current()
    }, 15000)
    return () => {
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
    }
  }, [])

  // ── 移除 index.html 中的 bootstrap 闪屏 ──
  // 2026-08-31: 已上移到 App 层(App.tsx)——skipSplash 路径不挂载本组件,
  // 此处移除会让该路径残留 z-index:9999 全屏遮罩

  // ── P5.5 启动音乐：用户自备 data/boot-music.mp3 → 播放；无 → Web Audio 合成星际氛围 ──
  const bootAudioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    let cancelled = false
    const playBootMusic = async () => {
      try {
        if (isElectron() && window.electronAPI?.app?.bootMusic?.getPath) {
          const p = await window.electronAPI.app.bootMusic.getPath()
          if (cancelled) return
          if (p) {
            const audio = new Audio(p)
            audio.volume = 0.25
            bootAudioRef.current = audio
            audio.play().catch((e) => console.warn('[boot] 启动音乐播放失败(自动播放被拒,降级静音):', e))
            return
          }
        }
        playBootAmbience(10)
      } catch (e) {
        console.error('[boot] 启动音乐初始化失败:', e)
      }
    }
    playBootMusic()
    return () => {
      cancelled = true
      try {
        if (bootAudioRef.current) { bootAudioRef.current.pause(); bootAudioRef.current = null }
      } catch (e) {
        console.error('[boot] 停播失败:', e)
      }
    }
  }, [])

  // ── 计算进度 ──
  const finishedCount = steps.filter(s => s.status === 'ready' || s.status === 'skipped' || s.status === 'error').length
  const progressPct = steps.length > 0 ? (finishedCount / steps.length) * 100 : 0
  const allDone = finishedCount === steps.length

  // ── 步骤图标渲染 ──
  function renderStepIcon(status: LoadingStep['status']) {
    switch (status) {
      case 'pending':  return <span className="splash-step-icon splash-step-icon--pending">○</span>
      case 'starting': return <span className="splash-step-icon splash-step-icon--starting">◉</span>
      case 'ready':    return <span className="splash-step-icon splash-step-icon--ready">✓</span>
      case 'skipped':  return <span className="splash-step-icon splash-step-icon--skipped">—</span>
      case 'error':    return <span className="splash-step-icon splash-step-icon--error">✗</span>
    }
  }

  // ── 步骤状态文本 ──
  function renderStepStatus(step: LoadingStep) {
    switch (step.status) {
      case 'pending':  return '等待中'
      case 'starting': return step.message || '连接中...'
      case 'ready':    return step.message || '完成'
      case 'skipped':  return '未配置'
      case 'error':    return step.message || '失败'
    }
  }

  return (
    <div className={`splash-root${phase === 'fade-out' ? ' splash-root--fade-out' : ''}`}>
      {/* 网格背景 */}
      <div className="splash-grid" />

      {/* 扫描线 */}
      <div className="splash-scan-line" />

      {/* 2026-08-04: 移除辐射光环与粒子汇聚球(圆圈动效)——聚焦螃蟹 LOGO */}
      <div className={`splash-brand${phase === 'loading' ? ' splash-brand--shrink' : ''}`}>
        {/* 2026-08-04: 螃蟹 LOGO 强化动效(能量环 + 脉冲光晕 + 呼吸) */}
        <div className="splash-logo-wrap">
          <div className="splash-logo-ring" />
          <div className="splash-logo-ring splash-logo-ring--inner" />
          <div className="splash-emoji">🦀</div>
        </div>

        {/* 标题：逐字动画 */}
        <div className="splash-title">
          {BRAND_TITLE.split('').map((char, i) => (
            <span
              key={i}
              className="splash-title-char"
              style={{ animationDelay: `${0.15 + i * 0.08}s` }}
            >
              {char}
            </span>
          ))}
        </div>

        <div className="splash-subtitle">AI Assistant Platform</div>

        {/* 品牌阶段底部进度微条 */}
        {phase === 'brand' && (
          <div className="splash-progress-bar">
            <div className="splash-progress-bar-fill" />
          </div>
        )}
      </div>

      {/* 加载列表（常规启动时显示）；全部完成时整体淡出，为进入主界面过渡 */}
      {phase === 'loading' && (
        <div className={`splash-loading-list${allDone ? ' splash-loading-list--done' : ''}`}>
          {steps.map((step, idx) => (
            <div
              key={step.id}
              className={`splash-loading-item splash-loading-item--${step.status}`}
              style={{ animationDelay: `${idx * 0.08}s` }}
            >
              {renderStepIcon(step.status)}
              <span className="splash-step-label">{step.label}</span>
              <span className={`splash-step-status${
                step.status === 'starting' ? ' splash-step-status--starting' :
                step.status === 'ready' ? ' splash-step-status--ready' :
                step.status === 'error' ? ' splash-step-status--error' : ''
              }`}>
                {renderStepStatus(step)}
              </span>
            </div>
          ))}

          {/* 总进度条 — 完成时变绿 */}
          <div className="splash-loading-progress">
            <div
              className={`splash-loading-progress-fill${allDone ? ' splash-loading-progress-fill--done' : ''}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
