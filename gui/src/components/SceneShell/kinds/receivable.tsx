/**
 * ReceivableCard — 应收账款卡（panel key: receivable, 2026-09-05）
 *
 * 数据来自 ShowReceivablePanel 发射的 surface 'receivable-panel'：
 *   { overdueCount, totalOverdue, customers: [{customer, amount, dueDate, overdueDays}] }
 * 数据引擎 = morning-briefing-service.listOverdueReceivables（语义视图优先）。
 */

export interface ReceivableCustomer {
  customer: string
  amount: number
  dueDate?: string | null
  overdueDays?: number | null
}

export interface ReceivableCardData {
  overdueCount: number
  totalOverdue?: number | null
  customers?: ReceivableCustomer[]
  generatedAt?: number
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN')
}

export function ReceivableCard({ data, onClose }: { data: ReceivableCardData; onClose?: () => void }) {
  if (!data || typeof data.overdueCount !== 'number') return null
  const customers = Array.isArray(data.customers) ? data.customers : []
  return (
    <div className="scene-card receivable-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
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
        {data.overdueCount > 0 ? '⚠️ 应收账款 · 逾期提醒' : '✅ 应收账款 · 无逾期'}
      </div>
      <div style={{ display: 'flex', gap: 20, marginBottom: customers.length ? 10 : 0 }}>
        <div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>逾期笔数</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: data.overdueCount > 0 ? 'var(--warn, #e6a23c)' : undefined }}>{data.overdueCount}</div>
        </div>
        <div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>逾期总额</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>¥{fmtMoney(data.totalOverdue)}</div>
        </div>
      </div>
      {customers.map((c, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: 15, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.customer}
            {c.dueDate ? <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>
              到期 {c.dueDate}{c.overdueDays != null ? ` · 逾期 ${c.overdueDays} 天` : ''}
            </span> : null}
          </span>
          <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>¥{fmtMoney(c.amount)}</span>
        </div>
      ))}
    </div>
  )
}
