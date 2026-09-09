/**
 * NewsCard — 资讯结果卡（kind: news）
 * 场景: "今天有哪些热门AI资讯" → AI 推送 news surface → 本卡渲染头条列表
 */

export interface NewsData {
  items: Array<{ title: string; heat?: number | string; url?: string }>
  platform?: string
}

export function NewsCard({ data }: { data?: NewsData }) {
  const items = data?.items || []
  const platform = data?.platform || '综合'
  if (items.length === 0) return null
  return (
    <div style={{
      padding: '14px 16px', borderRadius: '12px', minWidth: 260, maxWidth: 340,
      background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ fontSize: 14, color: '#f97316', fontWeight: 600, marginBottom: 8 }}>🔥 {platform}资讯 · 实时</div>
      {items.slice(0, 6).map((item: any, i: number) => (
        <div key={item?.url || `${item?.title || ''}-${item?.platform || i}`} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: i < Math.min(5, items.length - 1) ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <span style={{ minWidth: 16, textAlign: 'center', fontSize: 10, fontWeight: 700, color: ['#ffd700', '#c0c0c0', '#cd7f32'][i] || '#666' }}>{i + 1}</span>
          <span style={{ flex: 1, fontSize: 14, color: '#ccc', lineHeight: 1.4 }}>{item.title}</span>
          {item.heat !== undefined && <span style={{ fontSize: 9, color: '#888', alignSelf: 'center' }}>{item.heat}</span>}
        </div>
      ))}
    </div>
  )
}
