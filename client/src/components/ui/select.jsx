import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '#/lib/utils'
import { ChevronDown } from 'lucide-react'

function Select({ value, onValueChange, children, placeholder }) {
  return <SelectImpl value={value} onValueChange={onValueChange} placeholder={placeholder}>{children}</SelectImpl>
}

function SelectImpl({ value, onValueChange, children, placeholder }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const options = (Array.isArray(children) ? children : [children]).filter(c => c?.type === SelectItem)

  const selectedLabel = options.find(o => o.props.value === value)?.props.children || placeholder || 'Select...'

  return (
    <div ref={ref} className='relative'>
      <button onClick={() => setOpen(!open)} className='flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring'>
        {selectedLabel}
        <ChevronDown className='h-4 w-4 opacity-50' />
      </button>
      {open && (
        <div className='absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md'>
          {options.map((opt, i) => (
            <div key={i} className={cn('relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground', opt.props.value === value && 'bg-accent text-accent-foreground')} onClick={() => { onValueChange(opt.props.value); setOpen(false) }}>
              {opt.props.children}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SelectItem({ children, ...props }) { return null }
SelectItem.displayName = 'SelectItem'

export { Select, SelectItem }
