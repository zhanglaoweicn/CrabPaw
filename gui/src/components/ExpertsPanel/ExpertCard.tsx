import { MessageCircle } from 'lucide-react'
import type { Expert } from './types'
import { renderExpertIcon } from './icons'

function formatTime(ts: number | null): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
}

interface ExpertCardProps {
  expert: Expert
  summoned: string | null
  onSummon: (expert: Expert) => void
  onSelect: (expert: Expert) => void
}

export function ExpertCard({ expert, summoned, onSummon, onSelect }: ExpertCardProps) {
  const isSummoned = summoned === expert.id

  return (
    <div
      className="rounded-xl p-4 transition-all duration-200 hover:scale-[1.02] cursor-pointer flex flex-col relative overflow-hidden group"
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-primary)',
      }}
      onClick={() => onSelect(expert)}
    >
      {/* 使用统计角标 */}
      {expert.usageCount > 0 && (
        <div className="absolute top-2 right-2 text-[10px] theme-text-muted opacity-60">
          使用 {expert.usageCount} 次
        </div>
      )}
      {expert.lastUsedAt && (
        <div className="absolute top-2 right-2 mt-4 text-[9px] theme-text-muted opacity-40">
          {formatTime(expert.lastUsedAt)}
        </div>
      )}

      {/* Icon + Name + Title */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent-muted)' }}>
          {renderExpertIcon(expert.icon, 'w-5 h-5 theme-accent')}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold theme-text-primary truncate">{expert.name || ''}</span>
            {/* 2026-08-27 B1-5: 清单异常徽章(validateExpertManifest per-expert 问题, 前缀匹配) */}
            {expert.manifestValid === false && (
              <span
                title={(expert.manifestIssues || []).join('；')}
                className="px-1.5 py-0.5 rounded-full text-[9px] flex-shrink-0 bg-amber-500/10 text-amber-400 border border-amber-500/20"
              >清单异常</span>
            )}
          </div>
          <div className="text-[11px] theme-text-muted truncate">{expert.title || ''}</div>
        </div>
      </div>

      {/* Description */}
      <p className="text-[11px] theme-text-muted leading-relaxed mb-3 flex-1">{expert.description || ''}</p>

      {/* Tags */}
      <div className="flex gap-1 flex-wrap mb-3">
        {(expert.tags || []).slice(0, 3).map(tag => (
          <span key={tag} className="px-2 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
            {tag}
          </span>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={e => { e.stopPropagation(); onSummon(expert) }}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-1 justify-center"
          style={{
            background: isSummoned ? 'var(--accent-primary)' : 'var(--accent-muted)',
            color: isSummoned ? '#fff' : 'var(--accent-primary)',
          }}
        >
          <MessageCircle className="w-3 h-3" />
          {isSummoned ? '已召唤' : '召唤'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onSelect(expert) }}
          className="px-3 py-1.5 rounded-lg text-xs theme-text-muted hover:theme-text-primary transition-all"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          详情
        </button>
      </div>
    </div>
  )
}
