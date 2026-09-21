import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NativeActionMenu } from './NativeActionMenu'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { ActionMenuItems, type ActionMenuLabelRenderer } from './ActionMenuItems'
import type { ResolvedActionMenuEntry } from './action-menu-model'

export type PointerActionMenuProps<ActionId extends string> = {
  entries: readonly ResolvedActionMenuEntry<ActionId>[]
  pointer: { x: number; y: number }
  testId: string
  align?: 'start' | 'end'
  focusFirst?: boolean
  header?: ReactNode
  label?: string
  sections?: Record<string, string>
  contentClassName?: string
  compact?: boolean
  dangerClassName?: string
  renderLabel?: ActionMenuLabelRenderer<ActionId>
  onSelect: (actionId: ActionId) => void
  onClose: () => void
  onRestoreFocus: () => void
}

export const PointerActionMenu = <ActionId extends string>(
  props: PointerActionMenuProps<ActionId>
): React.JSX.Element =>
  window.api?.window?.openActionMenu && window.api.window.onActionMenuClosed ? (
    <NativeActionMenu {...props} />
  ) : (
    <DomPointerActionMenu {...props} />
  )

export const DomPointerActionMenu = <ActionId extends string>({
  entries,
  header,
  align = 'start',
  focusFirst,
  label,
  sections,
  pointer,
  testId,
  contentClassName,
  compact,
  dangerClassName,
  renderLabel,
  onSelect,
  onClose,
  onRestoreFocus
}: PointerActionMenuProps<ActionId>): React.JSX.Element =>
  createPortal(
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (open) return
        onClose()
        queueMicrotask(onRestoreFocus)
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          data-testid={`${testId}-anchor`}
          className="pointer-events-none fixed size-0"
          style={{ left: pointer.x, top: pointer.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        align={align}
        onFocus={
          focusFirst
            ? (event) => {
                if (event.target !== event.currentTarget) return
                event.currentTarget
                  .querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
                  ?.focus()
              }
            : undefined
        }
        sideOffset={0}
        className={cn('min-w-[9.5rem] p-1', contentClassName)}
        data-testid={testId}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
      >
        {header}
        <ActionMenuItems
          entries={entries}
          sections={sections}
          onSelect={onSelect}
          compact={compact}
          dangerClassName={dangerClassName}
          renderLabel={renderLabel}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body
  )
