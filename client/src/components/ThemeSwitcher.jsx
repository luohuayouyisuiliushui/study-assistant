import { useEffect, useRef, useState } from 'react'
import { useTheme } from '#/lib/theme-context'
import { Check, ChevronDown, Monitor, Moon, Palette, Sun } from 'lucide-react'
import { cn } from '#/lib/utils'

const themeColors = {
  ocean: { label: 'Ocean 蓝', dot: 'bg-blue-500' },
  forest: { label: 'Forest 绿', dot: 'bg-green-500' },
  violet: { label: 'Violet 紫', dot: 'bg-purple-500' },
  amber: { label: 'Amber 琥珀', dot: 'bg-amber-500' },
  rose: { label: 'Rose 红', dot: 'bg-rose-500' },
  mono: { label: 'Mono 石墨', dot: 'bg-gray-500' },
}

const modeMeta = {
  light: { label: '亮色', icon: Sun },
  dark: { label: '暗色', icon: Moon },
  system: { label: '跟随系统', icon: Monitor },
}

export default function ThemeSwitcher() {
  const { theme, setTheme, mode, setMode, THEMES, MODES } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const ModeIcon = modeMeta[mode]?.icon || Monitor

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className='relative'>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        className='theme-trigger'
        title='切换显示主题'
        aria-expanded={open}
        aria-haspopup='dialog'
      >
        <Palette className='h-3.5 w-3.5 text-muted-foreground' />
        <span className={cn('theme-trigger__dot', themeColors[theme]?.dot)} />
        <span className='theme-trigger__label'>{themeColors[theme]?.label}</span>
        <span className='theme-trigger__mode'><ModeIcon className='h-3.5 w-3.5' /></span>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className='theme-popover' role='dialog' aria-label='主题设置'>
          <span className='theme-popover__label'>显示模式</span>
          <div className='theme-mode-grid'>
            {MODES.map((item) => {
              const Icon = modeMeta[item].icon
              return (
                <button key={item} type='button' className={mode === item ? 'is-active' : ''} onClick={() => { setMode(item); setOpen(false) }}>
                  <Icon className='h-3.5 w-3.5' />
                  <span>{modeMeta[item].label}</span>
                </button>
              )
            })}
          </div>

          <span className='theme-popover__label'>主题色</span>
          <div className='theme-color-grid'>
            {THEMES.map((item) => (
              <button key={item} type='button' className={theme === item ? 'is-active' : ''} onClick={() => { setTheme(item); setOpen(false) }}>
                <span className={cn('inline-block h-3 w-3 rounded-full', themeColors[item]?.dot)} />
                <span className='flex-1 truncate text-left'>{themeColors[item]?.label}</span>
                {theme === item && <Check className='h-3.5 w-3.5 shrink-0' />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}