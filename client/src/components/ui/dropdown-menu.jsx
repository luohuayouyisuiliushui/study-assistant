import { useState, useRef, useEffect } from 'react'
import { cn } from '#/lib/utils'
import { ChevronDown } from 'lucide-react'

function DropdownMenu({ children }) {
  return children
}

function DropdownMenuTrigger({ children, asChild, className, ...props }) {
  return <button className={cn('inline-flex items-center gap-1', className)} {...props}>{children}</button>
}

function DropdownMenuContent({ children, align = 'center', className, ...props }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target) && triggerRef.current && !triggerRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const childrenArray = Array.isArray(children) ? children : [children]

  return (
    <>
      {childrenArray.map((child, i) => {
        if (child?.type === DropdownMenuTrigger) {
          return <span key={i} ref={triggerRef} onClick={() => setOpen(!open)} className={cn(child.props.className)}>{child.props.children}</span>
        }
        return null
      })}
      {open && (
        <div ref={ref} className={cn('absolute z-50 mt-1 min-w-[8rem] rounded-md border bg-popover p-1 shadow-md', className)} {...props}>
          {childrenArray.map((child, i) => {
            if (child?.type === DropdownMenuItem || child?.type === DropdownMenuSeparator) {
              return <child.type key={i} {...child.props} onClick={(e) => { child.props.onClick?.(e); setOpen(false) }} />
            }
            return null
          })}
        </div>
      )}
    </>
  )
}

function DropdownMenuItem({ className, inset, children, ...props }) {
  return (
    <div className={cn('relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground', inset && 'pl-8', className)} {...props}>
      {children}
    </div>
  )
}

function DropdownMenuSeparator({ className }) {
  return <div className={cn('-mx-1 my-1 h-px bg-border', className)} />
}

function DropdownMenuLabel({ className, inset, ...props }) {
  return <div className={cn('px-2 py-1.5 text-sm font-semibold', inset && 'pl-8', className)} {...props} />
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel }
