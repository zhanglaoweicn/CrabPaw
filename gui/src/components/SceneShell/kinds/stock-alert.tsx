/**
 * StockAlertCard — 库存预警卡（panel key: stockAlert, 2026-09-05）
 *
 * 数据来自 ShowStockAlertPanel 发射的 surface 'stock-alert-panel'：
 *   { alerts: [{product, current, safety, gap}] }
 * 数据引擎 = business/card-queries.listStockAlerts（语义视图优先）。
 * 约定：导入的库存表需含"安全库存"列（canonical: safety）。
 */

export interface StockAlertItem {
  product?: string | null
  current: number
  safety: number
  gap: number
}

export interface StockAlertCardData {
  alerts: StockAlertItem[]
  generatedAt?: number
}

export function StockAlertCard({ data, onClose }: { data: StockAlertCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.alerts)) return null
  return (
    <div className="scene-card stock-alert-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
      {onClose && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 6,
            border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.06)',
            color: 'var(--text-muted, #999)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, zIndex: 2,
          }}
          title="关闭"
        >✕</button>
      )}
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
        {data.alerts.length > 0 ? `📦 库存预警 · ${data.alerts.length} 项低于安全线` : '📦 库存预警 · 无预警'}
      </div>
      {data.alerts.length === 0 ? (
        <div style={{ fontSize: 14, color: 'var(--text-muted, #888)', padding: '8px 0', textAlign: 'center' }}>
          当前库存均高于安全线
        </div>
      ) : (
        data.alerts.map((a, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: i < data.alerts.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
            <span style={{ fontSize: 15, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.product || '(未标注商品)'}
              <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>当前 {a.current} / 安全线 {a.safety}</span>
            </span>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--warn, #e6a23c)', whiteSpace: 'nowrap' }}>
              缺 {a.gap}
            </span>
          </div>
        ))
      )}
    </div>
  )
}
