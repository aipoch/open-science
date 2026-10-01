const OPEN_DIALOG_SELECTOR =
  '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])'
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
const LITERATURE_SIDEBAR_GROUP_LIMIT = 5

function limitSidebarEntries<T extends { id: string }>(
  entries: readonly T[],
  selectedId: string | undefined
): T[] {
  const limited = entries.slice(0, LITERATURE_SIDEBAR_GROUP_LIMIT)
  if (!selectedId || limited.some((entry) => entry.id === selectedId)) return limited
  const selected = entries.find((entry) => entry.id === selectedId)
  return selected ? [...limited.slice(0, -1), selected] : limited
}

type LiteratureSidebarGroupProps<T extends { id: string }> = Readonly<{
  collapsed: boolean
  entries: readonly T[]
  groupId: string
  label: string
  action?: ReactNode
  navButtonClassName: string
  selectedId?: string
  showAllLabel: string
  showAllText: string
  showFewerLabel: string
  showLessText: string
  renderEntry: (entry: T) => React.JSX.Element
}>

export function LiteratureSidebarHint({
  label,
  collapsed,
  children
}: Readonly<{ label: string; collapsed: boolean; children: ReactElement }>): React.JSX.Element {
  return (
    <Tooltip disableHoverableContent>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
        }}
      >
        {children}
      </TooltipTrigger>
      {collapsed ? <TooltipContent side="right">{label}</TooltipContent> : null}
    </Tooltip>
  )
}

export function LiteratureSidebarGroup<T extends { id: string }>({
  collapsed,
  entries,
  groupId,
  label,
  action,
  navButtonClassName,
  selectedId,
  showAllLabel,
  showAllText,
  showFewerLabel,
  showLessText,
  renderEntry
}: LiteratureSidebarGroupProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const visibleEntries = expanded ? entries : limitSidebarEntries(entries, selectedId)

  return (
    <>
      {!collapsed || action ? (
        <div className={cn('flex items-center gap-1', collapsed && 'justify-center')}>
          {!collapsed ? (
            <button
              type="button"
              className={cn(
                navButtonClassName,
                'min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground'
              )}
              aria-expanded={open}
              aria-controls={groupId}
              aria-label={label}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{label}</span>
              <span className="ml-auto shrink-0 tabular-nums" aria-hidden="true">
                {entries.length}
              </span>
            </button>
          ) : null}
          {action}
        </div>
      ) : null}
      <div id={groupId} className="mt-2 space-y-1" hidden={!collapsed && !open}>
        {visibleEntries.map(renderEntry)}
        {!collapsed && entries.length > LITERATURE_SIDEBAR_GROUP_LIMIT ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="mt-1 w-full justify-between px-3 text-xs text-muted-foreground transition-none"
            aria-expanded={expanded}
            aria-label={expanded ? showFewerLabel : showAllLabel}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? showLessText : showAllText}
            {expanded ? (
              <ChevronUp className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            )}
          </Button>
        ) : null}
      </div>
    </>
  )
}

export function LiteratureSidebarState({
  children
}: Readonly<{
  children: (collapsed: boolean, toggle: () => void) => React.JSX.Element
}>): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const toggleFromShortcut = (event: KeyboardEvent): void => {
      const isMac = window.api?.platform === 'darwin'
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.key.toLowerCase() !== 'b' ||
        !(isMac ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        document.querySelector(OPEN_DIALOG_SELECTOR) !== null
      ) {
        return
      }

      event.preventDefault()
      setCollapsed((current) => !current)
    }

    window.addEventListener('keydown', toggleFromShortcut)
    return () => window.removeEventListener('keydown', toggleFromShortcut)
  }, [])

  return (
    <TooltipProvider>
      {children(collapsed, () => setCollapsed((current) => !current))}
    </TooltipProvider>
  )
}
