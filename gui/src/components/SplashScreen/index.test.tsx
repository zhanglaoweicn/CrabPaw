/**
 * SplashScreen — 启动闪屏状态机单测（2026-08-31 深度检查配套）。
 * 覆盖: Electron IPC done 完成 / 非 Electron 1.5s 快速完成(修复前挂 15s loading 兜底)
 * / Electron 15s 兜底防卡死 / 首启分支。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { SplashScreen } from './index'
import { isElectron } from '../../lib/api'

vi.mock('../../lib/api', () => ({ isElectron: vi.fn(() => true) }))
vi.mock('../../hooks/useSoundEffects', () => ({ playBootAmbience: vi.fn() }))

type ProgressHandler = (e: { step: string; status: string; message?: string }) => void
let progressHandler: ProgressHandler | null = null

function mockElectron() {
  progressHandler = null
  ;(window as any).electronAPI = {
    splash: {
      onProgress: vi.fn((cb: ProgressHandler) => { progressHandler = cb; return () => {} }),
      ready: vi.fn(),
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(isElectron).mockReturnValue(true)
})
afterEach(() => {
  vi.useRealTimers()
  delete (window as any).electronAPI
})

describe('SplashScreen 启动闪屏', () => {
  it('Electron 常规启动: IPC 步骤更新 UI, done 后回调 onSplashComplete', () => {
    mockElectron()
    const onComplete = vi.fn()
    render(<SplashScreen checkingConfig={false} isFirstLaunch={false} onSplashComplete={onComplete} />)
    // 订阅建立后通知主进程(渲染就绪握手)
    expect((window as any).electronAPI.splash.ready).toHaveBeenCalledTimes(1)
    // 品牌阶段 800ms 后进入 loading 列表
    act(() => { vi.advanceTimersByTime(800) })
    expect(screen.getByText('核心引擎')).toBeTruthy()
    // 主进程推步骤 → UI 即时更新
    act(() => { progressHandler!({ step: 'backend', status: 'ready', message: '核心引擎就绪' }) })
    expect(screen.getByText('核心引擎就绪')).toBeTruthy()
    // done → 400ms 延迟完成 + 300ms 淡出
    act(() => { progressHandler!({ step: 'done', status: 'ready' }) })
    act(() => { vi.advanceTimersByTime(400 + 300) })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('非 Electron(纯浏览器): 1.5s 品牌动画后直接完成, 不挂 15s loading 兜底(2026-08-31 修复)', () => {
    vi.mocked(isElectron).mockReturnValue(false)
    const onComplete = vi.fn()
    render(<SplashScreen checkingConfig={false} isFirstLaunch={false} onSplashComplete={onComplete} />)
    act(() => { vi.advanceTimersByTime(1500 + 300) })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('核心引擎')).toBeNull()   // 从未进入 loading 列表
  })

  it('Electron 无事件: 15s 兜底强制完成(防卡死)', () => {
    mockElectron()
    const onComplete = vi.fn()
    render(<SplashScreen checkingConfig={false} isFirstLaunch={false} onSplashComplete={onComplete} />)
    act(() => { vi.advanceTimersByTime(15000 + 300) })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('首次启动: 品牌动画 1.5s 后直接完成(进 SetupWizard 由 App 决定)', () => {
    mockElectron()
    const onComplete = vi.fn()
    render(<SplashScreen checkingConfig={false} isFirstLaunch={true} onSplashComplete={onComplete} />)
    act(() => { vi.advanceTimersByTime(1500 + 300) })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
