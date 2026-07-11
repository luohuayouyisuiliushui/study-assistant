import { useState, useRef, useEffect } from "react"
import { useTheme } from '#/lib/theme-context'
import { Sun, Moon, Monitor, Palette, Check } from 'lucide-react'
import { cn } from '#/lib/utils'

const themeColors = {
  ocean: { label: 'Ocean 蓝', dot: 'bg-blue-500' },
  forest: { label: 'Forest 绿', dot: 'bg-green-500' },
  violet: { label: 'Violet 紫', dot: 'bg-purple-500' },
  amber: { label: 'Amber 琥珀', dot: 'bg-amber-500' },
  rose: { label: 'Rose 红', dot: 'bg-rose-500' },
  mono: { label: 'Mono 石墨', dot: 'bg-gray-500' },
}

export default function ThemeSwitcher() {
  const { theme, setTheme, mode, setMode, THEMES, MODES } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const modeIcon = mode === 'dark' ? Moon : mode === 'light' ? Sun : Monitor

  return (
    <div ref={ref} className='relative flex items-center gap-1'>
      <button onClick={() => setOpen(!open)} className='inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent transition-colors' title='选择主题'>
        <span className={cn('inline-block h-3 w-3 rounded-full', themeColors[theme]?.dot)} />
        <span className='text-muted-foreground'>{themeColors[theme]?.label}</span>
      </button>

      {[Sun, Moon, Monitor].map((Icon, i) => {
        const m = MODES[i]
        const active = mode === m
        return (
          <button key={m} onClick={() => setMode(m)} className={cn('rounded-md p-1.5 transition-colors hover:bg-accent', active ? 'text-foreground bg-accent' : 'text-muted-foreground')} title={m === 'system' ? '跟随系统' : m === 'light' ? '亮色' : '暗色'}>
            <Icon className='h-3.5 w-3.5' />
          </button>
        )
      })}

      {open && (
        <div className='absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md'>
          {THEMES.map((t) => (
            <button key={t} onClick={() => { setTheme(t); setOpen(false) }} className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent transition-colors'>
              <span className={cn('inline-block h-3 w-3 rounded-full', themeColors[t]?.dot)} />
              <span className='flex-1 text-left'>{themeColors[t]?.label}</span>
              {theme === t && <Check className='h-3.5 w-3.5' />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

