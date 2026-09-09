/**
 * StocksCard — 股票行情卡
 *
 * 展示 stocks 卡条目（StockQuery 工具 → stock-helper.buildVoiceQuote → SceneStore stocks-card）：
 *   - 名称/代码 + 信号徽标（语义着色：偏多→绿 / 偏空→红 / 多空交织→黄 / 中性→灰蓝）
 *   - 综合评分点（0-100 归一化：≥70 绿 / 40-70 黄 / <40 红，●●●●○ + 分值）
 *   - 现价/涨跌/持仓盈亏 + 免责声明（空态保留）
 *
 * 评分说明：后端 overallScore.finalScore 实际为 [-1, 1] 字符串（如 "0.42"），
 * 前端归一化为 0-100 用于评分点显示，不改后端字段。
 */

export interface StockItem {
  code: string; name: string; price?: number; changePct?: number;
  signal?: string; score?: number; shares?: number; cost?: number;
}

export interface StocksCardData { kind: 'stocks'; items: StockItem[] }

// 信号语义着色词表：命中多头词 → 偏多（绿）；命中空头词 → 偏空（红）；两者皆命中 → 多空交织（黄）
const BULLISH_RE = /买入|看多|多头|金叉|加仓|增持/
const BEARISH_RE = /卖出|看空|空头|死叉|减仓|减持/

function signalBadge(signal: string): { text: string; color: string; bg: string } {
  const bull = BULLISH_RE.test(signal)
  const bear = BEARISH_RE.test(signal)
  if (bull && bear) return { text: '多空交织', color: '#f59e0b', bg: 'rgba(245,158,11,0.14)' }
  if (bull) return { text: '偏多', color: '#10b981', bg: 'rgba(16,185,129,0.14)' }
  if (bear) return { text: '偏空', color: '#f43f5e', bg: 'rgba(244,63,94,0.14)' }
  return { text: '中性', color: '#94a3b8', bg: 'rgba(148,163,184,0.14)' }
}

// 综合评分色阶（0-100）：≥70 绿 / 40-70 黄 / <40 红
function scoreColor(score: number): string {
  if (score >= 70) return '#10b981'
  if (score >= 40) return '#f59e0b'
  return '#f43f5e'
}

// 后端 score 为 [-1, 1]（如 "0.42"）→ 归一化为 0-100；兼容直接 0-100 的取值；非法值返回 null
function normalizeScore(score: number | string | undefined | null): number | null {
  if (score === undefined || score === null) return null
  const n = Number(score)
  if (!Number.isFinite(n)) return null
  if (n >= -1 && n <= 1) return Math.round((n + 1) * 50)
  return Math.round(Math.max(0, Math.min(100, n)))
}

export default function StocksCard({ data, onClose }: { data: StocksCardData; onClose?: () => void }) {
  if (!data || !Array.isArray(data.items)) return null;
  return (
    <div className="scene-card stocks-card" style={{ padding: '14px 16px', minWidth: 300, maxHeight: 420, overflow: 'auto', position: 'relative' }}>
      {onClose && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: 4, right: 4, width: 24, height: 24, borderRadius: 6,
            border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.06)',
            color: 'var(--text-muted, #999)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, zIndex: 2,
          }}
          title="关闭"
        >✕</button>
      )}
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>📈 股票</div>
      {data.items.length === 0 && (
        <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--text-muted, #888)', textAlign: 'center' }}>
          暂无持仓/自选数据<br />
          <span style={{ fontSize: 11, opacity: 0.7 }}>可以说「买 600519 一百股成本 1200」开始管理持仓</span>
        </div>
      )}
      {data.items.map((s) => {
        const up = (s.changePct ?? 0) >= 0;
        const pnl = s.price != null && s.cost != null ? (s.price - s.cost) * (s.shares || 0) : null;
        const badge = s.signal ? signalBadge(s.signal) : null;
        const score = normalizeScore(s.score);
        const filled = score != null ? Math.round(score / 20) : 0;
        return (
          <div key={s.code} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{s.name}<span style={{ fontSize: 12, opacity: 0.5, marginLeft: 6 }}>{s.code}</span></div>
              {s.signal && badge ? (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 3 }}>
                  <span
                    style={{ fontSize: 11, padding: '1px 6px', borderRadius: 8, background: badge.bg, color: badge.color, fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}
                  >{badge.text}</span>
                  <span style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.35 }}>{s.signal}</span>
                </div>
              ) : null}
              {score != null ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 3 }}>
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} style={{ fontSize: 11, lineHeight: 1, color: i < filled ? scoreColor(score) : 'rgba(255,255,255,0.18)' }}>●</span>
                  ))}
                  <span style={{ fontSize: 11, color: scoreColor(score), marginLeft: 4 }}>{score} 分</span>
                </div>
              ) : null}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              {s.price != null ? <div style={{ fontSize: 15, fontWeight: 600, color: up ? '#4ade80' : '#f87171' }}>{s.price}</div> : null}
              {s.changePct != null ? <div style={{ fontSize: 14, color: up ? '#4ade80' : '#f87171' }}>{up ? '+' : ''}{s.changePct}%</div> : null}
              {pnl != null ? <div style={{ fontSize: 14, opacity: 0.7 }}>{pnl >= 0 ? '+' : ''}{Math.round(pnl)}</div> : null}
            </div>
          </div>
        );
      })}
      <div style={{ fontSize: 11, opacity: 0.5, marginTop: 10 }}>数据仅供参考，不构成投资建议</div>
    </div>
  );
}
