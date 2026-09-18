/**
 * web-browse — 应用内网页浏览（WebBrowsePanel）渲染层契约与纯函数
 *
 * 访客页由主进程 WebContentsView 承载（不启用 webview 标签，保持 S6 安全修复），
 * 渲染层只画工具栏并上报矩形。本文件收两侧共享的常量与纯函数
 * （URL 校验/动作枚举/面板矩形/状态清洗），无 electron 依赖，可被 vitest 直接测试。
 *
 * 通道命名与 electron/main/web-browse.ts 保持一致（主进程侧不 import 本文件，
 * 避免 electron-vite 打包边界问题——改动通道名时两处同步）。
 */

/* ─── 事件与通道名 ─── */
// 任意组件 dispatch 此 CustomEvent 打开浏览面板（detail: WebPanelOpenDetail）。
// 第一批接线方：SceneShell WebPreviewCard 的"应用内打开"按钮。
export const WEBPANEL_OPEN_EVENT = 'crabpaw:webpanel-open'

export interface WebPanelOpenDetail {
  url: string
  title?: string
}

// 主进程 IPC 通道 — 与 electron/main/web-browse.ts、preload 的 webPanel 命名空间对齐
export const WEBPANEL_IPC = {
  show: 'webpanel:show',
  hide: 'webpanel:hide',
  setBounds: 'webpanel:set-bounds',
  action: 'webpanel:action',
  close: 'webpanel:close',
  state: 'webpanel:state',
} as const

/* ─── 面板动作 ─── */
export type WebPanelAction = 'back' | 'forward' | 'reload' | 'stop' | 'open-external'

export const WEBPANEL_ACTIONS: readonly WebPanelAction[] = ['back', 'forward', 'reload', 'stop', 'open-external']

export function isWebPanelAction(value: unknown): value is WebPanelAction {
  return typeof value === 'string' && (WEBPANEL_ACTIONS as readonly string[]).includes(value)
}

/* ─── URL 校验 ─── */
// 访客页导航仅放行 http/https。local:/file:（本地 HTML 预览）仍由 WebPreviewCard
// 的 iframe 承担——面板专用内存 partition 未注册 local: 协议处理器。
export function isWebPanelNavigableUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/* ─── 面板矩形计算 ─── */
export interface WebPanelRect {
  x: number
  y: number
  width: number
  height: number
}

// 工具栏高度；访客页矩形 = 面板矩形去掉顶部工具栏条
export const WEBPANEL_HEADER_H = 46
// 右侧留边（面板与窗口右/下边缘的间距）
export const WEBPANEL_MARGIN = 12
// 右侧停靠宽度上限与视口占比
export const WEBPANEL_MAX_W = 560
export const WEBPANEL_VW_RATIO = 0.42

// 右侧停靠浮层：宽取 min(上限, 视口宽占比)。同一函数同时驱动 React 容器样式
// 与主进程 setBounds（渲染层上报 guestBounds），两侧必然一致。
// 视口过小（低于窗口 minWidth/minHeight 允许值）返回 null 表示不铺面板。
export function computePanelRect(viewportW: number, viewportH: number): WebPanelRect | null {
  if (typeof viewportW !== 'number' || typeof viewportH !== 'number') return null
  if (!Number.isFinite(viewportW) || !Number.isFinite(viewportH)) return null
  if (viewportW < 420 || viewportH < 240) return null
  const width = Math.min(WEBPANEL_MAX_W, Math.round(viewportW * WEBPANEL_VW_RATIO))
  const height = viewportH - WEBPANEL_HEADER_H - WEBPANEL_MARGIN * 2
  if (height < 140) return null
  return {
    x: Math.round(viewportW - width - WEBPANEL_MARGIN),
    y: WEBPANEL_HEADER_H + WEBPANEL_MARGIN,
    width,
    height,
  }
}

// 从面板矩形推出访客页矩形（主进程 WebContentsView 覆盖区域 = 工具栏以下）
export function guestBounds(panel: WebPanelRect): WebPanelRect {
  return {
    x: panel.x,
    y: panel.y + WEBPANEL_HEADER_H,
    width: panel.width,
    height: Math.max(0, panel.height - WEBPANEL_HEADER_H),
  }
}

/* ─── 主进程状态事件清洗 ─── */
export interface WebPanelState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

export function sanitizeWebPanelState(raw: unknown): WebPanelState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    url: typeof r.url === 'string' ? r.url : '',
    title: typeof r.title === 'string' ? r.title : '',
    isLoading: r.isLoading === true,
    canGoBack: r.canGoBack === true,
    canGoForward: r.canGoForward === true,
  }
}

/* ─── 标题展示 ─── */
// 卡片标题优先，其次主进程推送的页面标题，否则退化为 URL 主机名
export function displayTitle(cardTitle: string | undefined, pageUrl: string): string {
  if (cardTitle && cardTitle.trim()) return cardTitle.trim()
  try {
    return new URL(pageUrl).host || pageUrl
  } catch {
    return pageUrl
  }
}
