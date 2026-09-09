/**
 * PersonCard — 人物卡片
 *
 * 人物卡片: 当用户问"某人是谁", AI 调用工具展示人物简介、作品、标签。
 */

import { X, Star } from 'lucide-react'
import { apiGet } from '../../lib/api'

export interface PersonInfo {
  name: string
  alias?: string[]
  identity?: string
  summary?: string
  works?: string[]
  tags?: string[]
  birth?: string
  death?: string
  nationality?: string
}

interface PersonCardProps {
  person: PersonInfo
  onClose?: () => void
}

export function PersonCard({ person, onClose }: PersonCardProps) {
  return (
    <div className="theme-card p-4 relative overflow-hidden">
      {/* Close button */}
      {onClose && (
        <button onClick={onClose} className="absolute top-2 right-2 p-1 rounded hover:theme-bg-tertiary">
          <X className="w-3.5 h-3.5 theme-text-muted" />
        </button>
      )}

      {/* Avatar placeholder */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl flex-shrink-0" style={{
          background: 'linear-gradient(135deg, #6366f1, #a78bfa)',
        }}>
          {person.name.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold theme-text-primary">{person.name}</div>
          {person.identity && (
            <div className="text-xs theme-text-muted mt-0.5">{person.identity}</div>
          )}
          {person.nationality && (
            <div className="text-[10px] theme-text-muted mt-0.5">{person.nationality}</div>
          )}
        </div>
      </div>

      {/* Tags */}
      {person.tags && person.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {person.tags.map(tag => (
            <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full" style={{
              background: 'rgba(99,102,241,0.15)',
              color: '#818cf8',
            }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Summary */}
      {person.summary && (
        <div className="text-xs theme-text-secondary leading-relaxed mb-3 line-clamp-4">
          {person.summary}
        </div>
      )}

      {/* Works */}
      {person.works && person.works.length > 0 && (
        <div>
          <div className="text-[10px] font-medium theme-text-muted mb-1 flex items-center gap-1">
            <Star className="w-3 h-3" /> 代表作品
          </div>
          <div className="space-y-1">
            {person.works.slice(0, 5).map((work, i) => (
              <div key={i} className="text-xs theme-text-secondary flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full theme-accent-bg flex-shrink-0" />
                {work}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 根据名称查询人物信息 */
export async function fetchPersonCard(name: string): Promise<PersonInfo | null> {
  try {
    const result = await apiGet(`/api/person-card?name=${encodeURIComponent(name)}`)
    if (result.success && result.data) {
      return result.data as PersonInfo
    }
  } catch { console.warn('[PersonCard] fetch failed for name:', name) }
  return null
}
