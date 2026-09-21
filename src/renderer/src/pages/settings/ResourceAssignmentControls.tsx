import { Bot, Check, ChevronDown, ChevronRight, Minus, Users } from 'lucide-react'
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
import type { SpecialistUsage } from './specialist-resource-scope'
import {
  canEditResourceAssignments,
  isResourceAssigned,
  type AssignableResource,
  type ResourceSpecialist
} from './resource-assignment'

// Keep role glyphs neutral; the compact corner badge carries the access state.
const AccessStatusIcon = ({
  enabled,
  children
}: {
  enabled: boolean
  children: React.ReactNode
}): React.JSX.Element => (
  <span className="relative inline-flex shrink-0 text-foreground/80">
    {children}
    <span
      aria-hidden="true"
      className={cn(
        'absolute -right-1 -bottom-1 flex size-2.5 items-center justify-center rounded-full text-white ring-1 ring-background',
        enabled ? 'bg-status-success-accent-foreground' : 'bg-zinc-600'
      )}
    >
      {enabled ? (
        <Check className="size-2" strokeWidth={3} />
      ) : (
        <Minus className="size-2" strokeWidth={3} />
      )}
    </span>
  </span>
)

export const ResourceAssignmentControls = ({
  resource,
  onSetMain,
  onErrorChange,
  onOpenSpecialist,
  disabled = false,
  mainBlocked = false
}: {
  resource: AssignableResource
  onSetMain: (enabled: boolean) => Promise<void>
  onErrorChange?: (failed: boolean) => void
  onOpenSpecialist?: (usage: SpecialistUsage) => void
  disabled?: boolean
  mainBlocked?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const items = useSpecialistStore((state) => state.items)
  const integrity = useSpecialistStore((state) => state.integrity)
  const loadError = useSpecialistStore((state) => state.loadError)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState(false)
  const profiles = items.filter((item): item is ResourceSpecialist => item.kind !== 'reviewer')
  const count = profiles.filter((item) => isResourceAssigned(item, resource)).length
  const label = resource.displayName ?? resource.name
  // Use the unfiltered count so typing never removes the search field.
  const showSearch = profiles.length > 5
  const term = showSearch ? query.trim().toLocaleLowerCase() : ''
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
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
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
          <span
            aria-label={
              resource.mainEnabled ? t('Available to Main Agent') : t('Unavailable to Main Agent')
            }
          >
            <AccessStatusIcon enabled={resource.mainEnabled}>
              <Bot className="size-4" aria-hidden="true" />
            </AccessStatusIcon>
          </span>
          <span className="inline-flex items-center gap-2 text-xs tabular-nums">
            <AccessStatusIcon enabled={count > 0}>
              <Users className="size-4" aria-hidden="true" />
            </AccessStatusIcon>
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
        {showSearch ? (
          <SettingsSearchInput
            aria-label={t('Search Specialists')}
            placeholder={t('Search Specialists')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        <div className="mt-2 max-h-64 overflow-y-auto overscroll-contain" aria-busy={busy}>
          <div className="flex items-center gap-2 rounded-lg pr-1 pl-3 py-3">
            <Bot className="size-5 shrink-0 text-foreground/80" aria-hidden="true" />
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
          {visible.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
              {/* Navigation and assignment are sibling controls, so opening details never toggles access. */}
              <button
                type="button"
                disabled={!onOpenSpecialist}
                aria-label={t('Open {{name}} in Specialist Settings', {
                  name: item.displayName?.trim() || item.name
                })}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                onClick={() => {
                  setOpen(false)
                  onOpenSpecialist?.({
                    id: item.id,
                    name: item.displayName?.trim() || item.name,
                    kind: item.kind,
                    ...(item.iconKey ? { iconKey: item.iconKey } : {}),
                    ...(item.colorKey ? { colorKey: item.colorKey } : {})
                  })
                }}
              >
                <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{item.displayName?.trim() || item.name}</p>
                  {!canEditResourceAssignments(item) ? (
                    <p className="text-xs text-muted-foreground">{t('Read-only')}</p>
                  ) : !item.enabled ? (
                    <p className="text-xs text-muted-foreground">{t('Disabled')}</p>
                  ) : null}
                </div>
                {onOpenSpecialist ? (
                  <ChevronRight
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
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
          {visible.length === 0 && term ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t('No Specialists match your search.')}
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
