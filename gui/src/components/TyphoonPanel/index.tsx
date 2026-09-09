/**
 * TyphoonPanel — 台风追踪面板（2026-08-14 新增；08-14 二次修复：真实数据契约）
 *
 * 数据源：Scene surface 'typhoon-panel'（AI 调 ShowTyphoon → 浙江水利厅主源 +
 * apizero 备源的真实双源数据 → upsertSurface）。
 * 数据诚实化：后端已删 mock，本组件只渲染数据源字段；无路径/无登陆点/无风圈
 * 时如实显示空态占位，不编造。
 * 布局（70vw 大面板，同热点组合模式）：
 *   左信息列（编号/等级/气压/风速/风圈/位置）
 *   中 Canvas 地图（海岸线+历史轨迹+风圈+登陆点）
 *   右列（登陆倒计时走秒+登陆地点+通用防御提示）
 * 交互：语音/文本"打开台风/关闭台风"，与天气/音乐/热点互斥（SideSheet 基座）。
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { apiPost, apiGet } from '../../lib/api'
import { useSceneClient } from '../../lib/scene-client'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { SideSheet } from '../SideSheet'

/** 2026-08-16: 路径点含气压/风速/风圈半径——hover 显示风力并绘制影响范围圈 */
interface PathPoint {
  time: string; lat: number | null; lon: number | null; level: string
  pressure?: number | null
  speed?: number | null
  radius7?: number | null
  radius10?: number | null
}
interface TyphoonData {
  id: string; name: string; nameEn: string
  level: string; levelCode: number
  centerPressure: number | null; maxWindSpeed: number | null
  moveDir: string; moveSpeed: number | null
  position: { lat: number; lon: number } | null
  windRadii: { r7: number | null; r10: number | null } | null
  /** 2026-08-15 P0: 四象限风圈数组 [NE,SE,SW,NW](真实数据; 缺省画圆) */
  windQuadrants?: { r7: number[] | null; r10: number[] | null } | null
  /** 2026-08-15 理想面板: 真实雨圈半径(数据源提供时); 缺省前端按 7 级风圈推算示意 */
  rainRadius?: number
  /** 2026-08-15 理想面板: 真实云图 URL(数据源提供时); 缺省图层不渲染 */
  cloudImageUrl?: string
  history: PathPoint[]; forecast: PathPoint[]
  landfall: { time: string; place: string } | null
  alerts: string[]
  warnLevel: string
  updatedAt: string
  disclaimer: string
  /** 2026-08-15 P1: 机构预报对比(文字摘要) */
  forecastAgencies?: Array<{ agency: string; summary: string }>
  /** 2026-08-15 P1: 其他活跃台风(切换 tab) */
  siblings?: Array<{ tfid: string; name: string; level: string; warnLevel: string }>
  currentTfid?: string
  /** 2026-08-16: 历史台风视图标记（后端 mapHistoryDetailToPanelData 归一化注入） */
  isHistory?: boolean
  /** 2026-08-26: 多台风同图——全部活跃台风完整数据（每台风自含 history/forecast/position） */
  tracks?: TyphoonData[]
}

/** 2026-08-16: hover/锁定路径点数据类型（绘制影响范围圈用；坐标已转瓦片坐标系） */
type HoverPoint = { lat: number; lon: number; level: string; time?: string; pressure?: number | null; speed?: number | null; radius7?: number | null; radius10?: number | null }

/** 2026-08-16: 历史台风列表条目（GET /panels/typhoon/history） */
interface HistoryItem {
  id: string
  tcNum: string
  name: string
  nameEn: string
  state: string
  stateLabel: string
  isActive: boolean
}

/** 2026-08-16: 空态默认地图的数据骨架——无活跃台风时也渲染中国沿海地图 */
const EMPTY_MAP_DATA: TyphoonData = {
  id: '', name: '', nameEn: '', level: '', levelCode: 0,
  centerPressure: null, maxWindSpeed: null, moveDir: '', moveSpeed: null,
  position: null, windRadii: null, history: [], forecast: [],
  landfall: null, alerts: [], warnLevel: '', updatedAt: '', disclaimer: '',
}

const LEVEL_COLORS: Record<string, string> = {
  '热带低压': '#4fc3f7', '热带风暴': '#29b6f6', '强热带风暴': '#ffb74d',
  '台风': '#ff7043', '强台风': '#ef5350', '超强台风': '#d32f2f',
}
// 2026-08-15 P0: 强度等级顺序(官方六级, 蓝→深红)——趋势箭头与色阶用
const LEVEL_ORDER = ['热带低压', '热带风暴', '强热带风暴', '台风', '强台风', '超强台风']

/** 2026-08-26: 多台风同图的台风署名色——参考同类台风地图(每台风一条异色路径线)。
 *  焦点台风用 LEVEL_COLORS 强度分段，其余台风用本表固定色，路径+当前位置+风圈统一。 */
const SIBLING_TRACK_COLORS = ['#26a69a', '#7e57c2', '#ec407a', '#ffa726', '#9ccc65', '#5c6bc0']

/** 球面距离(km, haversine)——"距最近主要城市"参考 */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const WARN_CN: Record<string, string> = {
  white: '白色预警', blue: '蓝色预警', yellow: '黄色预警', orange: '橙色预警', red: '红色预警',
}

function pad2(n: number) { return String(n).padStart(2, '0') }

/* ─── 登陆倒计时（真实走秒；无登陆点/时间非法 → 占位不渲染假数字）─── */
function LandfallCountdown({ target }: { target: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const targetMs = new Date(target).getTime()
  if (Number.isNaN(targetMs)) {
    return <div className="typhoon-countdown-time">--:--:--</div>
  }
  const diff = Math.max(0, targetMs - now)
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return (
    <div className={`typhoon-countdown-time${diff < 3600000 ? ' is-soon' : ''}`}>
      {pad2(h)}:{pad2(m)}:{pad2(s)}
    </div>
  )
}

/* 2026-08-16: 手绘 canvas 海岸线/自适应范围已移除——改用 Leaflet 真实瓦片
   （真实海岸线/岛屿自带, 不再需要 COASTLINE/TAIWAN/MAP_RANGE） */
// 2026-08-15 P0: 主要沿海城市参照点(装饰性常量, 帮助用户定位"台风离哪近")
const CITIES: Array<{ name: string; lat: number; lon: number }> = [
  { name: '上海', lat: 31.2, lon: 121.5 },
  { name: '杭州', lat: 30.3, lon: 120.2 },
  { name: '温州', lat: 28.0, lon: 120.7 },
  { name: '福州', lat: 26.1, lon: 119.3 },
  { name: '台北', lat: 25.0, lon: 121.5 },
  { name: '厦门', lat: 24.5, lon: 118.1 },
  { name: '广州', lat: 23.1, lon: 113.3 },
  { name: '香港', lat: 22.3, lon: 114.2 },
  { name: '海口', lat: 20.0, lon: 110.3 },
]

// 2026-08-16: Leaflet 真实地图。瓦片源按序 fallback：
//   1) 高德暗色（style=8, lang=zh_cn）——国内 CDN 快、中文地名标注；GCJ-02 火星坐标
//   2) CartoDB dark_all——全球兜底（境外网络可达时）；WGS-84
// 台风源数据为 WGS-84：高德瓦片叠加前需 wgs84ToGcj02 转换（中国境外无偏移原样返回）。
// 强度分段着色 + 逐段浮现动画保留；全部源失败时灰底 + 提示，路径数据仍可显示。
const TILE_SOURCES: Array<{ url: string; subdomains: string; attribution: string; gcj02: boolean }> = [
  {
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: '1234',
    attribution: '© 高德地图',
    gcj02: true,
  },
  {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    attribution: '© OpenStreetMap © CARTO',
    gcj02: false,
  },
]
const DEFAULT_VIEW: L.LatLngExpression = [24.5, 120]
const DEFAULT_ZOOM = 6

/* WGS-84 → GCJ-02（火星坐标）标准算法——高德瓦片用 GCJ-02 渲染，WGS 数据直叠会偏移数百米 */
const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323
function outOfChina(lat: number, lon: number) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}
function transformLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return r
}
function transformLon(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return r
}
function wgs84ToGcj02(lat: number, lon: number): [number, number] {
  if (outOfChina(lat, lon)) return [lat, lon]
  const dLat = transformLat(lon - 105.0, lat - 35.0)
  const dLon = transformLon(lon - 105.0, lat - 35.0)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const dLat2 = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI)
  const dLon2 = (dLon * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lat + dLat2, lon + dLon2]
}

function TyphoonMap({ data, onFocusTrack }: { data: TyphoonData; onFocusTrack?: (tfid: string) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<L.LayerGroup | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  /** 2026-08-16: hover 影响范围圈层（独立于数据层，mouseout 清空） */
  const hoverRef = useRef<L.LayerGroup | null>(null)
  const [tileFailed, setTileFailed] = useState(false)
  // 2026-08-16: 瓦片源序号（tileerror 连续超阈值 → 切下一源 fallback）
  const [srcIdx, setSrcIdx] = useState(0)
  // 2026-08-26: 容器尺寸未稳定(入场动画)时的重绘触发——fitBounds 需在真实尺寸下执行
  const [redrawTick, setRedrawTick] = useState(0)
  const tileErrRef = useRef(0)
  // 当前瓦片源的坐标转换：高德 GCJ-02（WGS 需转换），CartoDB WGS-84（原样）
  const toLatLon = (lat: number, lon: number): [number, number] =>
    TILE_SOURCES[srcIdx].gcj02 ? wgs84ToGcj02(lat, lon) : [lat, lon]
  // 2026-08-16: 图层开关（路径/风圈/雨圈）——图例点击切换，默认全开
  const [visible, setVisible] = useState({ path: true, wind: true, rain: true })
  const toggleLayer = (k: keyof typeof visible) => setVisible(v => ({ ...v, [k]: !v[k] }))
  // 有效历史路径点（组件作用域：绘制 effect + 图例共用；lat/lon 非法 → 跳过；WGS 原值）
  const validHistory = data.history.filter(p => p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon)) as Array<{ lat: number; lon: number; level: string; time?: string; pressure?: number | null }>
  // 2026-08-26: 多台风同图——全部活跃台风（无 tracks 字段时仅自身，兼容空态/历史视图）
  const allTracks = (data.tracks && data.tracks.length > 0 ? data.tracks : [data])
    .filter(t => t && t.id)
  // 路径点 hover 信息："级别 · 风速 m/s · 气压 hPa · 时间"（无数据字段则省略，不编造）
  const pointTip = (p: { level: string; pressure?: number | null; time?: string; speed?: number | null }) => {
    const parts: string[] = []
    if (p.level) parts.push(p.level)
    if (p.speed != null) parts.push(`${p.speed} m/s`)
    if (p.pressure != null) parts.push(`${p.pressure} hPa`)
    if (p.time) parts.push(p.time.replace('T', ' ').slice(5, 16))
    return parts.join(' · ') || '—'
  }

  // 2026-08-16: hover/点击路径点 → 影响范围圈（通用台风展示方式）：
  //   多层同心风圈（7/10级，真实半径优先/无则风速示意）+ 径向渐变叠层 + 发光呼吸动画
  //   + 中心点（白描边红心 + 旋转台风符号）+ 圆边缘半径标签
  // 交互：hover 显示、移出 1.6s 保留后淡出（不闪烁）、点击锁定常显（金色外环 + 锁定标签）
  const ringTimerRef = useRef<number | null>(null)
  const lockedPointRef = useRef<HoverPoint | null>(null)
  const clearRing = () => {
    if (ringTimerRef.current != null) { window.clearTimeout(ringTimerRef.current); ringTimerRef.current = null }
    lockedPointRef.current = null
    hoverRef.current?.clearLayers()
  }
  const scheduleClearRing = () => {
    // 已锁定 → 保持锁定圈（悬停过其他点后恢复锁定点）
    if (lockedPointRef.current) { drawHoverPoint(lockedPointRef.current, true); return }
    if (ringTimerRef.current != null) window.clearTimeout(ringTimerRef.current)
    ringTimerRef.current = window.setTimeout(() => {
      ringTimerRef.current = null
      hoverRef.current?.clearLayers()
    }, 1600)
  }
  const drawHoverPoint = (p: HoverPoint, locked: boolean) => {
    const hg = hoverRef.current
    if (!hg) return
    hg.clearLayers()
    // 圆边缘标记 + 半径标签（正东 0° / 正南 90° 错开）
    const edgeAt = (rKm: number, deg: number, content: string, color: string) => {
      const rad = (deg * Math.PI) / 180
      const dLat = (rKm / 111) * Math.sin(rad)
      const dLon = (rKm / (111 * Math.cos((p.lat * Math.PI) / 180))) * Math.cos(rad)
      const at: L.LatLngExpression = [p.lat + dLat, p.lon + dLon]
      L.circleMarker(at, { radius: 4, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1 }).addTo(hg)
      L.tooltip({ permanent: true, direction: 'right', className: 'typhoon-map-tooltip typhoon-map-tooltip--ring' })
        .setLatLng(at)
        .setContent(content)
        .addTo(hg)
    }
    // 圈数据：真实半径优先（7级/10级），无则风速示意（虚线 + 明确"示意"）
    const rings: Array<{ r: number; color: string; cls: string; label: string; deg: number; estimate: boolean }> = []
    const r7 = p.radius7 != null ? p.radius7 : null
    const r10 = p.radius10 != null ? p.radius10 : null
    if (r7 != null) rings.push({ r: r7, color: '#4fc3f7', cls: 'typhoon-ring-pulse--r7', label: `7级风圈 ${r7}km`, deg: 0, estimate: false })
    if (r10 != null) rings.push({ r: r10, color: '#ff7043', cls: 'typhoon-ring-pulse--r10', label: `10级风圈 ${r10}km`, deg: 90, estimate: false })
    if (rings.length === 0 && p.speed != null) rings.push({ r: Math.round(p.speed * 8), color: '#4fc3f7', cls: 'typhoon-ring-pulse--est', label: `影响范围示意 · ${p.speed} m/s`, deg: 0, estimate: true })
    // 三层同心底座叠加（中心浓→边缘淡 = 径向渐变感）+ 外圈发光描边 + 呼吸动画
    for (const ring of rings) {
      const layers: Array<[number, number]> = [[1, 0.1], [0.65, 0.15], [0.35, 0.22]]
      layers.forEach(([f, o]) => {
        L.circle([p.lat, p.lon], {
          radius: ring.r * 1000 * f, color: ring.color, weight: f === 1 ? 2 : 1,
          fillColor: ring.color, fillOpacity: o, dashArray: ring.estimate ? '4 6' : undefined,
          className: `typhoon-ring-pulse ${ring.cls}`,
        }).addTo(hg)
      })
      edgeAt(ring.r, ring.deg, ring.label, ring.color)
    }
    // 中心点：锁定态金色外环 → 白描边红心 → 旋转台风符号
    if (locked) {
      L.circleMarker([p.lat, p.lon], { radius: 16, color: '#ffd54f', weight: 2, fillColor: 'transparent', fillOpacity: 0, className: 'typhoon-ring-lock-halo' }).addTo(hg)
    }
    L.circleMarker([p.lat, p.lon], { radius: 10, color: '#fff', weight: 2.5, fillColor: '#ff5252', fillOpacity: 0.95 }).addTo(hg)
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ html: '<span class="typhoon-ring-cyc">🌀</span>', className: '', iconSize: [30, 30], iconAnchor: [15, 15] }),
      interactive: false,
    }).addTo(hg)
    if (locked) {
      L.tooltip({ permanent: true, direction: 'top', offset: [0, -18], className: 'typhoon-map-tooltip typhoon-map-tooltip--ring typhoon-map-tooltip--ring-lock' })
        .setLatLng([p.lat, p.lon])
        .setContent(`已锁定 · ${pointTip(p)}`)
        .addTo(hg)
    }
  }

  // 地图初始化（仅一次; 卸载时销毁）
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || mapRef.current) return
    const map = L.map(wrap, {
      zoomControl: false,
      attributionControl: true,
      minZoom: 3,
      maxZoom: 12,
    })
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    map.attributionControl.setPrefix('')
    mapRef.current = map
    layersRef.current = L.layerGroup().addTo(map)
    hoverRef.current = L.layerGroup().addTo(map)
    // 点击地图空白 → 清除锁定圈（路径点 click 已 stopPropagation 不会冒泡到这里）
    map.on('click', clearRing)
    // 面板启动动画后布局尺寸才稳定——延迟 invalidate 一次
    const t = setTimeout(() => map.invalidateSize(), 260)
    return () => { clearTimeout(t); map.remove(); mapRef.current = null; layersRef.current = null; hoverRef.current = null }
  }, [])

  // 瓦片层（按 TILE_SOURCES 序号；tileerror 连续超阈值 → 切下一源 fallback）
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const prev = tileLayerRef.current
    if (prev) { prev.remove(); prev.off() }
    const src = TILE_SOURCES[srcIdx]
    const tiles = L.tileLayer(src.url, {
      subdomains: src.subdomains,
      maxZoom: 20,
      attribution: src.attribution,
    }).addTo(map)
    tileLayerRef.current = tiles
    tiles.on('tileerror', () => {
      setTileFailed(true)
      tileErrRef.current += 1
      // 连续失败（如网络不可达整批瓦片挂）→ 切备用源；单张偶发失败不误切。
      // 2026-09-05 修复: 此前走到最后一个源后永久锁死——实测 CartoDB 在境内网络
      // 完全不可达, 高德一旦抖动累计 8 错切过去就再也回不来(灰底自愈失败)。
      // 现在末源连续 16 错回绕到首选源重试; 若首选已恢复, tileload 会清零计数稳住;
      // 若双源都挂, 8/16 的错距形成天然退避, 不会快速抖动。
      if (tileErrRef.current >= (srcIdx < TILE_SOURCES.length - 1 ? 8 : 16)) {
        tileErrRef.current = 0
        setSrcIdx(i => (i + 1) % TILE_SOURCES.length)
      }
    })
    tiles.on('tileload', () => { setTileFailed(false); tileErrRef.current = 0 })
    map.invalidateSize()
  }, [srcIdx])

  // 2026-08-31 修复(地图加载空白/全白): 面板常驻挂载, 地图在宽度 0(关闭态)初始化——
  // visible 翻转时 invalidateSize 执行于 0.45s 宽度过渡起点(仍 0), Leaflet 认为 0×0、
  // 视图/瓦片全部失效(实测 map-pane transform=identity + tile-pane 空)。
  // 打开后 600ms(过渡结束)补两件事: 从未 setView 则补默认视图; invalidateSize。
  useEffect(() => {
    if (!visible) return
    const t = setTimeout(() => {
      const map = mapRef.current
      if (!map) return
      if (!(map as any)._loaded) {
        map.setView(DEFAULT_VIEW, DEFAULT_ZOOM)
      }
      map.invalidateSize()
    }, 600)
    return () => clearTimeout(t)
  }, [visible])
  // 数据变化 → 清图层重绘。2026-08-26 多台风同图：tracks（全部活跃台风）逐一绘
  // 制——焦点台风完整交互（hover 影响圈/锁定/分段强度色），其余台风画异色固定
  // 路径线+当前位置+风圈（不可交互，防图层过载）；预报路径画虚线。
  useEffect(() => {
    const map = mapRef.current
    const layers = layersRef.current
    if (!map || !layers) return
    // 2026-08-26: SideSheet 入场动画期间容器宽度可能仍为 0——此时 fitBounds 会按
    // 0 宽算出错误视口(zoom 8 漂到远海)→ 整图空白。尺寸未稳定则延迟重试。
    const size = map.getSize()
    if (size.x === 0 || size.y === 0) {
      const t = window.setTimeout(() => setRedrawTick(t => t + 1), 350)
      return () => window.clearTimeout(t)
    }
    layers.clearLayers()
    clearRing() // 数据变化（切台风/切源）→ 重置 hover/锁定圈

    const allTracks = (data.tracks && data.tracks.length > 0 ? data.tracks : [data])
      .filter(t => t && t.id)
    // 坐标 → 当前瓦片源坐标系（高德 GCJ-02 / CartoDB WGS-84；中国境外无偏移原样）

    // 主要沿海城市参照点（帮助定位；随瓦片坐标系转换）
    for (const c of CITIES) {
      const [cLat, cLon] = toLatLon(c.lat, c.lon)
      L.circleMarker([cLat, cLon], { radius: 3, color: '#94a3b8', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.9 })
        .bindTooltip(c.name, { direction: 'top', offset: [0, -4], className: 'typhoon-map-tooltip' })
        .addTo(layers)
    }

    // ── 逐台风绘制 ──
    const bounds: Array<[number, number]> = []
    let siblingIdx = 0
    allTracks.forEach((tr) => {
      const isFocused = String(tr.id) === String(data.id)
      if (!isFocused) siblingIdx += 1
      const tPosM = tr.position ? (() => { const [a, b] = toLatLon(tr.position!.lat, tr.position!.lon); return { lat: a, lon: b } })() : null
      const tPts = (tr.history || []).filter(p => p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map(p => { const [a, b] = toLatLon(p.lat!, p.lon!); return { ...p, lat: a, lon: b } })
      const tForecast = (tr.forecast || []).filter(p => p.lat != null && p.lon != null && Number.isFinite(p.lat) && Number.isFinite(p.lon))
        .map(p => { const [a, b] = toLatLon(p.lat!, p.lon!); return { ...p, lat: a, lon: b } })
      // 非焦点台风按序号取异色（多台风同图各带一条可区分的路径线）
      const accent = SIBLING_TRACK_COLORS[(siblingIdx - 1) % SIBLING_TRACK_COLORS.length]
      const trackColor = isFocused ? null : accent

      // 实况路径：焦点台风 = 强度分段着色 + 浮现动画 + 完整交互；非焦点 = 固定异色线
      if (visible.path && tPts.length > 0) {
        const drawPoints: Array<{ lat: number; lon: number; level: string; time?: string; pressure?: number | null }> = [...tPts]
        if (tPosM && isFocused) drawPoints.push({ lat: tPosM.lat, lon: tPosM.lon, level: tr.level })
        drawPoints.forEach((p, i) => {
          if (i === 0) return
          const a = drawPoints[i - 1], b = p
          const color = isFocused
            ? (LEVEL_COLORS[b.level] || (b.level ? '#fff' : (LEVEL_COLORS[tr.level] || '#fff')))
            : trackColor!
          const seg = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
            color, weight: isFocused ? 2.5 : 2, opacity: isFocused ? 0.9 : 0.8, lineCap: 'round',
          }).addTo(layers)
          if (isFocused) {
            seg.bindTooltip(pointTip(b), { className: 'typhoon-map-tooltip' })
            const path = seg.getElement() as SVGPathElement | null
            if (path) {
              const len = path.getTotalLength()
              path.style.strokeDasharray = String(len)
              path.style.strokeDashoffset = String(len)
              path.style.transition = 'stroke-dashoffset 380ms linear'
              path.style.transitionDelay = `${i * 55}ms`
              requestAnimationFrame(() => { path.style.strokeDashoffset = '0' })
            }
          }
        })
        // 路径点：焦点台风带 hover 影响圈/点击锁定；非焦点仅常显 tooltip
        tPts.forEach(p => {
          const cm = L.circleMarker([p.lat, p.lon], {
            radius: isFocused ? 4.5 : 3.5,
            color: '#fff', weight: 1,
            fillColor: isFocused ? (LEVEL_COLORS[p.level] || '#fff') : trackColor!,
            fillOpacity: isFocused ? 1 : 0.85,
          }).addTo(layers)
          if (isFocused) {
            cm.bindTooltip(pointTip(p), { className: 'typhoon-map-tooltip' })
              .on('mouseover', () => { if (ringTimerRef.current != null) { window.clearTimeout(ringTimerRef.current); ringTimerRef.current = null }; drawHoverPoint(p, false) })
              .on('mouseout', scheduleClearRing)
              .on('click', (e) => {
                L.DomEvent.stopPropagation(e)
                const lk = lockedPointRef.current
                if (lk && lk.lat === p.lat && lk.lon === p.lon) clearRing()
                else { lockedPointRef.current = p; drawHoverPoint(p, true) }
              })
          } else {
            cm.bindTooltip(`${tr.name} · ${pointTip(p)}`, { className: 'typhoon-map-tooltip' })
          }
        })
      }

      // 预报路径（中国机构）——虚线 + 空心端点，不随图层开关(visible.path 才显示)
      if (visible.path && tForecast.length > 0) {
        const foreColor = isFocused ? '#94a3b8' : trackColor!
        L.polyline(tForecast.map(p => [p.lat, p.lon] as [number, number]), {
          color: foreColor, weight: 2, opacity: 0.75, dashArray: '7 6', lineCap: 'round',
        }).addTo(layers)
        tForecast.forEach(p => {
          L.circleMarker([p.lat, p.lon], {
            radius: 3, color: foreColor, weight: 1.5, fillColor: 'transparent', fillOpacity: 1,
          })
            .bindTooltip(`预报 · ${pointTip(p)}`, { className: 'typhoon-map-tooltip' })
            .addTo(layers)
        })
        // 预报线起点衔接实况终点（视觉连续性：来自机构预报首点即当前点）
      }

      // 风圈（四象限非对称 8 点 polygon；缺四象限画圆近似）——visible.wind 开关。
      // 非焦点台风只画均值圆近似（不画四象限，避免误读优先级）
      if (tPosM && visible.wind) {
        const drawWindBlob = (quad: number[] | null | undefined, fallbackR: number | null, color: string, fillOpacity: number) => {
          const radAt = (deg: number): number | null => {
            if (quad && quad.length === 4) {
              const t = ((deg + 45) % 360) / 90
              const idx = Math.floor(t) % 4
              const frac = t - Math.floor(t)
              const a = quad[idx], b = quad[(idx + 1) % 4]
              return a + (b - a) * frac
            }
            return fallbackR
          }
          const cpts: L.LatLngExpression[] = []
          for (let deg = 0; deg < 360; deg += 45) {
            const r = radAt(deg)
            if (r == null) return
            const rad = (deg * Math.PI) / 180
            const dLat = (r / 111) * Math.sin(rad)
            const dLon = (r / (111 * Math.cos((tPosM.lat * Math.PI) / 180))) * Math.cos(rad)
            cpts.push([tPosM.lat + dLat, tPosM.lon + dLon])
          }
          L.polygon(cpts, { color, weight: 1.2, fillColor: color, fillOpacity, dashArray: '4 4' }).addTo(layers)
        }
        const q7 = tr.windQuadrants?.r7
        const q10 = tr.windQuadrants?.r10
        if (q7 || (tr.windRadii && tr.windRadii.r7 != null)) drawWindBlob(q7, tr.windRadii?.r7 ?? null, '#4fc3f7', 0.08)
        if (q10 || (tr.windRadii && tr.windRadii.r10 != null)) drawWindBlob(q10, tr.windRadii?.r10 ?? null, '#ff7043', 0.1)
      }

      // 雨圈（真实优先; 缺省 r7×1.4 示意）——仅焦点台风绘制（防多雨圈层级混乱）
      if (tPosM && isFocused && visible.rain) {
        const rainR = tr.rainRadius != null
          ? tr.rainRadius
          : (tr.windRadii && tr.windRadii.r7 != null ? Math.round(tr.windRadii.r7 * 1.4) : null)
        if (rainR != null) {
          L.circle([tPosM.lat, tPosM.lon], { radius: rainR * 1000, color: '#34d399', weight: 1.2, fillColor: '#34d399', fillOpacity: 0.05, dashArray: '3 6' }).addTo(layers)
        }
      }

      // 当前位置（台风符号 + 名称常显标签）——每个台风都有（参考图同款：双台风各标名）
      if (tPosM) {
        const posColor = isFocused ? '#ff5252' : trackColor!
        L.circleMarker([tPosM.lat, tPosM.lon], {
          radius: isFocused ? 8 : 6, color: posColor, weight: 2.5, fillColor: posColor, fillOpacity: 0.55,
        })
          .bindTooltip(`${tr.id} ${tr.name}`, { permanent: true, direction: 'right', offset: [10, 0], className: 'typhoon-map-tooltip typhoon-map-tooltip--pos' })
          .addTo(layers)
      }

      // 本台风路径/预报/位置入包围盒（视野统一）
      tPts.forEach(p => bounds.push([p.lat, p.lon]))
      tForecast.forEach(p => bounds.push([p.lat, p.lon]))
      if (tPosM) bounds.push([tPosM.lat, tPosM.lon])
    })

    // 视野：路径包围盒 与「中国沿海默认视域」取并集——2026-08-25 用户反馈
    // 「默认放大无法浏览全图」: 纯 fitBounds 在台风路径短/远海时过度放大。
    // 并集保证打开即见沿海全域(外加路径), 远海台风自动撑大而非被迫聚焦。
    if (bounds.length > 0) {
      const fit = L.latLngBounds(bounds)
      fit.extend(L.latLngBounds([[17.5, 102], [30.5, 126]])) // 沿海默认视域(南海→华东西太平洋)
      map.fitBounds(fit, { padding: [30, 30], maxZoom: 8 })
    } else {
      map.setView(DEFAULT_VIEW, DEFAULT_ZOOM)
    }
    map.invalidateSize()
  }, [data, visible, srcIdx, redrawTick])

  return (
    <div className="typhoon-map-leaflet">
      <div ref={wrapRef} className="typhoon-map-leaflet--canvas" />
      {tileFailed && (
        <div className="typhoon-map-tile-error">地图瓦片加载失败（离线？）· 台风路径数据仍可显示</div>
      )}
      {!data.position && (
        <div className="typhoon-map-no-pos">暂无路径数据</div>
      )}
      {/* 图例（强度色阶 + 多台风署名 + 路径/风圈/雨圈图层开关——点击切换显示） */}
      {(allTracks.some(tr => (tr.history || []).length > 0 || tr.forecast?.length)
        || (data.windRadii && data.windRadii.r7 != null) || (() => {
        const rainR = data.rainRadius != null ? data.rainRadius : (data.windRadii && data.windRadii.r7 != null ? Math.round(data.windRadii.r7 * 1.4) : null)
        return rainR != null
      })()) && (
        <div className="typhoon-map-legend">
          {/* 2026-08-26: 多台风署名——各台风路径线配色对应（参考图同款名称角标） */}
          {allTracks.length > 1 && (
            <div className="typhoon-map-legend-row typhoon-map-legend-tracks">
              {allTracks.map((tr, ti) => {
                const isFocused = String(tr.id) === String(data.id)
                const color = isFocused ? (LEVEL_COLORS[data.level] || '#ff5252') : SIBLING_TRACK_COLORS[ti % SIBLING_TRACK_COLORS.length]
                return (
                  <button
                    key={tr.id}
                    type="button"
                    className="typhoon-map-legend-track"
                    style={{ color, borderColor: `${color}88` }}
                    onClick={() => { if (!isFocused) onFocusTrack?.(String(tr.id)) }}
                    title={isFocused ? '当前台风' : `切换到「${tr.name}」`}
                  >
                    <span className="typhoon-map-legend-line typhoon-map-legend-line--track" style={{ borderColor: color }} />
                    {tr.id} {tr.name} · {isFocused ? '当前' : (tr.level || '—')}
                  </button>
                )
              })}
            </div>
          )}
          {validHistory.length > 0 && (
            <div className="typhoon-map-legend-row">
              {LEVEL_ORDER.map(lv => (
                <span key={lv} className="typhoon-map-legend-swatch" style={{ background: LEVEL_COLORS[lv] }} title={lv} />
              ))}
              <span className="typhoon-map-legend-text">强度</span>
            </div>
          )}
          {validHistory.length > 0 && (
            <button type="button" className={`typhoon-map-legend-row${visible.path ? '' : ' typhoon-map-legend-row--off'}`} onClick={() => toggleLayer('path')} title="点击显示/隐藏路径">
              <span className="typhoon-map-legend-line" style={{ borderColor: '#ff7043', borderStyle: 'solid' }} />路径
              <span className="typhoon-map-legend-state">{visible.path ? '显示' : '隐藏'}</span>
            </button>
          )}
          {data.windRadii && data.windRadii.r7 != null && (
            <button type="button" className={`typhoon-map-legend-row${visible.wind ? '' : ' typhoon-map-legend-row--off'}`} onClick={() => toggleLayer('wind')} title="点击显示/隐藏风圈">
              <span className="typhoon-map-legend-line" style={{ borderColor: '#4fc3f7', borderStyle: 'solid' }} />7级风圈
              <span className="typhoon-map-legend-state">{visible.wind ? '显示' : '隐藏'}</span>
            </button>
          )}
          {(() => {
            const rainR = data.rainRadius != null
              ? data.rainRadius
              : (data.windRadii && data.windRadii.r7 != null ? Math.round(data.windRadii.r7 * 1.4) : null)
            if (rainR == null) return null
            return (
              <button type="button" className={`typhoon-map-legend-row${visible.rain ? '' : ' typhoon-map-legend-row--off'}`} onClick={() => toggleLayer('rain')} title="点击显示/隐藏降雨圈">
                <span className="typhoon-map-legend-line" style={{ borderColor: '#34d399', borderStyle: 'dashed' }} />{data.rainRadius != null ? '降雨圈' : '降雨圈·示意'}
                <span className="typhoon-map-legend-state">{visible.rain ? '显示' : '隐藏'}</span>
              </button>
            )
          })()}
        </div>
      )}
    </div>
  )
}

/* ─── 指标小卡 ─── */
function Metric({ label, value, unit, color }: { label: string; value: string | number | null | undefined; unit?: string; color?: string }) {
  return (
    <div className="typhoon-metric">
      <div className="typhoon-metric-label">{label}</div>
      <div className="typhoon-metric-value" style={color ? { color } : undefined}>
        {value != null && value !== '' ? value : '--'}{value != null && value !== '' && unit ? <span className="typhoon-metric-unit">{unit}</span> : null}
      </div>
    </div>
  )
}

function TyphoonContent({ data, isHistory, onOpenHistory, onExitHistory, onClose, onRefresh, refreshing, refreshError, onFocusTrack }: {
  data: TyphoonData
  /** 2026-08-16: 历史台风视图标记（头部"历史台风"角标 + 返回当前按钮） */
  isHistory?: boolean
  onOpenHistory: () => void
  onExitHistory: () => void
  onClose: () => void
  onRefresh: (force: boolean, tfid?: string) => void
  refreshing: boolean
  refreshError: string
  /** 2026-08-26: 多台风本地焦点切换（数据已在 tracks，无需回源） */
  onFocusTrack: (tfid: string) => void
}) {
  const levelColor = LEVEL_COLORS[data.level] || '#4fc3f7'
  return (
    <div className="typhoon-panel">
      {/* 头部 */}
      <header className="typhoon-header sheet-boot" style={{ ['--boot-delay' as any]: '40ms' }}>
        <div className="typhoon-header-left">
          <span className="typhoon-header-icon" aria-hidden="true">🌀</span>
          <span className="typhoon-header-title">台风追踪 · 气象感知</span>
          {isHistory && (
            <span className="typhoon-level-badge" style={{ background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.4)' }}>
              历史台风
            </span>
          )}
          {!isHistory && data.level && (
            <span className="typhoon-level-badge" style={{ background: `${levelColor}22`, color: levelColor, border: `1px solid ${levelColor}55` }}>
              {data.level}
            </span>
          )}
          {!isHistory && data.warnLevel && (
            <span className="typhoon-warn-badge">{WARN_CN[data.warnLevel] || data.warnLevel}</span>
          )}
        </div>
        <div className="typhoon-header-right">
          <span className="typhoon-header-en">TYPHOON TRACKING · {isHistory ? 'HISTORY' : `${data.id} ${data.nameEn}`}</span>
          {/* 2026-08-16: 历史台风入口（列表层）+ 历史视图返回当前 */}
          {isHistory && (
            <button
              type="button"
              className="typhoon-history-btn"
              onClick={onExitHistory}
              aria-label="返回当前台风"
              title="返回当前台风"
            >← 返回当前</button>
          )}
          <button
            type="button"
            className="typhoon-history-btn"
            onClick={onOpenHistory}
            aria-label="查看历史台风"
            title="查看历史台风"
          >🕘 历史</button>
          {/* 2026-08-15 交互对齐: 手动刷新按钮(?refresh=1 绕过缓存) */}
          <button
            type="button"
            className="typhoon-close-btn"
            onClick={() => onRefresh(true)}
            aria-label="刷新台风数据"
            title="刷新数据"
            disabled={refreshing}
          >{refreshing ? '…' : '⟳'}</button>
          <button
            data-close-btn
            type="button"
            className="typhoon-close-btn"
            onClick={onClose}
            aria-label="关闭台风面板"
            title="关闭"
          >×</button>
        </div>
      </header>
      {/* 2026-08-15: 刷新失败横幅(透明错误态, 参考实现 conn-banner 语义) */}
      {refreshError && (
        <div className="typhoon-refresh-error sheet-boot" style={{ ['--boot-delay' as any]: '80ms' }} role="alert">
          ⚠ {refreshError}
        </div>
      )}

      {/* 2026-08-15 P1: 多台风切换 tab(有多个活跃台风时出现)
          2026-08-26: 数据已在 tracks 内 → 本地切换焦点(不再回源), 地图同图不改 */}
      {(data.tracks && data.tracks.length > 1) && (
        <div className="typhoon-tabs">
          {data.tracks.map(tr => {
            const isActive = String(tr.id) === String(data.id)
            return (
              <button
                key={tr.id}
                type="button"
                className={`typhoon-tab${isActive ? ' is-active' : ''}`}
                onClick={() => { if (!isActive) onFocusTrack(String(tr.id)) }}
                title={`切换查看台风「${tr.name}」`}
              >{tr.name}{tr.level ? ` · ${tr.level}` : ''}{tr.warnLevel ? ' ⚠' : ''}</button>
            )
          })}
        </div>
      )}

      {/* 2026-08-15 用户指定布局: 左数据列(指标+路径预测列表) + 右侧大地图(路径/云图/雨圈/风圈) */}
      <div className="typhoon-body sheet-boot" style={{ ['--boot-delay' as any]: '130ms' }}>
        {/* 左数据列 */}
        <div className="typhoon-side typhoon-side--left">
          <div className="typhoon-name-card">
            <div className="typhoon-name-main">{data.id ? `${data.id}号 · ` : ''}{data.name || '未命名台风'}</div>
            <div className="typhoon-name-sub">{data.nameEn}{data.level ? ` · ${data.level}` : ''}</div>
          </div>
          {/* 四大指标: 最大风速/中心气压/移动方向/移动速度 */}
          <div className="typhoon-metric-grid">
            <Metric label="最大风速" value={data.maxWindSpeed} unit="m/s" color="#ff7043" />
            <Metric label="中心气压" value={data.centerPressure} unit="hPa" color="#4fc3f7" />
            <Metric label="移动方向" value={data.moveDir || '—'} />
            <Metric label="移动速度" value={data.moveSpeed} unit="km/h" />
          </div>
          {data.windRadii && (
            <div className="typhoon-metric-grid">
              <Metric label="7级风圈" value={data.windRadii.r7} unit="km" color="#4fc3f7" />
              <Metric label="10级风圈" value={data.windRadii.r10} unit="km" color="#ff7043" />
            </div>
          )}
          {(data.rainRadius != null || (data.windRadii && data.windRadii.r7 != null)) && (
            <Metric
              label={data.rainRadius != null ? '降雨圈半径' : '降雨圈半径(示意)'}
              value={data.rainRadius != null ? data.rainRadius : Math.round((data.windRadii?.r7 ?? 0) * 1.4)}
              unit="km"
              color="#34d399"
            />
          )}
          {data.position && (
            <div className="typhoon-pos-box">
              中心位置 {data.position.lat.toFixed(1)}°N, {data.position.lon.toFixed(1)}°E
              {/* 2026-08-15 P0: 强度趋势箭头(较上一路径点) */}
              {(() => {
                const hs = data.history || []
                if (hs.length < 2) return null
                const cur = LEVEL_ORDER.indexOf(hs[hs.length - 1].level)
                const prev = LEVEL_ORDER.indexOf(hs[hs.length - 2].level)
                if (cur < 0 || prev < 0) return null
                if (cur > prev) return <span style={{ color: '#ff7043', marginLeft: 6 }}>↑ 增强</span>
                if (cur < prev) return <span style={{ color: '#4fc3f7', marginLeft: 6 }}>↓ 减弱</span>
                return <span style={{ color: 'rgba(148,163,184,0.8)', marginLeft: 6 }}>→ 维持</span>
              })()}
            </div>
          )}
          {/* 2026-08-15 P0: 距最近主要城市 + 预计影响时间(直线估算, 明确标注口径) */}
          {data.position && data.moveSpeed != null && (() => {
            const p = data.position as { lat: number; lon: number }
            let best: { name: string } | null = null
            let bestKm = Infinity
            for (const c of CITIES) {
              const d = haversineKm(p.lat, p.lon, c.lat, c.lon)
              if (d < bestKm) { bestKm = d; best = c }
            }
            if (!best) return null
            const hours = data.moveSpeed != null && data.moveSpeed > 0 ? bestKm / data.moveSpeed : null
            return (
              <div className="typhoon-pos-box" style={{ color: 'rgba(251, 191, 36, 0.95)' }}>
                距{best.name}约 {Math.round(bestKm)} km
                {hours != null ? ` · 直线约 ${Math.round(hours)}h 后影响` : ''}
              </div>
            )
          })()}
          {/* 2026-08-15 P0: 四象限风圈数值表(真实数据, 非对称) */}
          {data.windQuadrants && (data.windQuadrants.r7 || data.windQuadrants.r10) && (
            <div className="typhoon-quad-table">
              <div className="typhoon-quad-title">风圈半径 · 四象限(km)</div>
              {(['r7', 'r10'] as const).map(k => data.windQuadrants![k] && (
                <div key={k} className="typhoon-quad-row">
                  <span className="typhoon-quad-label">{k === 'r7' ? '7级' : '10级'}</span>
                  {['东北', '东南', '西南', '西北'].map((dir, i) => (
                    <span key={dir} className="typhoon-quad-cell">{dir.slice(0, 1)} {data.windQuadrants![k]![i]}</span>
                  ))}
                </div>
              ))}
            </div>
          )}

          {/* 路径预测数据列表(历史+预报, 滚动) */}
          <div className="typhoon-path-section">
            <div className="typhoon-path-section-title">路径预测数据</div>
            {(() => {
              const entries = [
                ...(data.history || []).map(p => ({ ...p, kind: '历史' as const })),
                ...(data.forecast || []).map(p => ({ ...p, kind: '预报' as const })),
              ]
              if (entries.length === 0) {
                return <div className="typhoon-empty">暂无路径数据</div>
              }
              return (
                <div className="typhoon-path-list">
                  {entries.map((p, i) => (
                    <div key={i} className={`typhoon-path-row${p.kind === '预报' ? ' is-forecast' : ''}`}>
                      <span className="typhoon-path-kind">{p.kind === '预报' ? '预' : '史'}</span>
                      <span className="typhoon-path-time">{p.time ? p.time.replace('T', ' ').slice(5, 16) : '—'}</span>
                      <span className="typhoon-path-pos">
                        {p.lat != null && p.lon != null ? `${Number(p.lat).toFixed(1)}°N ${Number(p.lon).toFixed(1)}°E` : '—'}
                      </span>
                      <span className="typhoon-path-level">{p.level || ''}</span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>

          {/* 2026-08-15 P1: 机构预报对比(文字摘要, 多机构路径分歧是最有价值的信息) */}
          {data.forecastAgencies && data.forecastAgencies.length > 0 && (
            <div className="typhoon-agencies">
              <div className="typhoon-path-section-title">机构预报对比</div>
              {data.forecastAgencies.map((f, i) => (
                <div key={i} className="typhoon-agency-row">
                  <span className="typhoon-agency-name">{f.agency}</span>
                  <span className="typhoon-agency-summary">{f.summary}</span>
                </div>
              ))}
            </div>
          )}

          {/* 2026-08-15 P1: 条件化防御提示——仅橙/红预警或 24h 内可能登陆时展示 */}
          {(() => {
            const highRisk = data.warnLevel === 'orange' || data.warnLevel === 'red'
            const landMs = data.landfall ? new Date(data.landfall.time).getTime() : NaN
            const nearLandfall = !Number.isNaN(landMs) && landMs - Date.now() < 24 * 3600 * 1000
            if (!highRisk && !nearLandfall) return null
            return (
              <div className="typhoon-alerts-box">
                <div className="typhoon-alerts-title">⚠ 防御提示{highRisk ? '（橙/红预警）' : '（24h 内可能登陆）'}</div>
                {data.alerts.map((a, i) => (
                  <div key={i} className="typhoon-alert-item">
                    <span className="typhoon-alert-dot" aria-hidden="true">·</span>{a}
                  </div>
                ))}
              </div>
            )
          })()}

          {/* 登陆倒计时(紧凑) */}
          <div className="typhoon-countdown-box">
            <div className="typhoon-countdown-label">预计登陆倒计时</div>
            {data.landfall ? (
              <>
                <LandfallCountdown target={data.landfall.time} />
                <div className="typhoon-landfall-place">{data.landfall.place}</div>
              </>
            ) : (
              <div className="typhoon-empty">暂无登陆点数据</div>
            )}
          </div>

          <div className="typhoon-updated">数据源：政府实时发布系统 · 更新于 {new Date(data.updatedAt).toLocaleString('zh-CN')}</div>
          <div className="typhoon-disclaimer">{data.disclaimer || '台风信息以官方发布为准。'}</div>
        </div>

        {/* 右侧沿海大地图——2026-08-16: 始终渲染（无台风时默认中国沿海地图 +
        周边海域；无位置时地图内标注"暂无路径数据"，不再整块空态占位） */}
        <div className="typhoon-map-wrap">
          <TyphoonMap data={data} onFocusTrack={onFocusTrack} />
        </div>
      </div>
    </div>
  )
}

export function TyphoonPanel() {
  const surface = useSceneClient('typhoon-panel')
  const [dismissed, setDismissed] = useState(false)
  const [voiceVisible, setVoiceVisible] = useState(false)
  // 2026-08-16 历史台风入口: 历史列表层 + 历史详情视图（切换后 surface 更新不打断）
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyItems, setHistoryItems] = useState<HistoryItem[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyData, setHistoryData] = useState<TyphoonData | null>(null)
  // 新 surface 到达重置关闭标记（对齐 HotspotPanel 模式）
  const prevSceneRef = useRef(!!surface)
  useEffect(() => {
    if (surface && !prevSceneRef.current) {
      setDismissed(false)
      closedRef.current = false // 2026-08-15: 新一轮推送 → 允许刷新
    }
    prevSceneRef.current = !!surface
  }, [surface])
  const visible = (voiceVisible || !!surface) && !dismissed
  // 2026-08-14 二次修复: surface 数据守卫——畸形数据(无 id/name/position)不渲染。
  // 2026-08-15: empty 空态标记放行(无活跃台风时后端推 empty 面板)——此前被守卫
  // 拒绝 → SideSheet 开空白面板(无标题无关闭按钮, "UI 乱了/无法关闭"的根因)
  const data: TyphoonData | null = surface?.data && typeof surface.data === 'object'
    && (surface.data.name || surface.data.position || (surface.data as { empty?: boolean }).empty === true)
    ? surface.data as TyphoonData
    : null
  // 2026-08-26: 本地焦点台风——tab 切换不回源（tracks 已在 surface 内）；
  // surface 更新后若焦点台风已不存在(如停编/刷新)则回退默认台风。
  const [focusTfid, setFocusTfid] = useState<string | null>(null)
  const shown: TyphoonData | null = useMemo(() => {
    if (!data || (data as any).empty) return data
    if (!focusTfid || !data.tracks?.length) return data
    const hit = data.tracks.find(t => String(t.id) === focusTfid)
    if (!hit) return data
    return { ...hit, tracks: data.tracks } // 保 tracks 引用 → tab/地图多台风不丢
  }, [data, focusTfid])
  useEffect(() => {
    if (focusTfid && data?.tracks?.length && !data.tracks.some(t => String(t.id) === focusTfid)) setFocusTfid(null)
  }, [data, focusTfid])

  // 2026-08-15 交互对齐(参考"自动轮询+时间戳透明化"哲学): 面板打开期间每 5 分钟
  // 自动刷新真实数据(政府源 3-6h 更新, 5min 轮询足够), 失败置错误横幅; 手动刷新
  // 按钮走 ?refresh=1 绕过后端缓存。
  const [refreshError, setRefreshError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  // 2026-08-15 修复(对齐 StockPanel closedRef 守卫): 关闭后刷新请求(5min 轮询/
  // 手动刷新)落地会重新 upsert surface → 面板被"复活"。关闭后刷新直接跳过;
  // 新 surface 到达(重新打开)时复位。
  const closedRef = useRef(false)
  const refresh = useCallback(async (force: boolean, tfid?: string) => {
    if (!data || closedRef.current) return
    setRefreshing(true)
    try {
      const params = new URLSearchParams()
      if (force) params.set('refresh', '1')
      if (tfid) params.set('tfid', tfid)
      const qs = params.toString()
      const res = await apiGet<{ updatedAt?: string }>(`/panels/typhoon${qs ? `?${qs}` : ''}`)
      if (res?.data?.updatedAt) setRefreshError('')
      else setRefreshError('数据刷新返回异常')
    } catch (e) {
      console.error('[TyphoonPanel] 数据刷新失败:', e)
      setRefreshError('数据刷新失败，点击重试')
    } finally {
      setRefreshing(false)
    }
  }, [data])
  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => { refresh(false).catch((e) => console.warn('[typhoon-panel] 定时刷新失败:', e)) }, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [visible, refresh])

  // ── 2026-08-16 历史台风入口（列表 → 详情 → 视图切换）──
  const openHistory = useCallback(async () => {
    setHistoryOpen(true)
    setHistoryError('')
    if (historyItems) return // 已缓存列表直接打开
    setHistoryLoading(true)
    try {
      const res = await apiGet<{ list: HistoryItem[]; total: number }>('/panels/typhoon/history')
      if (!res?.success || !Array.isArray(res.data?.list)) {
        setHistoryError(res?.error || '历史台风加载失败')
        return
      }
      setHistoryItems(res.data.list)
    } catch (e) {
      console.error('[TyphoonPanel] 历史台风列表加载失败:', e)
      setHistoryError('历史台风加载失败，请稍后再试')
    } finally {
      setHistoryLoading(false)
    }
  }, [historyItems])

  const openHistoryDetail = useCallback(async (item: HistoryItem) => {
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const res = await apiGet<TyphoonData>(`/panels/typhoon/history/detail?id=${encodeURIComponent(item.id)}`)
      if (!res?.success || !res.data) {
        setHistoryError(res?.error || '历史台风详情加载失败')
        return
      }
      setHistoryData(res.data)
      setHistoryOpen(false)
    } catch (e) {
      console.error('[TyphoonPanel] 历史台风详情加载失败:', e)
      setHistoryError('历史台风详情加载失败，请稍后再试')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const exitHistory = useCallback(() => setHistoryData(null), [])

  // 与 HotspotPanel 同款广播——VoiceShell 按 name 聚合 70% 组合布局状态
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'typhoon' } }))
    } catch (e) { console.warn('[typhoon-panel] 广播可见性事件失败(极端环境):', e) }
  }, [visible])

  const handleClose = useCallback(() => {
    closedRef.current = true
    setDismissed(true)
    setVoiceVisible(false)
    setHistoryOpen(false)      // 2026-08-16: 关闭时一并收起历史层/历史视图
    setHistoryData(null)
    apiPost('/api/scene/remove', { id: 'typhoon-panel' }).catch(e => console.warn('[TyphoonPanel] 移除 surface 失败:', e))
    apiPost('/api/scene/panel-state', { panel: 'typhoon', state: 'closed' }).catch(e => console.warn('[TyphoonPanel] 写入面板状态失败:', e))
  }, [])

  // 语音/文本开关接口（window.__typhoonPanel，对齐 __weatherPanel/__hotspotPanel 模式）
  useEffect(() => {
    const api = {
      setVisible: (v: boolean): boolean => {
        if (v) {
          if (!data) return false
          setDismissed(false)
          setVoiceVisible(true)
          return true
        }
        handleClose()
        return true
      },
      isVisible: () => visible,
    }
    return registerCommandHost('typhoonPanel', api)
  }, [data, visible, handleClose])

  return (
    <SideSheet open={visible} onClose={handleClose} name="typhoon" width="70vw">
      {historyData ? (
        /* 2026-08-16: 历史台风视图——完整数据列 + 地图（自适应范围画远海路径） */
        <TyphoonContent data={historyData} isHistory onOpenHistory={openHistory} onExitHistory={exitHistory} onClose={handleClose} onRefresh={refresh} refreshing={refreshing} refreshError={refreshError} onFocusTrack={(tfid) => setFocusTfid(tfid)} />
      ) : data && (data as any).empty === true ? (
        /* 2026-08-15: 空态面板——无活跃台风也打开面板(诚实空态+刷新)
           2026-08-16: 改为左右布局——左侧空态说明 + 历史台风入口, 右侧默认
           中国沿海地图(无路径/风圈), 不再整块文字占位 */
        <div className="typhoon-panel">
          <header className="typhoon-header sheet-boot" style={{ ['--boot-delay' as any]: '40ms' }}>
            <div className="typhoon-header-left">
              <span className="typhoon-header-icon" aria-hidden="true">🌀</span>
              <span className="typhoon-header-title">台风追踪 · 气象感知</span>
            </div>
            <div className="typhoon-header-right">
              <button type="button" className="typhoon-history-btn" onClick={openHistory} aria-label="查看历史台风" title="查看历史台风">🕘 历史</button>
              <button type="button" className="typhoon-close-btn" onClick={() => refresh(true)} aria-label="刷新台风数据" title="刷新数据" disabled={refreshing}>{refreshing ? '…' : '⟳'}</button>
              <button data-close-btn type="button" className="typhoon-close-btn" onClick={handleClose} aria-label="关闭台风面板" title="关闭">×</button>
            </div>
          </header>
          <div className="typhoon-body sheet-boot" style={{ ['--boot-delay' as any]: '130ms' }}>
            <div className="typhoon-side typhoon-side--left">
              <div className="typhoon-name-card">
                <div className="typhoon-name-main">当前无活跃台风</div>
                <div className="typhoon-name-sub">台风季请留意官方预警信息</div>
              </div>
              <div className="typhoon-pos-box">
                {(data as any).message || '当前暂无活跃台风'}
              </div>
              <button type="button" className="typhoon-history-btn typhoon-history-btn--primary" onClick={openHistory}>
                🕘 查看历史台风
              </button>
              <div className="typhoon-empty-sub">可点击 ⟳ 刷新 · 历史台风点击下方按钮</div>
              <div className="typhoon-updated">更新于 {new Date((data as any).updatedAt).toLocaleString('zh-CN')}</div>
            </div>
            <div className="typhoon-map-wrap">
              <TyphoonMap data={EMPTY_MAP_DATA} />
            </div>
          </div>
        </div>
      ) : (
        shown && <TyphoonContent data={shown} onOpenHistory={openHistory} onExitHistory={exitHistory} onClose={handleClose} onRefresh={refresh} refreshing={refreshing} refreshError={refreshError} onFocusTrack={(tfid) => setFocusTfid(tfid)} />
      )}

      {/* 2026-08-16: 历史台风列表层（fixed 覆盖, 点击遮罩/× 关闭; 列表点击加载详情） */}
      {historyOpen && (
        <div className="typhoon-history-overlay" onClick={() => setHistoryOpen(false)}>
          <div className="typhoon-history-card" onClick={(e) => e.stopPropagation()}>
            <div className="typhoon-history-head">
              <div className="typhoon-history-title">历史台风{historyItems ? `（${historyItems.length}）` : ''}</div>
              <button type="button" className="typhoon-close-btn" onClick={() => setHistoryOpen(false)} aria-label="关闭历史列表" title="关闭">×</button>
            </div>
            <div className="typhoon-history-list">
              {historyLoading && !historyItems && <div className="typhoon-history-empty">加载中…</div>}
              {historyError && <div className="typhoon-history-empty" style={{ color: '#ff7043' }}>{historyError}</div>}
              {historyItems && historyItems.length === 0 && <div className="typhoon-history-empty">暂无历史台风数据</div>}
              {historyItems?.map((it) => (
                <button key={it.id} type="button" className="typhoon-history-item" onClick={() => openHistoryDetail(it)} disabled={historyLoading}>
                  <span aria-hidden="true">🌀</span>
                  <span className="typhoon-history-item-name">
                    {it.name || '未命名台风'}{it.tcNum ? `（${it.tcNum}）` : ''}
                    <span className="typhoon-history-meta">{it.nameEn || ''}</span>
                  </span>
                  <span className="typhoon-history-state">{it.stateLabel || '已停编'}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </SideSheet>
  )
}

export default TyphoonPanel
