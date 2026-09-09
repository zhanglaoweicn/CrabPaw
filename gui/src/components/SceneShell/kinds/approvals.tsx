/**
 * ApprovalsCard — 审批待办卡（panel key: approvals, 2026-09-05）
 *
 * 数据来自 ShowApprovalsPanel 发射的 surface 'approvals-panel'：
 *   { approvals: [{approvalId, flowId, message, createdAt, expiresAt}] }
 * 批准/驳回按钮通过 sendIntent 上报意图（下一轮进入 Agent 上下文），
 * 由 Agent 调用 ResolveApproval 工具落地。
 */

export interface PendingApproval {
  approvalId: string
  flowId?: string
  message?: string
  createdAt?: number
  expiresAt?: number
}

export interface ApprovalsCardData {
  approvals: PendingApproval[]
  generatedAt?: number
}

export function ApprovalsCard({ data, onClose, sendIntent, surfaceId }: {
  data: ApprovalsCardData
  onClose?: () => void
  sendIntent?: (id: string, name: string, data: any) => void
  surfaceId?: string
}) {
  if (!data || !Array.isArray(data.approvals)) return null
  const resolve = (approvalId: string, approved: boolean) => {
    if (!sendIntent || !surfaceId) return
    sendIntent(surfaceId, 'approval_resolve', { approvalId, approved })
  }
  return (
    <div className="scene-card approvals-card" style={{ padding: '16px 18px', minWidth: 300, position: 'relative' }}>
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
        {data.approvals.length > 0 ? `📝 审批待办 · ${data.approvals.length} 项` : '📝 审批待办 · 无待办'}
      </div>
      {data.approvals.length === 0 ? (
        <div style={{ fontSize: 14, color: 'var(--text-muted, #888)', padding: '8px 0', textAlign: 'center' }}>
          当前没有待审批事项
        </div>
      ) : (
        data.approvals.map((a, i) => (
          <div key={a.approvalId} style={{ padding: '8px 0', borderBottom: i < data.approvals.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
            <div style={{ fontSize: 14, opacity: 0.85, marginBottom: 6 }}>
              {a.message || a.approvalId}
              {a.flowId ? <span style={{ display: 'block', fontSize: 12, opacity: 0.6 }}>流程: {a.flowId}</span> : null}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); resolve(a.approvalId, true) }}
                style={{
                  flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid rgba(103,194,58,0.5)',
                  background: 'rgba(103,194,58,0.15)', color: 'var(--ok, #67c23a)',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >批准</button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); resolve(a.approvalId, false) }}
                style={{
                  flex: 1, padding: '5px 0', borderRadius: 6, border: '1px solid rgba(230,162,60,0.5)',
                  background: 'rgba(230,162,60,0.12)', color: 'var(--warn, #e6a23c)',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >驳回</button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
