import { describe, test, expect } from 'vitest'
import { isTerminalCollabStatus } from './collab-terminal'

describe('collab 终态判定', () => {
  test('done/error/timeout/cancelled 都是终态', () => {
    expect(isTerminalCollabStatus('done')).toBe(true)
    expect(isTerminalCollabStatus('error')).toBe(true)
    expect(isTerminalCollabStatus('timeout')).toBe(true)
    expect(isTerminalCollabStatus('cancelled')).toBe(true)
  })
  test('running/pending/undefined 非终态', () => {
    expect(isTerminalCollabStatus('running')).toBe(false)
    expect(isTerminalCollabStatus(undefined)).toBe(false)
  })
})
