import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { statusToneOf, type StatusTone } from './status'

/** 管理舱统一状态徽章(绿=正常/黄=警告/红=错误/灰=停用) */
export function StatusBadge({ tone, label, title }: { tone?: StatusTone | string; label: string; title?: string }) {
  const t = tone ? (['success','warn','danger','neutral'].includes(tone) ? tone as StatusTone : statusToneOf(tone)) : 'neutral'
  const styles: Record<StatusTone, string> = {
    success: 'bg-green-500/10 text-green-400 border-green-500/20',
    warn: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    danger: 'bg-red-500/10 text-red-400 border-red-500/20',
    neutral: 'theme-bg-active theme-text-muted border-transparent',
  }
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] ${styles[t]}`}>
      {label}
    </span>
  )
}

/** 管理舱面板统一头部: 图标+标题+副题, 右侧动作槽 */
export function PanelHeader({ icon: Icon, title, sub, children }: {
  icon: LucideIcon
  title: string
  sub?: string
  children?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="w-4 h-4 theme-accent flex-shrink-0" />
        <div className="min-w-0">
          <h2 className="text-sm font-medium theme-text-primary truncate">{title}</h2>
          {sub && <p className="text-xs theme-text-muted truncate">{sub}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">{children}</div>
    </div>
  )
}

/** 管理舱统一空态 */
export function EmptyState({ icon: Icon, title, sub, action }: {
  icon: LucideIcon
  title: string
  sub?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="w-10 h-10 mb-3 opacity-40 theme-text-muted" />
      <p className="text-sm theme-text-secondary">{title}</p>
      {sub && <p className="text-xs mt-1 theme-text-muted">{sub}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/** 管理舱统一加载骨架 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg theme-bg-tertiary ${className}`} />
}
