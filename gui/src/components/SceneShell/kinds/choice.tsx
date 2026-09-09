/**
 * Choice Card — 选项按钮卡片（带交错入场动画）
 *
 * 2026-08-13: pending 确认(P1-6, 参考实现 data.pending 借鉴)——点击后
 * 全部按钮禁用 + 选中项高亮 + Loader2,发送 intent 携带 { value, pending: true };
 * 15s 兜底定时器防后端无回复时按钮永久锁死;surface 数据变化(新问题/新选项)自动解锁。
 * 组件只负责显示与上报,不承担业务决策。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

export interface ChoiceData {
  question: string
  options: string[] | Array<{ label: string; value: string }>
  multiple?: boolean
  onSelect?: (value: string) => void
}

/** 兜底: 发送后 15s 无任何反馈 → 解锁按钮(后端无回复时防永久锁死) */
const PENDING_FALLBACK_MS = 15_000

export function ChoiceCard({ data, surfaceId, sendIntent }: { data: ChoiceData; surfaceId: string; sendIntent?: (id: string, name: string, data: any) => void }) {
  const [pendingValue, setPendingValue] = useState<string | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPending = useCallback(() => {
    setPendingValue(null)
    if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null }
  }, [])

  // 2026-08-13: surface 数据变化(新问题/新选项/后端替换卡)→ 解锁
  useEffect(() => {
    clearPending()
  }, [data, clearPending])

  // 卸载清理定时器
  useEffect(() => () => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
  }, [])

  const handleClick = useCallback((value: string) => {
    if (pendingValue !== null) return // 防重复点击
    setPendingValue(value)
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    pendingTimerRef.current = setTimeout(clearPending, PENDING_FALLBACK_MS)
    if (sendIntent) {
      sendIntent(surfaceId, data.multiple ? 'toggle' : 'select', { value, pending: true, ts: Date.now() })
    }
  }, [pendingValue, clearPending, surfaceId, data.multiple, sendIntent])

  const pending = pendingValue !== null

  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: '12px',
      background: 'rgba(24,24,36,0.88)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      {data.question && (
        <div style={{ fontSize: '14px', color: 'var(--text-primary, #e0e0e0)', marginBottom: '10px', fontWeight: 500 }}>
          {data.question}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {(data.options || []).map((opt, i) => {
          const label = typeof opt === 'string' ? opt : opt.label
          const value = typeof opt === 'string' ? opt : opt.value
          const isSelected = pendingValue === value
          return (
            <button
              key={i}
              onClick={() => handleClick(value)}
              disabled={pending}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '8px 12px',
                borderRadius: '8px',
                border: isSelected
                  ? '1px solid rgba(249,115,22,0.65)'
                  : '1px solid rgba(255,255,255,0.08)',
                background: isSelected
                  ? 'rgba(249,115,22,0.14)'
                  : 'rgba(255,255,255,0.04)',
                color: 'var(--text-primary, #e0e0e0)',
                fontSize: '14px',
                cursor: pending ? 'default' : 'pointer',
                opacity: pending && !isSelected ? 0.5 : 1,
                transition: 'all 0.2s ease',
                animation: `scene-stagger-fade 0.3s ease-out ${i * 60}ms both`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
              onMouseEnter={e => { if (!pending) (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.1)' }}
              onMouseLeave={e => { if (!pending && !isSelected) (e.target as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
            >
              <span>{label}</span>
              {isSelected && (
                <Loader2 size={14} className="animate-spin" style={{ color: '#f97316', flexShrink: 0 }} />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
