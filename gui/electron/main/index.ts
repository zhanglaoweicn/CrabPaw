import { app, BrowserWindow, ipcMain, dialog, nativeImage, net, protocol, Tray, Menu, session, powerSaveBlocker, Notification } from 'electron'
import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import http from 'http'
import https from 'https'
import { crashReporter } from 'electron'
import { parseWindowMode, applyWindowMode } from './window-mode'
import { sanitizeConfigSetPayload } from './config-set-guard'

let mainWindow: BrowserWindow | null = null
let crabpawServer: ChildProcess | null = null
let larkBridge: ChildProcess | null = null
let wecomBridge: ChildProcess | null = null
let isRestarting = false
// 2026-08-08(审计 P1): 主动停止服务标志——stopServices 置位后 exit handler
// 短路自动重启。旧实现 SIGTERM 造成后端非零退出 → 命中"崩溃自动重启"分支,
// "停止服务"实际停不了(5s 后又活)
let isStoppingServices = false
let serviceReady = false
let serverStartedByUs = false
let restartAttempts = 0
const MAX_RESTART_ATTEMPTS = 3
let isStartingServer = false  // Startup lock to prevent concurrent calls
let tray: Tray | null = null
let closeToTray = true  // 关闭窗口 = 缩到托盘，不退出
let isCreatingTray = false  // 托盘创建锁，防止并发调用
let isTtsDucked = false  // TTS duck音量状态

// E4: Typed isQuitting property — track alongside app instead of (app as any).isQuitting
let appIsQuitting = false

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

const API_PORT = 38767
// E6: Read version from package.json instead of hardcoding
const APP_VERSION = (() => {
  try {
    return require('../../../package.json').version || '1.0.0'
  } catch (err) {
    console.warn('[main] package.json 版本读取失败,回退 app.getVersion:', err instanceof Error ? err.message : String(err))
    return app.getVersion?.() || '1.0.0'
  }
})()

function detectDevMode(): boolean {
  // Check if running in Vite dev server mode
  if (process.env.VITE_DEV_SERVER_URL) return true

  // Check NODE_ENV
  if (process.env.NODE_ENV === 'development') return true

  // Check if running inside asar package (packaged mode)
  // If __dirname contains 'app.asar', it is in packaged mode
  if (__dirname.includes('app.asar')) return false

  // Check if src/cli/index.js exists (dev mode indicator)
  const projectRoot = path.resolve(__dirname, '../../..')
  const srcCliPath = path.join(projectRoot, 'src', 'cli', 'index.js')
  if (fs.existsSync(srcCliPath)) return true
  // Also check 4 levels up (gui subdirectory structure)
  const crabpawRoot = path.resolve(__dirname, '../../../..')
  const crabpawCliPath = path.join(crabpawRoot, 'src', 'cli', 'index.js')
  if (fs.existsSync(crabpawCliPath)) return true

  // Default to packaged mode
  return false
}

const isDev = detectDevMode()

// F3: 无手势自动启动连续对话/唤醒——autoplay 策略默认要求用户手势才允许
// AudioContext 启动,导致无手势时音频流不流动 → PCM 静音 → 火山 ASR 聋掉
// ("看起来在听、实际零转录",空格 PTT 有手势所以正常)。
// 桌面应用用户已显式启动应用,无需手势限制;浏览器模式无此开关,靠 F4 重试兜底。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function getBackendCwd(): string {
  if (isDev) {
    // Dev mode: __dirname = dist-electron/main, go up 4 levels to crabpaw root
    const projectRoot = path.resolve(__dirname, '../../..')
    if (fs.existsSync(path.join(projectRoot, 'src', 'cli', 'index.js'))) {
      return projectRoot
    }
    // If no src/cli under gui dir, try going up to crabpaw dir
    const crabpawRoot = path.resolve(__dirname, '../../../..')
    if (fs.existsSync(path.join(crabpawRoot, 'src', 'cli', 'index.js'))) {
      return crabpawRoot
    }
  }
  return process.resourcesPath
}

function getNodeExePath(): string {
  if (isDev) {
    return 'node'
  }
  return path.join(process.resourcesPath, 'node.exe')
}

const BACKEND_CWD = getBackendCwd()
const NODE_EXE = getNodeExePath()

// ── 2026-09-08 全内置发行: 预置运行时工具前置进 PATH ──────────────────────
// npm(技能依赖/Remotion 运行时自装)与 ffmpeg(VideoEdit 工具 + 主进程 TTS 解码)
// 随包发行: 打包版从 resources/ 解析, dev 版若仓库已 download:deps 也生效。
// 主进程 process.env 前置 → 后端/桥接 spawn(env 展开 process.env)与主进程自身
// spawn(TTS)全部继承, 目标机零系统环境依赖。
;(function prependPortableToolsPath() {
  const prependDirs: string[] = []
  const ffmpegBinOf = (base: string) => path.join(base, 'portable', 'ffmpeg', 'bin')
  if (!isDev) {
    prependDirs.push(path.dirname(NODE_EXE))                    // resources/ → npm.cmd/npx.cmd
    prependDirs.push(ffmpegBinOf(String(process.resourcesPath))) // resources/portable/ffmpeg/bin
  } else {
    const devFfmpegBin = ffmpegBinOf(BACKEND_CWD)
    if (fs.existsSync(devFfmpegBin)) prependDirs.push(devFfmpegBin)
  }
  // Windows 环境变量键名大小写不定(Path/PATH), 按现键名原位修改, 避免 spawn env 展开出重复键
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') || 'PATH'
  for (const dir of prependDirs) {
    try {
      if (fs.existsSync(dir) && !(process.env[pathKey] || '').includes(dir)) {
        process.env[pathKey] = `${dir}${path.delimiter}${process.env[pathKey] || ''}`
        console.log('[>>] Portable tools path prepended:', dir)
      }
    } catch (e) {
      console.warn('[WARN] PATH 前置失败:', dir, e instanceof Error ? e.message : String(e))
    }
  }
})()

function getPortableDataDir(): string {
  if (isDev) {
    const projectDataDir = path.join(BACKEND_CWD, 'data', '.crabpaw')
    if (fs.existsSync(projectDataDir)) {
      return projectDataDir
    }
    return path.join(app.getPath('userData'), '.crabpaw')
  }
  const exeDir = path.dirname(app.getPath('exe'))
  const portableDataDir = path.join(exeDir, 'CrabPaw-Data')
  try {
    if (!fs.existsSync(portableDataDir)) {
      fs.mkdirSync(portableDataDir, { recursive: true })
    }
  } catch (e) {
    // S2-NSIS: 安装到 Program Files 等无写权限目录时,自动回退到 userData,而不是拒绝启动
    console.warn('[WARN] exe 目录不可写,数据目录回退到 userData:', portableDataDir,
      e instanceof Error ? e.message : String(e))
    return getUserDataFallbackDir()
  }
  return portableDataDir
}

/** S2-NSIS: 无写权限场景的数据目录回退点(exe 目录写测试失败时也复用) */
function getUserDataFallbackDir(): string {
  return path.join(app.getPath('userData'), 'CrabPaw-Data')
}

// S2-NSIS: 后续可能回退到 userData,故全部用 let(回退时重新赋值)
let DATA_DIR = getPortableDataDir()
let CONFIG_PATH = path.join(DATA_DIR, 'config.json')
let TOKEN_PATH = path.join(DATA_DIR, '.api_token')
let PORT_PATH = path.join(DATA_DIR, '.api_port')
let LOG_PATH = path.join(DATA_DIR, 'crabpaw.log')

let _credMgrCache: any = null
function getCredMgr() {
  if (!_credMgrCache) {
    const { getCredentialManager } = require(path.join(BACKEND_CWD, 'src/core/credential-manager'))
    _credMgrCache = getCredentialManager(DATA_DIR)
  }
  return _credMgrCache
}

const API_TOKEN = (() => {
  if (fs.existsSync(TOKEN_PATH)) {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf-8').trim()
    if (existing) return existing
  }
  return crypto.randomBytes(32).toString('hex')
})()

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
  if (!isDev && !fs.existsSync(CONFIG_PATH)) {
    const defaultDataDir = path.join(process.resourcesPath, 'data')
    if (fs.existsSync(defaultDataDir)) {
      try {
        // Exclude dev environment remnants and user-generated data
        const EXCLUDE_DIRS = new Set([
          'logs', 'generated-images', 'generated-videos', 'tts-output',
          'enterprise-cache', 'enterprise-scores', 'stock-evolution',
          'tool-evolution', 'perception', 'personalization', 'recovery',
          'watchdog', 'trajectories', 'kanban', 'analysis', 'reviews', 'metrics',
          'curator', 'composition', 'memory-snapshot', 'stability-reports',
          'backups', '.crabpaw', 'workspace',
          // 2026-08-19 发行审计 W9: ~400MB CloakBrowser 运行时直接读
          // resources/data/cloakbrowser(browser-control/index.js:15), 无需首启拷贝;
          // 此前整体复制进用户数据目录造成首启翻倍磁盘+慢首启。
          'cloakbrowser'
        ])
        const EXCLUDE_FILES = new Set([
          'history.db', 'history.db-shm', 'history.db-wal',
          'onboarding.json', 'patterns.json', 'skill-lifecycle.json', 'skill-usage.json',
          'crabpaw.log', 'crash.log', '.api_keys.json', '.api_port', '.api_token',
          '.wecom_bridge.pid', '.wecom_send_port', 'lark-status.json', 'wecom-status.json',
          'audit-log.json', 'calendar.json', 'schedule.json', 'schedules.json',
          'skill-content-cache.json', 'skill-trajectory.json', 'usage-stats.json',
          'fts-memory.db', 'unified-memory.db', 'skill-quality.db', 'skill-versions.db',
          'config-evolution.json', 'evolution-feedback.json', 'evolution-system.json',
          'memory-evolution.json', 'plugins-data.json', 'security-policy.yaml',
          'skill-evolution.json', 'skill-recommender.json', 'config.json',
          'dream.json', 'access-log.json', 'archive-index.json'
        ])
        const items = fs.readdirSync(defaultDataDir, { withFileTypes: true })
        for (const item of items) {
          if (item.isDirectory() && EXCLUDE_DIRS.has(item.name)) continue
          if (item.isFile() && EXCLUDE_FILES.has(item.name)) continue
          const src = path.join(defaultDataDir, item.name)
          const dest = path.join(DATA_DIR, item.name)
          if (!fs.existsSync(dest)) {
            if (item.isDirectory()) {
              copyDirSync(src, dest)
            } else {
              fs.copyFileSync(src, dest)
            }
          }
        }
        console.log('[OK] Default data initialized to portable data dir')
      } catch (e) {
        console.warn('[WARN] Copy default data failed:', e)
      }
    }
  }
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true })
  const items = fs.readdirSync(src, { withFileTypes: true })
  for (const item of items) {
    const srcPath = path.join(src, item.name)
    const destPath = path.join(dest, item.name)
    if (item.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function saveApiCredentials() {
  ensureDataDir()
  fs.writeFileSync(TOKEN_PATH, API_TOKEN, 'utf-8')
  fs.writeFileSync(PORT_PATH, API_PORT.toString(), 'utf-8')
}

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB - rotate log when exceeding this size
const MAX_LOG_FILES = 5 // Keep at most 5 historical log files
let logRotationTimer: ReturnType<typeof setInterval> | null = null
// === RotatingLogManager: Proper log rotation with fd-safe writes ===
// Uses pipe-based approach to avoid the fd-rename leak where
// fs.openSync fds continue writing to renamed inodes indefinitely.
class RotatingLogManager {
  private currentPath: string
  private stream: any = null
  private bytesWritten: number = 0
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private closed: boolean = false

  constructor() {
    this.currentPath = getDatedLogPath()
    this._reopen()
    this.flushTimer = setInterval(() => this._flush(), 5000)
    if (this.flushTimer.unref) this.flushTimer.unref()
  }

  private _reopen() {
    if (this.stream) {
      try { this.stream.end() } catch (err: any) { console.warn('[RotatingLog] stream end 失败:', err?.message || err) }
    }
    const newPath = getDatedLogPath()
    if (newPath !== this.currentPath) {
      this.currentPath = newPath
    }
    this.stream = fs.createWriteStream(this.currentPath, { flags: 'a' })
    this.stream.on('error', (err: Error) => { console.error('[RotatingLog] stream error:', err.message) })
    // E8: Reset bytesWritten inside _reopen() after rotation to avoid race
    this.bytesWritten = fs.existsSync(this.currentPath)
      ? fs.statSync(this.currentPath).size : 0
  }

  write(data: string) {
    if (this.closed) return
    this.buffer.push(data)
    this.bytesWritten += Buffer.byteLength(data, 'utf-8')
    if (this.bytesWritten >= MAX_LOG_SIZE) {
      this._rotate()
    }
  }

  writeFromStream(readable: any) {
    let leftover = ''
    readable.on('data', (chunk: Buffer) => {
      leftover += chunk.toString('utf-8')
      const lines = leftover.split('\n')
      leftover = lines.pop() || ''
      for (const line of lines) {
        this.write(line + '\n')
      }
    })
    readable.on('end', () => {
      if (leftover) this.write(leftover)
    })
    readable.on('error', (err: Error) => { console.error('[RotatingLog] stream read error:', err.message) })
  }

  private _flush() {
    if (this.buffer.length === 0) return
    const batch = this.buffer.join('')
    this.buffer = []
    // Check if date changed (new day)
    const newPath = getDatedLogPath()
    if (newPath !== this.currentPath) {
      this._reopen()
    }
    if (this.stream) {
      try { this.stream.write(batch) } catch (err: any) { console.warn('[RotatingLog] stream write 失败:', err?.message || err) }
    }
  }

  private _rotate() {
    if (this.stream) {
      try { this.stream.end() } catch (err: any) { console.warn('[RotatingLog] stream end 失败:', err?.message || err) }
      this.stream = null
    }
    this._flush()
    const rotatedPath = this.currentPath + '.' + Date.now()
    try {
      if (fs.existsSync(this.currentPath)) {
        fs.renameSync(this.currentPath, rotatedPath)
        console.log('[LOG] Rotated:', path.basename(this.currentPath), '->', path.basename(rotatedPath))
      }
    } catch (err: any) { console.warn('[LOG] 轮转重命名失败(文件可能被锁定):', err?.message || err) }
    this._reopen()
    cleanupOldLogs()
  }

  shutdown() {
    this.closed = true
    this._flush()
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    if (this.stream) { try { this.stream.end() } catch (err: any) { console.warn('[RotatingLog] stream end 失败:', err?.message || err) }; this.stream = null }
  }
}

let sharedLogManager: RotatingLogManager | null = null

function getLogManager(): RotatingLogManager {
  if (!sharedLogManager) {
    sharedLogManager = new RotatingLogManager()
  }
  return sharedLogManager
}

// T1.12: 全局异常兜底——Electron 默认 uncaughtException 会终止主进程,
// 注册 handler 后记录到日志并保持进程存活(单实例锁/托盘/服务生命周期不被意外打断)。
process.on('uncaughtException', (err) => {
  try {
    console.error('[main] uncaughtException:', err)
    if (sharedLogManager) {
      sharedLogManager.write(`[${new Date().toISOString()}] [uncaughtException] ${err?.stack || err?.message || String(err)}\n`)
    }
  } catch (logErr) {
    console.error('[main] uncaughtException 日志记录失败:', logErr)
  }
})
process.on('unhandledRejection', (reason) => {
  try {
    console.error('[main] unhandledRejection:', reason)
    if (sharedLogManager) {
      sharedLogManager.write(`[${new Date().toISOString()}] [unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}\n`)
    }
  } catch (logErr) {
    console.error('[main] unhandledRejection 日志记录失败:', logErr)
  }
})


// Get date-based log file path to prevent single file growing indefinitely
function getDatedLogPath(): string {
  const dateStr = new Date().toISOString().slice(0, 10)
  return path.join(DATA_DIR, `crabpaw-${dateStr}.log`)
}

// Clean up old log files exceeding MAX_LOG_FILES (sorted by mtime)
function cleanupOldLogs(): void {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => /^crabpaw-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/.test(f) || /^crabpaw\.log(\.\d+)?$/.test(f))
      .map(f => ({
        name: f,
        path: path.join(DATA_DIR, f),
        mtime: fs.statSync(path.join(DATA_DIR, f)).mtime.getTime(),
        size: fs.statSync(path.join(DATA_DIR, f)).size,
      }))
      .sort((a, b) => b.mtime - a.mtime)

    // Keep the newest MAX_LOG_FILES, delete the rest
    for (let i = MAX_LOG_FILES; i < files.length; i++) {
      try { fs.unlinkSync(files[i].path) } catch (err) { console.warn('[LOG] 清理旧日志失败(文件可能被锁定):', err instanceof Error ? err.message : String(err)) }
    }
  } catch (e) {
    console.error('Clean old logs failed:', e)
  }
}

function rotateLogIfNeeded() {
  try {
    // Check all crabpaw*.log files, rotate those exceeding MAX_LOG_SIZE
    const files = fs.readdirSync(DATA_DIR).filter(f => /^crabpaw.*\.log$/.test(f))
    for (const file of files) {
      const filePath = path.join(DATA_DIR, file)
      if (!fs.existsSync(filePath)) continue
      const stat = fs.statSync(filePath)
      if (stat.size < MAX_LOG_SIZE) continue

      // Rotate: file -> file.1, file.1 -> file.2, ...
      for (let i = MAX_LOG_FILES; i >= 1; i--) {
        const oldPath = `${filePath}.${i}`
        if (fs.existsSync(oldPath)) {
          if (i === MAX_LOG_FILES) {
            try { fs.unlinkSync(oldPath) } catch (err) { console.warn('[LOG] 旧日志删除失败(Windows 可能锁定):', err instanceof Error ? err.message : String(err)) }
          } else {
            try { fs.renameSync(oldPath, `${filePath}.${i + 1}`) } catch (err) { console.warn('[LOG] 旧日志轮转重命名失败:', err instanceof Error ? err.message : String(err)) }
          }
        }
      }
      try {
        fs.renameSync(filePath, `${filePath}.1`)
        console.log(`[LOG] Log rotation done: ${file} (${(stat.size / 1024 / 1024).toFixed(1)}MB -> ${file}.1)`)
      } catch (e) {
        // File locked on Windows, cannot rename; log but do not abort
        console.warn(`[WARN] Log rotation failed (file may be locked): ${file}`, e instanceof Error ? e.message : e)
      }
    }
    cleanupOldLogs()
  } catch (e) {
    console.error('Log rotation failed:', e)
  }
}

function startLogRotation() {
  // Check immediately on startup
  rotateLogIfNeeded()
  // Check every 30s (old 5min was too slow, can grow to GB-level)
  logRotationTimer = setInterval(rotateLogIfNeeded, 30 * 1000)
  if (logRotationTimer.unref) logRotationTimer.unref()
}

function stopLogRotation() {
  if (logRotationTimer) {
    clearInterval(logRotationTimer)
    logRotationTimer = null
  }
}

// T1.10: 主窗口导航白名单——主窗口自身导航零校验时,被 XSS 注入的 window.location
// 可把整个应用导航到任意页面。此函数判定哪些 URL 允许替换主窗口内容。
function isAllowedNavigationUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    // about:blank 是 Electron 初始化阶段的安全占位页
    if (u.protocol === 'about:' && rawUrl === 'about:blank') return true
    // file: 仅放行打包后的应用入口 index.html 本体
    if (u.protocol === 'file:') {
      let filePart = decodeURIComponent(u.pathname)
      if (/^\/[A-Za-z]:/.test(filePart)) filePart = filePart.slice(1) // /D:/x → D:/x
      const candidate = path.normalize(filePart.replace(/\//g, path.sep)).toLowerCase()
      const indexPath = path.normalize(path.join(__dirname, '../../dist/index.html')).toLowerCase()
      return candidate === indexPath
    }
    // http(s): 仅 dev server URL(打包版导航来源只能是 file: 或约等空白页)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      if (!VITE_DEV_SERVER_URL) return false
      return rawUrl.startsWith(VITE_DEV_SERVER_URL)
    }
    return false
  } catch {
    return false
  }
}

function createWindow() {
  // 销毁旧窗口，防止 Vite HMR 时任务栏图标堆积
  if (mainWindow) {
    try { mainWindow.destroy() } catch (err) { console.warn('[main] 窗口销毁失败:', err instanceof Error ? err.message : String(err)) }
    mainWindow = null
  }

  // P5 fix: blockerId 提升到 createWindow 作用域，供 closed 回调经闭包释放（每次窗口独立，避免模块级跨窗口竞态）
  let blockerId: number | null = null

  // 注意：不要在这里销毁和重建托盘！
  // Windows 系统托盘中 tray.destroy() 不会立即移除图标，
  // 立即 new Tray() 会创建第二个图标，旧图标残留成"幽灵图标"直到鼠标悬停。
  // 托盘的生命周期独立于窗口，只应在 app 退出时销毁。

  let iconPath: string
  
  if (isDev) {
    iconPath = path.join(__dirname, '../../build/icons/win/icon.ico')
  } else {
    iconPath = path.join(process.resourcesPath, 'build/icons/win/icon.ico')
  }
  
  // If icon does not exist, try fallback path
  if (!fs.existsSync(iconPath)) {
    const altPath = path.join(__dirname, '../../build/icons/win/icon.ico')
    if (fs.existsSync(altPath)) {
      iconPath = altPath
    }
  }
  
  console.log('[FIND] Icon path:', iconPath)
  console.log('[FIND] Icon exists:', fs.existsSync(iconPath))
  
  // 麦克风/语音识别权限：自动批准（Electron 默认会拒绝 media 权限）
  // permission 类型：media (getUserMedia/SpeechRecognition), geolocation, notifications, etc.
  // 2026-08-08(审计 P1): 校验请求来源——旧实现全局放行,setWindowOpenHandler 弹出的
  // https 弹窗页面(渲染层 window.open 的任意链接)也能获授麦克风权限,恶意站点可静默开麦。
  // 仅信任主窗口(打包 index.html / dev server)与 KWS wake-probe 窗口。
  const isTrustedPermissionSource = (wc: any): boolean => {
    if (!wc || typeof wc.getURL !== 'function') return false
    const url = wc.getURL() || ''
    if (!url) return false
    if (isAllowedNavigationUrl(url)) return true
    try {
      const u = new URL(url)
      if (u.protocol === 'file:' && u.pathname.includes('wake-probe.html')) return true
    } catch { /* 非法 URL 视为不可信 */ }
    return false
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    // 2026-08-16: 补 'fullscreen'——HTML5 视频全屏(requestFullscreen, 原生控制条
    // 全屏按钮)此前被白名单外默认拒绝 → 视频面板全屏静默失败。仍走可信来源门控。
    // 2026-08-16(第二轮): 补 'clipboard-sanitized-write'——navigator.clipboard.writeText()
    // (对话窗口"复制回复"、文件浏览器复制路径)被白名单外默认拒绝 → toast 复制失败。
    const allowed = ['media', 'microphone', 'audioCapture', 'speechRecognition', 'fullscreen', 'clipboard-sanitized-write']
    if (!allowed.includes(permission)) { callback(false); return }
    if (!isTrustedPermissionSource(wc)) {
      console.warn('[SECURITY] 拒绝不可信来源的媒体权限请求:', wc?.getURL?.() || '(unknown)')
      callback(false)
      return
    }
    callback(true)
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    // T1.9: 未知权限默认拒绝（白名单外 return false），仅放行已知权限
    const allowed = ['media', 'microphone', 'audioCapture', 'speechRecognition', 'fullscreen', 'clipboard-sanitized-write']
    if (!allowed.includes(permission)) return false
    return isTrustedPermissionSource(wc)
  })

  // P5 一体机：--kiosk / --fullscreen 启动参数 → 窗口模式
  const winMode = parseWindowMode(process.argv)

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'CrabPaw',
    icon: nativeImage.createFromPath(iconPath),
    backgroundColor: '#0a0a0a',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // S2 fix: 启用沙箱化 — 渲染进程不再拥有 Node.js 权限
      sandbox: true,
      // S1 fix: 启用同源策略 — 阻止 XSS 读取本地文件
      webSecurity: true,
      // S6 fix: 禁用 webview 标签 — 减少攻击面
      webviewTag: false,
      // S5 fix: 禁止加载不安全内容
      allowRunningInsecureContent: false,
    },
  })

  // T1.10: 主窗口导航白名单——渲染层发起的任何导航(链接点击/window.location 跳转)
  // 都必须在白名单内,否则阻止。程序化 loadURL/loadFile/reload 不受 will-navigate 影响。
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigationUrl(url)) {
      console.warn('[SECURITY] will-navigate 阻止非白名单导航:', url)
      e.preventDefault()
    }
  })

  if (winMode.kiosk || winMode.fullscreen) {
    applyWindowMode(mainWindow, winMode)
    // 一体机静默待机：屏幕不熄（规格 §9）
    blockerId = powerSaveBlocker.start('prevent-display-sleep')
    console.log(`[kiosk] 窗口模式 ${winMode.kiosk ? 'kiosk' : 'fullscreen'} 已启用, powerSaveBlocker=${blockerId}`)
  }

  // P5 fix: 窗口销毁（含 window:restart / 崩溃重建）时释放 powerSaveBlocker，防止重建窗口叠加 blocker 泄漏
  mainWindow.on('closed', () => {
    if (blockerId !== null) {
      powerSaveBlocker.stop(blockerId)
      console.log(`[kiosk] 窗口已关闭, powerSaveBlocker=${blockerId} 已释放`)
      blockerId = null
    }
  })

let rendererCrashCount = 0
const MAX_RENDERER_CRASH_RECOVERY = 10
let lastCrashTime = 0

function setupCrashRecovery(webContents: any) {
  // 2026-08-01: 渲染进程 console 转发（诊断）——React hooks 错误等组件栈可在此捕获
  webContents.on('console-message', (_event: any, level: number, message: string, line: number, sourceId: string) => {
    // [DIAG-2026-08-08] 临时:放开过滤转发全部渲染层日志(抓 TTS paused 根因),排障后恢复 level>=2 || /hooks|ErrorBoundary|error/
    if (level >= 1 || /hooks|ErrorBoundary|error/i.test(message)) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    }
  })
  const onCrashed = (reason: string, killed: boolean) => {
    const now = Date.now()
    if (now - lastCrashTime > 60000) {
      rendererCrashCount = 0
    }
    lastCrashTime = now
    rendererCrashCount++
    
    console.error(`[RENDERER] 渲染进程崩溃 (${reason})${killed ? '（被终止）' : ''}，尝试自动恢复... (${rendererCrashCount}/${MAX_RENDERER_CRASH_RECOVERY})`)
    
    // 记录崩溃详情到 crash.log
    try {
      const crashLogPath = path.join(DATA_DIR, 'renderer-crash.log')
      const ts = new Date().toISOString()
      fs.appendFileSync(crashLogPath, `[${ts}] RENDERER CRASH: reason=${reason} killed=${killed} count=${rendererCrashCount}\n`)
    } catch (err: any) { console.error('[main] 崩溃日志写入失败:', err?.message || err) }
    
    if (rendererCrashCount > MAX_RENDERER_CRASH_RECOVERY) {
      console.error('[RENDERER] 超过最大崩溃恢复次数，停止自动恢复')
      return
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      // 延迟更长（3秒），让渲染进程完全退出
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[RENDERER] 正在重新加载页面以恢复...')
          try {
            mainWindow.reload()
          } catch (e) {
            console.error('[RENDERER] reload 失败:', e)
            // 如果 reload 失败，尝试重新创建窗口
            try { mainWindow.destroy() } catch (err) { console.warn('[main] 窗口销毁失败:', err instanceof Error ? err.message : String(err)) }
            mainWindow = null
            createWindow()
          }
        }
      }, 3000)
    }
  }

  // T1.17: 只保留 render-process-gone——'crashed' 与 'render-process-gone' 在同一
  // 崩溃事件中都会触发,双监听会导致崩溃计数翻倍、自动恢复逻辑重复执行。
  webContents.on('render-process-gone', (_event: any, details: any) => {
    onCrashed(details?.reason || 'render-process-gone', details?.exitCode === 0)
  })

  webContents.on('unresponsive', () => {
    console.warn('[RENDERER] 渲染进程无响应')
  })

  webContents.on('responsive', () => {
    if (rendererCrashCount > 0) {
      console.log('[RENDERER] 渲染进程恢复响应')
    }
  })

  webContents.on('did-finish-load', () => {
    // 2026-08-08(审计 P1): 仅当页面已稳定存活(距上次崩溃 >30s)才清零——
    // 旧实现崩溃→reload→did-finish-load 无条件清零,每 3s 一次的崩溃循环
    // (OOM/原生崩溃)上限 MAX_RENDERER_CRASH_RECOVERY 形同虚设
    if (rendererCrashCount > 0 && Date.now() - lastCrashTime > 30000) {
      console.log('[RENDERER] 页面加载完成(已稳定存活),崩溃计数重置')
      rendererCrashCount = 0
    }
  })
}

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    setupCrashRecovery(mainWindow.webContents)
    // E2E 测试模式下不自动打开 DevTools（避免 Playwright 连接到 DevTools 窗口）
    if (!process.env.CRABPAW_E2E) {
      mainWindow?.webContents.openDevTools()
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
    setupCrashRecovery(mainWindow.webContents)
    // Production: log renderer errors to main process console
    // T1.18: 生产环境不自动打开 DevTools——仅 CRABPAW_E2E / CRABPAW_DEBUG 调试环境开;
    // 其余场景 console.error + 有限次重试加载。
    let prodLoadFailCount = 0
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[RENDERER] Page load failed: ${code} ${desc} (${url})`)
      if (code === -3) return // ABORTED: 主动取消(如重定向),不算失败
      if (process.env.CRABPAW_E2E || process.env.CRABPAW_DEBUG) {
        mainWindow?.webContents.openDevTools({ mode: 'detach' })
        return
      }
      prodLoadFailCount++
      if (prodLoadFailCount <= 3) {
        console.warn(`[RENDERER] ${3}s 后重试加载 (${prodLoadFailCount}/3)...`)
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.loadFile(path.join(__dirname, '../../dist/index.html'))
              .catch((e) => console.error('[RENDERER] 重试加载失败:', e instanceof Error ? e.message : String(e)))
          }
        }, 3000)
      } else {
        console.error('[RENDERER] 重试次数耗尽,请检查 dist/index.html 是否完整')
      }
    })
    mainWindow.webContents.on('did-finish-load', () => { prodLoadFailCount = 0 })
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.error(`[RENDERER] ${message}`) // warn and error levels
    })
  }

  // 2026-08-31 深度检查修复(P2): 渲染就绪握手 8s 兜底逐窗口挂载——此前挂在 whenReady
  // 的首窗 webContents.once 上, 重建窗口(window:restart/崩溃恢复)无兜底。
  // reload/HMR full-reload 会再次触发 did-finish-load, 每次重置计时; 握手到达即清掉。
  mainWindow.webContents.on('did-finish-load', () => {
    if (splashFallbackTimer) clearTimeout(splashFallbackTimer)
    splashFallbackTimer = setTimeout(() => { void runSplashStartSequence() }, 8000)
  })

  // T1.8: HTML 属性注入防御——转义 & < > " ' 五个字符
  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // Intercept webview popups → custom clean window (no menu bar, with URL bar)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      const { BrowserWindow } = require('electron')
      // 2026-08-14 审计 M4: 弹窗隔离加固——
      // ① 非持久化内存 partition(不带 persist: 前缀)会话,与主应用默认会话隔离,
      //    不共享 cookie/storage/localStorage;
      // ② iframe 加 sandbox(allow-scripts allow-forms,无 allow-same-origin/
      //    allow-popups/allow-top-navigation)——外部站点以 opaque origin 运行,
      //    不能弹窗、不能改写顶层导航;
      // ③ 弹窗自身 setWindowOpenHandler 一律 deny(拦截 iframe 内 window.open)。
      const win = new BrowserWindow({
        width: 1024, height: 700,
        autoHideMenuBar: true,
        title: url,
        skipTaskbar: true,
        show: false,
        // S6 fix: popup window also sandboxed, no webview tag, webSecurity enabled
        webPreferences: {
          sandbox: true, webSecurity: true, webviewTag: false, contextIsolation: true, nodeIntegration: false,
          partition: 'popup:' + Date.now(),
        },
      })
      win.webContents.setWindowOpenHandler(() => {
        console.warn('[popup] 弹窗内 window.open 已被拦截(隔离策略):', url)
        return { action: 'deny' }
      })
      win.once('ready-to-show', () => win.show())
      // Simple URL bar at top — use iframe instead of webview for security
      const safeUrl = escapeHtml(url)
      win.loadURL(`data:text/html,<html><body style="margin:0;font-family:system-ui">
        <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#1a1a1a;border-bottom:1px solid #333">
          <input id="u" value="${safeUrl}" onkeydown="if(event.key==='Enter')document.querySelector('#w').src=this.value"
            style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid #444;background:#2a2a2a;color:#fff;font-size:13px;outline:none">
        </div>
        <iframe id="w" src="${safeUrl}" sandbox="allow-scripts allow-forms" style="width:100%;height:calc(100vh - 44px);border:none"></iframe>
      </body></html>`)
    }
    return { action: 'deny' }
  })

  // ── 关闭窗口 → 缩到托盘 ───────────────────────────
  mainWindow.on('close', (event) => {
    // 2026-09-09 (U盘实测): 便携版点关闭=真正退出(stopServices 杀后端, U 盘可弹出)——
    // 缩托盘行为仅保留在开发版(常驻桌面助手场景)。此前打包版点 X 只隐藏到托盘,
    // 后端持续占用 U 盘 → 用户"已关闭应用仍无法弹出"(托盘图标又常被收进溢出区, 找不到)
    if (closeToTray && serviceReady && isDev) {
      event.preventDefault()
      mainWindow?.hide()
      // 不创建新托盘！托盘在 app.whenReady 时已创建。
      // Windows 上 destroy+recreate 会堆积多个托盘图标（幽灵图标 bug）。
      console.log('[TRAY] Window hidden to tray, server keeps running')
    } else {
      stopServices()
      // 2026-08-01: 退出时不显式 destroy 托盘——Windows 上 tray.destroy()
      // 不会立即从通知区域移除图标，进程退出瞬间残留成"幽灵图标"
      // （直到悬停或 Explorer 刷新）。Electron 退出时会随进程自动清理，
      // 残留由下次启动 createTray 的 refreshWindowsTrayIcons() 兜底清除。
      tray = null
    }
  })

  // Desktop app: CSP not needed, webSecurity handles security model
}

function checkPortInUse(): Promise<boolean> {
  return new Promise((resolve) => {
    // T1.16: 统一 127.0.0.1——localhost 可能解析到 ::1(IPv6)而后端只监听 127.0.0.1
    const req = http.get(`http://127.0.0.1:${API_PORT}/health`, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function getExistingServerToken(): Promise<string | null> {
  return new Promise((resolve) => {
    // T1.16(2026-08-08,审计 P1): challenge-response——带随机 challenge,
    // 应答者须回传 HMAC-SHA256(API_TOKEN, challenge)。防本机任意进程先绑定
    // 38767 伪造 /dev/token 应答者,让主进程写入攻击者 token 长期与其对话
    // (对话/记忆/上传数据 MITM)。校验失败返回 null → 调用方走 kill 端口自启。
    const challenge = Math.random().toString(36).slice(2) + Date.now().toString(36)
    console.log('[KEY] getExistingServerToken: requesting /dev/token (challenge)...')
    const req = http.request({
      hostname: '127.0.0.1',
      port: API_PORT,
      path: `/dev/token?challenge=${encodeURIComponent(challenge)}`,
      method: 'GET',
      headers: { 'x-electron': 'true', 'X-Api-Key': API_TOKEN }
    }, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const expected = crypto.createHmac('sha256', API_TOKEN).update(challenge).digest('hex')
          if (data?.challengeHmac !== expected) {
            // 2026-08-08 (冒烟修复): API_TOKEN 是模块加载时的陈旧值——外部后端(npm start)
            // 若在 token 文件缺失时启动会生成新 token 写入文件。challenge 失败直接 kill
            // 端口占用者会误杀外部后端(实测: 后端被杀 + vite-plugin-electron treeKillSync
            // 崩溃的双重事故)。用 TOKEN_PATH 文件最新值重试——文件与后端 key 同步,
            // 合法复用场景据此通过;proxy 层本就实时读文件,不会因旧常量 401。
            const fileToken = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim() : ''
            if (fileToken && fileToken !== API_TOKEN) {
              const expected2 = crypto.createHmac('sha256', fileToken).update(challenge).digest('hex')
              if (data?.challengeHmac === expected2) {
                console.log('[KEY] /dev/token 文件 token 校验通过(后端已更新 token),复用现有服务')
                resolve(data.token || null)
                return
              }
            }
            console.warn('[KEY] /dev/token challenge 校验失败——应答者不可信(端口劫持?),释放端口自启')
            resolve(null)
            return
          }
          // T1.15: token 不落日志——仅打印是否取到(掩码后 4 位)
          const tokenOk = typeof data?.token === 'string' && data.token.length > 0
          console.log('[KEY] /dev/token response:', tokenOk ? `token=${maskSecret(String(data.token))}` : JSON.stringify(data))
          resolve(data.token || null)
        } catch (e) {
          console.log('[KEY] /dev/token parse failed:', e instanceof Error ? e.message : String(e))
          resolve(null)
        }
      })
    })
    req.on('error', (e) => {
      console.log('[KEY] /dev/token request failed:', e.message)
      resolve(null)
    })
    req.setTimeout(2000, () => {
      console.log('[KEY] /dev/token request timeout')
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

// 2026-09-08 便携发行加固: 端口被占时只允许清理 CrabPaw 自家进程(僵尸后端/桥接/开发脚本),
// 第三方程序一律不杀——此前无差别 taskkill /F /T 会强杀目标机上恰好占用 38767 的任何程序
const CRABPAW_PROC_SIGNATURE = /crabpaw|src[\\/]cli[\\/]index\.js|clean-start\.js/i

/** 批量获取进程命令行(win32: PowerShell CIM 一次查询); 失败返回空 Map(视为未知, 宁可不杀) */
function listWin32Cmdlines(pids: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const map = new Map<string, string>()
    const filter = pids.map(p => `ProcessId=${p}`).join(' OR ')
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`
    ], { shell: false, windowsHide: true })
    let out = ''
    ps.stdout?.on('data', (d) => { out += d.toString() })
    ps.on('error', () => resolve(map))
    ps.on('close', (code) => {
      if (code !== 0 || !out.trim()) { resolve(map); return }
      try {
        const parsed = JSON.parse(out)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        for (const it of items) {
          if (it && it.ProcessId != null) map.set(String(it.ProcessId), String(it.CommandLine || ''))
        }
      } catch (e) { console.warn('[PORT] 进程命令行解析失败:', e instanceof Error ? e.message : String(e)) }
      resolve(map)
    })
  })
}

function killProcessOnPort(): Promise<{ killed: boolean; foreign: string[] }> {
  return new Promise((resolve) => {
    const port = String(API_PORT)
    if (!/^\d+$/.test(port)) {
      console.error('Invalid port:', port)
      resolve({ killed: false, foreign: [] })
      return
    }

    if (process.platform === 'win32') {
      const netstat = spawn('netstat', ['-ano'], { shell: false, windowsHide: true })
      let output = ''
      netstat.stdout.on('data', (data) => { output += data.toString() })
      netstat.on('close', async () => {
        const lines = output.split('\n').filter(l => l.includes(`:${port}`))
        const pids = new Set<string>()
        for (const line of lines) {
          const parts = line.trim().split(/\s+/)
          const pid = parts[parts.length - 1]
          if (pid && /^\d+$/.test(pid)) {
            pids.add(pid)
          }
        }
        if (pids.size === 0) {
          resolve({ killed: false, foreign: [] })
          return
        }
        // 只杀命令行命中 CrabPaw 特征的进程; 未知/第三方进程全部保留并回报
        const cmdlines = await listWin32Cmdlines([...pids])
        const foreign: string[] = []
        let killed = 0
        for (const pid of pids) {
          const cmdline = cmdlines.get(pid) || ''
          if (cmdline && CRABPAW_PROC_SIGNATURE.test(cmdline)) {
            try {
              // Use taskkill /T /F to kill entire process tree
              spawn('taskkill', ['/F', '/T', '/PID', pid], { shell: false, windowsHide: true })
              killed++
            } catch (err) { console.warn('[PORT] taskkill 启动失败:', err instanceof Error ? err.message : String(err)) }
          } else {
            foreign.push(cmdline || `PID ${pid} (命令行未知)`)
          }
        }
        if (foreign.length) {
          console.warn('[PORT] 端口被非 CrabPaw 进程占用, 不予清理:', foreign.join(' | '))
        }
        // Give process time to exit
        setTimeout(() => resolve({ killed: killed > 0, foreign }), 1000)
      })
    } else {
      const lsof = spawn('lsof', ['-ti', port], { shell: false, windowsHide: true })
      let pidOutput = ''
      lsof.stdout.on('data', (data) => { pidOutput += data.toString() })
      lsof.on('close', () => {
        const pids = pidOutput.trim().split('\n').filter(p => /^\d+$/.test(p))
        if (pids.length === 0) {
          resolve({ killed: false, foreign: [] })
          return
        }
        const query = spawn('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { windowsHide: true })
        let psOutput = ''
        query.stdout?.on('data', (d) => { psOutput += d.toString() })
        query.on('error', () => resolve({ killed: false, foreign: pids.map(p => `PID ${p} (命令行未知)`) }))
        query.on('close', () => {
          const foreign: string[] = []
          let killed = 0
          for (const line of psOutput.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(.*)$/)
            if (!m) continue
            const [, pid, cmdline] = m
            if (CRABPAW_PROC_SIGNATURE.test(cmdline)) {
              const kill = spawn('kill', ['-9', pid], { shell: false, windowsHide: true })
              kill.on('close', () => {})
              killed++
            } else {
              foreign.push(cmdline || `PID ${pid} (命令行未知)`)
            }
          }
          if (foreign.length) {
            console.warn('[PORT] 端口被非 CrabPaw 进程占用, 不予清理:', foreign.join(' | '))
          }
          setTimeout(() => resolve({ killed: killed > 0, foreign }), 500)
        })
      })
    }
  })
}

// ── Splash 进度推送 ──────────────────────────────────────────
// 2026-08-31 深度检查修复: 记录已推送的进度历史——渲染层重载(崩溃恢复/window:restart/
// HMR full-reload)后新页面重新握手时按历史重放, 不再等 15s 渲染层兜底超时。
const splashProgressHistory: { step: string; status: string; message?: string }[] = []
function sendSplashProgress(event: { step: string; status: string; message?: string }) {
  const last = splashProgressHistory[splashProgressHistory.length - 1]
  if (!last || last.step !== event.step || last.status !== event.status || last.message !== event.message) {
    splashProgressHistory.push(event)
    if (splashProgressHistory.length > 40) splashProgressHistory.shift()
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('splash:progress', event)
    } catch (err) {
      // 窗口可能正在关闭
      console.warn('[splash] 进度推送失败(窗口可能已关闭):', err instanceof Error ? err.message : String(err))
    }
  }
}

// 按历史重放进度给当前窗口(直接 send, 不经 sendSplashProgress 避免重复记录)
function replaySplashProgressToCurrentWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  for (const ev of splashProgressHistory) {
    try {
      mainWindow.webContents.send('splash:progress', ev)
    } catch (err) {
      console.warn('[splash] 进度重放失败(窗口可能已关闭):', err instanceof Error ? err.message : String(err))
      return
    }
  }
}

let splashFallbackTimer: ReturnType<typeof setTimeout> | null = null
let splashSequenceStarted = false

// 2026-08-31 深度检查修复(P2): 启动序列可重复触发——首启窗口走完整序列;
// 重载窗口(崩溃恢复/window:restart/HMR full-reload)再握手时序列已启动过,
// 直接按历史重放, 让重载后的闪屏立即完成而非挂 15s。序列 no-op(如首启向导期)
// 但服务随后经 service:start 就绪的场景, 重放时按 serviceReady 补发 done。
async function runSplashStartSequence() {
  if (splashSequenceStarted) {
    if (splashProgressHistory.length > 0) {
      replaySplashProgressToCurrentWindow()
    } else if (serviceReady) {
      sendSplashProgress({ step: 'done', status: 'ready' })
    }
    return
  }
  splashSequenceStarted = true
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      if (config.setupCompleted === true) {
        console.log('[OK] Config ready, auto-starting service...')

        // Step 1: Backend server
        sendSplashProgress({ step: 'backend', status: 'starting', message: '启动核心引擎' })
        await startCrabPawServer()
        sendSplashProgress({ step: 'backend', status: 'ready', message: '核心引擎就绪' })

        // Step 2: Message channel bridges
        const chatChannelRaw = config.chatChannel || 'none'
        const channels = new Set(Array.isArray(chatChannelRaw) ? chatChannelRaw : [chatChannelRaw])
        if (getCredMgr().isWecomConfigured()) channels.add('wecom')
        if (getCredMgr().isLarkConfigured()) channels.add('lark')

        if (channels.has('lark')) {
          sendSplashProgress({ step: 'lark-bridge', status: 'starting', message: '连接飞书通道' })
          await startLarkBridge()
          sendSplashProgress({ step: 'lark-bridge', status: 'ready', message: '飞书通道就绪' })
        } else {
          sendSplashProgress({ step: 'lark-bridge', status: 'skipped' })
        }

        if (channels.has('wecom')) {
          sendSplashProgress({ step: 'wecom-bridge', status: 'starting', message: '连接企业微信' })
          await startWecomBridge()
          sendSplashProgress({ step: 'wecom-bridge', status: 'ready', message: '企业微信就绪' })
        } else {
          sendSplashProgress({ step: 'wecom-bridge', status: 'skipped' })
        }

        // Step 3: SSE connect (handled by renderer's startSceneClient)
        sendSplashProgress({ step: 'sse-connect', status: 'ready', message: '实时连接就绪' })

        // Step 3.5: Voice engine check (P5.5) — 凭证在则 ready，无凭证 skipped（不阻塞启动）
        const voiceCfg = config.voice || {}
        // 2026-08-31 深度检查修复: 与后端真实凭据口径对齐——ASR 支持
        // volcAsrAppKey+volcAsrAccessKey 对(src/core/asr/cloud-asr.js),
        // doubao TTS 要求 volcanoAppId+volcanoToken 成对(src/core/tts/index.js)
        const hasAsrCreds = !!(voiceCfg.volcAsrApiKey || (voiceCfg.volcAsrAppKey && voiceCfg.volcAsrAccessKey))
        const hasTtsCreds = !!(voiceCfg.doubaoKey || (voiceCfg.volcanoAppId && voiceCfg.volcanoToken))
        const hasVoiceCreds = hasAsrCreds || hasTtsCreds
        if (hasVoiceCreds) {
          sendSplashProgress({ step: 'voice', status: 'starting', message: '启动语音引擎' })
          // 语音引擎为渲染层常驻（KWS/ASR 随 VoiceShell 挂载），此处仅标记检查通过
          sendSplashProgress({ step: 'voice', status: 'ready', message: '语音引擎就绪' })
        } else {
          sendSplashProgress({ step: 'voice', status: 'skipped' })
        }

        // Done
        sendSplashProgress({ step: 'done', status: 'ready' })
      }
    }
  } catch (e) {
    console.error('Auto-start service failed:', e)
    sendSplashProgress({ step: 'backend', status: 'error', message: '服务启动失败' })
  }
}

function startCrabPawServer(): Promise<void> {
  return new Promise(async (resolve, reject) => {
    // 2026-08-08(审计 P1): 停止后再启动时复位主动停止标志,恢复崩溃自动重启能力
    isStoppingServices = false
    // Startup lock: prevent concurrent calls
    if (isStartingServer) {
      console.log('[>>] startCrabPawServer: start already in progress, waiting...')
      // E3: Replace spin-wait with setInterval-based polling
      const SERVER_STARTUP_TIMEOUT = 60000
      const waitStart = Date.now()
      await new Promise<void>((waitResolve, waitReject) => {
        const interval = setInterval(() => {
          if (!isStartingServer) {
            clearInterval(interval)
            waitResolve()
          } else if (Date.now() - waitStart >= SERVER_STARTUP_TIMEOUT) {
            clearInterval(interval)
            waitReject(new Error('Service startup timed out: another startup flow did not complete'))
          }
        }, 500)
        if (interval.unref) interval.unref()
      }).catch(reject)
      // If waiting was rejected, propagate the error
      if (isStartingServer) return
      // Existing startup completed, check if service is ready
      if (serviceReady) {
        resolve()
        return
      }
      // Service not ready, continue startup
    }
    
    isStartingServer = true
    
    console.log('[>>] startCrabPawServer called')
    console.log('[>>] BACKEND_CWD:', BACKEND_CWD)
    console.log('[>>] NODE_EXE:', NODE_EXE)
    console.log('[>>] DATA_DIR:', DATA_DIR)
    console.log('[>>] LOG_PATH:', LOG_PATH)
    
    // If service is already ready, return immediately
    if (serviceReady) {
      console.log('[OK] Service ready, skip start')
      isStartingServer = false
      resolve()
      return
    }
    
    let portInUse = await checkPortInUse()
    console.log('[>>] Port in use:', portInUse)

    // dev 模式（vite 开发）：后端由外部 `npm run dev` 管理，Electron 永不自起后端——
    // 否则双后端抢端口/锁 → 崩溃重启循环（实测：watch 重启窗口 30-90s 内探测失败
    // → Electron 误判空闲自起 → 双开互抢）。等待外部后端（最多 60s），
    // 仍无则明确报错提示，绝不 spawn。
    if (isDev && !portInUse) {
      for (let retry = 0; retry < 40; retry++) {
        await new Promise((r) => setTimeout(r, 1500))
        portInUse = await checkPortInUse()
        if (portInUse) {
          console.log(`[>>] External backend available after retry ${retry + 1}, reusing`)
          break
        }
      }
      console.log('[>>] Final port in use:', portInUse)
      if (!portInUse) {
        console.error(`[ERR] dev 模式未检测到外部后端 (127.0.0.1:${API_PORT})——请先运行 npm run dev`)
        isStartingServer = false
        reject(new Error('Backend not running in dev mode'))
        return
      }
    }

    // 非 dev（打包版）：竞态兜底——探测失败先等待重试（最多 8×1.5s），
    // 确认外部服务确实不存在后才自己 spawn。
    if (!portInUse) {
      for (let retry = 0; retry < 8; retry++) {
        await new Promise((r) => setTimeout(r, 1500))
        portInUse = await checkPortInUse()
        if (portInUse) {
          console.log(`[>>] External service available after retry ${retry + 1}, reusing`)
          break
        }
      }
    }
    console.log('[>>] Final port in use:', portInUse)

    if (portInUse) {
      const existingToken = await getExistingServerToken()
      if (existingToken) {
        console.log('[OK] Detected running CrabPaw service, reusing')
        fs.writeFileSync(TOKEN_PATH, existingToken, 'utf-8')
        fs.writeFileSync(PORT_PATH, API_PORT.toString(), 'utf-8')
        serviceReady = true
        serverStartedByUs = false
        isStartingServer = false
        resolve()
        return
      }
      
      console.log('[WARN] Port occupied, trying to release...')
      const killResult = await killProcessOnPort()
      if (!killResult.killed) {
        isStartingServer = false
        const win = mainWindow
        if (!win) {
          reject(new Error('Port is occupied and no window to prompt'))
          return
        }
        const occupiedBy = killResult.foreign.length
          ? `\n\n占用进程: ${killResult.foreign[0].slice(0, 200)}`
          : ''
        const result = dialog.showMessageBoxSync(win, {
          type: 'error',
          title: 'Port Conflict',
          message: `Port ${API_PORT} is in use by another program`,
          detail: `Please close the program using this port and retry.${occupiedBy}`,
          buttons: ['Exit', 'Retry']
        })
        if (result === 0) {
          app.quit()
          reject(new Error('Port is occupied'))
          return
        } else {
          await new Promise(r => setTimeout(r, 2000))
          isStartingServer = false
          return startCrabPawServer().then(resolve).catch(reject)
        }
      }
      // Wait for port to fully release, with retry check
      console.log('[WAIT] Waiting for port release...')
      let portFreed = false
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const stillInUse = await checkPortInUse()
        if (!stillInUse) {
          portFreed = true
          break
        }
        console.log(`[WAIT] Port still releasing... (${i + 1}/5)`)
      }
      if (!portFreed) {
        console.log('[WARN] Port release timeout, continuing...')
      }
    }
    
    saveApiCredentials()
    ensureDataDir()
    
    // Verify critical paths before startup
    console.log('[>>] Spawning server process...')
    console.log('[>>] Command:', NODE_EXE, 'src/cli/index.js start')
    console.log('[>>] CWD:', BACKEND_CWD)
    
    if (!isDev) {
      if (!fs.existsSync(NODE_EXE)) {
        const msg = `node.exe not found: ${NODE_EXE}`
        console.error('[ERR]', msg)
        isStartingServer = false
        reject(new Error(msg))
        return
      }
      const entryFile = path.join(BACKEND_CWD, 'src', 'cli', 'index.js')
      if (!fs.existsSync(entryFile)) {
        const msg = `Entry file not found: ${entryFile}`
        console.error('[ERR]', msg)
        isStartingServer = false
        reject(new Error(msg))
        return
      }
      // Verify data directory is writable
      try {
        const testFile = path.join(DATA_DIR, '.write-test')
        fs.writeFileSync(testFile, 'test', 'utf-8')
        fs.unlinkSync(testFile)
      } catch (e) {
        // S2-NSIS: 安装到 Program Files 等无写权限目录时,自动回退到 userData,而不是拒绝启动
        const fallbackDir = getUserDataFallbackDir()
        try {
          fs.mkdirSync(fallbackDir, { recursive: true })
          const testFile = path.join(fallbackDir, '.write-test')
          fs.writeFileSync(testFile, 'test', 'utf-8')
          fs.unlinkSync(testFile)
        } catch (e2) {
          const msg = `Data directory not writable: ${DATA_DIR} (${e instanceof Error ? e.message : String(e)}); userData fallback also not writable: ${fallbackDir} (${e2 instanceof Error ? e2.message : String(e2)})`
          console.error('[ERR]', msg)
          isStartingServer = false
          reject(new Error(msg))
          return
        }
        console.warn(`[WARN] 数据目录不可写(${DATA_DIR}),已切换到 userData: ${fallbackDir}`)
        DATA_DIR = fallbackDir
        CONFIG_PATH = path.join(DATA_DIR, 'config.json')
        TOKEN_PATH = path.join(DATA_DIR, '.api_token')
        PORT_PATH = path.join(DATA_DIR, '.api_port')
        LOG_PATH = path.join(DATA_DIR, 'crabpaw.log')
        // 凭据/配置重新落盘到新目录(server 通过 env CRABPAW_DATA_DIR 使用回退后的目录)
        saveApiCredentials()
        ensureDataDir()
      }
      console.log('[OK] Critical path validation passed')
    }
    
    const logMgr = getLogManager()
    
    crabpawServer = spawn(NODE_EXE, ['src/cli/index.js', 'start'], {
      cwd: BACKEND_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        ADMIN_API_KEY: API_TOKEN,
        API_PORT: API_PORT.toString(),
        CRABPAW_DATA_DIR: DATA_DIR,
        // 2026-09-08 便携化收敛: path-utils 一族(默认 ~/.crabpaw: workflows/hooks/profiles/
        // browser-data/secrets 等)与 exec-approval/commitment(CONFIG_DIR) 全部落到数据目录,
        // 数据随盘走, 不再散落目标机用户主目录
        CRABPAW_HOME: DATA_DIR,
        CONFIG_DIR: DATA_DIR,
        CRABPAW_ELECTRON: 'true',
        // 2026-08-27 D4: 桌面端插件装配 profile——后端按 profiles.desktop 缩编清单(未配置=全量, 现状不变)
        CRABPAW_PROFILE: 'desktop',
        NODE_ENV: isDev ? 'development' : 'production'
      }
    })
    
    console.log('[>>] Server process spawned, PID:', crabpawServer.pid)
    
    // Pipe stdout/stderr through RotatingLogManager
    if (crabpawServer.stdout) logMgr.writeFromStream(crabpawServer.stdout)
    if (crabpawServer.stderr) logMgr.writeFromStream(crabpawServer.stderr)
    
    crabpawServer.on('error', (err) => {
      console.error('CrabPaw server spawn error:', err)
      serviceReady = false
      isStartingServer = false
      reject(new Error(`Server process start failed: ${err.message}。Please verify ${NODE_EXE} exists and is executable`))
    })
    
    // Detected fast exit (usually module load failure)
    const spawnTime = Date.now()
    crabpawServer.on('exit', (code) => {
      const uptime = Date.now() - spawnTime
      console.log(`CrabPaw server exited, code: ${code}, uptime: ${uptime}ms`)
      serviceReady = false
      crabpawServer = null
      
      // Normal exit (code=0 or null) does not need restart
      if (code === 0 || code === null) {
        isStartingServer = false
        return
      }
      
      // Fast exit (<3s) usually means module load failure, reject immediately
      if (uptime < 3000 && isStartingServer) {
        let logTail = ''
        const latestLog = getDatedLogPath()
        const logToRead = fs.existsSync(latestLog) ? latestLog : (fs.existsSync(LOG_PATH) ? LOG_PATH : null)
        try {
          if (logToRead) {
            const logContent = fs.readFileSync(logToRead, 'utf-8')
            const lines = logContent.split('\n').filter(l => l.trim()).slice(-15)
            logTail = lines.join('\n')
          }
        } catch (err) { console.warn('[main] 读取崩溃日志尾部失败:', err instanceof Error ? err.message : String(err)) }
        const detail = logTail ? `\n\nRecent logs:\n${logTail}` : ''
        isStartingServer = false
        reject(new Error(`Service exited quickly (code=${code}, ran${uptime}ms)${detail}\n\nLog path: ${logToRead || LOG_PATH}`))
        return
      }
      
      // Attempt restart on abnormal exit
      // 2026-08-08(审计 P1): 主动停止(isStoppingServices)不触发自动重启
      if (serverStartedByUs && !appIsQuitting && !isRestarting && !isStoppingServices) {
        restartAttempts++
        if (restartAttempts <= MAX_RESTART_ATTEMPTS) {
          console.log(`[RETRY] Service crashed, auto-restart in 5s... (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`)
          isStartingServer = false
          setTimeout(async () => {
            try {
              await startCrabPawServer()
              console.log('[OK] Service auto-restart succeeded')
              restartAttempts = 0
            } catch (e) {
              console.error('[ERR] Service auto-restart failed:', e)
            }
          }, 5000)
        } else {
          console.error('[ERR] Max restart attempts reached, stopping auto-restart')
          isStartingServer = false
          if (mainWindow && !mainWindow.isDestroyed()) {
            dialog.showMessageBox(mainWindow, {
              type: 'error',
              title: 'Service abnormal',
              message: 'Service failed to start multiple times, please check log file',
              detail: `Log path: ${LOG_PATH}`,
              buttons: ['OK']
            }).catch((err) => console.error('[main] 错误对话框展示失败:', err instanceof Error ? err.message : String(err)))
          } else {
            console.error('[ERR] 无可用窗口展示错误对话框,详情见日志:', LOG_PATH)
          }
        }
      } else {
        isStartingServer = false
      }
    })
    
    const checkReady = (attempts = 0) => {
      if (attempts >= 30) {
        isStartingServer = false
        // Read last few log lines to help diagnose
        let logTail = ''
        const latestLog = getDatedLogPath()
        const logToRead = fs.existsSync(latestLog) ? latestLog : (fs.existsSync(LOG_PATH) ? LOG_PATH : null)
        try {
          if (logToRead) {
            const logContent = fs.readFileSync(logToRead, 'utf-8')
            const lines = logContent.split('\n').filter(l => l.trim()).slice(-10)
            logTail = lines.join('\n')
          }
        } catch (err) { console.warn('[main] 读取启动日志尾部失败:', err instanceof Error ? err.message : String(err)) }
        const detail = logTail ? `\n\nRecent logs:\n${logTail}` : ''
        reject(new Error('Service startup timed out' + detail + `\n\nLog path: ${logToRead || LOG_PATH}`))
        return
      }
      
      const req = http.get(`http://127.0.0.1:${API_PORT}/health`, (res) => {
        if (res.statusCode === 200) {
          serviceReady = true
          serverStartedByUs = true
          restartAttempts = 0  // Reset restart counter on successful startup
          isStartingServer = false
          resolve()
        } else {
          setTimeout(() => checkReady(attempts + 1), 1000)
        }
      })
      req.on('error', () => {
        setTimeout(() => checkReady(attempts + 1), 1000)
      })
      req.setTimeout(2000, () => {
        req.destroy()
        setTimeout(() => checkReady(attempts + 1), 1000)
      })
    }
    
    setTimeout(() => checkReady(), 1000)
  })
}

function startLarkBridge(): Promise<void> {
  return new Promise((resolve) => {
    const bridgePath = path.join(BACKEND_CWD, 'src/channels/lark/event-bridge.js')

    if (!fs.existsSync(bridgePath)) {
      console.warn('Lark Bridge path not found, skipping')
      resolve()
      return
    }

    // 凭证检查（与企业微信对齐）
    const { getCredentialManager } = require(path.join(BACKEND_CWD, 'src/core/credential-manager'))
    const credMgr = getCredentialManager(DATA_DIR)
    const larkCreds = credMgr.getLarkCredentials()

    if (!larkCreds.appId || !larkCreds.appSecret) {
      console.log('[Lark] Missing App ID or Secret, bridge cannot start — configure in Settings → 飞书')
      resolve()
      return
    }

    const logMgr = getLogManager()

    larkBridge = spawn(NODE_EXE, [bridgePath], {
      cwd: BACKEND_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        API_PORT: API_PORT.toString(),
        CRABPAW_DATA_DIR: DATA_DIR,
        CRABPAW_HOME: DATA_DIR,
        CONFIG_DIR: DATA_DIR,
        LARK_APP_ID: larkCreds.appId || '',
        LARK_APP_SECRET: larkCreds.appSecret || ''
      }
    })
    
    larkBridge.on('error', (err) => {
      console.error('Lark bridge error:', err)
    })
    
    // Pipe Lark bridge output through RotatingLogManager
    if (larkBridge.stdout) logMgr.writeFromStream(larkBridge.stdout)
    if (larkBridge.stderr) logMgr.writeFromStream(larkBridge.stderr)
    
    larkBridge.on('exit', (code) => {
      console.log('Lark bridge exited:', code, '- auto-restart in 5s')
      larkBridge = null
      if (serviceReady && !appIsQuitting) {
        setTimeout(() => startLarkBridge(), 5000)
      }
    })
    
    resolve()
  })
}

function startWecomBridge(): Promise<void> {
  return new Promise((resolve) => {
    const bridgePath = path.join(BACKEND_CWD, 'src/channels/wecom/event-bridge.js')
    
    if (!fs.existsSync(bridgePath)) {
      console.warn('WeCom Bridge path not found, skipping')
      resolve()
      return
    }

    // Use CredentialManager to get credentials centrally
    const { getCredentialManager } = require(path.join(BACKEND_CWD, 'src/core/credential-manager'))
    const credMgr = getCredentialManager(DATA_DIR)
    const wecomCreds = credMgr.getWecomCredentials()
    // Only warn if channel is not 'wecom' — caller (service:start) already verified credentials
    // and may have decided to start the bridge regardless.

    if (!wecomCreds.botId || !wecomCreds.secret) {
      console.log('[WeCom] Missing botId or secret, bridge cannot start — configure in Settings → 企业微信')
      resolve()
      return
    }
    // corpId 占位符/缺失时同样不启动——否则桥接进程认证失败即退出，
    // 触发每 5 秒无限重启循环（crash-loop 刷日志 + 空转进程）
    if (!wecomCreds.corpId || wecomCreds.corpId === 'xxxxxxxx' || wecomCreds.corpId.length < 3) {
      console.log('[WeCom] corpId 未配置或为占位符，桥接不启动 — 请在 Settings → 企业微信 填写真实 corpId')
      resolve()
      return
    }

    const logMgr = getLogManager()
    
    wecomBridge = spawn(NODE_EXE, [bridgePath], {
      cwd: BACKEND_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        API_PORT: API_PORT.toString(),
        CRABPAW_DATA_DIR: DATA_DIR,
        CRABPAW_HOME: DATA_DIR,
        CONFIG_DIR: DATA_DIR,
        WECOM_SEND_PORT: '38769',
        WECOM_BOT_ID: wecomCreds.botId || '',
        WECOM_SECRET: wecomCreds.secret || ''
      }
    })
    
    wecomBridge.on('error', (err) => {
      console.error('WeCom bridge error:', err)
    })
    
    // Pipe WeCom bridge output through RotatingLogManager
    if (wecomBridge.stdout) logMgr.writeFromStream(wecomBridge.stdout)
    if (wecomBridge.stderr) logMgr.writeFromStream(wecomBridge.stderr)
    
    wecomBridge.on('exit', (code) => {
      console.log('WeCom bridge exited:', code, '- auto-restart in 5s')
      wecomBridge = null
      // Update status file on Bridge exit to prevent frontend false-positive
      try {
        const wecomStatusPath = path.join(DATA_DIR, 'wecom-status.json')
        fs.writeFileSync(wecomStatusPath, JSON.stringify({ connected: false, timestamp: Date.now() }))
        console.log('[WeCom] Bridge exited, updated wecom-status.json to disconnected')
      } catch (err) { console.warn('[WeCom] 状态文件写入失败:', err instanceof Error ? err.message : String(err)) }
      if (serviceReady && !appIsQuitting) {
        setTimeout(() => startWecomBridge(), 5000)
      }
    })
    
    resolve()
  })
}

function stopServices() {
  // 2026-08-08(审计 P1): 主动停止 → exit handler 短路自动重启
  isStoppingServices = true
  stopLogRotation()
  if (!serverStartedByUs) {
    console.log('Service not started by this process, skip stop')
    return
  }

  // Mark as exiting to prevent exit event from triggering restart
  serviceReady = false
  isStartingServer = false

  const serverProc = crabpawServer
  const larkProc = larkBridge
  const wecomProc = wecomBridge
  const pids = [serverProc?.pid, larkProc?.pid, wecomProc?.pid]
    .filter((p): p is number => typeof p === 'number')

  const cleanupTokenPortFiles = () => {
    try {
      if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH)
      if (fs.existsSync(PORT_PATH)) fs.unlinkSync(PORT_PATH)
    } catch (err) { console.warn('[main] token/port 文件清理失败:', err instanceof Error ? err.message : String(err)) }
  }

  // 1) 优雅停机:POST /shutdown → 服务端排空进行中会话后自行退出(见 handleShutdown)
  try {
    const token = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim() : API_TOKEN
    const req = http.request({
      hostname: '127.0.0.1',
      port: API_PORT,
      path: '/shutdown',
      method: 'POST',
      timeout: 3000,
      headers: {
        'X-Api-Key': token,
        'X-Electron': 'true'
      }
    }, () => {})
    req.on('error', (err) => { console.warn('[main] 优雅停机请求失败:', err instanceof Error ? err.message : String(err)) })
    req.end()
  } catch (err) { console.warn('[main] 优雅停机请求构造失败:', err instanceof Error ? err.message : String(err)) }

  // 2) 双重信号(移植 LiveKit Drain 模式):等待优雅退出,5s 超时才强制清理
  const forceKill = () => {
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        } else {
          process.kill(pid, 0)
          process.kill(pid, 'SIGKILL')
        }
      } catch (err) { console.warn('[main] 服务进程强杀失败:', err instanceof Error ? err.message : String(err)) }
    }
    cleanupTokenPortFiles()
  }

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      // ESRCH = 进程已退出,轮询正常收敛路径,非错误
      return false
    }
  }

  const deadline = Date.now() + 5000
  const poll = () => {
    if (!pids.some(isAlive)) { cleanupTokenPortFiles(); return }
    if (Date.now() >= deadline) { forceKill(); return }
    setTimeout(poll, 250)
  }
  poll()
}

function readJsonFile(filePath: string): any {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
    return null
  } catch (err) {
    console.warn('[readJsonFile] 解析失败:', filePath, err instanceof Error ? err.message : String(err))
    return null
  }
}

function writeJsonFile(filePath: string, data: any): { success: boolean; error?: string } {
  try {
    ensureDataDir()
    // 2026-09-09 (U盘实测): 掩码 key(sk-a****xxxx)曾被写回 config.json——真 key 从未
    // 落盘, 运行时拿掩码串当密钥 → 认证必失败。主进程的读改写路径(唤醒词/更新检查)
    // 一并防护: 永不持久化含 '****' 的假密钥
    if (filePath === CONFIG_PATH && data?.models?.providers) {
      for (const p of Object.values(data.models.providers) as any[]) {
        if (p && typeof p.apiKey === 'string' && p.apiKey.includes('****')) delete p.apiKey
      }
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// P5 一体机：开机自启（electron 原生 setLoginItemSettings = HKCU Run 键，等价任务计划程序自启，无 exec 注入面）
// P5.5: 启动音乐路径检测（用户自备 data/boot-music.mp3 → file:// 路径；无 → null，渲染层走合成氛围）
ipcMain.handle('app:boot-music:path', () => {
  const candidates = [
    path.join(app.getAppPath(), 'data', 'boot-music.mp3'),
    path.join(process.resourcesPath || '', 'data', 'boot-music.mp3'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return `file://${p.replace(/\\/g, '/')}`
    } catch (e) {
      console.error('[boot-music] 检查失败:', e)
    }
  }
  return null
})

ipcMain.handle('app:autostart:get', async () => {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch (e: any) {
    console.error('[autostart] get 失败:', e?.message || e)
    return false
  }
})
ipcMain.handle('app:autostart:set', async (_event, enabled: boolean) => {
  try {
    // 2026-08-07: 移除 args: ['--kiosk']——普通用户开自启不应强制一体机模式,
    // kiosk 模式只应通过用户显式命令行参数触发。
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
    })
    return app.getLoginItemSettings().openAtLogin
  } catch (e: any) {
    console.error('[autostart] set 失败:', e?.message || e)
    return app.getLoginItemSettings().openAtLogin
  }
})

// S2.2(2026-09-02): OS 系统通知——提醒到点主进程弹横幅, 点击聚焦主窗口
// 2026-09-07: 窗口聚焦且可见时跳过—— proactive_speak 已并行投递应用内卡片+TTS，
// 用户正看着应用时再弹 OS 横幅属纯重复打扰（实测风险告警"应用内+托盘"双弹）。
// 最小化/失焦（用户不在场）时横幅仍有价值，保留。
ipcMain.handle('os:notify', (_event, opts: { title?: string; body?: string }) => {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && mainWindow.isVisible()) {
      return { success: true, suppressed: 'window_focused' }
    }
    const title = typeof opts?.title === 'string' ? opts.title.slice(0, 80) : 'CrabPaw'
    const body = typeof opts?.body === 'string' ? opts.body.slice(0, 200) : ''
    if (!Notification.isSupported()) return { success: false, error: 'notifications not supported' }
    const notice = new Notification({ title, body })
    notice.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      } catch (err) {
        console.warn('[main] 通知点击聚焦失败:', err instanceof Error ? err.message : String(err))
      }
    })
    notice.show()
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[main] os:notify 失败:', msg)
    return { success: false, error: msg }
  }
})

ipcMain.handle('api:credentials', async () => {
  console.log('[KEY] api:credentials invoked')
  // S4 fix: 不再暴露 API_TOKEN 给渲染进程。渲染进程通过 api:proxy 走主进程代理
  return {
    port: API_PORT,
    baseUrl: `http://localhost:${API_PORT}`
  }
})

// T1.14: api:streamUrl 专用白名单——音频/下载类 GET 端点经 crabpaw-audio:// 协议由
// 主进程代理(零 token 接触面);SSE/WS/上传端点无法走自定义 scheme,仍注入 token 查询参数。
// 不能沿用 api:proxy 的宽白名单(/sessions /memory /logs 等敏感端点禁止经此通道)。
// 仅放行渲染层确实需要的: SSE(/chat /events)、音频播放(/api/voice/tts /api/voice/audio)、
// WS(/voice/cloud /scene)、上传(/upload /skills/install/zip)、下载(/api/profiles /api/backup/download)。
const STREAM_URL_EXACT_ENDPOINTS = [
  '/chat', '/events', '/voice/cloud', '/scene',
  '/upload', '/upload/base64', '/skills/install/zip',
  '/api/backup/download', '/api/proxy-audio',
]
const STREAM_URL_PREFIX_ENDPOINTS = [
  '/api/voice/tts', '/api/voice/audio/', '/api/profiles/', '/api/files/read',
]
function isStreamUrlAllowed(endpoint: string): boolean {
  // 与 isEndpointAllowed 相同的注入防御
  if (!endpoint.startsWith('/')) return false
  if (endpoint.startsWith('//')) return false
  if (endpoint.includes('://')) return false
  const pathOnly = endpoint.split('?')[0]
  if (STREAM_URL_EXACT_ENDPOINTS.includes(pathOnly)) return true
  return STREAM_URL_PREFIX_ENDPOINTS.some(p => pathOnly.startsWith(p))
}

ipcMain.handle('api:streamUrl', async (_, endpoint: string) => {
  // T1.14: 仅放行渲染层真正需要的端点(SSE/音频/WS/上传/下载),不再复用 api:proxy 宽白名单
  if (!isStreamUrlAllowed(endpoint)) {
    console.error('[api:streamUrl] Blocked endpoint:', endpoint)
    return { success: false, error: 'Endpoint not allowed' }
  }
  // 2026-08-12(T1.14 TODO 落地): 音频/下载类 GET 端点改走 crabpaw-audio:// 自定义协议,
  // 主进程 protocol.handle 校验白名单后带 X-Api-Key 代理——渲染层零 token 接触面,
  // 此 URL 不含敏感信息,可安全写入日志。
  // SSE(/chat /events)、WS(/voice/cloud /scene)、上传(/upload /skills/install/zip)端点
  // 保留 token 注入:EventSource/WebSocket 不支持自定义 scheme(WS 仅接受 ws/wss)、
  // POST 方法/表单体无法经 protocol.handle 转发——维持原 http 通道,行为不变。
  const pathOnly = endpoint.split('?')[0]
  const PROTOCOL_PROXY_ENDPOINTS = [
    '/api/voice/tts', '/api/voice/audio/', '/api/proxy-audio',
    '/api/backup/download', '/api/profiles/',
  ]
  if (PROTOCOL_PROXY_ENDPOINTS.some(p => pathOnly.startsWith(p))) {
    return { url: `crabpaw-audio://${endpoint.replace(/^\//, '')}` }
  }
  // 注意: 此 URL 一律不得写入 console 日志(token 会随日志泄露)。
  const token = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim() : API_TOKEN
  const separator = endpoint.includes('?') ? '&' : '?'
  return {
    url: `http://localhost:${API_PORT}${endpoint}${separator}token=${encodeURIComponent(token)}`
  }
})

// T1.2: api:sse — 主进程代连 SSE，渲染层完全拿不到 token
// 活动 SSE 连接池：streamId → http.ClientRequest（供渲染层关闭）
const _sseStreams = new Map<string, http.ClientRequest>()
ipcMain.handle('api:sse', async (event, { endpoint, since }: { endpoint: string; since?: number }) => {
  if (!isEndpointAllowed(endpoint)) {
    console.error('[api:sse] Blocked endpoint:', endpoint)
    return { success: false, error: 'Endpoint not allowed' }
  }
  const streamId = crypto.randomBytes(12).toString('hex')
  const token = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim() : API_TOKEN

  // 代理流清理与安全发送（修复：渲染进程销毁/HMR reload 后 WebContents 已销毁，
  // 直接 event.sender.send 抛 "Object has been destroyed"，连接池与后端连接
  // 永不清理 → 日志刷屏 + 连接泄漏。统一走 safeSend + destroyed 监听）
  let sseReq: http.ClientRequest | null = null
  let cleanupDone = false
  const cleanup = (why: string) => {
    if (cleanupDone) return
    cleanupDone = true
    if (_sseStreams.delete(streamId)) {
      console.log(`[api:sse] 清理流 ${streamId}: ${why}`)
    }
    if (sseReq) {
      try { sseReq.destroy() } catch { /* 已销毁 */ }
    }
  }
  const safeSend = (channel: string, payload: unknown) => {
    if (cleanupDone || event.sender.isDestroyed()) {
      cleanup('渲染进程已销毁')
      return false
    }
    try {
      event.sender.send(channel, payload)
      return true
    } catch (err: any) {
      cleanup(`发送失败: ${err?.message || err}`)
      return false
    }
  }
  event.sender.once('destroyed', () => cleanup('webContents destroyed'))

  // Task 6: 重连请求带 Last-Event-ID(since)——服务端据此重放 seq > since 的帧
  const reqHeaders: Record<string, string> = {
    'Accept': 'text/event-stream',
    'X-Api-Key': token,
    'Cache-Control': 'no-cache',
  }
  if (typeof since === 'number' && since > 0) {
    reqHeaders['Last-Event-ID'] = String(since)
  }
  sseReq = http.request({
    // R4: localhost 可能解析到 ::1(IPv6),后端只监听 127.0.0.1(IPv4) →
    // ECONNREFUSED。显式用 IPv4 回环。
    hostname: '127.0.0.1',
    port: API_PORT,
    path: endpoint,
    method: 'GET',
    headers: reqHeaders,
  }, (res) => {
    let buffer = ''
    let doneEmitted = false
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      // SSE 帧以 \n\n 分隔
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''
      for (const part of parts) {
        // 提取 id:/event:/data: 行（EventSource 协议; 服务端 id: <seq> 先行, 紧随 data: 归属该 seq）
        let eventName = 'message'
        let frameSeq: number | undefined
        const dataLines: string[] = []
        const lines = part.split('\n')
        for (const line of lines) {
          if (line.startsWith('id:')) {
            const v = line.slice(3).trim()
            frameSeq = /^\d+$/.test(v) ? Number(v) : undefined
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() || 'message'
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim())
          }
        }
        const payload = dataLines.join('\n')
        if (payload) {
          safeSend('sse:data', { streamId, data: payload, event: eventName, seq: frameSeq })
        }
        // 检查 [DONE] 信号
        if (payload === '[DONE]') {
          doneEmitted = true
          safeSend('sse:end', { streamId })
          cleanup('[DONE]')
          return
        }
      }
    })
    res.on('end', () => {
      if (doneEmitted) return
      // Flush buffer 残余：最后一段若不完整则丢弃，若有完整 data 行则发出
      if (buffer.trim()) {
        let eventName = 'message'
        let frameSeq: number | undefined
        const dataLines: string[] = []
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (line.startsWith('id:')) {
            const v = line.slice(3).trim()
            frameSeq = /^\d+$/.test(v) ? Number(v) : undefined
          } else if (line.startsWith('event:')) {
            eventName = line.slice(6).trim() || 'message'
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim())
          }
        }
        const payload = dataLines.join('\n')
        if (payload) {
          safeSend('sse:data', { streamId, data: payload, event: eventName, seq: frameSeq })
        }
      }
      safeSend('sse:end', { streamId })
      cleanup('end')
    })
    res.on('error', (err: Error) => {
      console.error('[api:sse] 响应流错误:', err?.message || err)
      safeSend('sse:error', { streamId, error: err.message })
      cleanup('响应错误')
    })
  })

  sseReq.on('error', (err: Error) => {
    console.error('[api:sse] 请求失败:', err?.message || err)
    safeSend('sse:error', { streamId, error: err.message })
    cleanup('请求错误')
  })

  sseReq.setTimeout(0) // SSE 长连接，不超时
  sseReq.end()

  _sseStreams.set(streamId, sseReq)
  // 渲染层销毁时清理对应 SSE 连接（destroy 幂等，已在 try/catch 中）
  event.sender.on('destroyed', () => {
    if (_sseStreams.has(streamId)) {
      try { sseReq.destroy() } catch (err: any) { console.warn('[api:sse] 渲染层销毁时清理失败:', err?.message || err) }
      _sseStreams.delete(streamId)
    }
  })
  return { success: true, streamId }
})

ipcMain.handle('api:sse:close', async (_, { streamId }: { streamId: string }) => {
  const sseReq = _sseStreams.get(streamId)
  if (sseReq) {
    try { sseReq.destroy() } catch (err: any) { console.error('[api:sse] 关闭失败:', err?.message || err) }
    _sseStreams.delete(streamId)
    return { success: true }
  }
  return { success: false, error: 'Stream not found' }
})

ipcMain.handle('service:start', async (_, opts?: { channel?: string | string[] }) => {
  try {
    // E5: Guard against concurrent service:start calls
    if (isStartingServer) {
      console.log('[service:start] Server startup already in progress, waiting...')
      // Wait for existing startup to complete (with timeout)
      const guardStart = Date.now()
      while (isStartingServer && Date.now() - guardStart < 60000) {
        await new Promise(r => setTimeout(r, 500))
      }
      if (isStartingServer) {
        return { success: false, error: 'Server startup timed out waiting for another startup flow' }
      }
      if (serviceReady) {
        return { success: true }
      }
      // If still not ready after wait, fall through to attempt start
    }

    // First check via HTTP if service is actually running (more reliable than memory flag)
    const actuallyRunning = await checkPortInUse()
    if (actuallyRunning) {
      serviceReady = true
      console.log('[OK] service:start: service already running')
    } else if (!serviceReady) {
      await startCrabPawServer()
    } else {
      // serviceReady is true but HTTP check failed, service may have crashed
      console.log('[WARN] service:start: ready=true but HTTP check failed, restarting')
      serviceReady = false
      await startCrabPawServer()
    }

    // Determine which bridges to start:
    // 1. Config file (authoritative)
    // 2. Frontend-passed channel (fallback if config not yet saved)
    // 3. Config has credentials → auto-include even if channel not set
    const configPath = path.join(DATA_DIR, 'config.json')
    let config: any = {}
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      }
    } catch (err) { console.warn('[config] 读取失败(使用空配置):', err instanceof Error ? err.message : String(err)) }

    const configChannel = config.chatChannel || 'none'
    const frontendChannel = opts?.channel || 'none'

    // Merge: use config first, fallback to frontend
    let channels = new Set<string>()
    const configList = Array.isArray(configChannel) ? configChannel : [configChannel]
    const frontendList = Array.isArray(frontendChannel) ? frontendChannel : [frontendChannel]
    configList.forEach(c => channels.add(c))
    frontendList.forEach(c => channels.add(c))

    // Auto-include bridges that have credentials configured
    // Use CredentialManager for authoritative isConfigured checks
    if (getCredMgr().isWecomConfigured()) {
      channels.add('wecom')
      console.log('[service:start] WeCom credentials found in config, auto-enabling bridge')
    }
    if (getCredMgr().isLarkConfigured()) {
      channels.add('lark')
      console.log('[service:start] Lark credentials found in config, auto-enabling bridge')
    }

    console.log('[service:start] Channels to start:', [...channels])

    if (channels.has('lark') && !larkBridge) {
      await startLarkBridge()
    }
    if (channels.has('wecom') && !wecomBridge) {
      // Check if WeCom bridge process is already running (started by main service)
      const wecomPidPath = path.join(DATA_DIR, '.wecom_bridge.pid')
      let existingBridgeRunning = false
      try {
        if (fs.existsSync(wecomPidPath)) {
          const pid = parseInt(fs.readFileSync(wecomPidPath, 'utf-8').trim(), 10)
          if (pid) {
            try {
              process.kill(pid, 0)
              existingBridgeRunning = true
              console.log(`[service:start] WeCom bridge already running (PID ${pid}), skipping`)
            } catch (err) {
              // Process does not exist, clean up PID file
              console.warn('[service:start] WeCom 进程不存在(PID 探活失败):', err instanceof Error ? err.message : String(err))
              try { fs.unlinkSync(wecomPidPath) } catch (unlinkErr) { console.warn('[service:start] PID 文件清理失败:', unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)) }
            }
          }
        }
      } catch (err) { console.warn('[service:start] WeCom PID 文件检查失败:', err instanceof Error ? err.message : String(err)) }

      if (!existingBridgeRunning) {
        await startWecomBridge()
      }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('service:stop', async () => {
  try {
    stopServices()
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('config:reload-bridges', async () => {
  try {
    const configPath = path.join(DATA_DIR, 'config.json')
    let config: any = {}
    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      }
    } catch (err) { console.warn('[config] 读取失败(使用空配置):', err instanceof Error ? err.message : String(err)) }

    const configChannel = config.chatChannel || 'none'
    const channels = new Set(
      Array.isArray(configChannel) ? configChannel : [configChannel]
    )
    // Auto-include bridges with credentials configured (use CredentialManager for authoritative check)
    if (getCredMgr().isWecomConfigured()) channels.add('wecom')
    if (getCredMgr().isLarkConfigured()) channels.add('lark')

    if (!channels.has('lark') && larkBridge) {
      try { larkBridge.kill() } catch (err) { console.warn('[config] 飞书桥停止失败:', err instanceof Error ? err.message : String(err)) }
      larkBridge = null
    }
    if (!channels.has('wecom') && wecomBridge) {
      try { wecomBridge.kill() } catch (err) { console.warn('[config] 企微桥停止失败:', err instanceof Error ? err.message : String(err)) }
      wecomBridge = null
    }

    if (channels.has('lark') && !larkBridge && serviceReady) {
      await startLarkBridge()
    }
    if (channels.has('wecom') && !wecomBridge && serviceReady) {
      await startWecomBridge()
    }

    return { success: true, chatChannel: [...channels] }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('service:status', async () => {
  return new Promise((resolve) => {
    let resolved = false
    const req = http.get(`http://127.0.0.1:${API_PORT}/health`, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        if (resolved) return
        resolved = true
        // HTTP health check passed, service is running
        serviceReady = true
        try {
          const data = JSON.parse(body)
          const larkStatus = data.components?.lark?.status || (data.lark ? 'connected' : 'disconnected')
          
          const wecomStatusPath = path.join(DATA_DIR, 'wecom-status.json')
          const wecomPidPath = path.join(DATA_DIR, '.wecom_bridge.pid')
          let wecomConnected = false
          try {
            if (fs.existsSync(wecomStatusPath)) {
              const wecomStatus = JSON.parse(fs.readFileSync(wecomStatusPath, 'utf-8'))
              const timeDiff = Date.now() - wecomStatus.timestamp
              wecomConnected = wecomStatus.connected && (timeDiff < 120000)

              if (!wecomConnected && wecomStatus.connected && fs.existsSync(wecomPidPath)) {
                try {
                  const pid = parseInt(fs.readFileSync(wecomPidPath, 'utf-8').trim(), 10)
                  if (pid) {
                    process.kill(pid, 0)
                    wecomConnected = true
                    fs.writeFileSync(wecomStatusPath, JSON.stringify({ connected: true, timestamp: Date.now() }))
                  }
                } catch (_) {
                  // 进程探活失败 = 桥未运行,属正常探测结果,不视为错误
                }
              }
            }
          } catch (e) {
            console.error('[service:status] Failed to read wecom-status.json:', e)
          }

          resolve({
            server: res.statusCode === 200,
            larkBridge: larkStatus === 'connected',
            wecomBridge: wecomConnected
          })
        } catch (e) {
          console.error('[ERR] Failed to parse health response:', e)
          resolve({
            server: res.statusCode === 200,
            larkBridge: false,
            wecomBridge: false
          })
        }
      })
    })
    req.on('error', () => {
      if (resolved) return
      resolved = true
      serviceReady = false
      
      // Check if service process is still alive
      const serverAlive = crabpawServer && crabpawServer.pid && !crabpawServer.killed
      if (serverAlive) {
        console.log('[service:status] HTTP health check failed, process alive (starting up)')
      }
      
      resolve({
        server: false,
        larkBridge: false,
        wecomBridge: false
      })
    })
    req.setTimeout(3000, () => {
      if (resolved) return
      resolved = true
      serviceReady = false
      req.destroy()
      resolve({
        server: false,
        larkBridge: false,
        wecomBridge: false
      })
    })
  })
})

// T1.6: 敏感字段掩码——保留前4后4，中间用 **** 替换
function maskSecret(val: string): string {
  if (!val || typeof val !== 'string') return val
  if (val.length <= 8) return '****'
  return val.slice(0, 4) + '****' + val.slice(-4)
}

// T1.6: 递归遍历对象掩码敏感字段
function maskConfigSecrets(obj: any, depth: number = 0): void {
  if (!obj || typeof obj !== 'object' || depth > 10) return
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      maskConfigSecrets(value, depth + 1)
    } else if (typeof value === 'string' && value.length >= 4) {
      // 掩码 apiKey / appSecret / secret / token 等敏感字段
      const lower = key.toLowerCase()
      if (lower === 'apikey' || lower === 'api_key' || lower === 'appsecret' ||
          lower === 'app_secret' || lower === 'secret' || lower === 'token' ||
          lower === 'password' || lower === 'apikeyhash') {
        // 仅掩码真实值，保持已掩码值（含 ****）不变
        if (!value.includes('****')) {
          obj[key] = maskSecret(value)
        }
      }
    }
  }
}

ipcMain.handle('config:get', async () => {
  const config = readJsonFile(CONFIG_PATH) || {}
  // Merge in user/assistant sub-configs (saved to separate files by saveConfig)
  try {
    const userConfigPath = path.join(DATA_DIR, 'config', 'user.json')
    if (fs.existsSync(userConfigPath)) {
      config.user = { ...config.user, ...JSON.parse(fs.readFileSync(userConfigPath, 'utf-8')) }
    }
    const assistantConfigPath = path.join(DATA_DIR, 'config', 'assistant.json')
    if (fs.existsSync(assistantConfigPath)) {
      config.agent = { ...config.agent, ...JSON.parse(fs.readFileSync(assistantConfigPath, 'utf-8')) }
    }
  } catch (err) { console.warn('[config:get] 子配置合并失败:', err instanceof Error ? err.message : String(err)) }
  // Inject authoritative isConfigured flags (resolves secrets from env, config.json, .api_keys.json)
  try {
    config._isLarkConfigured = getCredMgr().isLarkConfigured()
    config._isWecomConfigured = getCredMgr().isWecomConfigured()
  } catch (e) { console.warn('[config:get] CredentialManager 不可用:', e instanceof Error ? e.message : String(e)) }
  if (!config.wakeWord) config.wakeWord = '小螃蟹' // 品牌默认唤醒词（用户自定义保留）
  // T1.6: 回传前掩码敏感字段（apiKey / appSecret 等）
  try { maskConfigSecrets(config) } catch (e) { console.error('[config:get] 掩码失败:', e) }
  return config
})

// 2026-08-15 修复: config:set 此前任意对象直写 CONFIG_PATH 无 schema 校验——加
// 顶层字段白名单, 未知字段拒绝写入(防越权扩展配置结构); 下划线前缀内部字段
// (config:get 注入的 _isLarkConfigured 等)在 set 时静默剥离(每次 get 都会重新注入)。
// 校验/剥离逻辑抽至 config-set-guard.ts(纯函数, 单测覆盖)。

ipcMain.handle('config:set', async (_, config) => {
  // 2026-08-15 审查返工: _ 前缀剥离必须先于 unknownFields 校验(见 sanitizeConfigSetPayload),
  // 否则 SetupWizard 将 config:get 整包(含 _isLarkConfigured/_isWecomConfigured)
  // 回传时被误拒——非首启修改唤醒词静默失败、数据丢失。
  const guard = sanitizeConfigSetPayload(config)
  if (!guard.ok) {
    return { success: false, error: guard.error }
  }
  config = guard.config

  // S10 fix: 检测敏感字段写入并记录警告
  const SECRET_PATTERNS = ['apiKey', 'appSecret', 'secret', 'password', 'token', 'apiKey']
  try {
    const checkSecrets = (obj: any, path: string = '') => {
      if (!obj || typeof obj !== 'object') return
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key
        if (SECRET_PATTERNS.some(p => key.toLowerCase().includes(p.toLowerCase())) && value && typeof value === 'string') {
          console.warn(`[SECURITY] config:set writing sensitive field: ${currentPath} — consider using encrypted storage`)
        }
        if (value && typeof value === 'object') {
          checkSecrets(value, currentPath)
        }
      }
    }
    checkSecrets(config)
  } catch (err) { console.warn('[config:set] 敏感字段扫描失败:', err instanceof Error ? err.message : String(err)) }

  // Preserve existing credentials when incoming values are empty (SetupWizard safety net)
  const existing = readJsonFile(CONFIG_PATH)
  if (existing) {
    if (config.wecom && !config.wecom.corpId && existing.wecom?.corpId) config.wecom.corpId = existing.wecom.corpId
    if (config.wecom && !config.wecom.botId && existing.wecom?.botId) config.wecom.botId = existing.wecom.botId
    if (config.lark && !config.lark.appId && existing.lark?.appId) config.lark.appId = existing.lark.appId
  }
  return writeJsonFile(CONFIG_PATH, config)
})

ipcMain.handle('config:check', async () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    return false
  }
  
  const config = readJsonFile(CONFIG_PATH)
  if (!config || !config.models || !config.models.providers) {
    return false
  }
  
  const providers = config.models.providers
  const hasApiKey = Object.values(providers).some((p: any) => p && p.apiKey && p.apiKey.length > 0)
  
  return hasApiKey
})

ipcMain.handle('config:user:get', async () => {
  return readJsonFile(path.join(DATA_DIR, 'config/user.json'))
})

ipcMain.handle('config:user:set', async (_, config) => {
  return writeJsonFile(path.join(DATA_DIR, 'config/user.json'), config)
})

ipcMain.handle('config:assistant:get', async () => {
  return readJsonFile(path.join(DATA_DIR, 'config/assistant.json'))
})

ipcMain.handle('config:assistant:set', async (_, config) => {
  return writeJsonFile(path.join(DATA_DIR, 'config/assistant.json'), config)
})

// T1.1: Extract whitelist check for reuse across api:proxy, api:streamUrl, api:sse
function isEndpointAllowed(endpoint: string): boolean {
  // Reject non-slash endpoints (prevents schema:// injection)
  if (!endpoint.startsWith('/')) return false
  // Reject protocol-relative URLs (//example.com bypasses :// detection; defense-in-depth)
  if (endpoint.startsWith('//')) return false
  // Reject endpoints containing :// (prevents http:// bypass in path)
  if (endpoint.includes('://')) return false
  const ALLOWED_API_PREFIXES = [
    '/api/', '/status', '/config', '/health',
    '/sessions', '/memory', '/tools', '/skills',
    '/projects', '/backup', '/logs', '/usage',
    '/plugins', '/system',
    '/chat', '/upload', '/confirm', '/webhook',
    '/flows', '/test-message', '/dashboard-plugins',
    '/evolution', '/history', '/mcp', '/schedules',
    '/workspace', '/commands', '/events', '/lark',
    '/api/plugin-manager',
    '/api/files', '/stats', '/errors',
    '/panels/',
    // 2026-08-05 fix: 语音 WS(ASR/TTS 云链)端点缺白名单导致 streamUrl 注入失败
    '/voice/',
    // 2026-08-05 fix: scene-client 的 /scene WS 端点缺白名单——getAuthenticatedWsUrl 被拒
    // → streamInfo.url undefined → toWebSocketUrl 崩溃 + 场景 surface 实时通道中断
    '/scene',
  ]
  // T1.15: 前缀匹配加边界——'/' 分隔,防止 /status 白名单被 /status.json、
  // /config 被 /config.json 之类的相似路径绕过。前缀去尾斜杠后比较
  // (如 /api/、/panels/、/voice/ 去尾斜杠为 /api、/panels、/voice,
  // 再拼 '/' 边界——/panels/hotspot/all 命中、/panelsx 不命中)。
  return ALLOWED_API_PREFIXES.some(p => endpoint === p || endpoint.startsWith(p.replace(/\/+$/, '') + '/'))
}

// T1.15: 响应体敏感端点——/sessions /memory /logs 及其子路径的响应体不落日志
// (含 token/对话/记忆/日志原文; /config 亦不落——含配置细节)
const SENSITIVE_LOG_ENDPOINTS = ['/sessions', '/memory', '/logs', '/config']
function isSensitiveLogEndpoint(endpoint: string): boolean {
  const pathOnly = endpoint.split('?')[0]
  return SENSITIVE_LOG_ENDPOINTS.some(p => pathOnly === p || pathOnly.startsWith(p + '/'))
}

ipcMain.handle('api:proxy', async (_, { method, endpoint, body }: { method: string; endpoint: string; body?: any }) => {
  console.log('[api:proxy] Request:', method, endpoint)

  if (!isEndpointAllowed(endpoint)) {
    console.error('[api:proxy] Blocked:', endpoint)
    return { success: false, status: 403, error: 'Endpoint not allowed' }
  }
  
  const token = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim() : API_TOKEN
  
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: API_PORT,
      path: endpoint,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': token,
      },
    }
    
    // T1.15: 不打印 options(含 X-Api-Key token)——只打 method + endpoint
    console.log('[api:proxy] Proxying to backend:', method, endpoint)

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const responseData = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed
          // 2026-08-14 审计 G8: GET /config 响应在主进程侧再掩码一遍(泛化掩码,
          // 覆盖后端 redact 未枚举的 apiKey/secret/token/password 字段),
          // 渲染层经 api:proxy 不再拿到密钥明文(与 config:get 掩码行为对齐)。
          // POST /config 写入路径不受影响(掩码仅作用于 GET 响应)。
          const reqPathOnly = endpoint.split('?')[0]
          if (method.toUpperCase() === 'GET' && reqPathOnly === '/config' && responseData && typeof responseData === 'object') {
            try {
              maskConfigSecrets(responseData)
            } catch (e) {
              console.error('[api:proxy] /config 掩码失败:', e instanceof Error ? e.message : String(e))
            }
          }
          // T1.15: 响应体日志脱敏——敏感端点不落日志;其余仅打状态码 + JSON 截断 200 字符
          if (isSensitiveLogEndpoint(endpoint)) {
            console.log('[api:proxy] Backend response:', res.statusCode, '(body 省略: 敏感端点)')
          } else {
            const snippet = JSON.stringify(parsed)?.slice(0, 200)
            console.log('[api:proxy] Backend response:', res.statusCode, snippet)
          }
          resolve({
            success: res.statusCode! < 400 && (parsed.success !== false),
            status: res.statusCode,
            data: responseData,
            error: parsed.error || parsed.message
          })
        } catch (err) {
          console.warn('[api:proxy] 响应解析失败(非 JSON 响应):', err instanceof Error ? err.message : String(err))
          resolve({ success: res.statusCode! < 400, status: res.statusCode, data })
        }
      })
    })
    
    req.on('error', (err) => {
      resolve({ success: false, error: err.message })
    })
    
    // 2026-08-19: 会议总结 summarize 提至 120s——后端 60s 超时兜底 + AI 生成常达
    // 10-15s,默认 10s 必然 destroy 请求:后端仍完成落库+SSE 广播,但渲染层 HTTP 失败
    // → 错误条「操作失败」与 SSE 成功结果并存(实测 11268ms > 10s 触发)。
    req.setTimeout(endpoint === '/api/stt' || endpoint === '/api/voice/tts' ? 120000 : endpoint === '/config' || endpoint === '/config/user' ? 30000 : /^\/api\/meetings\/[^/]+\/summarize$/.test(endpoint) ? 120000 : /^\/skills\/market\/(install|search)$/.test(endpoint) ? 120000 : 10000, () => {
      req.destroy()
      resolve({ success: false, error: 'Request timed out' })
    })
    
    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
})

ipcMain.handle('app:version', async () => {
  return APP_VERSION
})

// 2026-08-14 审计 M5: 更新检查 URL 域名白名单——更新源为自定义服务,
// 以用户配置的 update.url 的 https origin 为准(配置缺失或非 https 则视为无白名单)。
function getConfiguredUpdateOrigin(): string | null {
  try {
    const config = readJsonFile(CONFIG_PATH)
    const raw = config?.update?.url
    if (!raw || typeof raw !== 'string' || !raw.trim()) return null
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    return u.origin
  } catch (e) {
    console.warn('[update] 读取更新配置失败:', e instanceof Error ? e.message : String(e))
    return null
  }
}

ipcMain.handle('app:checkUpdate', async (_, updateUrl: string) => {
  // TODO(E10): Implement trusted auto-update with code signing verification (e.g., electron-updater with signature validation)
  // TODO(E11): Ensure executable is signed in CI/CD pipeline (Windows: signtool, macOS: codesign) for secure auto-update
  return new Promise((resolve) => {
    if (!updateUrl) {
      resolve({ success: false, error: 'Update address not configured' })
      return
    }

    let secureUrl = updateUrl
    try {
      const urlObj = new URL(updateUrl)
      if (urlObj.protocol !== 'https:') {
        console.warn('[WARN] Update URL must use HTTPS, auto-upgraded')
        urlObj.protocol = 'https:'
        secureUrl = urlObj.toString()
      }
      // 2026-08-14 审计 M5: 域名白名单——渲染层传入的更新地址必须与用户配置的
      // update.url 同 origin,防止任意主机探测/钓鱼下载。未配置时一律拒绝。
      const configuredOrigin = getConfiguredUpdateOrigin()
      if (!configuredOrigin || urlObj.origin !== configuredOrigin) {
        console.warn('[SECURITY] 更新检查 URL 不在白名单(配置 update.url origin):', updateUrl, 'configured:', configuredOrigin || '(none)')
        resolve({ success: false, error: 'Update host not allowed' })
        return
      }
    } catch (e) {
      resolve({ success: false, error: 'Invalid update address' })
      return
    }
    
    const req = https.get(`${secureUrl}/version.json`, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          const latestVersion = data.version || '0.0.0'
          const hasUpdate = compareVersions(latestVersion, APP_VERSION) > 0
          resolve({
            success: true,
            hasUpdate,
            currentVersion: APP_VERSION,
            latestVersion,
            downloadUrl: `${secureUrl}/download`,
            releaseNotes: data.releaseNotes || ''
          })
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse version info' })
        }
      })
    })
    req.on('error', (e) => {
      resolve({ success: false, error: e.message })
    })
    req.setTimeout(10000, () => {
      req.destroy()
      resolve({ success: false, error: 'Update check timed out' })
    })
  })
})

function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0
    const numB = partsB[i] || 0
    if (numA > numB) return 1
    if (numA < numB) return -1
  }
  return 0
}

async function autoCheckUpdate() {
  try {
    const config = readJsonFile(CONFIG_PATH)
    const updateSettings = config?.update
    
    if (!updateSettings?.url || updateSettings?.autoCheck === false) {
      return
    }
    
    let secureUrl = updateSettings.url
    try {
      const urlObj = new URL(updateSettings.url)
      if (urlObj.protocol !== 'https:') {
        urlObj.protocol = 'https:'
        secureUrl = urlObj.toString()
      }
    } catch (err) {
      console.warn('[update] 更新地址解析失败,跳过自动检查:', err instanceof Error ? err.message : String(err))
      return
    }
    
    const result = await new Promise<any>((resolve) => {
      const req = https.get(`${secureUrl}/version.json`, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (err) {
            console.warn('[update] 版本信息解析失败:', err instanceof Error ? err.message : String(err))
            resolve(null)
          }
        })
      })
      req.on('error', () => resolve(null))
      req.setTimeout(5000, () => {
        req.destroy()
        resolve(null)
      })
    })
    
    if (result?.version && compareVersions(result.version, APP_VERSION) > 0) {
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: 'New version found',
          message: `New version v${result.version} found`,
          detail: result.releaseNotes || 'Update recommended for latest features and fixes.',
          buttons: ['Remind later', 'Go to download'],
          defaultId: 1
        }).then((result) => {
          if (result.response === 1) {
            require('electron').shell.openExternal(`${secureUrl}/download`)
          }
        })
      }
    }
    
    if (config) {
      config.update = config.update || {}
      config.update.lastCheck = new Date().toISOString()
      writeJsonFile(CONFIG_PATH, config)
    }
  } catch (e) {
    console.error('Auto check update failed:', e)
  }
}

ipcMain.handle('file:open', async (_, filePath: string) => {
  console.log('[file:open] 请求打开:', filePath)
  try {
    const { shell } = require('electron')
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` }
    }

    // T1.5: 阻止可执行文件类型直接打开（RCE 防御）
    const ext = path.extname(filePath).toLowerCase()
    const BLOCKED_EXTENSIONS = [
      '.exe', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
      '.wsf', '.wsh', '.msi', '.scr', '.com', '.pif', '.hta', '.cpl',
      '.msc', '.jar', '.reg', '.inf',
    ]
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return { success: false, error: '该文件类型不允许直接打开' }
    }

    // S9 fix: 使用 path.normalize + path.resolve + fs.realpathSync 防止路径穿越和符号链接逃逸
    const resolvedPath = path.normalize(path.resolve(filePath)).toLowerCase()
    const allowedDirs = [
      path.normalize(path.resolve(DATA_DIR)).toLowerCase(),
      path.normalize(path.resolve(BACKEND_CWD)).toLowerCase(),
      path.normalize(path.resolve(DATA_DIR, 'uploads')).toLowerCase(),
    ]

    // 检查符号链接目标是否仍在允许目录内
    try {
      const realPath = fs.realpathSync(resolvedPath).toLowerCase()
      const realAllowed = allowedDirs.some(dir =>
        realPath.startsWith(dir + path.sep) || realPath === dir
      )
      if (!realAllowed) {
        return { success: false, error: 'Security restriction: symlink target escapes allowed directories' }
      }
      // T1.13: 符号链接真实目标也须过敏感文件黑名单(与 validateDataDirFile 一致)
      if (isSensitiveFilePath(realPath)) {
        return { success: false, error: '不允许打开敏感文件' }
      }
    } catch (err) {
      // 文件不存在或不可解析，后续逻辑会处理
      console.warn('[file:open] realpath 解析失败:', err instanceof Error ? err.message : String(err))
    }

    const isAllowed = allowedDirs.some(dir =>
      resolvedPath.startsWith(dir + path.sep) || resolvedPath === dir
    )

    if (!isAllowed) {
      return { success: false, error: `Security restriction: only files within data or project directories can be opened. Current path: ${resolvedPath}` }
    }

    // T1.13: 敏感文件黑名单(token/密钥/配置/数据库/日志)不允许直接打开。
    // SENSITIVE_FILE_NAMES/EXTS 定义于模块下方,handler 为运行时调用,此时已初始化,无 TDZ 问题。
    if (isSensitiveFilePath(resolvedPath)) {
      return { success: false, error: '不允许打开敏感文件' }
    }

    await shell.openPath(filePath)
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

// T1.13: 敏感文件黑名单——目录前缀校验之外的第二道防线。
// 防止渲染层借 file:read-base64 / voice:read-audio / voice:play 读取
// token/密钥/配置/数据库/日志等敏感文件(DATA_DIR 内同样需要拦截)。
const SENSITIVE_FILE_NAMES = new Set([
  '.api_token', '.api_port', '.api_keys.json', 'config.json',
  'audit-log.json', 'access-log.json',
  // 2026-08-08(审计 P1): .env/.env.* 含全部 provider 密钥——后端根目录在
  // allowedDirs 内,此前渲染层可诱导 file:open 打开 .env
  '.env', '.env.local', '.env.development', '.env.production', '.env.test',
])
// *.db / *.db-wal / *.db-shm / *.log 按扩展名后缀匹配
const SENSITIVE_FILE_EXTS = ['.db', '.db-wal', '.db-shm', '.log']

function isSensitiveFilePath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase()
  if (SENSITIVE_FILE_NAMES.has(base)) return true
  return SENSITIVE_FILE_EXTS.some(ext => base.endsWith(ext))
}

/** T1.13: DATA_DIR 内 + 非敏感文件的统一校验(file:read-base64 / voice:read-audio / voice:play 共用) */
function validateDataDirFile(filePath: string): { ok: boolean; error?: string } {
  if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${filePath}` }
  // 前缀 + realpath 双重校验(防路径穿越与符号链接逃逸)
  const resolvedPath = path.normalize(path.resolve(filePath)).toLowerCase()
  const dataDirResolved = path.normalize(path.resolve(DATA_DIR)).toLowerCase()
  if (!resolvedPath.startsWith(dataDirResolved + path.sep) && resolvedPath !== dataDirResolved) {
    return { ok: false, error: 'Security restriction: only files within data directory can be read' }
  }
  if (isSensitiveFilePath(resolvedPath)) {
    return { ok: false, error: 'Security restriction: sensitive file is not allowed to be read' }
  }
  try {
    const realPath = fs.realpathSync(resolvedPath).toLowerCase()
    if (!realPath.startsWith(dataDirResolved + path.sep) && realPath !== dataDirResolved) {
      return { ok: false, error: 'Security restriction: symlink target escapes data directory' }
    }
    if (isSensitiveFilePath(realPath)) {
      return { ok: false, error: 'Security restriction: sensitive file is not allowed to be read' }
    }
  } catch (err) {
    console.warn('[file:read] realpath 解析失败:', err instanceof Error ? err.message : String(err))
    return { ok: false, error: 'File not resolvable' }
  }
  return { ok: true }
}

ipcMain.handle('file:read-base64', async (_, filePath: string) => {
  try {
    const check = validateDataDirFile(filePath)
    if (!check.ok) {
      return { success: false, error: check.error }
    }

    const stats = fs.statSync(filePath)
    if (stats.size > 50 * 1024 * 1024) {
      return { success: false, error: 'File too large, exceeds 50MB' }
    }
    const buffer = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mimeMap: Record<string, string> = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    return {
      success: true,
      data: buffer.toString('base64'),
      mime,
      size: stats.size,
      name: path.basename(filePath)
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

ipcMain.handle('window:minimize', async () => {
  mainWindow?.minimize()
})

ipcMain.handle('window:maximize', async () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow?.maximize()
  }
})

// 2026-08-14: 窗口最大化状态查询——E2E 用状态轮询替代 outerHeight 比较
// (frameless 窗口动画期间高度不可靠,导致 window:maximize 测试偶发失败)
ipcMain.handle('window:isMaximized', async () => {
  return mainWindow?.isMaximized() ?? false
})

// 2026-08-14: 窗口最小化状态查询 + 确定性还原——E2E 窗口测试自包含
// (minimize 后调 maximize() 的切换语义在 Windows 上会残留 maximized 状态,
//  状态污染下一个测试;restore 统一回 normal 态)
ipcMain.handle('window:isMinimized', async () => {
  return mainWindow?.isMinimized() ?? false
})

ipcMain.handle('window:restore', async () => {
  const win = mainWindow
  if (!win) return
  if (win.isMinimized()) {
    win.restore()
  } else if (win.isMaximized()) {
    win.unmaximize()
  }
})

// T1.11: shell:openExternal——默认仅放行 https;http 需显式配置允许(dev 模式放行便利开发)
const ALLOW_HTTP_OPEN_EXTERNAL = isDev || process.env.CRABPAW_ALLOW_HTTP_EXTERNAL === 'true'

ipcMain.handle('shell:openExternal', async (_, url: string) => {
  const { shell } = require('electron')
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ALLOW_HTTP_OPEN_EXTERNAL)) {
      return { success: false, error: 'Only https URLs allowed' }
    }
    // 防超长 URL 与 hostname 控制字符(旧正则前缀校验可被畸形字符绕过)
    if (url.length >= 2048) {
      return { success: false, error: 'URL too long' }
    }
    if (/[\x00-\x1F\x7F]/.test(u.hostname)) {
      return { success: false, error: 'Invalid URL hostname' }
    }
    await shell.openExternal(url)
    return { success: true }
  } catch (err) {
    console.error('[shell:openExternal] 无效 URL:', url, err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Invalid URL' }
  }
})

// 2026-08-21: 对话附件本地文件打开——openExternal 只放行 https/http，
// 附件是本地磁盘路径 → new URL() 直接抛错 → 点击无响应（实测）。
// 白名单复用 local:// 协议的放行目录（workspace 产物区），并过敏感文件黑名单。
ipcMain.handle('shell:openPath', async (_, filePath: string) => {
  const { shell } = require('electron')
  try {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length >= 2048 || filePath.includes('..')) {
      return { success: false, error: 'Invalid path' }
    }
    const resolved = path.normalize(path.resolve(filePath))
    const allowedDirs = [
      path.join(DATA_DIR, 'workspace'),
      path.join(BACKEND_CWD, 'data', 'workspace'),
    ].map(dir => path.normalize(path.resolve(dir)) + path.sep)
    const isAllowed = allowedDirs.some(dir => resolved.toLowerCase().startsWith(dir.toLowerCase()))
    if (!isAllowed || isSensitiveFilePath(resolved)) {
      console.warn('[shell:openPath] 路径被拒:', resolved)
      return { success: false, error: 'Path not allowed' }
    }
    const err = await shell.openPath(resolved)
    return err ? { success: false, error: err } : { success: true }
  } catch (err) {
    console.error('[shell:openPath] 打开失败:', filePath, err instanceof Error ? err.message : String(err))
    return { success: false, error: 'Invalid path' }
  }
})

ipcMain.handle('window:close', async () => {
  mainWindow?.close()
})

ipcMain.handle('window:restart', async () => {
  if (mainWindow) {
    isRestarting = true
    const oldWindow = mainWindow
    mainWindow = null
    oldWindow.destroy()
    setTimeout(() => {
      createWindow()
      isRestarting = false
    }, 100)
  }
})

// ==================== Voice Audio Player ====================
let currentAudioProcess: ChildProcess | null = null

function stopAudioPlayback() {
  if (currentAudioProcess) {
    try {
      currentAudioProcess.kill()
    } catch (err) { console.warn('[AUDIO] 播放进程终止失败(可能已退出):', err instanceof Error ? err.message : String(err)) }
    currentAudioProcess = null
  }
}

function notifyVoiceStopped() {
  console.log('[AUDIO] [notifyVoiceStopped] Sending voice:stopped to renderer')
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('voice:stopped')
  }
}

function playAudioFile(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log('[AUDIO] [playAudioFile] Start playing audio:', filePath)
    stopAudioPlayback()

    if (!fs.existsSync(filePath)) {
      console.error('[AUDIO] [playAudioFile] Audio file not found:', filePath)
      resolve(false)
      return
    }

    // ── Windows: ffmpeg → temp WAV → SoundPlayer.PlaySync() ──
    // 不用 PowerShell MediaPlayer（没有 WPF Dispatcher 消息泵，不会真正出声）。
    // SoundPlayer 是 WinForms 控件，PlaySync 自带消息泵，可靠。
    if (process.platform === 'win32') {
      const tempWav = path.join(app.getPath('temp'), `crabpaw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`)
      let resolved = false
      const doResolve = (success: boolean, reason: string) => {
        if (resolved) return
        resolved = true
        console.log(`[AUDIO] [playAudioFile] ${reason}`)
        currentAudioProcess = null
        // 尽量清理临时 WAV
        try { if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav) } catch (err) { console.warn('[AUDIO] 临时 WAV 清理失败:', err instanceof Error ? err.message : String(err)) }
        notifyVoiceStopped()
        resolve(success)
      }

      // 1) ffmpeg 解码 MP3 → WAV
      const ffmpeg = spawn('ffmpeg', ['-y', '-i', filePath, '-ac', '1', '-ar', '22050', tempWav], {
        windowsHide: true,
      })
      currentAudioProcess = ffmpeg
      let ffmpegErr = ''

      ffmpeg.stderr.on('data', (chunk: Buffer) => { ffmpegErr += chunk.toString() })
      ffmpeg.on('exit', (code) => {
        if (code !== 0 || !fs.existsSync(tempWav)) {
          doResolve(false, `ffmpeg decode failed (code=${code}): ${ffmpegErr.slice(0, 200)}`)
          return
        }
        console.log(`[AUDIO] ffmpeg decode OK: ${path.basename(tempWav)}`)

        // 2) PowerShell SoundPlayer.PlaySync (同步，可靠)
        // SoundPlayer 本身不支持 Volume，用 winmm.dll waveOutSetVolume
        // 在 PlaySync 前后调整当前进程的音频输出音量
        // 2026-08-08(音量忽大忽小修复): 播放前先读原音量,结束后恢复原值——
        // 旧实现 finally 无条件恢复 100%,用户系统音量 40% 播完一个文件被拉满
        const duckPercent = isTtsDucked ? 35 : 100
        const psScript = `
          Add-Type -TypeDefinition @"
          using System;
          using System.Runtime.InteropServices;
          public class AudioVol {
            [DllImport("winmm.dll")]
            public static extern int waveOutSetVolume(IntPtr hwo, uint dwVolume);
            [DllImport("winmm.dll")]
            public static extern int waveOutGetVolume(IntPtr hwo, out uint pdwVolume);
          }
"@
          [uint]$beforeVol = 0
          [AudioVol]::waveOutGetVolume([IntPtr]::Zero, [ref]$beforeVol) | Out-Null
          $vol = [Math]::Max(0, [Math]::Min(100, ${duckPercent}))
          $v = [uint]($vol * 65535 / 100)
          $combined = $v -bor ($v -shl 16)
          [AudioVol]::waveOutSetVolume([IntPtr]::Zero, $combined)
          try {
            $player = New-Object System.Media.SoundPlayer('${tempWav.replace(/'/g, "''")}')
            $player.PlaySync()
          } finally {
            if ($beforeVol -ne 0) {
              [AudioVol]::waveOutSetVolume([IntPtr]::Zero, $beforeVol)
            }
          }
          Write-Host 'Playback completed'
        `
        const ps = spawn('powershell', ['-NoProfile', '-Command', psScript], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        currentAudioProcess = ps
        let psOut = ''
        ps.stdout.on('data', (d: Buffer) => { psOut += d.toString() })
        ps.on('exit', (code) => {
          doResolve(code === 0, `SoundPlayer exit code=${code} ${psOut.slice(0, 80)}`)
        })
        ps.on('error', (err) => {
          doResolve(false, `SoundPlayer error: ${err.message}`)
        })
      })
      ffmpeg.on('error', (err) => {
        // ffmpeg 不可用 → 回退到旧的 PowerShell MediaPlayer（聊胜于无）
        console.warn('[AUDIO] ffmpeg not found, falling back to PowerShell MediaPlayer:', err.message)
        currentAudioProcess = null
        fallbackPSPlay(filePath, resolve)
      })
    } else {
      // macOS / Linux: use afplay / aplay
      const cmd = process.platform === 'darwin' ? 'afplay' : 'aplay'
      const proc = spawn(cmd, [filePath], { stdio: 'ignore', windowsHide: true })
      currentAudioProcess = proc

      let resolved = false
      const doResolve = (success: boolean, reason: string) => {
        if (resolved) return
        resolved = true
        console.log(`[AUDIO] [playAudioFile] ${reason}`)
        if (currentAudioProcess === proc) {
          currentAudioProcess = null
          notifyVoiceStopped()
        }
        resolve(success)
      }

      proc.on('exit', (code) => {
        doResolve(code === 0, `Audio playback process exited, code: ${code}`)
      })
      proc.on('error', (err) => {
        doResolve(false, `Audio playback process error: ${err}`)
      })
    }
  })
}

/** 回退：旧 PowerShell MediaPlayer（无 Dispatcher 时可能无声，但比完全崩溃好） */
function fallbackPSPlay(filePath: string, resolve: (val: boolean) => void) {
  // E13: ffmpeg not bundled, PowerShell fallback may not work reliably
  console.warn('[AUDIO] ffmpeg not available; falling back to PowerShell MediaPlayer (may not produce audio without WPF Dispatcher)')
  const volume = isTtsDucked ? 0.15 : 1.0
  const psScript = `
    Add-Type -AssemblyName presentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    $player.Open('${filePath.replace(/'/g, "''")}')
    $player.Volume = ${volume}
    $player.Play()
    Start-Sleep -Seconds 1
    while ($player.NaturalDuration.HasTimeSpan -eq $false) { Start-Sleep -Milliseconds 100 }
    $duration = $player.NaturalDuration.TimeSpan.TotalSeconds
    Start-Sleep -Seconds ($duration + 0.5)
    $player.Close()
  `
  const ps = spawn('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true })
  currentAudioProcess = ps
  ps.on('exit', (code) => {
    currentAudioProcess = null
    notifyVoiceStopped()
    resolve(code === 0)
  })
  ps.on('error', () => {
    currentAudioProcess = null
    notifyVoiceStopped()
    resolve(false)
  })
}

ipcMain.handle('voice:setDuck', async (_, ducked: boolean) => {
  isTtsDucked = ducked
  console.log(`[AUDIO] [voice:setDuck] Duck state set to: ${ducked}`)
  return true
})

ipcMain.handle('shell:screenshot', async () => {
  // 2026-08-25 界面自检员: 渲染层请求窗口截图(视觉校验), 仅取顶层窗口, 无参数注入面
  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return { ok: false, error: 'no-window' }
    const image = await win.webContents.capturePage()
    return { ok: true, dataUrl: image.toDataURL() }
  } catch (e: any) {
    console.error('[main] shell:screenshot 失败:', e?.message || e)
    return { ok: false, error: String(e?.message || e) }
  }
})

ipcMain.handle('voice:play', async (_, filePath: string) => {
  // T1.13: 复用 file:read-base64 的目录校验 + 敏感文件黑名单,防止播放任意路径
  const check = validateDataDirFile(filePath)
  if (!check.ok) {
    console.error('[voice:play] 拒绝播放:', check.error)
    return false
  }
  return playAudioFile(filePath)
})

ipcMain.handle('voice:stop', async () => {
  stopAudioPlayback()
  return true
})

ipcMain.handle('voice:toggle-pause', async () => {
  // Pause = Stop (PowerShell MediaPlayer does not support cross-process pause)
  // Frontend should display this behavior as “Stop” rather than “Pause”
  stopAudioPlayback()
  return { stopped: true }
})

ipcMain.handle('voice:read-audio', async (_, filePath: string) => {
  try {
    // T1.13: 复用 file:read-base64 的目录校验 + 敏感文件黑名单(含 realpath 双重校验)
    const check = validateDataDirFile(filePath)
    if (!check.ok) {
      return { success: false, error: check.error }
    }

    // 2026-08-14 审计: 加 50MB 上限(与 file:read-base64 一致),
    // 防超大音频文件拖垮 IPC 序列化与内存
    const stats = fs.statSync(filePath)
    if (stats.size > 50 * 1024 * 1024) {
      return { success: false, error: 'File too large, exceeds 50MB' }
    }
    const buffer = fs.readFileSync(filePath)
    return { success: true, data: buffer.toString('base64') }
  } catch (error) {
    return { success: false, error: String(error) }
  }
})

// ── TTS 音频诊断：在渲染进程中执行原生 <audio> 播放测试 ──
ipcMain.handle('voice:diag-tts', async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return { success: false, error: 'No window' }
  try {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const results = [];
        // 环境信息
        results.push('__audioOutputDeviceId=' + (window.__audioOutputDeviceId || '(空)'));
        results.push('__ttsDucked=' + window.__ttsDucked);
        results.push('__ttsAudioCtx.state=' + (window.__ttsAudioCtx?.state || '(不存在)'));

        // 测试1: 最简单原生播放 (不调setSinkId)
        try {
          const audio = new Audio();
          audio.volume = 1.0;
          const url = '/api/voice/tts/stream?text=' + encodeURIComponent('测试语音') + '&voice=zh-CN-XiaoxiaoNeural&provider=edge&speed=1&_refined=true';
          audio.src = url;
          await audio.play();
          results.push('TEST_NATIVE: play() OK');
          await new Promise(r => { audio.onended = r; setTimeout(r, 5000); });
          results.push('TEST_NATIVE: playback complete');
        } catch(e) {
          results.push('TEST_NATIVE FAILED: ' + e.name + ': ' + e.message);
        }

        // 测试2: 带 setSinkId
        try {
          const audio2 = new Audio();
          audio2.volume = 1.0;
          if (window.__audioOutputDeviceId && typeof audio2.setSinkId === 'function') {
            await audio2.setSinkId(window.__audioOutputDeviceId);
            results.push('setSinkId(' + window.__audioOutputDeviceId.substring(0,20) + '...) OK');
          }
          const url2 = '/api/voice/tts/stream?text=' + encodeURIComponent('设备测试') + '&voice=zh-CN-XiaoxiaoNeural&provider=edge&speed=1&_refined=true';
          audio2.src = url2;
          await audio2.play();
          results.push('TEST_SINKID: play() OK');
          await new Promise(r => { audio2.onended = r; setTimeout(r, 5000); });
          results.push('TEST_SINKID: playback complete');
        } catch(e) {
          results.push('TEST_SINKID FAILED: ' + e.name + ': ' + e.message);
        }

        return results.join('\\n');
      })()
    `)
    return { success: true, result }
  } catch (e: any) {
    return { success: false, error: e.message }
  }
})

// Dev 模式：若 AppData 目录权限不足（沙箱/AV 阻止），回退到项目本地临时目录
if (isDev) {
  const defaultUserData = app.getPath('userData')
  const testFile = path.join(defaultUserData, '.write-test')
  try {
    fs.mkdirSync(defaultUserData, { recursive: true })
    fs.writeFileSync(testFile, 'ok')
    fs.unlinkSync(testFile)
  } catch {
    const fallbackDir = path.join(__dirname, '..', '..', '.tmp-userdata')
    console.warn('[main] AppData 目录不可写，回退到本地临时目录:', fallbackDir)
    fs.mkdirSync(fallbackDir, { recursive: true })
    app.setPath('userData', fallbackDir)
  }
}

// Set Electron cache dir to user data dir to avoid permission issues
const electronCacheDir = path.join(app.getPath('userData'), 'Cache')
if (!fs.existsSync(electronCacheDir)) {
  try { fs.mkdirSync(electronCacheDir, { recursive: true }) } catch (err) { console.warn('[main] 缓存目录创建失败:', err instanceof Error ? err.message : String(err)) }
}
app.setPath('cache', electronCacheDir)

// GPU cache dir also set to user data dir to avoid permission issues
app.commandLine.appendSwitch('disk-cache-dir', electronCacheDir)
// Disable GPU shader cache (avoid cache_util_win permission errors)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
// 自动播放策略: 允许 TTS/语音无需用户手势即可播放
// Electron 默认的 autoplay 策略与 Chrome 一致（需要用户交互才能播放音频），
// 但语音助手场景下，AI 回复时用户通常不在点击状态，必须允许自动播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// E9: allow-file-access-from-files is only needed in dev mode for ES module cross-file loading.
// Removed for production builds to reduce attack surface — packaged builds serve from localhost, not file://.
if (isDev) {
  app.commandLine.appendSwitch('allow-file-access-from-files')
}
// E2E 模式: 注入 CDP 调试端口——playwright 经 connectOverCDP 驱动。
// Electron 28 不认路径前 --remote-debugging-port 命令行开关(见 scripts/patch-playwright-electron.js),
// 故用官方 appendSwitch 方式在此注入(仅 E2E 测试模式,生产不暴露调试端口)。
// 2026-08-14: 端口由 CRABPAW_CDP_PORT 指定(cdp-helper 每次随机 9222-9321),
// 避免固定 9222 被前次 Electron TIME_WAIT 残留占用 → devtools bind 失败竞态。
if (process.env.CRABPAW_E2E) {
  const cdpPort = process.env.CRABPAW_CDP_PORT || '9222'
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort)
}

// ── Windows 托盘图标管理 — AppUserModelID ────────────
// 设置唯一的 AppUserModelID 帮助 Windows 通知区域正确管理图标，
// 防止进程退出后托盘图标残留在任务栏（幽灵图标）。
if (process.platform === 'win32') {
  try { app.setAppUserModelId('CrabPaw.CrabPaw') } catch (err) { console.warn('[main] AppUserModelID 设置失败:', err instanceof Error ? err.message : String(err)) }
}

// ── 单实例锁 — 防止多次启动导致多个托盘图标 ────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 已有实例运行时再次启动 → 聚焦已有窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// 2026-08-12(T1.14 TODO 落地): crabpaw-audio 协议——主进程代理音频,渲染层零 token 接触面
// 必须在 app ready 之前注册特权(stream 允许渐进播放, supportFetchAPI 允许 fetch 使用)
protocol.registerSchemesAsPrivileged([
  { scheme: 'crabpaw-audio', privileges: { stream: true, supportFetchAPI: true } },
  // 2026-08-18 filegen 预览修复: local 注册为 standard scheme——iframe 文档导航加载
  // local:// 要求 scheme 为 standard(privileged)，否则 Chromium 在导航层直接拒绝
  // (请求不达 protocol.handle → 预览 iframe 恒空白、frameTree 无子 frame)。
  // 安全仍由 handler 白名单 + filegen iframe sandbox(无 allow-same-origin)兜底。
  { scheme: 'local', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  // 启动崩溃报告器 — 收集渲染进程崩溃堆栈用于诊断
  try {
    const crashDumpsDir = app.getPath('crashDumps')
    console.log('[CRASH] 崩溃转储目录:', crashDumpsDir)
    crashReporter.start({
      productName: 'CrabPaw',
      companyName: 'CrabPaw',
      submitURL: 'https://127.0.0.1', // 不上传，仅本地收集
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
    })
  } catch (e) {
    console.warn('[CRASH] crashReporter 启动失败:', e)
  }

  // 2026-08-12: crabpaw-audio:// 音频代理——校验白名单后带 X-Api-Key 请求本地服务
  // 2026-08-13(P2 修复): 转发 method 与 body——HEAD 探测按 fetch 语义无 body 转发
  // (后端走零成本 HEAD 端点, 避免主路径每次 TTS 双倍合成); GET/HEAD 之外的方法
  // (如 playTTSStream 降级链 POST JSON)读取 request.body 原样转发, 不再静默转 GET。
  protocol.handle('crabpaw-audio', async (request) => {
    const url = new URL(request.url)
    const endpointPath = '/' + url.host + url.pathname + url.search
    if (!isStreamUrlAllowed(endpointPath)) {
      console.error('[crabpaw-audio] Blocked endpoint:', endpointPath)
      return new Response('Forbidden', { status: 403 })
    }
    const token = fs.existsSync(TOKEN_PATH) ? fs.readFileSync(TOKEN_PATH, 'utf-8').trim() : API_TOKEN
    try {
      const method = request.method
      let body: ArrayBuffer | undefined
      if (method !== 'GET' && method !== 'HEAD') {
        const buf = await request.arrayBuffer()
        body = buf.byteLength > 0 ? buf : undefined
      }
      const upstream = await net.fetch(`http://127.0.0.1:${API_PORT}${endpointPath}`, {
        method,
        body,
        headers: { 'X-Api-Key': token, 'X-Electron': 'true' },
      })
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      console.error('[crabpaw-audio] 代理请求失败:', err instanceof Error ? err.message : String(err))
      return new Response('Proxy error', { status: 502 })
    }
  });

  protocol.handle('local', (request) => {
    // 2026-08-17 R2-2 审查修复: 用 URL 解析剥离 ?t= query——live 分屏 src 带 ?t=writeTick
    // 破缓存参数, 裸字符串替换会把 '?t=0' 一并塞进 fs 路径 → statSync ENOENT → iframe 404
    // (先例: 上方 crabpaw-audio handler 用 new URL(request.url) 读 pathname/search)
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch (err) {
      console.error('[local:] URL 解析失败:', request.url, err instanceof Error ? err.message : String(err))
      return new Response('Bad Request: invalid URL', { status: 400 })
    }
    let filePath = parsed.pathname

    if (filePath.startsWith('/') && filePath.length > 2 && filePath.charAt(2) === ':') {
      filePath = filePath.substring(1)
    }
    // 2026-08-18: local 注册 standard scheme 后, Chromium 把 local:///D:/xxx 规范化为
    // host=D(单字符盘符)+pathname 丢盘符——历史 URL 形态(media 面板 img/video 等)需恢复盘符
    if (parsed.host && /^[a-zA-Z]$/.test(parsed.host) && !/^[a-zA-Z]:\//.test(filePath)) {
      filePath = `/${parsed.host.toUpperCase()}:${filePath}`
    }
    // 2026-08-21: 盘符重构产物 '/D:/xxx' 仍带前导斜杠——Windows 下 path.resolve('/D:/x')
    // 把 'D:' 当当前盘符根下的目录（实测 D:\D:\bossagent\...）→ 白名单前缀不匹配 → 403 破图。
    // 剥成 'D:/...' 才是标准盘符形态（上方 3072 的剥离只覆盖形态A: host='' 的情形）。
    // 佐证: FileGenPanel HtmlDevPreview 2026-08-18 用 local://localhost/ 前缀绕同一问题。
    if (filePath.startsWith('/') && filePath.length > 2 && filePath.charAt(2) === ':') {
      filePath = filePath.substring(1)
    }
    // 2026-08-17 final-review: 畸形百分号编码(如 'a%zz')会让 decodeURIComponent 抛
    // URIError——handler 整体抛错 → protocol 以异常告终。包进 try/catch 回 400。
    try {
      filePath = decodeURIComponent(filePath)
    } catch (err) {
      console.warn('[local:] decodeURIComponent 失败(畸形百分号编码):', request.url,
        err instanceof Error ? err.message : String(err))
      return new Response('Bad Request: invalid percent-encoding', { status: 400 })
    }
    
    // S3 fix: 使用 path.normalize + 严格路径比较，防止路径穿越
    // 1. 规范化路径（消除 ..、双斜杠等）
    const resolvedPath = path.normalize(path.resolve(filePath))
    // 2. 检查路径穿越（.. 在 normalize 后仍应在 allowedDir 内）
    if (filePath.includes('..')) {
      console.error('[ERR] Path traversal detected:', filePath)
      return new Response('Forbidden: path traversal not allowed', { status: 403 })
    }
    // 2026-08-14 审计 M10: 敏感文件黑名单(复用 T1.13 SENSITIVE_FILE_NAMES/EXTS)——
    // 即使路径命中媒体子目录,也拒绝 .env/.api_token/config.json/日志等文件
    if (isSensitiveFilePath(resolvedPath)) {
      console.warn('[local:] 敏感文件访问被拒:', resolvedPath)
      return new Response('Forbidden: sensitive file', { status: 403 })
    }
    // 3. 规范化 allowedDirs 并严格比较（使用 path.sep 后缀防止前缀匹配绕过）
    // 2026-08-14 审计 M10: 收窄为媒体子目录,不放行 DATA_DIR 根(最小暴露原则;
    // web-preview 为 MarkdownToHTML 内嵌预览目录,此前由 DATA_DIR 根前缀覆盖)
    const allowedDirs = [
      path.join(DATA_DIR, 'generated-images'),
      path.join(DATA_DIR, 'generated-videos'),
      path.join(DATA_DIR, 'uploads'),
      path.join(DATA_DIR, 'screenshots'),
      path.join(DATA_DIR, 'backups'),
      path.join(DATA_DIR, 'exports'),
      path.join(DATA_DIR, 'tts-output'),
      path.join(DATA_DIR, 'audio'),
      path.join(DATA_DIR, 'web-preview'),
      // 2026-08-17 final-review P2: 补文件生成产物目录——Write/html_generate 默认落盘
      // backend data/workspace(documents) 与 DATA_DIR/workspace(config WORKSPACE_DIR)。
      // 此前 live 分屏 iframe 请求这些路径一律 403（previewUrlFor 只查 DATA_DIR 前缀,
      // 口径比白名单宽 → url 非 null 但 electron 拒绝）。白名单是安全门:
      // 只加产物目录, 不放整个 data 根。
      path.join(DATA_DIR, 'workspace'),
      path.join(BACKEND_CWD, 'data', 'workspace'),
    ]
    const normalizedAllowed = allowedDirs.map(dir => path.normalize(path.resolve(dir)) + path.sep)
    const isAllowed = normalizedAllowed.some(dir => resolvedPath.toLowerCase().startsWith(dir.toLowerCase())) ||
                      normalizedAllowed.some(dir => resolvedPath.toLowerCase() === dir.slice(0, -1).toLowerCase())
    
    if (!isAllowed) {
      console.error('[ERR] Access denied to path:', resolvedPath)
      return new Response('Forbidden: path not allowed', { status: 403 })
    }
    
    // S3 fix: 检查符号链接目标是否仍在允许目录内
    try {
      const realPath = fs.realpathSync(resolvedPath)
      const realAllowed = normalizedAllowed.some(dir => realPath.toLowerCase().startsWith(dir.toLowerCase())) ||
                          normalizedAllowed.some(dir => realPath.toLowerCase() === dir.slice(0, -1).toLowerCase())
      if (!realAllowed) {
        console.error('[ERR] Symlink escape detected:', realPath)
        return new Response('Forbidden: symlink escape', { status: 403 })
      }
      // 2026-08-14 审计 M10: 符号链接真实目标同样过敏感文件黑名单
      if (isSensitiveFilePath(realPath)) {
        console.warn('[local:] 符号链接目标为敏感文件,访问被拒:', realPath)
        return new Response('Forbidden: sensitive file', { status: 403 })
      }
    } catch (err) {
      // 文件不存在，后续 statSync 会处理
      console.warn('[local:] realpath 解析失败:', err instanceof Error ? err.message : String(err))
    }
    
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) {
        return new Response('Not a file', { status: 400 })
      }
      let mimeType = getMimeType(filePath)
      // 2026-08-18 filegen 预览修复: T1.19 对 .html 以 octet-stream 返回(防 local: 加载
      // 本地 HTML 在应用上下文执行脚本)→ 面板分屏预览 iframe 拿到二进制流恒空白。
      // 此处受控放行: 仅带 ?html=1 的请求(FileGenPanel HtmlDevPreview 专用; iframe
      // sandbox="allow-scripts" 无 allow-same-origin, 本地 HTML 脚本在 opaque origin
      // 运行触不到应用上下文——安全由 sandbox 兜底)返回 text/html; 其余消费方
      // (window.open 等)维持 octet-stream。
      const ext = path.extname(filePath).toLowerCase()
      const isHtmlPreview = (ext === '.html' || ext === '.htm') && parsed.searchParams.get('html') === '1'
      if (isHtmlPreview) mimeType = 'text/html; charset=utf-8'
      const previewHeaders: Record<string, string> = isHtmlPreview ? {
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline' 'self' local:; style-src 'unsafe-inline' 'self' local:; img-src * data: blob:; media-src *; connect-src * local: http: https:; font-src * data:",
        'X-Content-Type-Options': 'nosniff',
      } : {}
      const fileSize = stat.size
      
      const rangeHeader = request.headers.get('range')
      if (rangeHeader) {
        const matches = /bytes=(\d+)-(\d*)/.exec(rangeHeader)
        if (matches) {
          const start = parseInt(matches[1], 10)
          const end = matches[2] ? parseInt(matches[2], 10) : fileSize - 1
          const chunkSize = end - start + 1
          
          if (start >= fileSize || end >= fileSize) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: { 'Content-Range': `bytes */${fileSize}` }
            })
          }
          
          const fileStream = fs.createReadStream(filePath, { start, end })
          
          return new Response(fileStream as any, {
            status: 206,
            headers: {
              'Content-Type': mimeType,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'no-cache',
              ...previewHeaders
            }
          })
        }
      }
      
      const fileStream = fs.createReadStream(filePath)
      
      return new Response(fileStream as any, {
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          ...previewHeaders
        }
      })
    } catch (error) {
      console.error('[ERR] Read local file failed:', error)
      return new Response('File not found', { status: 404 })
    }
  })
  
  // T1.21: CSP 注入须在窗口创建前注册(onHeadersReceived 影响后续所有请求)
  setupCspInjection()
  // 2026-08-16: B站视频直链(https://*.bilivideo.com)防盗链——CDN 校验 Referer,
  // 渲染进程发出的请求 Referer 是本地页面源(dev localhost / prod file://) → 403。
  // 主进程对 bilivideo 域名请求统一注入 bilibili.com Referer(官方播放页同款头)。
  setupBiliRefererInjection()

  // E1: Ensure data dir and save credentials BEFORE createWindow so DATA_DIR exists
  ensureDataDir()
  saveApiCredentials()
  createWindow()
  createTray()
  startLogRotation()

  // ── 唤醒词体系初始化 ──
  try {
    const { initWake, setWakeKeyword } = require('../kws')
    const userDataDir = app.getPath('userData')
    // F1: 打包后模型随 extraResources 放置(to 相对 resources 目录),须用 process.resourcesPath 定位。
    // 若沿用 __dirname 相对路径,asar 打包后 __dirname=<app>/resources/app.asar/dist-electron/main,
    // ../../resources 会解析进 app.asar 内部,取不到 extraResources 产物 → 唤醒词发行版失效。
    // dev 下 __dirname=gui/dist-electron/main,'../../resources/kws-model' 即 gui/resources/kws-model。
    const modelDir = isDev
      ? path.join(__dirname, '../../resources/kws-model')
      : path.join(process.resourcesPath, 'resources', 'kws-model')
    initWake({
      userDataDir,
      modelDir,
      getWakeWord: () => {
        try {
          if (fs.existsSync(CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
            return (cfg.wakeWord as string | string[]) || '小螃蟹'
          }
        } catch (err) { console.warn('[wake] 唤醒词配置读取失败,使用默认词:', err instanceof Error ? err.message : String(err)) }
        return '小螃蟹'
      },
    })
    ipcMain.handle('wake:set-keyword', (_e, word: string | string[]) => {
      // 2026-08-06: 支持数组（多唤醒词）。空/单字符串时按原逻辑。
      const normalized = Array.isArray(word) ? word.filter(w => w && typeof w === 'string') : (word ? [String(word)] : [])
      const result = setWakeKeyword(app.getPath('userData'), normalized)
      if (result.ok) {
        // 持久化到配置文件（存数组）
        const cfg = readJsonFile(CONFIG_PATH) || {}
        cfg.wakeWord = normalized
        const writeResult = writeJsonFile(CONFIG_PATH, cfg)
        if (!writeResult.success) {
          console.error('[wake] 配置持久化失败:', writeResult.error)
        }
      }
      return result
    })
  } catch (err: any) {
    console.error('[wake] 唤醒模块初始化失败(忽略):', err?.message || err)
  }

  // If already configured, auto-start service AFTER renderer is ready
  // 2026-08-03: 改为渲染就绪握手——前端 SplashScreen 订阅 onProgress 后发
  // 'splash:renderer-ready'，主进程收到才开始发进度事件。此前 did-finish-load+500ms
  // 固定延迟，dev 模式 vite 加载 React 常需 1-3s → 订阅未注册事件全丢 → 五项永远"等待中"。
  // 2026-08-31 深度检查修复(P2): 握手从 ipcMain.once 改为持久 on——once 首启后即消费,
  // 崩溃恢复/window:restart 重建的窗口重发握手无人应答, 闪屏只能挂 15s 兜底。
  // 触发逻辑收敛到 runSplashStartSequence(幂等, 已启动过则按历史重放);
  // did-finish-load 的 8s 兜底已移入 createWindow 逐窗口挂载。
  ipcMain.on('splash:renderer-ready', () => {
    if (splashFallbackTimer) { clearTimeout(splashFallbackTimer); splashFallbackTimer = null }
    void runSplashStartSequence()
  })
  
  setTimeout(() => {
    autoCheckUpdate()
  }, 3000)
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

// ── CSP 注入 ─────────────────────────────────────────────
// T1.21: 对 file://(打包入口)与 http://localhost:* 响应注入 CSP。
// 决策说明:
// 1) index.html 首屏内联 theme 脚本(防主题闪烁)是本项目必需的内联脚本,且本次修复
//    范围仅限 electron/,无法将其外置或加 nonce——故对 file:// 采用
//    script-src 'self' + 'sha256-<脚本hash>' 精确放行该脚本(运行时从 dist/index.html
//    提取计算,与文件内容自动同步),不引入 unsafe-inline。
// 2) 仅对打包入口 index.html 文档注入(file:// 下其他页面如 wake-probe.html 不受影响,
//    其整页脚本为内联,注入会阻断唤醒词采集)。
// 3) dev 模式(Vite)不注入: @vitejs/plugin-react 会向 index.html 注入内联
//    react-refresh preamble,严格 script-src 会阻断它导致 dev 无法运行。
// 4) img-src/media-src 显式放行 http://localhost:*——生产打包版 file:// 页面直连
//    后端加载图片(FileBrowser 缩略图)与 TTS 音频(<audio> src=localhost:38767)。
// 5) frame-src 放行 http/https——web-preview 场景卡以 sandbox(无 allow-same-origin)
//    iframe 内嵌后端生成的预览页(既有功能,沙箱已隔离)。
// 6) style-src 保留 'unsafe-inline'(React 行内 style 属性)并放行 Google Fonts
//    @import;font-src 放行 fonts.gstatic.com(维持现有字体渲染,不回归)。
const CSP_HTTP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* https://*.hdslb.com https://*.bilibili.com https://*.basemaps.cartocdn.com https://*.is.autonavi.com",
  "media-src 'self' blob: data: http://localhost:* http://127.0.0.1:* https://*.bilivideo.com https://*.bilibili.com",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'self' http://localhost:* http://127.0.0.1:* https: http:",
  "base-uri 'self'",
].join('; ')

/** 从 dist/index.html 提取首屏内联 theme 脚本内容,计算 sha256(CSP hash 格式)。
 *  CSP 加固:只匹配第一个无 src 属性的内联 script(带 src 的外链脚本内容不可控,不参与 hash;
 *  index.html 若含多个内联 script,旧实现取第一个会抓错,现逐标签过滤) */
function computeThemeScriptHash(): string | null {
  const indexPath = path.join(__dirname, '../../dist/index.html')
  if (!fs.existsSync(indexPath)) return null
  try {
    const html = fs.readFileSync(indexPath, 'utf-8')
    const scriptTags = html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []
    for (const tag of scriptTags) {
      if (/\bsrc\s*=/.test(tag)) continue
      const m = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(tag)
      if (m && m[1].trim()) {
        return crypto.createHash('sha256').update(m[1]).digest('base64')
      }
    }
    return null
  } catch (err) {
    console.error('[CSP] theme 脚本 hash 计算失败(将不注入 file:// CSP):', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** 2026-08-16: B站 CDN 防盗链 Referer 注入——bilivideo.com 直链必须携带
 * bilibili.com Referer, 否则 403; 渲染进程无法自定义媒体请求头, 主进程统一注入。
 * 注: 必须在窗口创建前注册(onBeforeSendHeaders 影响后续所有请求)。 */
function setupBiliRefererInjection() {
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      try {
        if (/^https:\/\/[^/]*\.bilivideo\.com\//.test(details.url)) {
          callback({ requestHeaders: { ...details.requestHeaders, Referer: 'https://www.bilibili.com/' } })
        } else {
          callback({ requestHeaders: details.requestHeaders })
        }
      } catch (err) {
        console.warn('[webRequest] bilivideo Referer 注入异常:', err instanceof Error ? err.message : String(err))
        callback({ requestHeaders: details.requestHeaders })
      }
    })
  } catch (err) {
    console.error('[webRequest] bilivideo Referer 注入注册失败:', err instanceof Error ? err.message : String(err))
  }
}

function setupCspInjection() {
  // dev 模式不注入(见上方决策说明 3)
  if (isDev) {
    console.log('[CSP] dev 模式不注入 CSP(Vite 内联 react-refresh preamble 兼容)')
    return
  }
  const themeHash = computeThemeScriptHash()
  // file:// 版策略: script-src 用 'self' + theme 脚本 sha256 精确放行(不引入 unsafe-inline)
  const cspFile = themeHash
    ? [
        "default-src 'self'",
        `script-src 'self' 'sha256-${themeHash}'`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        // 2026-08-16: 媒体卡需 https 外部源——B站视频直链(bilivideo)与封面图(hdslb/bilibili),
        // 缺则打包版视频黑屏/缩略图不加载(dev 不注入 CSP 不受影响)
        "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:* https://*.hdslb.com https://*.bilibili.com https://*.basemaps.cartocdn.com https://*.is.autonavi.com",
        "media-src 'self' blob: data: http://localhost:* http://127.0.0.1:* https://*.bilivideo.com https://*.bilibili.com",
        "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*",
        "object-src 'none'",
        "frame-src 'self' http://localhost:* http://127.0.0.1:* https: http:",
        "base-uri 'self'",
      ].join('; ')
    : null

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      const u = new URL(details.url)
      let csp: string | null = null
      if (u.protocol === 'file:') {
        // 仅打包入口 index.html 文档注入;其他 file: 页面(wake-probe.html 等)不注入
        if (cspFile && isAppIndexHtmlPath(u.pathname)) {
          csp = cspFile
        }
      } else if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
        csp = CSP_HTTP
      }
      if (csp) {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
      } else {
        callback({ responseHeaders: details.responseHeaders })
      }
    } catch (err) {
      console.warn('[CSP] 注入处理异常:', err instanceof Error ? err.message : String(err))
      callback({ responseHeaders: details.responseHeaders })
    }
  })
}

/** 判断 file: pathname 是否为打包入口 dist/index.html(处理 /D:/x 形式的 Windows 路径) */
function isAppIndexHtmlPath(pathname: string): boolean {
  try {
    let filePart = decodeURIComponent(pathname)
    if (/^\/[A-Za-z]:/.test(filePart)) filePart = filePart.slice(1)
    const candidate = path.normalize(filePart.replace(/\//g, path.sep)).toLowerCase()
    const indexPath = path.normalize(path.join(__dirname, '../../dist/index.html')).toLowerCase()
    return candidate === indexPath
  } catch {
    return false
  }
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.css': 'text/css',
    // T1.19: .html / .js 不提供 mime 映射——local: 协议以 octet-stream 返回,
    // 防止通过 local: 直接加载本地 HTML/JS 在应用上下文执行脚本
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

// ── 系统托盘 ─────────────────────────────────────────────
// Windows 托盘幽灵图标：tray.destroy() 不立即从通知区域移除图标，
// 此时 new Tray() 会创建第二个图标，旧图标残留成"幽灵"（悬停才消失）。
// 解决方案（已在 createTray 中实现）：只创建一次，仅更新菜单，永不 destroy+recreate。
let trayUpdateTimer: ReturnType<typeof setInterval> | null = null

/** 构建托盘上下文菜单 */
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示 CrabPaw',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus() }
        else { createWindow() }
      },
    },
    { type: 'separator' },
    {
      label: `服务状态: ${serviceReady ? '● 运行中' : '○ 已停止'}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '飞书: ' + (larkBridge && !larkBridge.killed ? '● 已连接' : '—'), enabled: false },
    { label: '企业微信: ' + (wecomBridge && !wecomBridge.killed ? '● 已连接' : '—'), enabled: false },
    { type: 'separator' },
    {
      label: '退出 CrabPaw',
      click: () => {
        closeToTray = false
        stopServices()
        if (tray) { try { if (!tray.isDestroyed?.()) tray.destroy() } catch (err) { console.warn('[TRAY] 托盘销毁失败:', err instanceof Error ? err.message : String(err)) }; tray = null }
        app.quit()
      },
    },
  ])
}

/** 仅更新托盘菜单和提示（不重建托盘） */
function updateTrayMenu() {
  if (!tray || tray.isDestroyed?.()) return
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip('CrabPaw' + (serviceReady ? ' — 运行中' : '') +
    (larkBridge ? ' | 飞书' : '') + (wecomBridge ? ' | 企微' : ''))
}

/**
 * Windows 专用：刷新系统托盘通知区域，清除孤儿图标。
 *
 * 当进程被强制杀死（Stop-Process / 任务管理器 / 崩溃）时，before-quit 不会触发，
 * tray.destroy() 没有执行，Windows 通知区域会残留"幽灵图标"（鼠标悬停才消失）。
 *
 * 方案一：发送 WM_SETTINGCHANGE (0x001A) 到 Shell_TrayWnd → TrayNotifyWnd，
 * Explorer 会重新枚举所有托盘图标，检查属主进程是否存活，移除孤儿。
 * (实测部分 Win10/11 无效——保留为尽力而为的补充)
 *
 * 方案二(可靠)：异常退出检测 + 重启 Explorer——before-quit 写正常退出标志；
 * 下次启动若标志缺失(上次被强杀)→ 重启 Explorer(托盘图标由 Explorer 全量重建,
 * 幽灵必然清除)。仅在异常退出后执行,正常启动不打扰。
 */
function refreshWindowsTrayIcons() {
  const { execFile } = require('child_process')
  const os = require('os')
  const pathMod = require('path')
  const fsMod = require('fs')

  // PowerShell 脚本：通过 P/Invoke 发送 WM_SETTINGCHANGE 到系统托盘
  // 使用普通多行单引号字符串（非 here-string），避免 @'...'@ 在文件写入时被破坏
  // 2026-08-01: 双目标发送（Shell_TrayWnd + TrayNotifyWnd）+ 双次（间隔 800ms），
  // 单目标发送在部分 Windows 10/11 版本上 Explorer 会忽略，导致幽灵图标清理失效
  const psScript = `$sig = '
[DllImport("user32.dll", SetLastError=true)]
public static extern IntPtr FindWindow(string c, string w);
[DllImport("user32.dll", SetLastError=true)]
public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string c1, string c2);
[DllImport("user32.dll", SetLastError=true)]
public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
'
$t = Add-Type -MemberDefinition $sig -Name "TR" -Namespace "W32" -PassThru
function Refresh-Tray {
  $tray = $t::FindWindow("Shell_TrayWnd", $null)
  if ($tray -ne [IntPtr]::Zero) { $t::SendMessage($tray, 0x001A, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
  $notify = $t::FindWindowEx($tray, [IntPtr]::Zero, "TrayNotifyWnd", $null)
  if ($notify -ne [IntPtr]::Zero) { $t::SendMessage($notify, 0x001A, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
}
Refresh-Tray
Start-Sleep -Milliseconds 800
Refresh-Tray
`

  const tmpFile = pathMod.join(os.tmpdir(), `crabpaw_tray_refresh_${Date.now()}.ps1`)
  try {
    fsMod.writeFileSync(tmpFile, psScript, 'utf-8')
    // 用 execFile 而非 exec，避免 cmd.exe 对命令的二次解析
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { timeout: 5000, windowsHide: true },
      (err: Error | null) => {
        try { fsMod.unlinkSync(tmpFile) } catch (err: any) { console.error('[tray] 临时文件清理失败:', err?.message || err) }
    if (err) {
          console.log('[TRAY] Tray refresh skipped:', err.message)
        } else {
          console.log('[TRAY] System tray refreshed (ghost icons cleaned)')
        }
      }
    )
  } catch (e) {
    console.log('[TRAY] Tray refresh skipped:', (e as Error).message)
  }
}

// 2026-08-04: 托盘幽灵图标可靠清理——正常退出标志文件
// 路径: userData/.crabpaw_exited_normally
const TRAY_EXIT_FLAG_FILE = 'crabpaw_exited_normally.flag'
function getTrayExitFlagPath() {
  try { return require('path').join(app.getPath('userData'), TRAY_EXIT_FLAG_FILE) } catch (err) { console.warn('[TRAY] 退出标志路径获取失败:', err instanceof Error ? err.message : String(err)); return '' }
}

/**
 * 2026-08-04: 检测上次是否异常退出(被强杀)→ 重启 Explorer 清幽灵图标。
 * WM_SETTINGCHANGE 对托盘无效(实测),重启 Explorer 是唯一可靠清理——
 * 托盘图标由 Explorer 全量重建,幽灵必然消失。
 * 仅在上次异常退出后执行(标志文件缺失),正常启动不打扰。
 */
function cleanupGhostTrayIconsIfNeeded() {
  if (process.platform !== 'win32') return
  const flagPath = getTrayExitFlagPath()
  if (!flagPath) return
  const fsMod = require('fs')
  const pathMod = require('path')
  const { execFile } = require('child_process')
  const existed = fsMod.existsSync(flagPath)
  try { fsMod.unlinkSync(flagPath) } catch (err) { console.warn('[TRAY] 退出标志清理失败:', err instanceof Error ? err.message : String(err)) }
  if (existed) {
    // 上次正常退出 → 无需清理
    console.log('[TRAY] 上次正常退出,无需幽灵清理')
    return
  }
  // R6: 幽灵托盘清理不再重启整个 Explorer——旧实现 Stop-Process explorer + Start-Process,
  // 副作用是 Windows 会恢复崩溃前资源管理器里打开的文件夹窗口(用户看到"启动打开了硬盘目录"),
  // 且成本远超一个幽灵图标的价值。改为温和刷新系统托盘缓存(隐藏托盘进程重启),不清窗口。
  console.warn('[TRAY] 检测到上次异常退出,温和刷新托盘清理幽灵图标(不重启 Explorer)…')
  const psScript = '$p = Get-Process explorer -ErrorAction SilentlyContinue; ' +
    'if ($p) { ' +
    'Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition "public static extern void SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);"; ' +
    '[Win32.NativeMethods]::SystemParametersInfo(0x0040, 0, [IntPtr]::Zero, 0x01) | Out-Null }'
  const tmpFile = pathMod.join(require('os').tmpdir(), `crabpaw_tray_refresh_${Date.now()}.ps1`)
  try {
    fsMod.writeFileSync(tmpFile, psScript, 'utf-8')
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { timeout: 10000, windowsHide: true },
      (err: Error | null) => {
        try { fsMod.unlinkSync(tmpFile) } catch (unlinkErr) { console.warn('[TRAY] 临时脚本清理失败:', unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)) }
        if (err) console.log('[TRAY] 托盘刷新失败(忽略):', err.message)
        else console.log('[TRAY] 系统托盘已刷新,幽灵图标清理完成')
      })
  } catch (e) {
    console.log('[TRAY] 托盘刷新跳过:', (e as Error).message)
  }
}

function createTray() {
  // 幂等：如果托盘已存在且未被销毁，只更新菜单和提示
  if (tray && !tray.isDestroyed?.()) {
    updateTrayMenu()
    console.log('[TRAY] Tray already exists, updated menu')
    return
  }

  if (isCreatingTray) return
  isCreatingTray = true

  // Windows: 刷新系统托盘通知区域，清除上一次进程被强制关闭留下的幽灵图标
  // 2026-08-04: WM_SETTINGCHANGE 实测无效(保留为补充);可靠清理走
  // cleanupGhostTrayIconsIfNeeded(异常退出检测 + 重启 Explorer)
  if (process.platform === 'win32') {
    refreshWindowsTrayIcons()
    setTimeout(() => refreshWindowsTrayIcons(), 2000)
    setTimeout(() => refreshWindowsTrayIcons(), 6000)
    cleanupGhostTrayIconsIfNeeded()
  }

  try {
    // 清理旧定时器
    if (trayUpdateTimer) {
      clearInterval(trayUpdateTimer)
      trayUpdateTimer = null
    }

    function makeFallbackIcon(size: number) {
      const buf = Buffer.alloc(size * size * 4);
      const isWin = process.platform === 'win32';
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - size / 2 + 0.5, dy = y - size / 2 + 0.5;
          const i = (y * size + x) * 4;
          if (Math.sqrt(dx*dx + dy*dy) < size / 2 - 1) {
            // RGBA color: R=0xea, G=0x58, B=0x0c
            if (isWin) {
              // Windows expects BGRA: swap R and B
              buf[i]=0x0c; buf[i+1]=0x58; buf[i+2]=0xea; buf[i+3]=255;
            } else {
              buf[i]=0xea; buf[i+1]=0x58; buf[i+2]=0x0c; buf[i+3]=255;
            }
          } else {
            buf[i]=0; buf[i+1]=0; buf[i+2]=0; buf[i+3]=0;
          }
        }
      }
      return nativeImage.createFromBuffer(buf, { width: size, height: size });
    }

    const iconSize = 16;
    let trayIcon = null;

    const possibleIconPaths = [
      path.join(__dirname, '../../build/icons/win/icon.ico'),
      path.join(process.resourcesPath, 'build/icons/win/icon.ico'),
      path.join(app.getAppPath(), 'build/icons/win/icon.ico'),
      path.join(__dirname, 'icon.ico'),
    ];

    for (const iconPath of possibleIconPaths) {
      try {
        if (fs.existsSync(iconPath)) {
          trayIcon = nativeImage.createFromPath(iconPath).resize({ width: iconSize, height: iconSize });
          console.log('[TRAY] Using icon:', iconPath);
          break;
        }
      } catch (e) { console.warn('[TRAY] 图标加载失败:', iconPath, e instanceof Error ? e.message : String(e)) }
    }

    if (!trayIcon) {
      trayIcon = makeFallbackIcon(iconSize);
      console.log('[TRAY] Using fallback icon');
    }

    tray = new Tray(trayIcon);
    console.log('[TRAY] Tray created successfully')

    // 设置初始菜单和提示
    tray.setContextMenu(buildTrayMenu())
    tray.setToolTip('CrabPaw' + (serviceReady ? ' — 运行中' : ''))

    // 双击托盘图标 = 显示窗口
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      } else {
        createWindow()
      }
    })

    // 定期更新托盘菜单中的服务状态（只更新，不重建）
    trayUpdateTimer = setInterval(updateTrayMenu, 10000)
  } catch (e) {
    console.error('[TRAY] Error creating tray:', e)
    tray = null
  } finally {
    isCreatingTray = false
  }
}

app.on('window-all-closed', () => {
  // 安全兜底：如果托盘已销毁或用户明确不缩托盘，则退出
  if (!closeToTray || (tray && tray.isDestroyed?.())) {
    stopServices()
    app.quit()
  } else if (!tray) {
    // 没有托盘、没有窗口 → 无法再交互的僵尸状态
    // 需要退出以防单实例锁阻止重启动
    stopServices()
    app.quit()
  }
  // 正常 tray 模式：窗口关闭只是隐藏，保持运行
})

app.on('before-quit', () => {
  if (sharedLogManager) { sharedLogManager.shutdown(); sharedLogManager = null }
  appIsQuitting = true

  // 2026-08-04: 正常退出写标志——下次启动据此判断"上次是否被强杀"，
  // 决定是否需要重启 Explorer 清理幽灵托盘图标
  try {
    const flagPath = getTrayExitFlagPath()
    if (flagPath) require('fs').writeFileSync(flagPath, String(Date.now()), 'utf-8')
  } catch (e) { console.warn('[TRAY] 正常退出标志写入失败:', (e as Error).message) }

  // 先销毁托盘图标，再停止服务。
  // Windows 上必须显式销毁托盘，否则 Explorer 可能残留图标（幽灵图标）
  if (tray) {
    if (process.platform === 'win32') {
      // 2026-08-01: destroy 前刷新系统托盘——子进程独立于主进程存活，
      // 主进程退出后 PowerShell 仍会完成清理（WM_SETTINGCHANGE 让 Explorer 移除图标）
      try { refreshWindowsTrayIcons() } catch (err) { console.warn('[TRAY] 托盘刷新失败:', err instanceof Error ? err.message : String(err)) }
      // Windows 技巧：先设置空白图标让 Explorer 移除旧图标
      try { tray.setImage(nativeImage.createEmpty()) } catch (err) { console.warn('[TRAY] 空白图标设置失败:', err instanceof Error ? err.message : String(err)) }
    }
    try { if (!tray.isDestroyed?.()) tray.destroy() } catch (err) { console.warn('[TRAY] 退出时托盘销毁失败:', err instanceof Error ? err.message : String(err)) }
    tray = null
  }

  stopServices()
})
