/**
 * Image Card — 图片卡片（加载渐入）
 *
 * 图片展示面板组件。
 */

import { useState, useEffect } from 'react'

export interface ImageData {
  src: string
  alt?: string
  caption?: string
  aspectRatio?: number
}

export function ImageCard({ data }: { data: ImageData }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const aspectRatio = data.aspectRatio || 16 / 9

  // src 变更 → 重置加载状态（避免新图沿用旧图 loaded 状态导致闪烁/残留）
  useEffect(() => {
    setLoaded(false)
    setFailed(false)
  }, [data.src])

  return (
    <div className="scene-image" style={{
      borderRadius: '12px',
      overflow: 'hidden',
      background: 'rgba(24,24,36,0.5)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ position: 'relative', paddingBottom: `${(1 / aspectRatio) * 100}%` }}>
        <img
          src={data.src}
          alt={data.alt || ''}
          className={loaded ? 'loaded' : ''}
          onLoad={() => setLoaded(true)}
          onError={() => { setFailed(true); console.warn('[ImageCard] 图片加载失败:', data.src) }}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 0.6s ease',
          }}
        />
        {!loaded && !failed && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted, #666)',
            fontSize: '12px',
          }}>
            加载中...
          </div>
        )}
        {failed && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted, #888)',
            fontSize: '12px',
          }}>
            ⚠ 图片加载失败
          </div>
        )}
      </div>
      {data.caption && (
        <div style={{
          padding: '8px 12px',
          fontSize: '14px',
          color: 'var(--text-muted, #aaa)',
        }}>
          {data.caption}
        </div>
      )}
    </div>
  )
}
