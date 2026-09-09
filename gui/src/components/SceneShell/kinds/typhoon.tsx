/**
 * TyphoonCard — 台风场景卡（kind 'typhoon'）
 *
 * 数据来自后端 TyphoonQuery 工具发射的 scene surface 'typhoon'：
 *   { items: [{tfid,name,enname,lat,lng,strong,power,pressure,speed,moveDir,moveSpeed,radius7,radius10,warnLevel}],
 *     detail?: { name, enname, strong, power, pressure, speed, moveDir, moveSpeed,
 *                radius7, radius10, warnLevel, lat, lng, land, points, forecasts } }
 *
 * 列表态：名称+编号 / 强度+气压 / 预警等级色标（white→#eee … red→#ef4444）
 * 详情态：当前位置 / 强度 / 气压风速 / 移向移速 / 风圈 / 登陆点 / 路径点与机构预报摘要
 * 空态：当前暂无活跃台风
 */

export interface TyphoonItem {
  tfid?: string
  name?: string
  enname?: string
  lat?: number | null
  lng?: number | null
  strong?: string
  power?: string
  pressure?: number | null
  speed?: number | null
  moveDir?: string
  moveSpeed?: number | null
  radius7?: string
  radius10?: string
  warnLevel?: string
}

export interface TyphoonPoint {
  time?: string
  lat?: number | null
  lng?: number | null
  strong?: string
  pressure?: number | null
}

export interface TyphoonLand {
  time?: string
  lat?: number | null
  lng?: number | null
}

export interface TyphoonForecast {
  agency?: string
  pointCount?: number
  summary?: string
}

export interface TyphoonDetail {
  tfid?: string
  name?: string
  enname?: string
  strong?: string
  power?: string
  pressure?: number | null
  speed?: number | null
  moveDir?: string
  moveSpeed?: number | null
  radius7?: string
  radius10?: string
  warnLevel?: string
  lat?: number | null
  lng?: number | null
  land?: TyphoonLand[]
  points?: TyphoonPoint[]
  forecasts?: TyphoonForecast[]
}

export interface TyphoonCardData {
  kind: 'typhoon'
  items: TyphoonItem[]
  detail?: TyphoonDetail
}

/** 预警等级色标（契约：white→#eee / blue→#3b82f6 / yellow→#eab308 / orange→#f97316 / red→#ef4444） */
const WARN_COLORS: Record<string, string> = {
  white: '#eee',
  blue: '#3b82f6',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
}

const WARN_CN: Record<string, string> = {
  white: '白色预警',
  blue: '蓝色预警',
  yellow: '黄色预警',
  orange: '橙色预警',
  red: '红色预警',
}

/** 经纬度 → "东经145.3°、北纬22.9°"（负值为西经/南纬） */
function fmtPos(lat?: number | null, lng?: number | null): string {
  const parts: string[] = []
  if (lng != null && !Number.isNaN(lng)) parts.push(`${lng >= 0 ? '东经' : '西经'}${Math.abs(lng).toFixed(1)}°`)
  if (lat != null && !Number.isNaN(lat)) parts.push(`${lat >= 0 ? '北纬' : '南纬'}${Math.abs(lat).toFixed(1)}°`)
  return parts.join('、')
}

/** 预警色点 + 中文名（无预警时不渲染） */
function WarnBadge({ level }: { level?: string }) {
  if (!level) return null
  const color = WARN_COLORS[level] || '#888'
  const label = WARN_CN[level] || level
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 11, color,
        background: `${color}1a`, border: `1px solid ${color}55`,
        borderRadius: 999, padding: '1px 8px', flexShrink: 0,
      }}
      title={label}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

function DetailBlock({ detail }: { detail: TyphoonDetail }) {
  const rows: Array<[string, string]> = []
  const pos = fmtPos(detail.lat, detail.lng)
  if (pos) rows.push(['当前位置', pos])
  const statusBits: string[] = []
  if (detail.strong) statusBits.push(detail.strong)
  if (detail.power) statusBits.push(`${detail.power}级`)
  if (detail.pressure != null) statusBits.push(`气压 ${detail.pressure} 百帕`)
  if (detail.speed != null) statusBits.push(`风速 ${detail.speed} 米/秒`)
  if (statusBits.length) rows.push(['强度', statusBits.join(' / ')])
  const moveBits: string[] = []
  if (detail.moveDir) moveBits.push(`向${detail.moveDir}移动`)
  if (detail.moveSpeed != null) moveBits.push(`${detail.moveSpeed} 公里/小时`)
  if (moveBits.length) rows.push(['移向移速', moveBits.join('，')])
  if (detail.radius7) rows.push(['7级风圈', `${detail.radius7} 公里`])
  if (detail.radius10) rows.push(['10级风圈', `${detail.radius10} 公里`])

  const land = detail.land || []
  rows.push(['登陆点', land.length === 0 ? '暂无' : land.map((l) => `${l.time} ${fmtPos(l.lat, l.lng)}`).join('；')])

  const points = detail.points || []
  if (points.length > 0) {
    const first = points[0]
    const last = points[points.length - 1]
    rows.push(['路径点', `共 ${points.length} 个（${first.time || ''} 至 ${last.time || ''}）`])
  }

  const forecasts = detail.forecasts || []
  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 8, paddingTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#dbe0ff' }}>
        {detail.name || '台风'}详情
        {detail.warnLevel ? <span style={{ marginLeft: 8 }}><WarnBadge level={detail.warnLevel} /></span> : null}
      </div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 8, padding: '2px 0', fontSize: 12.5, lineHeight: 1.5 }}>
          <span style={{ color: '#888', flexShrink: 0, width: 64 }}>{label}</span>
          <span style={{ color: '#ccc', wordBreak: 'break-all' }}>{value}</span>
        </div>
      ))}
      {forecasts.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>机构预报（{forecasts.length} 家）</div>
          {forecasts.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: '#aaa', padding: '1px 0' }}>
              {f.agency}：{f.summary || `共 ${f.pointCount || 0} 个预报点`}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TyphoonCard({ data, onClose }: { data: TyphoonCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.items)) return null
  const items = data.items
  return (
    <div className="scene-card typhoon-card" style={{ padding: '14px 16px', minWidth: 300, maxHeight: 420, overflow: 'auto', position: 'relative' }}>
      {onClose && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 6,
            border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.06)',
            color: 'var(--text-muted, #999)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, zIndex: 2,
          }}
          title="关闭"
        >✕</button>
      )}
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>🌀 台风</div>
      {items.length === 0 && (
        <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--text-muted, #888)', textAlign: 'center' }}>
          当前暂无活跃台风<br />
          <span style={{ fontSize: 11, opacity: 0.7 }}>台风季请留意官方预警信息</span>
        </div>
      )}
      {items.map((t) => {
        const warn = t.warnLevel
        const warnColor = warn ? (WARN_COLORS[warn] || '#888') : undefined
        const bits: string[] = []
        if (t.strong) bits.push(t.strong)
        if (t.power) bits.push(`${t.power}级`)
        if (t.pressure != null) bits.push(`${t.pressure} 百帕`)
        if (t.speed != null) bits.push(`${t.speed} 米/秒`)
        const pos = fmtPos(t.lat, t.lng)
        return (
          <div key={t.tfid || t.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: warnColor || '#eee' }}>
                {t.name}
                <span style={{ fontSize: 12, opacity: 0.5, marginLeft: 6 }}>{t.enname || ''}{t.tfid ? ` · ${t.tfid}` : ''}</span>
              </div>
              {bits.length > 0 && <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 2 }}>{bits.join(' / ')}</div>}
              {pos && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 1 }}>{pos}{t.moveDir ? `，向${t.moveDir}移动${t.moveSpeed != null ? `（${t.moveSpeed} 公里/小时）` : ''}` : ''}</div>}
            </div>
            {warn && (
              <div style={{ display: 'flex', alignItems: 'center' }}><WarnBadge level={warn} /></div>
            )}
          </div>
        )
      })}
      {data.detail ? <DetailBlock detail={data.detail} /> : null}
      <div style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>台风信息以官方发布为准。</div>
    </div>
  )
}
