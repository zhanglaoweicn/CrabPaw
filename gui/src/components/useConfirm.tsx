/**
 * useConfirm — 命令式确认弹窗 hook（替代 window.confirm，Electron 渲染层不支持）
 *
 * 用法：
 *   const { confirmNode, askConfirm } = useConfirm()
 *   // 在 JSX 根部渲染 confirmNode
 *   // 调用：if (!(await askConfirm({ title: '删除确认', message: '...' }))) return
 */

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

export function useConfirm() {
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState<ConfirmOptions>({ title: '', message: '' })
  const resolveRef = useRef<((v: boolean) => void) | null>(null)

  const askConfirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    // C3 fix: 若已有未决 dialog，先 resolve(false) 关闭旧的（最后调用者胜出）再开新的
    if (resolveRef.current) {
      resolveRef.current(false)
      resolveRef.current = null
    }
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setOpts(options)
      setOpen(true)
    })
  }, [])

  // C4 fix: 组件卸载时清理未决 Promise，防止内存泄漏
  useEffect(() => {
    return () => {
      resolveRef.current?.(false)
    }
  }, [])

  const handleCancel = useCallback(() => {
    setOpen(false)
    resolveRef.current?.(false)
    resolveRef.current = null
  }, [])

  const handleConfirm = useCallback(() => {
    setOpen(false)
    resolveRef.current?.(true)
    resolveRef.current = null
  }, [])

  const confirmNode: ReactNode = open ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="rounded-xl p-6 max-w-md w-full mx-4 theme-bg-primary border theme-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold theme-text-primary">{opts.title}</h3>
          <button onClick={handleCancel} className="p-1 rounded hover:theme-bg-hover transition-colors">
            <X className="w-4 h-4 theme-text-muted" />
          </button>
        </div>
        <p className="mb-6 theme-text-secondary">{opts.message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={handleCancel} className="px-4 py-2 rounded-lg theme-btn-ghost">
            取消
          </button>
          <button
            onClick={handleConfirm}
            className={`px-4 py-2 rounded-lg text-white ${opts.danger ? 'bg-red-600 hover:bg-red-700' : 'theme-accent-bg'}`}
          >
            {opts.confirmLabel || '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { confirmNode, askConfirm } as const
}
