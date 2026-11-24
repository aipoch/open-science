import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

import { ProviderKindIcon } from './provider-icons'
import type { ProviderKindAvailability } from './provider-form-value'
import {
  PROVIDER_PICKER_CATEGORIES,
  matchesProviderPickerQuery,
  providerPickerEntries,
  type ProviderPickerCategory,
  type ProviderPickerEntry
} from './provider-picker-catalog'
import { SettingsSearchInput } from './SettingsSearchInput'

const CATEGORY_LABEL_KEYS = {
  'sign-in': 'Account sign-in',
  vendor: 'Model vendors',
  'coding-plan': 'Coding plans',
  cloud: 'Cloud platforms',
  gateway: 'Gateways',
  local: 'Local'
} as const satisfies Record<ProviderPickerCategory, string>

type CategoryFilter = ProviderPickerCategory | 'all'

type ProviderKindPickerProps = ProviderKindAvailability & {
  // The kind matching the active agent framework, marked as recommended.
  recommendedKey?: string
  onSelect: (key: string) => void
}

const entryLabel = (entry: ProviderPickerEntry, t: TFunction): string => {
  if (entry.label) return entry.label
  if (!entry.kind) return entry.key
  return entry.kind.labelKey === undefined ? entry.kind.label : t(entry.kind.labelKey)
}

const entryDescription = (entry: ProviderPickerEntry, t: TFunction): string | undefined => {
  if (entry.disabled) return t('Already added')
  if (entry.host) {
    return entry.regionCount
      ? `${entry.host} · ${t('{{count}} regions', {
          count: entry.regionCount,
          defaultValue_one: '{{count}} region'
        })}`
      : entry.host
  }
  if (entry.kind?.descriptionKey) return t(entry.kind.descriptionKey)
  if (entry.category === 'sign-in') return t('Sign in with your CodeBuddy account')
  return undefined
}

const ProviderCard = ({
  entry,
  label,
  recommended,
  onClick
}: {
  entry: ProviderPickerEntry
  label: string
  recommended: boolean
  onClick: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const description = entryDescription(entry, t)

  return (
    <button
      type="button"
      data-slot="provider-picker-card"
      data-provider-kind={entry.key}
      disabled={entry.disabled}
      onClick={onClick}
      className="flex min-h-15 w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3 text-left text-card-foreground outline-none transition-[border-color,box-shadow,transform] duration-150 motion-reduce:transition-none active:translate-y-px focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0 [@media(hover:hover)]:enabled:hover:border-foreground/20 [@media(hover:hover)]:enabled:hover:shadow-sm"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
        <ProviderKindIcon kindKey={entry.iconKey ?? entry.key} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {recommended ? (
        <Badge variant="outline" className="text-muted-foreground">
          {t('Recommended')}
        </Badge>
      ) : null}
    </button>
  )
}

// First step of Add provider: search and pick a provider kind, then fill in its details. Categories
// filter in place instead of a second sidebar, which the Settings dialog has no room for.
const ProviderPicker = <Key extends string>({
  entries,
  recommendedKey,
  searchLabel,
  searchPlaceholder = searchLabel,
  onSelect
}: {
  entries: ProviderPickerEntry<Key>[]
  recommendedKey?: Key
  searchLabel: string
  searchPlaceholder?: string
  onSelect: (key: Key) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')

  const matches = entries
    .map((entry) => ({ entry, label: entryLabel(entry, t) }))
    .filter(({ entry, label }) => matchesProviderPickerQuery(entry, query, label))
  const sectioned = matches.filter(({ entry }) => entry.category !== 'custom')
  const custom = matches.filter(({ entry }) => entry.category === 'custom')
  const countFor = (id: ProviderPickerCategory): number =>
    sectioned.filter(({ entry }) => entry.category === id).length
  const visibleCategories = PROVIDER_PICKER_CATEGORIES.filter(
    (id) => (category === 'all' || category === id) && countFor(id) > 0
  )
  const firstMatch = [...(category === 'all' ? custom : []), ...sectioned].find(
    ({ entry }) => !entry.disabled && (category === 'all' || entry.category === category)
  )
  // Hide filters that would show nothing, but keep the active one so it can be cleared.
  const filterOptions: CategoryFilter[] = [
    'all',
    ...PROVIDER_PICKER_CATEGORIES.filter(
      (id) => category === id || entries.some((entry) => entry.category === id)
    )
  ]
  const renderCard = ({
    entry,
    label
  }: {
    entry: ProviderPickerEntry<Key>
    label: string
  }): React.JSX.Element => (
    <li key={entry.key} className="min-w-0">
      <ProviderCard
        entry={entry}
        label={label}
        recommended={entry.key === recommendedKey}
        onClick={() => onSelect(entry.key)}
      />
    </li>
  )
  const gridClassName = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2'

  return (
    <div data-slot="provider-picker" className="flex flex-col gap-4">
      <SettingsSearchInput
        autoFocus
        aria-label={searchLabel}
        placeholder={searchPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !query.trim()) return
          if (!firstMatch) return
          event.preventDefault()
          onSelect(firstMatch.entry.key)
        }}
      />

      <div role="group" aria-label={t('Provider category')} className="flex flex-wrap gap-1.5">
        {filterOptions.map((id) => {
          const selected = category === id
          const count = id === 'all' ? sectioned.length + custom.length : countFor(id)
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => setCategory(id)}
              className={cn(
                'inline-flex min-h-7 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:ring-3 focus-visible:ring-ring/50 [@media(hover:hover)]:hover:text-foreground',
                selected && 'border-foreground/30 bg-muted text-foreground'
              )}
            >
              {id === 'all' ? t('All') : t(CATEGORY_LABEL_KEYS[id])}
              <span className="tabular-nums text-muted-foreground">{count}</span>
            </button>
          )
        })}
      </div>

      {category === 'all' && custom.length > 0 ? (
        <ul className={gridClassName}>{custom.map(renderCard)}</ul>
      ) : null}

      {visibleCategories.map((id) => (
        <section key={id} aria-labelledby={`provider-picker-${id}`} className="space-y-2">
          <h3 id={`provider-picker-${id}`} className="text-xs font-medium text-muted-foreground">
            {t(CATEGORY_LABEL_KEYS[id])}
          </h3>
          <ul className={gridClassName}>
            {sectioned.filter(({ entry }) => entry.category === id).map(renderCard)}
          </ul>
        </section>
      ))}

      {visibleCategories.length === 0 && !(category === 'all' && custom.length > 0) ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">
            {t('No providers match your search.')}
          </p>
          {/* Anything not listed can still be reached through a custom gateway. */}
          <ul className={gridClassName}>
            {entries
              .filter((entry) => entry.category === 'custom')
              .map((entry) => renderCard({ entry, label: entryLabel(entry, t) }))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

const ProviderKindPicker = ({
  recommendedKey,
  onSelect,
  ...availability
}: ProviderKindPickerProps): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ProviderPicker
      entries={providerPickerEntries(availability)}
      recommendedKey={recommendedKey}
      searchLabel={t('Search providers')}
      searchPlaceholder={t('Search by name or website, e.g. kimi, openrouter')}
      onSelect={onSelect}
    />
  )
}

export const SelectedProviderCard = ({
  iconKey,
  label,
  description,
  disabled,
  onChange
}: {
  iconKey: string
  label?: string
  description?: string
  disabled?: boolean
  onChange: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('Provider type')}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-muted/30 p-3"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card">
        <ProviderKindIcon kindKey={iconKey} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={t('Change provider')}
        disabled={disabled}
        onClick={onChange}
      >
        {t('Change')}
      </Button>
    </div>
  )
}

export { ProviderKindPicker, ProviderPicker }
