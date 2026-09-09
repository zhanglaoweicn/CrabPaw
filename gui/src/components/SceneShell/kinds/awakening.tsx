/**
 * Awakening Card — 唤醒/环境通知卡片
 *
 * 系统觉醒面板组件。
 * 带状态圆点的环境通知
 */


export interface AwakeningData {
  text?: string
  // SceneAwakening 工具发 { index, total, title, finding, emoji }（无 text）；
  // awakening_status surface 发 { text, type }（src/core/awakening.js）。两类都兼容。
  finding?: string
  title?: string
  emoji?: string
  type?: 'info' | 'success' | 'warning' | 'error'
  dots?: number // 圆点数量，默认3
}

const DOT_COLORS: Record<string, string> = {
  info: '#59a8ff',
  success: '#4ade80',
  warning: '#fbbf24',
  error: '#f87171',
}

export function AwakeningCard({ data }: { data: AwakeningData }) {
  const dotCount = data.dots || 3
  const dotColor = DOT_COLORS[data.type || 'info'] || DOT_COLORS.info
  const body = data.text || data.finding || ''

  return (
    <div className="scene-awakening">
      {data.title && (
        <div style={{ fontSize: '13px', color: 'var(--text-muted, #999)', fontWeight: 600, marginBottom: '6px' }}>
          {data.emoji ? `${data.emoji} ` : ''}{data.title}
        </div>
      )}
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          {Array.from({ length: dotCount }).map((_, i) => (
            <div key={i} className="dot" style={{ background: dotColor }} />
          ))}
        </div>
        <span style={{ fontSize: '14px', color: 'var(--text-primary, #e0e0e0)', flex: 1 }}>
          {body}
        </span>
      </div>
    </div>
  )
}
