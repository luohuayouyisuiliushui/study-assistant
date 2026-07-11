import { createContext, useContext, useEffect, useState } from 'react'

const ThemeContext = createContext()

const THEMES = ['ocean', 'forest', 'violet', 'amber', 'rose', 'mono']
const MODES = ['light', 'dark', 'system']

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => localStorage.getItem('app-theme') || 'ocean')
  const [mode, setModeState] = useState(() => localStorage.getItem('app-mode') || 'system')

  const setTheme = (t) => { setThemeState(t); localStorage.setItem('app-theme', t) }
  const setMode = (m) => { setModeState(m); localStorage.setItem('app-mode', m) }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const isDark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', isDark)
  }, [mode])

  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e) => document.documentElement.classList.toggle('dark', e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode])

  return <ThemeContext.Provider value={{ theme, setTheme, mode, setMode, THEMES, MODES }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
