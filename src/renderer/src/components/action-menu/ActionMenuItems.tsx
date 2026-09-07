import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'

import type { ResolvedActionMenuAction, ResolvedActionMenuEntry } from './action-menu-model'

export type ActionMenuLabelRenderer<ActionId extends string> = (
  entry: ResolvedActionMenuAction<ActionId>,
  translatedLabel: string
) => ReactNode

export const ActionMenuItems = <ActionId extends string>({
  entries,
  onSelect,
  compact = true,
  dangerClassName,
  renderLabel
}: {
  entries: readonly ResolvedActionMenuEntry<ActionId>[]
  onSelect: (actionId: ActionId) => void
  compact?: boolean
  dangerClassName?: string
  renderLabel?: ActionMenuLabelRenderer<ActionId>
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') {
          return <DropdownMenuSeparator key={`separator-${index}`} />
        }

        const Icon = entry.icon
        return (
          <DropdownMenuItem
            key={entry.action}
            data-action-id={entry.action}
            disabled={entry.disabled}
            className={cn(
              'gap-2',
              compact && 'min-h-0 h-6 rounded-md px-2 py-0 text-[12px]',
              entry.danger &&
                (dangerClassName ??
                  'text-danger-000 data-[highlighted]:bg-danger-000/10 data-[highlighted]:text-danger-000')
            )}
            onSelect={() => onSelect(entry.action)}
          >
            <Icon className={cn(compact ? 'size-3.5' : 'size-4', 'shrink-0')} aria-hidden="true" />
            {renderLabel?.(entry, t(entry.labelKey)) ?? t(entry.labelKey)}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
