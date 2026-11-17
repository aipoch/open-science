import { useId, useState, type ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'

export function ComputePanel({
  title,
  description,
  icon: Icon,
  count,
  action,
  label,
  collapsible = false,
  children
}: {
  title: string
  description?: ReactNode
  icon: LucideIcon
  count?: number
  action?: ReactNode
  label?: string
  collapsible?: boolean
  children: ReactNode
}): React.JSX.Element {
  const titleId = useId()
  const [expanded, setExpanded] = useState(false)
  const heading = (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 id={titleId} className="text-[17px] font-medium leading-6">
          {title}
        </h2>
        {count !== undefined && (
          <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
      </div>
      {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
    </div>
  )
  return (
    <section
      className="text-sm leading-5 text-foreground"
      aria-label={label}
      aria-labelledby={label ? undefined : titleId}
    >
      <Card className="gap-0 rounded-lg py-0">
        {collapsible ? (
          <details
            className="group/panel"
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary
              className={`flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-4 outline-none focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden ${expanded ? 'border-b border-border' : ''}`}
            >
              {heading}
              <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-open/panel:rotate-90" />
            </summary>
            {expanded && children}
          </details>
        ) : (
          <>
            <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-4">
              {heading}
              {action}
            </header>
            {children}
          </>
        )}
      </Card>
    </section>
  )
}
