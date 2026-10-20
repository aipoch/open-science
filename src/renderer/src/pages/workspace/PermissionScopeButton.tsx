import { Check, ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type PermissionScope = 'once' | 'session' | 'project' | 'global'
type ScopeOption = { scope: PermissionScope; label: string; subtitle: string }

// Shared scope menu for permission cards and approval dialogs.
export const ScopeDropdown = ({
  selected,
  available,
  onSelect,
  onClose,
  portaled,
  onceDescription,
  className
}: {
  selected: PermissionScope
  available: Set<PermissionScope>
  onSelect: (scope: PermissionScope) => void
  onClose: (restoreTriggerFocus?: boolean) => void
  portaled: boolean
  onceDescription?: string
  className?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const scopeOptions: ScopeOption[] = [
    { scope: 'once', label: t('Once'), subtitle: t('This call only') },
    {
      scope: 'session',
      label: t('This conversation'),
      subtitle: t('Remembered for this conversation')
    },
    { scope: 'project', label: t('This project'), subtitle: t('Remembered for this project') },
    { scope: 'global', label: t('Global'), subtitle: t('Remembered across all projects') }
  ]
  const ref = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const options = scopeOptions.filter(({ scope }) => available.has(scope))
  const selectedIndex = options.findIndex(({ scope }) => scope === selected)

  useEffect(() => {
    itemRefs.current[selectedIndex]?.focus()
  }, [selectedIndex])

  useEffect(() => {
    if (portaled) return

    // Listen on `click` (not `mousedown`) so it pairs with the chevron's onClick toggle: the
    // chevron stops propagation, so its own click never reaches here and re-opens the menu.
    const onDocClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    // Escape dismisses the menu, matching the keyboard affordance implied by aria-haspopup.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose(true)
      }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, portaled])

  const items = (
    <>
      {options.map(({ scope, label, subtitle }, index) => (
        <button
          key={scope}
          ref={(item) => {
            itemRefs.current[index] = item
          }}
          type="button"
          role="menuitemradio"
          aria-checked={selected === scope}
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted',
            selected === scope && 'bg-muted'
          )}
          onClick={() => {
            onSelect(scope)
            onClose(true)
          }}
          onKeyDown={(event) => {
            const lastIndex = options.length - 1
            let nextIndex: number | undefined

            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(scope)
              onClose(true)
              return
            }
            if (event.key === 'ArrowDown') nextIndex = index === lastIndex ? 0 : index + 1
            if (event.key === 'ArrowUp') nextIndex = index === 0 ? lastIndex : index - 1
            if (event.key === 'Home') nextIndex = 0
            if (event.key === 'End') nextIndex = lastIndex

            if (nextIndex !== undefined) {
              event.preventDefault()
              itemRefs.current[nextIndex]?.focus()
            }
          }}
        >
          {/* Label column: left-aligned flush to padding so both rows line up */}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-xs font-medium text-foreground">{label}</span>
            <span className="text-[11px] leading-tight text-muted-foreground">
              {scope === 'once' && onceDescription ? onceDescription : subtitle}
            </span>
          </div>
          {/* Check column: right side, fixed slot so selection never shifts the label */}
          <span className="flex w-3.5 shrink-0 justify-center text-primary">
            {selected === scope ? <Check className="size-3.5" strokeWidth={2.5} /> : null}
          </span>
        </button>
      ))}
    </>
  )

  return portaled ? (
    <PopoverContent
      ref={ref}
      role="menu"
      aria-label={t('Authorization scope')}
      side="top"
      align="end"
      sideOffset={6}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={() => onClose(true)}
      className={cn(
        'min-w-44 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu',
        className
      )}
    >
      {items}
    </PopoverContent>
  ) : (
    <div
      ref={ref}
      role="menu"
      aria-label={t('Authorization scope')}
      className="absolute bottom-full right-0 z-10 mb-1.5 min-w-44 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-menu outline-none"
    >
      {items}
    </div>
  )
}

// Mount with the request ID as key: scope choices must never leak into another agent call.
export function PermissionScopeButton({
  available,
  disabled,
  onAllow
}: {
  available: readonly PermissionScope[]
  disabled: boolean
  onAllow: (scope: PermissionScope) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<PermissionScope>('session')
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => trigger.current?.focus())
  }, [])
  const fallback = available.includes('session')
    ? 'session'
    : available.includes('once')
      ? 'once'
      : available[0]
  const scope = available.includes(selected) ? selected : fallback
  const labels: Record<PermissionScope, string> = {
    once: t('Allow once'),
    session: t('Allow for this conversation'),
    project: t('Allow for this project'),
    global: t('Allow globally')
  }
  const style =
    'inline-flex h-8 items-center justify-center bg-primary text-primary-foreground hover:bg-primary/80 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="flex items-stretch overflow-hidden rounded-lg">
          <button
            type="button"
            className={cn(style, 'px-3 text-sm font-semibold')}
            disabled={disabled || !scope}
            onClick={() => {
              if (scope) onAllow(scope)
            }}
          >
            {scope ? labels[scope] : t('Allow once')}
          </button>
          {available.length > 1 ? (
            <button
              ref={trigger}
              type="button"
              aria-label={t('Choose authorization scope')}
              aria-haspopup="menu"
              aria-expanded={open && !disabled}
              disabled={disabled}
              className={cn(style, 'border-l border-primary-foreground/25 px-2')}
              onClick={() => setOpen(!open)}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </PopoverAnchor>
      {open && !disabled && scope ? (
        <ScopeDropdown
          portaled
          selected={scope}
          available={new Set(available)}
          onSelect={setSelected}
          onClose={close}
          className="z-[70]"
        />
      ) : null}
    </Popover>
  )
}
