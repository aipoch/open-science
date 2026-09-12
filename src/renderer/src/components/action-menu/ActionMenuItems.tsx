import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'

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

        if (entry.submenu) {
          const previous = entries[index - 1]
          if (previous?.kind === 'action' && previous.submenu === entry.submenu) return null
          const children: ResolvedActionMenuEntry<ActionId>[] = []
          for (const candidate of entries.slice(index)) {
            if (candidate.kind !== 'action' || candidate.submenu !== entry.submenu) break
            children.push({ ...candidate, submenu: undefined })
          }
          const GroupIcon = entry.submenu.icon
          return (
            <DropdownMenuSub key={`submenu-${index}`}>
              <DropdownMenuSubTrigger
                disabled={children.every((child) => child.kind === 'action' && child.disabled)}
                className={cn('gap-2', compact && 'h-6 min-h-0 rounded-md px-2 py-0 text-[12px]')}
              >
                <GroupIcon
                  className={cn(compact ? 'size-3.5' : 'size-4', 'shrink-0')}
                  aria-hidden="true"
                />
                {t(entry.submenu.labelKey)}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <ActionMenuItems
                  entries={children}
                  onSelect={onSelect}
                  compact={compact}
                  dangerClassName={dangerClassName}
                  renderLabel={renderLabel}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
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
