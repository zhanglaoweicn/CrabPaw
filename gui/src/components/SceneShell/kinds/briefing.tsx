export interface BriefingItem {
  title: string;
  value: string;
  detail?: string;
}

export interface BriefingCardData {
  kind: 'briefing';
  /** 卡片标题；缺省时用通用「经营提醒」（不再硬编码「早间经营播报」） */
  title?: string;
  items: BriefingItem[];
}

export function BriefingCard({ data, onClose }: { data: BriefingCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.items)) return null;
  return (
    <div className="scene-card briefing-card" style={{ padding: '16px 18px', minWidth: 280, position: 'relative' }}>
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
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{data.title || '⚠️ 经营提醒'}</div>
      {data.items.length === 0 ? (
        <div style={{ fontSize: 14, color: 'var(--text-muted, #888)', padding: '8px 0', textAlign: 'center' }}>
          暂无内容
        </div>
      ) : (
        data.items.map((it, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: i < data.items.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
            <span style={{ fontSize: 15, opacity: 0.85 }}>{it.title}</span>
            <span style={{ fontSize: 15, fontWeight: 600, textAlign: 'right' }}>
              {it.value}
              {it.detail ? <span style={{ display: 'block', fontSize: 14, opacity: 0.7, fontWeight: 400 }}>{it.detail}</span> : null}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
