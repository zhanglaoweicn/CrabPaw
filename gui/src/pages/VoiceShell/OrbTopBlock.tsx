/**
 * OrbTopBlock — 语音球区块（语音球 + 语音模式三态 + 语速）
 *
 * 2026-08-15: 从 AgentLeftPanel 抽出为独立组件——组合布局(热点/台风/股票)
 * 打开时左栏完全让位, 本区块内联渲染在对话窗口上方(compact 横向小尺寸),
 * 页面不再因左栏残留而变形。常规态仍由 AgentLeftPanel 纵向渲染(200px 球)。
 */
import { useRef } from 'react'
import { VoiceOrb } from '../../components/VoiceOrb'
import { Car, Plane, Rocket, Mic, MicOff } from 'lucide-react'
import { executeCommand } from '../../lib/ui-command-registry'

/** 按住多久算"说话"（PTT）；低于此值是轻点（开始听/打断播报） */
const PTT_HOLD_MS = 220
/** 指针移动超过这个距离视为"在拖卡片"，让位给拖动、不误触 PTT */
const PTT_MOVE_TOL = 10

export interface OrbTopBlockProps {
  orbMode: 'idle' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'muted'
  muted: boolean
  /** 2026-08-24: 能量电平(0~1)——绿态波动幅度唯一驱动源(安静=绿静态) */
  volume?: number
  speechRate: 'low' | 'default' | 'high'
  micMode: 'default' | 'focus' | 'live'
  compact?: boolean
  /** 2026-08-31: 覆盖球尺寸(px)（cards 布局用；缺省 200/compact 96） */
  size?: number
  onToggleMute?: () => void
  onSpeechRate?: (rate: 'low' | 'default' | 'high') => void
  onCycleMicMode?: () => void
  /** 2026-09-24 会客厅(S1): 轻点球 = 开始听 / 打断播报（原"点击=静音"取消） */
  onTapTalk?: () => void
}

export function OrbTopBlock({
  orbMode,
  muted,
  volume,
  speechRate,
  micMode,
  compact = false,
  size,
  onToggleMute,
  onSpeechRate,
  onCycleMicMode,
  onTapTalk,
}: OrbTopBlockProps) {
  // 2026-09-22 可访问性: 语音球是 canvas——它的状态（聆听/思考/播报）对读屏
  // 完全不可知。此处把状态翻成人话，经 sr-only 的 aria-live 区域播报。
  const orbStateText = muted
    ? '语音已关闭'
    : orbMode === 'waiting'
      ? '等你拍板'
      : orbMode === 'listening'
        ? '正在聆听'
        : orbMode === 'thinking'
          ? '正在思考'
          : orbMode === 'speaking'
            ? '正在播报'
            : '语音待机'
  // ── 2026-09-24 会客厅(S1): 球上的手势 ─────────────────────────────────
  // 按住 = 说话（PTT，经命令注册表调用 VoiceIntegration 的同一套按下/松开逻辑——
  //   一体机没有键盘，这是"按住球说话"的唯一入口；部署手册此前写的是"已内置"，
  //   实际代码里只有空格键）
  // 轻点 = 开始听 / 打断播报（原「点击 = 静音」取消：墙机上客人伸手点球期望
  //   "它开始听我"，结果把麦克风关了，是反直觉且危险的手势）
  // 静音 → 搬到控制行的显式麦克风按钮（可见、可点、有 aria-pressed）
  // 指针移动超过阈值即取消按住（让位给卡片拖动，不误触 PTT）
  const pressRef = useRef<{ timer: number | null; x: number; y: number; talking: boolean }>(
    { timer: null, x: 0, y: 0, talking: false },
  )
  const clearPressTimer = () => {
    if (pressRef.current.timer !== null) {
      window.clearTimeout(pressRef.current.timer)
      pressRef.current.timer = null
    }
  }
  const onBallPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    clearPressTimer()
    pressRef.current = {
      timer: window.setTimeout(() => {
        pressRef.current.timer = null
        pressRef.current.talking = true
        executeCommand('ptt', 'start')
      }, PTT_HOLD_MS),
      x: e.clientX,
      y: e.clientY,
      talking: false,
    }
  }
  const onBallPointerMove = (e: React.PointerEvent) => {
    const st = pressRef.current
    if (st.timer === null || st.talking) return
    if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > PTT_MOVE_TOL) clearPressTimer()
  }
  const onBallPointerUp = () => {
    const wasTalking = pressRef.current.talking
    clearPressTimer()
    pressRef.current.talking = false
    if (wasTalking) { executeCommand('ptt', 'stop'); return }
    // 2026-09-24 用户反馈修复（"点球没反应、无法静音"）：
    // 静音态下轻点球 = 开启语音。旧实现在静音时直接走"唤醒命中"→ 被静音守卫挡掉，
    // 于是点球毫无反应，用户被困在静音里（球是唯一显眼的控件，而静音键在旁边很小）。
    // 语义：球始终可用——关着就点开，开着就"开始听/打断播报"；静音开关在球右侧的
    // 麦克风按钮（静音时该行会显示"已静音"标签，见下）。
    if (muted) { onToggleMute?.(); return }
    onTapTalk?.()
  }
  const onBallPointerCancel = () => {
    const wasTalking = pressRef.current.talking
    clearPressTimer()
    pressRef.current.talking = false
    if (wasTalking) executeCommand('ptt', 'stop')
  }

  return (
    <div className="voice-shell-orb-top">
      <div className="voice-shell-orb-wrap">
        <button
          type="button"
          className="voice-shell-orb-click"
          onPointerDown={onBallPointerDown}
          onPointerMove={onBallPointerMove}
          onPointerUp={onBallPointerUp}
          onPointerCancel={onBallPointerCancel}
          onPointerLeave={() => { if (pressRef.current.timer !== null && !pressRef.current.talking) clearPressTimer() }}
          onContextMenu={(e) => e.preventDefault()}
          title={muted ? '点一下开启语音 · 按住说话' : '按住说话 · 轻点开始听'}
          aria-label={muted ? '点一下开启语音（当前语音已关闭）' : `按住说话 · 轻点开始听（当前${orbStateText}）`}
          style={{ touchAction: 'manipulation', userSelect: 'none' }}
        >
          <VoiceOrb mode={orbMode} volume={volume} size={size ?? (compact ? 96 : 200)} />
        </button>
        {/* 状态播报区（视觉不可见，仅读屏）——含静音态，避免"球不说话也没提示" */}
        <span className="sr-only" role="status" aria-live="polite">{orbStateText}</span>
        {/* 2026-08-14: 语音模式三态循环按钮（DingDong MicModeButton 对齐）——
            点击循环: 默认(唤醒词+空格) → 专注(仅空格) → 实时(连续对话) → 默认。
            原输入框上方"静音/连续对话/专注"三按钮合并于此, 静音保留为点击语音球。 */}
        <button
          type="button"
          className={`mic-mode-btn mic-mode-btn--${micMode}`}
          onClick={onCycleMicMode}
          title={
            micMode === 'focus'
              ? '专注模式 · 仅按住空格说话（点击切换）'
              : micMode === 'live'
                ? '实时监听 · 连续对话（点击切换）'
                : '默认模式 · 唤醒词 + 空格说话（点击切换）'
          }
          aria-label={`切换语音模式（当前${
            micMode === 'focus' ? '专注模式' : micMode === 'live' ? '实时监听' : '默认模式'
          }）`}
        >
          <span className="mic-mode-icon" aria-hidden>{micMode === 'focus' ? '␣' : micMode === 'live' ? '∞' : '◉'}</span>
          <span className="mic-mode-label">{micMode === 'focus' ? '空格' : micMode === 'live' ? '实时' : '默认'}</span>
        </button>
      </div>
      {/* 2026-09-23 排版轮: 状态词贴到球正下方。此前视觉上只有右侧对话卡顶栏的注意带
          显示「待命/聆听/思考/播报」——离球约 300px，语音优先的界面里状态该挨着球。
          sr-only 那份保留给读屏（同一事实两个出口，不是重复）。 */}
      <span
        className="voice-shell-orb-state"
        data-orb-mode={orbMode}
        data-muted={muted ? 'true' : undefined}
      >
        <span className="voice-shell-orb-state-dot" aria-hidden="true" />
        {/* 2026-09-24: 静音态给出可操作提示——用户反馈"点球没反应、无法静音"，
            根因之一是静音开关（球右侧麦克风按钮）太难被发现 */}
        {muted ? '语音已关闭 · 点一下球开启' : orbStateText}
      </span>
      <div className="voice-shell-speech-rate">
        <span className="voice-shell-speech-rate-label">语速</span>
        <div className="voice-shell-speech-rate-btns" role="group" aria-label="语速">
          {(['low', 'default', 'high'] as const).map(rate => (
            <button
              key={rate}
              type="button"
              className={`hud-mode${speechRate === rate ? ' is-active' : ''}`}
              onClick={() => onSpeechRate?.(rate)}
              title={rate === 'low' ? '语速 低 (0.7x)' : rate === 'high' ? '语速 高 (1.3x)' : '语速 默认 (1x)'}
              aria-label={rate === 'low' ? '语速低' : rate === 'high' ? '语速高' : '语速默认'}
              aria-pressed={speechRate === rate}
            >
              {rate === 'low' ? <Car size={13} aria-hidden /> : rate === 'high' ? <Rocket size={13} aria-hidden /> : <Plane size={13} aria-hidden />}
            </button>
          ))}
        </div>
        {/* 2026-09-24 会客厅(S1): 麦克风总开关改显式按钮——球让位给"按住说话"之后，
            静音必须另有一个可见、可点、带 aria-pressed 的入口（墙机上尤其重要） */}
        {muted && (
          <span className="voice-shell-speech-rate-label" style={{ color: 'var(--color-warning, #f5b455)' }}>
            已静音
          </span>
        )}
        <div className="voice-shell-speech-rate-btns" role="group" aria-label="语音开关">
          <button
            type="button"
            className={`hud-mode${muted ? ' is-active' : ''}`}
            onClick={onToggleMute}
            title={muted ? '开启语音（ASR/TTS 当前全停）' : '关闭语音（ASR/TTS 全停）'}
            aria-label={muted ? '开启语音' : '关闭语音'}
            aria-pressed={muted}
          >
            {muted ? <MicOff size={13} aria-hidden /> : <Mic size={13} aria-hidden />}
          </button>
        </div>
      </div>
    </div>
  )
}

export default OrbTopBlock
