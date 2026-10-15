/**
 * render-three.ts — 经营数据三维渲染（2026-09-30，P2）
 *
 * 单独成文件的原因：它**只能**被 `import()` 动态加载（见 BusinessScene3D），
 * 这样 three.js 才留在懒加载 chunk 里、不进首屏——与 HotspotPanel → HotspotEarth
 * 的既有做法一致。U 盘应用的首屏体积是产品体验的一部分。
 *
 * 场景约定（与 lib/business-scene 的映射对齐）：
 *   z 轴 = 账龄（0 最近 → 3 最老），越靠后越老
 *   y 轴 = 金额（柱高）
 *   x 轴 = 同段内客户横向铺开（体现集中度）
 *   自发光 = glow（视线被该看的吸走）
 *
 * 交互：拖拽旋转、滚轮缩放。不引入 OrbitControls（那是 examples 额外模块，
 * 会把 chunk 再撑大）；几十行原生指针处理足够，且没有额外依赖。
 */
import * as THREE from 'three'
import type { BusinessScene } from '../../lib/business-scene'

export interface MountOptions {
  onError?: (msg: string) => void
}

/** 柱体基准尺寸（场景单位） */
const BAR_W = 0.9
const BAR_D = 0.9
const MAX_H = 4.2
/** 账龄越老的段整体抬高一点，避免前排遮挡后排（"越深越老"要看得见） */
const DEPTH_LIFT = 0.32

/**
 * 把场景模型挂到 canvas 上。返回清理函数（组件卸载时必须调用，
 * 否则 WebGL context 会泄漏——老机器上很快耗尽 context 数量上限）。
 */
export function mountBusinessScene(
  canvas: HTMLCanvasElement,
  scene: BusinessScene,
  opts: MountOptions = {},
): () => void {
  const onError = opts.onError ?? (() => {})
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      // 导出 PNG 需要它：否则 toDataURL 拿到的是空缓冲
      preserveDrawingBuffer: true,
    })
  } catch (e) {
    const msg = (e as Error)?.message || '无法创建 WebGL 上下文'
    onError(msg)
    return () => {}
  }

  const root = canvas.parentElement
  const width = () => Math.max(240, root?.clientWidth || canvas.clientWidth || 480)
  const height = () => Math.max(180, root?.clientHeight || canvas.clientHeight || 260)

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(width(), height(), false)
  renderer.setClearColor(0x000000, 0)

  const gl = new THREE.Scene()

  // 正交相机：等轴测视角下体积对比更"诚实"（透视会让远处的柱子显得更小，误读账龄）
  const frustum = 7
  let aspect = width() / height()
  const camera = new THREE.OrthographicCamera(
    (-frustum * aspect) / 2, (frustum * aspect) / 2,
    frustum / 2, -frustum / 2, 0.1, 100,
  )

  // 轨道参数（拖拽改变 yaw/pitch，滚轮改变 zoom）
  const orbit = { yaw: -0.62, pitch: 0.52, zoom: 1 }
  const applyCamera = () => {
    const dist = 14 / orbit.zoom
    const y = Math.sin(orbit.pitch) * dist
    const horiz = Math.cos(orbit.pitch) * dist
    camera.position.set(Math.sin(orbit.yaw) * horiz, y, Math.cos(orbit.yaw) * horiz)
    camera.lookAt(0, MAX_H * 0.35, 1.5)
  }
  applyCamera()

  // 灯光：环境光保证暗部可辨，方向光给柱体立体感（不用阴影——省性能且无必要）
  gl.add(new THREE.AmbientLight(0xffffff, 0.72))
  const key = new THREE.DirectionalLight(0xffffff, 1.05)
  key.position.set(5, 9, 6)
  gl.add(key)
  const rim = new THREE.DirectionalLight(0x66e0ff, 0.35)
  rim.position.set(-6, 3, -5)
  gl.add(rim)

  // 地面网格：给纵深一个参照（否则"深浅"读不出来）
  const grid = new THREE.GridHelper(12, 12, 0x2a3540, 0x1b232b)
  grid.position.set(0, 0, 1.5)
  ;(grid.material as THREE.Material).transparent = true
  ;(grid.material as THREE.Material).opacity = 0.5
  gl.add(grid)

  // 柱体：每个节点一根 box；自发光随 glow，告警段用暖色
  const group = new THREE.Group()
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  for (const node of scene.nodes) {
    const h = Math.max(0.16, node.scale * MAX_H)
    const geo = new THREE.BoxGeometry(BAR_W, h, BAR_D)
    geometries.push(geo)
    const base = node.alarm ? 0xf59e0b : 0x22d3ee
    const mat = new THREE.MeshStandardMaterial({
      color: base,
      emissive: base,
      // 自发光强度直接承载"该看程度"——这是本视图唯一的视觉强调手段
      emissiveIntensity: 0.18 + node.glow * 0.85,
      roughness: 0.42,
      metalness: 0.12,
    })
    materials.push(mat)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(node.position.x, h / 2 + node.position.z * DEPTH_LIFT, node.position.z)
    group.add(mesh)
  }
  gl.add(group)

  // 交互：原生指针拖拽旋转 / 滚轮缩放
  let dragging = false
  let lastX = 0
  let lastY = 0
  const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture?.(e.pointerId) }
  const onMove = (e: PointerEvent) => {
    if (!dragging) return
    orbit.yaw -= (e.clientX - lastX) * 0.008
    orbit.pitch = Math.max(-0.15, Math.min(1.35, orbit.pitch + (e.clientY - lastY) * 0.006))
    lastX = e.clientX; lastY = e.clientY
    applyCamera()
  }
  const onUp = (e: PointerEvent) => { dragging = false; try { canvas.releasePointerCapture?.(e.pointerId) } catch { /* 未捕获时忽略 */ } }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    orbit.zoom = Math.max(0.55, Math.min(2.4, orbit.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
    applyCamera()
  }
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  const onResize = () => {
    const w = width(), h = height()
    aspect = w / h
    camera.left = (-frustum * aspect) / 2
    camera.right = (frustum * aspect) / 2
    camera.top = frustum / 2
    camera.bottom = -frustum / 2
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
  if (ro && root) ro.observe(root)
  window.addEventListener('resize', onResize)

  // 告警段轻微呼吸：给"这里要看"一个不刺眼的持续提示。
  // 尊重 L0（组件在 L0 根本不挂 WebGL）；L1/L2 都保留但幅度很小。
  let raf = 0
  const start = performance.now()
  const tick = () => {
    const t = (performance.now() - start) / 1000
    for (let i = 0; i < group.children.length; i++) {
      const node = scene.nodes[i]
      if (!node?.alarm) continue
      const mat = (group.children[i] as THREE.Mesh).material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = 0.55 + Math.sin(t * 2.2) * 0.25
    }
    renderer.render(gl, camera)
    raf = requestAnimationFrame(tick)
  }
  tick()

  return () => {
    cancelAnimationFrame(raf)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onUp)
    canvas.removeEventListener('wheel', onWheel)
    window.removeEventListener('resize', onResize)
    ro?.disconnect()
    for (const g of geometries) g.dispose()
    for (const m of materials) m.dispose()
    grid.geometry.dispose()
    ;(grid.material as THREE.Material).dispose()
    // dispose() 释放 GPU 资源；forceContextLoss 让老机器立刻回收 context
    renderer.dispose()
    renderer.forceContextLoss?.()
  }
}
