/**
 * sheet-state — SideSheet 互斥 + body 联动（纯函数可单测，模式同 lib/top-overlay）
 *
 * 语义对照参考实现（styles.css:2752 body.hotspot-mode 挂载/卸载）：
 * 打开面板 → body 挂 side-sheet-open + 设 --sheet-width；关闭 → 移除。
 * 互斥：同一时刻只允许一个面板激活（打开新面板先触发旧面板关闭回调）。
 * 三面板挂在 App 根层（Dashboard/VoiceShell 共用），布局联动只能走 body 级通道。
 */

type DocLike = {
  body: {
    classList: {
      toggle(c: string, on: boolean): void
      add(c: string): void
      remove(c: string): void
      item(i: number): string | undefined
      readonly length: number
    }
    style: { setProperty(k: string, v: string): void; removeProperty(k: string): void }
  }
}

let doc: DocLike | null = null
let activeName: string | null = null
let activeWidth = 'min(56vw, 860px)'
// A2(2026-09-05): overlay 档——管理舱/会话抽屉与 SideSheet 共用同一互斥位,
// 但不做 body 布局联动(side-sheet-open/--sheet-width 是侧板让位语义,
// 全屏浮层激活时聊天列不应位移)。
let activeIsOverlay = false
const closeCallbacks = new Map<string, () => void>()

/** 注入 document（测试传假对象；null 表示脱离 DOM，所有操作 no-op） */
export function setSheetDocument(d: DocLike | null): void {
  doc = d
}

/** 面板挂载时注册关闭回调，返回注销函数（卸载时调用） */
export function registerSheet(name: string, onClose: () => void): () => void {
  closeCallbacks.set(name, onClose)
  return () => { closeCallbacks.delete(name) }
}

export function getActiveSheet(): string | null {
  return activeName
}

/** 打开面板：已有其他面板激活则先触发其关闭（互斥）；再同步 body class 与宽度 */
export function activateSheet(name: string, width: string): void {
  if (activeName && activeName !== name) {
    const prev = closeCallbacks.get(activeName)
    if (prev) prev()
  }
  activeName = name
  activeWidth = width
  activeIsOverlay = false
  syncBody()
}

/**
 * 打开全屏 overlay(管理舱/会话抽屉):与 SideSheet 共用同一互斥位——
 * 打开任一方自动关闭另一方;但不写 body class / --sheet-width。
 * 返回注销函数(调用方 effect 清理时与 closeSheet 一起调用,对齐 SideSheet 模式)。
 */
export function activateOverlay(name: string, onClose: () => void): () => void {
  const unregister = registerSheet(name, onClose)
  if (activeName && activeName !== name) {
    const prev = closeCallbacks.get(activeName)
    if (prev) prev()
  }
  activeName = name
  activeIsOverlay = true
  syncBody()
  return unregister
}

/** 关闭指定面板（幂等；被互斥顶掉时 activeName 已易主，no-op） */
export function closeSheet(name: string): void {
  if (activeName !== name) return
  activeName = null
  activeIsOverlay = false
  syncBody()
}

/**
 * 关闭当前激活面板（通用入口）——VoiceShell 裸「关闭」命令用：
 * 会议纪要/热点/台风等 SideSheet 宿主卡打开时，无目标词的「关闭」应关掉在屏面板
 * 而非落 LLM。返回是否真的关闭了某面板（无面板激活时 false，调用方落 LLM）。
 */
export function closeActiveSheet(): boolean {
  if (!activeName) return false
  const cb = closeCallbacks.get(activeName)
  if (cb) {
    try { cb() } catch (err) { console.error('[sheet-state] 关闭活动面板回调失败:', err) }
  }
  activeName = null
  activeIsOverlay = false
  syncBody()
  return true
}

function syncBody(): void {
  if (!doc) return
  // overlay 激活时不挂 side-sheet-open——聊天列不位移(全屏浮层盖在其上)
  const open = activeName !== null && !activeIsOverlay
  // 2026-08-14 P2-图例2: 挂 side-sheet-<name> 类, 让前端样式可针对特定面板
  // (如 hotspot) 做差异化布局组合,而不影响 weather/music 等其他面板
  const list = doc.body.classList
  // 清理所有可能残留的 side-sheet-* 类
  for (let i = list.length - 1; i >= 0; i--) {
    const cls = list.item(i) || ''
    if (cls.startsWith('side-sheet-') && cls !== 'side-sheet-open') list.remove(cls)
  }
  list.toggle('side-sheet-open', open)
  if (open && activeName) list.add(`side-sheet-${activeName}`)
  if (open) doc.body.style.setProperty('--sheet-width', activeWidth)
  else doc.body.style.removeProperty('--sheet-width')
}
