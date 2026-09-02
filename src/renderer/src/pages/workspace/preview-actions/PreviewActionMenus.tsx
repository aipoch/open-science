import { Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

type PreviewMenuActionPresentation = {
  kind: 'action'
  labelKey: string
  icon: LucideIcon
  danger: boolean
  disabled: boolean
}

type PreviewMenuDataAttribute = 'capability' | 'command'

export const PreviewMenuItems = <
  Action extends PreviewMenuActionPresentation,
  ActionId extends string
>({
  entries,
  getActionId,
  onSelect,
  dataAttribute = 'capability',
  compact = true,
  renderSeparator,
  renderLabel
}: {
  entries: readonly (Action | { kind: 'separator' })[]
  getActionId: (action: Action) => ActionId
  onSelect: (actionId: ActionId) => void
  dataAttribute?: PreviewMenuDataAttribute
  compact?: boolean
  renderSeparator?: (index: number) => React.ReactNode
  renderLabel?: (action: Action, translatedLabel: string) => React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') {
          return renderSeparator ? (
            <Fragment key={`separator-${index}`}>{renderSeparator(index)}</Fragment>
          ) : (
            <DropdownMenuSeparator key={`separator-${index}`} />
          )
        }

        const Icon = entry.icon
        const actionId = getActionId(entry)
        const dataProps =
          dataAttribute === 'command'
            ? { 'data-command': actionId }
            : { 'data-capability': actionId }
        return (
          <DropdownMenuItem
            key={actionId}
            {...dataProps}
            disabled={entry.disabled}
            className={cn(
              'gap-2',
              compact && 'min-h-0 h-6 rounded-md px-2 py-0 text-[12px]',
              entry.danger &&
                'text-danger-000 data-[highlighted]:bg-danger-000/10 data-[highlighted]:text-danger-000'
            )}
            onSelect={() => onSelect(actionId)}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            {renderLabel?.(entry, t(entry.labelKey)) ?? t(entry.labelKey)}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

export const PreviewPointerMenu = <
  Action extends PreviewMenuActionPresentation,
  ActionId extends string
>({
  entries,
  getActionId,
  pointer,
  testId,
  onSelect,
  onClose,
  onRestoreFocus,
  dataAttribute = 'capability'
}: {
  entries: readonly (Action | { kind: 'separator' })[]
  getActionId: (action: Action) => ActionId
  pointer: { x: number; y: number }
  testId: string
  onSelect: (actionId: ActionId) => void
  onClose: () => void
  onRestoreFocus: () => void
  dataAttribute?: PreviewMenuDataAttribute
}): React.JSX.Element =>
  createPortal(
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
          queueMicrotask(onRestoreFocus)
        }
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
        className="min-w-[9.5rem] p-1"
        data-testid={testId}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
      >
        <PreviewMenuItems
          entries={entries}
          getActionId={getActionId}
          onSelect={onSelect}
          dataAttribute={dataAttribute}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body
  )
