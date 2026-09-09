import { describe, expect, it } from 'vitest'
import { statusToneOf } from './status'

describe('statusToneOf', () => {
  it('错误类语义 → danger（fail 补齐；大小写不敏感已由 SUCCESS 类设计覆盖，不增额外用例）', () => {
    for (const v of ['error', 'fail', 'failed', 'critical', 'offline', 'disconnected']) {
      expect(statusToneOf(v)).toBe('danger')
    }
  })
  it('警告类语义 → warn', () => {
    for (const v of ['warning', 'degraded', 'connecting', 'disabled']) {
      expect(statusToneOf(v)).toBe('warn')
    }
  })
  it('正常/连接 → success', () => {
    for (const v of ['ok', 'connected', 'active', 'healthy', 'enabled', 'loaded']) {
      expect(statusToneOf(v)).toBe('success')
    }
  })
  it('未知/空 → neutral', () => {
    expect(statusToneOf(undefined)).toBe('neutral')
    expect(statusToneOf(null)).toBe('neutral')
    expect(statusToneOf('anything-else')).toBe('neutral')
  })
})
