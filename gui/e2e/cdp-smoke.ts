/** CDP 模式冒烟测试: 启动 Electron → CDP 连接 → 验证页面 */
import { launchCdpApp, getCdpPage, waitForService, closeCdpApp } from './cdp-helper'

async function main() {
  console.log('[cdp-smoke] 启动 Electron(CRABPAW_E2E)...')
  const { proc, browser } = await launchCdpApp()
  console.log('[cdp-smoke] CDP 已连接 ✓')

  const page = await getCdpPage(browser)
  console.log('[cdp-smoke] 主窗口:', page.url().slice(0, 60))

  await waitForService(page)
  console.log('[cdp-smoke] React 已挂载 ✓')

  // 验证 electronAPI 可用(CDP 模式渲染层 preload 正常)
  const hasApi = await page.evaluate(() => {
    const w = window as any
    return { api: !!w.electronAPI, window: !!w.electronAPI?.window, version: w.electronAPI?.app?.getVersion?.() }
  })
  console.log('[cdp-smoke] electronAPI:', JSON.stringify(hasApi))

  // 验证默认直达 VoiceShell（AgentHome 已删除）
  await page.waitForSelector('.voice-shell-stage', { timeout: 30000 })
  console.log('[cdp-smoke] VoiceShell 已渲染 ✓')

  await closeCdpApp(browser, proc)
  console.log('[cdp-smoke] 已关闭 ✓')
  process.exit(0)
}
main().catch((e) => { console.error('[cdp-smoke] FAILED:', e?.message || e); process.exit(1) })
