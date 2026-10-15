import { Palette, Gauge } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  type MotionMode,
  type MotionTier,
  applyTier,
  currentTier,
  readMotionMode,
  resolveAndApplyMotionTier,
  saveMotionMode,
} from '../../lib/motion-tier'

type AccentColor = 'cyan' | 'blue' | 'purple' | 'green' | 'pink'
type Theme = 'dark' | 'light'

const COLOR_MAP: Record<AccentColor, string> = {
  cyan: '#00e5ff', blue: '#3b82f6', purple: '#8b5cf6',
  green: '#22c55e', pink: '#ec4899',
}

export function SettingsAppearance({
  theme, accentColor, setTheme, setAccentColor,
}: {
  theme: Theme
  accentColor: AccentColor
  setTheme: (t: Theme) => void
  setAccentColor: (c: AccentColor) => void
}) {
  return (
    <div className="theme-card p-6 settings-section">
      <h3 className="font-medium mb-4 flex items-center gap-2 theme-text-primary">
        <Palette className="w-5 h-5 theme-accent" />
        外观主题
      </h3>

      <div className="space-y-5">
        {/* Accent color picker */}
        <div>
          <label className="block text-sm mb-3 theme-text-secondary">强调色</label>
          <div className="flex gap-3">
            {(Object.keys(COLOR_MAP) as AccentColor[]).map(color => (
              <button
                key={color}
                onClick={() => setAccentColor(color)}
                className="w-9 h-9 rounded-full transition-all duration-200 flex items-center justify-center"
                style={{ backgroundColor: COLOR_MAP[color] }}
                title={color.charAt(0).toUpperCase() + color.slice(1)}
              >
                {accentColor === color && (
                  <span className="text-white text-xs font-bold">✓</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Dark/light mode toggle */}
        <div>
          <label className="block text-sm mb-3 theme-text-secondary">主题模式</label>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setTheme(mode)}
                className={`flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  theme === mode
                    ? 'theme-accent-bg text-white'
                    : 'theme-bg-tertiary theme-text-secondary hover:theme-bg-hover'
                }`}
              >
                {mode === 'dark' ? '🌙 深色' : '☀️ 浅色'}
              </button>
            ))}
          </div>
        </div>

        <MotionTierControl />
      </div>
    </div>
  )
}

/**
 * 动效保真阶梯开关（2026-09-30）
 *
 * 为什么要给用户开关：本产品跑在"买 U 盘、不装环境"的形态上，用户插的常是集显/机械盘
 * 老机器；同一套界面在不同机器上都必须"顺"。默认自动（按实测帧率 + 系统无障碍偏好判定），
 * 同时提供手动锁定——**信任来自可控**：机器卡时老板能自己降档，而不是只能忍。
 */
function MotionTierControl() {
  const [mode, setMode] = useState<MotionMode>('auto')
  const [effective, setEffective] = useState<MotionTier>('L1')

  useEffect(() => {
    setMode(readMotionMode())
    setEffective(currentTier())
  }, [])

  const choose = async (next: MotionMode) => {
    setMode(next)
    saveMotionMode(next)
    if (next === 'auto') {
      // 交回自动判定：重新采样一次，避免"点了自动但仍停在旧档位"
      const tier = await resolveAndApplyMotionTier()
      setEffective(tier)
    } else {
      applyTier(next)
      setEffective(next)
    }
  }

  const OPTIONS: Array<{ id: MotionMode; label: string; desc: string }> = [
    { id: 'auto', label: '自动', desc: '按实测帧率与系统设置决定' },
    { id: 'L2', label: '全效', desc: '完整玻璃与动效（独显/高分屏）' },
    { id: 'L1', label: '标准', desc: '较轻的模糊与转场（默认）' },
    { id: 'L0', label: '精简', desc: '去模糊去动效，最省资源' },
  ]

  return (
    <div>
      <label className="block text-sm mb-2 theme-text-secondary flex items-center gap-2">
        <Gauge className="w-4 h-4" />
        动效强度
        <span className="theme-text-muted text-xs">
          （当前：{OPTIONS.find(o => o.id === mode)?.label}{mode === 'auto' ? ` · 实测 ${effective}` : ''}）
        </span>
      </label>
      <div className="flex gap-2">
        {OPTIONS.map(o => (
          <button
            key={o.id}
            onClick={() => { void choose(o.id) }}
            title={o.desc}
            className={`flex-1 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              mode === o.id
                ? 'theme-accent-bg text-white'
                : 'theme-bg-tertiary theme-text-secondary hover:theme-bg-hover'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs theme-text-muted leading-relaxed">
        机器偏慢或接了外接屏时选「精简」可显著减少卡顿；勾选系统「减少动态效果」时程序会自动进入精简。
      </p>
    </div>
  )
}
