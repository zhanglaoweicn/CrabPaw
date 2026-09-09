/**
 * CrabPaw 桌面端交互 E2E（2026-08-14 补充）
 *
 * 覆盖此前缺失的两块:
 *   1. 文本交互: 输入 → 发送 → 用户消息气泡回声（本地渲染断言,不依赖 LLM 回复）
 *   2. 语音 PTT: 按住空格 → 真实录音管线启动（无 JS 错误）→ 松开恢复
 *
 * 运行方式: npm run test:e2e:dev interaction.spec.ts
 */
import { test, expect, Page, Browser } from '@playwright/test'
import { launchCdpApp, getCdpPage, waitForService, closeCdpApp } from './cdp-helper'
import { ChildProcess } from 'child_process'

let proc: ChildProcess
let browser: Browser
let page: Page

test.beforeAll(async () => {
  test.setTimeout(180000)
  const r = await launchCdpApp()
  proc = r.proc
  browser = r.browser
  page = await getCdpPage(browser)
  await waitForService(page, 90000)
  await page.waitForSelector('.voice-shell-stage', { timeout: 30000 })
  await page.waitForTimeout(2000)
})

test.afterAll(async () => {
  await closeCdpApp(browser, proc)
})

test.describe('桌面端交互 — 文本', () => {
  test('输入并发送:用户消息回声出现且无 JS 错误', async () => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))

    const input = page.locator('.vs-text-field')
    await expect(input).toBeVisible({ timeout: 15000 })
    const msg = 'E2E 交互测试消息 ' + Date.now()
    await input.fill(msg)
    await page.locator('.vs-send-btn').click()

    // 用户消息回声（本地渲染,不依赖 LLM 回复）
    const bubble = page.locator('.chatcard-msg--user .chatcard-msg-bubble', { hasText: msg })
    await expect(bubble.first()).toBeVisible({ timeout: 15000 })

    // 发送后给 LLM/管线一个窗口,断言无 JS 运行时错误
    await page.waitForTimeout(3000)
    expect(errors).toEqual([])
  })
})

test.describe('桌面端交互 — 语音 PTT', () => {
  test('按住空格进入录音管线,松开恢复,全程无 JS 错误', async () => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))

    // 前置: 左栏语音球存在（DingDong 对齐）
    await expect(page.locator('.voice-shell-orb-click canvas')).toBeVisible({ timeout: 15000 })

    await page.keyboard.down('Space')
    await page.waitForTimeout(2500) // 录音进行中（真实 getUserMedia + ASR WS）
    expect(errors).toEqual([])

    await page.keyboard.up('Space')
    await page.waitForTimeout(2500) // 停止录音 + 会话恢复
    expect(errors).toEqual([])
  })
})
