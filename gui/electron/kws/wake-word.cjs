// wake-word.cjs —— 主进程侧的唤醒管理器
//
// 职责: 启动/重启 KWS 子进程、转发 PCM、转达命中、热更新词表、健康巡检。
// fork 失败不抛(不拖垮 app), 通过 isEnabled() 供上层判断。
// 2026-08-04: 新增 watchdog——子进程假死(进程在但不回心跳/不处理 PCM)30s 后自动重启。
//   移植 LiveKit PublicationMonitor 思想: 1s 巡检 + 超时自愈(见 docs/livekit-voice-analysis)。
const { utilityProcess, BrowserWindow } = require('electron')
const path = require('path')
// 2026-08-04: 窗口化音频活跃检测(移植 LiveKit audiolevel.go)——P2
const { AudioLevelDetector } = require('./audio-level.cjs')

let child = null
let modelDir = null
let keywordsFileStore = null
let spawned = false
let onHit = null
let watchdogTimer = null

// 2026-08-04: 能量检测器 + 1s 广播节流(渲染层语音球/日志消费)
const audioLevel = new AudioLevelDetector()
let levelBroadcastAt = 0

// 2026-08-04: 健康巡检状态——最后心跳时间与累计处理字节(判断假死)
let lastDiagAt = 0
let lastDiagBytes = 0
let watchdogRestarts = 0
// 2026-08-07 fix(双重计数): watchdog 主动 kill 的子进程引用——exit handler 检测到
// 后跳过崩溃计数/重启调度。此前 watchdog kill 路径(removeAllListeners 兜底下)与
// exit handler 各自 recordCrashRestart,一次假死重启消耗两次 3次/10分钟 配额
// → 2 次假死后唤醒被永久禁用(审查报告 P2)。用"子进程身份比对"而非布尔标记,
// 避免 watchdog kill 后新子进程自然崩溃时被陈旧标记误跳过。
let watchdogKilledChild = null

const HEARTBEAT_TIMEOUT_MS = 30000 // 30s 无心跳判定假死
const WATCHDOG_INTERVAL_MS = 10000 // 每 10s 巡检一次

// 2026-08-15: 心跳日志去抖——子进程空闲心跳(无 PCM 也发 diag)不再每 5s 刷屏,
// 仅在活跃↔空闲状态切换时打点一次
let lastDiagWasIdle = false

// T1.4: 崩溃自愈——重启上限 3 次/10 分钟
let crashRestartTimestamps = []
const MAX_CRASH_RESTARTS = 3
const CRASH_RESTART_WINDOW_MS = 10 * 60 * 1000

function canCrashRestart() {
  const now = Date.now()
  crashRestartTimestamps = crashRestartTimestamps.filter(t => now - t < CRASH_RESTART_WINDOW_MS)
  return crashRestartTimestamps.length < MAX_CRASH_RESTARTS
}

function recordCrashRestart() {
  crashRestartTimestamps.push(Date.now())
}

function sendFatalToRenderer(msg) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('wake:status', { status: 'fatal', fatal: true, detail: msg })
    } catch (e) { console.error('[wake] fatal 事件推送失败:', e?.message || e) }
  }
}

/** 健康巡检:假死自动重启(移植 LiveKit PublicationMonitor 1s 巡检 + 超时自愈思想) */
function startWatchdog() {
  if (watchdogTimer) return
  watchdogTimer = setInterval(() => {
    if (!spawned || !child) return
    const idle = Date.now() - lastDiagAt
    if (idle > HEARTBEAT_TIMEOUT_MS) {
      watchdogRestarts++
      console.warn(`[wake] KWS 假死检测: ${Math.round(idle / 1000)}s 无心跳(第 ${watchdogRestarts} 次重启),正在重启…`)
      lastDiagAt = 0
      try {
        const c = child
        child = null
        spawned = false
        // 2026-08-07: 标记本次 kill 为 watchdog 主动重启(exit handler 据此跳过重复计数)
        watchdogKilledChild = c
        c.removeAllListeners()
        c.kill()
      } catch (e) { console.error('[wake] 假死清理失败:', e?.message || e) }
      // T1.4: 检查崩溃重启上限
      if (!canCrashRestart()) {
        console.error('[wake] KWS 假死次数超限(3次/10分钟)，停止自愈，唤醒功能禁用')
        sendFatalToRenderer('KWS 反复假死，唤醒功能已禁用')
        return
      }
      recordCrashRestart()
      // 延迟重启,避免与旧进程退出竞争
      setTimeout(() => spawnChild(), 1000)
    }
  }, WATCHDOG_INTERVAL_MS)
  if (watchdogTimer.unref) watchdogTimer.unref()
}

/** 实际 fork 子进程(供首启与 watchdog 重启共用) */
function spawnChild() {
  if (child) return
  try {
    child = utilityProcess.fork(path.join(__dirname, 'kws-process.cjs'), [], {
      stdio: 'inherit',
      serviceName: 'crabpaw-kws',
    })
    child.on('message', (msg) => {
      if (!msg) return
      if (msg.type === 'ready') {
        console.log('[wake] KWS 子进程就绪')
      } else if (msg.type === 'error') {
        // 2026-08-14: 初始化/热加载失败也走 fatal 上报——此前只 console.error,
        // 与 sendFatalToRenderer 机制脱节,渲染层(useKwsWakeWord kwsFatal toast)无感知,
        // 用户以为唤醒正常只是"没听到"。watchdog 30s 兜底重启仍保留(模型目录修正后自愈)。
        console.error('[wake] KWS 子进程初始化失败(功能禁用):', msg.error)
        sendFatalToRenderer('唤醒词模型加载失败:' + (msg.error || 'unknown'))
      } else if (msg.type === 'hit') {
        console.log('[wake] 命中唤醒词:', msg.keyword)
        try { onHit && onHit(msg.keyword) } catch (e) { console.error('[wake] onHit 回调异常:', e?.message || e) }
      } else if (msg.type === 'diag') {
        // 2026-08-03: 子进程心跳回执（确认子进程活着 + 在处理 PCM）
        // 2026-08-04: 记录心跳时间供 watchdog 判假死
        // 2026-08-15: idle 标记——子进程空闲(无 PCM 流入)也发心跳, liveness 与
        // PCM 吞吐脱钩: 麦克风被 ASR 会话占用/probe 重建期间不再误判假死。
        // 心跳日志仅状态切换时打点, 空闲期不刷屏。
        lastDiagAt = Date.now()
        lastDiagBytes = msg.bytes || 0
        const isIdle = msg.idle === true
        if (isIdle !== lastDiagWasIdle || !isIdle) {
          console.log(`[kws] 子进程心跳: 5s 处理 ${msg.bytes} 字节 PCM${isIdle ? '(空闲)' : ''}`)
        }
        lastDiagWasIdle = isIdle
      }
    })
    // T1.4: spawned=true 必须在 spawn 成功后置位,不掩盖 fork 失败
    child.on('spawn', () => {
      spawned = true
      // 2026-08-15: 新子进程从零起算心跳时钟——旧实现 kill 后 lastDiagAt=0,
      // 下一巡检立刻判"假死"(实测 1786783713s 无心跳), 新子进程还在 init
      // (模型加载数秒)就被杀 → 重启配额 3 次瞬耗尽 → 唤醒永久禁用。
      lastDiagAt = Date.now()
      lastDiagWasIdle = false
      try { child.postMessage({ type: 'init', modelDir, keywordsFile: keywordsFileStore }) } catch (err) {
        console.error('[wake] init 投递失败:', err?.message || err)
      }
    })
    child.on('error', (err) => {
      console.error('[wake] KWS 子进程错误:', err?.message || err)
      spawned = false
      child = null
    })
    child.on('exit', (code) => {
      // 2026-08-07 fix(双重计数): watchdog 主动 kill 的退出不重复计数——
      // 重启由 watchdog 的 1s 定时器负责;身份比对只对"本次被 kill 的子进程"生效,
      // 之后自然崩溃的新子进程仍正常走崩溃自愈
      const wasWatchdogKill = watchdogKilledChild === child
      if (wasWatchdogKill) {
        watchdogKilledChild = null
        console.warn('[wake] KWS 子进程退出 code=' + code + '(watchdog 主动重启,跳过崩溃计数)')
        child = null
        spawned = false
        return
      }
      watchdogKilledChild = null
      console.warn('[wake] KWS 子进程退出 code=' + code)
      child = null
      spawned = false

      // T1.4: 崩溃自愈——5s 延迟重启,上限 3 次/10 分钟
      if (!canCrashRestart()) {
        console.error('[wake] KWS 崩溃次数超限(3次/10分钟)，停止自愈，唤醒功能禁用')
        sendFatalToRenderer('KWS 反复崩溃，唤醒功能已禁用')
        return
      }
      console.warn('[wake] KWS 子进程将在 5s 后自动重启')
      recordCrashRestart()
      setTimeout(() => {
        if (!child && !spawned) spawnChild()
      }, 5000)
    })
    return true
  } catch (err) {
    console.error('[wake] 无法启动 KWS 子进程(忽略):', err?.message || err)
    child = null
    return false
  }
}

/** 启动唤醒子进程 */
function initWakeWord({ modelDir: dir, keywordsFile }) {
  if (child) return spawned
  modelDir = dir
  keywordsFileStore = keywordsFile
  const ok = spawnChild()
  startWatchdog()
  return ok
}

/** 转发一块 16kHz Float32 PCM 给子进程 */
let feedPcmBytes = 0
let feedPcmDiagTs = 0

// ── 2026-08-15: 语音能量打断(barge-in) ────────────────────────────────
// TTS 播放窗口(渲染层经 wake:bargein-window IPC 置位)内, 用户说任何话
// (非唤醒词)即打断——此前打断只能靠"喊唤醒词"(probe 无 AEC 是有意为之,
// 注释见 wake-probe.html, 喊词又被喇叭回声淹没 → 需大声吼)。
// LiveKit 占空比判定: 回声基线 EMA + 超基线 2.5x 连续 3 块(~384ms)触发,
// 回落滞回防抖; 触发后 1.5s 冷却。误触发代价=打断一次播报, 远小于喊不动的代价。
let bargeinWindow = false
let bargeinBaseline = 0
let bargeinStreak = 0
let bargeinCooldownUntil = 0
const BARGEIN_TRIGGER_BLOCKS = 3
const BARGEIN_COOLDOWN_MS = 1500

function setBargeinWindow(v) {
  bargeinWindow = v === true
  if (!bargeinWindow) { bargeinBaseline = 0; bargeinStreak = 0 }
}

function detectBargein(f32) {
  if (!bargeinWindow) return
  const now = Date.now()
  if (now < bargeinCooldownUntil) return
  let sum = 0
  let cnt = 0
  for (let i = 0; i < f32.length; i += 8) { const v = f32[i]; sum += v * v; cnt++ }
  const rms = Math.sqrt(cnt > 0 ? sum / cnt : 0)
  // 回声基线: 低于基线立即跟随(TTS 停顿时快速回落), 高于基线慢速上爬(0.05 EMA)
  if (bargeinBaseline === 0 || rms < bargeinBaseline) bargeinBaseline = rms
  else bargeinBaseline += (rms - bargeinBaseline) * 0.05
  const threshold = Math.max(bargeinBaseline * 2.5, 0.02)
  if (rms > threshold) {
    bargeinStreak++
    if (bargeinStreak >= BARGEIN_TRIGGER_BLOCKS) {
      bargeinStreak = 0
      bargeinCooldownUntil = now + BARGEIN_COOLDOWN_MS
      console.log(`[wake] 语音能量打断触发: rms=${rms.toFixed(4)} baseline=${bargeinBaseline.toFixed(4)} threshold=${threshold.toFixed(4)}`)
      // 2026-08-15 修复: 此前向所有窗口广播 wake:speech-bargein——probe 采集窗不订阅
      // 该事件(唯一消费者是主渲染进程的 wake.onSpeechBargein), 全量广播徒增 IPC
      // 流量。排除 probe 窗口(URL 含 wake-probe), 只向主窗口广播。
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (win.webContents.getURL().includes('wake-probe')) continue
          win.webContents.send('wake:speech-bargein', { rms, baseline: bargeinBaseline })
        } catch { /* 窗口关闭中忽略 */ }
      }
    }
  } else if (rms < threshold * 0.6) {
    bargeinStreak = 0 // 回落才清零(滞回防抖)
  }
}

// 2026-08-04: KWS 自适应增益——USB 麦克风输入微弱(RMS ~0.0018/-55dB,ASR 已有
// AGC 放大,KWS 无增益 → sherpa 打分无法命中唤醒词)。
// 放大到目标 RMS 0.06(纯静音不放大防噪声爆表)。
// R2: 上限 8 → 16——probe 端 g=4 已移除(此前两级增益叠加致正常说话削波 RMS 1.0,
// sherpa 0 召回),统一由本函数自适应放大;弱麦 0.0018 需 33 倍才到 0.06,上限 16
// 可到 0.0288(够 sherpa 打分),强麦 gain 趋近 1 不削波。
function boostPcmForKws(f32) {
  let sum = 0
  let count = 0
  for (let i = 0; i < f32.length; i += 8) {
    const v = f32[i]
    sum += v * v
    count++
  }
  const rms = Math.sqrt(count > 0 ? sum / count : 0)
  if (rms < 0.0005) return f32 // 纯静音不放大
  const gain = Math.min(16, Math.max(1, 0.06 / rms))
  const out = new Float32Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i] * gain
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v
  }
  return out
}

function feedPcm(buffer) {
  if (!child || !buffer) return
  let ab = null
  if (buffer instanceof ArrayBuffer) ab = buffer
  else if (ArrayBuffer.isView(buffer)) ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  else return
  try {
    // 2026-08-03 修复: utilityProcess.postMessage 的 ArrayBuffer——
    // ① 不传 transfer：子进程收不到含 ArrayBuffer 的消息（sherpa 无输入）
    // ② 传 transfer：主进程 segfault（SIGSEGV 崩溃）
    // ③ 稳妥方案：base64 字符串传输（克隆一定可达、无原生崩溃），
    //    性能可接受（5s 320KB → ~427KB 字符串）
    feedPcmBytes += ab.byteLength
    const now = Date.now()
    if (now - feedPcmDiagTs > 5000) {
      console.log(`[wake:feed] 主进程 5s 投递 ${feedPcmBytes} 字节 PCM`)
      feedPcmDiagTs = now
      feedPcmBytes = 0
    }
    // 2026-08-04: 能量检测(窗口化百分位 + EMA,静音门控信号源)+ 1s 广播给渲染层
    try {
      // 2026-08-15: barge-in 打断检测(原始信号, 先于 KWS 增益)
      detectBargein(new Float32Array(ab))
      audioLevel.observePcmF32(new Float32Array(ab))
      if (now - levelBroadcastAt > 1000) {
        levelBroadcastAt = now
        const active = audioLevel.isActive(now)
        const level = audioLevel.getLevel(now)
        for (const win of BrowserWindow.getAllWindows()) {
          try { win.webContents.send('wake:audio-level', { level, active }) } catch { /* 窗口关闭中忽略 */ }
        }
      }
    } catch (e) { console.error('[wake] 能量检测失败:', e?.message || e) }
    // 2026-08-04: KWS 自适应增益(弱麦克风信号放大后送 sherpa)——能量检测用原始信号
    const boosted = boostPcmForKws(new Float32Array(ab))
    const boostedBuf = boosted.buffer.slice(boosted.byteOffset, boosted.byteOffset + boosted.byteLength)
    child.postMessage({ type: 'pcm', b64: Buffer.from(boostedBuf).toString('base64') })
  } catch (err) {
    console.error('[wake] feedPcm 投递失败:', err?.message || err)
  }
}

/** 热更新词表（用户改唤醒词后调用） */
function reloadKeywords(keywordsFile) {
  if (!child || !spawned) return false
  try { child.postMessage({ type: 'reload', modelDir, keywordsFile }); return true } catch (err) {
    console.error('[wake] reload 投递失败:', err?.message || err)
    return false
  }
}

function isEnabled() { return spawned }
function setOnHit(cb) { onHit = cb }

// 2026-08-14: probe 自愈重建后重置心跳时钟——probe 死亡是子进程心跳停的根因之一,
// 重建 probe 后给其 30s 重新供流,避免与子进程假死重启在同一时刻双双触发
// (probe 重建即可自愈时,不应再杀子进程)。由 index.ts 的 probe 自愈巡检调用。
function resetWatchdogClock() {
  lastDiagAt = Date.now()
}

module.exports = { initWakeWord, feedPcm, reloadKeywords, isEnabled, setOnHit, resetWatchdogClock, setBargeinWindow }
