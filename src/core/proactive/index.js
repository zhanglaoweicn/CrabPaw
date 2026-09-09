/**
 * Proactive 主动沟通决策层 v1（规则通道）
 *
 * 职责: 统一入口 proactive.notify() — 决策"是否发声"、打扰抑制、补播队列。
 * 表达层由前端负责（TTS 播报 + 场景卡片），本模块只输出决策。
 */
const { broadcastEvent } = require('../sse-broadcast')

const DEFAULT_SILENT_START = 22  // 22:00 起静默
const DEFAULT_SILENT_END = 8     // 08:00 结束静默
const DEFAULT_DEDUP_MS = 30 * 60 * 1000 // 同一事件 30 分钟去重
const DEDUP_CACHE_MAX = 500      // 去重缓存条目上限，超出触发过期清理
const MAX_QUEUE_SIZE = 50        // 补播队列上限，超出丢弃最旧

let config = {
  silentStart: DEFAULT_SILENT_START,
  silentEnd: DEFAULT_SILENT_END,
  dedupMs: DEFAULT_DEDUP_MS,
}
let initialized = false
const dedupCache = new Map()   // `${trigger}|${text}` → lastEmitTs
const pendingQueue = []        // 静默时段积压的补播项

/** 清理过期的去重缓存项（仅当缓存超过上限时执行，避免每请求扫描） */
function pruneDedupCache() {
  if (dedupCache.size <= DEDUP_CACHE_MAX) return
  const now = Date.now()
  for (const [key, ts] of dedupCache) {
    if (now - ts > config.dedupMs) dedupCache.delete(key)
  }
  // 仍超上限 → 强制驱逐最旧条目（防止高频事件流下缓存无界）
  let overflow = dedupCache.size - DEDUP_CACHE_MAX
  for (const [key] of dedupCache) {
    if (overflow <= 0) break
    dedupCache.delete(key)
    overflow--
  }
}

/** 初始化（幂等） */
function init(options = {}) {
  if (initialized) return
  config = {
    silentStart: Number.isFinite(options.silentStart) ? options.silentStart : DEFAULT_SILENT_START,
    silentEnd: Number.isFinite(options.silentEnd) ? options.silentEnd : DEFAULT_SILENT_END,
    dedupMs: Number.isFinite(options.dedupMs) ? options.dedupMs : DEFAULT_DEDUP_MS,
  }
  initialized = true
}

function currentHour() {
  return new Date().getHours()
}

function isSilentHour() {
  const h = currentHour()
  const { silentStart, silentEnd } = config
  if (silentStart === silentEnd) return false // 相同 = 不启用静默
  if (silentStart < silentEnd) return h >= silentStart && h < silentEnd
  return h >= silentStart || h < silentEnd // 跨零点（如 22-8）
}

function isDup(trigger, text) {
  const key = `${trigger}|${text}`
  const last = dedupCache.get(key)
  if (last && Date.now() - last < config.dedupMs) return true
  dedupCache.set(key, Date.now())
  return false
}

/**
 * 主动发声决策入口
 * @param {{ trigger: string, text: string, intent?: string, surface?: object }} req
 * @returns {{ ok: boolean, reason?: string }}
 */
function notify(req) {
  try {
    if (!req || !req.trigger || !req.text) return { ok: false, reason: 'invalid_request' }
    const intent = req.intent || 'inform'

    pruneDedupCache()

    if (isDup(req.trigger, req.text)) return { ok: false, reason: 'dedup' }

    if (isSilentHour()) {
      if (pendingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = pendingQueue.shift()
        console.warn(`[proactive] 补播队列已达上限(${MAX_QUEUE_SIZE})，丢弃最旧项: ${dropped?.trigger || 'unknown'}`)
      }
      pendingQueue.push({ trigger: req.trigger, text: req.text, intent, ts: Date.now(), ...(req.surface ? { surface: req.surface } : {}) })
      return { ok: true, reason: 'silent_hours' }
    }

    const payload = { trigger: req.trigger, text: req.text, intent, ts: Date.now() }
    if (req.surface) payload.surface = req.surface
    broadcastEvent('proactive_speak', payload)
    return { ok: true }
  } catch (err) {
    console.error('[proactive] notify 失败:', err?.message || err)
    return { ok: false, reason: 'error' }
  }
}

function getQueue() { return pendingQueue.slice() }

/**
 * 仅返回不广播，误用将丢弃队列项；请用 flushAndBroadcast。
 * @returns {object[]} 被冲刷的队列项快照（已从内部队列中移除）
 */
function flushQueue() { return pendingQueue.splice(0) }

/** 冲刷补播队列并重新广播（白天唤醒后调用） */
function flushAndBroadcast() {
  const items = pendingQueue.splice(0)
  for (const item of items) {
    broadcastEvent('proactive_speak', { ...item, ts: Date.now() })
  }
  return items.length
}

function isSilentHourExported() { return isSilentHour() }

function getCacheSize() { return dedupCache.size }

function getSilentEnd() { return config.silentEnd }

module.exports = { init, notify, getQueue, flushQueue, flushAndBroadcast, isSilentHour: isSilentHourExported, getCacheSize, getSilentEnd }
