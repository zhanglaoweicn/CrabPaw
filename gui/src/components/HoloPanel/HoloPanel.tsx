/**
 * HoloPanel —— 全息网格面板基座
 *
 * 发光网格线背景（linear-gradient 交叉线）+ border + box-shadow 辉光。
 * 纯 CSS 合成器实现，无 canvas。
 * tint 颜色通过 CSS 变量 --holo-r/--holo-g/--holo-b 注入。
 * 样式内联于组件实例（<style>），实例数少可接受；若实例增多可提取共享 css。
 */

import type { CSSProperties, ReactNode } from 'react'

// B7: tint 默认值常量化——避免每次渲染创建新数组（参照 HoloDissolve DEFAULT_TINT 做法）
const DEFAULT_TINT: [number, number, number] = [249, 115, 22]

interface HoloPanelProps {
  /** 辉光颜色 [r, g, b]，默认品牌橙 #f97316 */
  tint?: [number, number, number]
  children?: ReactNode
  /** 额外 CSS class，与 holo-panel 合并 */
  className?: string
}

export function HoloPanel({ tint = DEFAULT_TINT, children, className }: HoloPanelProps) {
  const [r, g, b] = tint

  const containerStyle: CSSProperties = {
    '--holo-r': r,
    '--holo-g': g,
    '--holo-b': b,
  } as CSSProperties

  return (
    <>
      <style>{`
        .holo-panel {
          position: relative;
          border: 1px solid rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.4);
          border-radius: 8px;
          background-color: var(--bg-secondary, #111115);
          box-shadow:
            0 0 15px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.15),
            0 0 30px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.08),
            inset 0 0 30px rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.05);
          overflow: hidden;
        }
        .holo-panel::before {
          content: '';
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(var(--holo-r), var(--holo-g), var(--holo-b), 0.06) 1px, transparent 1px);
          background-size: 40px 40px;
          pointer-events: none;
          z-index: 0;
        }
        .holo-panel > * {
          position: relative;
          z-index: 1;
        }
      `}</style>
      <div
        className={`holo-panel${className ? ` ${className}` : ''}`}
        style={containerStyle}
      >
        {children}
      </div>
    </>
  )
}
