import { Bot, ChevronDown, ListChecks, Trash2, Unlink, Users, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useSpecialistStore } from '@/stores/specialist-store'
import {
  canEditResourceAssignments,
  type AssignableResource,
  type ResourceSpecialist
} from './resource-assignment'
import type { ResourceSelection as Selection } from './use-resource-selection'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SpecialistAvatar } from './specialist-avatar'
import { BatchManageReview } from './BatchManageReview'

export const ResourceCategorySelection = ({
  selection,
  group,
  label,
  ids
}: {
  selection: Selection
  group: string
  label: string
  ids: string[]
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const active = selection.groups.has(group)
  const checkbox = useRef<HTMLInputElement>(null)
  const count = ids.filter((id) => selection.ids.has(id)).length
  useLayoutEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = count > 0 && count < ids.length
  }, [count, ids.length, active])
  if (ids.length === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-2">
      {active ? (
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            ref={checkbox}
            type="checkbox"
            className="size-3.5 accent-primary"
            aria-label={t('Select all in {{name}}', { name: label })}
            checked={ids.length > 0 && count === ids.length}
            disabled={selection.locked}
            onChange={() => selection.toggleIds(ids)}
          />
          {t('Select all')}
        </label>
      ) : null}
      <Button
        variant={active ? 'secondary' : 'ghost'}
        size="sm"
        disabled={selection.locked}
        aria-label={
          active
            ? t('Finish selection in {{name}}', { name: label })
            : t('Select multiple in {{name}}', { name: label })
        }
        aria-pressed={active}
        onClick={() => selection.toggleGroup(group)}
      >
        <ListChecks className="size-3.5" aria-hidden="true" />
        {active ? t('Done') : t('Select multiple')}
      </Button>
    </div>
  )
}

export const ResourceSelectionCheckbox = ({
  selection,
  resource
}: {
  selection: Selection
  resource: AssignableResource
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (!selection.groups.has(resource.group)) return null
  return (
    <input
      type="checkbox"
      className="ml-2 size-4 shrink-0 accent-primary"
      aria-label={t('Select {{name}}', { name: resource.name })}
      checked={selection.ids.has(resource.id)}
      disabled={selection.locked}
      onChange={() => selection.toggleIds([resource.id])}
    />
  )
}

export const ResourceSelectionBar = ({
  selection,
  visibleIds
}: {
  selection: Selection
  visibleIds?: string[]
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const items = useSpecialistStore((state) => state.items)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const eligibleSpecialists = items.filter(
    (item): item is ResourceSpecialist =>
      item.kind !== 'reviewer' && canEditResourceAssignments(item)
  )
  // Count eligible profiles before filtering so search stays visible while typing.
  const showSearch = eligibleSpecialists.length > 5
  const term = showSearch ? query.trim().toLocaleLowerCase() : ''
  const specialists = eligibleSpecialists.filter((item) =>
    `${item.displayName ?? ''} ${item.name}`.toLocaleLowerCase().includes(term)
  )
  const { selected, actions, busy, review } = selection
  const bar = useRef<HTMLDivElement>(null)
  const deleteTrigger = useRef<HTMLButtonElement>(null)
  const clearTrigger = useRef<HTMLButtonElement>(null)
  const wasReviewing = useRef(false)
  useLayoutEffect(() => {
    // Replacing the action row removes its focused button. Keep keyboard users in the review flow.
    if (review && !wasReviewing.current) {
      bar.current?.querySelector<HTMLElement>('[data-slot="batch-review-title"]')?.focus()
    } else if (!review && wasReviewing.current) {
      if (busy) return
      const target = deleteTrigger.current
      ;(target && !target.disabled ? target : clearTrigger.current)?.focus()
    }
    wasReviewing.current = Boolean(review)
  }, [review, busy])
  const hidden = visibleIds
    ? selected.filter((resource) => !visibleIds.includes(resource.id)).length
    : 0
  const warningClass =
    'text-status-warning-foreground hover:bg-status-warning-surface hover:text-status-warning-foreground dark:text-status-warning-dark-foreground dark:hover:bg-status-warning-dark-surface dark:hover:text-status-warning-dark-foreground'
  if (!selected.length && !busy && !selection.error && !selection.completed) return null
  return (
    <div
      ref={bar}
      data-slot="resource-selection-bar"
      role="region"
      aria-label={t('Selected resources')}
      className="sticky bottom-0 z-30 -mx-5 mt-4 border-t border-border bg-card px-5 py-3 shadow-sm"
    >
      {selection.error ? (
        <ErrorNotice
          inline
          role="alert"
          tone="amber"
          className="mb-2"
          description={t('Some changes could not be saved. Unchanged resources remain selected.')}
        />
      ) : null}
      {selection.completed ? (
        <p role="status" className="mb-2 text-xs text-muted-foreground">
          {t('Changes saved.')}
        </p>
      ) : null}
      {review ? (
        <BatchManageReview
          title={t('Delete selected resources?')}
          description={t(
            'Only removable resources will be deleted. Featured resources and resources owned or used by Specialists are kept.'
          )}
          details={
            <ul>
              {review.map((resource) => (
                <li key={resource.id}>{resource.displayName ?? resource.name}</li>
              ))}
            </ul>
          }
          summary={<span>{t('{{count}} selected', { count: review.length })}</span>}
          actions={
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void selection.deleteSelected()}
            >
              {t('Confirm deletion')} <span className="tabular-nums">{review.length}</span>
            </Button>
          }
          onCancel={selection.cancelReview}
          busy={busy}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-auto text-xs font-medium">
            {t('{{count}} selected', { count: selected.length })}
            {hidden > 0 ? (
              <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                {t('{{count}} hidden by filters', { count: hidden })}
              </p>
            ) : null}
          </div>
          {selected.length > 0 ? (
            <>
              <Popover
                open={open}
                onOpenChange={(value) => {
                  setOpen(value)
                  setQuery('')
                }}
              >
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" disabled={busy || !selection.available}>
                    <Users className="size-3.5" aria-hidden="true" />
                    {t('Add to Specialist')}
                    <ChevronDown className="size-3" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  side="top"
                  className="flex w-72 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-2rem)] flex-col gap-1 overscroll-contain rounded-[15px] border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
                >
                  {showSearch ? (
                    <div className="shrink-0">
                      <SettingsSearchInput
                        aria-label={t('Search Specialists')}
                        placeholder={t('Search Specialists')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </div>
                  ) : null}
                  <div className="min-h-0 max-h-60 overflow-y-auto overscroll-contain">
                    {specialists.map((item) =>
                      item.kind === 'custom' ? (
                        <button
                          key={item.id}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setOpen(false)
                            void selection.assign(item.id)
                          }}
                          className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50"
                        >
                          <SpecialistAvatar
                            iconKey={item.iconKey}
                            colorKey={item.colorKey}
                            size="sm"
                          />
                          <span className="truncate">{item.displayName?.trim() || item.name}</span>
                        </button>
                      ) : null
                    )}
                    {!specialists.length ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">
                        {t('No Specialists match your search.')}
                      </p>
                    ) : null}
                  </div>
                </PopoverContent>
              </Popover>
              <TooltipProvider delayDuration={300}>
                {actions.unlink.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || !selection.available}
                        className={warningClass}
                        onClick={() => void selection.unlink()}
                      >
                        <Unlink className="size-3.5" aria-hidden="true" />
                        {t('Unlink Specialists')}
                        <span className="tabular-nums">{actions.unlink.length}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-72">
                      {t(
                        'Remove these resources from all editable Specialists. Future Specialist tasks may lose these capabilities. Main Agent loading and read-only Specialists are unchanged.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {actions.stopMain.length > 0 ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        className={warningClass}
                        onClick={() => void selection.stopMain()}
                      >
                        <Bot className="size-3.5" aria-hidden="true" />
                        {t('Stop Main Agent loading')}
                        <span className="tabular-nums">{actions.stopMain.length}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-72">
                      {t(
                        'Future Main Agent tasks will not load these resources and may lose these capabilities. Specialist access and required Skills are unchanged.'
                      )}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </TooltipProvider>
              {actions.deletable.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy || !selection.available}
                  aria-label={t('Delete selected')}
                  ref={deleteTrigger}
                  onClick={selection.openReview}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t('Delete')}
                  <span className="tabular-nums">{actions.deletable.length}</span>
                </Button>
              ) : null}
            </>
          ) : null}
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={t('Clear selection')}
                  ref={clearTrigger}
                  onClick={selection.clear}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('Clear selection')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}
    </div>
  )
}
