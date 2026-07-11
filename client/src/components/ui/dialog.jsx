import { useCallback, useEffect, useRef } from 'react'
import { cn } from '#/lib/utils'
import { X } from 'lucide-react'

function Dialog({ open, onOpenChange, children }) {
  return open ? <DialogInner open={open} onOpenChange={onOpenChange} children={children} /> : null
}

function DialogInner({ open, onOpenChange, children }) {
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
    <div ref={overlayRef} className='fixed inset-0 z-50 flex items-center justify-center bg-black/50' onClick={handleOverlayClick}>
      <div className='relative z-50 w-full max-w-lg max-h-[85vh] overflow-auto rounded-lg border bg-background p-6 shadow-lg animate-in fade-in zoom-in-95'>
        {children}
      </div>
    </div>
  )
}

function DialogContent({ className, children, ...props }) {
  return <div className={cn('', className)} {...props}>{children}</div>
}

function DialogHeader({ className, ...props }) {
  return <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left mb-4', className)} {...props} />
}

function DialogFooter({ className, ...props }) {
  return <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-4', className)} {...props} />
}

function DialogTitle({ className, ...props }) {
  return <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
}

function DialogDescription({ className, ...props }) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function DialogClose({ className, ...props }) {
  return <button className={cn('absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2', className)} {...props}><X className='h-4 w-4' /></button>
}

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose }
