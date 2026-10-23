import { createPortal } from 'react-dom'
import { NativeActionMenu } from './NativeActionMenu'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { ActionMenuItems } from './ActionMenuItems'
import type { PointerActionMenuProps } from './action-menu-presentation'

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
  side = 'bottom',
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
        side={side}
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
