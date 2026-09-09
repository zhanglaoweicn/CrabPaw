/**
 * WeatherPopup 动态天气图标（SVG 动画）
 *
 * 借鉴参考项目（Agent 驱动 UI 原型）的视觉语言：天气状态用动态图形表达——
 * 太阳光芒 shimmer、云漂移、雨滴下落、雪花旋转、闪电闪烁、雾纹漂移、风线流动。
 * 替代此前的静态 emoji，提升天气面板的"贾维斯"科技感。
 * 所有动画 CSS 内联（无需外部样式表），prefers-reduced-motion 由父容器降级。
 */

/* ── 动画 keyframes（单例注入一次）── */
const WEATHER_KF = `
@keyframes wSunShimmer { 0%,100%{opacity:.5} 50%{opacity:1} }
@keyframes wSunRotate { from{transform:rotate(0)} to{transform:rotate(360deg)} }
@keyframes wCloudDrift { 0%,100%{transform:translateX(0)} 50%{transform:translateX(4px)} }
@keyframes wRainDrop { 0%{transform:translateY(-4px);opacity:0} 20%{opacity:.8} 100%{transform:translateY(26px);opacity:0} }
@keyframes wSnowFall { 0%{transform:translateY(-4px) rotate(0);opacity:0} 20%{opacity:.9} 100%{transform:translateY(26px) rotate(360deg);opacity:0} }
@keyframes wLightning { 0%,85%,100%{opacity:0} 88%,94%{opacity:1} 91%{opacity:.4} }
@keyframes wFogDrift { 0%{transform:translateX(-10px);opacity:0} 40%{opacity:.7} 100%{transform:translateX(10px);opacity:0} }
@keyframes wWindFlow { 0%{transform:translateX(-12px);opacity:0} 50%{opacity:.8} 100%{transform:translateX(12px);opacity:0} }
`
if (typeof document !== 'undefined') {
  try {
    if (!document.getElementById('crabpaw-weather-kf')) {
      const style = document.createElement('style')
      style.id = 'crabpaw-weather-kf'
      style.textContent = WEATHER_KF
      document.head.appendChild(style)
    }
  } catch (e) { console.warn('[WeatherPopup] 注入天气动画样式失败:', e) }
}

/* ── 基础 SVG 视图框 ── */
const VB = '0 0 64 64'

/** 太阳：核心渐变 + 光芒 shimmer */
export function SunIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => (
        <line
          key={deg}
          x1={32 + Math.cos((deg * Math.PI) / 180) * 17}
          y1={32 + Math.sin((deg * Math.PI) / 180) * 17}
          x2={32 + Math.cos((deg * Math.PI) / 180) * 24}
          y2={32 + Math.sin((deg * Math.PI) / 180) * 24}
          stroke="#fde68a"
          strokeWidth="2.5"
          strokeLinecap="round"
          style={{ animation: `wSunShimmer ${1.5 + i * 0.2}s ease-in-out infinite`, animationDelay: `${i * 0.15}s` }}
        />
      ))}
      <circle cx="32" cy="32" r="13" fill="#fbbf24" />
      <circle cx="32" cy="32" r="13" fill="url(#wSunGrad)" />
      <defs>
        <radialGradient id="wSunGrad" cx="35%" cy="30%">
          <stop offset="0%" stopColor="#fff176" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>
    </svg>
  )
}

/** 云（阴/多云基础）：漂移动画 + 双层渐变 */
export function CloudIcon({ size = 80, dark = false }: { size?: number; dark?: boolean }) {
  const main = dark ? '#64748b' : '#cbd5e1'
  const back = dark ? '#475569' : '#b0bec5'
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      <g style={{ animation: 'wCloudDrift 4s ease-in-out infinite' }}>
        <ellipse cx="38" cy="26" rx="14" ry="10" fill={back} opacity="0.7" />
        <path d="M14 36 Q14 24 26 24 Q28 16 38 18 Q48 18 48 28 Q54 28 54 36 Z" fill={main} />
      </g>
    </svg>
  )
}

/** 雨：云 + 雨滴下落 */
export function RainIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      <g style={{ animation: 'wCloudDrift 4s ease-in-out infinite' }}>
        <ellipse cx="38" cy="24" rx="14" ry="9" fill="#64748b" opacity="0.7" />
        <path d="M14 32 Q14 22 26 22 Q28 15 38 17 Q48 17 48 26 Q54 26 54 32 Z" fill="#94a3b8" />
      </g>
      {[20, 30, 40, 50].map((x, i) => (
        <line
          key={x}
          x1={x} y1={38} x2={x - 2} y2={58}
          stroke="#60a5fa"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ animation: `wRainDrop ${0.9 + i * 0.15}s linear infinite`, animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </svg>
  )
}

/** 雪：云 + 雪花旋转下落 */
export function SnowIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      <g style={{ animation: 'wCloudDrift 4.5s ease-in-out infinite' }}>
        <ellipse cx="38" cy="24" rx="14" ry="9" fill="#64748b" opacity="0.7" />
        <path d="M14 32 Q14 22 26 22 Q28 15 38 17 Q48 17 48 26 Q54 26 54 32 Z" fill="#cbd5e1" />
      </g>
      {[22, 32, 42, 50].map((x, i) => (
        <circle
          key={x}
          cx={x} cy={58}
          r="2"
          fill="#e2e8f0"
          style={{ animation: `wSnowFall ${1.6 + i * 0.25}s linear infinite`, animationDelay: `${i * 0.35}s` }}
        />
      ))}
    </svg>
  )
}

/** 雷暴：暗云 + 闪电闪烁 */
export function StormIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      <ellipse cx="38" cy="24" rx="14" ry="9" fill="#334155" opacity="0.8" />
      <path d="M14 32 Q14 22 26 22 Q28 15 38 17 Q48 17 48 26 Q54 26 54 32 Z" fill="#475569" />
      <path
        d="M34 40 L28 52 L34 50 L30 60 L42 46 L36 44 L42 40 Z"
        fill="#fbbf24"
        style={{ animation: 'wLightning 2.4s ease-in-out infinite' }}
      />
    </svg>
  )
}

/** 雾：雾纹漂移 */
export function FogIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      {[22, 32, 42].map((y, i) => (
        <rect
          key={y}
          x={12} y={y} width={40} height={3}
          rx={1.5}
          fill="#94a3b8"
          opacity="0.7"
          style={{ animation: `wFogDrift ${3 + i}s ease-in-out infinite`, animationDelay: `${i * 0.8}s` }}
        />
      ))}
      <ellipse cx="32" cy="18" rx="16" ry="5" fill="#cbd5e1" opacity="0.5" style={{ animation: 'wCloudDrift 5s ease-in-out infinite' }} />
    </svg>
  )
}

/** 风：风线流动 */
export function WindIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      {[
        { y: 26, w: 36, d: 0 },
        { y: 36, w: 26, d: 0.5 },
        { y: 46, w: 32, d: 1 },
      ].map((l, i) => (
        <path
          key={i}
          d={`M${12 + l.d * 6} ${l.y} q${l.w / 4} ${-4} ${l.w / 2} 0 q${l.w / 4} ${4} ${l.w / 2} 0`}
          stroke="#7dd3fc"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          style={{ animation: `wWindFlow ${2 + i * 0.6}s ease-in-out infinite`, animationDelay: `${i * 0.4}s` }}
        />
      ))}
    </svg>
  )
}

/** 温度计（未知天气兜底） */
export function ThermometerIcon({ size = 80 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox={VB} fill="none">
      <rect x="28" y="10" width="8" height="34" rx="4" fill="#e2e8f0" />
      <circle cx="32" cy="48" r="10" fill="#f87171" />
      <rect x="29.5" y="36" width="5" height="14" rx="2.5" fill="#fff" opacity="0.6" />
    </svg>
  )
}

/** 按天气条件选择图标 */
export function WeatherIcon({ condition = '', size = 80 }: { condition?: string; size?: number }) {
  const c = condition.toLowerCase()
  if (/晴|sun|clear/.test(c)) return <SunIcon size={size} />
  if (/雷|thunder|storm/.test(c)) return <StormIcon size={size} />
  if (/雨|rain/.test(c)) return <RainIcon size={size} />
  if (/雪|snow/.test(c)) return <SnowIcon size={size} />
  if (/雾|fog|霾|haze/.test(c)) return <FogIcon size={size} />
  if (/风|wind/.test(c)) return <WindIcon size={size} />
  if (/云|cloud|阴|overcast/.test(c)) return <CloudIcon size={size} dark={/阴|overcast/.test(c)} />
  return <ThermometerIcon size={size} />
}
