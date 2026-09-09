import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './contexts/ThemeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Toaster } from 'sonner'
import './index.css'

let errorCount = 0
const MAX_ERRORS_BEFORE_RELOAD = 50
let lastErrorTime = 0

// 不计入全局错误计数的模式（这些是非致命错误，不应触发页面重载）
const IGNORABLE_ERROR_PATTERNS = [
  '加载插件',           // 插件加载失败
  'script error',       // 跨域脚本错误
  'ResizeObserver',     // ResizeObserver 循环
  'NetworkError',       // 网络错误（服务未启动时）
  'Failed to fetch',    // fetch 失败
  'Load failed',        // 资源加载失败
  'AbortError',         // 主动中止
  'NotAllowedError',    // 权限被拒
]

window.addEventListener('error', (event) => {
  const errMsg = event.error?.message || event.message || ''
  
  // 跳过可忽略的错误 — 不计入错误计数
  if (IGNORABLE_ERROR_PATTERNS.some(p => errMsg.includes(p))) {
    try { event.preventDefault() } catch { console.warn('[Global] ignorable 错误 preventDefault 失败') }
    return false
  }
  
  // 跳过资源加载错误（<script>, <img>, <link> 等）— 这些不会导致 JS 执行问题
  if (event.target && event.target !== window) {
    try { event.preventDefault() } catch { console.warn('[Global] 资源加载 error 事件 preventDefault 失败') }
    return false
  }
  
  const now = Date.now()
  errorCount++
  
  if (now - lastErrorTime > 10000) {
    errorCount = 1
  }
  lastErrorTime = now
  
  try {
    console.error('[Global] 未捕获的错误:', errMsg, errorCount)
  } catch { console.warn('[Global] console.error 写入失败') }
  
  if (errorCount > MAX_ERRORS_BEFORE_RELOAD) {
    try { console.error('[Global] 错误次数过多 (' + errorCount + '/' + MAX_ERRORS_BEFORE_RELOAD + ')，即将重新加载页面...') } catch { console.warn('[Global] console.error 写入失败（页面即将重载）') }
    // 写入 localStorage 用于重启后诊断
    try { localStorage.setItem('crabpaw_reload_reason', JSON.stringify({ time: new Date().toISOString(), errorCount, lastError: errMsg })) } catch { console.warn('[Global] localStorage.setItem 写入失败') }
    setTimeout(() => { window.location.reload() }, 2000)
    errorCount = 0
  }
  
  try { event.preventDefault() } catch { console.warn('[Global] error 事件 preventDefault 失败') }
  return false
}, true)

window.addEventListener('unhandledrejection', (event) => {
  try {
    console.warn('[Global] 未处理的 Promise rejection:', event.reason?.message || String(event.reason).slice(0, 200))
  } catch { console.warn('[Global] unhandledrejection console.warn 写入失败') }
  
  try { event.preventDefault() } catch { console.warn('[Global] unhandledrejection preventDefault 失败') }
  return false
}, true)

// TS4 fix: 'render-process-gone' is an Electron-specific event, not on window
// Use string literal type to avoid `as any` on the event name
window.addEventListener('render-process-gone' as keyof WindowEventMap, ((event: Event) => {
  try { console.error('[Global] 渲染进程崩溃:', (event as CustomEvent)?.detail?.reason) } catch { console.warn('[Global] 渲染进程崩溃日志写入失败') }
}) as EventListener)

// TS5 fix: Use PerformanceObserver from global scope with proper typing
const _PerformanceObserver = typeof window !== 'undefined'
  ? (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver
  : undefined
if (_PerformanceObserver) {
  try {
    // 探测浏览器是否支持 'memory' entryType——Electron 某些版本不认,直接 observe
    // 会抛 "The entry type 'memory' does not exist"。不支持则跳过(内存监控是可选项)
    const supported: string[] = (window as any).PerformanceObserver?.supportedEntryTypes || []
    if (!supported.includes('memory')) {
      console.log('[Global] 浏览器不支持 memory entryType,内存监控跳过')
    } else {
      const observer = new _PerformanceObserver((list: PerformanceObserverEntryList) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'memory') {
            const memEntry = entry as PerformanceEntry & { usedJSHeapSize?: number; jsHeapSizeLimit?: number }
            const usedMB = memEntry.usedJSHeapSize ? Math.round(memEntry.usedJSHeapSize / 1024 / 1024) : 0
            const limitMB = memEntry.jsHeapSizeLimit ? Math.round(memEntry.jsHeapSizeLimit / 1024 / 1024) : 0
            if (usedMB > limitMB * 0.85) {
              try { console.warn('[Memory] 内存使用过高:', usedMB + 'MB / ' + limitMB + 'MB') } catch { console.warn('[Global] Memory 日志写入失败') }
            }
          }
        }
      })
      observer.observe({ entryTypes: ['memory'] } as PerformanceObserverInit)
    }
  } catch { console.warn('[Global] PerformanceObserver 初始化失败') }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <ErrorBoundary>
      <App />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            backgroundColor: 'var(--bg-card)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-body)'
          }
        }}
      />
    </ErrorBoundary>
  </ThemeProvider>,
)
