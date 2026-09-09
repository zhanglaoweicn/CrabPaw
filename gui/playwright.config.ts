import { defineConfig } from '@playwright/test'

/**
 * Playwright config for CrabPaw Electron E2E tests (dev mode)
 *
 * 运行方式:
 *   1. 先启动 Vite dev server:   npm run dev          (在另一个终端)
 *   2. 再跑测试:                  npx playwright test   (或 npm run test:e2e)
 *
 * 测试会通过 electron.launch() 启动 Electron 主进程，连接到已运行的 Vite dev server。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,          // 每个测试最长 60s（首次启动后端可能较慢）
  expect: {
    timeout: 15_000,        // 断言等待时间
  },
  fullyParallel: false,     // Electron 测试不要并行，避免端口冲突
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
})
