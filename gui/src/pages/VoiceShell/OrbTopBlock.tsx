/**
 * OrbTopBlock — 语音球区块（语音球 + 语音模式三态 + 语速）
 *
 * 2026-08-15: 从 AgentLeftPanel 抽出为独立组件——组合布局(热点/台风/股票)
 * 打开时左栏完全让位, 本区块内联渲染在对话窗口上方(compact 横向小尺寸),
 * 页面不再因左栏残留而变形。常规态仍由 AgentLeftPanel 纵向渲染(200px 球)。
 */
import { VoiceOrb } from '../../components/VoiceOrb'
import { Car, Plane, Rocket } from 'lucide-react'

export interface OrbTopBlockProps {
  orbMode: 'idle' | 'listening' | 'thinking' | 'speaking'
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
}: OrbTopBlockProps) {
  return (
    <div className="voice-shell-orb-top">
      <div className="voice-shell-orb-wrap">
        <button
          type="button"
          className="voice-shell-orb-click"
          onClick={onToggleMute}
          title={muted ? '点击开启语音' : '点击关闭语音（ASR/TTS）'}
          aria-label={muted ? '开启语音' : '关闭语音'}
        >
          <VoiceOrb mode={orbMode} volume={volume} size={size ?? (compact ? 96 : 200)} />
        </button>
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
          aria-label="切换语音模式"
        >
          <span className="mic-mode-icon">{micMode === 'focus' ? '␣' : micMode === 'live' ? '∞' : '◉'}</span>
          <span className="mic-mode-label">{micMode === 'focus' ? '空格' : micMode === 'live' ? '实时' : '默认'}</span>
        </button>
      </div>
      <div className="voice-shell-speech-rate">
        <span className="voice-shell-speech-rate-label">语速</span>
        <div className="voice-shell-speech-rate-btns">
          {(['low', 'default', 'high'] as const).map(rate => (
            <button
              key={rate}
              type="button"
              className={`hud-mode${speechRate === rate ? ' is-active' : ''}`}
              onClick={() => onSpeechRate?.(rate)}
              title={rate === 'low' ? '语速 低 (0.7x)' : rate === 'high' ? '语速 高 (1.3x)' : '语速 默认 (1x)'}
            >
              {rate === 'low' ? <Car size={13} /> : rate === 'high' ? <Rocket size={13} /> : <Plane size={13} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default OrbTopBlock
