import { describe, test, expect } from 'vitest'
import { extractCommodityPayload } from './extract-payload'

describe('extractCommodityPayload', () => {
  test('扁平后端响应经 api.ts 包装后, 字段在 data 层', () => {
    const res = { success: true, data: { items: [{ name: 'x', price: 1 }], stage: 'done', note: '', screenshot: '', source: 'jc' } }
    const p = extractCommodityPayload(res as any)
    expect(p.items).toHaveLength(1)
    expect(p.stage).toBe('done')
  })
  test('data 缺失时不抛错, items 兜底空数组', () => {
    const p = extractCommodityPayload({ success: true } as any)
    expect(p.items).toEqual([])
  })
  test('失败响应返回空 payload + error 透传', () => {
    const p = extractCommodityPayload({ success: false, error: 'boom' } as any)
    expect(p.items).toEqual([])
    expect((p as any).error).toBe('boom')
  })
})
