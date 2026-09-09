export interface TravelTrain {
  code: string;
  from: string;
  to: string;
  depart: string;
  arrive: string;
  duration: string;
  seats: Array<{ name: string; count: string }>;
}

export interface TravelCardData { kind: 'travel'; trains: TravelTrain[]; query?: string }

function CloseButton({ onClose }: { onClose?: () => void }) {
  if (!onClose) return null
  return (
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
  )
}

export default function TravelCard({ data, onClose }: { data: TravelCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.trains)) return null;
  if (data.trains.length === 0) {
    return (
      <div className="scene-card" style={{ padding: 16, fontSize: 15, position: 'relative' }}>
        <CloseButton onClose={onClose} />
        没有查到可用车次
      </div>
    );
  }
  return (
    <div className="scene-card travel-card" style={{ padding: '14px 16px', minWidth: 320, maxHeight: 420, overflow: 'auto', position: 'relative' }}>
      <CloseButton onClose={onClose} />
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>{data.query || '车次查询'}</div>
      {data.trains.map((t) => (
        <div key={t.code} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <span style={{ fontSize: 16, fontWeight: 700, minWidth: 60 }}>{t.code}</span>
          <span style={{ fontSize: 15 }}>{t.depart}</span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>→</span>
          <span style={{ fontSize: 15 }}>{t.arrive}</span>
          <span style={{ fontSize: 12, opacity: 0.6, flex: 1 }}>{t.duration}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {t.seats.slice(0, 3).map((s) => (
              <span key={s.name} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: s.count === '有' ? 'rgba(34,197,94,0.15)' : s.count === '无' ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)', color: s.count === '有' ? '#4ade80' : s.count === '无' ? '#f87171' : 'inherit' }}>
                {s.name}·{s.count}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
