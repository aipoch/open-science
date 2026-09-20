import { Bot, ChevronDown, SlidersHorizontal, Users } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSpecialistStore } from '@/stores/specialist-store'
import { cn } from '@/lib/utils'
import { setResourceAssignments } from './resource-assignment-actions'
import { SettingsToggle } from './SettingsLayout'
import { RequiredSkillToggle } from './RequiredSkillToggle'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SpecialistAvatar } from './specialist-avatar'
import {
  canEditResourceAssignments,
  isResourceAssigned,
  type AssignableResource,
  type ResourceSpecialist
} from './resource-assignment'

export const ResourceAssignmentControls = ({
  resource,
  onSetMain,
  onErrorChange,
  disabled = false,
  mainBlocked = false
}: {
  resource: AssignableResource
  onSetMain: (enabled: boolean) => Promise<void>
  onErrorChange?: (failed: boolean) => void
  disabled?: boolean
  mainBlocked?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const items = useSpecialistStore((state) => state.items)
  const integrity = useSpecialistStore((state) => state.integrity)
  const loadError = useSpecialistStore((state) => state.loadError)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState(false)
  const profiles = items.filter((item): item is ResourceSpecialist => item.kind !== 'reviewer')
  const count = profiles.filter((item) => isResourceAssigned(item, resource)).length
  const label = resource.displayName ?? resource.name
  const term = query.trim().toLocaleLowerCase()
  const visible = profiles.filter((item) =>
    `${item.displayName ?? ''} ${item.name}`.toLocaleLowerCase().includes(term)
  )
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(false)
    onErrorChange?.(false)
    try {
      await action()
    } catch {
      setError(true)
      // A filtered row may already be unmounted after the optimistic Main Agent update.
      onErrorChange?.(true)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Popover
      onOpenChange={() => {
        setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={t('Manage access for {{name}}', { name: label })}
          className="gap-2 rounded-lg border border-transparent px-2 text-muted-foreground hover:border-border hover:bg-muted/60"
          data-slot="resource-assignment-trigger"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          <Bot
            aria-label={
              resource.mainEnabled ? t('Available to Main Agent') : t('Unavailable to Main Agent')
            }
            className={cn('size-4', resource.mainEnabled && 'text-primary')}
          />
          <span
            className={cn(
              'inline-flex items-center gap-1 text-xs tabular-nums',
              count > 0 && 'text-blue-600 dark:text-blue-400'
            )}
          >
            <Users className="size-3.5" aria-hidden="true" />
            {count}
          </span>
          <ChevronDown className="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      >
        <p className="mb-2 truncate text-sm font-medium">{label}</p>
        <SettingsSearchInput
          aria-label={t('Search agents')}
          placeholder={t('Search agents')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-2 max-h-64 overflow-y-auto overscroll-contain" aria-busy={busy}>
          {t('Main Agent').toLocaleLowerCase().includes(term) ? (
            <div className="flex items-center gap-2 rounded-lg px-1 py-3">
              <Bot className="size-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm">{t('Main Agent')}</p>
                {resource.mainRequired ? (
                  <p className="text-xs text-muted-foreground">{t('Always enabled')}</p>
                ) : mainBlocked ? (
                  <p className="text-xs text-muted-foreground">
                    {t('Sign in or configure credentials first.')}
                  </p>
                ) : null}
              </div>
              {resource.mainRequired ? (
                <RequiredSkillToggle label={t('Main Agent')} />
              ) : (
                <SettingsToggle
                  aria-label={t('Main Agent')}
                  enabled={resource.mainEnabled}
                  disabled={busy || resource.mainRequired || mainBlocked}
                  onToggle={() => void run(() => onSetMain(!resource.mainEnabled))}
                />
              )}
            </div>
          ) : null}
          {visible.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg px-1 py-3">
              <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{item.displayName?.trim() || item.name}</p>
                {!canEditResourceAssignments(item) ? (
                  <p className="text-xs text-muted-foreground">{t('Read-only')}</p>
                ) : !item.enabled ? (
                  <p className="text-xs text-muted-foreground">{t('Disabled')}</p>
                ) : null}
              </div>
              <SettingsToggle
                aria-label={item.displayName?.trim() || item.name}
                enabled={isResourceAssigned(item, resource)}
                disabled={
                  busy ||
                  !canEditResourceAssignments(item) ||
                  integrity.status !== 'ok' ||
                  Boolean(loadError)
                }
                onToggle={() =>
                  void run(() =>
                    setResourceAssignments([resource], !isResourceAssigned(item, resource), item.id)
                  )
                }
              />
            </div>
          ))}
          {visible.length === 0 && !t('Main Agent').toLocaleLowerCase().includes(term) ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t('No agents match your search.')}
            </p>
          ) : null}
        </div>
        {(error && !onErrorChange) || loadError || integrity.status !== 'ok' ? (
          <ErrorNotice
            inline
            role="alert"
            tone="amber"
            description={t('Could not update resource access. Refresh and try again.')}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
