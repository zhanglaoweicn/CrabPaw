/**
 * ContractCard — 合同卡片组件（kind: contract）
 *
 * document 变体：复用 PaperStack 渲染条款纸页，左侧叠加关键信息栏
 * （甲方 / 乙方 / 金额高亮框）。data 缺字段时隐藏对应项。
 */

import { useEffect } from 'react'
import { PaperStack, ensureKeyframes } from './document'

/* ─── 数据接口 ─── */
export interface ContractData {
  title: string
  parties?: { a: string; b: string }
  amount?: string
  clauses: string[]
  seal?: boolean
}

/* ─── 模块级 keyframes 注入（仅一次，补充 contract 专用动画） ─── */
let contractKeyframesInjected = false
function ensureContractKeyframes() {
  if (contractKeyframesInjected || typeof document === 'undefined') return
  contractKeyframesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes contract-info-slide-in {
      from { opacity: 0; transform: translateX(-16px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .contract-info-item {
        animation: none !important;
      }
    }
  `
  document.head.appendChild(style)
}

/* ─── ContractCard ─── */
export function ContractCard({ data }: { data?: ContractData }) {
  useEffect(() => { ensureContractKeyframes(); ensureKeyframes() }, [])

  // 兜底空数据渲染
  if (!data || !data.title || !data.clauses || data.clauses.length === 0) {
    return (
      <div style={{
        padding: '14px 18px', borderRadius: '14px', minWidth: 220, maxWidth: 420,
        background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)',
        border: '1px dashed rgba(255,255,255,0.10)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted, #888)', textAlign: 'center' }}>
          ⚠ 数据不完整 — 无法渲染合同
        </div>
      </div>
    )
  }

  // 将 clauses 字符串数组转换为 PaperStack 需要的 pages 格式
  const pages = data.clauses.map((text) => ({ text }))

  // 是否有信息栏内容（任一字段有值时显示）
  const hasInfoBar = !!(data.parties?.a || data.parties?.b || data.amount)

  return (
    <div style={{
      padding: '14px 18px', borderRadius: '14px', minWidth: 300, maxWidth: 440,
      background: 'rgba(24,24,36,0.90)', backdropFilter: 'blur(16px)',
      border: '1px solid rgba(147,51,234,0.18)',
      boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
    }}>
      {/* 标题栏 */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: '12px', paddingBottom: '8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '16px', lineHeight: 1 }}>📜</span>
          <span style={{
            fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #eee)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {data.title}
          </span>
        </div>
        {/* 印章 */}
        {data.seal && (
          <span
            className="doc-seal"
            style={{
              fontSize: '22px', lineHeight: 1, opacity: 0.8,
              color: '#ef4444',
              filter: 'drop-shadow(0 1px 2px rgba(239,68,68,0.3))',
              animation: 'doc-seal-stamp 500ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) both',
              userSelect: 'none',
            }}
            title="已签章"
          >
            ⚑
          </span>
        )}
      </div>

      {/* 主体：flex 布局，左侧信息栏 + 右侧纸页 */}
      <div style={{ display: 'flex', gap: '12px' }}>
        {/* 左侧关键信息栏 */}
        {hasInfoBar && (
          <div style={{
            flex: '0 0 auto', width: '110px',
            display: 'flex', flexDirection: 'column', gap: '8px',
          }}>
            {/* 甲方 */}
            {data.parties?.a && (
              <div
                className="contract-info-item"
                style={{
                  padding: '8px 10px', borderRadius: '8px',
                  background: 'rgba(89,168,255,0.10)',
                  border: '1px solid rgba(89,168,255,0.20)',
                  opacity: 0,
                  animation: 'contract-info-slide-in 360ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) both',
                  animationDelay: '80ms',
                }}
              >
                <div style={{ fontSize: 9, color: 'var(--text-muted, #888)', marginBottom: 3, fontWeight: 500 }}>
                  甲方
                </div>
                <div style={{
                  fontSize: 14, fontWeight: 600, color: '#59a8ff',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {data.parties.a}
                </div>
              </div>
            )}

            {/* 乙方 */}
            {data.parties?.b && (
              <div
                className="contract-info-item"
                style={{
                  padding: '8px 10px', borderRadius: '8px',
                  background: 'rgba(167,139,250,0.10)',
                  border: '1px solid rgba(167,139,250,0.20)',
                  opacity: 0,
                  animation: 'contract-info-slide-in 360ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) both',
                  animationDelay: '160ms',
                }}
              >
                <div style={{ fontSize: 9, color: 'var(--text-muted, #888)', marginBottom: 3, fontWeight: 500 }}>
                  乙方
                </div>
                <div style={{
                  fontSize: 14, fontWeight: 600, color: '#a78bfa',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {data.parties.b}
                </div>
              </div>
            )}

            {/* 金额 */}
            {data.amount && (
              <div
                className="contract-info-item"
                style={{
                  padding: '8px 10px', borderRadius: '8px',
                  background: 'rgba(251,191,36,0.10)',
                  border: '1px solid rgba(251,191,36,0.20)',
                  opacity: 0,
                  animation: 'contract-info-slide-in 360ms var(--scene-ease-out, cubic-bezier(0.16,1,0.3,1)) both',
                  animationDelay: '240ms',
                }}
              >
                <div style={{ fontSize: 9, color: 'var(--text-muted, #888)', marginBottom: 3, fontWeight: 500 }}>
                  金额
                </div>
                <div style={{
                  fontSize: '14px', fontWeight: 700, color: '#fbbf24',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {data.amount}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 右侧纸页堆叠（复用 PaperStack） */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <PaperStack pages={pages} startDelay={hasInfoBar ? 300 : 0} />
        </div>
      </div>
    </div>
  )
}
