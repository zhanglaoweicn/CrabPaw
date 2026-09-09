// 2026-08-27 管理舱视觉统一: 状态语义→tone 映射(绿=正常/黄=警告/红=错误/灰=停用)。
export type StatusTone = 'success' | 'warn' | 'danger' | 'neutral'

const DANGER = new Set(['error', 'fail', 'failed', 'critical', 'offline', 'disconnected', 'crash', 'fatal'])
const WARN = new Set(['warning', 'degraded', 'connecting', 'disabled', 'stopped', 'timeout'])
const SUCCESS = new Set(['ok', 'connected', 'active', 'healthy', 'enabled', 'loaded', 'running'])

export function statusToneOf(value: unknown): StatusTone {
  const v = String(value ?? '').toLowerCase()
  if (!v) return 'neutral'
  if (DANGER.has(v)) return 'danger'
  if (WARN.has(v)) return 'warn'
  if (SUCCESS.has(v)) return 'success'
  return 'neutral'
}
