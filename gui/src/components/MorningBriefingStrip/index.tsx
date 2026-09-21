/**
 * MorningBriefingStrip — 晨报带（2026-09-21 创新-A：VoiceShell 零输入信息层）
 *
 * 老板一句话不说也能获得价值：打开 shell 即见今日日程/应收逾期/临期合同/
 * 本月营收环比。数据来自既有服务聚合端点 /api/briefing/today（语义视图 v_*），
 * 点击任一指标块直接向对话流发出对应追问（onAsk → handleCommandChip）。
 *
 * 诚实降级：单源失败该块不显示；全部无数据整条不渲染——不用假数字占位。
 */
import { useEffect, useState } from 'react'
import { apiGet } from '../../lib/api'

interface BriefingSnapshot {
  revenue?: { month?: number | null; prevMonth?: number | null; yesterday?: number | null; deltaPct?: number | null }
  risks?: { receivableOverdue?: number | null; totalReceivable?: number | null; contractsExpiring?: number | null }
}
interface BriefingData {
  date: string
  snapshot: BriefingSnapshot | null
  receivables: { count: number; amount: number; items: Array<{ customer?: string | null; amount?: number | null; expireDate?: string | null }> } | null
  contracts: { count: number; items: Array<{ customer?: string | null; expireDate?: string | null }> } | null
  schedule: { count: number; items: Array<{ title?: string; startTime?: string | null; location?: string | null }> } | null
  sources: Record<string, { ok: boolean; detail?: string }>
}

const REFRESH_MS = 5 * 60 * 1000

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—'
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`
  return String(Math.round(v))
}

export function MorningBriefingStrip({ onAsk }: { onAsk: (text: string) => void }) {
  const [data, setData] = useState<BriefingData | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await apiGet<BriefingData>('/api/briefing/today')
        if (alive && r?.success && r.data) setData(r.data)
      } catch {
        // 拉取失败保持上一份数据；首次失败则整条隐藏（后端未就绪/无业务库）
      }
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  if (!data) return null
  const rev = data.snapshot?.revenue
  const hasReceivables = !!data.receivables && data.receivables.count > 0
  const hasContracts = !!data.contracts && data.contracts.count > 0
  const hasSchedule = !!data.schedule
  const hasRevenue = !!rev && rev.month != null
  // 全部源都无内容 → 整条不渲染（诚实：没有数据不装作有）
  if (!hasReceivables && !hasContracts && !hasSchedule && !hasRevenue) return null

  const blockStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.85)',
    fontSize: 12, lineHeight: 1.3, cursor: 'pointer', whiteSpace: 'nowrap',
  }
  const labelStyle: React.CSSProperties = { opacity: 0.55 }
  const strongStyle: React.CSSProperties = { fontWeight: 600 }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '6px 12px 2px', fontSize: 12,
      }}
      data-briefing-date={data.date}
    >
      <span style={{ opacity: 0.5, marginRight: 2 }}>☀ 今日</span>
      {hasSchedule && (
        <button
          type="button" style={blockStyle}
          onClick={() => onAsk('打开日程')}
          title={(data.schedule!.items || []).map(i => i.title).filter(Boolean).join(' / ') || '今日日程'}
        >
          <span style={labelStyle}>日程</span>
          <span style={strongStyle}>{data.schedule!.count}</span>
          <span style={labelStyle}>项</span>
        </button>
      )}
      {hasReceivables && (
        <button
          type="button" style={{ ...blockStyle, borderColor: 'rgba(255,120,100,0.35)' }}
          onClick={() => onAsk('看看逾期应收明细')}
          title={(data.receivables!.items || []).map(i => `${i.customer || '?'} ¥${fmtMoney(i.amount)}`).join(' / ')}
        >
          <span style={labelStyle}>应收逾期</span>
          <span style={{ ...strongStyle, color: '#ff8a7a' }}>{data.receivables!.count}</span>
          <span style={labelStyle}>笔 · ¥{fmtMoney(data.receivables!.amount)}</span>
        </button>
      )}
      {hasContracts && (
        <button
          type="button" style={blockStyle}
          onClick={() => onAsk('临期合同有哪些')}
          title={(data.contracts!.items || []).map(i => `${i.customer || '?'} ${i.expireDate || ''}`).join(' / ')}
        >
          <span style={labelStyle}>临期合同</span>
          <span style={strongStyle}>{data.contracts!.count}</span>
          <span style={labelStyle}>份</span>
        </button>
      )}
      {hasRevenue && (
        <button
          type="button" style={blockStyle}
          onClick={() => onAsk('本月经营情况怎么样')}
          title={`本月 ¥${fmtMoney(rev!.month)} · 上月 ¥${fmtMoney(rev!.prevMonth)}${rev!.deltaPct != null ? ` · 环比 ${rev!.deltaPct > 0 ? '+' : ''}${rev!.deltaPct}%` : ''}`}
        >
          <span style={labelStyle}>本月营收</span>
          <span style={strongStyle}>¥{fmtMoney(rev!.month)}</span>
          {rev!.deltaPct != null && (
            <span style={{ color: rev!.deltaPct >= 0 ? '#7ad39e' : '#ff8a7a', fontWeight: 600 }}>
              {rev!.deltaPct >= 0 ? '↑' : '↓'}{Math.abs(rev!.deltaPct)}%
            </span>
          )}
        </button>
      )}
    </div>
  )
}
