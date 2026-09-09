import { useRef, useEffect, useCallback, useState } from 'react'
import * as THREE from 'three'

const TEX = {
  earth: '/earth/earth_atmos_2048.jpg',
  normal: '/earth/earth_normal_2048.jpg',
  specular: '/earth/earth_specular_2048.jpg',
  clouds: '/earth/earth_clouds_2048.png',
}

const HOTSPOT_COORDS = [
  { lat: 39.9, lon: 116.4, label: '北京' },
  { lat: 31.2, lon: 121.5, label: '上海' },
  { lat: 22.5, lon: 114.1, label: '深圳' },
  { lat: 40.7, lon: -74.0, label: '纽约' },
  { lat: 51.5, lon: -0.1, label: '伦敦' },
  { lat: 48.9, lon: 2.3, label: '巴黎' },
  { lat: 35.7, lon: 139.7, label: '东京' },
  { lat: -33.9, lon: 151.2, label: '悉尼' },
  { lat: 55.8, lon: 37.6, label: '莫斯科' },
  { lat: 19.4, lon: -99.1, label: '墨西哥城' },
  { lat: -23.5, lon: -46.6, label: '圣保罗' },
  { lat: 28.6, lon: 77.2, label: '新德里' },
]

function createProceduralEarthTexture(T: typeof THREE): THREE.CanvasTexture {
  const W = 1024, H = 512
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  const oceanGrad = ctx.createLinearGradient(0, 0, 0, H)
  oceanGrad.addColorStop(0, '#061a2e')
  oceanGrad.addColorStop(0.3, '#0a2d4e')
  oceanGrad.addColorStop(0.5, '#0d3860')
  oceanGrad.addColorStop(0.7, '#0a2d4e')
  oceanGrad.addColorStop(1, '#061a2e')
  ctx.fillStyle = oceanGrad
  ctx.fillRect(0, 0, W, H)

  ctx.fillStyle = '#3a6b25'

  const p = (x: number, y: number) => [x / 360 * W, (90 - y) / 180 * H]
  function poly(coords: [number, number][]) {
    ctx.beginPath()
    coords.forEach(([x, y], i) => {
      const [cx, cy] = p(x, y)
      i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy)
    })
    ctx.closePath()
    ctx.fill()
  }

  poly([[-170,72],[-60,72],[-55,45],[-65,25],[-85,15],[-115,20],[-130,30],[-140,55],[-165,62]])
  poly([[-73,76],[-20,83],[-17,76],[-30,70],[-55,68],[-66,72]])
  poly([[-82,12],[-60,12],[-35,5],[-35,-25],[-55,-55],[-68,-55],[-75,-40],[-80,-10]])
  poly([[0,72],[30,72],[35,60],[30,45],[15,38],[0,38],[-10,45],[-10,60]])
  poly([[-18,38],[52,38],[52,10],[45,-10],[35,-35],[20,-55],[10,-35],[0,0],[-18,15]])
  poly([[30,72],[180,72],[180,40],[140,20],[120,10],[100,5],[80,12],[60,20],[40,38],[28,60]])
  poly([[95,25],[110,10],[105,0],[95,5],[90,15]])
  poly([[114,-22],[154,-22],[154,-39],[140,-38],[125,-33],[113,-28]])

  ctx.fillStyle = 'rgba(200,225,255,0.55)'
  ctx.beginPath()
  ctx.rect(0, H * 0.89, W, H * 0.11)
  ctx.fill()

  ctx.fillStyle = 'rgba(200,225,255,0.55)'
  ctx.beginPath()
  ctx.rect(0, 0, W, H * 0.04)
  ctx.fill()

  const tex = new T.CanvasTexture(canvas)
  if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace
  return tex
}

function latLonToVec3(lat: number, lon: number, radius: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

export interface EarthHotspotItem {
  title: string
  hot: number
  platform: string
}

interface HotspotEarthProps {
  visible?: boolean
  // 2026-08-16 数据链审计 #7: 真实热点数据(跨平台 Top N)——旧实现纯装饰,
  // 点位固定城市坐标与热点无关。传入后: 位置由标题确定性 hash 生成(同一
  // 热点稳定复现), 点大小/亮度按热度分级, hover 显示标题。缺省回退城市装饰。
  items?: EarthHotspotItem[]
}

// 确定性字符串 hash → [lat, lon](-80°~80°, 全经度)——热点事件无地理归属,
// 用标题指纹保证"同一热点固定位置、不同热点分散"的稳定可视化
function hashLatLon(title: string): { lat: number; lon: number } {
  let h = 2166136261
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const u = (h >>> 0) / 4294967295 // 0..1
  const v = ((h >>> 13) ^ (h >>> 7)) / 4294967295
  const lat = (u * 2 - 1) * 80
  const lon = v * 360 - 180
  return { lat, lon }
}

export function HotspotEarth({ visible = true, items }: HotspotEarthProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const itemsRef = useRef<EarthHotspotItem[] | undefined>(items)
  itemsRef.current = items
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null)
  const earthRef = useRef<{
    renderer: THREE.WebGLRenderer | null
    scene: THREE.Scene | null
    camera: THREE.PerspectiveCamera | null
    earth: THREE.Mesh | null
    clouds: THREE.Mesh | null
    atmo: THREE.Mesh | null
    atmo2: THREE.Mesh | null
    stars: THREE.Points | null
    hotspots: THREE.Group | null
    isDragging: boolean
    prevMouse: { x: number; y: number }
    rotX: number
    rotY: number
    velX: number
    velY: number
    camDist: number
    camDistMin: number
    camDistMax: number
    appearing: boolean
    appearScale: number
    animFrame: number | null
    // 2026-08-16: 动画循环函数引用——visibilitychange 暂停/恢复与 start()
    // 共用同一份循环(旧实现复制粘贴第二份 animate, 逻辑漂移风险)
    animate: (() => void) | null
    _bound: {
      onDown?: (e: MouseEvent | TouchEvent) => void
      onMove?: (e: MouseEvent | TouchEvent) => void
      onUp?: () => void
      onWheel?: (e: WheelEvent) => void
    }
    // 2026-08-08(审计 P1): 卸载活性标志
    disposed: boolean
  }>({
    renderer: null,
    scene: null,
    camera: null,
    earth: null,
    clouds: null,
    atmo: null,
    atmo2: null,
    stars: null,
    hotspots: null,
    isDragging: false,
    prevMouse: { x: 0, y: 0 },
    rotX: 0.1,
    rotY: 0,
    velX: 0,
    velY: 0.0008,
    camDist: 3.25,
    camDistMin: 2.35,
    camDistMax: 4.5,
    appearing: false,
    appearScale: 0,
    animFrame: null,
    animate: null,
    _bound: {},
    // 2026-08-08(审计 P1): 卸载活性标志——initEarth 是异步,await 纹理期间组件
    // 卸载后 await 恢复仍会建 renderer 并 start() rAF 循环,GPU 永久空转
    disposed: false,
  })

  /**
   * 2026-08-16: 唯一动画循环工厂——start() 与 visibilitychange 恢复共用。
   * 旧实现 visibilitychange 里复制粘贴了第二份 animate(无 appearing/resize
   * 处理), 两份逻辑漂移风险; 现合一, 恢复时复用同一循环(状态机无差异)。
   */
  const createAnimate = useCallback((state: typeof earthRef.current) => {
    const animate = () => {
      if (state.disposed) return
      state.animFrame = requestAnimationFrame(animate)

      if (state.appearing) {
        state.appearScale += (1 - state.appearScale) * 0.07
        const s = state.appearScale
        if (state.earth) state.earth.scale.setScalar(s)
        if (state.clouds) state.clouds.scale.setScalar(s)
        if (state.atmo) state.atmo.scale.setScalar(s)
        if (state.atmo2) state.atmo2.scale.setScalar(s)
        if (state.stars) (Array.isArray(state.stars.material) ? state.stars.material[0] : state.stars.material).opacity = Math.min(1, s * 1.5)
        if (s > 0.999) {
          state.appearing = false
          if (state.earth) state.earth.scale.setScalar(1)
          if (state.clouds) state.clouds.scale.setScalar(1)
          if (state.atmo) state.atmo.scale.setScalar(1)
          if (state.atmo2) state.atmo2.scale.setScalar(1)
          if (state.stars) (Array.isArray(state.stars.material) ? state.stars.material[0] : state.stars.material).opacity = 1
        }
      }

      if (!state.isDragging) {
        state.velX *= 0.92
        state.velY *= 0.92
        state.rotX += state.velX
        // 2026-08-16: 自转提速 0.0018 → 0.004 rad/帧(60fps 约 14s/圈)——旧值
        // 58s/圈肉眼几乎无感, 用户反馈"地球不动"。拖拽时惯性阻尼复用同一 velY。
        state.rotY += state.velY + 0.004
        state.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, state.rotX))
      }

      if (state.earth) {
        state.earth.rotation.x = state.rotX
        state.earth.rotation.y = state.rotY
      }
      if (state.clouds) {
        state.clouds.rotation.x = state.rotX
        state.clouds.rotation.y = state.rotY + performance.now() * 0.000008
      }

      if (state.camera) {
        const curr = state.camera.position.length()
        const next = curr + (state.camDist - curr) * 0.1
        state.camera.position.setLength(next)
      }

      if (state.renderer && state.scene && state.camera) {
        const c2 = canvasRef.current
        if (c2) {
          const w2 = c2.clientWidth
          const h2 = c2.clientHeight
          if (w2 && h2) {
            const dpr = state.renderer.getPixelRatio()
            if (c2.width !== Math.round(w2 * dpr) || c2.height !== Math.round(h2 * dpr)) {
              state.renderer.setSize(w2, h2, false)
              state.camera.aspect = w2 / h2
              state.camera.updateProjectionMatrix()
            }
          }
        }
        state.renderer.render(state.scene, state.camera)
      }
    }
    return animate
  }, [])

  const initEarth = useCallback(async () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const state = earthRef.current

    // 首次初始化才创建渲染器和场景；重显时复用已有 WebGL 资源
    const isFirstInit = !state.renderer

    if (isFirstInit) {
    const w = canvas.clientWidth || 400
    const h = canvas.clientHeight || 400

    state.scene = new THREE.Scene()

    state.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100)
    state.camera.position.set(0, 0, state.camDist)

    state.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    })
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    state.renderer.setSize(w, h, false)
    if (THREE.SRGBColorSpace) state.renderer.outputColorSpace = THREE.SRGBColorSpace
    if (THREE.ACESFilmicToneMapping) {
      state.renderer.toneMapping = THREE.ACESFilmicToneMapping
      state.renderer.toneMappingExposure = 1.15
    }

    const sun = new THREE.DirectionalLight(0xffffff, 2.35)
    sun.position.set(5, 2.2, 4.5)
    state.scene.add(sun)
    state.scene.add(new THREE.HemisphereLight(0xdcecff, 0x111827, 0.72))
    state.scene.add(new THREE.AmbientLight(0xffffff, 0.16))

    const loader = new THREE.TextureLoader()
    const load = (url: string) => new Promise<THREE.Texture | null>((res) => {
      loader.load(url, res, undefined, () => res(null))
    })

    const [earthTex, normalTex, specTex, cloudTex] = await Promise.all([
      load(TEX.earth),
      load(TEX.normal),
      load(TEX.specular),
      load(TEX.clouds),
    ])

    // 2026-08-08(审计 P1): await 恢复后复查卸载标志——组件已卸载则不再创建
    // WebGL 资源/启动 rAF(cleanup 已执行,不会再有 cancel 机会)
    if (state.disposed) return

    ;[earthTex, cloudTex].forEach((tex) => {
      if (tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace
    })

    const usedEarthTex = earthTex || createProceduralEarthTexture(THREE)

    const geo = new THREE.SphereGeometry(1, 64, 64)
    const mat = new THREE.MeshPhongMaterial({
      map: usedEarthTex,
      normalMap: normalTex || undefined,
      specularMap: specTex || undefined,
      specular: new THREE.Color(0x1d3557),
      shininess: 28,
    })
    state.earth = new THREE.Mesh(geo, mat)
    state.scene.add(state.earth)

    if (cloudTex) {
      const cloudGeo = new THREE.SphereGeometry(1.012, 48, 48)
      const cloudMat = new THREE.MeshPhongMaterial({
        map: cloudTex,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        emissive: new THREE.Color(0x666666),
      })
      state.clouds = new THREE.Mesh(cloudGeo, cloudMat)
      state.scene.add(state.clouds)
    }

    const atmoGeo = new THREE.SphereGeometry(1.06, 32, 32)
    const atmoMat = new THREE.MeshBasicMaterial({
      color: 0x4488ff,
      transparent: true,
      opacity: 0.06,
      side: THREE.BackSide,
      depthWrite: false,
    })
    state.atmo = new THREE.Mesh(atmoGeo, atmoMat)
    state.scene.add(state.atmo)

    const atmo2Geo = new THREE.SphereGeometry(1.035, 32, 32)
    const atmo2Mat = new THREE.MeshBasicMaterial({
      color: 0x88ccff,
      transparent: true,
      opacity: 0.035,
      side: THREE.FrontSide,
      depthWrite: false,
    })
    state.atmo2 = new THREE.Mesh(atmo2Geo, atmo2Mat)
    state.scene.add(state.atmo2)

    const starVerts: number[] = []
    for (let i = 0; i < 2000; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r = 18 + Math.random() * 12
      starVerts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      )
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starVerts, 3))
    const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.06, sizeAttenuation: true })
    state.stars = new THREE.Points(starGeo, starMat)
    state.scene.add(state.stars)

    const group = new THREE.Group()
    const current = itemsRef.current
    if (current && current.length > 0) {
      // 2026-08-16 数据链审计 #7: 数据驱动热点点——位置 = 标题指纹经纬度,
      // 热度分级大小/亮度(热度越高点越大越亮), userData 供 hover raycast。
      // 热度归一化: hot=0 时取中档(0.6), 避免全 0 时点消失。
      // 2026-08-16(二轮): 尺寸 0.007~0.023 → 0.02~0.07 半径(相机 3.25 距离下
      // 旧值最大仅 ~5px, 用户反馈"没有热点标注"), ring 随之放大。
      const maxHot = Math.max(...current.map(i => i.hot), 1)
      current.forEach(item => {
        const { lat, lon } = hashLatLon(item.title)
        const pos = latLonToVec3(lat, lon, 1.025)
        const t = maxHot > 0 ? Math.min(1, item.hot / maxHot) : 0.6
        const size = 0.02 + t * 0.05
        const ringGeo = new THREE.RingGeometry(size * 1.5, size * 2.5, 16)
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xff4444,
          transparent: true,
          opacity: 0.5 + t * 0.4,
          side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.position.copy(pos)
        ring.lookAt(pos.clone().multiplyScalar(2))

        const dotGeo = new THREE.CircleGeometry(size, 12)
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8888, side: THREE.DoubleSide })
        const dot = new THREE.Mesh(dotGeo, dotMat)
        dot.position.copy(pos)
        dot.lookAt(pos.clone().multiplyScalar(2))
        dot.userData = { title: item.title, hot: item.hot, platform: item.platform }
        ring.userData = dot.userData

        group.add(ring, dot)
      })
    } else {
      // 无数据时回退城市装饰点(原行为)——2026-08-16(二轮): 放大 + userData,
      // 旧值 dot 0.009 半径 ~2px 不可见, 且无 userData → hover 无任何标注。
      HOTSPOT_COORDS.forEach(({ lat, lon, label }) => {
        const pos = latLonToVec3(lat, lon, 1.025)
        const ringGeo = new THREE.RingGeometry(0.05, 0.08, 16)
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xff4444,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.position.copy(pos)
        ring.lookAt(pos.clone().multiplyScalar(2))

        const dotGeo = new THREE.CircleGeometry(0.028, 12)
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8888, side: THREE.DoubleSide })
        const dot = new THREE.Mesh(dotGeo, dotMat)
        dot.position.copy(pos)
        dot.lookAt(pos.clone().multiplyScalar(2))
        dot.userData = { title: label, hot: 0, platform: '城市' }
        ring.userData = dot.userData

        group.add(ring, dot)
      })
    }
    state.hotspots = group
    state.earth.add(group)

    state.earth.scale.setScalar(0)
    if (state.clouds) state.clouds.scale.setScalar(0)
    if (state.atmo) state.atmo.scale.setScalar(0)
    if (state.atmo2) state.atmo2.scale.setScalar(0)
    if (state.stars) (Array.isArray(state.stars.material) ? state.stars.material[0] : state.stars.material).opacity = 0
    } // end isFirstInit

    // 启动动画循环 + 事件监听（独立函数，供 visible 重显时复用）
    const start = () => {
      const c = canvas
      if (!c || state.disposed) return

      // 移除旧事件监听，防止重复绑定
      const old = state._bound as any
      if (old?.onDown) {
        c.removeEventListener('mousedown', old.onDown)
        c.removeEventListener('mousemove', old.onMove)
        c.removeEventListener('mouseup', old.onUp)
        c.removeEventListener('mouseleave', old.onUp)
        c.removeEventListener('touchstart', old.onDown)
        c.removeEventListener('touchmove', old.onMove)
        c.removeEventListener('touchend', old.onUp)
        c.removeEventListener('wheel', old.onWheel)
      }

      const onDown = (e: MouseEvent | TouchEvent) => {
        state.isDragging = true
        const p = 'touches' in e ? e.touches[0] : e
        state.prevMouse = { x: p.clientX, y: p.clientY }
        state.velX = 0
        state.velY = 0
      }
      const onMove = (e: MouseEvent | TouchEvent) => {
        // 2026-08-16 数据链审计 #7: 非拖拽移动 → raycast hover 检测热点点, 显示标题 tooltip
        if (!state.isDragging) {
          try {
            const pt = 'touches' in e ? e.touches[0] : e
            const rect = c.getBoundingClientRect()
            const x = pt.clientX - rect.left
            const y = pt.clientY - rect.top
            if (x >= 0 && y >= 0 && x <= rect.width && y <= rect.height && state.hotspots) {
              const ndc = new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1)
              const raycaster = new THREE.Raycaster()
              raycaster.setFromCamera(ndc, state.camera!)
              const dots: THREE.Object3D[] = []
              state.hotspots.traverse(o => { if (o.userData?.title) dots.push(o) })
              const hits = raycaster.intersectObjects(dots, false)
              if (hits.length > 0 && hits[0].object.userData?.title) {
                const d = hits[0].object.userData
                setTooltip({ x: pt.clientX, y: pt.clientY, text: `${d.title}${d.hot ? ` · 热度 ${d.hot}` : ''}${d.platform ? ` [${d.platform}]` : ''}` })
              } else {
                setTooltip(null)
              }
            } else {
              setTooltip(null)
            }
          } catch (err) { console.warn('[HotspotEarth] hover 检测失败:', err) }
          return
        }
        e.preventDefault()
        const p = 'touches' in e ? e.touches[0] : e
        const dx = p.clientX - state.prevMouse.x
        const dy = p.clientY - state.prevMouse.y
        state.velY = dx * 0.003
        state.velX = dy * 0.003
        state.rotY += state.velY
        state.rotX += state.velX
        state.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, state.rotX))
        state.prevMouse = { x: p.clientX, y: p.clientY }
      }
      const onUp = () => { state.isDragging = false }
      const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        state.camDist += e.deltaY * 0.002
        state.camDist = Math.max(state.camDistMin, Math.min(state.camDistMax, state.camDist))
      }

      c.addEventListener('mousedown', onDown)
      c.addEventListener('mousemove', onMove)
      c.addEventListener('mouseup', onUp)
      c.addEventListener('mouseleave', onUp)
      c.addEventListener('touchstart', onDown, { passive: true })
      c.addEventListener('touchmove', onMove, { passive: false })
      c.addEventListener('touchend', onUp)
      c.addEventListener('wheel', onWheel, { passive: false })

      state._bound = { onDown, onMove, onUp, onWheel }

      if (visible) {
        state.appearing = true
        state.appearScale = 0
      }

      // 取消已有动画帧，启动新的动画循环（createAnimate 统一工厂）
      if (state.animFrame) {
        cancelAnimationFrame(state.animFrame)
        state.animFrame = null
      }

      const animate = createAnimate(state)
      state.animate = animate
      animate()
    }

    start()
  }, [visible])

  const triggerAppear = useCallback(() => {
    const state = earthRef.current
    if (!state.earth) return
    state.appearing = true
    state.appearScale = 0
    if (state.earth) state.earth.scale.setScalar(0)
    if (state.clouds) state.clouds.scale.setScalar(0)
    if (state.atmo) state.atmo.scale.setScalar(0)
    if (state.atmo2) state.atmo2.scale.setScalar(0)
    if (state.stars) (Array.isArray(state.stars.material) ? state.stars.material[0] : state.stars.material).opacity = 0
  }, [])

  useEffect(() => {
    if (!visible) return
    const state = earthRef.current
    state.disposed = false // 重显时重置卸载标志
    initEarth().then(() => {
      if (state.disposed) return
      requestAnimationFrame(triggerAppear)
    }).catch(err => console.error('[HotspotEarth] initEarth 失败:', err))

    return () => {
      state.disposed = true // 2026-08-08(审计 P1): 置位后 initEarth 的 await 恢复即退出
      if (state.animFrame) {
        cancelAnimationFrame(state.animFrame)
        state.animFrame = null
      }
    }
  }, [visible, initEarth, triggerAppear])

  // 2026-08-16 数据链审计 #7: items 变化 → 重建热点点(轮询 30s 刷新后地球点位跟随)
  useEffect(() => {
    const state = earthRef.current
    if (!state.hotspots || !state.earth) return
    state.earth.remove(state.hotspots)
    state.hotspots.traverse(o => {
      const mesh = o as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
    })
    const group = new THREE.Group()
    const current = items
    if (current && current.length > 0) {
      // 2026-08-16(二轮): 与 initEarth 分支同步放大(0.02~0.07 半径)
      const maxHot = Math.max(...current.map(i => i.hot), 1)
      current.forEach(item => {
        const { lat, lon } = hashLatLon(item.title)
        const pos = latLonToVec3(lat, lon, 1.025)
        const t = maxHot > 0 ? Math.min(1, item.hot / maxHot) : 0.6
        const size = 0.02 + t * 0.05
        const ringGeo = new THREE.RingGeometry(size * 1.5, size * 2.5, 16)
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xff4444, transparent: true, opacity: 0.5 + t * 0.4, side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.position.copy(pos)
        ring.lookAt(pos.clone().multiplyScalar(2))
        const dotGeo = new THREE.CircleGeometry(size, 12)
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8888, side: THREE.DoubleSide })
        const dot = new THREE.Mesh(dotGeo, dotMat)
        dot.position.copy(pos)
        dot.lookAt(pos.clone().multiplyScalar(2))
        dot.userData = { title: item.title, hot: item.hot, platform: item.platform }
        ring.userData = dot.userData
        group.add(ring, dot)
      })
    } else {
      // 2026-08-16(二轮): 数据清空时回退城市装饰点(原 initEarth 同款, 放大版)
      HOTSPOT_COORDS.forEach(({ lat, lon, label }) => {
        const pos = latLonToVec3(lat, lon, 1.025)
        const ringGeo = new THREE.RingGeometry(0.05, 0.08, 16)
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xff4444, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.position.copy(pos)
        ring.lookAt(pos.clone().multiplyScalar(2))
        const dotGeo = new THREE.CircleGeometry(0.028, 12)
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xff8888, side: THREE.DoubleSide })
        const dot = new THREE.Mesh(dotGeo, dotMat)
        dot.position.copy(pos)
        dot.lookAt(pos.clone().multiplyScalar(2))
        dot.userData = { title: label, hot: 0, platform: '城市' }
        ring.userData = dot.userData
        group.add(ring, dot)
      })
    }
    state.hotspots = group
    state.earth.add(group)
  }, [items])

  useEffect(() => {
    const handleVisibilityChange = () => {
      const state = earthRef.current
      if (!state.animFrame || !state.renderer) return
      if (document.hidden) {
        if (state.animFrame) {
          cancelAnimationFrame(state.animFrame)
          state.animFrame = null
        }
      } else if (visible && state.renderer) {
        // 2026-08-16: 恢复共用同一份循环（createAnimate）——旧实现复制粘贴
        // 第二份 animate(缺 appearing/resize 处理), 双份逻辑漂移风险
        if (state.animate) state.animate()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [visible])

  useEffect(() => {
    return () => {
      const state = earthRef.current
      const c = canvasRef.current
      if (!c) return

      if (state._bound.onDown) c.removeEventListener('mousedown', state._bound.onDown)
      if (state._bound.onMove) c.removeEventListener('mousemove', state._bound.onMove)
      if (state._bound.onUp) c.removeEventListener('mouseup', state._bound.onUp)
      if (state._bound.onUp) c.removeEventListener('mouseleave', state._bound.onUp)
      if (state._bound.onDown) c.removeEventListener('touchstart', state._bound.onDown)
      if (state._bound.onMove) c.removeEventListener('touchmove', state._bound.onMove)
      if (state._bound.onUp) c.removeEventListener('touchend', state._bound.onUp)
      if (state._bound.onWheel) c.removeEventListener('wheel', state._bound.onWheel)

      state.renderer?.dispose()
      state.renderer = null
    }
  }, [])

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: visible ? 'block' : 'none' }}
      />
      {/* 2026-08-16 数据链审计 #7: 热点点 hover tooltip(标题/热度/平台) */}
      {tooltip && (
        <div style={{
          position: 'fixed', left: tooltip.x + 14, top: tooltip.y + 14,
          maxWidth: 260, padding: '6px 10px', borderRadius: 8, zIndex: 9999,
          background: 'rgba(12,12,22,0.92)', border: '1px solid rgba(89,168,255,0.35)',
          color: '#ddd', fontSize: 11, lineHeight: 1.4, pointerEvents: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}>
          {tooltip.text}
        </div>
      )}
    </>
  )
}

export default HotspotEarth
