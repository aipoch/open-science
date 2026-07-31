import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { AlertDialog } from 'radix-ui'
import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsToggle } from './SettingsLayout'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { CreateSpecialistInput } from '../../../../shared/specialist'
import { SpecialistEditor } from './SpecialistEditor'
import { SpecialistAvatar } from './specialist-avatar'

// Sub-view for the Specialists panel (parallels SkillsView).
export type SpecialistsView =
  | { kind: 'list' }
  | { kind: 'create'; draft?: CreateSpecialistInput }
  | { kind: 'edit'; id: string }

type CategoryFilter = 'all' | 'custom' | 'builtin'

const FILTER_LABELS: Record<CategoryFilter, string> = {
  all: 'All',
  custom: 'Custom',
  builtin: 'Built-in'
}

type SpecialistsPanelProps = {
  view: SpecialistsView
  onNavigate: (view: SpecialistsView) => void
}

const SpecialistsPanel = ({ view, onNavigate }: SpecialistsPanelProps): React.JSX.Element => {
  const items = useSpecialistStore((s) => s.items)
  const isLoaded = useSpecialistStore((s) => s.isLoaded)
  const load = useSpecialistStore((s) => s.load)
  const setEnabled = useSpecialistStore((s) => s.setEnabled)
  const createSpecialist = useSpecialistStore((s) => s.create)
  const updateSpecialist = useSpecialistStore((s) => s.update)
  const deleteSpecialist = useSpecialistStore((s) => s.delete)
  const duplicateSpecialist = useSpecialistStore((s) => s.duplicate)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [query, setQuery] = useState('')
  const [deletingItem, setDeletingItem] = useState<{
    id: string
    revision: number
    name: string
  } | null>(null)
  const [deleteError, setDeleteError] = useState<string | undefined>()

  // Memoised so visibleCustomItems' memo can reference a stable value.
  const customItems = useMemo(() => items.filter((i) => i.kind === 'custom'), [items])

  useEffect(() => {
    void load()

    // Subscribe to catalog-changed push events so the list stays in sync.
    const unsub = window.api.specialist.onCatalogChanged(() => void load())
    return unsub
  }, [load])

  // Separate Custom vs Built-in (Reviewer) items.
  const reviewerItems = items.filter((i) => i.kind === 'reviewer')
  const visibleCustomItems = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (filter === 'builtin') return []
    if (!term) return customItems
    return customItems.filter(
      (item) =>
        (item.displayName ?? item.name).toLowerCase().includes(term) ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term)
    )
  }, [customItems, filter, query])
  const visibleReviewerItems = useMemo(() => {
    if (filter === 'custom') return []
    const term = query.trim().toLowerCase()
    if (!term || 'reviewer used by auto-review'.includes(term)) return reviewerItems
    return []
  }, [filter, query, reviewerItems])

  if (view.kind === 'create') {
    return (
      <SpecialistEditor
        existingNames={customItems.map((item) => item.name)}
        initialInput={view.draft}
        onCancel={() => onNavigate({ kind: 'list' })}
        onSave={async (input: CreateSpecialistInput) => {
          await createSpecialist(input)
          onNavigate({ kind: 'list' })
        }}
      />
    )
  }

  if (view.kind === 'edit') {
    // Reuse the create editor prefilled from the stored profile. Capabilities
    // stay informational; only identity/instructions are editable here.
    const specialist = customItems.find((item) => item.kind === 'custom' && item.id === view.id)
    if (specialist && specialist.kind === 'custom') {
      return (
        <SpecialistEditor
          key={specialist.id}
          editSpecialist={specialist}
          existingNames={customItems.filter((item) => item.id !== view.id).map((item) => item.name)}
          onCancel={() => onNavigate({ kind: 'list' })}
          onSave={async () => onNavigate({ kind: 'list' })}
          onSaveEdit={async (input) => {
            await updateSpecialist(input)
            onNavigate({ kind: 'list' })
          }}
          onReload={async () => {
            // Load the fresh list and read the result from the store directly —
            // not from the render closure, which captured the pre-load items.
            await load()
            const refreshed = useSpecialistStore
              .getState()
              .items.find((item) => item.kind === 'custom' && item.id === view.id)
            if (refreshed && refreshed.kind === 'custom') return refreshed
            return undefined
          }}
        />
      )
    }
    // Profile no longer exists (deleted/stale) — fall through to the list.
  }

  return (
    <div className="p-5">
      {/* Toolbar */}
      <div className="mb-4 flex items-center gap-2">
        <div
          className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
          role="tablist"
          aria-label="Filter specialists by category"
        >
          {(['all', 'custom', 'builtin'] as const).map((key) => {
            const count =
              key === 'all'
                ? items.length
                : key === 'custom'
                  ? customItems.length
                  : reviewerItems.length
            const active = filter === key
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(key)}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none ${
                  active
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {FILTER_LABELS[key]}
                <span className="tabular-nums text-muted-foreground">({count})</span>
              </button>
            )
          })}
        </div>
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search specialists"
            placeholder="Search specialists…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="shrink-0">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add specialist
              <ChevronDown data-icon="inline-end" className="opacity-70" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="gap-2.5" onSelect={() => onNavigate({ kind: 'create' })}>
              <Pencil className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span>Write from scratch</span>
                <span className="text-xs text-muted-foreground">
                  Configure instructions and capabilities yourself
                </span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!isLoaded ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Custom specialists group */}
          {filter !== 'builtin' ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Custom</span>
                <span className="text-xs text-muted-foreground">Created by you.</span>
              </div>

              {visibleCustomItems.length > 0 ? (
                <ul className="mt-2 flex flex-col divide-y divide-border">
                  {visibleCustomItems.map((item) => {
                    if (item.kind !== 'custom') return null
                    return (
                      <li
                        key={item.id}
                        data-slot="settings-list-row"
                        className="flex min-h-14 items-center gap-2 py-2.5"
                      >
                        {/* Click the row body to open the editor (prefilled) */}
                        <button
                          type="button"
                          onClick={() => onNavigate({ kind: 'edit', id: item.id })}
                          aria-label={`Edit ${item.displayName ?? item.name}`}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {/* Avatar */}
                          <SpecialistAvatar iconKey={item.iconKey} colorKey={item.colorKey} />

                          {/* Body: name + description */}
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-foreground">
                              {item.displayName ?? item.name}
                            </span>
                            {item.description ? (
                              <span className="block truncate text-xs text-muted-foreground">
                                {item.description}
                              </span>
                            ) : null}
                            <span className="block text-[11px] text-muted-foreground">
                              {item.capabilityMode === 'full'
                                ? 'Full access'
                                : 'Selected capabilities'}
                            </span>
                          </div>
                        </button>

                        {/* Enabled toggle */}
                        <SettingsToggle
                          enabled={item.enabled}
                          aria-label={`Toggle ${item.displayName ?? item.name}`}
                          onToggle={() => void setEnabled(item.id, !item.enabled)}
                        />
                        <DropdownMenu>
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Actions for ${item.displayName ?? item.name}`}
                                  >
                                    <ChevronDown aria-hidden="true" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </TooltipTrigger>
                              <TooltipContent>
                                Actions for {item.displayName ?? item.name}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="gap-2 text-xs"
                              onSelect={() =>
                                void duplicateSpecialist(item.id).then((draft) =>
                                  onNavigate({ kind: 'create', draft })
                                )
                              }
                            >
                              <Copy className="size-3.5" aria-hidden="true" /> Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="gap-2 text-xs text-destructive"
                              onSelect={() =>
                                setDeletingItem({
                                  id: item.id,
                                  revision: item.revision,
                                  name: item.displayName ?? item.name
                                })
                              }
                            >
                              <Trash2 className="size-3.5" aria-hidden="true" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="mt-2 py-2 text-xs text-muted-foreground">
                  No specialists yet. Use &ldquo;Add specialist&rdquo; to create one.
                </p>
              )}
            </div>
          ) : null}

          {/* Built-in group (Reviewer only) */}
          {visibleReviewerItems.length > 0 ? (
            <div>
              <div className="mb-1 flex flex-col gap-0.5">
                <span className="text-sm font-semibold text-foreground">Built-in</span>
                <span className="text-xs text-muted-foreground">
                  Shipped with the app. Not configurable.
                </span>
              </div>
              <ul className="mt-2 flex flex-col divide-y divide-border">
                {visibleReviewerItems.map(() => (
                  <li
                    key="reviewer"
                    data-slot="settings-list-row"
                    className="flex min-h-14 items-center gap-2 py-2.5"
                  >
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[13px] text-primary"
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">Reviewer</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        Used by Auto-review
                      </span>
                    </div>
                    {/* No toggle, no actions for Reviewer */}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog.Root
        open={deletingItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingItem(null)
            setDeleteError(undefined)
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))]')}>
            <AlertDialog.Title className={dialogTitleClassName}>
              Delete {deletingItem?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              This will permanently remove this specialist and all its configurations. This action
              cannot be undone.
            </AlertDialog.Description>
            {deleteError ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-danger-000/30 bg-danger-000/10 px-3 py-2 text-xs text-danger-000"
              >
                {deleteError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  if (!deletingItem) return
                  const item = deletingItem
                  void (async () => {
                    try {
                      await deleteSpecialist(item.id, item.revision)
                      setDeletingItem(null)
                      setDeleteError(undefined)
                    } catch (err) {
                      // Reload the list so a retry picks up the current revision.
                      void load()
                      setDeleteError(
                        err instanceof Error
                          ? err.message
                          : 'This specialist changed — review and try again.'
                      )
                    }
                  })()
                }}
              >
                Delete
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  )
}

export { SpecialistsPanel }
