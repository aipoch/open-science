import { useId, type ReactNode } from 'react'
import { GalleryVerticalEnd, LoaderCircle, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// Callers own eligible Projects and the effect of choosing one. A selectedId opts into
// deferred radio selection; without one, each row is an immediate destination action.
export const ProjectPicker = ({
  projects,
  query,
  onQueryChange,
  onSelect,
  selectedId,
  pendingId,
  label,
  headerAction,
  loaded = true,
  disabled = false,
  alwaysShowSearch = false,
  emptyContent
}: {
  projects: readonly { id: string; name: string }[]
  query: string
  onQueryChange: (query: string) => void
  onSelect: (id: string) => void
  selectedId?: string
  pendingId?: string
  label?: string
  headerAction?: ReactNode
  loaded?: boolean
  disabled?: boolean
  alwaysShowSearch?: boolean
  emptyContent?: ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const groupId = useId()
  const showSearch = alwaysShowSearch || (loaded && projects.length > 5)
  const needle = showSearch ? query.trim().toLocaleLowerCase() : ''
  const visible = projects.filter((project) => project.name.toLocaleLowerCase().includes(needle))
  const selecting = selectedId !== undefined
  return (
    <div className="space-y-2">
      {selecting ? (
        <div className="flex min-h-9 items-center justify-between gap-3">
          <p className="min-w-0 text-sm font-medium">{label ?? t('Projects')}</p>
          {headerAction}
        </div>
      ) : null}
      {showSearch ? (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label={t('Search projects')}
            placeholder={t('Search projects…')}
            autoComplete="off"
            value={query}
            disabled={disabled}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            className="h-10 pl-8"
          />
        </div>
      ) : null}
      {!loaded ? (
        <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
          {t('Loading…')}
        </p>
      ) : !projects.length ? (
        (emptyContent ?? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t('No active projects')}</p>
        ))
      ) : !visible.length ? (
        <p role="status" className="px-2 py-3 text-sm text-muted-foreground">
          {t('No matching projects')}
        </p>
      ) : (
        <div
          role={selecting ? 'radiogroup' : 'group'}
          aria-label={label ?? t('Projects')}
          className={cn(
            'max-h-56 space-y-1 overflow-y-auto',
            selecting && 'rounded-2xl bg-bg-000 p-1.5 shadow-card'
          )}
        >
          {visible.map((project) =>
            selecting ? (
              <label
                key={project.id}
                className={cn(
                  'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm focus-within:outline-2 focus-within:outline-ring',
                  project.id === selectedId ? 'bg-primary/5' : 'hover:bg-bg-300',
                  disabled && 'opacity-50'
                )}
              >
                <GalleryVerticalEnd
                  className={cn(
                    'size-4 shrink-0',
                    project.id === selectedId ? 'text-primary' : 'text-muted-foreground'
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 break-words font-semibold text-text-000">
                  {project.name}
                </span>
                <input
                  type="radio"
                  name={groupId}
                  value={project.id}
                  checked={project.id === selectedId}
                  disabled={disabled}
                  onChange={() => onSelect(project.id)}
                  className="size-4 shrink-0 accent-primary"
                />
              </label>
            ) : (
              <button
                key={project.id}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(project.id)}
                className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
              >
                {pendingId === project.id ? (
                  <LoaderCircle
                    className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <GalleryVerticalEnd
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
