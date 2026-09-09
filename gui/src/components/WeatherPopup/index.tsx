/**
 * WeatherPopup — 天气侧滑面板（SideSheet 基座）
 *
 * 数据源：Scene surface 'weather-panel'（AI 调用 ShowWeather → tool 创建 surface → 本组件自动出现）。
 * 用户点击关闭 / 语音关闭 / Esc → 后端删除 surface → 本组件收起（常驻挂载，动画由 SideSheet 驱动）。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { apiPost } from '../../lib/api'
import { useSceneClient } from '../../lib/scene-client'
import { WeatherIcon } from './icons'
import { WeatherScene } from './scene'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { SideSheet } from '../SideSheet'

interface ForecastDay {
  day: string
  high: number | string
  low: number | string
  condition: string
}

interface WeatherData {
  city?: string
  temp?: string | number
  condition?: string
  humidity?: string | number
  wind?: string
  forecast?: ForecastDay[]
}

export function WeatherPopup() {
  const surface = useSceneClient('weather-panel')
  const [selfDismissed, setSelfDismissed] = useState(false)
  // 2026-08-15: 本次显示内的拖动偏移——不持久化, 每次打开由 SideSheet centerOnOpen 重置居中
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null)
  // 2026-08-14 竞态修复: 关闭(含互斥顶掉)时记录 surface 内容指纹——
  // 防止 scene 双通道(WS+SSE)事件乱序期间 data null→恢复 的抖动使面板复活
  // (复活会再次触发互斥, 与用户刚打开的另一面板乒乓互顶)。
  // remove 成功落库后指纹清空 → 之后任何 data 恢复都视为新推送可正常弹出。
  const dismissedHashRef = useRef<string | null>(null)

  const data: WeatherData | null = surface?.data || null
  const isVisible = !!data && !selfDismissed
  const isCompact = !data?.forecast || (data?.forecast?.length || 0) <= 3

  const stableDataHash = useCallback((d: WeatherData): string => {
    const f = (d.forecast || []).map(x => `${x.day}|${x.high}|${x.low}|${x.condition}`).join(';')
    return `${d.city || ''}|${d.temp ?? ''}|${d.condition || ''}|${d.humidity ?? ''}|${d.wind || ''}|${f}`
  }, [])

  // ── 语音开关接口（registerCommandHost 自动镜像 window.__weatherPanel）──
  const handleClose = useCallback(() => {
    setSelfDismissed(true)
    dismissedHashRef.current = data ? stableDataHash(data) : ''
    apiPost('/api/scene/remove', { id: 'weather-panel' })
      .then(() => { dismissedHashRef.current = null })  // 真删成功 → 后续 data 恢复视为新推送
      .catch(e => console.warn('[WeatherPopup] 移除 surface 失败:', e))
    apiPost('/api/scene/panel-state', { panel: 'weather', state: 'closed' }).catch(e => console.warn('[WeatherPopup] 写入面板状态失败:', e))
  }, [data, stableDataHash])

  useEffect(() => {
    const api = {
      setVisible: (v: boolean): boolean => {
        if (v) {
          if (!data) return false
          dismissedHashRef.current = null  // 用户显式打开 → 清指纹守卫(意图优先)
          setSelfDismissed(false)
          return true
        }
        handleClose()
        return true
      },
      isVisible: () => isVisible,
    }
    return registerCommandHost('weatherPanel', api)
  }, [data, isVisible, handleClose])

  // selfDismissed 复活守卫（2026-08-14 重写竞态逻辑）:
  // - data=null(通道抖动/删除中) → 保持 dismissed, 不再立即重置——
  //   旧实现"null 即重置"在 WS/SSE 双通道乱序时被同内容恢复复活(实测出现过)
  // - data 恢复且与关闭时指纹相同(抖动回放) → 保持关闭
  // - data 恢复且指纹不同(AI 新一轮推送) 或 remove 已成功落库(指纹清空) → 正常弹出
  useEffect(() => {
    if (!selfDismissed) return
    if (!data) return
    if (dismissedHashRef.current !== null && stableDataHash(data) === dismissedHashRef.current) return
    setSelfDismissed(false)
  }, [data, selfDismissed, stableDataHash])

  // 2026-08-15: 关闭时清 dragOffset——重开不再闪现旧拖位(本次显示内偏移不持久化)
  useEffect(() => {
    if (!isVisible) setDragOffset(null)
  }, [isVisible])

  // 2026-08-14: 尺寸自适应——宽度由数据量决定(用户反馈"目前太大了")。
  // 仅当前天气(无预报) → 320px 窄卡; ≤3 天 → 360px; 4-5 天 → 420px(5 列预报需要)。
  // 高度走 SideSheet fitContent 浮动模式(内容高度, 不再全屏高空洞)。
  const dayCount = data?.forecast?.length || 0
  const sheetWidth = dayCount >= 4 ? 'min(92vw, 420px)' : dayCount >= 1 ? 'min(90vw, 360px)' : 'min(80vw, 320px)'

  return (
    <SideSheet
      open={isVisible}
      onClose={handleClose}
      name="weather"
      width={sheetWidth}
      fitContent
      draggable
      centerOnOpen
      dragOffset={dragOffset ?? undefined}
      onDragOffsetChange={setDragOffset}
      autoCloseMs={5000}
    >
      {data && (
        <>
          {/* ═══ 顶部标题栏 ═══ */}
          <header className="sheet-boot" style={{
            padding: '8px 20px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(10,14,23,0.95)',
            backdropFilter: 'blur(12px)',
            ['--boot-delay' as any]: '40ms',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: '#59a8ff' }} aria-hidden="true">⛅</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #eee)' }}>天气面板</span>
            </div>
            <button
              data-close-btn
              onClick={handleClose}
              aria-label="关闭天气面板"
              style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(255,255,255,0.05)',
                border: 'none', color: '#888',
                fontSize: 16, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s',
              }}
            >×</button>
          </header>

          {/* ═══ 主体 ═══ */}
          <div className="sheet-boot" style={{
            flex: 1, minHeight: 0, overflowY: 'auto',
            padding: '20px 24px',
            position: 'relative',  // 2026-08-15: 天气氛围层定位基准
            ['--boot-delay' as any]: '130ms',
          }}>
            <WeatherScene condition={data.condition} />
            <div style={{ position: 'relative', zIndex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '12px' }}>
              <WeatherIcon condition={data.condition} size={56} />
              <div>
                <div style={{ fontSize: '42px', fontWeight: 300, color: 'var(--text-primary, #eee)', lineHeight: 1 }}>
                  {data.temp}<span style={{ fontSize: '20px', color: 'var(--text-secondary, #888)' }}>°</span>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--text-muted, #999)', marginTop: '2px' }}>
                  {data.city || '-'} · {data.condition || '-'}
                </div>
              </div>
            </div>

            {(data.humidity || data.wind) && (
              <div style={{ display: 'flex', gap: '20px', fontSize: '12px', color: 'var(--text-secondary, #888)', marginBottom: '10px' }}>
                {data.humidity && <span>💧 湿度 {data.humidity}</span>}
                {data.wind && <span>💨 {data.wind}</span>}
              </div>
            )}

            {data.forecast && data.forecast.length > 0 && (
              <div style={{
                display: 'flex', gap: isCompact ? '8px' : '6px',
                flexWrap: isCompact ? 'nowrap' : 'wrap',
                paddingTop: '12px', borderTop: '1px solid var(--weather-divider, rgba(255,255,255,0.06))',
              }}>
                {data.forecast.slice(0, 5).map((d, i) => (
                  <div key={i} style={{
                    flex: '1', textAlign: 'center', fontSize: '12px', color: 'var(--text-secondary, #aaa)',
                    minWidth: isCompact ? 'auto' : '52px',
                  }}>
                    <div style={{ marginBottom: '4px' }}>{i === 0 ? '今天' : d.day}</div>
                    <div style={{ lineHeight: 1.2, display: 'flex', justifyContent: 'center' }}><WeatherIcon condition={d.condition} size={26} /></div>
                    <div style={{ color: 'var(--text-primary, #ddd)', fontSize: '13px', marginTop: '4px' }}>{d.high}°</div>
                    <div style={{ fontSize: '11px' }}>{d.low}°</div>
                  </div>
                ))}
              </div>
            )}
              </div>
            </div>
        </>
      )}
    </SideSheet>
  )
}

export default WeatherPopup
