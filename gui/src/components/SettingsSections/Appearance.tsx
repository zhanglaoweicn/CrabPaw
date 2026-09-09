import { Palette } from 'lucide-react'

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
      </div>
    </div>
  )
}
