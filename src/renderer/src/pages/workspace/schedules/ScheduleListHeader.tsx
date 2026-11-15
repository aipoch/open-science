import { useRef } from 'react'
import { ChevronLeft, ListFilter, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export function ScheduleListHeader({
  onBack,
  onCreate,
  actions,
  query,
  onQuery,
  filters
}: {
  onBack: () => void
  onCreate: () => void
  actions?: React.ReactNode
  query: string | null
  onQuery: (query: string | null) => void
  filters: { label: string; checked: boolean; toggle: () => void }[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <header className="sticky top-0 z-10 mb-2 shrink-0 bg-rail-card-bg py-1">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label={t('Back')} onClick={onBack}>
          <ChevronLeft />
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-serif text-[15px] font-bold tracking-[-0.02em] text-text-000">
          {t('Schedule')}
        </h1>
        {actions}
      </div>
      <div className="mt-2 -mx-0.5 flex h-9 items-center gap-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm text-text-000 hover:bg-bg-300"
          onClick={onCreate}
        >
          <Plus className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span className="truncate">{t('New task')}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              className={
                filters.every((filter) => filter.checked)
                  ? 'relative text-muted-foreground'
                  : 'relative bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
              }
              aria-label={t('Filter by status')}
              title={t('Filter by status')}
            >
              <ListFilter className="size-3.5" />
              {!filters.every((filter) => filter.checked) && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-1 rounded-full bg-primary"
                />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuLabel>{t('Status')}</DropdownMenuLabel>
            {filters.map((filter) => (
              <DropdownMenuCheckboxItem
                key={filter.label}
                checked={filter.checked}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={filter.toggle}
              >
                {filter.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          ref={trigger}
          size="icon-sm"
          variant={query === null ? 'ghost' : 'secondary'}
          aria-label={t('Search scheduled tasks')}
          title={t('Search scheduled tasks')}
          aria-expanded={query !== null}
          onClick={() => onQuery(query === null ? '' : null)}
        >
          <Search className="size-3.5" />
        </Button>
      </div>
      {query !== null && (
        <div className="relative mt-2">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            type="search"
            className="rounded-full border-transparent bg-muted ps-8"
            placeholder={t('Search scheduled tasks')}
            aria-label={t('Search scheduled tasks')}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              onQuery(null)
              trigger.current?.focus()
            }}
          />
        </div>
      )}
    </header>
  )
}
