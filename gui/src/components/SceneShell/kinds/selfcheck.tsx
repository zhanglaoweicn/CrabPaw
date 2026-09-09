/**
 * SelfCheck Card — 启动诊断卡片
 *
 * 系统自检面板组件。
 * 带扫描线动画的启动诊断显示
 */


export interface SelfCheckData {
  items: Array<{ label: string; status: 'pending' | 'checking' | 'ok' | 'warn' | 'error' }>
  title?: string
}

const STATUS_MAP: Record<string, { icon: string; color: string }> = {
  // pending：等待执行（SceneSelfCheck 工具默认 status 兜底为 pending，scene-kinds-tool.js:99）
  pending: { icon: '○', color: '#94a3b8' },
  checking: { icon: '⋯', color: '#888' },
  ok: { icon: '✓', color: '#4ade80' },
  warn: { icon: '⚠', color: '#fbbf24' },
  error: { icon: '✗', color: '#f87171' },
}

export function SelfCheckCard({ data }: { data: SelfCheckData }) {
  return (
    <div className="scene-selfcheck">
      {data.title && (
        <div style={{ fontSize: '15px', color: 'var(--text-muted, #999)', marginBottom: '10px', fontWeight: 600 }}>
          {data.title}
        </div>
      )}
      <div className="scan-line" style={{ marginBottom: '10px' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {(data.items || []).map((item, i) => {
          const st = STATUS_MAP[item.status] || STATUS_MAP.checking
          return (
            <div key={i} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '14px',
              color: 'var(--text-secondary, #ccc)',
            }}>
              <span style={{ color: st.color, width: '14px', textAlign: 'center' }}>{st.icon}</span>
              <span>{item.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
