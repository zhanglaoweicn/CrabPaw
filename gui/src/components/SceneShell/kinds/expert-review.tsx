/**
 * ExpertReviewCard — 评审投票卡（kind: expert_review, P4）
 * 每位专家一行（✓ 名字 + 状态 + 时长）+ 结论合成区；追问按钮触发语音追问。
 * 数据源：collab-orbit 完成态聚合（toReviewData）。
 */
import { resolvePersona } from '../../../lib/expert-persona'

export interface ExpertReviewData {
  agents: { id?: string; name: string; status: string; duration?: number }[]
  conclusion: string
  ts: number
}

export function ExpertReviewCard({ data, onAsk }: { data: ExpertReviewData; onAsk?: (text: string) => void }) {
  return (
    <div className="glass-panel" style={{ padding: '14px 16px', minWidth: 260, maxWidth: 340 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#eee' }}>专家评审</span>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 999, color: '#f97316', border: '1px solid rgba(249,115,22,0.4)', background: 'rgba(249,115,22,0.1)' }}>
          {data.agents.length} 位完成
        </span>
      </div>

      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {data.agents.map((a, idx) => {
          const p = resolvePersona(a.name)
          return (
            <div key={a.id || `${a.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
              <span style={{ color: '#4caf50' }}>✓</span>
              <span style={{ color: '#ccc', minWidth: 64 }}>{p.label}</span>
              <span style={{ flex: 1, color: '#666', fontSize: 10 }}>
                {a.status === 'done' ? `完成 · ${((a.duration || 0) / 1000).toFixed(1)}s` : a.status}
              </span>
            </div>
          )
        })}
      </div>

      {/* 结论合成区 */}
      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.15)' }}>
        <div style={{ fontSize: 14, color: '#f97316', fontWeight: 600, marginBottom: 4 }}>结论合成</div>
        <div style={{ fontSize: 14, color: '#ccc', lineHeight: 1.5 }}>
          {data.conclusion || '全部专家已就位，结论生成中…'}
        </div>
      </div>

      {typeof onAsk === 'function' && (
        <button
          type="button"
          onClick={() => onAsk(`追问评审专家：${data.agents.map(a => a.name).join('、')} 的详细推理链`)}
          style={{
            marginTop: 10, fontSize: 11, padding: '4px 12px', borderRadius: 999,
            border: '1px solid rgba(249,115,22,0.4)', color: '#f97316',
            background: 'rgba(249,115,22,0.08)', cursor: 'pointer',
          }}
        >
          语音追问推理链
        </button>
      )}
    </div>
  )
}
