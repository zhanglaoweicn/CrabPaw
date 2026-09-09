/**
 * useKwsWakeWord — 本地 KWS 唤醒接入（P0 构建的 Electron 唤醒体系）
 *
 * 与 useWakeWord（浏览器 Web Speech API）互补：
 *   - 本 hook 消费 P0 的 `electronAPI.wake.onHit` IPC（sherpa-onnx 常驻，不出本机）
 *   - 命中 → 通知上层启动会话（VoiceIntegration 的 wakeWordEnabled 生效）
 *   - `wake:status` IPC 上报采集状态（capturing / error）+ 致命状态（fatal）——
 *     fatal 时置 kwsFatal 并派发 `crabpaw:kws-fatal` window 事件（App 根层 toast 提示）
 *   - 60s 空闲（无命中、无会话活动）→ onDismiss 收球
 */

import { useEffect, useRef, useCallback, useState } from 'react'

const IDLE_DISMISS_MS = 60000
const WAKE_HIT_DEBOUNCE_MS = 1500

export interface KwsAudioLevel {
  level: number   // 线性平滑电平 0-1(1 最响)
  active: boolean // 窗口化活跃判定(移植 LiveKit audiolevel)
}

export function useKwsWakeWord({
  enabled,
  onWake,
  onDismiss,
  onDisabledHit,
}: {
  enabled: boolean
  onWake: () => void
  onDismiss: () => void
  /** 2026-08-15: 唤醒词被禁用(专注模式/关闭)时命中回调——语音提示用户当前模式,
   *  而非静默吞掉(此前用户喊唤醒词只看到球变色却无任何反馈, 不知是模式问题) */
  onDisabledHit?: () => void
}) {
  const enabledRef = useRef(enabled)
  const onWakeRef = useRef(onWake)
  const onDismissRef = useRef(onDismiss)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastHitAtRef = useRef(0)
  // 2026-08-04: 麦克风能量(主进程 audiolevel 广播)——语音球可据此驱动
  const [audioLevel, setAudioLevel] = useState<KwsAudioLevel | null>(null)
  // P2-1 (2026-08-12): 唤醒致命状态——wake-word 进程崩溃/模型缺失时置 true。
  // 提示承载：hook 内派发 crabpaw:kws-fatal window 事件 + console.error，
  // App 根层（全局外壳）监听该事件用 toast 展示"唤醒功能已禁用"提示；
  // 调用方（VoiceShell）如需展示可监听同一事件，或消费本返回值。
  const [kwsFatal, setKwsFatal] = useState(false)
  const lastFatalAtRef = useRef(0)
  // 2026-08-15: fatal 闩锁的可读 ref——onStatus 回调闭包内判断"此前是否 fatal"
  // （state 在闭包里是旧值且不触发重订阅）。KWS 自愈重启后健康状态回传时复位。
  const kwsFatalRef = useRef(false)

  useEffect(() => { enabledRef.current = enabled }, [enabled])
  useEffect(() => { onWakeRef.current = onWake }, [onWake])
  useEffect(() => { onDismissRef.current = onDismiss }, [onDismiss])
  const onDisabledHitRef = useRef(onDisabledHit)
  useEffect(() => { onDisabledHitRef.current = onDisabledHit }, [onDisabledHit])

  const armIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      try { onDismissRef.current() } catch (e) { console.error('[kws-wake] onDismiss:', e) }
    }, IDLE_DISMISS_MS)
  }, [])

  const resetIdle = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    armIdleTimer()
  }, [armIdleTimer])

  useEffect(() => {
    const w = window.electronAPI
    // P5(GUI 全量修复 P1): 开关与采集联动——关闭时停 KWS 探测/释放麦克风。
    // 旧实现关闭只是退订 onHit, probe 仍常驻占麦 + 持续广播能量(隐私/功耗);
    // 恢复开启时重新启用采集(与 useVoiceSession.setMicEnabled 的会话内拉锯无冲突,
    // 后者在会话 start/stop 时切换, 本处只在开关翻转时设置)
    if (w?.wake?.setMicEnabled) {
      // 2026-08-15: setMicEnabled 为 Promise<boolean>(preload invoke)——异步
      // 拒绝不在 try/catch 捕获范围, 改 .catch 消费(同步 try 仅兜底旧契约)
      try {
        void w.wake.setMicEnabled(!!enabledRef.current).catch((e: any) => {
          console.warn('[kws-wake] setMicEnabled 失败:', e?.message || e)
        })
      } catch (e: any) { console.warn('[kws-wake] setMicEnabled 失败:', e?.message || e) }
    }
    if (!w || !w.wake || typeof w.wake.onHit !== 'function') {
      console.warn('[kws-wake] electronAPI.wake 不可用（非 Electron 环境），本地唤醒禁用')
      return
    }
    // 2026-08-15: 禁用态(专注模式等)仍订阅命中——但只回调 onDisabledHit 做
    // 语音提示("当前是专注模式,按住空格说话"), 不再静默吞掉。
    const off = w.wake.onHit((payload: { keyword: string }) => {
      // 2026-08-08 fix: 一次说话多次命中去抖——KWS 0.5s 分块喂入时,同一
      // 唤醒词跨块边界可被检测多次(实测"叫一次小龙女命中两次"),渲染层
      // 每次命中都启动会话 → 对话窗口出现重复消息。1.5s 内只响应首次。
      const now = Date.now()
      if (now - lastHitAtRef.current < WAKE_HIT_DEBOUNCE_MS) {
        console.log('[kws-wake] 去抖: 忽略重复命中', payload?.keyword)
        return
      }
      lastHitAtRef.current = now
      console.log('[kws-wake] 本地唤醒命中:', payload?.keyword)
      if (!enabledRef.current) {
        // 2026-08-15: 唤醒词被禁用——提示用户而非沉默
        try { onDisabledHitRef.current?.() } catch (e) { console.error('[kws-wake] onDisabledHit:', e) }
        return
      }
      try { onWakeRef.current() } catch (e) { console.error('[kws-wake] onWake:', e) }
      armIdleTimer()
    })
    // 2026-08-04: 麦克风能量广播(1s 节流)——球体/字幕的能量驱动信号
    let offLevel: (() => void) | null = null
    if (typeof w.wake.onAudioLevel === 'function') {
      offLevel = w.wake.onAudioLevel((payload: { level: number; active: boolean }) => {
        setAudioLevel({ level: Math.min(1, Math.max(0, payload.level)), active: !!payload.active })
      })
    }
    // P2-1 (2026-08-12): 订阅 wake:status——fatal（进程崩溃/模型缺失）时唤醒不可用。
    // 此前只订阅 onHit/onAudioLevel，fatal 静默无任何提示，用户以为唤醒没坏只是不听。
    // 30s 去抖防重复推送；派发 crabpaw:kws-fatal 事件由 App 根层 toast 展示提示。
    let offStatus: (() => void) | null = null
    if (typeof w.wake.onStatus === 'function') {
      offStatus = w.wake.onStatus((payload: { status?: string; fatal?: boolean; detail?: string }) => {
        // 2026-08-15: 健康状态回传（capturing/ready）→ 复位 fatal 闩锁——旧实现
        // setKwsFatal(true) 永不复位: 看门狗自愈重启成功/用户重启后 UI 仍显示
        // "唤醒异常"。仅当此前确实 fatal 过才广播恢复事件（App 根层收尾 toast）。
        if (payload?.fatal !== true && payload?.status !== 'fatal') {
          if (kwsFatalRef.current && (payload?.status === 'capturing' || payload?.status === 'ready')) {
            kwsFatalRef.current = false
            setKwsFatal(false)
            console.log('[kws-wake] 唤醒功能已恢复:', payload?.status)
            try {
              window.dispatchEvent(new CustomEvent('crabpaw:kws-recovered', { detail: { status: payload?.status } }))
            } catch (e) { console.error('[kws-wake] 派发 kws-recovered 事件失败:', e) }
          }
          return
        }
        const now = Date.now()
        if (now - lastFatalAtRef.current < 30000) return
        lastFatalAtRef.current = now
        kwsFatalRef.current = true
        setKwsFatal(true)
        console.error('[kws-wake] 唤醒功能致命异常:', payload?.detail || payload?.status || 'unknown')
        try {
          window.dispatchEvent(new CustomEvent('crabpaw:kws-fatal', { detail: { detail: payload?.detail, at: now } }))
        } catch (e) { console.error('[kws-wake] 派发 kws-fatal 事件失败:', e) }
      })
    }
    armIdleTimer()
    return () => {
      off()
      offLevel?.()
      offStatus?.()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [enabled, armIdleTimer])

  return { resetIdle, audioLevel, kwsFatal }
}
