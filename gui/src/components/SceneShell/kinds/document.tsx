/**
 * DocumentCard — 文档卡片组件（kind: document）
 *
 * 全息 A4 纸页从底部"抽拉"堆叠：每页 CSS transform translateY 入场 +
 * 文字快速浮现，间隔 ~300ms，CSS animation-delay 控制交错。
 *
 * 同时导出 PaperStack 内部组件，供 contract kind 复用纸页渲染。
 */

import { useEffect } from 'react'

/* ─── 数据接口 ─── */
export interface DocumentData {
  title: string
  pages: Array<{ text: string }>
  pageCount?: number
}

/* ─── 模块级 keyframes 注入（仅一次） ─── */
let keyframesInjected = false
export function ensureKeyframes() {
  if (keyframesInjected || typeof document === 'undefined') return
  keyframesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes doc-page-slide-up {
      from { opacity: 0; transform: translateY(28px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes doc-text-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes doc-seal-stamp {
      0%   { opacity: 0; transform: rotate(-15deg) scale(1.6); }
      60%  { opacity: 0.9; transform: rotate(2deg) scale(0.95); }
      80%  { opacity: 0.85; transform: rotate(-1deg) scale(1.02); }
      100% { opacity: 0.8; transform: rotate(0deg) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .doc-page, .doc-page-text, .doc-seal {
        animation: none !important;
      }
    }
  `
  document.head.appendChild(style)
}

/* ─── PaperStack — 共享纸页堆叠组件（contract 复用） ─── */
export function PaperStack({
  pages,
  pageCount,
  startDelay = 0,
}: {
  pages: Array<{ text: string }>
  pageCount?: number
  /** 起始延迟 ms，contract 在信息栏动画后开始 */
  startDelay?: number
}) {
  const effectiveCount = Math.min(pageCount ?? pages.length, 12)
  const displayPages = pages.slice(0, Math.max(1, effectiveCount))

  useEffect(() => { ensureKeyframes() }, [])

  if (displayPages.length === 0) {
    return (
      <div style={{
        padding: '16px', color: 'var(--text-muted, #888)', fontSize: 11,
        textAlign: 'center', fontStyle: 'italic',
      }}>
        暂无页面内容
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {displayPages.map((page, i) => (
        <div
          key={i}
          className="doc-page"
          style={{
            /* A4 纸页模拟 */
            background: 'linear-gradient(135deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03))',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '6px',
            padding: '14px 16px',
            boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            /* 交错入场动画 */
            opacity: 0,
            animation: `doc-page-slide-up 420ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) both`,
            animationDelay: `${startDelay + i * 300}ms`,
            /* 纸页堆叠立体感 */
            transform: `translateY(${(displayPages.length - 1 - i) * 1}px)`,
          }}
        >
          {/* 页眉：页码标记 */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '8px', paddingBottom: '6px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}>
            <span style={{ fontSize: 9, color: 'var(--text-muted, #666)', fontWeight: 500 }}>
              第 {i + 1} 页 / 共 {displayPages.length} 页
            </span>
            <div style={{ display: 'flex', gap: '2px' }}>
              {[0, 1, 2, 3].map((dot) => (
                <span key={dot} style={{
                  width: '3px', height: '3px', borderRadius: '50%',
                  background: dot % 2 === 0 ? 'rgba(255,255,255,0.12)' : 'transparent',
                }} />
              ))}
            </div>
          </div>
          {/* 正文 */}
          <div
            className="doc-page-text"
            style={{
              fontSize: '14px', lineHeight: 1.7, color: 'var(--text-secondary, #ccc)',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              opacity: 0,
              animation: `doc-text-fade-in 320ms ease both`,
              animationDelay: `${startDelay + i * 300 + 180}ms`,
            }}
          >
            {page.text}
          </div>
        </div>
      ))}
      {/* 超出页数提示 */}
      {pages.length > effectiveCount && (
        <div style={{ fontSize: 9, color: 'var(--text-muted, #666)', textAlign: 'center', marginTop: 4 }}>
          … 共 {pages.length} 页，仅显示前 {effectiveCount} 页
        </div>
      )}
    </div>
  )
}

/* ─── DocumentCard ─── */
export function DocumentCard({ data, onClose }: { data?: DocumentData; onClose?: () => void }) {
  // 兜底空数据渲染
  if (!data || !data.title || !data.pages || data.pages.length === 0) {
    return (
      <div style={{
        padding: '14px 18px', borderRadius: '14px', minWidth: 220, maxWidth: 360,
        background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)',
        border: '1px dashed rgba(255,255,255,0.10)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', textAlign: 'center' }}>
          ⚠ 数据不完整 — 无法渲染文档
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: '14px 18px', borderRadius: '14px', minWidth: 260, maxWidth: 380,
      background: 'rgba(24,24,36,0.90)', backdropFilter: 'blur(16px)',
      border: '1px solid rgba(255,255,255,0.08)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
    }}>
      {/* 标题栏 + 关闭按钮（2026-08-12: 此前卡片忽略 onClose 无关闭按钮） */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        marginBottom: '12px', paddingBottom: '8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <span style={{ fontSize: '16px', lineHeight: 1 }}>📄</span>
        <span style={{
          fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #eee)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {data.title}
        </span>
        {onClose && (
          <button
            type="button"
            title="关闭"
            onClick={onClose}
            aria-label="关闭文档"
            style={{
              flexShrink: 0, width: '22px', height: '22px', borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)',
              color: 'var(--text-muted, #999)', fontSize: '12px', lineHeight: 1,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >✕</button>
        )}
      </div>

      {/* 纸页堆叠 */}
      <PaperStack pages={data.pages} pageCount={data.pageCount} />
    </div>
  )
}
