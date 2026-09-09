/**
 * Vite 配置 — E2E 测试专用 dev server
 *
 * 与 vite.config.ts 完全一致，唯一区别:
 *   onstart 回调中不调用 startup()，阻止自动启动 Electron
 *   → 只启动 Vite dev server（带 HMR）
 *   → Playwright 自己启动 Electron 连接到 dev server
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron({
      // ★ 关键: 不调用 startup()，阻止自动启动 Electron
      onstart() {
        console.log('[test:e2e:dev] Electron 启动已跳过，由 Playwright 控制')
      },
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          build: {
            outDir: 'dist/electron/main',
          },
        },
      },
      preload: {
        input: {
          index: 'electron/preload/index.ts',
        },
        vite: {
          build: {
            outDir: 'dist/electron/preload',
          },
        },
      },
      renderer: {},
    }),
    renderer(),
  ],
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
