import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

/**
 * ConfirmDialog — 本地确认框
 *
 * 2026-09-22 可访问性修复：此前 Esc 不关闭、无焦点圈闭、无 dialog 语义——
 * 打开后键盘用户只能一路 Tab 找按钮，读屏也不知道弹了个对话框。
 * hooks 必须无条件调用，故弹框本体拆为仅在 open 时挂载的子组件。
 */
export function ConfirmDialog({
  open, title, message, confirmLabel = '确定离开',
  onCancel, onConfirm,
}: Props) {
  if (!open) return null
  return (
    <DialogBody
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}

function DialogBody({ title, message, confirmLabel, onCancel, onConfirm }: Omit<Props, 'open'>) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  // 初始焦点落在「取消」——破坏性动作不该是默认焦点（回车误触的代价不对称）
  useEffect(() => { cancelRef.current?.focus() }, [])

  // Esc = 取消；Tab 在框内循环。
  // 说明：本 handler 挂在 window，与 VoiceShell 的全局 Esc 处理同层——同层监听器之间
  // stopPropagation 无效，故打开确认框时按 Esc 可能同时触发外层（如关掉一张场景卡）。
  // 此处只保证"确认框一定关得掉"，不做跨模块的 Esc 仲裁。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const box = boxRef.current
      if (!box) return
      const focusables = Array.from(
        box.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => !el.hasAttribute('disabled'))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        ref={boxRef}
        className="rounded-xl p-6 max-w-md w-full mx-4 theme-bg-primary border theme-border"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className="flex items-center justify-between mb-3">
          <h3 id="confirm-dialog-title" className="text-lg font-semibold theme-text-primary">{title}</h3>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:theme-bg-hover transition-colors"
            aria-label="关闭"
          >
            <X className="w-4 h-4 theme-text-muted" />
          </button>
        </div>
        <p className="mb-6 theme-text-secondary">{message}</p>
        <div className="flex gap-3 justify-end">
          <button ref={cancelRef} onClick={onCancel} className="px-4 py-2 rounded-lg theme-btn-ghost">
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
