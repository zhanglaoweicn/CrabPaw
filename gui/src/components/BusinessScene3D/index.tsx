/**
 * BusinessScene3D.tsx — 经营数据三维化（2026-09-30，P2 规格 §6.2）
 *
 * 用**空间**回答"钱卡在哪一段账龄"：账龄→纵深、金额→体积、异常→自发光、集中度→横向聚拢。
 *
 * 三个刻意的取舍：
 *
 * 1. **复用已有依赖，不新增体积**。three.js 已通过 HotspotPanel 的 lazy() 进包
 *    （独立 510KB chunk，只有打开热点面板才下载）。本组件同样走 lazy 边界，
 *    因此对首屏零影响，也没有给 U 盘应用加重。
 *
 * 2. **只在老板主动要看时出现**，不做常驻 3D。U 盘插的机器常年是老笔记本，
 *    常驻 WebGL 既费电又违背"信 > 哇"（规格 §6.2 防止玩具化的第一条）。
 *
 * 3. **低端档降级为二维，信息不丢**。L0/L1 不挂 WebGL，直接用 lib/business-scene
 *    产出的同一份数据画条形——`toFlatRows()` 保证行数与三维节点数一致。
 *    这是"降级"而不是"阉割"：档位只改变呈现形式，不改变可信内容。
 *
 * 业务口径全部来自 lib/business-scene（纯函数、25 例测试）；本组件只负责画。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildBusinessScene,
  toFlatRows,
  sceneSummary,
  type AgingItem,
} from '../../lib/business-scene'
import { currentTier } from '../../lib/motion-tier'
import './styles.css'

export interface BusinessScene3DProps {
  /** 逾期账目（来自 listOverdueReceivables / /api/briefing/today 的 receivables.items） */
  items: AgingItem[]
  /** 是否按客户细分（默认按账龄段聚合，更易读） */
  perCustomer?: boolean
  /** 关闭 */
  onClose?: () => void
}

/** 金额格式化（与 HUD/晨报同口径，避免三处各写一套） */
function money(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return `${Math.round(n / 1_000_000) / 100}亿`
  if (abs >= 10_000) return `${Math.round(n / 1000) / 10}万`
  return String(Math.round(n))
}

export function BusinessScene3D({ items, perCustomer = false, onClose }: BusinessScene3DProps) {
  // 2026-10-09 修复"首次打开必空态": 此前 useRef(buildBusinessScene(items)).current
  // 把场景冻结在首渲染——VoiceShell 是"打开即挂载(此时 items 为空)→ 异步取数"时序,
  // 首次打开永远渲染空数据,第二次打开才正常。改 useMemo 按 items/perCustomer 重建;
  // 下方渲染 effect 已依赖 scene,重建即自动卸旧挂新。
  const scene = useMemo(() => buildBusinessScene(items, { perCustomer }), [items, perCustomer])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [tier, setTier] = useState<string>('L1')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => { setTier(currentTier() || 'L1') }, [])

  // 低端档（L0）不挂 WebGL：省电、避免老机器驱动问题，且信息由二维视图完整承载
  const use3D = tier !== 'L0' && !scene.emptyReason

  useEffect(() => {
    if (!use3D) return
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    let cleanup: (() => void) | null = null

    // 动态 import：与 HotspotPanel 同样走 lazy 边界，three 不进首屏
    void import('./render-three')
      .then(({ mountBusinessScene }) => {
        if (disposed) return
        cleanup = mountBusinessScene(canvas, scene, {
          onError: (msg) => { if (!disposed) setError(msg) },
        })
        setReady(true)
      })
      .catch((e) => {
        // three 加载失败不该让整卡白屏——如实报错并保留二维回退（下面按 error 渲染）
        console.error('[business-scene] three 加载失败:', e)
        if (!disposed) setError((e as Error)?.message || '三维渲染器加载失败')
      })

    return () => {
      disposed = true
      try { cleanup?.() } catch (e) { console.warn('[business-scene] 清理失败:', e) }
    }
  }, [use3D, scene])

  /** 导出 PNG（规格 §6.3：能进周报/发给客户）。WebGL 需 preserveDrawingBuffer，见 render-three */
  const exportPng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url
      a.download = `经营账龄-${new Date().toISOString().slice(0, 10)}.png`
      a.click()
    } catch (e) {
      console.error('[business-scene] 导出 PNG 失败:', e)
      setError('导出图片失败')
    }
  }

  const rows = toFlatRows(scene)
  const show2D = !use3D || !!error
  // 空场景判定必须看**数据**而不是只看 emptyReason：
  // 输入是 [] 时 buildBusinessScene 走的是"有账目但金额为 0"分支（emptyReason 为 null），
  // 若只判 emptyReason 就会画出一个空的画布 + 图例 + 结论——正是要避免的"空场景"。
  const isEmpty = !!scene.emptyReason || scene.nodes.length === 0
  const emptyText = scene.emptyReason || '没有逾期账目——没有可看的结构'

  return (
    <div className="bs3d">
      <div className="bs3d__head">
        <div className="bs3d__title">账龄结构</div>
        <div className="bs3d__summary">{sceneSummary(scene)}</div>
      </div>

      {isEmpty ? (
        <div className="bs3d__empty">{emptyText}</div>
      ) : (
        <>
          {/* 三维画布：show2D 时隐藏但保留在 DOM（导出/切回都还需要它）。
              data-engine 便于排查"到底跑没跑 WebGL"（降级排查第一问）。 */}
          <canvas
            ref={canvasRef}
            className="bs3d__canvas"
            data-engine={show2D ? 'flat' : 'three.js r185'}
            style={{ display: show2D ? 'none' : 'block' }}
            aria-label="账龄结构三维视图"
            role="img"
          />

          {/* 二维回退：L0 或渲染失败时使用。信息与三维同源（同一份 rows） */}
          {show2D && (
            <div className="bs3d__flat" data-reason={error ? 'render-error' : 'tier-L0'}>
              {error && <div className="bs3d__warn">三维渲染不可用（{error}），已切二维视图——数据完全相同</div>}
              {rows.map((r) => {
                const max = rows[0]?.amount || 1
                return (
                  <div key={r.label} className={`bs3d__row${r.alarm ? ' is-alarm' : ''}`}>
                    <span className="bs3d__row-label">{r.label}</span>
                    <span className="bs3d__row-bar" aria-hidden>
                      <span className="bs3d__row-fill" style={{ width: `${Math.max(2, (r.amount / max) * 100)}%` }} />
                    </span>
                    <span className="bs3d__row-val">{money(r.amount)}</span>
                    <span className="bs3d__row-share">{r.shareText}</span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="bs3d__legend">
            <span>纵深 = 账龄（越深越老）</span>
            <span>体积 = 金额</span>
            <span>发光 = 该看程度</span>
          </div>

          {scene.concentration.risky && scene.concentration.topCustomer && (
            <div className="bs3d__alarm">
              集中度偏高：{scene.concentration.topCustomer} 占 {Math.round(scene.concentration.topShare * 100)}%
            </div>
          )}
        </>
      )}

      <div className="bs3d__actions">
        {!show2D && ready && (
          <button type="button" className="bs3d__btn" onClick={exportPng}>导出图片</button>
        )}
        {onClose && <button type="button" className="bs3d__btn" onClick={onClose}>关闭</button>}
      </div>
    </div>
  )
}
