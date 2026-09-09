import { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback } from 'react'

type Theme = 'dark' | 'light'
type AccentColor = 'cyan' | 'blue' | 'purple' | 'green' | 'pink'

interface ThemeContextType {
  theme: Theme
  accentColor: AccentColor
  toggleTheme: () => void
  setTheme: (theme: Theme) => void
  setAccentColor: (color: AccentColor) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const THEME_STORAGE_KEY = 'crabpaw_theme'
const ACCENT_STORAGE_KEY = 'crabpaw_accent'

export function ThemeProvider({ children }: { children: ReactNode }) {
  // 2026-08-08(审计 P1): 读取加 try/catch——隐私模式/沙箱 iframe/禁用存储时
  // localStorage.getItem 抛 SecurityError,旧实现初始化器内无保护 → 整个
  // ThemeProvider 挂载崩溃白屏
  const readStorage = (key: string): string | null => {
    try { return localStorage.getItem(key) } catch (e) { console.warn('[Theme] 主题存储读取失败:', e); return null }
  }

  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStorage(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
    return 'dark'
  })

  const [accentColor, setAccentColorState] = useState<AccentColor>(() => {
    const stored = readStorage(ACCENT_STORAGE_KEY)
    if (stored === 'cyan' || stored === 'blue' || stored === 'purple' || stored === 'green' || stored === 'pink') return stored
    if (stored === 'orange') return 'cyan' // 2026-08-28 迁移: orange 无 CSS 规则, 实际渲染基底全息青
    return 'cyan'
  })

  // 过渡动画定时器 ref：effect cleanup 清除，防止卸载/切主题后残留
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove('theme-dark', 'theme-light')
    root.classList.add(`theme-${theme}`)
    // localStorage 可能在隐私模式/存储满时抛异常——持久化失败不阻断主题切换
    try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch (e) { console.warn('[Theme] 主题持久化失败:', e) }
    // Add transition class briefly for smooth theme switch
    root.classList.add('theme-transitioning')
    if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = setTimeout(() => {
      root.classList.remove('theme-transitioning')
      transitionTimerRef.current = null
    }, 400)
    return () => {
      if (transitionTimerRef.current) { clearTimeout(transitionTimerRef.current); transitionTimerRef.current = null }
    }
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accentColor)
    try { localStorage.setItem(ACCENT_STORAGE_KEY, accentColor) } catch (e) { console.warn('[Theme] 强调色持久化失败:', e) }
  }, [accentColor])

  const toggleTheme = useCallback(() => {
    setThemeState(prev => prev === 'dark' ? 'light' : 'dark')
  }, [])

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme)
  }, [])

  const setAccentColor = useCallback((color: AccentColor) => {
    setAccentColorState(color)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, accentColor, toggleTheme, setTheme, setAccentColor }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
