/**
 * HeartbeatCard — 首页左卡片（2026-08-31 M2）
 *
 * 三态大字（🟢 已就绪 / 🟡 正在处理任务 / 🔴 离线）+ 迷你 ECG（HeartBeatEcg）
 * + 服务状态 3 行（主服务 / AI 模型 / 语音引擎）。老板视角：一眼"它在干活"。
 * 外壳 ShellFloatCard（可拖动、位置持久化），由 VoiceShell 布局层提供。
 */
import { HeartBeatEcg } from '../HeartBeatEcg'

export interface HomeStatus {
  label: string
  tone: 'ready' | 'busy' | 'offline'
  dot: string
}

/** 三态推导（纯函数）——在线+活跃=处理任务；断线=离线；否则=已就绪 */
export function deriveHomeStatus({ online, heartBeatActive }: { online: boolean; heartBeatActive: boolean }): HomeStatus {
  if (!online) return { label: '离线', tone: 'offline', dot: '🔴' }
  if (heartBeatActive) return { label: '正在处理任务', tone: 'busy', dot: '🟡' }
  return { label: '已就绪', tone: 'ready', dot: '🟢' }
}

export interface HeartbeatCardProps {
  online: boolean
  heartBeatActive: boolean
  /** '—' 或 null = 尚未收到心跳 */
  heartBeatCount: string | number | null
  services?: {
    ai?: { configured?: boolean }
    wecom?: { configured?: boolean }
  }
  voiceEngineOk?: boolean
  /** 语音播放中 → ECG 120BPM + 波幅增强（2026-09-02 与 TTS 同步） */
  speaking?: boolean
}

export function HeartbeatCard({ online, heartBeatActive, heartBeatCount, services, voiceEngineOk = true, speaking = false }: HeartbeatCardProps) {
  const st = deriveHomeStatus({ online, heartBeatActive })
  const hasData = heartBeatCount != null && heartBeatCount !== '—'
  const aiOk = services?.ai?.configured === true

  const rows = [
    { label: '主服务', value: online ? '已连接' : '已断开', ok: online },
    { label: 'AI 模型', value: aiOk ? '已配置' : '未配置', ok: aiOk },
    { label: '语音引擎', value: voiceEngineOk ? '已启动' : '故障', ok: voiceEngineOk },
  ]

  return (
    <div style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* 2026-09-24 会客厅轮: 状态点去 emoji（🔴/🟡/🟢 会把"专业仪器"拉成手机 App）。
            deriveHomeStatus().dot 字段保留（对外契约与单测不动），这里只按 tone 画同色圆点。 */}
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            flexShrink: 0,
            background: st.tone === 'busy' ? '#fbbf24' : st.tone === 'offline' ? '#f87171' : '#4ade80',
            boxShadow: `0 0 10px ${st.tone === 'busy' ? 'rgba(251,191,36,0.55)' : st.tone === 'offline' ? 'rgba(248,113,113,0.5)' : 'rgba(74,222,128,0.5)'}`,
          }}
        />
        <span
          style={{
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: 1,
            color: st.tone === 'busy' ? '#fbbf24' : st.tone === 'offline' ? '#f87171' : '#4ade80',
            textShadow: `0 0 12px ${st.tone === 'busy' ? 'rgba(251,191,36,0.45)' : st.tone === 'offline' ? 'rgba(248,113,113,0.4)' : 'rgba(74,222,128,0.4)'}`,
          }}
        >
          {st.label}
        </span>
      </div>

      <HeartBeatEcg active={heartBeatActive} hasData={hasData} online={online} speaking={speaking} height={64} />

      {/* 2026-09-24 会客厅轮: 离线时补一个恢复入口——此前只显示红点/离线，没有任何
          可点的动作（用户只能重开应用）。service:start 本身幂等（运行中会直接返回）。 */}
      {!online && (
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                await window.electronAPI?.service?.start?.({ channel: 'none' })
              } catch (e) {
                console.warn('[heartbeat] 重新连接失败:', e)
              }
            })()
          }}
          style={{
            alignSelf: 'flex-start',
            fontSize: 12,
            fontWeight: 600,
            padding: '4px 12px',
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
            background: 'transparent',
            border: '1px solid rgba(248, 113, 113, 0.55)',
            color: '#f87171',
          }}
          title="尝试重新启动后端服务"
        >
          重新连接
        </button>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11 }}>
            <span style={{ color: 'rgba(148,163,184,0.7)' }}>{r.label}</span>
            <span style={{ color: r.ok ? 'rgba(125,211,252,0.9)' : 'rgba(248,113,113,0.9)', fontWeight: 600 }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default HeartbeatCard
