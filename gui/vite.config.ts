import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import fs from 'fs'

// 2026-08-03: KWS 资源复制——kws/index.ts 运行时 require/引用相对 __dirname 的
// cjs/html 文件（wake-word.cjs、kws-process.cjs、wake-probe-*.cjs/html），
// vite 只打包入口，其余文件需在构建后复制到 dist-electron/kws/
function copyKwsResources(): any {
  return {
    name: 'copy-kws-resources',
    closeBundle() {
      const src = path.resolve(__dirname, 'electron/kws')
      const dest = path.resolve(__dirname, 'dist-electron/kws')
      try {
        fs.mkdirSync(dest, { recursive: true })
        for (const f of fs.readdirSync(src)) {
          if (f.includes('.test.') || f.endsWith('.ts')) continue
          fs.copyFileSync(path.join(src, f), path.join(dest, f))
        }
        console.log('[kws] 资源复制完成 → dist-electron/kws')
      } catch (e: any) {
        console.error('[kws] 资源复制失败:', e?.message || e)
      }
    },
  }
}

export default defineConfig({
  base: './',
  server: {
    proxy: {
      '/chat': 'http://localhost:38767',
      '/events': 'http://localhost:38767',
      '/status': 'http://localhost:38767',
      '/config': 'http://localhost:38767',
      '/health': 'http://localhost:38767',
      '/api': 'http://localhost:38767',
      '/sse': 'http://localhost:38767',
      '/projects': 'http://localhost:38767',
      // B2: /shutdown proxy excluded — prevents external users from triggering backend shutdown in dev
      // '/shutdown': 'http://localhost:38767',
      '/skills': 'http://localhost:38767',
      '/upload': 'http://localhost:38767',
      // 2026-08-21: 对话附件图 src=/files/workspace/uploads/...——此前无代理规则，
      // vite 返回 index.html → 破图不显示（Electron 走 local:// 不受影响）
      '/files': 'http://localhost:38767',
      '/webhook': 'http://localhost:38767',
      '/dashboard-plugins': 'http://localhost:38767',
      '/voice/cloud': {
        target: 'ws://localhost:38767',
        ws: true,
      },
      '/scene': {
        target: 'ws://localhost:38767',
        ws: true,
      },
    },
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main/index.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      {
        entry: 'electron/preload/index.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload'
          }
        }
      },
      {
        // 2026-08-03: KWS 唤醒模块独立入口——此前动态 require('../kws') 未被打包，
        // 运行时 Cannot find module '../kws' → 唤醒完全不可用（说'小螃蟹'无反应）
        entry: 'electron/kws/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/kws',
            rollupOptions: {
              external: ['electron']
            }
          },
          plugins: [copyKwsResources()]
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  // 2026-08-23: vitest 配置——测试文件用全局 describe/test（无需显式 import），
  // 组件测试需 jsdom 环境。vite dev/build 忽略此块。
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-markdown': ['react-markdown'],
          'vendor-ui': ['lucide-react', 'sonner'],
          'vendor-mermaid': ['mermaid'],
          'vendor-katex': ['katex'],
          'vendor-three': ['three'],
        }
      }
    }
  }
})
