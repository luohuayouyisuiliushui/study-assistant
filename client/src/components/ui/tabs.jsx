import { useState } from 'react'
import { cn } from '#/lib/utils'

function Tabs({ defaultValue, value, onValueChange, children, className }) {
  const [internalValue, setInternalValue] = useState(defaultValue)
  const activeValue = value ?? internalValue
  const setActive = onValueChange ?? setInternalValue

  const tabs = Array.isArray(children) ? children : [children]
  const trigger = tabs.find(c => c?.type === TabsList)
  const panels = tabs.filter(c => c?.type === TabsContent)

  return (
    <div className={className}>
      {trigger && <TabsListWrapper activeValue={activeValue} onValueChange={setActive}>{trigger.props.children}</TabsListWrapper>}
      {panels.filter(p => p.props.value === activeValue).map((p, i) => (
        <div key={i} className={cn('mt-2', p.props.className)}>{p.props.children}</div>
      ))}
    </div>
  )
}

function TabsListWrapper({ activeValue, onValueChange, children }) {
  const items = Array.isArray(children) ? children : [children]
  return (
    <div className='inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground'>
      {items.filter(c => c?.type === TabsTrigger).map((item, i) => (
        <button key={i} onClick={() => onValueChange(item.props.value)} className={cn('inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50', item.props.value === activeValue ? 'bg-background text-foreground shadow' : 'hover:text-foreground')}>
          {item.props.children}
        </button>
      ))}
    </div>
  )
}

function TabsList({ children }) { return <>{children}</> }
function TabsTrigger({ children }) { return <>{children}</> }
function TabsContent({ children, value }) { return <>{children}</> }

export { Tabs, TabsList, TabsTrigger, TabsContent }
