import { useComparisonTables } from '../comparison/useComparisonTables'
import { useLiteratureHost } from '../renderer-host'
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { AlertCircle, ListTodo, LoaderCircle, X } from 'lucide-react'
import { LiteratureErrorNotice } from '../LiteratureErrorNotice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import type { LiteratureJobSummary } from '@aipoch/literature-discovery/jobs'

type ComparisonFeed = Pick<ReturnType<typeof useComparisonTables>, 'tables' | 'command'>
type BackgroundProps = {
  onOpenComparison?: (tableId: string) => void
  onOpenItem?: (itemId: string, onReturn: () => void) => void | Promise<void>
  onOpen: (job: LiteratureJobSummary) => void
  onChanged?: (itemIds: string[]) => void
  compact?: boolean
  hidden?: boolean
}
export function LiteratureBackgroundTasks({
  comparisons,
  ...props
}: BackgroundProps & { comparisons?: ComparisonFeed }): React.JSX.Element {
  return comparisons ? (
    <BackgroundTasks {...props} comparisons={comparisons} />
  ) : (
    <SubscribedBackgroundTasks {...props} />
  )
}
function SubscribedBackgroundTasks(props: BackgroundProps): React.JSX.Element {
  const comparisons = useComparisonTables()
  return <BackgroundTasks {...props} comparisons={comparisons} />
}
function BackgroundTasks({
  comparisons,
  onOpenComparison,
  onOpenItem,
  onOpen,
  onChanged,
  compact = false,
  hidden = false
}: BackgroundProps & { comparisons: ComparisonFeed }): React.JSX.Element {
  const { api: hostApi } = useLiteratureHost()
  const { t } = useTranslation()
  const comparisonTasks = comparisons.tables.filter(
    (table) =>
      table.state !== 'idle' ||
      table.succeeded + table.failed + table.unavailable + table.running > 0
  )
  const statusId = useId()
  const formatDate = useDateTimeFormat()
  const [open, setOpen] = useState(false)
  const [referenceError, setReferenceError] = useState(false)
  const taskListRef = useRef<HTMLDivElement>(null)
  const referenceButtons = useRef(new Map<string, HTMLButtonElement>())
  const referenceReturn = useRef<{ tableId: string; scrollTop: number } | undefined>(undefined)
  const restoringReference = useRef(false)
  const referenceGeneration = useRef(0)
  useEffect(
    () => () => {
      referenceGeneration.current++
    },
    []
  )
  const openReference = (tableId: string, itemId: string): void => {
    if (!onOpenItem || referenceReturn.current) return
    const generation = ++referenceGeneration.current
    referenceReturn.current = { tableId, scrollTop: taskListRef.current?.scrollTop ?? 0 }
    setReferenceError(false)
    setOpen(false)
    const restore = (): void => {
      if (generation !== referenceGeneration.current || !referenceReturn.current) return
      restoringReference.current = true
      setOpen(true)
    }
    void Promise.resolve()
      .then(() => onOpenItem(itemId, restore))
      .catch(() => {
        if (generation !== referenceGeneration.current) return
        setReferenceError(true)
        restore()
      })
  }
  const [jobs, setJobs] = useState<LiteratureJobSummary[]>([])
  const [error, setError] = useState(false)
  const [announceCompletion, setAnnounceCompletion] = useState(false)
  const previous = useRef<LiteratureJobSummary[]>([])
  const initialized = useRef(false)
  const receive = useEffectEvent((summaries: LiteratureJobSummary[]) => {
    const changed = summaries.flatMap((job) => {
      const prior = previous.current.find(({ id }) => id === job.id)
      if (!prior) return initialized.current ? (job.completedItemIds ?? []) : []
      if (job.done <= prior.done) return []
      const known = new Set(prior.completedItemIds)
      return (job.completedItemIds ?? []).filter((id) => !known.has(id))
    })
    if (changed.length) onChanged?.([...new Set(changed)])
    if (JSON.stringify(previous.current) !== JSON.stringify(summaries)) {
      setAnnounceCompletion(
        summaries.some((job) => {
          const prior = previous.current.find(({ id }) => id === job.id)
          return Boolean(
            prior &&
            (prior.state !== 'completed' ||
              prior.failed > 0 ||
              prior.ready > 0 ||
              prior.checked < prior.total) &&
            job.state === 'completed' &&
            job.failed === 0 &&
            job.ready === 0 &&
            job.checked >= job.total
          )
        })
      )
    }
    previous.current = summaries
    initialized.current = true
    setJobs((current) =>
      JSON.stringify(current) === JSON.stringify(summaries) ? current : summaries
    )
  })
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let inFlight = false
    let refreshRequested = false
    const poll = async (): Promise<void> => {
      if (inFlight) {
        refreshRequested = true
        return
      }
      inFlight = true
      try {
        const result = await hostApi.literature.jobs({ action: 'list' })
        if (active) {
          receive(result.summaries ?? [])
          setError(false)
        }
      } catch {
        if (active) {
          setError(true)
          setAnnounceCompletion(false)
        }
      } finally {
        inFlight = false
        const running = previous.current.some((job) =>
          ['queued', 'running', 'pausing'].includes(job.state)
        )
        if (active)
          timer = setTimeout(
            () => void poll(),
            refreshRequested ? 0 : !document.hidden && running ? 2000 : 30_000
          )
        refreshRequested = false
      }
    }
    void poll()
    const wake = (): void => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    window.addEventListener('literature-jobs-changed', wake)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      active = false
      clearTimeout(timer)
      window.removeEventListener('literature-jobs-changed', wake)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [hostApi.literature])
  const labels = {
    queued: t('Queued'),
    running: t('Running'),
    pausing: t('Pausing after the current reference…'),
    paused: t('Paused'),
    review: t('Awaiting review'),
    completed: t('Completed')
  }
  const pending = jobs.filter(
    (job) => job.state !== 'completed' || job.failed > 0 || job.ready > 0 || job.checked < job.total
  )
  const running = pending.filter((job) => job.state === 'running' || job.state === 'pausing')
  const allPaused = pending.every((job) => job.state === 'paused')
  const checked = running.reduce(
    (sum, job) => sum + (job.processed ?? (job.phase === 'search' ? job.checked : job.done)),
    0
  )
  const total = running.reduce((sum, job) => sum + (job.phaseTotal ?? job.total), 0)
  const statusLabel = error
    ? t('Task list unavailable')
    : running.some((job) => job.state === 'pausing')
      ? t('Pausing…')
      : running.length
        ? running[0].phase === 'search'
          ? t('Searching…')
          : running[0].mode === 'full-text'
            ? t('Downloading…')
            : t('Saving…')
        : pending.some((job) => job.state === 'queued')
          ? t('Queued')
          : pending.some((job) => job.failed > 0)
            ? t('Failed')
            : allPaused
              ? t('Paused')
              : t('Awaiting review')
  const announcement =
    error || pending.length ? statusLabel : announceCompletion ? t('Completed') : ''
  const showEntry = !hidden && (pending.length > 0 || comparisonTasks.length > 0 || open || error)
  return (
    <>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
      {showEntry ? (
        <Dialog.Root
          open={open}
          onOpenChange={(next) => {
            if (!next) {
              referenceGeneration.current++
              referenceReturn.current = undefined
            }
            setOpen(next)
          }}
        >
          <Dialog.Trigger asChild>
            <Button
              variant={compact ? 'outline' : 'ghost'}
              size={compact ? 'icon' : 'default'}
              title={compact ? t('Background tasks') : undefined}
              className="text-muted-foreground"
              aria-label={t('Background tasks')}
              aria-describedby={error ? statusId : `${statusId} ${statusId}-progress`}
            >
              {error || (!running.length && pending.some((job) => job.failed > 0)) ? (
                <AlertCircle
                  className="size-4 text-status-warning-foreground dark:text-status-warning-dark-foreground"
                  aria-hidden="true"
                />
              ) : running.length ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none text-primary"
                  aria-hidden="true"
                />
              ) : (
                <ListTodo className="size-4" aria-hidden="true" />
              )}
              <span id={statusId} className={compact ? 'sr-only' : undefined}>
                {pending.length || error ? statusLabel : t('Background tasks')}
              </span>
              {!error ? (
                <span id={`${statusId}-progress`} className={compact ? 'sr-only' : 'tabular-nums'}>
                  {running.length ? `${checked}/${total}` : pending.length + comparisonTasks.length}
                </span>
              ) : null}
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              onCloseAutoFocus={(event) => {
                if (referenceReturn.current) event.preventDefault()
              }}
              onOpenAutoFocus={(event) => {
                const returning = referenceReturn.current
                if (!restoringReference.current || !returning) return
                event.preventDefault()
                restoringReference.current = false
                referenceReturn.current = undefined
                requestAnimationFrame(() => {
                  if (taskListRef.current) taskListRef.current.scrollTop = returning.scrollTop
                  const target =
                    referenceButtons.current.get(returning.tableId) ??
                    taskListRef.current?.closest<HTMLElement>('[role="dialog"]')
                  target?.focus({ preventScroll: true })
                })
              }}
              className={dialogPanelClassName(
                'flex max-h-[80vh] w-[min(40rem,calc(100vw-2rem))] flex-col p-0'
              )}
            >
              <header className={dialogHeaderClassName}>
                <div>
                  <Dialog.Title className={dialogTitleClassName}>
                    {t('Background tasks')}
                  </Dialog.Title>
                  <Dialog.Description className={dialogDescriptionClassName}>
                    {t(
                      'Completed results are saved. Resume unfinished references after restarting the app.'
                    )}
                  </Dialog.Description>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  onClick={() => setOpen(false)}
                >
                  <X aria-hidden="true" />
                </Button>
              </header>
              <div ref={taskListRef} className="min-h-0 overflow-y-auto px-5 py-3">
                {referenceError && (
                  <LiteratureErrorNotice
                    title={t('This reference is no longer in your Library.')}
                  />
                )}
                {error ? (
                  <LiteratureErrorNotice
                    title={t('Background task could not be updated. Try again.')}
                    primaryButton={{
                      label: t('Retry'),
                      onClick: () => window.dispatchEvent(new Event('literature-jobs-changed'))
                    }}
                  />
                ) : null}
                {!jobs.length && !comparisonTasks.length && !error ? (
                  <p className="py-5 text-sm text-muted-foreground">
                    {t('No background tasks yet.')}
                  </p>
                ) : null}
                <ul className="divide-y divide-border-300/60">
                  {comparisonTasks.map((table) => (
                    <li
                      key={`comparison-${table.id}`}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0 text-sm">
                        {onOpenComparison ? (
                          <button
                            type="button"
                            className="rounded-sm text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t('Open comparison table: {{name}}', { name: table.name })}
                            onClick={() => {
                              setOpen(false)
                              onOpenComparison(table.id)
                            }}
                          >
                            {table.name}
                          </button>
                        ) : (
                          <p className="font-medium">{table.name}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t('Comparison table')} ·{' '}
                          {table.state === 'running'
                            ? t('Running')
                            : table.state === 'paused'
                              ? table.running > 0
                                ? t('Saving the current cell before pausing…')
                                : t('Paused')
                              : table.state === 'interrupted'
                                ? t('Interrupted')
                                : t('Awaiting review')}{' '}
                          ·{' '}
                          {t('Completed cells: {{done}} / {{total}}', {
                            done: table.succeeded,
                            total: table.total
                          })}
                        </p>
                      </div>
                      <div className="flex min-w-0 flex-wrap gap-2">
                        {onOpenItem && (table.reference || table.pendingItemIds?.[0]) && (
                          <Button
                            ref={(node) => {
                              if (node) referenceButtons.current.set(table.id, node)
                              else referenceButtons.current.delete(table.id)
                            }}
                            size="sm"
                            variant="ghost"
                            className="h-auto min-h-7 max-w-full whitespace-normal text-left"
                            onClick={() =>
                              openReference(
                                table.id,
                                table.reference?.itemId ?? table.pendingItemIds[0]
                              )
                            }
                          >
                            {table.reference
                              ? t('Open reference: {{title}}', { title: table.reference.title })
                              : t('Open reference')}
                          </Button>
                        )}
                        {onOpenComparison && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setOpen(false)
                              onOpenComparison(table.id)
                            }}
                          >
                            {t('Open')}
                          </Button>
                        )}
                        {table.state === 'running' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              void comparisons
                                .command({ action: 'pause', tableId: table.id })
                                .catch(() => setError(true))
                            }}
                          >
                            {t('Pause after current cell')}
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                  {jobs.map((job) => (
                    <li
                      key={job.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0 text-sm">
                        <p className="font-medium">
                          {job.mode === 'metadata'
                            ? t('Complete metadata')
                            : t('Find full-text PDF')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {labels[job.state]} ·{' '}
                          {job.phase === 'search'
                            ? t('Checked {{checked}} of {{total}}', {
                                checked: job.checked,
                                total: job.total
                              })
                            : job.mode === 'metadata'
                              ? t('Metadata updated: {{done}}', { done: job.done })
                              : t('PDFs added: {{done}}', { done: job.done })}
                          {job.total > job.checked
                            ? ` · ${t('Pending')}: ${job.total - job.checked}`
                            : null}
                          {job.failed > 0 ? ` · ${t('Failed')}: ${job.failed}` : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(job.createdAt, 'dateTime')}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setOpen(false)
                            onOpen(job)
                          }}
                        >
                          {t('Open')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={['queued', 'running', 'pausing'].includes(job.state)}
                          onClick={() => {
                            void hostApi.literature.jobs({ action: 'remove', jobId: job.id }).then(
                              () => setJobs((current) => current.filter(({ id }) => id !== job.id)),
                              () => {
                                setError(true)
                                setAnnounceCompletion(false)
                              }
                            )
                          }}
                        >
                          {t('Remove task')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  )
}
