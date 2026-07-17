import { useCallback, useEffect, useRef } from 'react'
import { cn } from '#/lib/utils'
import { X } from 'lucide-react'

function Dialog({ open, onOpenChange, children }) {
  return open ? <DialogInner onOpenChange={onOpenChange}>{children}</DialogInner> : null
}

function DialogInner({ onOpenChange, children }) {
  const overlayRef = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onOpenChange(false) }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = '' }
  }, [onOpenChange])

  const handleOverlayClick = useCallback((e) => {
    if (e.target === overlayRef.current) onOpenChange(false)
  }, [onOpenChange])

  return (
    <div ref={overlayRef} className='fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm animate-in fade-in' onClick={handleOverlayClick}>
      <div className='relative z-50 w-full max-w-lg max-h-[88vh] overflow-auto rounded-2xl border border-border/70 bg-background/95 p-6 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95'>
        {children}
      </div>
    </div>
  )
}

function DialogContent({ className, children, ...props }) {
  return <div className={cn('', className)} {...props}>{children}</div>
}

function DialogHeader({ className, ...props }) {
  return <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left mb-5', className)} {...props} />
}

function DialogFooter({ className, ...props }) {
  return <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-5', className)} {...props} />
}

function DialogTitle({ className, ...props }) {
  return <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
}

function DialogDescription({ className, ...props }) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function DialogClose({ className, ...props }) {
  return <button className={cn('absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40', className)} {...props}><X className='h-4 w-4' /></button>
}

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose }