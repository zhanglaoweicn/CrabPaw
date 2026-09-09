import { X } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open, title, message, confirmLabel = '确定离开',
  onCancel, onConfirm,
}: Props) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50">
      <div className="rounded-xl p-6 max-w-md w-full mx-4 theme-bg-primary border theme-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold theme-text-primary">{title}</h3>
          <button onClick={onCancel} className="p-1 rounded hover:theme-bg-hover transition-colors">
            <X className="w-4 h-4 theme-text-muted" />
          </button>
        </div>
        <p className="mb-6 theme-text-secondary">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg theme-btn-ghost">
            取消
          </button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-lg text-white theme-accent-bg">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
