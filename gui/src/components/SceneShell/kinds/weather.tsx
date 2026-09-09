/**
 * Weather Card —— 天气全息面板组件（P7 Task 10 升级）
 *
 * 使用 HoloPanel/HoloNumber/HoloOrbitText 全息组件重构渲染。
 * - HoloNumber 渲染温度镂空数字（主视觉）
 * - HoloOrbitText 环绕湿度/风速（动态环绕）
 * - HoloPanel 网格面板基座（全息网格背景 + 辉光边框）
 * - tint 由天气码映射：晴=暖金、雨=冷蓝、阴=灰蓝
 * - 数据缺字段时保持原有降级行为（不崩溃）
 *
 * 支持 compact(<=3天) / week(grid) 两种变体
 * 内置 glyphFor() 天气图标映射
 */


export interface WeatherData {
  city: string
  temp: string | number
  condition: string
  humidity?: string | number
  wind?: string
  icon?: string
  forecast?: Array<{
    day: string
    high: number | string
    low: number | string
    condition: string
  }>
}

/** 天气条件 -> Emoji 图标 */
function glyphFor(cond = ''): string {
  const c = cond.toLowerCase()
  if (c.includes('晴') || c.includes('sun') || c.includes('clear')) return '☀️'
  if (c.includes('多云') || c.includes('cloud') || c.includes('阴') || c.includes('overcast')) return '☁️'
  if (c.includes('雨') || c.includes('rain') || c.includes('drizzle') || c.includes('shower')) return '🌧️'
  if (c.includes('雪') || c.includes('snow') || c.includes('sleet')) return '❄️'
  if (c.includes('雾') || c.includes('fog') || c.includes('mist') || c.includes('霾') || c.includes('haze')) return '🌫️'
  if (c.includes('雷') || c.includes('thunder') || c.includes('storm')) return '⛈️'
  if (c.includes('风') || c.includes('wind')) return '💨'
  if (c.includes('月') || c.includes('night')) return '🌙'
  return '🌡️'
}

/** 天气条件 -> 全息色调 [r, g, b]：晴=暖金、雨=冷蓝、阴/多云=灰蓝、默认品牌橙 */
export function tintForWeather(cond = ''): [number, number, number] {
  const c = cond.toLowerCase()
  if (c.includes('晴') || c.includes('sun') || c.includes('clear')) return [255, 180, 60]
  if (c.includes('雨') || c.includes('rain') || c.includes('drizzle') || c.includes('shower')) return [80, 140, 255]
  if (c.includes('阴') || c.includes('多云') || c.includes('cloud') || c.includes('overcast')) return [120, 140, 170]
  if (c.includes('雪') || c.includes('snow')) return [180, 210, 240]
  if (c.includes('雷') || c.includes('thunder') || c.includes('storm')) return [160, 120, 220]
  // 默认品牌橙（雾、风、月、未知）
  return [249, 115, 22]
}

import { X } from 'lucide-react'
import { HoloPanel } from '../../HoloPanel/HoloPanel'
import { HoloNumber } from '../../HoloPanel/HoloNumber'
import { HoloOrbitText } from '../../HoloPanel/HoloOrbitText'

export function WeatherCard({ data, onClose }: { data: WeatherData; onClose?: () => void }) {
  const isCompact = !data.forecast || data.forecast.length <= 3
  const tint = tintForWeather(data.condition)

  // 构造环绕文本项（湿度 + 风速，缺字段时降级）
  const orbitItems: string[] = []
  if (data.humidity !== undefined && data.humidity !== null && data.humidity !== '') {
    orbitItems.push(`湿度 ${data.humidity}${typeof data.humidity === 'number' || /^\d+$/.test(String(data.humidity)) ? '%' : ''}`)
  }
  if (data.wind && data.wind !== '') {
    orbitItems.push(`风速 ${data.wind}`)
  }

  return (
    <div className={`scene-weather ${isCompact ? 'compact' : 'week'}`}>
      <HoloPanel tint={tint}>
        <div style={{ padding: '14px 18px', position: 'relative', minWidth: '200px' }}>
          {/* 关闭按钮 */}
          {onClose && (
            <button
              onClick={(e) => { e.stopPropagation(); onClose() }}
              style={{
                position: 'absolute', top: '4px', right: '4px',
                width: '24px', height: '24px', borderRadius: '6px',
                border: 'none', cursor: 'pointer',
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text-muted, #999)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '12px',
                zIndex: 2,
              }}
              title="关闭天气面板"
            >
              <X className="w-3 h-3" />
            </button>
          )}

          {/* 主信息行：城市 + 天气图标 + 状态文字 */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px',
            color: `rgb(${tint[0]},${tint[1]},${tint[2]})`,
            fontSize: '14px', fontWeight: 500, letterSpacing: '0.04em',
          }}>
            <span style={{ fontSize: '20px' }}>{glyphFor(data.condition)}</span>
            <span>{data.city}</span>
            <span style={{ opacity: 0.7 }}>{data.condition}</span>
          </div>

          {/* 温度镂空数字（主视觉）+ 环绕湿度/风速 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: '8px', marginBottom: orbitItems.length > 0 ? '6px' : '0',
          }}>
            <HoloNumber
              value={typeof data.temp === 'number' ? data.temp : String(data.temp).replace(/[°℃]\s*$/, '')}
              unit="°"
              size={80}
              tint={tint}
            />
            {orbitItems.length > 0 && (
              <HoloOrbitText
                items={orbitItems}
                radius={60}
                speed={18}
                tint={tint}
              />
            )}
          </div>

          {/* 预报（保留原有降级逻辑） */}
          {data.forecast && data.forecast.length > 0 && (
            <div style={{
              display: 'flex',
              gap: isCompact ? '8px' : '6px',
              flexWrap: isCompact ? 'nowrap' : 'wrap',
              marginTop: '6px',
              paddingTop: '10px',
              borderTop: `1px solid rgba(${tint[0]},${tint[1]},${tint[2]},0.12)`,
            }}>
              {data.forecast.slice(0, isCompact ? 3 : 7).map((d, i) => (
                <div key={i} style={{
                  flex: '1',
                  textAlign: 'center',
                  fontSize: '14px',
                  color: 'var(--text-muted, #aaa)',
                  minWidth: isCompact ? 'auto' : '48px',
                }}>
                  <div style={{ marginBottom: '2px' }}>{i === 0 ? '今天' : d.day}</div>
                  <div style={{ fontSize: '18px', lineHeight: 1.2 }}>{glyphFor(d.condition)}</div>
                  <div style={{ color: 'var(--text-primary, #ddd)', fontSize: '14px', marginTop: '2px' }}>
                    {d.high}°
                  </div>
                  <div style={{ fontSize: '14px' }}>{d.low}°</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </HoloPanel>
    </div>
  )
}
