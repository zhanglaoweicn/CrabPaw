/**
 * SceneShell — Scene UI 前端渲染器（v2 增强版）
 *
 * 完全重写，修复了以下关键问题：
 * 1. ✅ patch 消息之前被前端忽略（实时更新不生效）— 现增加 patch 处理
 * 2. ✅ 增强动画：film-grade 动画系统（620ms enter / 420ms exit / 520ms morph）
 * 3. ✅ 新增卡片种类：awakening, selfcheck, image, metric(增强), choice(增强)
 * 4. ✅ Intent 权重：ambient(缩小) / inform(正常) / confront(高亮边框)
 * 5. ✅ 交错延迟 (stagger)：按 order 自动计算延迟
 * 6. ✅ dataEqual 深度比较（替代 JSON.stringify）
 * 7. ✅ prefers-reduced-motion 支持
 * 8. ✅ FLIP 共享元素转场（§六）：记录 prev 位置 → 计算 delta → 下一帧 transition 回原位
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSceneSurfaces, sceneIntentV1 } from '../../lib/scene-client'
import { getKindRenderer, type KindRenderer } from './kinds'
import { apiPost } from '../../lib/api'
import { toast } from 'sonner'
import { registerCommandHost, getCommandHost } from '../../lib/ui-command-registry'
import './styles.css'

/* ─── 类型 ─── */
export interface Surface {
  id: string
  kind: string
  data?: any
  intent?: 'ambient' | 'inform' | 'confront'
  focus?: boolean
  order?: number
}

type Phase = 'enter' | 'morph' | 'exit'

interface AnimatedSurface extends Surface {
  _phase: Phase
  _stagger?: number
  _instanceKey?: string  // R9 fix: 唯一实例键，防止同 id surface 被定时器误操作
}

/* ─── 深度数据比较（替代 JSON.stringify） ─── */
function dataEqual(a: any, b: any): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a == null || b == null) return a === b
  if (typeof a !== 'object') return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => dataEqual(v, b[i]))
  }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && dataEqual(a[k], b[k]))
}

/* ─── 交错延迟 ─── */
function staggerFromOrder(order?: number): number {
  return order !== undefined ? Math.min(Math.max(order, 0), 5) : 0
}

/* ─── 组件 ─── */
export function SceneShell() {
  const [items, setItems] = useState<AnimatedSurface[]>([])
	  const prevRef = useRef<Map<string, Surface>>(new Map())
	  const timerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
	  const revRef = useRef(0)
	  const mountedRef = useRef(true)
	  // B15 fix: 唯一定时器 ID 计数器，避免 surface id 复用导致定时器冲突
	  const timerIdCounter = useRef(0)

  /** 应用 scene (支持 snapshot 和 patch) */
  const applyScene = useCallback((incoming: Surface[], rev?: number) => {
    if (rev !== undefined) {
      // 2026-08-07: 后端重启时 _rev 归零(scene-store.js:131)——rev 回退意味着
      // 新代际(正常协议只递增)。重置 revRef 接受新代际,相同 rev 仍忽略防重复。
      if (rev < revRef.current) revRef.current = rev - 1
      if (rev <= revRef.current) return // 旧版本忽略
      revRef.current = rev
    }

    const prev = prevRef.current
    const next = new Map<string, Surface>()
    const updates: AnimatedSurface[] = []
    const exiting: string[] = []

    // 1. 找出消失的 surface
    for (const [id] of prev) {
      if (!incoming.find(s => s.id === id)) exiting.push(id)
    }

    incoming.forEach(s => next.set(s.id, s))

    // 2. Exit 动画 (420ms 后移除)
			    for (const id of exiting) {
			      const old = prev.get(id)!
			      // R9 fix: 分配唯一实例键，确保定时器只移除对应的旧表面而非同 id 新表面
			      const instanceKey = `exit_${id}_${++timerIdCounter.current}`
			      updates.push({ ...old, _phase: 'exit', _stagger: staggerFromOrder(old.order), _instanceKey: instanceKey })
			      const t = setTimeout(() => {
			        if (mountedRef.current) {
			          // R9 fix: 通过 _instanceKey 匹配，而非 id，避免新表面被误删
			          setItems(prev2 => prev2.filter(i => i._instanceKey !== instanceKey))
			        }
			        timerRef.current.delete(instanceKey)
			      }, 420)
			      timerRef.current.set(instanceKey, t)
			    }

    // 3. Enter / Morph
    incoming.forEach((s, idx) => {
      const existing = prev.get(s.id)
      const stagger = staggerFromOrder(s.order ?? idx)

      if (!existing) {
		        // 新 surface → enter
		        // R9 fix: 分配唯一实例键，确保定时器只 morph 对应的表面
		        const instanceKey = `enter_${s.id}_${++timerIdCounter.current}`
		        updates.push({ ...s, _phase: 'enter', _stagger: stagger, _instanceKey: instanceKey })
		        // B15 fix: 使用唯一定时器 ID 而非 surface id
		        const timerId = `enter_${s.id}_${timerIdCounter.current}`
		        const t = setTimeout(() => {
		          if (mountedRef.current) {
		            // R9 fix: 通过 _instanceKey 匹配，而非 id，避免新表面被误 morph
		            setItems(prev2 => prev2.map(i =>
		              i._instanceKey === instanceKey ? { ...i, _phase: 'morph' as Phase } : i
		            ))
		          }
		          timerRef.current.delete(timerId)
		        }, 620)
		        timerRef.current.set(timerId, t)
      } else if (!dataEqual(existing.data, s.data)) {
        // 数据变化 → morph
        updates.push({ ...s, _phase: 'morph', _stagger: stagger })
      } else {
        // 无变化 → 保持 morph
        updates.push({ ...existing, _phase: 'morph', _stagger: stagger })
      }
    })

    prevRef.current = next
    setItems(updates.sort((a, b) => (a.order || 0) - (b.order || 0)))
  }, [])

  // ── mounted ref ──
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  // ── 订阅 scene-client 的 surface 数据（替代独立 WS） ──
  const { surfaces, rev } = useSceneSurfaces()

  useEffect(() => {
    applyScene(surfaces, rev)
  }, [surfaces, rev, applyScene])

  // ── 2026-08-25 界面自检员(视觉闭环): 高价值面板出现后延时截图→主模型
  //    校验是否真的渲染成功(弹卡类隐性失败的探测仪)。仅 Electron 窗口(截图 IPC);
  //    每面板每次会话只检一次——差异 toast+日志, 正常仅日志。
  const VERIFY_KINDS: Record<string, string> = {
    'typhoon-panel': '台风面板应显示台风编号/等级/路径轨迹地图, 不应是空白或仅文字',
    'hotspot-panel': '热点面板应显示热点榜单卡片(平台名/排名/话题/热度), 不应空白',
    'file-panel': '文件生成面板应显示生成产物内容或文件条目, 不应空白',
  }
  const verifiedOnceRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const ids = Object.keys(surfaces || {})
    const targets = ids.filter(id => VERIFY_KINDS[id] && !verifiedOnceRef.current.has(id))
    if (targets.length === 0) return
    targets.forEach(id => verifiedOnceRef.current.add(id))
    const timer = setTimeout(async () => {
      try {
        const w = window as unknown as { electronAPI?: { window?: { screenshot?: () => Promise<{ ok: boolean; dataUrl?: string }> } } }
        const shot = await w?.electronAPI?.window?.screenshot?.()
        if (!shot?.ok || !shot.dataUrl) return // 非 Electron 环境静默
        for (const id of targets) {
          try {
            const res = await apiPost('/api/vision/verify', {
              image: shot.dataUrl,
              expectation: VERIFY_KINDS[id],
              kind: id,
            }) as unknown as { success?: boolean; verified?: boolean; note?: string }
            if (res?.success && res.verified === false) {
              const note = String(res.note || '').slice(0, 90)
              console.warn('[visual-verify]', id, res.note)
              try { toast.warning(`界面自检异常(${id}): ${note}`) } catch { /* toast 兜底 */ }
            } else if (res?.success) {
              console.log('[visual-verify] OK', id)
            }
          } catch (e) { console.warn('[visual-verify] 校验请求失败:', e) }
        }
      } catch (e) { console.warn('[visual-verify] 截图/校验失败:', e) }
    }, 1200)
    return () => clearTimeout(timer)
  }, [surfaces])

  // ── 清理定时器（SceneShell 卸载时） ──
  useEffect(() => {
    return () => {
      for (const [, t] of timerRef.current) clearTimeout(t)
    }
  }, [])

  // ── P5 触摸：水平滑动关卡（本地 dismiss，不入 surface 订阅流） ──
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const handleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    if (t) touchStartRef.current = { x: t.clientX, y: t.clientY }
  }
  const handleTouchEnd = (id: string) => (e: React.TouchEvent) => {
    const start = touchStartRef.current
    touchStartRef.current = null
    if (!start) return
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - start.x
    const dy = t.clientY - start.y
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      setDismissedIds(prev => new Set(prev).add(id))
    }
  }

  // ── P5.5 语音面板控制：window.__sceneShell.setVisible / closeTop ──
  useEffect(() => {
    const api = {
      // 返回该 kind 是否存在于当前面板流（P5.5 最终审查 M4: 空面板守卫 — 无数据时调用方播报"当前没有"）
      setVisible: (kind: string, visible: boolean): boolean => {
        const hasKind = items.some(s => s.kind === kind)
        setDismissedIds(prev => {
          const next = new Set(prev)
          if (visible) {
            // 恢复显隐：把该 kind 的条目（按 _instanceKey，无则 id 兜底）从 dismissed 移除
            for (const key of next) {
              if (items.some(s => (s._instanceKey ?? s.id) === key && s.kind === kind)) next.delete(key)
            }
          } else {
            for (const s of items) {
              if (s.kind === kind) next.add(s._instanceKey ?? s.id)
            }
          }
          return next
        })
        return hasKind
      },
      closeTop: () => {
        setDismissedIds(prev => {
          const next = new Set(prev)
          const visibleItems = items.filter(s => !prev.has(s._instanceKey ?? s.id))
          const top = visibleItems[visibleItems.length - 1]
          if (top) next.add(top._instanceKey ?? top.id)
          return next
        })
      },
    }
    // A1: 经 ui-command-registry 注册(旧 window.__sceneShell 退役)
    const unregisterScene = registerCommandHost('sceneShell', api)
    return () => { unregisterScene() }
  }, [items])

  if (items.length === 0) return null

  // P4 戏剧强度：按最高 intent 计算镜头聚焦 (confront > ambient > inform)
  const focusIntent = items.some(s => s.intent === 'confront') ? 'confront'
    : items.some(s => s.intent === 'ambient') ? 'ambient' : 'inform'

  return (
    <div className="fixed right-4 bottom-16 z-[var(--z-float-stack)] flex flex-col gap-2 max-w-xs pointer-events-none" data-focus={focusIntent}>
      {items
        .filter(s => !dismissedIds.has(s._instanceKey ?? s.id))
        .map((surface, idx) => (
          <div
            key={surface._instanceKey ?? surface.id}
            style={{ pointerEvents: 'auto' }}  // P5 触摸：外层容器 pointer-events-none，卡片须可命中才能收 touch
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd(surface._instanceKey ?? surface.id)}
          >
            <SurfaceRenderer surface={surface} index={idx} />
          </div>
        ))}
    </div>
  )
}

/* ─── 动画 class ─── */
function animClass(phase: Phase, intent: string): string {
  const classes = ['scene-surface']
  const intentClass = intent === 'confront' ? ' scene-intent-confront'
    : intent === 'ambient' ? ' scene-intent-ambient' : ''

  switch (phase) {
    case 'enter':
      return [...classes, 'is-entering', intentClass].join(' ')
    case 'exit':
      return [...classes, 'is-exiting', intentClass].join(' ')
    case 'morph':
      return [...classes, 'is-morphing', intentClass].join(' ')
    default:
      return classes.join(' ')
  }
}

/* ─── Kind 级最小形状守卫 ─── */
const kindShapeGuards: Record<string, (data: any) => boolean> = {
  person_card: (d) => d && typeof d.name === 'string',
  // 2026-08-17: 放行 candlestick——ChartCard 支持 K线模式（datasets 可为空，走 ohlc），
  // 守卫此前只认 datasets → stocks-kline 被误判"数据不足"显示丑陋占位卡（实机反馈）。
  chart: (d) => d && (Array.isArray(d.datasets) || (d.type === 'candlestick' && Array.isArray(d.ohlc))),
  form: (d) => d && Array.isArray(d.fields),
  expert_review: (d) => d && Array.isArray(d.agents),
  metric: (d) => d && (d.value !== undefined && d.label !== undefined || Array.isArray(d.items) && d.items.length > 0),
  weather: (d) => d && typeof d.city === 'string' && d.temp !== undefined,
  timeline: (d) => d && Array.isArray(d.events),
  music: (d) => d && typeof d.title === 'string',
  music_player: (d) => d && typeof d.title === 'string',
  media: (d: any) => d && Array.isArray(d.items),
  media_stage: (d: any) => d && Array.isArray(d.items),
  image: (d) => d && typeof d.src === 'string',
  choice: (d) => d && typeof d.question === 'string' && Array.isArray(d.options),
  contract: (d) => d && typeof d.title === 'string' && Array.isArray(d.clauses),
  document: (d) => d && typeof d.title === 'string' && Array.isArray(d.pages),
  progress: (d) => d && (typeof d.percent === 'number' || typeof d.progress === 'number'),
  'web-preview': (d) => d && typeof d.url === 'string',
  web_preview: (d) => d && typeof d.url === 'string',
}

// 2026-08-17 设计变更: 移除"数据不完整"占位卡。
// 产品要求：①不论数据是否充足，卡片都要弹出（组件内建空态兜底，如 ChartCard
// "暂无K线数据"、StocksCard "暂无持仓"）；②绝不能在主界面显示无样式的丑陋占位卡。
// 形状守卫失败（数据形状完全不对）→ 不渲染（null），由 kind 组件自身的空态负责"有卡"。

/** 局部错误边界：防止单个 surface 崩溃整页（渲染失败不显示占位，静默跳过 + 日志） */
class KindErrorBoundary extends React.Component<{ kind: string; children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: { kind: string; children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[SceneShell] kind render error:', this.props.kind, error.message)
  }
  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

/* ─── 交互 kind 集合（需要 pointer-events: auto） ─── */
const INTERACTIVE_KINDS = new Set(['choice', 'form'])

/** 检查 kind 是否有交互需求 */
export function isInteractiveKind(kind: string): boolean {
  return INTERACTIVE_KINDS.has(kind)
}

/**
 * closeSurface — 卡片关闭通道（2026-08-12 修复）
 *
 * 此前 onClose 只调 sceneIntentV1（意图进 LLM 上下文，等下一轮响应才关，慢且不可靠）；
 * 且单界面迁移后 SceneShell 不再挂载，__sceneShell 通道已死 → 场景卡彻底无法关闭。
 * 现在：① 本地即时隐藏（VoiceShell 注册的 __sceneShell.setVisible，纯前端 dismissedIds）；
 *       ② 后端意图同步（agent 感知，下一轮可 ui_set 移除 surface）。
 */
function closeSurface(surface: Surface) {
  try {
    const shell = getCommandHost<{ setVisible?: (kind: string, v: boolean) => void }>('sceneShell')
    if (shell && typeof shell.setVisible === 'function') shell.setVisible(surface.kind, false)
  } catch (e) {
    console.error('[SceneShell] 本地关闭失败:', surface.kind, e)
  }
  try {
    sceneIntentV1(surface.id, 'close', {})
  } catch (e) {
    console.error('[SceneShell] surface close intent failed:', surface.kind, e)
  }
}

/**
 * renderKindContent — 单一 kind 渲染核心（2026-08-14 审计 M2）
 *
 * 原 SceneSurfaceRenderer 与 SurfaceRenderer 各有一份几乎逐字重复的 per-kind switch
 * (person_card/media/choice/form/music 特判)。差异已下沉为 KIND_REGISTRY 属性:
 * - mapProps: 定制组件 props(缺省 { data, onClose })
 * - frameStyle: 组件外层框架样式
 * - render: 'skip': 不渲染(如 music → FloatingMusicPlayer)
 * 新 kind 只需在注册表加条目,渲染核心不再改动。
 */
function renderKindContent(renderer: KindRenderer, surface: Surface): React.ReactNode {
  if (renderer.render === 'skip') return null
  const Component = renderer.component
  const sendIntent = (id: string, name: string, data: any) => {
    try { sceneIntentV1(id, name, data) } catch (e) { console.error('[SceneShell] intent send failed:', surface.kind, id, name, e) }
  }
  const close = () => closeSurface(surface)
  const props = renderer.mapProps
    ? renderer.mapProps({ surface, sendIntent, close })
    : { data: surface.data, onClose: close }
  const element = <Component {...props} />
  return renderer.frameStyle ? <div style={renderer.frameStyle}>{element}</div> : element
}

/**
 * SceneSurfaceRenderer — 单 surface 紧凑渲染器（供 VoiceShell holo-stage 等场景复用）
 *
 * 与内部 SurfaceRenderer 的区别：
 * - 无动画阶段（_phase/_stagger），仅渲染 kind 组件本体
 * - compact 模式下不包裹动画容器，仅返回纯内容
 * - 复用同一个 kindShapeGuards / getKindRenderer / KindErrorBoundary
 */
export function SceneSurfaceRenderer({ surface, compact }: { surface: Surface; compact?: boolean }) {
  const renderer: KindRenderer | undefined = getKindRenderer(surface.kind)
  if (!renderer) {
    return null
  }

  // 形状守卫——2026-08-17: 失败不再显示占位卡（产品要求），数据形状完全不对时
  // 不渲染，由 kind 组件内建空态兜底（ChartCard 暂无K线数据 / StocksCard 暂无持仓）。
  const guard = kindShapeGuards[surface.kind]
  const shapeValid = !guard || guard(surface.data)
  if (!shapeValid) {
    return null
  }

  // 2026-08-14 审计 M2: 特判差异下沉为注册表属性(mapProps/frameStyle/render:'skip'),
  // 与 SurfaceRenderer 共用同一渲染核心;music 等 skip kind 保持函数级早退(null 不包裹)。
  const content = renderKindContent(renderer, surface)
  if (content == null) return null

  if (compact || renderer.wrapper === 'none') {
    return <KindErrorBoundary kind={surface.kind}>{content}</KindErrorBoundary>
  }

  // 非 compact 模式：包裹动画容器（与内部 SurfaceRenderer 样式一致）
  const ac = `scene-surface scene-intent-${surface.intent === 'confront' ? 'confront' : surface.intent === 'ambient' ? 'ambient' : 'inform'}`
  return (
    <KindErrorBoundary kind={surface.kind}>
      <div className={ac} style={{ pointerEvents: 'auto' as any }}>
        {content}
      </div>
    </KindErrorBoundary>
  )
}

/* ─── Surface 渲染器（内部，含动画阶段） ─── */
function SurfaceRenderer({ surface, index }: { surface: AnimatedSurface; index: number }) {
  const ac = animClass(surface._phase, surface.intent || 'inform')
  const order = surface.order ?? index
  const stagger = surface._stagger ?? staggerFromOrder(order)
  const elRef = useRef<HTMLDivElement | null>(null)
  const prevRectRef = useRef<DOMRect | null>(null)
  const didInitialMountRef = useRef(false)

  // ── FLIP 共享元素转场（§六） ──
  // morph 时：记录 prev rect → 测 next rect → 反向 transform 拉到 prev → 下一帧 transition 回原位
  useEffect(() => {
    if (!elRef.current) return
    const el = elRef.current
    if (!didInitialMountRef.current) {
      didInitialMountRef.current = true
      return
    }
    if (surface._phase === 'morph') {
      const nextRect = el.getBoundingClientRect()
      const prevRect = prevRectRef.current
      if (prevRect) {
        const dx = prevRect.x - nextRect.x
        const dy = prevRect.y - nextRect.y
        const sx = prevRect.width / Math.max(1, nextRect.width)
        const sy = prevRect.height / Math.max(1, nextRect.height)
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(sx - 1) + Math.abs(sy - 1) > 0.5) {
          // First frame: invert
          el.style.transition = 'none'
          el.style.transformOrigin = 'top left'
          el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
          // Next frame: play
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              el.style.transition = 'transform 520ms cubic-bezier(0.22, 0.61, 0.36, 1)'
              el.style.transform = 'translate(0, 0) scale(1, 1)'
            })
          })
        }
      }
      prevRectRef.current = nextRect
    } else if (surface._phase === 'enter') {
      prevRectRef.current = el.getBoundingClientRect()
    } else if (surface._phase === 'exit') {
      // 退出动画播放后清理
    }
  }, [surface._phase, surface.id])

  const baseStyle: React.CSSProperties = {
    pointerEvents: 'auto' as any,
  }

  const wrapped = (children: React.ReactNode) => (
    <div ref={elRef} className={ac} data-stagger={stagger} style={baseStyle}>
      {children}
    </div>
  )

  const renderer: KindRenderer | undefined = getKindRenderer(surface.kind)
  if (!renderer) {
    return null
  }

  // 形状守卫：检查数据是否满足 kind 的最小字段要求
  const guard = kindShapeGuards[surface.kind]
  const shapeValid = !guard || guard(surface.data)

  const renderContent = () => {
    if (!shapeValid) {
      // 2026-08-17: 形状失败不渲染占位（产品要求），组件内建空态兜底
      return null
    }
    // 2026-08-14 审计 M2: 与 SceneSurfaceRenderer 共用同一渲染核心(注册表驱动)。
    // 注意: music 等 skip kind 返回 null,仍走 wrapped(null) 与原行为一致。
    return renderKindContent(renderer, surface)
  }

  const content = renderContent()
  if (renderer.wrapper === 'none') return <KindErrorBoundary kind={surface.kind}>{content}</KindErrorBoundary>
  return <KindErrorBoundary kind={surface.kind}>{wrapped(content)}</KindErrorBoundary>
}

