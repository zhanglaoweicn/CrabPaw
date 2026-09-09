/**
 * EnterpriseCard — 企业信息卡片（kind 'enterprise'，2026-08-14 新增）
 *
 * 数据来自后端 EnterpriseQuery 工具发射的 scene surface 'enterprise-card'：
 *   { basic: { name, legalPerson, status, regCapital, establishedDate, industry, regAddress },
 *     shareholders: [{ name, ratio }],
 *     risks: [{ level, type, count }], riskScore, source, disclaimer }
 *
 * 布局对齐 person_card/股票卡：名称+状态、工商信息行、股东 chips、风险徽标+评分。
 * 空态守卫：basic.name 缺失不渲染。
 */

export interface EnterpriseCardData {
  basic: {
    name?: string
    legalPerson?: string
    status?: string
    regCapital?: string
    establishedDate?: string
    industry?: string
    regAddress?: string
  }
  shareholders: Array<{ name: string; ratio: string }>
  risks: Array<{ level: string; type: string; count?: number }>
  riskScore: number | null
  source?: string
  disclaimer?: string
}

const RISK_LEVEL_COLORS: Record<string, string> = {
  高: '#ef4444',
  中: '#f59e0b',
  低: '#22c55e',
}

export default function EnterpriseCard({ data, onClose }: { data: EnterpriseCardData; onClose?: () => void }) {
  if (!data || !data.basic || !data.basic.name) return null
  const b = data.basic
  const rows: Array<[string, string]> = [
    ['法定代表人', b.legalPerson || '—'],
    ['经营状态', b.status || '—'],
    ['注册资本', b.regCapital || '—'],
    ['成立日期', b.establishedDate || '—'],
    ['所属行业', b.industry || '—'],
    ['注册地址', b.regAddress || '—'],
  ]
  const score = data.riskScore
  const scoreColor = score == null ? '#94a3b8' : score >= 60 ? '#ef4444' : score >= 30 ? '#f59e0b' : '#22c55e'
  return (
    <div className="scene-card enterprise-card" style={{ padding: '14px 16px', minWidth: 320, maxHeight: 420, overflow: 'auto', position: 'relative' }}>
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
      {/* 名称 + 状态 + 风险评分 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #eee)' }}>🏢 {b.name}</div>
          {b.status && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{b.status}</div>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted, #888)' }}>风险评分</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: scoreColor, fontFamily: 'Consolas, monospace' }}>
            {score == null ? '—' : score}
          </div>
        </div>
      </div>

      {/* 工商信息行 */}
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12.5, lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text-muted, #888)', flexShrink: 0, width: 72 }}>{label}</span>
          <span style={{ color: 'var(--text-secondary, #ccc)', wordBreak: 'break-all', minWidth: 0 }}>{value}</span>
        </div>
      ))}

      {/* 股东 chips */}
      {data.shareholders.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 4 }}>主要股东</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.shareholders.map((s, i) => (
              <span key={i} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 999,
                background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary, #ccc)',
              }}>
                {s.name}{s.ratio ? ` · ${s.ratio}` : ''}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 风险列表 */}
      {data.risks.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 4 }}>风险项</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {data.risks.map((r, i) => {
              const c = RISK_LEVEL_COLORS[r.level] || '#94a3b8'
              return (
                <span key={i} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 999,
                  background: `${c}1a`, border: `1px solid ${c}55`, color: c,
                }}>
                  {r.level}·{r.type}{r.count != null ? ` ×${r.count}` : ''}
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>
        {data.source ? `数据源：${data.source} · ` : ''}{data.disclaimer || '信息仅供参考，不构成商业建议。'}
      </div>
    </div>
  )
}
