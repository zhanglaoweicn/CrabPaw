import { useMemo, useState, useCallback, useEffect } from 'react'
import { apiPost, apiGet } from '../../lib/api'
import { extractCommodityPayload } from './extract-payload'
import { Search, RefreshCw, X, ArrowUpDown, Brain, ExternalLink, History, ImageIcon } from 'lucide-react'

/**
 * CommodityPanel — 商品查询卡（2026-08-25 插件管线首张"重交互+多模态"业务卡）
 * 数据: commodity 数据源（浏览器导航 + 多模态视觉模型截图解析）
 * 表格化: 名称/价格(可排序)/销量/店铺 + 截图预览 + 状态徽标 + 查询历史
 */
interface CommodityItem { name: string; price: number | null; sales: string; shop: string }
interface CommodityResult {
  ok: boolean; stage: string; items: CommodityItem[]; note?: string | null
  source?: string | null; query?: string; screenshot?: string
}
type SortKey = 'name' | 'price' | 'sales'

const SOURCES = ['京东商品搜索', '淘宝商品搜索', '苏宁易购商品搜索', '什么值得买', '当当图书搜索', '1688 商品搜索']

function sortItems(items: CommodityItem[], key: SortKey, dir: 1 | -1): CommodityItem[] {
  const arr = [...items]
  arr.sort((a, b) => {
    if (key === 'price') return (((a.price ?? -1) - (b.price ?? -1)) * dir)
    if (key === 'name') return a.name.localeCompare(b.name, 'zh') * dir
    const sa = a.sales.match(/\d+/)?.[0] || '0'
    const sb = b.sales.match(/\d+/)?.[0] || '0'
    return ((Number(sa) - Number(sb)) * dir)
  })
  return arr
}

export default function CommodityPanel() {
  const [visible, setVisible] = useState(false)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState(SOURCES[0])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CommodityResult | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('price')
  const [sortDir, setSortDir] = useState<1 | -1>(1)
  const [showScreenshot, setShowScreenshot] = useState(false)
  const [history, setHistory] = useState<Array<{ query: string; source: string; count: number; created_at: number }>>([])

  const openLogin = useCallback(async () => {
    try { await apiPost('/api/commodity/login', { source }); } catch { /* 浏览器端反馈 */ }
  }, [source])

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiGet('/api/commodity/history')
      // 后端返回扁平 {success,rows}，api.ts 包装后业务字段在 res.data 层
      const rows = res?.success ? ((res as any)?.data?.rows ?? []) : []
      if (Array.isArray(rows)) setHistory(rows.slice(0, 10))
    } catch { /* 历史可选 */ }
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  const runSearch = useCallback(async (q?: string) => {
    const qq = (q ?? query).trim()
    if (!qq || busy) return
    setBusy(true); setResult(null)
    try {
      const res = await apiPost('/api/commodity/search', { query: qq, source })
      if (res?.success) setResult(extractCommodityPayload(res) as any)
      else setResult({ ok: false, stage: 'error', items: [], note: res?.error || '查询失败' })
      loadHistory()
    } catch (e: any) {
      setResult({ ok: false, stage: 'error', items: [], note: '后端未响应：' + (e?.message || '') })
    } finally { setBusy(false) }
  }, [query, source, busy, loadHistory])

  const sorted = useMemo(() => result ? sortItems(result.items, sortKey, sortDir) : [], [result, sortKey, sortDir])
  const toggleSort = useCallback((k: SortKey) => {
    setSortKey(k)
    setSortDir(prev => (sortKey === k ? (prev === 1 ? -1 : 1) : 1))
  }, [sortKey])

  const stageBadge = () => {
    if (!result) return null
    if (result.stage === 'browser_unavailable') return <span className="text-xs text-amber-500">⚠ 浏览器自动化不可用（安装 Chromium 后可查询）</span>
    if (result.stage === 'error') return <span className="text-xs text-red-500">✕ 查询失败</span>
    if (result.note?.includes('登录')) return <span className="text-xs text-amber-500">🔒 {result.note} <button className="ml-1 px-2 py-0.5 rounded theme-btn theme-btn-secondary" onClick={openLogin}>打开登录页</button><span className="text-[10px] ml-1">(persistent 会话—登录一次自动复用)</span></span>
    return null
  }

  if (!visible) return null

  return (
    <div className="theme-card p-5" style={{ position: 'fixed', right: 24, bottom: 24, width: 560, zIndex: 'var(--z-side-float)', maxHeight: '78vh', overflow: 'auto' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium flex items-center gap-2 theme-text-primary">
          <Search className="w-5 h-5 theme-accent" />商品查询
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-400 border border-purple-500/25 flex items-center gap-1"><Brain className="w-3 h-3" />多模态视觉解析</span>
        </h3>
        <div className="flex items-center gap-1">
          <button onClick={loadHistory} className="p-1.5 rounded theme-btn theme-btn-secondary" title="刷新"><RefreshCw className="w-3.5 h-3.5" /></button>
          <button onClick={() => setVisible(false)} className="p-1.5 rounded theme-btn theme-btn-secondary"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* 搜索区 */}
      <div className="flex gap-2 mb-3">
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          placeholder="输入商品关键词（如：华为 Mate60 / 空气炸锅）"
          className="flex-1 px-3 py-2 rounded-lg theme-bg-tertiary text-sm theme-text-primary outline-none focus:border-[var(--color-accent)]"
        />
        <select value={source} onChange={(e) => setSource(e.target.value)}
          className="px-2 py-1 rounded-lg theme-bg-tertiary text-xs theme-text-muted outline-none">
          {SOURCES.map((s) => <option key={s} value={s}>{s.replace('商品搜索', '')}</option>)}
        </select>
        <button onClick={() => runSearch()} disabled={busy}
          className="px-4 py-2 rounded-lg text-xs font-medium theme-btn theme-btn-primary disabled:opacity-50 flex items-center gap-1">
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} 查询
        </button>
      </div>

      {stageBadge() && <div className="mb-2">{stageBadge()}</div>}
      {result?.note && !result.note.includes('登录') && <div className="mb-2 text-xs theme-text-muted">{result.note}</div>}

      {/* 截图预览（多模态原始证据） */}
      {result?.screenshot && (
        <details className="mb-2" open={showScreenshot} onToggle={(e) => setShowScreenshot((e.target as HTMLDetailsElement).open)}>
          <summary className="text-xs theme-text-muted cursor-pointer flex items-center gap-1"><ImageIcon className="w-3 h-3" /> 页面截图（视觉解析依据）</summary>
          <img src={`data:image/png;base64,${result.screenshot}`} alt="商品页面截图" style={{ width: '100%', borderRadius: 8, marginTop: 6 }} />
        </details>
      )}

      {/* 结果表 */}
      {sorted.length > 0 ? (
        <div className="rounded-lg overflow-hidden border theme-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="theme-bg-tertiary theme-text-muted">
                <th className="px-2 py-2 text-left cursor-pointer hover:theme-text-primary" onClick={() => toggleSort('name')}><span className="flex items-center gap-1">名称<ArrowUpDown className="w-3 h-3" /></span></th>
                <th className="px-2 py-2 text-right cursor-pointer hover:theme-text-primary" onClick={() => toggleSort('price')}><span className="flex items-center justify-end gap-1">价格<ArrowUpDown className="w-3 h-3" /></span></th>
                <th className="px-2 py-2 text-right cursor-pointer hover:theme-text-primary" onClick={() => toggleSort('sales')}>销量</th>
                <th className="px-2 py-2 text-left">店铺</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((it, i) => (
                <tr key={i} className="border-t theme-border hover:brightness-105">
                  <td className="px-2 py-1.5 theme-text-primary max-w-[240px] truncate" title={it.name}>{it.name}</td>
                  <td className="px-2 py-1.5 text-right" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{it.price != null ? `¥${it.price.toLocaleString('zh-CN')}` : '—'}</td>
                  <td className="px-2 py-1.5 text-right theme-text-muted">{it.sales || '—'}</td>
                  <td className="px-2 py-1.5 theme-text-muted max-w-[130px] truncate">{it.shop || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : busy ? <div className="py-6 text-center text-xs theme-text-muted">浏览器导航中 → 截图 → 视觉模型提取…</div>
        : result?.items?.length === 0 ? <div className="py-6 text-center text-xs theme-text-muted">未提取到商品条目（可切换数据源或换关键词）</div>
        : null}

      {/* 查询历史 */}
      {history.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs theme-text-muted cursor-pointer flex items-center gap-1"><History className="w-3 h-3" /> 查询历史（{history.length}）</summary>
          <div className="mt-2 space-y-1">
            {history.map((h) => (
              <div key={h.created_at} className="flex items-center gap-2 text-xs">
                <button className="text-blue-400 hover:underline" onClick={() => { setQuery(h.query); runSearch(h.query) }}>{h.query}</button>
                <span className="theme-text-muted text-[10px]">{h.source?.replace('商品搜索', '')} · {h.count} 条</span>
                <span className="theme-text-muted/50 text-[10px]">{new Date(h.created_at).toLocaleTimeString('zh-CN')}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* 打开原站 */}
      {result?.source && (
        <div className="mt-3 text-[11px] theme-text-muted flex items-center gap-1">
          <ExternalLink className="w-3 h-3" /> 数据源：{result.source}（已在浏览器中打开；原站可继续操作）
        </div>
      )}
    </div>
  )
}
