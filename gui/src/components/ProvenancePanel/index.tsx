/**
 * ProvenancePanel.tsx — 数据出处链面板（2026-09-30，P2「这数从哪来」）
 *
 * 老板/合作方问"本月营收 57.1 万从哪来"时，给一条**可核验**的链路，而不是让模型念工具名：
 *
 *   [销售明细-1月.csv]  →  [v_sales 14 行]  →  [营收]
 *    14 行参与 · 09-06 导入
 *   ── 事实：参与行数 14 · 空值 date 0 / customer 0 · 来源数 1
 *
 * 呈现口径全部来自 lib/provenance（纯函数、已测）；本组件只负责布局与取数。
 * 外壳复用 ShellFloatCard（拖动 + 位置持久化 + 层级），与 VoiceShell 其他浮卡一致。
 *
 * 诚实降级：ok:false 时**不显示空链路**（空链路会被读成"没有来源"），
 * 只显示失败原因与注意事项。
 */
import { useCallback, useEffect, useState } from 'react'
import { ShellFloatCard } from '../ShellFloatCard'
import { buildProvenanceView, type ProvenanceData, type ProvenanceView } from '../../lib/provenance'
import './styles.css'

export interface ProvenancePanelProps {
  /** 取数的指标（与 HUD / 晨报口径一致） */
  metric: string
  /** 取数函数（注入；缺省走 /api/business/provenance） */
  fetcher?: (metric: string) => Promise<ProvenanceData>
  /** 关闭面板 */
  onClose?: () => void
  /**
   * 2026-09-30 P2: 切到账龄结构三维视图。
   * 不传则不显示该入口（例如没有逾期账目时，三维场景没有可看的东西）。
   */
  onShow3D?: () => void
}

async function defaultFetcher(metric: string): Promise<ProvenanceData> {
  const { apiGet } = await import('../../lib/api')
  const res = await apiGet<{ data?: ProvenanceData } & ProvenanceData>(`/api/business/provenance?metric=${encodeURIComponent(metric)}`)
  if (!res?.success) throw new Error(res?.error || '取数失败')
  // 端点返回 { success, data: { ...provenance } }
  const payload = (res.data as { data?: ProvenanceData })?.data ?? (res.data as ProvenanceData)
  return payload
}

export function ProvenancePanel({ metric, fetcher, onClose, onShow3D }: ProvenancePanelProps) {
  const [view, setView] = useState<ProvenanceView | null>(null)

  const load = useCallback(async () => {
    const f = fetcher ?? defaultFetcher
    try {
      const data = await f(metric)
      setView(buildProvenanceView(data))
    } catch (e) {
      // 网络/HTTP 层失败也走"只说原因"分支，不给空链路
      setView(buildProvenanceView({
        ok: false, metric, label: '数据出处', view: null, triedViews: [],
        rows: null, nulls: {}, sources: [], notes: [],
        unavailableReason: (e as Error)?.message || String(e),
      }))
    }
  }, [fetcher, metric])

  useEffect(() => { void load() }, [load])

  return (
    <ShellFloatCard
      cardKey={`provenance-${metric}`}
      title={<span>数据出处 · {view?.label ?? metric}</span>}
      width={340}
      blur="sm"
      defaultOffset={{ x: 64, y: 120 }}
    >
      <div className="prov">
        {!view && <div className="prov__loading">正在核对来源…</div>}

        {view && !view.ok && (
          <div className="prov__unavailable">
            <div className="prov__unavailable-title">取不到这条链路</div>
            <div className="prov__unavailable-reason">{view.unavailableReason}</div>
            <div className="prov__hint">这不是"没有数据"，是取数失败——建议检查数据目录后再问一次。</div>
          </div>
        )}

        {view && view.ok && (
          <>
            <div className="prov__chain">
              {view.nodes.map((n, i) => (
                <div key={`${n.kind}-${n.title}-${i}`} className="prov__chain-item">
                  {i > 0 && <span className="prov__arrow" aria-hidden>→</span>}
                  <div className={`prov__node prov__node--${n.kind}${n.trustworthy ? '' : ' prov__node--warn'}`}>
                    <div className="prov__node-title">{n.title}</div>
                    {n.subtitle && <div className="prov__node-sub">{n.subtitle}</div>}
                  </div>
                </div>
              ))}
            </div>

            <div className="prov__facts">
              {view.facts.map((f) => (
                <div key={f.key} className="prov__fact">
                  <span className="prov__fact-key">{f.key}</span>
                  <span className="prov__fact-val">{f.text}</span>
                </div>
              ))}
            </div>

            {view.warnings.length > 0 && (
              <ul className="prov__warnings">
                {view.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
          </>
        )}

        <div className="prov__actions">
          {onShow3D && (
            <button type="button" className="prov__act" onClick={onShow3D} title="按账龄看钱的分布">
              看账龄结构
            </button>
          )}
          {onClose && (
            <button type="button" className="prov__act" onClick={onClose}>关闭</button>
          )}
        </div>
      </div>
    </ShellFloatCard>
  )
}
