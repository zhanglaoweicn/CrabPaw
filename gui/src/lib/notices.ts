/**
 * notices — 「需要老板知道的事」的统一记录与播报（2026-09-22 体验层）
 *
 * 背景：此前这类事分散在五个地方各自表达（审批卡 / 任务轨道 / 心跳卡 /
 * 中断恢复横幅 / 告警卡），没有任何一处回答「我现在该做什么」；而最容易
 * 被漏掉的三类还会静默消失：
 *   · 审批超时 —— 后端自动拒绝（src/core/security/approval.js 的
 *     resolutionReason = 'approval_timeout_auto_deny'），前端此前只是把卡片
 *     filter 掉，无提示、无痕迹，老板离开一分钟回来什么都没发生；
 *   · 长任务 —— 只在各自面板内可见，切走面板就没有角标；
 *   · 工具失败 —— 没有 toast，错误卡 2.5s 淡出。
 *
 * 本模块是同一份数据的两个出口：
 *   1. recordNotice() —— 记进「事务账本」环形记录（左栏渲染），持久化可回看；
 *   2. announce()     —— 说给老板听，落在既有的 'crabpaw:speak' 事件 →
 *                        VoiceShell 共享播报队列（useSpeechQueue）。该队列自带
 *                        守卫：主回复流进行中不抢播、静音时 2 分钟过期丢弃，
 *                        所以这里不重复判断，也绝不打断正在说的回复。
 *
 * 收录口径：只记「不看屏幕会漏掉、且需要老板出手或知情」的事。面板开关 /
 * 导航 / 模式切换这类操作确认仍走各自的 speech.enqueue，不进账本——否则
 * 账本会被噪音淹没，等于没有。
 */

export type NoticeKind = 'approval' | 'task' | 'alert' | 'system'

/**
 * 账本分档（决定排序与配色，不决定播报）：
 *   action —— 需要老板出手（批准/拒绝/重试/确认），永远排最前
 *   failed —— 已经失败，知情即可
 *   done   —— 完成，知情即可
 *   info   —— 发生了但无动作
 */
export type NoticeLevel = 'action' | 'failed' | 'done' | 'info'

export interface Notice {
  id: string
  ts: number
  kind: NoticeKind
  level: NoticeLevel
  /** 一句话说明「什么事」，账本主行 */
  title: string
  /** 补充信息（命令原文 / 失败原因），账本次行 */
  detail?: string
  /**
   * 关联实体 id——审批 requestId / 任务 taskId。账本据此提供行内动作
   * （直接批准/拒绝、跳到对应任务），不必解析 id 字符串前缀。
   */
  ref?: string
  /** 已处理标记（老板点掉/语音答复后置位），仅对 actionable 有意义 */
  handled?: boolean
}

const STORAGE_KEY = 'crabpaw.notices.v1'
/** 环形上限——账本是「今天还有什么要办」，不是审计日志（审计有 audit-log-v2） */
const MAX_NOTICES = 60
/** 单条 detail 截断——命令原文可能很长，账本只做线索不做全文 */
const MAX_DETAIL = 120

let notices: Notice[] = load()
const listeners = new Set<() => void>()

function load(): Notice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 只保留当天的——隔夜账本对老板无意义，且防止无限累积
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    return parsed.filter((n: Notice) => n && typeof n.ts === 'number' && n.ts >= dayStart.getTime())
  } catch (e) {
    console.warn('[notices] 读取账本失败(忽略):', e)
    return []
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notices))
  } catch (e) {
    // 配额满/隐私模式——账本是尽力而为的展示层，落盘失败不影响主流程
    console.warn('[notices] 账本落盘失败(忽略):', e)
  }
}

function emit(): void {
  for (const cb of listeners) {
    try { cb() } catch (e) { console.warn('[notices] 订阅回调异常:', e) }
  }
}

/** 订阅账本变化（配 useSyncExternalStore 使用） */
export function subscribeNotices(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 当前账本快照——引用稳定，仅内容变化时更换，符合 useSyncExternalStore 契约 */
export function getNotices(): Notice[] {
  return notices
}

function trimDetail(detail?: string): string | undefined {
  if (!detail) return undefined
  const one = String(detail).replace(/\s+/g, ' ').trim()
  if (!one) return undefined
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL)}…` : one
}

/**
 * 记一条账本。同 id 覆盖（幂等）——重复事件不该刷屏。
 * 返回最终落库的那条，便于调用方复用。
 */
export function recordNotice(input: Omit<Notice, 'ts'> & { ts?: number }): Notice {
  const notice: Notice = {
    ...input,
    detail: trimDetail(input.detail),
    ts: input.ts ?? Date.now(),
  }
  const idx = notices.findIndex(n => n.id === notice.id)
  if (idx >= 0) {
    // 同 id 更新：保留 handled 标记（老板已经点过的事，后续状态刷新不该复活它）
    const prev = notices[idx]
    notices = [...notices]
    notices[idx] = { ...notice, handled: prev.handled }
  } else {
    notices = [notice, ...notices].slice(0, MAX_NOTICES)
  }
  persist()
  emit()
  return notice
}

/** 标记已处理（老板批复/点掉后调用） */
export function markNoticeHandled(id: string): void {
  const idx = notices.findIndex(n => n.id === id)
  if (idx < 0 || notices[idx].handled) return
  notices = [...notices]
  notices[idx] = { ...notices[idx], handled: true }
  persist()
  emit()
}

/** 清空账本（「全部知道了」） */
export function clearNotices(): void {
  if (notices.length === 0) return
  notices = []
  persist()
  emit()
}

/**
 * 账本排序：需要老板出手的排最前（未处理 > 已处理），其次失败，最后完成/信息；
 * 同档按时间倒序（最近发生的在上）。
 * 意义：老板扫一眼左栏，第一行就该是"现在最该管的事"。
 */
export function sortNotices(list: Notice[]): Notice[] {
  const rank = (n: Notice): number => {
    if (n.level === 'action') return n.handled ? 1 : 0
    if (n.level === 'failed') return 2
    if (n.level === 'done') return 3
    return 4
  }
  return [...list].sort((a, b) => (rank(a) - rank(b)) || (b.ts - a.ts))
}

/** 还等着老板出手的条数——左栏角标用它（已处理的 action 不计） */
export function countPending(list: Notice[]): number {
  return list.filter(n => n.level === 'action' && !n.handled).length
}

export interface AnnounceOptions {
  /** 稳定 id——同一件事重复播报时调用方靠它去重；缺省按 kind+时间生成 */
  id?: string
  kind?: NoticeKind
  /** 岗位音色（专家/角色音），缺省落共享队列配置 */
  voice?: string
}

/**
 * 说给老板听。落在既有 crabpaw:speak 事件上——VoiceShell 是唯一消费方，
 * 它把 text 转投共享播报队列（或被实时通道改喂模型口播）。
 * 静音/主回复进行中的抑制由队列负责，这里不判断。
 */
export function announce(text: string, opts: AnnounceOptions = {}): void {
  const t = String(text || '').trim()
  if (!t) return
  const kind = opts.kind || 'system'
  const id = opts.id || `announce_${kind}_${Date.now()}`
  try {
    window.dispatchEvent(new CustomEvent('crabpaw:speak', {
      detail: { id, text: t, ...(opts.voice ? { voice: opts.voice } : {}) },
    }))
  } catch (e) {
    console.warn('[notices] 播报派发失败:', e)
  }
}

/**
 * 记一条 + 说一句。speech 传 false 时只记账不出声（例如高频的失败重试）。
 * 返回账本条目。
 */
export function notify(
  input: Omit<Notice, 'ts'> & { ts?: number },
  speech?: string | false,
): Notice {
  const notice = recordNotice(input)
  if (speech !== false) announce(speech || notice.title, { id: `notice_${notice.id}`, kind: notice.kind })
  return notice
}

/** 仅供测试：重置模块内部状态 */
export function __resetNoticesForTest(seed: Notice[] = []): void {
  notices = seed
  persist()
  emit()
}
