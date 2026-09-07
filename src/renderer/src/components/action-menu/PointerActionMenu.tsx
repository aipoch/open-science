import { createPortal } from 'react-dom'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

import { ActionMenuItems, type ActionMenuLabelRenderer } from './ActionMenuItems'
import type { ResolvedActionMenuEntry } from './action-menu-model'

export const PointerActionMenu = <ActionId extends string>({
  entries,
  pointer,
  testId,
  contentClassName,
  compact,
  dangerClassName,
  renderLabel,
  onSelect,
  onClose,
  onRestoreFocus
}: {
  entries: readonly ResolvedActionMenuEntry<ActionId>[]
  pointer: { x: number; y: number }
  testId: string
  contentClassName?: string
  compact?: boolean
  dangerClassName?: string
  renderLabel?: ActionMenuLabelRenderer<ActionId>
  onSelect: (actionId: ActionId) => void
  onClose: () => void
  onRestoreFocus: () => void
}): React.JSX.Element =>
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
        align="start"
        sideOffset={0}
        className={cn('min-w-[9.5rem] p-1', contentClassName)}
        data-testid={testId}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
      >
        <ActionMenuItems
          entries={entries}
          onSelect={onSelect}
          compact={compact}
          dangerClassName={dangerClassName}
          renderLabel={renderLabel}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body
  )
