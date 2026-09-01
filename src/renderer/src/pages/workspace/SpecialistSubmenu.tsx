// SpecialistSubmenu — composer menu submenu for selecting a Personal Specialist.
// Renders as a DropdownMenuSub inside ComposerAgentControlsMenu: hover the trigger
// (icon + "Specialist" + current-value capsule) and None / enabled Personal
// Specialists / "Create new…" expand to the side. Never shows Reviewer or disabled
// specialists (except the currently-bound unavailable one, shown struck-through).

import { Check, ChevronRight, UserRound } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { AgentControlMenuItemTooltip } from './AgentControlMenuItemTooltip'

import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem, SpecialistView } from '../../../../shared/specialist'

type RunnableSpecialistItem = Exclude<SpecialistListItem, { kind: 'reviewer' }>

type SpecialistSubmenuProps = {
  // Undefined means None (no specialist selected).
  selectedId: string | undefined
  onChange: (specialistId: string | undefined) => void
  // Shows an "unavailable" capsule when the selected specialist is disabled/deleted.
  unavailable?: boolean
  // A bound session shows its identity in the trigger without a mutable submenu.
  readOnly?: boolean
}

// Short label for the trigger capsule: truncated name when selected, "None" or
// "Unavailable" otherwise. Kept compact so the trigger never wraps. Takes the
// resolved strings rather than calling t() so it stays a pure helper.
const capsuleLabel = (
  selected: SpecialistView | undefined,
  unavailable: boolean,
  labels: { none: string; unavailable: string }
): string => {
  if (unavailable) return labels.unavailable
  if (selected) return selected.name
  return labels.none
}

const SpecialistSubmenu = ({
  selectedId,
  onChange,
  unavailable = false,
  readOnly = false
}: SpecialistSubmenuProps): React.JSX.Element => {
  const { t } = useTranslation()
  const items = useSpecialistStore((state) => state.items)
  const isLoaded = useSpecialistStore((state) => state.isLoaded)
  const load = useSpecialistStore((state) => state.load)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)

  // Lazy-load on mount. This submenu only mounts when the parent menu opens
  // (DropdownMenuContent mounts its children on open), so this is open-time load.
  useEffect(() => {
    if (!isLoaded && typeof window.api?.specialist?.list === 'function') {
      void load()
    }
  }, [isLoaded, load])

  // Keep the list fresh when the specialist catalog changes elsewhere.
  useEffect(() => {
    if (typeof window.api?.specialist?.onCatalogChanged !== 'function') return
    const remove = window.api.specialist.onCatalogChanged(() => {
      void load()
    })
    return remove
  }, [load])

  const enabledSpecialists = items.filter(
    (item): item is RunnableSpecialistItem => item.kind !== 'reviewer' && item.enabled
  )

  const selected = enabledSpecialists.find((s) => s.id === selectedId)
  const isNone = selectedId === undefined

  const label = capsuleLabel(selected, unavailable, {
    none: t('None'),
    unavailable: t('Unavailable')
  })
  // When the selected specialist is unavailable, keep it visible in the list as struck-through so
  // the user understands which profile is bound. Only applies to the currently-bound unavailable
  // profile; other disabled profiles stay out of the picker as normal.
  const unavailableItem =
    unavailable && selectedId
      ? items.find((item) => item.kind !== 'reviewer' && item.id === selectedId)
      : undefined
  const unavailableProfile = unavailableItem?.kind !== 'reviewer' ? unavailableItem : undefined

  return (
    <DropdownMenuSub>
      <AgentControlMenuItemTooltip
        description={t('Bind a personal specialist to this conversation.')}
        disabled={readOnly}
        submenu
      >
        <DropdownMenuSubTrigger
          disabled={readOnly}
          className="items-center gap-2 px-2 py-1.5"
          data-testid="specialist-submenu-trigger"
        >
          <UserRound
            className={cn(
              'size-4 shrink-0 text-text-200',
              unavailable && 'text-amber-600 dark:text-amber-400'
            )}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5">
            {t('Specialist')}
          </span>
          {/* Value capsule mirrors the permission-mode capsule: current selection on the right. */}
          <span
            className={cn(
              'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
              unavailable
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-bg-200 text-text-100'
            )}
          >
            <span className="max-w-[120px] truncate">{label}</span>
            {!readOnly ? (
              <ChevronRight
                className="size-3 shrink-0 opacity-60"
                strokeWidth={2}
                aria-hidden="true"
              />
            ) : null}
          </span>
        </DropdownMenuSubTrigger>
      </AgentControlMenuItemTooltip>

      {!readOnly ? (
        <DropdownMenuSubContent className="w-56 p-1">
          {/* None option */}
          <DropdownMenuItem
            onSelect={() => onChange(undefined)}
            className="items-center gap-2 px-2 py-1.5"
            data-testid="specialist-option-none"
          >
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded bg-bg-300 text-[11px] text-text-300"
              aria-hidden="true"
            >
              —
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{t('None')}</span>
            {isNone && !unavailable ? (
              <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>

          {/* Enabled Personal Specialists (plus the unavailable bound profile if any) */}
          {isLoaded && (enabledSpecialists.length > 0 || unavailableProfile) ? (
            <>
              <DropdownMenuSeparator />
              {/* Unavailable bound specialist: struck-through/dimmed, not selectable.
                  Only the currently-bound unavailable profile appears here; other disabled
                  profiles are excluded from the picker as normal. */}
              {unavailableProfile ? (
                <div
                  className="flex cursor-not-allowed items-center gap-2 rounded-sm px-2 py-1.5 opacity-35"
                  data-testid={`specialist-option-${unavailableProfile.id}`}
                  aria-disabled="true"
                >
                  <span
                    className="flex size-5 shrink-0 items-center justify-center rounded bg-bg-300 text-[11px] font-medium"
                    aria-hidden="true"
                  >
                    {unavailableProfile.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] line-through">
                    {unavailableProfile.name}
                  </span>
                  <span className="text-[10px] text-amber-500">{t('Unavailable')}</span>
                </div>
              ) : null}
              {enabledSpecialists.map((specialist) => {
                const isSelected = specialist.id === selectedId
                return (
                  <DropdownMenuItem
                    key={specialist.id}
                    onSelect={() => onChange(specialist.id)}
                    className="items-center gap-2 px-2 py-1.5"
                    data-testid={`specialist-option-${specialist.id}`}
                  >
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded bg-bg-300 text-[11px] font-medium"
                      aria-hidden="true"
                    >
                      {specialist.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{specialist.name}</span>
                    {isSelected ? (
                      <Check
                        className="size-4 shrink-0 text-primary"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
            </>
          ) : null}

          <DropdownMenuSeparator />

          {/* Create new entry point */}
          <DropdownMenuItem
            onSelect={() => openSettingsToPanel('specialists')}
            className="items-center gap-2 px-2 py-1.5 text-[13px] text-text-200"
            data-testid="specialist-option-create"
          >
            {t('Create new…')}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      ) : null}
    </DropdownMenuSub>
  )
}

export { SpecialistSubmenu }
