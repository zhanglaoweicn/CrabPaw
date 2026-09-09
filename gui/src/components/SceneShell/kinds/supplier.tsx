/**
 * SupplierCard — 供应商档案卡（panel key: supplierProfile, 2026-09-05）
 *
 * 数据来自 ShowSupplierPanel 发射的 surface 'supplier-panel'：
 *   { supplier, purchases: [{supplier, totalPurchase, orderCount, lastPurchaseDate}],
 *     enterprise: {queried, success} | null, contacts: {source, count, items} | null,
 *     larkConfigured }
 * 采购区块 = card-queries.summarizeSuppliers（v_purchase 优先）；工商区块走
 * 既有 EnterpriseQuery（结构化企业卡另经 'enterprise-card' surface 推送）。
 */

export interface SupplierSummary {
  supplier: string
  totalPurchase?: number | null
  orderCount?: number
  lastPurchaseDate?: string | null
}

export interface SupplierCardData {
  supplier?: string | null
  purchases: SupplierSummary[]
  enterprise?: { queried: boolean; success: boolean } | null
  contacts?: { source: string; count: number; items: any[] } | null
  larkConfigured?: boolean
  generatedAt?: number
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN')
}

export function SupplierCard({ data, onClose }: { data: SupplierCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.purchases)) return null
  const single = !!data.supplier
  const secTitle: React.CSSProperties = { fontSize: 13, opacity: 0.65, margin: '10px 0 4px' }
  return (
    <div className="scene-card supplier-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
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
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
        🏭 {single ? `供应商档案 · ${data.supplier}` : `供应商采购汇总 · ${data.purchases.length} 家`}
      </div>
      {data.purchases.length === 0 ? (
        <div style={{ fontSize: 14, color: 'var(--text-muted, #888)', padding: '8px 0', textAlign: 'center' }}>
          暂无采购记录（导入采购报表后自动聚合）
        </div>
      ) : (
        data.purchases.map((p, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderBottom: i < data.purchases.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
            <span style={{ fontSize: 15, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.supplier}
              {p.lastPurchaseDate ? <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>最近采购 {p.lastPurchaseDate}</span> : null}
            </span>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>¥{fmtMoney(p.totalPurchase)}</span>
              <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>{p.orderCount ?? 0} 单</span>
            </span>
          </div>
        ))
      )}

      {data.enterprise ? (
        <>
          <div style={secTitle}>工商信息</div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            {data.enterprise.success ? '企业工商信息卡已同步推送（可查看股东/风险等）。' : '工商查询未成功，可稍后重试。'}
          </div>
        </>
      ) : null}

      {data.contacts ? (
        <>
          <div style={secTitle}>联系人（{data.contacts.source} · {data.contacts.count} 条）</div>
          {data.contacts.items.slice(0, 5).map((it: any, i: number) => (
            <div key={i} style={{ fontSize: 13, opacity: 0.8, padding: '2px 0' }}>
              {typeof it === 'string' ? it : JSON.stringify(it).slice(0, 80)}
            </div>
          ))}
        </>
      ) : (
        <div style={secTitle}>联系人（Lark Bitable）</div>
      )}
      {!data.contacts && !data.larkConfigured ? (
        <div style={{ fontSize: 12, opacity: 0.55 }}>提示：配置飞书应用后可从多维表格拉取供应商联系人。</div>
      ) : null}
    </div>
  )
}
