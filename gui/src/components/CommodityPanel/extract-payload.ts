/** 从 api.ts requestFetch 包装后的响应中提取商品查询业务载荷。
 *  后端返回扁平 {success,...result}，api.ts 会把它整体装进 res.data——
 *  直接读 res.items 是 undefined（P0 崩溃根因）。 */
export function extractCommodityPayload(res: any): {
  items: any[]; stage?: string; note?: string; screenshot?: string; source?: string; error?: string
} {
  if (!res?.success) return { items: [], error: res?.error }
  const payload = res?.data && typeof res.data === 'object' ? res.data : {}
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    stage: payload.stage,
    note: payload.note,
    screenshot: payload.screenshot,
    source: payload.source,
  }
}
