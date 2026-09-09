/**
 * HoloOrbitText —— 全息环绕文字
 *
 * 环形布局：每 item 定位在圆周（CSS transform rotate + translate），
 * 容器整体匀速旋转（CSS animation）。
 * 文本保持正向可读——内层 span 以同速反向动画抵消容器旋转，
 * 使文本相对屏幕静止（counter-rotate by reverse animation）。
 * 纯 CSS 合成器实现，无 canvas。
 * 样式内联于组件实例（<style>），实例数少可接受；若实例增多可提取共享 css。
 */

import type { CSSProperties } from 'react'

// B7: tint 默认值常量化——避免每次渲染创建新数组（参照 HoloDissolve DEFAULT_TINT 做法）
const DEFAULT_TINT: [number, number, number] = [249, 115, 22]

interface HoloOrbitTextProps {
  /** 环绕文本项数组 */
  items: string[]
  /** 环绕半径（px），默认 90 */
  radius?: number
  /** 旋转周期（秒），默认 20 */
  speed?: number
  /** 辉光颜色 [r, g, b]，默认品牌橙 #f97316 */
  tint?: [number, number, number]
}

export function HoloOrbitText({
  items,
  radius = 90,
  speed = 20,
  tint = DEFAULT_TINT,
}: HoloOrbitTextProps) {
  const [r, g, b] = tint
  const diameter = radius * 2

  const containerStyle: CSSProperties = {
    '--holo-r': r,
    '--holo-g': g,
    '--holo-b': b,
    '--holo-orbit-radius': `${radius}px`,
    '--holo-orbit-speed': `${speed}s`,
  } as CSSProperties

  return (
    <>
      <style>{`
        .holo-orbit {
          position: relative;
          width: ${diameter}px;
          height: ${diameter}px;
          animation: holo-orbit-spin var(--holo-orbit-speed, 20s) linear infinite;
        }
        .holo-orbit-item {
          position: absolute;
          top: 50%;
          left: 50%;
          white-space: nowrap;
          color: rgb(var(--holo-r), var(--holo-g), var(--holo-b));
          font-family: 'Courier New', 'Consolas', monospace;
          font-size: 13px;
          text-shadow:
            0 0 6px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.6);
          user-select: none;
        }
        .holo-orbit-text {
          display: inline-block;
        }
        @keyframes holo-orbit-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div className="holo-orbit" style={containerStyle}>
        {items.map((item, i) => {
          const angle = (i / items.length) * 360
          return (
            <span
              key={i}
              className="holo-orbit-item"
              style={{
                transform: `rotate(${angle}deg) translateX(var(--holo-orbit-radius, ${radius}px)) rotate(-${angle}deg)`,
              }}
            >
              <span className="holo-orbit-text" style={{ animation: `holo-orbit-spin ${speed}s linear infinite reverse`, display: 'inline-block' }}>
                {item}
              </span>
            </span>
          )
        })}
      </div>
    </>
  )
}
