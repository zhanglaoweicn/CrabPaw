/**
 * BusinessBriefingCard — 经营简报卡（panel key: businessBriefing, 2026-09-05）
 *
 * 数据来自 ShowBusinessBriefingPanel 发射的 surface 'business-briefing-panel'：
 *   { date, revenue: {month, prevMonth, yesterday, deltaPct}, risks: {receivableOverdue, totalReceivable, contractsExpiring} }
 * 数据引擎 = morning-briefing-service.buildBriefingSnapshot（语义视图优先）。
 */

export interface BriefingRevenue {
  month?: number | null
  prevMonth?: number | null
  yesterday?: number | null
  deltaPct?: number | null
}

export interface BriefingRisks {
  receivableOverdue?: number
  totalReceivable?: number | null
  contractsExpiring?: number
}

export interface BusinessBriefingCardData {
  date?: string
  revenue: BriefingRevenue
  risks?: BriefingRisks
  generatedAt?: number
}

function fmtMoney(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN')
}

export function BusinessBriefingCard({ data, onClose }: { data: BusinessBriefingCardData; onClose?: () => void }) {
  if (!data || !data.revenue) return null
  const rev = data.revenue
  const risks = data.risks || {}
  const delta = rev.deltaPct
  const hasRisk = (risks.receivableOverdue || 0) > 0 || (risks.contractsExpiring || 0) > 0
  return (
    <div className="scene-card business-briefing-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
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
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 2 }}>📊 经营简报</div>
      {data.date ? <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 10 }}>{data.date}</div> : <div style={{ marginBottom: 10 }} />}
      <div style={{ display: 'flex', gap: 20, marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>本月营收</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            ¥{fmtMoney(rev.month)}
            {delta != null ? (
              <span style={{ fontSize: 14, fontWeight: 600, marginLeft: 6, color: delta >= 0 ? 'var(--ok, #67c23a)' : 'var(--warn, #e6a23c)' }}>
                {delta >= 0 ? '↑' : '↓'}{Math.abs(delta)}%
              </span>
            ) : null}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>昨日营收</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>¥{fmtMoney(rev.yesterday)}</div>
        </div>
      </div>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: hasRisk ? 6 : 0 }}>
        上月同期 ¥{fmtMoney(rev.prevMonth)}
      </div>
      {hasRisk ? (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 8, fontSize: 14 }}>
          {(risks.receivableOverdue || 0) > 0 ? (
            <div style={{ color: 'var(--warn, #e6a23c)', padding: '2px 0' }}>
              ⚠️ {risks.receivableOverdue} 笔应收逾期{risks.totalReceivable != null ? `（约 ¥${fmtMoney(risks.totalReceivable)}）` : ''}
            </div>
          ) : null}
          {(risks.contractsExpiring || 0) > 0 ? (
            <div style={{ padding: '2px 0' }}>
              📅 {risks.contractsExpiring} 份合同 7 天内到期
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
