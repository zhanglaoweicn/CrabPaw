import { Shield } from 'lucide-react'

export function TrustBadge({ score }: { score?: number }) {
  if (score === undefined || score === null) return null
  const level = score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low'
  const colors = {
    high: 'theme-color-success-bg theme-color-success',
    medium: 'theme-color-warning-bg theme-color-warning',
    low: 'theme-color-error-bg theme-color-error'
  }
  const labels = { high: '高信任', medium: '中信任', low: '低信任' }
  return (
    <span className={`text-xs px-2 py-0.5 rounded flex items-center gap-1 ${colors[level]}`}>
      <Shield className="w-3 h-3" />
      {labels[level]} ({(score * 100).toFixed(0)}%)
    </span>
  )
}
