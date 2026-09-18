/**
 * web-browse — 应用内网页浏览面板（主进程 WebContentsView）
 *
 * 为什么不用 <webview> 标签：webviewTag 由 S6 安全审计修复显式禁用（index.ts 主窗口
 * webPreferences），渲染层嵌入会扩大攻击面。本模块改由主进程持有 WebContentsView，
 * 访客页 webPreferences 与渲染层完全隔离，S6 保持不动。
 *
 * 安全闸门（对齐既有审计先例）：
 * - 独立内存 partition（无 persist: 前缀，M4 弹窗隔离同款）——不落盘、不与默认会话
 *   共享 cookie/storage，U盘便携版不留站点数据；
 * - 访客页 sandbox + contextIsolation + 无 preload + 无 webviewTag；
 * - 导航仅 http/https（local:/file: 本地预览仍由 WebPreviewCard iframe 承担）；
 * - window.open 一律 deny 并转发系统浏览器（同 shell:openExternal 的 https/http 门槛）；
 * - 下载取消并转发系统浏览器；权限请求（麦克风/地理位置等）全拒；
 * - 关闭面板即销毁访客页（不留会话残影）。
 *
 * 通道名与 gui/src/lib/web-browse.ts 对齐（此侧不 import 渲染层文件，避免打包边界问题）。
 */
import { ipcMain, session, shell, WebContentsView } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

// 通道名（勿单点改动——同步 gui/src/lib/web-browse.ts WEBPANEL_IPC）
const IPC_SHOW = 'webpanel:show'
const IPC_HIDE = 'webpanel:hide'
const IPC_SET_BOUNDS = 'webpanel:set-bounds'
const IPC_ACTION = 'webpanel:action'
const IPC_CLOSE = 'webpanel:close'
const IPC_STATE = 'webpanel:state'

// 访客页动作白名单（同步 gui/src/lib/web-browse.ts WEBPANEL_ACTIONS）
const ACTIONS = ['back', 'forward', 'reload', 'stop', 'open-external'] as const
type GuestAction = (typeof ACTIONS)[number]

// 独立内存会话（无 persist: 前缀 = 纯内存，应用退出即清）
const GUEST_PARTITION = 'webpreview'

// 与 shell:openExternal 一致的协议门槛（index.ts 2870 区域）
const ALLOWED_URL = /^https?:\/\//i

// 面板最小可见尺寸（渲染层 computePanelRect 的下限同源，防坏矩形把视图压没）
const MIN_BOUNDS = 80

let registered = false
let currentView: WebContentsView | null = null

function openExternalForward(url: string, reason: string) {
  if (!ALLOWED_URL.test(url)) {
    console.warn(`[web-browse] 拒绝转发非 http/https ${reason}:`, url)
    return
  }
  shell.openExternal(url).catch((err: unknown) => {
    console.error('[web-browse] openExternal 失败:', err instanceof Error ? err.message : String(err))
  })
}

function configureGuestSession() {
  const ses = session.fromPartition(GUEST_PARTITION)
  // 权限全拒：预览面板不是麦克风/摄像头/定位的合法入口
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn('[web-browse] 拒绝访客页权限请求:', permission)
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  // 下载不进应用目录：取消并转系统浏览器（用户自己的下载器处理落盘）
  ses.on('will-download', (event, item) => {
    event.preventDefault()
    console.log('[web-browse] 下载转发系统浏览器:', item.getURL())
    openExternalForward(item.getURL(), '下载链接')
  })
  return ses
}

function pushState(getWindow: () => BrowserWindow | null) {
  const win = getWindow()
  if (!win || win.isDestroyed() || !currentView) return
  const wc = currentView.webContents
  if (wc.isDestroyed()) return
  const state = {
    url: wc.getURL() || '',
    title: wc.getTitle() || '',
    isLoading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  }
  if (!win.isMinimized()) {
    win.webContents.send(IPC_STATE, state)
  }
}

function attachGuestHandlers(wc: WebContents, getWindow: () => BrowserWindow | null) {
  const push = () => pushState(getWindow)
  wc.on('did-start-loading', push)
  wc.on('did-stop-loading', push)
  wc.on('did-navigate', push)
  wc.on('did-navigate-in-page', push)
  wc.on('page-title-updated', push)
  // 访客页内导航仅 http/https（拦截 file:/devtools:/自定义协议跳转）
  wc.on('will-navigate', (event, url) => {
    if (!ALLOWED_URL.test(url)) {
      console.warn('[web-browse] 拦截访客页非 http/https 导航:', url)
      event.preventDefault()
    }
  })
  // window.open/带 target 链接：deny 弹窗，转系统浏览器（预览面板不开二级窗）
  wc.setWindowOpenHandler(({ url }) => {
    console.log('[web-browse] 访客页弹窗转发系统浏览器:', url)
    openExternalForward(url, '弹窗链接')
    return { action: 'deny' }
  })
}

function ensureView(getWindow: () => BrowserWindow | null): WebContentsView | null {
  if (currentView && !currentView.webContents.isDestroyed()) return currentView
  const win = getWindow()
  if (!win || win.isDestroyed()) return null
  currentView = new WebContentsView({
    webPreferences: {
      partition: GUEST_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // 无 preload——访客页不需要任何桥接能力
    },
  })
  currentView.setBackgroundColor('#0a0a0f')
  attachGuestHandlers(currentView.webContents, getWindow)
  return currentView
}

function destroyView(getWindow: () => BrowserWindow | null) {
  if (!currentView) return
  const win = getWindow()
  try {
    if (win && !win.isDestroyed()) win.contentView.removeChildView(currentView)
  } catch (err: unknown) {
    console.warn('[web-browse] 移除视图失败:', err instanceof Error ? err.message : String(err))
  }
  if (!currentView.webContents.isDestroyed()) currentView.webContents.close()
  currentView = null
}

function validBounds(payload: unknown): { x: number; y: number; width: number; height: number } | null {
  const r = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const pick = (key: string): number =>
    typeof r[key] === 'number' && Number.isFinite(r[key] as number) ? (r[key] as number) : NaN
  const x = pick('x')
  const y = pick('y')
  const width = pick('width')
  const height = pick('height')
  if ([x, y, width, height].some((v) => Number.isNaN(v))) return null
  if (width < MIN_BOUNDS || height < MIN_BOUNDS) return null
  return { x, y, width, height }
}

/**
 * 注册 webPanel IPC。幂等：IPC 处理器只挂一次（窗口重建不影响，getWindow
 * 闭包读的是 index.ts 的模块变量 mainWindow）。
 */
export function registerWebBrowse(getWindow: () => BrowserWindow | null) {
  configureGuestSession()

  if (!registered) {
    registered = true

    ipcMain.handle(IPC_SHOW, (_e, payload: unknown) => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return { success: false, error: '主窗口不可用' }
      const url = (payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>).url
        : undefined)
      if (typeof url !== 'string' || !ALLOWED_URL.test(url)) {
        return { success: false, error: '仅支持 http/https 地址' }
      }
      const view = ensureView(getWindow)
      if (!view) return { success: false, error: '视图创建失败' }
      win.contentView.addChildView(view) // 重复 add 会置顶，保证覆盖弹层
      view.webContents.loadURL(url).catch((err: unknown) => {
        console.error('[web-browse] loadURL 失败:', err instanceof Error ? err.message : String(err))
      })
      pushState(getWindow)
      return { success: true }
    })

    ipcMain.handle(IPC_HIDE, () => {
      const win = getWindow()
      if (win && !win.isDestroyed() && currentView) win.contentView.removeChildView(currentView)
      return { success: true }
    })

    ipcMain.handle(IPC_SET_BOUNDS, (_e, payload: unknown) => {
      const rect = validBounds(payload)
      if (!rect) return { success: false, error: '矩形无效' }
      if (currentView && !currentView.webContents.isDestroyed()) {
        currentView.setBounds(rect)
      }
      return { success: true }
    })

    ipcMain.handle(IPC_ACTION, (_e, payload: unknown) => {
      const action = typeof payload === 'string' ? payload : ''
      if (!(ACTIONS as readonly string[]).includes(action)) {
        return { success: false, error: '未知动作' }
      }
      if (!currentView || currentView.webContents.isDestroyed()) {
        return { success: false, error: '面板未打开' }
      }
      const wc = currentView.webContents
      try {
        switch (action as GuestAction) {
          case 'back': wc.navigationHistory.goBack(); break
          case 'forward': wc.navigationHistory.goForward(); break
          case 'reload': wc.reload(); break
          case 'stop': wc.stop(); break
          case 'open-external': openExternalForward(wc.getURL() || '', '当前页'); break
        }
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
      return { success: true }
    })

    ipcMain.handle(IPC_CLOSE, () => {
      destroyView(getWindow)
      return { success: true }
    })
  }

  return { ok: true }
}

/** 主窗口关闭/重建时调用：销毁访客页（IPC 处理器保留，窗口重建后仍可用） */
export function disposeWebBrowse(getWindow: () => BrowserWindow | null) {
  destroyView(getWindow)
}
