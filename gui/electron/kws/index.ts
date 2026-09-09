/**
 * 唤醒模块协调层（主进程）
 * 职责: 读配置 → 生成词表 → 启动 KWS 子进程 → 创建隐藏采集窗口 → IPC 桥
 */
import { BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

// CJS 模块无类型声明，使用 require 避免 TS 类型错误
// @ts-ignore
const { initWakeWord, feedPcm, reloadKeywords, isEnabled, setOnHit, resetWatchdogClock, setBargeinWindow } = require('./wake-word.cjs')
// @ts-ignore
const { buildKeywordsFile, validateWakeWord } = require('./keywords')

// 2026-08-03: 默认词表同时含品牌词"小螃蟹"与用户常用称呼（多词支持）
const DEFAULT_WAKE_WORDS = ['小螃蟹', '小龙女']

let probeWindow: BrowserWindow | null = null

// 2026-08-14: probe 采集窗自愈——probe 静默死亡(渲染层崩溃/被系统挂起)时 PCM 停 →
// 心跳也停 → 子进程 watchdog 重启的只是子进程,修不好 probe → 唤醒永久失效无提示。
// 5s 诊断周期内无 PCM 计一个零周期,连续 6 个(30s)且采集应启用时重建窗口自愈。
let probeMicEnabled = true
let probeZeroCycles = 0
const PROBE_ZERO_CYCLES_MAX = 6

/** 创建隐藏采集窗口(首启与自愈重建共用)——wake-probe.html 在 DOMContentLoaded 自动开采 */
function createProbeWindow(): void {
  try {
    // T1.7: sandbox: true + 仅采集窗 local:// 地址可触发 IPC
    probeWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'wake-probe-preload.cjs'),
      },
    })
    probeWindow.loadFile(path.join(__dirname, 'wake-probe.html'))
  } catch (err: any) {
    console.error('[wake] 采集窗口创建失败(唤醒词禁用):', err?.message || err)
  }
}

/** probe 自愈重建:销毁旧窗口(可能已死/半死)→ 重建 → 重置零周期计数与子进程心跳时钟 */
function rebuildProbeWindow(): void {
  console.warn('[wake] probe 30s 无 PCM(采集窗静默死亡),重建采集窗口…')
  try {
    if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy()
  } catch (err: any) {
    console.error('[wake] 旧采集窗口销毁失败:', err?.message || err)
  }
  probeWindow = null
  probeZeroCycles = 0
  createProbeWindow()
  // 与子进程 30s 假死重启解耦:probe 死亡是心跳停的根因之一——重建后重置其
  // 心跳时钟,给新 probe 30s 重新供流,避免两个巡检在同一时刻双双触发
  try { resetWatchdogClock() } catch (err: any) { console.warn('[wake] 重置子进程 watchdog 时钟失败:', err?.message || err) }
}

/** 生成词表文件到用户数据目录，返回路径 */
function writeKeywordsFile(userDataDir: string, wakeWord: string | string[]): string {
  const content = buildKeywordsFile(wakeWord)
  const file = path.join(userDataDir, 'wake-keywords.txt')
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

/** 启动唤醒体系 */
export function initWake({ userDataDir, modelDir, getWakeWord }: {
  userDataDir: string
  modelDir: string
  getWakeWord: () => string | string[]
}): void {
  let keywordsFile = ''
  try {
    // 2026-08-03: 用户自定义词 + 默认品牌词双词表（多词支持）
    // 2026-08-06: 支持用户词为数组（多唤醒词）——getWakeWord 可能返回 ['小螃蟹','小龙女']
    const userRaw = getWakeWord() || ''
    const userWords = Array.isArray(userRaw) ? userRaw.filter(w => typeof w === 'string' && w) : (userRaw ? [userRaw] : [])
    const words = userWords.length > 0
      ? [...new Set([...userWords, ...DEFAULT_WAKE_WORDS])]
      : DEFAULT_WAKE_WORDS
    keywordsFile = writeKeywordsFile(userDataDir, words)
  } catch (err: any) {
    console.error('[wake] 词表生成失败:', err?.message || err)
    return
  }

  setOnHit((keyword: string) => {
    // 2026-08-03: 主进程命中日志（子进程 console 在 Windows utilityProcess 可能不转发）
    console.log('[wake] 命中唤醒词:', keyword)
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('wake:hit', { keyword }) } catch (e: any) { console.error('[wake] 命中转发失败:', e?.message || e) }
    }
  })

  initWakeWord({ modelDir, keywordsFile, logDir: userDataDir })

  // 隐藏采集窗口
  createProbeWindow()

  // T1.20: 采集窗口 senderFrame 精确比对——substring 匹配可被 URL 含
  // 'wake-probe' 字样的其他窗口伪造;主判定用 mainFrame 引用相等,probe 窗口
  // 未创建/已销毁时退化为 URL 子串兜底(与旧行为一致)。
  const isProbeFrame = (frame: any): boolean => {
    if (probeWindow && !probeWindow.isDestroyed()) {
      return frame === probeWindow.webContents.mainFrame
    }
    return !!frame?.url?.includes('wake-probe')
  }

  // 2026-08-03: 麦克风占用切换——ASR 会话激活时暂停 KWS 采集（释放 mic），
  // 会话结束恢复。避免 probe 与 ASR 并发抢 mic 导致 ASR 收到静音流。
  // F7: 改为可 await 的 handle——等 probe 完成 stop/start 的回执(ack)后再 resolve,
  // 消除"渲染 getUserMedia 时 probe 还没停完"的抢麦竞态窗口。
  ipcMain.handle('wake:mic-enabled', (event, enabled: boolean) => {
    // 2026-08-15 守卫反转修复: 该通道的唯一调用方是主渲染进程(useVoiceSession/
    // useKwsWakeWord 经 preload invoke), probe 采集窗从不 invoke 此通道。旧守卫
    // 要求 senderFrame 是 probe frame → 主窗口恒 false → probe 从不收到
    // wake:mic-toggle → ASR 期间不暂停采集(抢麦)/关唤醒词时不停止(隐私功耗)。
    // 改为与 wake:bargein-window 同款语义: 拒绝 probe 自身, 放行主窗口。
    if (isProbeFrame(event.senderFrame)) return false
    // 2026-08-14: 记录采集开关状态——自愈巡检只在"应采集"时计数零 PCM 周期
    // (ASR 会话主动暂停 probe 属正常,不得误判死亡重建)
    probeMicEnabled = enabled === true
    return new Promise<boolean>((resolve) => {
      if (!probeWindow || probeWindow.isDestroyed()) { resolve(false); return }
      let done = false
      const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok) } }
      const onAck = (_ev: Electron.IpcMainEvent) => {
        if (isProbeFrame(_ev.senderFrame)) finish(true)
      }
      ipcMain.on('wake:mic-toggle-ack', onAck)
      // 兜底:probe 的 stop/start 是同步 DOM 操作,300ms 足够;超时仍视为成功
      setTimeout(() => { ipcMain.removeListener('wake:mic-toggle-ack', onAck); finish(true) }, 300)
      try {
        probeWindow.webContents.send('wake:mic-toggle', enabled === true)
      } catch (err: any) {
        console.error('[wake] mic-toggle 下发失败:', err?.message || err)
        ipcMain.removeListener('wake:mic-toggle-ack', onAck)
        finish(false)
      }
    })
  })

  // 2026-08-15: barge-in 打断窗口开关——渲染层 TTS 播放开始/结束经此 IPC 置位,
  // 主进程在窗口内做能量打断检测(说任何话即可打断, 无需喊唤醒词)。
  // 仅主窗口(非 probe 采集窗)可触发。
  ipcMain.handle('wake:bargein-window', (event, v: boolean) => {
    if (isProbeFrame(event.senderFrame)) return false
    setBargeinWindow(v === true)
    return true
  })

  // 采集窗口 → 主进程 → KWS 子进程
  // 2026-08-03 诊断: PCM 数据量 + RMS 打点（每 5s）——确认采集链路通且非静音
  let pcmDiagBytes = 0
  let pcmDiagPeakRms = 0
  ipcMain.on('wake:pcm', (event, buf) => {
    // T1.7: 仅采集窗口(probe)允许推送 PCM
    if (!isProbeFrame(event.senderFrame)) return
    try {
      if (buf && buf.byteLength) {
        pcmDiagBytes += buf.byteLength
        // 抽样 RMS：Float32 前 4096 样本
        const f32 = new Float32Array(buf)
        const n = Math.min(4096, f32.length)
        let sum = 0
        for (let i = 0; i < n; i += 16) { const v = f32[i]; sum += v * v }
        const rms = Math.sqrt(sum / Math.ceil(n / 16))
        if (rms > pcmDiagPeakRms) pcmDiagPeakRms = rms
      }
      feedPcm(buf)
    } catch (err: any) { console.error('[wake] feedPcm 失败:', err?.message || err) }
  })
  setInterval(() => {
    if (pcmDiagBytes > 0) {
      try {
        console.log(`[wake:pcm] 5s 采集 ${pcmDiagBytes} 字节, 峰值RMS=${pcmDiagPeakRms.toFixed(4)}`)
      } catch (err) { console.warn('[wake] 采集诊断打点失败:', err instanceof Error ? err.message : String(err)) }
      pcmDiagBytes = 0
      pcmDiagPeakRms = 0
      probeZeroCycles = 0
      return
    }
    // 2026-08-14: 零 PCM 周期计数——probe 静默死亡(渲染层崩溃/被系统挂起)时 PCM 停 →
    // 心跳停 → 子进程 watchdog 重启的只是子进程,修不好 probe → 唤醒永久失效。
    // 连续 6 个 5s 周期(30s)无 PCM 且采集应启用 → 重建 probe 窗口自愈。
    if (probeMicEnabled) {
      probeZeroCycles++
      if (probeZeroCycles >= PROBE_ZERO_CYCLES_MAX) rebuildProbeWindow()
    } else {
      probeZeroCycles = 0 // ASR 会话主动暂停采集:正常,不计入死亡判定
    }
  }, 5000)
  ipcMain.on('wake:status', (event, payload) => {
    // T1.7: 仅采集窗口(probe)允许上报状态
    if (!isProbeFrame(event.senderFrame)) return
    // 2026-08-03: 主进程日志打点——排查采集设备/状态（probe 窗口 console 不转发）
    try { console.log('[wake:status]', JSON.stringify(payload)) } catch (err) { console.warn('[wake] 状态打点失败:', err instanceof Error ? err.message : String(err)) }
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('wake:status', payload) } catch (e: any) { console.error('[wake] 状态转发失败:', e?.message || e) }
    }
  })
}

/** 更新唤醒词: 校验 → 重新生成词表 → 热加载 */
export function setWakeKeyword(userDataDir: string, wakeWord: string | string[]): { ok: boolean; error?: string } {
  const check = validateWakeWord(wakeWord)
  if (!check.ok) return { ok: false, error: check.error }
  try {
    // 2026-08-06: 多唤醒词——用户词 + 品牌默认词合并去重（保证"小龙女"常驻）
    const userWords = Array.isArray(wakeWord) ? wakeWord : [wakeWord]
    const merged = [...new Set([...userWords, ...DEFAULT_WAKE_WORDS])]
    const file = writeKeywordsFile(userDataDir, merged)
    reloadKeywords(file)
    return { ok: true }
  } catch (err: any) {
    console.error('[wake] 更新唤醒词失败:', err?.message || err)
    return { ok: false, error: err?.message || String(err) }
  }
}

export function isWakeEnabled(): boolean { return isEnabled() }
