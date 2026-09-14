/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V3
 * component: batch management · genre: modern-minimal · theme: Open Science
 * States use existing semantic tokens, native controls, and owner-provided feedback.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { BatchActionDock, BatchSelectionActions } from './BatchActionDock'
import { Button } from '@/components/ui/button'

export function BatchManageLayout({
  description,
  filters,
  children,
  controlsLabel,
  visibleCount,
  visibleSelectedCount,
  selectedCount,
  selectedOnly,
  busy,
  onToggleAll,
  onToggleSelectedOnly,
  onClear,
  actions,
  review,
  feedback,
  onDone
}: {
  description: ReactNode
  filters: ReactNode
  children: ReactNode
  controlsLabel: string
  visibleCount: number
  visibleSelectedCount: number
  selectedCount: number
  selectedOnly: boolean
  busy: boolean
  onToggleAll: () => void
  onToggleSelectedOnly: () => void
  onClear: () => void
  actions: ReactNode
  review?: ReactNode
  feedback?: ReactNode
  onDone?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const selectAll = useRef<HTMLInputElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const wasReviewing = useRef(false)
  const restoreSelectionFocus = useRef(false)
  const reviewing = Boolean(review)
  const locked = busy || reviewing
  useLayoutEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        visibleSelectedCount > 0 && visibleSelectedCount < visibleCount
  }, [visibleCount, visibleSelectedCount])
  useLayoutEffect(() => {
    if (reviewing && !wasReviewing.current)
      dock.current
        ?.querySelector<HTMLElement>('[data-slot="batch-review-title"]')
        ?.focus({ preventScroll: true })
    else if (!reviewing && (wasReviewing.current || restoreSelectionFocus.current)) {
      // A deleted/filtered-away selection can disable select-all. Restore only to a live control,
      // after React has committed the new list and re-enabled its fieldset.
      const target = !restoreSelectionFocus.current
        ? dock.current?.querySelector<HTMLElement>(
            '[data-batch-delete-trigger]:not(:disabled), [data-batch-done]:not(:disabled)'
          )
        : undefined
      const selection = selectAll.current
      ;(
        target ??
        (selection?.matches(':enabled')
          ? selection
          : selection
              ?.closest('fieldset')
              ?.querySelector<HTMLElement>('input:enabled, button:enabled'))
      )?.focus({ preventScroll: true })
      restoreSelectionFocus.current = false
    }
    wasReviewing.current = reviewing
  })
  const clear = (): void => {
    restoreSelectionFocus.current = true
    onClear()
  }

  return (
    <div
      data-slot="batch-manage-layout"
      role="group"
      aria-label={controlsLabel}
      className="flex h-full min-h-0 min-w-0 flex-col [@media(pointer:coarse)]:[&_button]:min-h-11 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring"
    >
      <fieldset
        disabled={locked}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 pb-10 [scroll-padding-block:2rem] [scrollbar-gutter:stable]"
        data-slot="batch-manage-scroll"
      >
        <p className="text-[13px] leading-5 text-muted-foreground">{description}</p>
        <div className="@container mt-4 flex min-w-0 items-center gap-2">{filters}</div>
        <label className="mt-3 flex min-h-9 w-fit items-center gap-2 text-xs text-muted-foreground [@media(pointer:coarse)]:min-h-11">
          <input
            ref={selectAll}
            type="checkbox"
            aria-label={t('Select all results')}
            checked={visibleCount > 0 && visibleSelectedCount === visibleCount}
            disabled={locked || visibleCount === 0}
            onChange={onToggleAll}
            className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <span>
            {t('Select all results')} ({visibleCount})
          </span>
        </label>
        {children}
      </fieldset>
      {selectedCount > 0 || busy || review || feedback ? (
        <BatchActionDock ref={dock} data-slot="batch-manage-dock">
          <div className="space-y-3">
            {feedback ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1 basis-64 space-y-3">{feedback}</div>
                {onDone && !review ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto shrink-0"
                    disabled={busy}
                    data-batch-done
                    onClick={() => {
                      restoreSelectionFocus.current = true
                      onDone()
                    }}
                  >
                    {t('Done')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {review ||
              (selectedCount > 0 ? (
                <BatchSelectionActions
                  selectedCount={selectedCount}
                  disabled={busy}
                  onClear={clear}
                >
                  <Button
                    type="button"
                    variant={selectedOnly ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={selectedOnly}
                    onClick={onToggleSelectedOnly}
                    disabled={busy}
                  >
                    {t('Show selected')}
                  </Button>
                  <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
                </BatchSelectionActions>
              ) : null)}
          </div>
        </BatchActionDock>
      ) : null}
    </div>
  )
}

export function BatchManageReview({
  title,
  description,
  summary,
  details,
  actions,
  onCancel,
  busy
}: {
  title: string
  description: ReactNode
  summary: ReactNode
  details: ReactNode
  actions: ReactNode
  onCancel: () => void
  busy: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <section
      data-slot="batch-manage-review"
      aria-label={title}
      className="space-y-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          if (!busy) onCancel()
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 tabIndex={-1} data-slot="batch-review-title" className="text-sm font-semibold">
          {title}
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            {t('Cancel', { ns: 'common' })}
          </Button>
          {actions}
        </div>
      </div>
      <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      <div className="space-y-1">{summary}</div>
      <details className="group">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
          {t('Details')}
          <ChevronDown aria-hidden="true" className="size-4 group-open:rotate-180" />
        </summary>
        <div className="space-y-3 pt-2 text-xs leading-5 [overflow-wrap:anywhere]">{details}</div>
      </details>
    </section>
  )
}
