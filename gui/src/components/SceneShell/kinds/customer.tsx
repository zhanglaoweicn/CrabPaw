/**
 * CustomerCard — 客户跟进卡·过渡版（panel key: customerView, 2026-09-05）
 *
 * 数据来自 ShowCustomerPanel 发射的 surface 'customer-panel'：
 *   { customers: [{customer, totalSales, lastSaleDate, receivable}] }
 * 数据引擎 = business/card-queries.summarizeCustomers（v_sales/v_receivable 优先）。
 * 跟进状态/互动记录模型未建——本卡只做交易与应收的客户维度聚合。
 */

export interface CustomerSummary {
  customer: string
  totalSales?: number | null
  lastSaleDate?: string | null
  receivable?: number | null
}

export interface CustomerCardData {
  customers: CustomerSummary[]
  generatedAt?: number
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN')
}

export function CustomerCard({ data, onClose }: { data: CustomerCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.customers)) return null
  return (
    <div className="scene-card customer-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
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
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>👥 客户总览 · {data.customers.length}</div>
      {data.customers.length === 0 ? (
        <div style={{ fontSize: 14, color: 'var(--text-muted, #888)', padding: '8px 0', textAlign: 'center' }}>
          暂无客户交易数据
        </div>
      ) : (
        data.customers.map((c, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: i < data.customers.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
            <span style={{ fontSize: 15, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.customer}
              {c.lastSaleDate ? <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>最近成交 {c.lastSaleDate}</span> : null}
            </span>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>¥{fmtMoney(c.totalSales)}</span>
              {(c.receivable || 0) > 0 ? (
                <span style={{ display: 'block', fontSize: 13, color: 'var(--warn, #e6a23c)' }}>应收 ¥{fmtMoney(c.receivable)}</span>
              ) : null}
            </span>
          </div>
        ))
      )}
    </div>
  )
}
