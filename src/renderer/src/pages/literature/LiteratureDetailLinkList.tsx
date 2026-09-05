import * as Checkbox from '@radix-ui/react-checkbox'
import { Check, Search } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const SEARCH_THRESHOLD = 5

type LiteratureDetailLinkEntry = Readonly<{
  id: string
  name: string
}>

type LiteratureDetailLinkListProps = Readonly<{
  checkedIds: readonly string[]
  entries: readonly LiteratureDetailLinkEntry[]
  error?: string
  kind: 'collections' | 'projects'
  loaded?: boolean
  onCheckedChange: (id: string, checked: boolean) => Promise<boolean>
}>

const DetailLinkCheckbox = ({
  checked,
  entry,
  onCheckedChange
}: Readonly<{
  checked: boolean
  entry: LiteratureDetailLinkEntry
  onCheckedChange: (id: string, checked: boolean) => Promise<boolean>
}>): React.JSX.Element => {
  const [optimisticChecked, setOptimisticChecked] = useState(checked)
  const [pending, setPending] = useState(false)

  return (
    <Checkbox.Root
      checked={pending ? optimisticChecked : checked}
      disabled={pending}
      aria-busy={pending}
      onCheckedChange={(nextChecked) => {
        if (pending || nextChecked === 'indeterminate') return
        setOptimisticChecked(nextChecked)
        setPending(true)
        void onCheckedChange(entry.id, nextChecked).then(
          () => setPending(false),
          () => setPending(false)
        )
      }}
      className="group flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted/80 disabled:cursor-wait motion-reduce:transition-none"
    >
      <span className="flex size-4 shrink-0 items-center justify-center rounded border border-border-100 bg-bg-000 text-text-000 group-data-[state=checked]:border-text-000">
        <Checkbox.Indicator>
          <Check className="size-3" aria-hidden="true" />
        </Checkbox.Indicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
    </Checkbox.Root>
  )
}

const LiteratureDetailLinkList = ({
  checkedIds,
  entries,
  error,
  kind,
  loaded = true,
  onCheckedChange
}: LiteratureDetailLinkListProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const normalizedQuery = entries.length > SEARCH_THRESHOLD ? query.trim().toLocaleLowerCase() : ''
  const visibleEntries = normalizedQuery
    ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery))
    : entries
  const isProjects = kind === 'projects'

  return (
    <>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger-000">
          {error}
        </p>
      ) : null}
      {entries.length > SEARCH_THRESHOLD ? (
        <div className="relative mt-3">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={isProjects ? t('Search projects') : t('Search collections')}
            placeholder={isProjects ? t('Search projects…') : t('Search collections…')}
            value={query}
            autoComplete="off"
            className="h-8 pl-8"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
      ) : null}
      {visibleEntries.length > 0 ? (
        <div
          className={cn(
            'mt-2 grid gap-1',
            entries.length > SEARCH_THRESHOLD && 'max-h-56 overflow-y-auto pr-1'
          )}
        >
          {visibleEntries.map((entry) => (
            <DetailLinkCheckbox
              key={entry.id}
              checked={checkedIds.includes(entry.id)}
              entry={entry}
              onCheckedChange={onCheckedChange}
            />
          ))}
        </div>
      ) : !loaded ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {t('Loading…')}
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {isProjects ? t('No active projects') : t('No collections')}
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {isProjects ? t('No matching projects') : t('No matching collections')}
        </p>
      )}
    </>
  )
}

export { LiteratureDetailLinkList }
