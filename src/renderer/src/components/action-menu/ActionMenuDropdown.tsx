import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Slot } from 'radix-ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ActionMenuItems, type ActionMenuLabelRenderer } from './ActionMenuItems'
import { PointerActionMenu } from './PointerActionMenu'
import type { ResolvedActionMenuEntry } from './action-menu-model'

// Button menus use the same native surface as pointer menus; the browser retains its Radix portal.
export const ActionMenuDropdown = <ActionId extends string>({
  children,
  entries,
  onSelect,
  onOpenChange,
  renderLabel,
  compact = false,
  contentClassName,
  header,
  label,
  sections,
  dangerClassName,
  side = 'bottom',
  align = 'end',
  sideOffset = 4
}: {
  children: ReactElement
  entries: readonly ResolvedActionMenuEntry<ActionId>[]
  onSelect: (action: ActionId) => void
  onOpenChange?: (open: boolean) => void
  renderLabel?: ActionMenuLabelRenderer<ActionId>
  compact?: boolean
  contentClassName?: string
  header?: ReactNode
  label?: string
  sections?: Record<string, string>
  dangerClassName?: string
  side?: 'right' | 'bottom'
  align?: 'start' | 'end'
  sideOffset?: number
}): React.JSX.Element => {
  const [pointer, setPointer] = useState<{ x: number; y: number }>()
  const [focusFirst, setFocusFirst] = useState(false)
  const trigger = useRef<HTMLElement>(null)
  const native = !!window.api?.window?.openActionMenu && !!window.api.window.onActionMenuClosed
  const close = (): void => {
    setPointer(undefined)
    onOpenChange?.(false)
  }
  const open = (keyboard: boolean): void => {
    setFocusFirst(keyboard)
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    setPointer({
      x: side === 'right' ? rect.right + sideOffset : align === 'end' ? rect.right : rect.left,
      y: side === 'right' ? rect.top : rect.bottom + sideOffset
    })
    onOpenChange?.(true)
  }
  if (native)
    return (
      <>
        <Slot.Root
          ref={trigger}
          aria-haspopup="menu"
          aria-expanded={!!pointer}
          data-state={pointer ? 'open' : 'closed'}
          onClick={(event) => open(event.detail === 0)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              open(true)
            }
          }}
        >
          {children}
        </Slot.Root>
        {pointer ? (
          <PointerActionMenu
            entries={entries}
            pointer={pointer}
            compact={compact}
            testId="action-menu"
            contentClassName={contentClassName}
            renderLabel={renderLabel}
            header={header}
            label={label}
            sections={sections}
            align={side === 'right' ? 'start' : align}
            focusFirst={focusFirst}
            dangerClassName={dangerClassName}
            onSelect={onSelect}
            onClose={close}
            onRestoreFocus={() => trigger.current?.focus()}
          />
        ) : null}
      </>
    )
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        side={side}
        align={align}
        sideOffset={sideOffset}
        className={contentClassName}
      >
        {header}
        <ActionMenuItems
          entries={entries}
          sections={sections}
          dangerClassName={dangerClassName}
          compact={compact}
          renderLabel={renderLabel}
          onSelect={onSelect}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
