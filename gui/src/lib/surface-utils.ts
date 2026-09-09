/**
 * surface-utils — 对话窗口卡片墙治理工具（2026-08-20 弹卡治理轮）
 *
 * 用户指令: 对话窗口不再出现临时文本卡片。三条防线:
 *   1. 后端不再自动推 document 卡(R19 删除)——本文件只负责前端渲染/持久化。
 *   2. 卡片墙过滤纯文本 kind(text/info): reminder/proactive 的文本卡
 *      只走对话消息流, 不再以卡片形式出现。
 *   3. dismiss 记录持久化: 用户已清除的卡片跨重启/重连保持关闭,
 *      同指纹卡不复活; 新数据卡(新指纹)照常出现。
 */

/** 卡片墙不渲染的纯文本 kind（渲染层过滤, 不影响 dismiss/closeTop 契约） */
export const CARD_WALL_PLAIN_TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'info'])

/** 该 kind 是否允许出现在对话窗口卡片墙（text/info → false） */
export function isCardWallKind(kind: string | undefined): boolean {
  return !!kind && !CARD_WALL_PLAIN_TEXT_KINDS.has(kind)
}

/** dismiss 记录 localStorage 键 */
export const DISMISS_STORAGE_KEY = 'crabpaw.dismissedSurfaces.v1'

/** 持久化上限——防 localStorage 膨胀, 超出丢最旧 */
export const MAX_DISMISSED = 300

/** 读取已关闭卡片记录（localStorage 损坏/不可用 → 空集） */
export function loadDismissedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch (e) {
    console.warn('[surface-utils] 读取已关闭卡片记录失败:', e)
    return new Set()
  }
}

/** 保存已关闭卡片记录（截断至 MAX_DISMISSED 条, 失败仅告警不阻断） */
export function saveDismissedKeys(keys: Set<string>): void {
  try {
    const arr = [...keys].slice(-MAX_DISMISSED)
    localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(arr))
  } catch (e) {
    console.warn('[surface-utils] 保存已关闭卡片记录失败:', e)
  }
}
