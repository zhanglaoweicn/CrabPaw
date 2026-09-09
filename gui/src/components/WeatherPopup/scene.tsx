/**
 * WeatherScene — 天气卡片背景氛围层（CSS 动画，纯展示）
 *
 * 需求（2026-08-15）：天气卡片加场景级动效——下雨/乌云/台风/太阳等。
 * 实现：CSS keyframes 单例注入（与 icons.tsx 同风格），条件匹配复用
 * WeatherIcon 同款正则语义。场景层绝对定位铺满标题栏下方内容区，
 * z 序在数据之下（内容容器 position:relative 盖在其上），pointer-events:none
 * 不干扰拖动/点击。面板关闭态动画暂停（animation-play-state:paused）不空耗 CPU；
 * prefers-reduced-motion 下整个氛围层隐藏。
 */
import type { ReactNode } from 'react'

/* ── 场景动画样式（keyframes + 容器规则，单例注入一次）── */
const SCENE_CSS = `
.wx-scene { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.wx-scene * { pointer-events: none; animation-fill-mode: both !important; }
@keyframes wsSunPulse { 0%,100% { opacity: 0.25; } 50% { opacity: 0.55; } }
@keyframes wsCloudDrift { from { transform: translateX(225%); } to { transform: translateX(-130%); } }
@keyframes wsRainFall { 0% { transform: rotate(12deg) translateY(-16px); opacity: 0; } 12% { opacity: 0.75; } 85% { opacity: 0.75; } 100% { transform: rotate(12deg) translateY(150px); opacity: 0; } }
@keyframes wsSnowFall { 0% { transform: translateY(-12px) translateX(0); opacity: 0; } 12% { opacity: 0.9; } 100% { transform: translateY(140px) translateX(14px); opacity: 0; } }
@keyframes wsTyphoonSpin { from { transform: translate(-50%,-50%) rotate(0deg); } to { transform: translate(-50%,-50%) rotate(360deg); } }
@keyframes wsWindStreak { 0% { transform: translateX(-50%); opacity: 0; } 15% { opacity: 0.6; } 85% { opacity: 0.6; } 100% { transform: translateX(150%); opacity: 0; } }
@keyframes wsFogDrift { 0% { transform: translateX(-30%); opacity: 0; } 30% { opacity: 0.55; } 100% { transform: translateX(130%); opacity: 0; } }
@keyframes wsFlash { 0%, 88%, 100% { opacity: 0; } 92% { opacity: 0.45; } 96% { opacity: 0.1; } }
.side-sheet[data-open='false'] .wx-scene * { animation-play-state: paused !important; }
@media (prefers-reduced-motion: reduce) { .wx-scene { display: none; } }
`
if (typeof document !== 'undefined') {
  try {
    if (!document.getElementById('crabpaw-weather-scene-kf')) {
      const style = document.createElement('style')
      style.id = 'crabpaw-weather-scene-kf'
      style.textContent = SCENE_CSS
      document.head.appendChild(style)
    }
  } catch (e) { console.warn('[WeatherScene] 注入场景动画样式失败:', e) }
}

const PARTICLES = (n: number) => Array.from({ length: n }, (_, i) => i)

function SunScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      {/* 右上角光芒（光锥脉动） */}
      <div style={{
        position: 'absolute', top: -120, right: -120, width: 260, height: 260, borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(255,200,80,0.28) 0%, rgba(255,180,60,0.08) 45%, transparent 70%)',
        animation: 'wsSunPulse 3.5s ease-in-out infinite',
      }} />
      {/* 漂浮光斑 */}
      {PARTICLES(8).map(i => (
        <div key={i} style={{
          position: 'absolute',
          left: `${12 + ((i * 37) % 76)}%`,
          top: `${10 + ((i * 53) % 70)}%`,
          width: 3, height: 3, borderRadius: '50%',
          background: 'rgba(255,220,140,0.6)',
          animation: `wsSunPulse ${2.2 + (i % 4) * 0.5}s ease-in-out infinite`,
          animationDelay: `${i * 0.35}s`,
        }} />
      ))}
    </div>
  )
}

function CloudScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      {/* 2-3 层乌云从右向左漂移（负 delay 使打开时已在途中） */}
      {PARTICLES(3).map(i => (
        <div key={i} style={{
          position: 'absolute',
          left: i % 2 === 0 ? '-35%' : '-55%',
          top: `${12 + i * 26}%`,
          width: '70%', height: 40 + i * 8,
          borderRadius: '50%',
          background: 'rgba(71,85,105,0.5)',
          filter: 'blur(14px)',
          animation: `wsCloudDrift ${18 + i * 7}s linear infinite`,
          animationDelay: `${-i * 9}s`,
        }} />
      ))}
    </div>
  )
}

function RainDrops({ count = 20 }: { count?: number }) {
  return (
    <>
      {PARTICLES(count).map(i => (
        <div key={i} style={{
          position: 'absolute',
          left: `${(i * 47) % 100}%`,
          top: 0,
          width: 1.5, height: 16,
          background: 'linear-gradient(to bottom, transparent, rgba(96,165,250,0.8))',
          animation: `wsRainFall ${0.9 + (i % 5) * 0.18}s linear infinite`,
          animationDelay: `${(i % 7) * 0.13}s`,
        }} />
      ))}
    </>
  )
}

function CloudBand({ top, height, color }: { top: string; height: string; color: string }) {
  return <div style={{ position: 'absolute', top, left: 0, right: 0, height, background: color, filter: 'blur(12px)' }} />
}

function RainScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      <CloudBand top="-12%" height="26%" color="rgba(51,65,85,0.45)" />
      <RainDrops />
    </div>
  )
}

function StormScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      <CloudBand top="-14%" height="34%" color="rgba(30,41,59,0.6)" />
      <RainDrops count={14} />
      {/* 周期性闪电闪白 */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(226,232,240,0.5)', animation: 'wsFlash 3.8s linear infinite' }} />
    </div>
  )
}

function SnowScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      {PARTICLES(14).map(i => (
        <div key={i} style={{
          position: 'absolute',
          left: `${(i * 53) % 100}%`,
          top: 0,
          width: 4, height: 4, borderRadius: '50%',
          background: 'rgba(226,232,240,0.75)',
          animation: `wsSnowFall ${2.4 + (i % 6) * 0.4}s linear infinite`,
          animationDelay: `${(i % 9) * 0.32}s`,
        }} />
      ))}
    </div>
  )
}

function TyphoonScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      {/* 旋转旋涡：同心环 + 螺旋臂，中心弱化避免遮挡温度 */}
      <div style={{
        position: 'absolute', left: '50%', top: '50%',
        width: 250, height: 250,
        animation: 'wsTyphoonSpin 7s linear infinite',
      }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid rgba(125,211,252,0.22)' }} />
        <div style={{ position: 'absolute', inset: 30, borderRadius: '50%', border: '2px dashed rgba(125,211,252,0.28)' }} />
        <div style={{ position: 'absolute', inset: 60, borderRadius: '50%', border: '1px solid rgba(125,211,252,0.18)' }} />
        <div style={{ position: 'absolute', left: '50%', top: 0, width: 26, height: 125, background: 'linear-gradient(to bottom, rgba(125,211,252,0.45), transparent)', borderRadius: 20, transformOrigin: '50% 100%', transform: 'translateX(-50%)' }} />
        <div style={{ position: 'absolute', left: '50%', bottom: 0, width: 20, height: 95, background: 'linear-gradient(to top, rgba(125,211,252,0.4), transparent)', borderRadius: 20, transformOrigin: '50% 0%', transform: 'translateX(-50%) rotate(120deg)' }} />
      </div>
    </div>
  )
}

function WindScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      {PARTICLES(4).map(i => (
        <div key={i} style={{
          position: 'absolute', left: 0,
          top: `${18 + i * 20}%`,
          width: '48%', height: 2, borderRadius: 2,
          background: 'linear-gradient(to right, transparent, rgba(125,211,252,0.55), transparent)',
          animation: `wsWindStreak ${1.6 + i * 0.5}s linear infinite`,
          animationDelay: `${i * 0.35}s`,
        }} />
      ))}
    </div>
  )
}

function FogScene() {
  return (
    <div className="wx-scene" aria-hidden="true">
      {PARTICLES(3).map(i => (
        <div key={i} style={{
          position: 'absolute', left: 0,
          top: `${22 + i * 24}%`,
          width: '70%', height: 22, borderRadius: 20,
          background: 'rgba(148,163,184,0.3)',
          filter: 'blur(8px)',
          animation: `wsFogDrift ${7 + i * 3}s ease-in-out infinite`,
          animationDelay: `${-i * 4}s`,
        }} />
      ))}
    </div>
  )
}

/** 按天气条件选择氛围场景（匹配语义与 WeatherIcon 一致；无匹配返回 null） */
export function WeatherScene({ condition = '' }: { condition?: string }): ReactNode | null {
  const c = condition.toLowerCase()
  if (/晴|sun|clear/.test(c)) return <SunScene />
  if (/台风|typhoon/.test(c)) return <TyphoonScene />
  if (/雷|thunder|storm/.test(c)) return <StormScene />
  if (/雨|rain/.test(c)) return <RainScene />
  if (/雪|snow/.test(c)) return <SnowScene />
  if (/雾|fog|霾|haze/.test(c)) return <FogScene />
  if (/风|wind/.test(c)) return <WindScene />
  if (/云|cloud|阴|overcast/.test(c)) return <CloudScene />
  return null
}

export default WeatherScene
