import { useState, useEffect, useCallback, useRef } from 'react'
import { Shield, Check, X, Clock, AlertTriangle, Pencil } from 'lucide-react'
import { apiPost, apiGet } from '../../lib/api'

export interface ApprovalRequest {
  id: string
  command: string
  message: string
  timeout: number
  createdAt: number
  expiresAt: number
  /**
   * 2026-08-14 审计 G3: 审批请求归属会话(SSE 广播新增字段,缺省 null 向后兼容)
   */
  conversationId?: string | null
}

export interface ApprovalResolved {
  id: string
  status: string
  scope: string | null
  command: string
  reason?: string
}

interface ApprovalCardProps {
  request: ApprovalRequest
  onResolved?: (resolved: ApprovalResolved) => void
  /**
   * 跨卡片互斥：传入当前正在响应中的请求 id 集合。
   * 当前卡片的 id 在集合中时，所有按钮禁用，防止并发审批。
   */
  inFlightRequestIds?: Set<string>
  /**
   * 用户点击"允许/拒绝"时触发（请求开始），用于父级追踪 in-flight 状态。
   */
  onSubmitting?: (id: string) => void
}

const SCOPE_LABELS: Record<string, { label: string; color: string }> = {
  once: { label: '本次允许', color: 'bg-blue-600 hover:bg-blue-700' },
  session: { label: '会话允许', color: 'bg-yellow-600 hover:bg-yellow-700' },
  always: { label: '永久允许', color: 'bg-orange-600 hover:bg-orange-700' },
}

export function ApprovalCard({ request, onResolved, inFlightRequestIds, onSubmitting }: ApprovalCardProps) {
  const [loading, setLoading] = useState(false)
  // 2026-08-13 P1-7: approve-with-edits——编辑命令后批准
  const [editOpen, setEditOpen] = useState(false)
  const [editedCommand, setEditedCommand] = useState('')
  const [fullCommand, setFullCommand] = useState(request.command)
  // 2026-08-14 审计 M6: GET 回填中标记(回填完成前禁用"批准(编辑后)",防止截断命令被快速提交)
  const [backfilling, setBackfilling] = useState(false)
  const [remaining, setRemaining] = useState(Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000)))
  // 防止同卡片快速重复点击（即使 React state 还没更新也能拦截）
  const submittingRef = useRef(false)

  // 倒计时
  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000))
      setRemaining(left)
      if (left <= 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [request.expiresAt])

  const handleRespond = useCallback(async (response: boolean, scope: string, command?: string) => {
    // 1) 同步 ref 拦截：即使 React 还没刷新 setLoading，也阻止后续点击
    if (submittingRef.current) return
    // 2) 跨卡片互斥：如果有其他卡片正在响应中，禁止当前卡片再点
    // 2026-08-14 审计 G2: 原外层条件误写 inFlightRequestIds.has(request.id)——自身 id
    // 在集合中时按钮早已被禁用,条件恒为假,"他卡 in-flight 时本卡拦截"永不触发。
    // 改为:集合非空即检查是否存在非自身 id。
    if (inFlightRequestIds && inFlightRequestIds.size > 0) {
      const otherInFlight = Array.from(inFlightRequestIds).some(id => id !== request.id)
      if (otherInFlight) {
        return
      }
    }
    // 3) 检查超时
    if (Date.now() >= request.expiresAt) {
      console.warn('[ApprovalCard] 已超时，跳过响应')
      return
    }

    onSubmitting?.(request.id)
    submittingRef.current = true
    setLoading(true)
    try {
      const result = await apiPost('/api/security/approval', {
        requestId: request.id,
        response,
        scope,
        // 2026-08-14 审计 G3: 会话归属回传(缺省省略保持向后兼容)
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        // 2026-08-13 P1-7: 编辑后命令随批准提交(仅当与原始命令不同)
        ...(command && command !== request.command ? { editedCommand: command } : {}),
      })
      if (result.success) {
        onResolved?.({
          id: request.id,
          status: response ? 'approved' : 'denied',
          scope: response ? scope : null,
          command: request.command
        })
      } else {
        console.error('审批响应失败:', result.error || '未知错误')
      }
    } catch (e) {
      console.error('审批响应失败:', e)
    } finally {
      submittingRef.current = false
      setLoading(false)
    }
  }, [request, onResolved, inFlightRequestIds, onSubmitting])

  const isExpired = remaining <= 0
  // 跨卡片互斥：其他卡片正在响应中时，本卡禁用
  const isLockedByOther = inFlightRequestIds
    ? Array.from(inFlightRequestIds).some(id => id !== request.id)
    : false
  // 自身卡片在 inFlight（语音审批在途）时也禁用，防语音+手动双重提交
  const isSelfInFlight = inFlightRequestIds ? inFlightRequestIds.has(request.id) : false
  const disabled = loading || isExpired || isSelfInFlight || isLockedByOther
  const urgency = remaining <= 10 ? 'text-red-500' : remaining <= 30 ? 'text-yellow-500' : 'text-green-500'

  return (
    <div className="border border-amber-500/40 bg-amber-500/5 rounded-lg p-4 my-2 animate-in slide-in-from-top-2">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <Shield className="w-5 h-5 text-amber-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-amber-400">需要审批确认</span>
            {!isExpired && (
              <span className={`text-xs flex items-center gap-1 ${urgency}`}>
                <Clock className="w-3 h-3" />
                {remaining}s
              </span>
            )}
          </div>

          <div className="bg-black/20 rounded p-2 mb-3 font-mono text-xs break-all text-zinc-300">
            {request.command}
          </div>

          {/* 2026-08-13 P1-7: 编辑命令区——批准前可修改命令参数(编辑后强制 once,后端重检) */}
          {editOpen ? (
            <div className="mb-3">
              <textarea
                value={editedCommand}
                onChange={(e) => setEditedCommand(e.target.value)}
                disabled={isExpired}
                rows={3}
                spellCheck={false}
                className="w-full bg-black/30 rounded p-2 font-mono text-xs text-zinc-300 border border-zinc-700 focus:border-amber-500 outline-none resize-y disabled:opacity-50"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => handleRespond(true, 'once', editedCommand.trim())}
                  disabled={disabled || !editedCommand.trim() || backfilling}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Check className="w-3 h-3" />
                  批准(编辑后)
                </button>
                <button
                  onClick={() => setEditOpen(false)}
                  disabled={disabled}
                  className="text-zinc-400 hover:text-zinc-200 text-xs px-3 py-1.5 rounded border border-zinc-600 transition-colors disabled:opacity-50"
                >
                  取消编辑
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                // 进入编辑态:GET 回填完整命令(SSE 广播的 command 可能被截断到 200 字符)
                setEditOpen(true)
                setEditedCommand(fullCommand || request.command)
                // 2026-08-14 审计 M6: 回填完成前禁用"批准(编辑后)"提交(防止截断命令被快速提交)
                setBackfilling(true)
                const query = request.conversationId
                  ? `?conversationId=${encodeURIComponent(request.conversationId)}`
                  : ''
                void apiGet<{ pending: Array<{ id: string; command?: string }> }>(`/api/security/approval${query}`).then((res) => {
                  const full = res?.data?.pending?.find((p) => p.id === request.id)?.command
                  if (full) { setFullCommand(full); setEditedCommand(full) }
                }).catch((e) => console.error('[ApprovalCard] 获取完整命令失败:', e))
                  .finally(() => setBackfilling(false))
              }}
              disabled={disabled}
              className="text-amber-400 hover:text-amber-300 text-xs px-3 py-1.5 rounded border border-amber-500/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mb-3"
            >
              <Pencil className="w-3 h-3 inline mr-1" />
              编辑命令
            </button>
          )}
          {isExpired ? (
            <div className="flex items-center gap-2 text-xs text-red-400">
              <AlertTriangle className="w-3 h-3" />
              审批已超时
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleRespond(true, 'once')}
                disabled={disabled}
                className={`${SCOPE_LABELS.once.color} text-white text-xs px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
              >
                <Check className="w-3 h-3" />
                {SCOPE_LABELS.once.label}
              </button>
              <button
                onClick={() => handleRespond(true, 'session')}
                disabled={disabled}
                className={`${SCOPE_LABELS.session.color} text-white text-xs px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
              >
                <Check className="w-3 h-3" />
                {SCOPE_LABELS.session.label}
              </button>
              <button
                onClick={() => handleRespond(true, 'always')}
                disabled={disabled}
                className={`${SCOPE_LABELS.always.color} text-white text-xs px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
              >
                <Check className="w-3 h-3" />
                {SCOPE_LABELS.always.label}
              </button>
              <button
                onClick={() => handleRespond(false, 'once')}
                disabled={disabled}
                className="bg-red-600 hover:bg-red-700 text-white text-xs px-3 py-1.5 rounded flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <X className="w-3 h-3" />
                拒绝
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
