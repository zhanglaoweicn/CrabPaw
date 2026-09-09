/**
 * ContractExpiryCard — 合同到期卡（panel key: contractExpiry, 2026-09-05）
 *
 * 数据来自 ShowContractExpiryPanel 发射的 surface 'contract-expiry-panel'：
 *   { windowDays, contracts: [{customer, amount, expireDate, daysLeft, count?}] }
 * 数据引擎 = morning-briefing-service.listExpiringContracts（语义视图优先）。
 */

export interface ExpiringContract {
  customer?: string | null
  amount?: number | null
  expireDate: string
  daysLeft: number
  count?: number
}

export interface ContractExpiryCardData {
  windowDays: number
  contracts: ExpiringContract[]
  generatedAt?: number
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN')
}

function daysLeftText(d: number): string {
  if (d <= 0) return '今日到期'
  if (d <= 7) return `${d} 天后到期`
  return `${d} 天`
}

export function ContractExpiryCard({ data, onClose }: { data: ContractExpiryCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.contracts)) return null
  const windowDays = typeof data.windowDays === 'number' ? data.windowDays : 30
  return (
    <div className="scene-card contract-expiry-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
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
        {data.contracts.length > 0 ? `📅 合同到期 · 未来 ${windowDays} 天` : `📅 合同到期 · 未来 ${windowDays} 天无到期`}
      </div>
      {data.contracts.length === 0 ? (
        <div style={{ fontSize: 14, color: 'var(--text-muted, #888)', padding: '8px 0', textAlign: 'center' }}>
          窗口期内没有到期合同
        </div>
      ) : (
        data.contracts.map((c, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: i < data.contracts.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
            <span style={{ fontSize: 15, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.customer || '未标注对方'}
              <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>到期 {c.expireDate}</span>
            </span>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: c.daysLeft <= 7 ? 'var(--warn, #e6a23c)' : undefined }}>{daysLeftText(c.daysLeft)}</span>
              {c.amount != null ? <span style={{ display: 'block', fontSize: 13, opacity: 0.75 }}>¥{fmtMoney(c.amount)}</span> : null}
            </span>
          </div>
        ))
      )}
    </div>
  )
}
