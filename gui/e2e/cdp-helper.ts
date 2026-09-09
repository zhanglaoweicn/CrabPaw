/**
 * CDP 模式 Electron E2E 启动 helper（2026-08-14）
 *
 * 背景: playwright 的 `_electron.launch` 依赖 `-r loader.js` preload 注入,
 * 但 Electron 28 遇到 `-r` 自动降级 ELECTRON_RUN_AS_NODE(process.type undefined,
 * require('electron') 返回路径字符串)→ loader 无法初始化,结构性不兼容。
 *
 * 方案(与 electron/main/index.ts 的 CRABPAW_E2E CDP 注入配套):
 *   - 直接 spawn electron.exe(不带 -r),主进程在 CRABPAW_E2E 时
 *     appendSwitch('remote-debugging-port', '9222')(官方方式)
 *   - playwright 用 chromium.connectOverCDP 连接 9222 端口驱动
 *
 * 用法:
 *   import { launchCdpApp, getCdpPage, waitForService } from './cdp-helper'
 */
import { chromium, expect, Page, Browser } from '@playwright/test'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import http from 'http'

// 2026-08-14: 每次启动随机端口(9222-9321)——固定 9222 会被前次 Electron
// TIME_WAIT 残留占用导致 devtools bind 失败;主进程从 CRABPAW_CDP_PORT 读。
export const CDP_PORT = 9222 + Math.floor(Math.random() * 100)
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`

const ELECTRON_EXE = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')

function waitForCdp(port: number, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        retry()
      })
      req.on('error', retry)
      req.setTimeout(3000, () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error(`CDP 端口 ${port} 未就绪(超时 ${timeoutMs}ms)`))
      setTimeout(check, 500)
    }
    check()
  })
}

/** 检查后端 38767 是否就绪（任何响应含 401 都算活着） */
function checkBackend(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:38767/api/identity', (res) => {
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => { req.destroy(); resolve(false) })
  })
}

/** 启动 Electron(CDP 模式),返回 electron 子进程 + 连接的 Browser */
export async function launchCdpApp(options?: { env?: Record<string, string> }): Promise<{ proc: ChildProcess; browser: Browser }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'development',
    CRABPAW_E2E: '1',
    ...(options?.env || {}),
  }
  // 2026-08-14: 必须删除 ELECTRON_RUN_AS_NODE——宿主环境(Claude Code)全局注入=1,
  // 强制 Electron 以纯 Node 模式运行(require('electron') 返回路径字符串,app undefined)。
  // Electron 按"变量存在"判断(空字符串/0 均算 set),只能整键删除。
  delete env.ELECTRON_RUN_AS_NODE
  // 默认连 Vite dev server(加载最新代码);未启动时回退 dist 构建
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
  if (devServerUrl) env.VITE_DEV_SERVER_URL = devServerUrl
  // 动态 CDP 端口——每次启动随机,主进程经 CRABPAW_CDP_PORT 读取
  env.CRABPAW_CDP_PORT = String(CDP_PORT)
  const proc = spawn(ELECTRON_EXE, [path.resolve(__dirname, '..')], { env, stdio: 'pipe' })
  proc.stdout?.on('data', () => { /* 忽略——Electron 日志混杂 */ })
  proc.stderr?.on('data', (d) => {
    const s = String(d)
    if (!s.includes('DeprecationWarning')) console.error('[electron]', s.trim().slice(0, 300))
  })

  await waitForCdp(CDP_PORT)
  // 等后端就绪(VoiceShell 挂载即调 service:start,主进程 dev 模式等外部后端最多 60s;
  // 后端未就绪则主进程报 "Backend not running in dev mode"。此处先行等待避免竞态)
  const backendReady = await checkBackend()
  if (!backendReady) {
    // 提示但不阻塞——主进程 60s 等待窗口内后端可能随后就绪
    console.warn('[cdp-helper] 后端 38767 未就绪——若 service:start 失败请先启动后端(npm run dev)')
  }
  const browser = await chromium.connectOverCDP(CDP_URL)
  return { proc, browser }
}

/** 获取主窗口页面(含 #root 的窗口——KWS wake-probe 等隐藏窗无 #root) */
export async function getCdpPage(browser: Browser, timeoutMs = 30000): Promise<Page> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const contexts = browser.contexts()
    for (const ctx of contexts) {
      for (const page of ctx.pages()) {
        if (page.url().startsWith('devtools://')) continue
        // 2026-08-14: 过滤隐藏窗——只认含 #root 的 React 主窗口
        const hasRoot = await page.evaluate(() => !!document.querySelector('#root')).catch(() => false)
        if (hasRoot) return page
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('未找到主窗口页面(超时)')
}

/** 等待 React 应用挂载 */
export async function waitForService(page: Page, timeoutMs = 30000): Promise<void> {
  await page.waitForSelector('#root', { timeout: timeoutMs })
  await page.waitForFunction(() => {
    const root = document.querySelector('#root')
    return root && root.textContent && root.textContent.length > 0
  }, { timeout: timeoutMs })
}

/** 关闭: 先关 browser 连接,再杀 electron 进程 */
export async function closeCdpApp(browser: Browser, proc: ChildProcess): Promise<void> {
  try { await browser.close() } catch { /* 忽略 */ }
  try { proc.kill() } catch { /* 忽略 */ }
}
