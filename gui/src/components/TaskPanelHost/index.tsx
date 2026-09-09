/**
 * TaskPanelHost — 任务链宿主（2026-08-12 任务链复活）
 *
 * 2026-08-04: 执行链任务卡彻底隐藏(用户嫌全尺寸卡干扰)。
 * 2026-08-12: 恢复极简任务进度浮层——running 任务以单行 compact 小卡呈现,
 * 克制原则(不打扰): 只渲染 running、完成/失败/取消事件到达立即消失、✕ 本地关闭。
 * 消费 /events 事件:
 *   - workflow:progress 等 → 写入 TaskPanelStore,渲染 running 卡
 *   - file_generated → 广播浏览器打开事件(HTML 自动预览)
 *   - proactive_speak → 主动通知卡 + TTS 播报
 *   - workflow:started → 多步骤任务计划确认卡(可"取消执行")
 * 语音接口: __taskPanel.setVisible 开关浮层显隐(通道 B)。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TaskPanelStore, type PanelEvent } from '../../lib/task-panel-store'
import { useSse } from '../../hooks/useSSE'
import { toProactiveNotice, INTENT_META, type ProactiveNotice } from '../../lib/proactive-meta'
import { useProactiveVoice } from '../../hooks/useProactiveVoice'
import { TaskPanelCard } from '../SceneShell/kinds/task-panel'
import { apiPost } from '../../lib/api'
import { registerCommandHost } from '../../lib/ui-command-registry'

export function TaskPanelHost() {
  const storeRef = useRef<TaskPanelStore | null>(null)
  if (!storeRef.current) storeRef.current = new TaskPanelStore({ onUpdate: (p) => setPanels([...p]) })
  const store = storeRef.current

  const [panels, setPanels] = useState(store.getPanels())
  const [pendingPlan, setPendingPlan] = useState<{ flowId: string; name: string; steps: string[] } | null>(null)
  const [proactiveMsg, setProactiveMsg] = useState<ProactiveNotice | null>(null)
  // 2026-08-12: 语音"打开/关闭任务面板"开关浮层显隐(整体含任务卡+计划卡+主动通知)
  const [visible, setVisible] = useState(true)
  // 2026-08-14: 原 dismissedIds(✕ 本地关闭任务卡)随 visiblePanels 恒空一并移除
  const proactiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { speak } = useProactiveVoice()
  // speak 放入 ref：useMemo handlers 闭包只捕获一次，避免闭包陈旧（参考 useSSE handlersRef 模式）
  const speakRef = useRef(speak)
  speakRef.current = speak

  // 2026-08-12: 语音命令接线(通道 B)——VoiceShell 调 __taskPanel.setVisible:
  // 关闭恒成功;打开时若无进行中任务返回 false(VoiceShell 据此播报"当前没有进行中的任务面板")
  useEffect(() => {
    // P7(GUI 全量修复, G1): registry 注册(自动镜像 window.__taskPanel)
    return registerCommandHost('taskPanel', {
      setVisible: (v: boolean) => {
        setVisible(v)
        return v ? store.getPanels().some(p => p.status === 'running') : true
      },
    })
  }, [store])

  // 2026-08-12: 语音"取消任务/停止任务"——本地规则+事件,由持有 store 的本组件找
  // 最近启动的 running flow 面板并 POST cancel
  useEffect(() => {
    const onCancelTask = () => {
      const flow = store.getPanels()
        .filter(p => p.status === 'running' && p.id.startsWith('flow:'))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (!flow) {
        console.warn('[task-panel] 语音取消任务: 当前无进行中的流程')
        return
      }
      void cancelFlow(flow.id.slice('flow:'.length)).then(ok => {
        if (!ok) console.warn('[task-panel] 取消任务失败:', flow.id)
      })
    }
    window.addEventListener('crabpaw:cancel-task', onCancelTask)
    return () => window.removeEventListener('crabpaw:cancel-task', onCancelTask)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  // 2026-08-13: 记录用户消息到最近 running 面板(P1-5 重试链路)——VoiceShell 发送时派发
  useEffect(() => {
    const onUserSent = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text
      if (!text) return
      const running = store.getPanels()
        .filter(p => p.status === 'running')
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (running) store.setLastUserMessage(running.id, text)
    }
    window.addEventListener('crabpaw:user-sent', onUserSent)
    return () => window.removeEventListener('crabpaw:user-sent', onUserSent)
  }, [store])

  // 2026-08-13: 重试——派发 crabpaw:resend-message(VoiceShell 重新发送原消息)
  // 2026-08-14: 任务卡不再渲染,panelId 参数保留供调用方兼容
  const handleRetryTask = (_panelId: string, text: string) => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:resend-message', { detail: { text } }))
    } catch (err) {
      console.error('[task-panel] 重试事件派发失败:', (err as any)?.message || err)
    }
  }

  // 2026-08-14: 原 dismissedIds 清理/✕ 关闭逻辑随 visiblePanels 恒空一并移除

  // 2026-08-13 P2-2: run 终态徽章——成功卡 25s autoCleanup 用户看不到,
  // 独立瞬态徽章 5s 淡出即时反馈(完成✓/失败✗/中断⊘)
  const [terminalBadges, setTerminalBadges] = useState<Array<{ id: string; label: string; kind: 'ok' | 'error' | 'interrupt' }>>([])
  const pushTerminalBadge = useCallback((status?: string, ts?: number) => {
    const kind = status === 'error' ? 'error' : status === 'interrupted' ? 'interrupt' : 'ok'
    const label = kind === 'error' ? '任务失败' : kind === 'interrupt' ? '任务已中断' : '任务完成'
    const id = `${status || 'ok'}-${ts || Date.now()}`
    setTerminalBadges(prev => [...prev.slice(-2), { id, label, kind }])
    setTimeout(() => {
      setTerminalBadges(prev => prev.filter(b => b.id !== id))
    }, 5000)
  }, [])

  /**
   * 任务卡 ✕ / 计划卡"取消执行"共用:
   * flow 面板 → 调后端取消(2026-08-14: 无卡可关,仅保留取消动作)。
   */
  const handleCancelTask = async (id: string) => {
    if (id.startsWith('flow:')) {
      const ok = await cancelFlow(id.slice('flow:'.length))
      if (!ok) console.warn('[task-panel] 取消任务失败:', id)
    }
  }

  // 主动通知 60s 自动淡出
  useEffect(() => {
    if (proactiveTimerRef.current) clearTimeout(proactiveTimerRef.current)
    if (proactiveMsg) {
      proactiveTimerRef.current = setTimeout(() => setProactiveMsg(null), 60_000)
    }
    return () => { if (proactiveTimerRef.current) clearTimeout(proactiveTimerRef.current) }
  }, [proactiveMsg])

  // 2026-09-06 风险告警轮: 通知卡关闭——risk_alert 触发器回传当日确认
  //（POST /api/proactive/ack），同内容告警当天不再重复播报（数据变化自动恢复）；
  // 其余触发器维持纯本地关闭。
  const closeProactive = useCallback(() => {
    const msg = proactiveMsg
    setProactiveMsg(null)
    if (msg?.trigger === 'risk_alert' && msg.text) {
      apiPost('/api/proactive/ack', { trigger: msg.trigger, text: msg.text })
        .catch((e: any) => console.warn('[task-panel] 告警确认回传失败:', e?.message))
    }
  }, [proactiveMsg])

  // 计划确认卡 60s 超时兜底：流程若一直无 complete/error/cancelled 事件，卡不常驻
  useEffect(() => {
    if (!pendingPlan) return
    const t = setTimeout(() => {
      setPendingPlan(prev => prev && prev.flowId === pendingPlan.flowId ? null : prev)
    }, 60_000)
    return () => clearTimeout(t)
  }, [pendingPlan])

  useSse({
    path: '/events',
    handlers: useMemo(() => {
      const h: Record<string, (data: any) => void> = {}

      // 任务事件写入 store(running 卡渲染,结束卡由 autoCleanup 统一清理)
      h['activity'] = (data: any) => {
        const activityType = data?.type
        // 2026-08-29 Task 8: 后端 activity-stream TYPE 枚举只有 tool_preparing/tool_executing/
        // tool_result,从不广播 type==='tool_call' 的 activity——旧条件使"执行中"条目永不注入。
        // preparing/executing 归一为 tool_call 由 toPanelEvent 完成。
        if (activityType === 'tool_call' || activityType === 'tool_preparing' || activityType === 'tool_executing'
          || activityType === 'tool_result' || activityType === 'thinking') {
          const evt = toPanelEvent(activityType, data)
          if (evt) { try { store.ingest(evt) } catch (e) { console.error('[task-panel] 事件写入失败:', (e as any)?.message || e) } }
        }
      }

      const types = ['workflow:progress', 'workflow:complete', 'workflow:error', 'workflow:cancelled', 'wecom_message']
      for (const t of types) {
        h[t] = (data: any) => {
          try {
            const evt = toPanelEvent(t, data)
            if (evt) store.ingest(evt)
          } catch (e) { console.error('[task-panel] 事件写入失败:', (e as any)?.message || e) }
          // 流程结束事件（complete/error/cancelled）：匹配 flowId 清除对应计划确认卡
          if (t === 'workflow:complete' || t === 'workflow:error' || t === 'workflow:cancelled') {
            const flowId = data?.flowId || 'wf'
            setPendingPlan(prev => prev && prev.flowId === flowId ? null : prev)
          }
        }
      }

      // file_generated:写入 store + 浏览器打开事件广播(HTML 自动预览)
      h['file_generated'] = (data: any) => {
        try {
          const evt = toPanelEvent('file_generated', data)
          if (evt) store.ingest(evt)
        } catch (e) { console.error('[task-panel] 事件写入失败:', (e as any)?.message || e) }
        // 生成的网页/可视化文件 → 广播浏览器打开事件
        const path = data?.path || ''
        if (path && /\.(html?|htm)$/i.test(path)) {
          try {
            window.dispatchEvent(new CustomEvent('crabpaw:open-browser', { detail: { path } }))
          } catch (err) {
            console.error('[task-panel] 浏览器打开事件广播失败:', (err as any)?.message || err)
          }
        }
      }

      // proactive_speak 事件:主动通知卡 + TTS 播报
      h['proactive_speak'] = (data: any) => {
        const notice = toProactiveNotice(data)
        if (!notice) return
        setProactiveMsg(notice)
        // silent 意图只入面板;其余经打扰抑制守卫播报(正在说话时不插嘴)
        if (notice.intent !== 'silent') {
          // S2.2: OS 系统通知——与通知卡+TTS 并行,互不替代(浏览器无 electronAPI 自然跳过)
          try {
            const notifyResult = window.electronAPI?.notify?.({
              title: notice.surface?.title || 'CrabPaw 提醒',
              body: notice.text,
            })
            if (notifyResult && typeof notifyResult.catch === 'function') {
              notifyResult.catch((e: any) => console.warn('[task-panel] OS 通知失败:', e?.message || e))
            }
          } catch (e) {
            console.warn('[task-panel] OS 通知调用异常:', (e as any)?.message || e)
          }
          speakRef.current(notice.text, notice.intent)
        }
      }

      // workflow:started:写入 store + 计划确认制(多步骤任务先亮计划卡)
      h['workflow:started'] = (data: any) => {
        try {
          const evt = toPanelEvent('workflow:started', data)
          if (evt) store.ingest(evt)
        } catch (e) { console.error('[task-panel] 事件写入失败:', (e as any)?.message || e) }
        const steps = (data?.steps || []) as string[]
        if (steps.length >= 2) {
          setPendingPlan({ flowId: data?.flowId || 'wf', name: data?.name || data?.workflow || '任务', steps })
        }
      }

      // 2026-08-13 P2-2: run 终态事件(ag-ui RunFinished/RunError 借鉴)——
      // roundId 面板置终态 + 终态徽章(5s 淡出,弥补 success 卡 25s 才消失的观感)
      const runTypes = ['run:finished', 'run:error', 'run:interrupt']
      for (const t of runTypes) {
        h[t] = (data: any) => {
          try {
            const evt = toPanelEvent(t, data)
            if (evt) store.ingest(evt)
          } catch (e) { console.error('[task-panel] 事件写入失败:', (e as any)?.message || e) }
          pushTerminalBadge(data?.status, data?.ts)
        }
      }

      // 2026-08-13 P2-2: phase 阶段事件——更新 roundId 面板当前动作(阶段可视化)
      h['phase'] = (data: any) => {
        try {
          const roundId = data?.roundId
          const label = data?.label || data?.phase
          if (!roundId || !label) return
          const panel = store.getPanels().find(p => p.id === roundId && p.status === 'running')
          if (panel) {
            panel.currentAction = String(label)
            store.ingest({ type: 'thinking', roundId, summary: String(label), ts: Date.now() })
          }
        } catch (e) { console.error('[task-panel] phase 处理失败:', (e as any)?.message || e) }
      }

      return h
    }, [store]),
  })

  // 完成卡片自动清理——成功/失败/取消的任务 25s 后从 store 移除(防内存膨胀)。
  // 2026-08-13: error 卡豁免——失败任务保留供用户重试(✕ 或重试成功后关闭)。
  const autoCleanupRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useEffect(() => {
    for (const p of panels) {
      if (p.status !== 'running' && p.status !== 'error') {
        if (!autoCleanupRef.current.has(p.id)) {
          const t = setTimeout(() => {
            try { store.clear(p.id) } catch (e) { console.error('[task-panel] 自动清理失败:', (e as any)?.message || e) }
            autoCleanupRef.current.delete(p.id)
          }, 25000)
          autoCleanupRef.current.set(p.id, t)
        }
      } else if (autoCleanupRef.current.has(p.id)) {
        clearTimeout(autoCleanupRef.current.get(p.id))
        autoCleanupRef.current.delete(p.id)
      }
    }
    // 清理已移除卡片的定时器
    const ids = new Set(panels.map(p => p.id))
    for (const [id, t] of autoCleanupRef.current) {
      if (!ids.has(id)) { clearTimeout(t); autoCleanupRef.current.delete(id) }
    }
  }, [panels, store])

  // 2026-08-12 任务链复活: 只渲染 running 面板(单行 compact 小卡,克制不打扰)。
  // 2026-08-13: error 卡纳入渲染(失败可见 + 重试按钮)——用户可重试或 ✕ 关闭。
  // 完成/取消事件到达 → status 变化 → 卡立即消失;✕ → 本地关闭(dismissedIds)。
  // 2026-08-14(用户反馈): "任务处理中"状态条与右栏行动日志/思考工具重复矛盾 →
  // 任务卡并入右栏"工具执行"区(flow.toolEvents 渲染 running/ok/fail),此处不再渲染;
  // store 与取消/重试事件接线保留(语音"取消任务"等仍可用)。
  const visiblePanels = panels.filter(() => false)

  // 语音"关闭任务面板"→ 整体显隐(连同主动通知一起隐藏);无任何内容时不占位
  if (!visible) return null
  if (!pendingPlan && !proactiveMsg && visiblePanels.length === 0) return null

  // 2026-08-14: surface 顶层 title 优先(risk-alert-service 直发),data.title 兜底;无 title 时整体展示 text
  const proactiveSurface = proactiveMsg?.surface
  const proactiveTitle = proactiveSurface?.title ?? proactiveSurface?.data?.title

  return (
    <div className="fixed right-4 bottom-16 z-40 flex flex-col gap-2 max-w-xs pointer-events-none">
      {visiblePanels.map(p => (
        <div key={p.id} style={{ pointerEvents: 'auto' }}>
          <TaskPanelCard
            panel={p}
            compact
            onCancel={(id) => { void handleCancelTask(id) }}
            onRetry={p.status === 'error' && p.lastUserMessage
              ? () => handleRetryTask(p.id, p.lastUserMessage!)
              : undefined}
          />
        </div>
      ))}
      {/* 2026-08-13 P2-2: run 终态徽章(5s 淡出) */}
      {terminalBadges.map(b => (
        <div
          key={b.id}
          style={{
            pointerEvents: 'none',
            alignSelf: 'flex-end',
            fontSize: 11,
            padding: '4px 12px',
            borderRadius: 999,
            border: `1px solid ${b.kind === 'error' ? 'rgba(248,113,113,0.5)' : b.kind === 'interrupt' ? 'rgba(148,163,184,0.5)' : 'rgba(74,222,128,0.5)'}`,
            color: b.kind === 'error' ? '#f87171' : b.kind === 'interrupt' ? '#94a3b8' : '#4ade80',
            background: 'rgba(24,24,36,0.85)',
            animation: 'tp-badge-in 0.25s ease-out',
          }}
        >
          {b.kind === 'error' ? '✗ ' : b.kind === 'interrupt' ? '⊘ ' : '✓ '}{b.label}
        </div>
      ))}
      {proactiveMsg && (
        <div style={{ pointerEvents: 'auto', padding: '14px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: `1px solid ${INTENT_META[proactiveMsg.intent].color}44`, minWidth: 280, maxWidth: 360 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: INTENT_META[proactiveMsg.intent].color }}>
              {proactiveMsg.intent === 'confront' ? '🔔 ' : proactiveMsg.intent === 'silent' ? '🕐 ' : '🔊 '}{INTENT_META[proactiveMsg.intent].label}
            </span>
            <span style={{ fontSize: 10, color: '#555' }}>{proactiveMsg.trigger}</span>
          </div>
          <div style={{ fontSize: 13, color: '#eee', lineHeight: 1.5 }}>
            {proactiveTitle ? (
              <>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{proactiveTitle}</div>
                <div style={{ color: '#aaa', fontSize: 12 }}>{proactiveSurface?.data?.body || proactiveMsg.text}</div>
              </>
            ) : proactiveMsg.text}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              type="button"
              onClick={closeProactive}
              style={{ fontSize: 11, padding: '5px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#999', cursor: 'pointer' }}
            >
              {proactiveMsg.trigger === 'risk_alert' ? '今日不再提醒' : '知道了'}
            </button>
          </div>
        </div>
      )}
      {pendingPlan && (
        <div style={{ pointerEvents: 'auto', padding: '14px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.92)', backdropFilter: 'blur(16px)', border: '1px solid rgba(249,115,22,0.35)', minWidth: 280, maxWidth: 360 }}>
          <div style={{ fontSize: 12, color: '#f97316', fontWeight: 600, marginBottom: 8 }}>📋 执行计划确认</div>
          <div style={{ fontSize: 13, color: '#eee', marginBottom: 8 }}>{pendingPlan.name}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
            {pendingPlan.steps.map((s, i) => (
              <div key={i} style={{ fontSize: 11, color: '#aaa', display: 'flex', gap: 6 }}>
                <span style={{ color: '#f97316' }}>{i + 1}.</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => setPendingPlan(null)}
              style={{ fontSize: 11, padding: '5px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: '#999', cursor: 'pointer' }}
            >
              知道了
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!pendingPlan) return
                // 2026-08-12: 取消执行——POST /api/taskflows/:flowId/cancel;成功直接关卡
                // (后端 cancelled 事件兜底也会清 pendingPlan),失败 console.error + 卡片保留
                const ok = await cancelFlow(pendingPlan.flowId)
                if (ok) setPendingPlan(null)
              }}
              style={{ fontSize: 11, padding: '5px 14px', borderRadius: 999, border: '1px solid rgba(244,67,54,0.45)', background: 'rgba(244,67,54,0.08)', color: '#f87171', cursor: 'pointer' }}
            >
              取消执行
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 取消流程: POST /api/taskflows/:flowId/cancel(与 taskflow-handler.js 端点对应)。
 * 成功返回 true;失败 console.error 并返回 false(调用方保留卡片)。
 */
async function cancelFlow(flowId: string): Promise<boolean> {
  try {
    const res = await apiPost(`/api/taskflows/${flowId}/cancel`, {})
    if (!res.success) {
      console.error('[task-panel] 取消任务失败:', res.error || '未知错误')
      return false
    }
    return true
  } catch (e) {
    console.error('[task-panel] 取消任务异常:', (e as any)?.message || e)
    return false
  }
}

/** 纯函数:将 SSE 事件数据转换为 PanelEvent(模块级,无闭包依赖) */
// 2026-08-29 Task 8: 导出供单测;后端 activity 真实广播的执行中类型是
// tool_preparing/tool_executing(activity-stream.js TYPE 枚举,载荷顶层带
// toolName/roundId/summary),归一为面板 tool_call。
export function toPanelEvent(type: string, data: any): PanelEvent | null {
  try {
    switch (type) {
      // 后端"准备工具/执行工具"两相位 → 面板 tool_call(执行中条目)
      case 'tool_preparing':
      case 'tool_executing':
      case 'tool_call':
        return { type: 'tool_call', roundId: data?.roundId, toolName: data?.toolName || '', summary: data?.summary || data?.toolName || '', ts: Date.now() }
      case 'tool_result':
        // 2026-08-13 P1-8: cardState(running/done/error) 兜底——chat 流与 activity
        // 双通道统一,失败判断优先 success===false
        return { type: 'tool_result', roundId: data?.roundId, toolName: data?.toolName || '', status: data?.success === false || data?.cardState === 'error' ? 'error' : 'success', summary: data?.summary || '', ts: Date.now() }
      case 'workflow:started':
        return { type: 'workflow_start', flowId: data?.flowId || 'wf', name: data?.name || data?.workflow || '任务', steps: data?.steps, ts: Date.now() }
      case 'workflow:progress':
        return { type: 'workflow_step', flowId: data?.flowId || 'wf', stepId: data?.stepId || '', name: data?.stepName || '步骤', status: data?.status === 'error' ? 'error' : (data?.status === 'done' || data?.status === 'complete') ? 'done' : 'running', ts: Date.now() }
      case 'workflow:cancelled':
        return { type: 'panel_cancel', id: 'flow:' + (data?.flowId || 'wf'), ts: Date.now() }
      // 2026-08-13 P2-2: run 终态(roundId 面板)
      case 'run:finished':
        return { type: 'run_finished', roundId: data?.roundId || '', ts: Date.now() }
      case 'run:error':
        return { type: 'run_error', roundId: data?.roundId || '', error: data?.error, ts: Date.now() }
      case 'run:interrupt':
        return { type: 'run_interrupted', roundId: data?.roundId || '', ts: Date.now() }
      case 'workflow:complete':
        return { type: 'workflow_complete', flowId: data?.flowId || 'wf', ts: Date.now() }
      case 'workflow:error':
        return { type: 'workflow_error', flowId: data?.flowId || 'wf', error: data?.error, ts: Date.now() }
      case 'wecom_message': {
        const hasFile = data?.file
        if (!hasFile) return null
        const baseName = data?.file?.name || '附件'
        const fileCount = data?.fileCount
        const fileName = (typeof fileCount === 'number' && fileCount > 1) ? `${baseName}（共 ${fileCount} 个附件）` : baseName
        return { type: 'wecom_doc', title: '收到企微文档', fileName, ts: Date.now() }
      }
      // 2026-08-13 G10: thinking(SSE)→PanelEvent——语音思考状态进入任务面板(store 已有 thinking 聚合)
      case 'thinking':
        return { type: 'thinking', roundId: data?.roundId, summary: data?.summary || data?.label || '思考中…', ts: Date.now() }
      default:
        return null
    }
  } catch (err) {
    console.error('[task-panel] 事件转换失败:', (err as any)?.message || err)
    return null
  }
}
