/**
 * HudBar.tsx — HUD 单数字常驻条（2026-09-30，P1-3 规格 §5）
 *
 * 场景：老板在会议中需要"瞄一眼"，不是"打开面板"。一条极薄的常驻条只承载
 * **一个数字 + 一个方向 + 一个风险点 + 新鲜度**，点击展开完整卡。
 *
 * 为什么做成应用内常驻条，而不是独立窗口/托盘：
 *   实测 `main/index.ts:847` —— 便携版（U 盘）点 X 是**真正退出**（缩托盘仅 isDev 生效），
 *   所以脱离主窗口的常驻路径在目标形态下没有活着的后端可查。要"瞄一眼"就得在应用内。
 *
 * 诚实降级（本组件的核心价值，规格 §5.2）：
 *   四态可被截图区分——取数失败显示 `—` 而**不是 0**，未导入显示"未导入"，
 *   陈旧则数字照显示但带沙漏。常驻在视野里把失败显示成 0，会被持续当成事实。
 *
 * 显示口径全部由 lib/hud-metric 决定（纯函数、已测）；本组件只负责渲染与取数，
 * 不含任何业务判断——这样"显示什么"是可断言的，"长什么样"可以随时改。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildHudView,
  hudInputFromBriefing,
  type HudMetricKey,
  type HudView,
} from '../../lib/hud-metric'
import './styles.css'

/** 默认指标：逾期应收（老板最先该看钱的去向） */
export const DEFAULT_HUD_METRIC: HudMetricKey = 'overdueReceivable'

/** 默认轮询间隔：60s。常驻条不需要秒级新鲜度，省电优先（U 盘设备常是旧笔记本） */
export const DEFAULT_POLL_MS = 60_000

export interface HudBarProps {
  /** 指标种类（默认逾期应收） */
  metric?: HudMetricKey
  /** 是否启用轮询（测试/演示可关） */
  polling?: boolean
  /** 轮询间隔（ms） */
  pollMs?: number
  /**
   * 取数函数（注入）。缺省走 /api/briefing/today。
   * 测试注入假实现即可完全离线验证四种状态的渲染。
   */
  fetcher?: () => Promise<unknown>
  /** 点击展开完整卡 */
  onExpand?: () => void
  /** 2026-09-30 P2: 查看数据出处（"这数从哪来"）。不传则不显示该入口 */
  onShowProvenance?: () => void
  /** 初始状态（测试用；生产留空） */
  initialView?: HudView | null
}

async function defaultFetcher(): Promise<unknown> {
  const { apiGet } = await import('../../lib/api')
  const res = await apiGet<Record<string, unknown>>('/api/briefing/today')
  if (!res?.success) throw new Error(res?.error || '取数失败')
  return res.data
}

export function HudBar({
  metric = DEFAULT_HUD_METRIC,
  polling = true,
  pollMs = DEFAULT_POLL_MS,
  fetcher,
  onExpand,
  onShowProvenance,
  initialView = null,
}: HudBarProps) {
  const [view, setView] = useState<HudView | null>(initialView)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => () => { mountedRef.current = false }, [])

  const refresh = useCallback(async () => {
    const load = fetcher ?? defaultFetcher
    try {
      const payload = await load()
      if (!mountedRef.current) return
      setView(buildHudView(hudInputFromBriefing(payload as never, metric)))
    } catch (e) {
      if (!mountedRef.current) return
      // 取数失败 → failed 视图（显示 — 而非 0），错误原文进 detail 供 hover 查看
      setView(buildHudView({
        metric,
        ok: false,
        errorDetail: (e as Error)?.message || String(e),
        now: Date.now(),
      }))
    }
  }, [fetcher, metric])

  useEffect(() => {
    void refresh()
    if (!polling) return
    timerRef.current = setInterval(() => { void refresh() }, pollMs)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [refresh, polling, pollMs])

  // 首帧尚无数据：显示占位而不是"0"（宁可慢一步，也不能先给个假数）
  if (!view) {
    return (
      <div className="hud-bar-wrap">
        <button type="button" className="hud-bar hud-bar--loading" aria-busy="true" title="正在取数">
          <span className="hud-bar__label">经营</span>
          <span className="hud-bar__value">···</span>
        </button>
      </div>
    )
  }

  const clickable = view.expandable && !!onExpand
  const cls = `hud-bar hud-bar--${view.state}`
  const title = [
    `${view.label}：${view.value}`,
    view.delta ? `较上期 ${view.delta}` : null,
    view.risk ? `关注：${view.risk}` : null,
    view.freshness ? `更新于${view.freshness}` : null,
    view.detail,
  ].filter(Boolean).join('\n')

  const inner = (
    <>
      <span className="hud-bar__label">{view.label}</span>
      <span className="hud-bar__value">{view.value}</span>
      {view.delta && <span className="hud-bar__delta">{view.delta}</span>}
      {view.risk && <span className="hud-bar__risk">· {view.risk}</span>}
      {view.freshness && (
        <span className="hud-bar__fresh">
          {view.state === 'stale' && <span className="hud-bar__stale-icon" aria-hidden>⌛</span>}
          {view.freshness}
        </span>
      )}
      {clickable && <span className="hud-bar__chevron" aria-hidden>▸</span>}
    </>
  )

  const bar = clickable ? (
    <button type="button" className={cls} title={title} onClick={onExpand} aria-label={`${view.label} ${view.value}，点击查看详情`}>
      {inner}
    </button>
  ) : (
    <div className={cls} title={title} role="status" aria-live="polite">
      {inner}
    </div>
  )

  // 出处入口（P2）：与主数字分离，避免误点；标签用大白话"从哪来"
  return (
    <div className="hud-bar-wrap">
      {bar}
      {onShowProvenance && (
        <button
          type="button"
          className="hud-bar__prov"
          title="这个数字是怎么算出来的"
          aria-label="查看数据出处"
          onClick={onShowProvenance}
        >从哪来</button>
      )}
    </div>
  )
}
