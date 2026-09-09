/**
 * HoloNumber —— 全息镂空大数字
 *
 * -webkit-text-stroke 镂空描边 + 透明填充 + text-shadow 辉光。
 * 纯 CSS 合成器实现，无 canvas。
 * 数字尺寸与辉光颜色通过 CSS 变量注入。
 * 样式内联于组件实例（<style>），实例数少可接受；若实例增多可提取共享 css。
 */

import type { CSSProperties } from 'react'

// B7: tint 默认值常量化——避免每次渲染创建新数组（参照 HoloDissolve DEFAULT_TINT 做法）
const DEFAULT_TINT: [number, number, number] = [249, 115, 22]

interface HoloNumberProps {
  /** 数值（数字或字符串） */
  value: number | string
  /** 单位文本（可选，如 "°"、"%"、"ms"） */
  unit?: string
  /** 数字字号（px），默认 120 */
  size?: number
  /** 辉光颜色 [r, g, b]，默认品牌橙 #f97316 */
  tint?: [number, number, number]
}

export function HoloNumber({ value, unit, size = 120, tint = DEFAULT_TINT }: HoloNumberProps) {
  const [r, g, b] = tint

  const containerStyle: CSSProperties = {
    '--holo-r': r,
    '--holo-g': g,
    '--holo-b': b,
    '--holo-size': `${size}px`,
  } as CSSProperties

  return (
    <>
      <style>{`
        .holo-number {
          display: inline-flex;
          align-items: baseline;
          font-family: 'Courier New', 'Consolas', monospace;
          font-weight: 700;
          line-height: 1;
        }
        .holo-number-value {
          font-size: var(--holo-size, 120px);
          color: transparent;
          -webkit-text-stroke: 2px rgb(var(--holo-r), var(--holo-g), var(--holo-b));
          -webkit-text-fill-color: transparent;
          text-shadow:
            0 0 8px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.9),
            0 0 20px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.5),
            0 0 40px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.3);
          user-select: none;
        }
        .holo-number-unit {
          font-size: calc(var(--holo-size, 120px) * 0.35);
          color: rgb(var(--holo-r), var(--holo-g), var(--holo-b));
          margin-left: 0.12em;
          opacity: 0.8;
          user-select: none;
        }
      `}</style>
      <span className="holo-number" style={containerStyle}>
        <span className="holo-number-value">{value}</span>
        {unit && <span className="holo-number-unit">{unit}</span>}
      </span>
    </>
  )
}
