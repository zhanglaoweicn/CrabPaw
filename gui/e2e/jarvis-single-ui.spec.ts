/**
 * 贾维斯单界面迁移 — 真机验证（阶段 A-D）
 *
 * 2026-08-14 重构为 CDP 模式（原 _electron.launch 与 Electron 28 结构性不兼容，
 * 见 app.spec.ts 头部说明）。
 *
 * 运行前提：后端已就绪 (port 38767) + Vite dev server 运行中 (port 5173)。
 * 用法：cd gui && node e2e/run-dev-tests.js e2e/jarvis-single-ui.spec.ts
 *
 * 验证清单（2026-08-21 更新: 「专家·数据」拆分后数据 tab 整体删除;MCP 提升为「连接」tab;技能仓库改名「技能」）：
 *   1. 默认直达 VoiceShell（.voice-shell-stage 可见,无「启动智能体」按钮）
 *   2. VoiceShell 顶栏有 管理舱,无「业务」按钮,无「控制台」,无 Dashboard 侧边栏
 *   3. ⚙ 管理舱 → 「专家」tab 渲染,「数据」tab 消失,「连接」tab 存在
 *   4. ⚙ 管理舱 → 系统设置/插件/技能/用量 tab
 *   5. 单浮层：重复打开管理舱不产生第二个浮层
 *   6. Esc 关闭管理舱
 */
import { test, expect, Page, Browser } from '@playwright/test'
import { launchCdpApp, getCdpPage, waitForService, closeCdpApp } from './cdp-helper'
import { ChildProcess } from 'child_process'

let proc: ChildProcess
let browser: Browser
let page: Page

async function waitForVoiceShell(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForSelector('.voice-shell-stage', { timeout: timeoutMs })
}

/** 强制关掉所有浮层（业务面板/管理舱/配置），保证测试自包含 */
async function closeAllOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(400)
}

test.describe('贾维斯单界面迁移验证', () => {

  test.beforeAll(async () => {
    // 2026-08-14: hook 默认 60s 超时——Electron 冷启动可能超限,显式放宽
    test.setTimeout(180000)
    const r = await launchCdpApp()
    proc = r.proc
    browser = r.browser
    page = await getCdpPage(browser)
    await waitForService(page, 90000)
  })

  test.afterAll(async () => {
    await closeCdpApp(browser, proc)
  })

  test('1. 默认直达 VoiceShell(AgentHome 已删除)', async () => {
    await waitForVoiceShell(page)
    await expect(page.locator('.voice-shell-stage')).toBeVisible()
    // AgentHome 宣传页已删除: 不存在「启动智能体」按钮
    await expect(page.locator('button', { hasText: '启动智能体' })).toHaveCount(0)
    const body = (await page.locator('body').innerText()).replace(/s+/g, '')
    expect(body).toContain('CrabPaw')
  })

  test('2. VoiceShell 顶栏有 管理舱,无「业务」按钮,无「控制台」(非 Dashboard)', async () => {
    await expect(page.locator('.voice-shell-stage')).toBeVisible()
    // 确认无 Dashboard 侧边栏
    await expect(page.locator('.sidebar-item')).toHaveCount(0)
    // 顶栏按钮
    const header = page.locator('header')
    await expect(header.locator('button', { hasText: '管理舱' })).toBeVisible()
    // 2026-08-19: 业务面板退役——「业务」按钮必须不存在
    await expect(header.locator('button', { hasText: '业务' })).toHaveCount(0)
    // 控制台按钮必须不存在（阶段 A 已删）
    await expect(header.locator('button', { hasText: '控制台' })).toHaveCount(0)
  })

  test('3. ⚙ 管理舱 → 「专家」tab 渲染 + 数据 tab 已删除 +「连接」tab 存在（2026-08-21）', async () => {
    await closeAllOverlays(page)
    await page.locator('header button', { hasText: '管理舱' }).click()
    await page.waitForSelector('.voice-shell-config-full', { timeout: 10_000 })
    const cockpit = page.locator('.voice-shell-config-full')
    await expect(cockpit).toBeVisible()
    // 2026-08-19: 业务面板退役——日程/文件/股票不再出现在管理舱 tab 列表
    await expect(cockpit.locator('button.cockpit-tab', { hasText: '专家·数据' })).toHaveCount(0)
    await expect(cockpit.locator('button.cockpit-tab', { hasText: '日程' })).toHaveCount(0)
    // 2026-08-21: 数据 tab 整体删除；MCP 提升为「连接」tab
    await expect(cockpit.locator('button.cockpit-tab', { hasText: '数据' })).toHaveCount(0)
    await expect(cockpit.locator('button.cockpit-tab', { hasText: '连接' })).toBeVisible()
    // 「专家」tab: 专家目录渲染
    await cockpit.locator('button.cockpit-tab', { hasText: '专家' }).click()
    await page.waitForTimeout(500)
    await expect(cockpit.locator('h3', { hasText: '🤖 专家' })).toBeVisible()
    // 专家目录渲染 4 位老板专家（2026-08-21 老板向专家, 旧 10 位专家已替换）
    await expect(cockpit.locator('text=老板驾驶舱').first()).toBeVisible()
    await expect(cockpit.locator('text=财务顾问').first()).toBeVisible()
    await expect(cockpit.locator('text=销售总监').first()).toBeVisible()
    await expect(cockpit.locator('text=人事主管').first()).toBeVisible()
    await expect(cockpit.locator('text=架构师')).toHaveCount(0)
    // 关闭，避免污染后续测试
    await closeAllOverlays(page)
  })

  test('4. ⚙ 管理舱 → 管理舱打开，系统设置/插件/技能/用量 tab', async () => {
    await closeAllOverlays(page)
    await expect(page.locator('.voice-shell-config-full')).toHaveCount(0)
    await page.locator('header button', { hasText: '管理舱' }).click()
    await page.waitForSelector('.voice-shell-config-full', { timeout: 10_000 })
    const cockpit = page.locator('.voice-shell-config-full')
    await expect(cockpit.locator('button.cockpit-tab', { hasText: '系统设置' })).toBeVisible()
    for (const label of ['系统设置', '连接', '专家', '插件', '技能', '用量']) {
      await expect(cockpit.locator('button.cockpit-tab', { hasText: label })).toBeVisible()
    }
    await closeAllOverlays(page)
  })

  test('5. 同一时刻只有一个浮层（重复打开管理舱不产生第二个浮层）', async () => {
    await closeAllOverlays(page)
    await page.locator('header button', { hasText: '管理舱' }).click()
    await page.waitForSelector('.voice-shell-config-full', { timeout: 10_000 })
    expect(await page.locator('.voice-shell-config-full').count()).toBe(1)
    // 遮罩盖住顶栏（z80>z5）→ 再次点击落在遮罩上,不会出现第二个浮层
    await page.locator('header button', { hasText: '管理舱' }).click({ force: true }).catch(() => {})
    await page.waitForTimeout(400)
    expect(await page.locator('.voice-shell-config-full').count()).toBeLessThanOrEqual(1)
    await closeAllOverlays(page)
  })

  test('6. Esc 关闭管理舱', async () => {
    await closeAllOverlays(page)
    await page.locator('header button', { hasText: '管理舱' }).click()
    await page.waitForSelector('.voice-shell-config-full', { timeout: 10_000 })
    await expect(page.locator('.voice-shell-config-full')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await expect(page.locator('.voice-shell-config-full')).toHaveCount(0)
  })
})
