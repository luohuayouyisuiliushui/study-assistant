import { forwardRef } from 'react'
import { cn } from '#/lib/utils'

const Progress = forwardRef(({ className, value = 0, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
    {...props}
  >
    <div
      className="h-full rounded-full bg-primary transition-all duration-300 ease-in-out"
      style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
    />
  </div>
))
Progress.displayName = 'Progress'

export { Progress }
