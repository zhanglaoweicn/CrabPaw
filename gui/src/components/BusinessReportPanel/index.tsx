import { useEffect, useState, useCallback } from 'react'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { apiGet } from '../../lib/api'
import { Package, RefreshCw, FileSpreadsheet, HelpCircle, X } from 'lucide-react'

/**
 * BusinessReportPanel — 经营日报宿主卡（插件化体系首张业务卡, 2026-08-25）
 * 登记: panel-registry({key:'businessReport', surface:'business-panel', ui:'BusinessReportPanel'})
 * 数据: business 数据源（导入表 registry）+ DataPoint(import_history)。
 * 当前骨架: 显隐宿主 + 数据源/导入表概览 + 空态引导；四格/趋势/月选器等在切片3。
 */
export default function BusinessReportPanel() {
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [tableInfo, _setTableInfo] = useState<{ tables: Array<{ name: string; role: string | null; rowCount: number }> } | null>(null)
  const [sources, setSources] = useState<string[]>([])

  const load = useCallback(async () => {
    if (!visible) return
    setLoading(true)
    try {
      // 汇总视图只读（assembly）——含 business 源与台账概览；专用端点切片3
      const res = await apiGet('/api/plugins/assembly')
      if (res?.success) {
        const srcs = ((res as any).sources || []).map((s: any) => s.name)
        setSources(srcs.filter((n: string) => n === 'business'))
      }
    } catch { /* 骨架容错 */ }
    try {
      // 表格清单（本地 business registry）
      const res2 = await apiGet('/api/plugin-manager/list')
      void res2
    } catch { /* 预览容错 */ }
    setLoading(false)
  }, [visible])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // A1: 经 ui-command-registry 注册(旧 window.__businessPanel 退役; 补卸载清理)
    const unregisterBusiness = registerCommandHost('businessPanel', {
      setVisible: (v: boolean) => setVisible(v),
      getVisible: () => visible,
      reload: load,
    })
    return () => { unregisterBusiness() }
  }, [load, visible])

  if (!visible) return null

  return (
    <div className="theme-card p-5" style={{ position: 'fixed', right: 24, bottom: 24, width: 420, zIndex: 'var(--z-side-float)', maxHeight: '70vh', overflow: 'auto' }}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium flex items-center gap-2 theme-text-primary">
          <FileSpreadsheet className="w-5 h-5 theme-accent" />经营日报
        </h3>
        <div className="flex items-center gap-1">
          <button onClick={load} className="p-1.5 rounded theme-btn theme-btn-secondary" title="刷新"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
          <button onClick={() => setVisible(false)} className="p-1.5 rounded theme-btn theme-btn-secondary" title="关闭"><X className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {loading && <div className="text-xs theme-text-muted mb-3">刷新中…</div>}

      {sources.length > 0 ? (
        <div className="text-xs text-green-500 mb-3">✓ 数据源 business 已接入（导入表自动建表 → 自然语言查询）</div>
      ) : (
        <div className="mb-3 p-3 rounded-lg theme-bg-active flex items-start gap-2 text-sm theme-text-muted">
          <HelpCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            还没有经营数据。<br />
            <span className="text-xs">把 CSV/Excel 报表（如微信/支付宝账单、流水账）发给我——&quot;导入报表&quot; 即自动建表，之后说 &quot;生成经营日报&quot; 就有内容。</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="p-3 rounded-lg theme-bg-active">
          <div className="text-2xl font-bold theme-text-primary">{tableInfo?.tables?.length ?? '—'}</div>
          <div className="text-xs theme-text-muted">已导入数据表</div>
        </div>
        <div className="p-3 rounded-lg theme-bg-active">
          <div className="text-2xl font-bold theme-text-primary">{tableInfo?.tables ? tableInfo.tables.reduce((s, t) => s + (t.rowCount || 0), 0) : '—'}</div>
          <div className="text-xs theme-text-muted">累计数据行</div>
        </div>
      </div>

      <div className="mt-3 text-[11px] theme-text-muted flex items-center gap-1">
        <Package className="w-3 h-3" /> 由插件化管道注册（panel-registry · business 数据源 · gen:ui-registry）
      </div>
    </div>
  )
}
