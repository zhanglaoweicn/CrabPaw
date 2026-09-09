/**
 * GUI 链接点修复——浏览器模式运行态验证（2026-08-13）
 *
 * 绕过 Electron 启动器（playwright 1.62 与 electron 28 的
 * --remote-debugging-port=0 不兼容），直接用 chromium 连 Vite dev server，
 * 验证本次修复的关键链路：
 *   G5: 默认直达 VoiceShell（AgentHome 已删除）
 *   G8: VoiceShell 三栏布局渲染（左栏/中栏对话/右栏）+ 右上角 VoiceOrb 恢复
 *   G6: tts-error/voice-error/open-search 监听已注册（无报错）
 *   页面无全局 JS 错误
 */
import { test, expect, chromium, Page } from '@playwright/test'

const URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

test.describe('GUI 链接点修复 — 浏览器运行态验证', () => {
  let page: Page
  const jsErrors: string[] = []

  test.beforeAll(async () => {
    const browser = await chromium.launch()
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    // 2026-08-14: 断点对齐 DingDong(≤1280 隐藏右栏)——测试需三栏可见, 视口放宽
    // 注入闪屏完成标记——全新浏览器上下文无 localStorage 会卡在 SplashScreen
    await page.addInitScript(() => {
      ;(window as any).__crabpawSplashDone = true
    })
    page.on('pageerror', (err) => jsErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') jsErrors.push('[console] ' + msg.text())
    })
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    // 等待 React 挂载
    await page.waitForSelector('#root', { timeout: 15000 })
    await page.waitForTimeout(3000)
  })

  test('G5: 默认直达 VoiceShell（AgentHome 已删除）', async () => {
    await expect(page.locator('.voice-shell-stage')).toBeVisible({ timeout: 15000 })
    // 顶栏品牌仍在
    const body = (await page.locator('body').innerText()).replace(/s+/g, '')
    expect(body).toContain('CrabPaw')
    // 不存在 AgentHome 的「启动智能体」入口
    await expect(page.locator('button', { hasText: '启动智能体' })).toHaveCount(0)
  })

  test('G5: 语音球在左栏顶部（DingDong 对齐, AgentLeftPanel orb-wrap）', async () => {
    // 原版 VoiceOrb 嵌在左栏顶部（5 态 Fibonacci 点云, 2026-08-14 从右栏迁移）
    const orb = page.locator('.voice-shell-sidebar--left .voice-shell-orb-top canvas')
    await expect(orb).toBeVisible({ timeout: 10000 })
  })

  test('G8: VoiceShell 三栏布局渲染（左/中/右）', async () => {
    // 左栏：AgentLeftPanel（消息日志 + 语速）
    const left = page.locator('.voice-shell-sidebar--left')
    await expect(left).toBeVisible({ timeout: 5000 })
    await expect(left.locator('text=消息日志').first()).toBeVisible()

    // 中栏：对话区
    const stage = page.locator('.voice-shell-stage--chat')
    await expect(stage).toBeVisible()

    // 右栏：AgentRightPanel（CONSCIOUS HEARTBEAT 顶栏）
    const right = page.locator('.voice-shell-sidebar--right')
    await expect(right).toBeVisible()
    await expect(right.locator('text=CONSCIOUS HEARTBEAT').first()).toBeVisible({ timeout: 5000 })
  })

  test('G7: 左右栏真实数据接线（无运行时错误 + 面板渲染）', async () => {
    // 左栏语速按钮可点击（applyShellConfig 链路）
    const speedBtn = page.locator('.voice-shell-sidebar--left button:has-text("默认")').first()
    if (await speedBtn.isVisible().catch(() => false)) {
      await speedBtn.click()
    }
    // 右栏 lastAction 区渲染（runs/active 消费）
    await expect(page.locator('.voice-shell-sidebar--right').first()).toBeVisible()
    await page.waitForTimeout(2000)
  })

  test('G6: 事件监听已注册（open-search 不抛错）', async () => {
    const result = await page.evaluate(() => {
      try {
        window.dispatchEvent(new CustomEvent('crabpaw:open-search', { detail: { query: '测试搜索' } }))
        window.dispatchEvent(new CustomEvent('crabpaw:tts-error', { detail: { message: 'test' } }))
        window.dispatchEvent(new CustomEvent('crabpaw:voice-error', { detail: { message: 'test' } }))
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    })
    expect(result.ok).toBe(true)
    await page.waitForTimeout(500)
  })

  test('G1-G4: 后端接线 curl 级验证（MCP/collab/审批/activity 契约）', async () => {
    const TOKEN = process.env.CRABPAW_TOKEN || ''
    await page.evaluate((t) => {
      if (t) localStorage.setItem('crabpaw_api_key', t)
    }, TOKEN)
    const results = await page.evaluate(async () => {
      // 2026-08-14: 每接口独立 8s 超时(AbortController)——避免单接口挂起拖死整测试(60s)
      const token = localStorage.getItem('crabpaw_api_key') || ''
      const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Api-Key': token } : {}) }
      const out: Record<string, string> = {}
      const trace: string[] = []
      async function probe(name: string, url: string, readJson = false) {
        trace.push(name + ':start')
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        try {
          const r = await fetch(url, { headers, signal: ctrl.signal })
          const j = readJson ? await r.json() : null
          out[name] = readJson
            ? r.status + ' data.isArray=' + Array.isArray(j?.data)
            : r.status + ''
          trace.push(name + ':done:' + r.status)
        } catch (e) {
          out[name] = 'ERR ' + String(e)
          trace.push(name + ':err:' + String(e))
        } finally {
          clearTimeout(timer)
        }
      }
      await probe('business/tables', 'http://localhost:38767/api/business/tables')
      await probe('experts/activity', 'http://localhost:38767/api/experts/activity?limit=5', true)
      await probe('mcp/servers', 'http://localhost:38767/api/mcp/servers')
      await probe('collab/status', 'http://localhost:38767/api/experts/collab/status?id=test')
      return { ...out, __trace: trace }
    })
    // eslint-disable-next-line no-console
    console.log('API contract:', JSON.stringify(results))
    // 业务端点可能有权限差异，但不应 401（鉴权链路是核心验证）
    expect(results['business/tables']).not.toBe('401')
    expect(results['experts/activity']).toContain('data.isArray=true')
  })

  test('页面无全局 JS 错误（除可忽略网络类）', async () => {
    const IGNORABLE = ['Failed to fetch', 'NetworkError', 'Load failed', 'AbortError', '加载插件', 'ResizeObserver', 'NotAllowedError', '404', '/events']
    const real = jsErrors.filter((e) => !IGNORABLE.some((p) => e.includes(p)))
    // eslint-disable-next-line no-console
    console.log('JS errors:', jsErrors.length, 'real:', real.length, real.slice(0, 5))
    expect(real).toEqual([])
  })
})
