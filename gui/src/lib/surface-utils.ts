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

/* ══════════════════════════════════════════════════════════════════════
   关闭状态机 v2 — SurfaceId / Revision / Lifecycle 分离（2026-09-30）

   为什么改：此前关闭记录只有一个按**内容指纹**生成的键
   `id@JSON(data)`（VoiceShell/index.tsx dismissKey）。指纹会随数据刷新而变，
   于是"用户明确关掉的卡片"在下一轮刷新时**必然复活**——对语音优先的界面，
   老板说"关掉"而卡片又回来，信任当场归零（git 历史里
   `fix(ui): 面板「说关了没关」收口` 正是这个症状）。

   为什么不能简单改成"按 id 关闭"：原设计刻意用指纹达成另一条正确目的——
   生成型 id（如 `doc-<ts>`）复用于**新内容**时，旧关闭记录不应遮蔽新卡片。
   一刀切按 id 会把那个 bug 换回来。

   解法：**分清"谁要求的关闭"**，两种语义各自记账：
     · permanent —— 用户明确关闭（点击/语音/closeTop）。按 SurfaceId 记，
       **数据刷新不得复活**。这是本产品要的语义。
     · fingerprint —— 指纹级过期（自动收纳等）。数据变化即可再出现。
   另设唯一例外：`intent === 'confront'` 且内容指纹与上次不同（风险升级）
   时可突破永久关闭重新弹出——因为漏掉风险比重复打扰更贵；其余情况一律不复活。
   ══════════════════════════════════════════════════════════════════════ */

/** 关闭记录 v2 的 localStorage 键（与 v1 并存，首次读取时自动迁移） */
export const DISMISS_STATE_KEY = 'crabpaw.dismissState.v2'

/** 关闭原因：用户明确关闭（跨数据刷新保持） / 指纹级过期（数据变化即可再现） */
export type DismissReason = 'permanent' | 'fingerprint'

interface DismissState {
  /** SurfaceId 集合 —— 用户明确关闭过的卡片 */
  permanent: string[]
  /** `id@指纹` 集合 —— 指纹级过期 */
  fingerprint: string[]
  /** `id` → 最后一次被关闭时的内容指纹（仅 permanent 项有意义） */
  lastFingerprint: Record<string, string>
}

export interface DismissStore {
  permanent: Set<string>
  fingerprint: Set<string>
  lastFingerprint: Map<string, string>
}

/** 与 VoiceShell 一致的指纹口径：id + 数据指纹（保持一致以免两处判定漂移） */
export function fingerprintOf(id: string, data: unknown): string {
  return `${id}@${JSON.stringify(data)}`
}

/** 数据指纹（不含 id），用于"内容是否真的变了"的判断 */
function dataHash(data: unknown): string {
  try { return JSON.stringify(data) ?? '' } catch { return '' }
}

function emptyStore(): DismissStore {
  return { permanent: new Set(), fingerprint: new Set(), lastFingerprint: new Map() }
}

/** 从 localStorage 读取关闭状态；v1 的纯指纹记录迁移为 fingerprint（语义等价） */
export function loadDismissStore(): DismissStore {
  try {
    const raw = localStorage.getItem(DISMISS_STATE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DismissState>
      const store = emptyStore()
      for (const id of Array.isArray(parsed.permanent) ? parsed.permanent : []) store.permanent.add(String(id))
      for (const k of Array.isArray(parsed.fingerprint) ? parsed.fingerprint : []) store.fingerprint.add(String(k))
      const lf = parsed.lastFingerprint && typeof parsed.lastFingerprint === 'object' ? parsed.lastFingerprint : {}
      for (const [id, fp] of Object.entries(lf)) store.lastFingerprint.set(String(id), String(fp))
      return store
    }
    // v2 不存在 → 迁移 v1（旧记录都是指纹级，保持原语义不扩大关闭范围）
    const legacy = localStorage.getItem(DISMISS_STORAGE_KEY)
    if (legacy) {
      const arr = JSON.parse(legacy)
      const store = emptyStore()
      for (const k of Array.isArray(arr) ? arr : []) store.fingerprint.add(String(k))
      return store
    }
    return emptyStore()
  } catch (e) {
    console.warn('[surface-utils] 读取关闭状态失败:', e)
    return emptyStore()
  }
}

/** 落盘（两侧各自截断，防 localStorage 膨胀；失败仅告警不阻断） */
export function saveDismissStore(store: DismissStore): void {
  try {
    const permanent = [...store.permanent].slice(-MAX_DISMISSED)
    const fingerprint = [...store.fingerprint].slice(-MAX_DISMISSED)
    const lastFingerprint: Record<string, string> = {}
    for (const id of permanent) {
      const fp = store.lastFingerprint.get(id)
      if (fp !== undefined) lastFingerprint[id] = fp
    }
    const payload: DismissState = { permanent, fingerprint, lastFingerprint }
    localStorage.setItem(DISMISS_STATE_KEY, JSON.stringify(payload))
    // v2 已建立，清掉 v1 避免两套记录长期并存造成判定歧义
    localStorage.removeItem(DISMISS_STORAGE_KEY)
  } catch (e) {
    console.warn('[surface-utils] 保存关闭状态失败:', e)
  }
}

/** 卡片是否应被隐藏 */
export function isDismissed(
  store: DismissStore,
  surface: { id: string; data?: unknown; intent?: string },
): boolean {
  if (store.fingerprint.has(fingerprintOf(surface.id, surface.data))) return true
  if (!store.permanent.has(surface.id)) return false
  // 永久关闭的唯一例外：confront 级内容发生变化（风险升级）→ 允许重新弹出。
  // 只认"升级"，同一份内容再推一次仍保持关闭，避免抖动式复活。
  if (surface.intent === 'confront') {
    const last = store.lastFingerprint.get(surface.id)
    if (last === undefined || last !== dataHash(surface.data)) return false
  }
  return true
}

/** 记录一次关闭（返回新 store，便于 setState 不可变更新） */
export function markDismissed(
  store: DismissStore,
  surface: { id: string; data?: unknown },
  reason: DismissReason = 'permanent',
): DismissStore {
  const next: DismissStore = {
    permanent: new Set(store.permanent),
    fingerprint: new Set(store.fingerprint),
    lastFingerprint: new Map(store.lastFingerprint),
  }
  if (reason === 'permanent') {
    next.permanent.add(surface.id)
    next.lastFingerprint.set(surface.id, dataHash(surface.data))
  } else {
    next.fingerprint.add(fingerprintOf(surface.id, surface.data))
  }
  return next
}

/** 撤销关闭（语音"打开X"/setVisible(true) 时调用），返回新 store */
export function clearDismissed(store: DismissStore, id: string): DismissStore {
  const next: DismissStore = {
    permanent: new Set(store.permanent),
    fingerprint: new Set(store.fingerprint),
    lastFingerprint: new Map(store.lastFingerprint),
  }
  next.permanent.delete(id)
  next.lastFingerprint.delete(id)
  for (const k of [...next.fingerprint]) {
    if (k === id || k.startsWith(`${id}@`)) next.fingerprint.delete(k)
  }
  return next
}
