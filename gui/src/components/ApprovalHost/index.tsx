/**
 * ApprovalHost — 全局审批宿主（2026-08-04）
 *
 * 双模式常驻(VoiceShell + Dashboard):审批请求经 SSE 推送 →
 * 全息玻璃卡显示命令 + 允许/拒绝/会话允许/永久允许,倒计时超时自动消失。
 *
 * 背景:此前 ApprovalCard 仅挂在 Dashboard,语音模式(默认界面)看不到审批
 * → LLM 每次 Bash 调用等 60s 超时自动拒绝 → 连续失败降级回复
 * ("无法生成网页报告"的第二个根因)。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useSse } from '../../hooks/useSSE'
import { ApprovalCard, type ApprovalRequest, type ApprovalResolved } from '../ApprovalCard'
import { apiGet, apiPost } from '../../lib/api'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { announce, markNoticeHandled, recordNotice } from '../../lib/notices'
import './styles.css'

/** 把命令原文压成一句人话线索——账本次行与播报都用它，避免念一整串 shell */
function describeCommand(command?: string): string {
  const c = String(command || '').replace(/\s+/g, ' ').trim()
  if (!c) return ''
  return c.length > 40 ? `${c.slice(0, 40)}…` : c
}

/** 播报开关——与提示音共用 approval-sound 设置（新增设置项只会多一处未配置项） */
function approvalVoiceEnabled(): boolean {
  try { return localStorage.getItem('approval-sound') !== 'off' } catch { return true }
}

/**
 * 2026-08-19 三栏联动轮 P2: 审批输入区接管——
 * variant='inline' 时以静态流式容器渲染(嵌入 VoiceShell 输入区上方, 接管输入),
 * 非全屏悬浮卡; onActiveChange 通知父级待审批数(父级禁用输入框/发送按钮)。
 * 双实例共存防重: inline 激活时(有待审批) overlay 实例静默抑制(窗口标记)。
 */
export function ApprovalHost({ variant = 'overlay', onActiveChange }: {
  variant?: 'overlay' | 'inline'
  onActiveChange?: (count: number) => void
}) {
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(new Set())

  const playChime = useCallback(() => {
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.value = 0.08
      osc.connect(gain).connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.35)
      setTimeout(() => ctx.close().catch((err) => { console.debug('[Approval] ctx.close error:', err) }), 500)
    } catch (err) { console.warn('[Approval] 提示音失败:', err) }
  }, [])
  const pendingRef = useRef<ApprovalRequest[]>([])
  pendingRef.current = pendingApprovals
  // 2026-09-22 体验层: 已上报过的超时请求 id——过期检测每 2s 跑一次, 保证每次超时
  // 只记一笔账、只播一句, 不随轮询重复刷屏
  const reportedExpiredRef = useRef<Set<string>>(new Set())

  // C5(Runtime差距分析): 挂载时恢复未决审批——此前仅靠 SSE approval_requested
  // 实时事件,渲染进程刷新期间产生的审批卡永久丢失(后端仍在 waitForApproval 挂起,
  // B4 continue 策略下 run 存活)。GET /api/security/approval 返回 pending 列表,
  // 与实时事件按 id 去重合并。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const result = await apiGet<{ success: boolean; pending?: any[] }>('/api/security/approval')
        const list = result?.data?.pending
        if (cancelled || !Array.isArray(list) || list.length === 0) return
        setPendingApprovals(prev => {
          const known = new Set(prev.map(r => r.id))
          const restored = list
            .filter((r: any) => r?.id && !known.has(r.id))
            .map((r: any) => ({
              id: r.id,
              command: r.command || '',
              message: r.message || '',
              timeout: r.timeout || 60,
              createdAt: r.createdAt || Date.now(),
              expiresAt: r.expiresAt || Date.now() + 60000,
              conversationId: r.conversationId ?? null,
            }))
          return restored.length > 0 ? [...prev, ...restored] : prev
        })
      } catch (e) {
        console.warn('[ApprovalHost] 未决审批恢复失败(忽略):', e)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 过期处理（2026-09-22 体验层重构：不再是静默移除）
  //
  // 后端在超时那一刻就按「自动拒绝」落定了（src/core/security/approval.js 的
  // resolutionReason = 'approval_timeout_auto_deny'）。此前前端只是把卡片
  // filter 掉——老板离开座位一分钟回来，一个需要他拍板的操作悄悄没了，
  // 既没有提示、也没有痕迹，甚至不知道发生过。现在补三件事：
  //   ① 账本记一笔（左栏事务账本，可回看）
  //   ② toast 可见提示（不依赖他正好在看卡区）
  //   ③ 说一句（语音优先产品里，最该开口的场景此前只有一声提示音）
  // 多条同时超时合并成一句播报，避免念成一串。
  useEffect(() => {
    if (pendingApprovals.length === 0) return
    const timer = setInterval(() => {
      const now = Date.now()
      const expired = pendingRef.current.filter(
        r => r.expiresAt <= now && !reportedExpiredRef.current.has(r.id),
      )
      if (expired.length === 0) return
      for (const r of expired) reportedExpiredRef.current.add(r.id)

      for (const r of expired) {
        recordNotice({
          id: `approval_timeout_${r.id}`,
          ts: r.expiresAt,
          kind: 'approval',
          level: 'failed',
          title: '一个待确认的操作超时了，已按拒绝处理',
          detail: describeCommand(r.command),
          ref: r.id,
        })
      }

      const first = expired[0]
      const brief = describeCommand(first.command)
      const spoken = expired.length === 1
        ? `刚才那个确认请求超时了，我按拒绝处理了${brief ? `。它要做的是：${brief}` : ''}`
        : `有 ${expired.length} 个确认请求超时，都按拒绝处理了`
      try {
        if (approvalVoiceEnabled()) announce(spoken, { id: `approval_timeout_${first.id}`, kind: 'approval' })
      } catch (e) { console.warn('[ApprovalHost] 超时播报失败:', e) }

      try {
        toast.warning(
          expired.length === 1 ? '一个待确认的操作超时了' : `${expired.length} 个待确认操作超时了`,
          { description: '已经按拒绝处理。需要的话让我重来一次就好。', duration: 8000 },
        )
      } catch (e) { console.warn('[ApprovalHost] 超时提示失败:', e) }

      setPendingApprovals(prev => prev.filter(r => r.expiresAt > now))
    }, 2000)
    return () => clearInterval(timer)
  }, [pendingApprovals.length])

  // 2026-08-19 P2 接管: inline 激活标记 + 父级通知——
  // ① overlay 实例见到标记即静默(防双卡); ② VoiceShell 据此禁用输入区
  useEffect(() => {
    const cur = pendingApprovals.length > 0
    if (variant === 'inline') {
      try {
        ;(window as any).__approvalInlineActive = cur
      } catch (e) { console.warn('[ApprovalHost] inline 标记失败:', e) }
      onActiveChange?.(pendingApprovals.length)
    }
    return () => {
      if (variant === 'inline') {
        try { ;(window as any).__approvalInlineActive = false } catch (e) { console.warn('[ApprovalHost] inline 标记清除失败:', e) }
        onActiveChange?.(0)
      }
    }
  }, [pendingApprovals.length, variant, onActiveChange])

  useSse({
    path: '/events',
    handlers: {
      approval_requested: (data: any) => {
        if (!data?.requestId) return
        if (localStorage.getItem('approval-sound') !== 'off') playChime()
        // 2026-09-22 体验层: 需要老板出手的事是全项目最该「开口」的事件——
        // 此前只有一声 880Hz 提示音。而语音批准/拒绝的指令早就通了
        // (voice-panel-commands 的 approval 规则), 等于工具齐了、没人通知。
        // 播报走 notices.announce → crabpaw:speak → 共享播报队列: 主回复进行中
        // 不抢播、静音时自然丢弃, 不会打断正在说的回复。
        try {
          const brief = describeCommand(data.command)
          recordNotice({
            id: `approval_${data.requestId}`,
            kind: 'approval',
            level: 'action',
            title: '有个操作需要你确认',
            detail: brief,
            ref: data.requestId,
          })
          if (approvalVoiceEnabled()) {
            announce(
              `有个操作需要你确认${brief ? `：${brief}` : ''}。说“批准”或“拒绝”就行`,
              { id: `approval_${data.requestId}`, kind: 'approval' },
            )
          }
        } catch (e) { console.warn('[ApprovalHost] 审批到达记账/播报失败:', e) }
        setPendingApprovals(prev => {
          if (prev.some(r => r.id === data.requestId)) return prev
          return [...prev, {
            id: data.requestId,
            command: data.command || '',
            message: data.message || '',
            timeout: data.timeout || 60,
            createdAt: data.createdAt || Date.now(),
            expiresAt: data.expiresAt || Date.now() + 60000,
            // 2026-08-14 审计 G3: 会话归属(SSE 广播新增字段,缺省 null 向后兼容)
            conversationId: data.conversationId ?? null,
          }]
        })
      },
      approval_resolved: (data: any) => {
        if (!data?.requestId) return
        setPendingApprovals(prev => prev.filter(r => r.id !== data.requestId))
        // 账本同源收口：已拍板的事不再挂在「需要你出手」档
        markNoticeHandled(`approval_${data.requestId}`)
        // 同步清除 inFlight 标记，防止集合只增不减导致后续审批卡永久禁用
        setInFlightIds(prev => {
          if (!prev.has(data.requestId)) return prev
          const next = new Set(prev)
          next.delete(data.requestId)
          return next
        })
      },
    },
  })

  const handleResolved = (_r: ApprovalResolved) => {
    setPendingApprovals(prev => prev.filter(r => r.id !== _r.id))
    markNoticeHandled(`approval_${_r.id}`)
    // 同上：resolved 后必须移出 inFlightIds
    setInFlightIds(prev => {
      if (!prev.has(_r.id)) return prev
      const next = new Set(prev)
      next.delete(_r.id)
      return next
    })
  }

  // 2026-08-14 审计 G2: 同步单飞锁——处理中拒绝再次进入(防止语音+手动/双击并发双提交)
  const decidingRef = useRef(false)

  // 语音审批：全局接口复用 ApprovalCard handleRespond 的 API 调用模式
  const handleDecision = useCallback((id: string | undefined, decision: 'approved' | 'rejected'): boolean => {
    if (decidingRef.current) {
      console.warn('[ApprovalHost] 已有审批正在处理中,拒绝重复决策:', decision)
      return false
    }
    // 2026-08-14 审计 G3: 未指定 id 时仅在"恰好一张待审批卡"时允许(目标无歧义);
    // 多卡并存时拒绝默认批准 pendingRef[0],防止误批其他会话的请求。
    let requestId = id
    if (!requestId) {
      if (pendingRef.current.length === 1) {
        requestId = pendingRef.current[0].id
      } else {
        console.warn(`[ApprovalHost] 语音审批未指定 id 且存在 ${pendingRef.current.length} 个待审批请求,拒绝默认批准第一张卡`)
        return false
      }
    }
    const req = pendingRef.current.find(r => r.id === requestId)
    if (!req || Date.now() >= req.expiresAt) return false
    decidingRef.current = true
    // 标记 in-flight（跨卡片互斥）
    setInFlightIds(prev => new Set(prev).add(requestId))
    // 异步提交（不阻塞返回）——与 ApprovalCard handleRespond 一致的 apiPost 调用
    apiPost('/api/security/approval', {
      requestId,
      response: decision === 'approved',
      scope: 'once',
      // 2026-08-14 审计 G3: 会话归属回传(缺省省略保持向后兼容)
      ...(req.conversationId ? { conversationId: req.conversationId } : {}),
    }).then(result => {
      if (result.success) {
        setPendingApprovals(prev => prev.filter(r => r.id !== requestId))
        markNoticeHandled(`approval_${requestId}`)
      }
      setInFlightIds(prev => {
        if (!prev.has(requestId)) return prev
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
    }).catch(e => {
      console.error('[ApprovalHost] 语音审批失败:', e)
      setInFlightIds(prev => {
        if (!prev.has(requestId)) return prev
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
    }).finally(() => { decidingRef.current = false })
    return true
  }, [])

  // 暴露全局接口供 VoiceShell 语音审批命令调用
  useEffect(() => {
    // A1: 经 ui-command-registry 注册(旧 window.__approvalHost 退役)
    const unregisterApproval = registerCommandHost('approvalHost', {
      approve: (id?: string) => handleDecision(id, 'approved'),
      reject: (id?: string) => handleDecision(id, 'rejected'),
      list: () => pendingRef.current ?? [],
    })
    return () => { unregisterApproval() }
  }, [handleDecision])

  if (pendingApprovals.length === 0) return null
  // 2026-08-19 P2 接管: overlay 实例遇 inline 激活(窗口标记)静默, 防双卡重复
  if (variant === 'overlay') {
    try { if ((window as any).__approvalInlineActive) return null } catch (e) { console.warn('[ApprovalHost] overlay 抑制标记读取失败:', e) }
  }

  return (
    <div className={variant === 'inline' ? 'approval-host approval-host--inline' : 'approval-host'}>
      {pendingApprovals.map(req => (
        <div key={req.id} className="approval-host-card">
          <ApprovalCard
            request={req}
            onResolved={handleResolved}
            inFlightRequestIds={inFlightIds}
            onSubmitting={(id) => setInFlightIds(prev => new Set(prev).add(id))}
          />
        </div>
      ))}
    </div>
  )
}
