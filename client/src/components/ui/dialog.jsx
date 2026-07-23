import { createContext, useCallback, useContext, useEffect, useId, useRef } from 'react'
import { cn } from '#/lib/utils'
import { X } from 'lucide-react'

const DialogContext = createContext(null)

function getFocusableElements(container) {
  if (!container) return []
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hasAttribute('hidden') && element.getClientRects().length > 0)
}

function Dialog({ open, onOpenChange, children }) {
  return open ? <DialogInner onOpenChange={onOpenChange}>{children}</DialogInner> : null
}

function DialogInner({ onOpenChange, children }) {
  const overlayRef = useRef(null)
  const dialogRef = useRef(null)
  const previousFocusRef = useRef(null)
  const titleId = useId()

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      const focusable = getFocusableElements(dialogRef.current)
      ;(focusable[0] || dialogRef.current)?.focus()
    })
    const handler = (e) => {
      const dialogRoots = [...document.querySelectorAll('[data-dialog-root]')]
      if (dialogRoots.at(-1) !== dialogRef.current) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
        return
      }
      if (e.key !== 'Tab') return
      const focusable = getFocusableElements(dialogRef.current)
      if (focusable.length === 0) {
        e.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handler)
    const lockCount = Number(document.body.dataset.dialogLockCount || 0) + 1
    document.body.dataset.dialogLockCount = String(lockCount)
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', handler)
      const nextLockCount = Math.max(0, Number(document.body.dataset.dialogLockCount || 1) - 1)
      if (nextLockCount === 0) {
        delete document.body.dataset.dialogLockCount
        document.body.style.overflow = ''
      } else {
        document.body.dataset.dialogLockCount = String(nextLockCount)
      }
      previousFocusRef.current?.focus?.()
    }
  }, [onOpenChange])

  const handleOverlayClick = useCallback((e) => {
    if (e.target === overlayRef.current) onOpenChange(false)
  }, [onOpenChange])

  return (
    <DialogContext.Provider value={{ titleId }}>
      <div ref={overlayRef} className='fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm animate-in fade-in' onClick={handleOverlayClick}>
        <div ref={dialogRef} data-dialog-root role='dialog' aria-modal='true' aria-labelledby={titleId} tabIndex={-1} className='relative z-50 w-full max-w-lg max-h-[88vh] overflow-auto rounded-2xl border border-border/70 bg-background/95 p-6 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in-95'>
          {children}
        </div>
      </div>
    </DialogContext.Provider>
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

function DialogTitle({ className, id, ...props }) {
  const dialog = useContext(DialogContext)
  return <h2 id={dialog?.titleId || id} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
}

function DialogDescription({ className, ...props }) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function DialogClose({ className, type = 'button', ...props }) {
  return <button type={type} className={cn('absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring/40', className)} {...props}><X className='h-4 w-4' /></button>
}

export { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose }
