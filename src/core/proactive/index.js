/**
 * Proactive 主动沟通决策层 v2（2026-09-18 LoopX P0 收编）
 *
 * 职责: 统一入口 proactive.notify() — 决策"是否发声"、打扰抑制、补播队列。
 * 表达层由前端负责（TTS 播报 + 场景卡片），本模块只输出决策。
 *
 * v2 变更：判定逻辑下沉到 kernel.js（五连判定：quota/gate/dedup/intent/speak，
 * 三不变量 I1 quiet 不计数 / I2 gate 具体确认 / I3 单一真值落盘）。本文件退化为
 * v1 兼容门面：notify() = kernel.propose(legacy profile) + 广播 + 补播队列。
 * 12 条 v1 行为契约见 proactive.test.js，逐条保留。
 *
 * init 可选持久化: { persist: true } → kernel 落盘 proactive-kernel.json
 * （去重/配额/确认跨重启有效）；不传则纯内存（存量测试零污染）。
 */
const { broadcastEvent } = require('../sse-broadcast')
const kernel = require('./kernel')

const DEFAULT_SILENT_START = 22  // 22:00 起静默
const DEFAULT_SILENT_END = 8     // 08:00 结束静默
const DEFAULT_DEDUP_MS = 30 * 60 * 1000 // 同一事件 30 分钟去重
const MAX_QUEUE_SIZE = 50        // 补播队列上限，超出丢弃最旧

let config = {
  silentStart: DEFAULT_SILENT_START,
  silentEnd: DEFAULT_SILENT_END,
  dedupMs: DEFAULT_DEDUP_MS,
}
let initialized = false
const pendingQueue = []        // 静默时段积压的补播项

/** 初始化（幂等） */
function init(options = {}) {
  if (initialized) return
  config = {
    silentStart: Number.isFinite(options.silentStart) ? options.silentStart : DEFAULT_SILENT_START,
    silentEnd: Number.isFinite(options.silentEnd) ? options.silentEnd : DEFAULT_SILENT_END,
    dedupMs: Number.isFinite(options.dedupMs) ? options.dedupMs : DEFAULT_DEDUP_MS,
  }
  kernel.configure({
    silentStart: config.silentStart,
    silentEnd: config.silentEnd,
    dedupMs: config.dedupMs,
    profile: 'legacy', // notify 兼容路径：无配额/无豁免（native 由收编服务显式开启）
  })
  if (options.persist) {
    const { getDataDir } = require('../config')
    const path = require('path')
    kernel.configure({ statePath: path.join(getDataDir(), kernel.STATE_FILENAME) })
  } else if (typeof options.statePath === 'string' && options.statePath) {
    kernel.configure({ statePath: options.statePath })
  }
  initialized = true
}

/**
 * 主动发声决策入口（v1 兼容签名与行为）
 * @param {{ trigger: string, text: string, intent?: string, surface?: object }} req
 * @returns {{ ok: boolean, reason?: string }} speak 无 reason；silent_hours 已入补播队列
 */
function notify(req) {
  try {
    if (!req || !req.trigger || !req.text) return { ok: false, reason: 'invalid_request' }
    const intent = req.intent || 'inform'

    const verdict = kernel.propose({
      trigger: req.trigger,
      text: req.text,
      intent,
      dedupMs: req.dedupMs, // 提案级去重窗（收编服务用，如场景提醒 1h）
      cap: req.cap,         // 提案级配额覆盖
      native: req.native === true, // native：配额/gate 豁免分档生效（见 kernel.js）
    })

    switch (verdict.decision) {
      case 'speak': {
        const payload = { trigger: req.trigger, text: req.text, intent, ts: Date.now() }
        if (req.surface) payload.surface = req.surface
        broadcastEvent('proactive_speak', payload)
        kernel.spend(req.trigger)
        return { ok: true }
      }
      case 'queued': {
        if (pendingQueue.length >= MAX_QUEUE_SIZE) {
          const dropped = pendingQueue.shift()
          console.warn(`[proactive] 补播队列已达上限(${MAX_QUEUE_SIZE})，丢弃最旧项: ${dropped?.trigger || 'unknown'}`)
        }
        pendingQueue.push({ trigger: req.trigger, text: req.text, intent, ts: Date.now(), ...(req.surface ? { surface: req.surface } : {}) })
        return { ok: true, reason: 'silent_hours' }
      }
      case 'gate':
        return { ok: false, reason: 'gate' }
      case 'quiet':
        return { ok: false, reason: 'dedup' }
      case 'deny':
        return { ok: false, reason: verdict.reason || 'deny' }
      default:
        return { ok: false, reason: 'error' }
    }
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

/** 冲刷补播队列并重新广播（白天唤醒后调用）；投递完成逐条记账（I1） */
function flushAndBroadcast() {
  const items = pendingQueue.splice(0)
  for (const item of items) {
    broadcastEvent('proactive_speak', { ...item, ts: Date.now() })
    kernel.spend(item.trigger)
  }
  return items.length
}

function getCacheSize() { return kernel.stats().dedupCount }

function getSilentEnd() { return config.silentEnd }

module.exports = { init, notify, getQueue, flushQueue, flushAndBroadcast, isSilentHour: kernel.isSilentHour, getCacheSize, getSilentEnd }
