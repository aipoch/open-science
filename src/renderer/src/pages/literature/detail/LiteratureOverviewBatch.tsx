import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/progress-bar'
import { Check, ChevronRight, Circle, CircleAlert, Loader2, Pause, Sparkles, X } from 'lucide-react'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { LiteratureOverviewDetails } from './LiteratureOverview'
import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureHost } from '../renderer-host'
import {
  literatureOverviewSource,
  type LiteratureOverview as LiteratureOverviewData,
  type LiteratureOverviewRequest
} from '../../../../../shared/literature-overview'
import {
  OVERVIEW_BATCH_CONCURRENCY,
  OVERVIEW_BATCH_LIMIT,
  type OverviewBatch,
  type OverviewBatchRequest
} from '../../../../../shared/literature-overview-batch'

export function LiteratureOverviewBatch({
  resolveSelection,
  hasSelection,
  onOverviewSaved,
  onActiveRequestsChange,
  onOpenOverview,
  returnFocusRef,
  children
}: {
  resolveSelection(): Promise<string[]>
  hasSelection: boolean
  onOverviewSaved?(request: LiteratureOverviewRequest): void
  onActiveRequestsChange?(requests: LiteratureOverviewRequest[]): void
  onOpenOverview?(item: LiteratureItemView, initiator: HTMLElement): void
  returnFocusRef?: React.RefObject<HTMLElement | null>
  children?(progress: React.ReactNode, generate: React.ReactNode): React.ReactNode
}): React.JSX.Element {
  const { api } = useLiteratureHost()
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const [expandedItems, setExpandedItems] = useState<string[]>([])
  const [pausing, setPausing] = useState(false)
  const [selectionError, setSelectionError] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLOListElement>(null)
  const [retryHeights, setRetryHeights] = useState<{
    jobId: string
    progress: number
    rows: (number | undefined)[]
  } | null>(null)
  const openingOverview = useRef<{ item: LiteratureItemView; initiator: HTMLElement } | null>(null)
  const [job, setJob] = useState<OverviewBatch | null>(null)
  const [references, setReferences] = useState<Record<string, LiteratureItemView | undefined>>({})
  const [busy, setBusy] = useState(false)
  const [activeItemIds, setActiveItemIds] = useState<string[]>([])
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const lifetime = useRef(new AbortController())
  const locked = useRef(false)
  const stop = useRef(false)
  const notified = useRef<{ jobId: string; requests: Set<string> } | null>(null)
  useEffect(() => {
    onActiveRequestsChange?.(
      job?.rows
        .filter(
          (row) =>
            row.status === 'running' ||
            (!error &&
              busy &&
              row.status === 'pending' &&
              activeItemIds.includes(row.request.itemId))
        )
        .map((row) => row.request) ?? []
    )
  }, [job, busy, error, activeItemIds, onActiveRequestsChange])
  useEffect(() => () => onActiveRequestsChange?.([]), [onActiveRequestsChange])
  useEffect(() => {
    if (!job || !onOverviewSaved) return
    if (notified.current?.jobId !== job.id)
      notified.current = { jobId: job.id, requests: new Set() }
    for (const row of job.rows) {
      if (row.status !== 'succeeded') continue
      const key = JSON.stringify([
        row.request.itemId,
        row.request.expectedSourceKey,
        row.request.language
      ])
      if (notified.current.requests.has(key)) continue
      notified.current.requests.add(key)
      onOverviewSaved(row.request)
    }
  }, [job, onOverviewSaved])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const initialGeneration = generation.current
    void api.literature
      .overviewBatch({ action: 'read' })
      .then((value) => {
        if (!controller.signal.aborted && generation.current === initialGeneration) setJob(value)
      })
      .catch(() => {
        if (!controller.signal.aborted && generation.current === initialGeneration) setError(true)
      })
    return () => {
      controller.abort()
    }
  }, [api])
  const itemIds = JSON.stringify(job?.rows.map((row) => row.request.itemId) ?? [])
  useEffect(() => {
    let current = true
    const ids: string[] = JSON.parse(itemIds)
    if (ids.length)
      void Promise.all(
        ids.map(async (itemId) => {
          const item = await api.literature.get(itemId).catch(() => undefined)
          return [itemId, item] as const
        })
      )
        .then((rows) => {
          if (current) setReferences(Object.fromEntries(rows))
        })
        .catch(() => {})
    return () => {
      current = false
    }
  }, [api, itemIds])
  const jobId = job?.id
  const hasRunningRows = job?.rows.some((row) => row.status === 'running') ?? false
  const observing = busy || hasRunningRows
  useEffect(() => {
    if (!jobId || !observing) return
    let current = true
    let reading = false
    const timer = setInterval(() => {
      if (reading) return
      reading = true
      const readGeneration = generation.current
      void api.literature
        .overviewBatch({ action: 'read' })
        .then((progress) => {
          // A request's final response wins over any earlier progress observation.
          if (current && generation.current === readGeneration && progress?.id === jobId)
            setJob(progress)
        })
        .catch(() => {})
        .finally(() => {
          reading = false
        })
    }, 1000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [api, jobId, observing])
  const execute = async (
    request: OverviewBatchRequest,
    signal = lifetime.current.signal
  ): Promise<void> => {
    if (locked.current || signal.aborted) return
    generation.current++
    locked.current = true
    // Preserve a pause requested during start's asynchronous selection preparation.
    if (request.action !== 'start') {
      stop.current = false
      setPausing(false)
    }
    setBusy(true)
    setError(false)
    try {
      let value = await api.literature.overviewBatch(request)
      generation.current++
      if (!signal.aborted) setJob(value)
      while (
        !signal.aborted &&
        !stop.current &&
        value &&
        !value.paused &&
        value.rows.some((row) => row.status === 'pending')
      ) {
        setActiveItemIds(
          value.rows
            .filter((row) => row.status === 'pending')
            .slice(0, OVERVIEW_BATCH_CONCURRENCY)
            .map((row) => row.request.itemId)
        )
        value = await api.literature.overviewBatch({ action: 'advance', jobId: value.id })
        generation.current++
        if (!signal.aborted) setJob(value)
      }
      if (!signal.aborted && stop.current && value) {
        value = await api.literature.overviewBatch({ action: 'pause', jobId: value.id })
        generation.current++
        if (!signal.aborted) setJob(value)
      }
    } catch {
      generation.current++
      if (!signal.aborted) setError(true)
    } finally {
      locked.current = false
      if (!signal.aborted) {
        setActiveItemIds([])
        setBusy(false)
        setPausing(false)
      }
    }
  }
  const start = async (): Promise<void> => {
    if (locked.current) return
    const signal = lifetime.current.signal
    stop.current = false
    setPausing(false)
    setSelectionError(false)
    setExpandedItems([])
    setRetryHeights(null)
    setOpen(true)
    generation.current++
    locked.current = true
    setBusy(true)
    setError(false)
    try {
      const ids = await resolveSelection()
      signal.throwIfAborted()
      if (!ids.length || ids.length > OVERVIEW_BATCH_LIMIT) {
        setSelectionError(true)
        setBusy(false)
        setPausing(false)
        locked.current = false
        return
      }
      const language = i18n.resolvedLanguage ?? i18n.language
      const entries = await Promise.all(
        ids.map(async (itemId) => {
          const item = await api.literature.get(itemId)
          if (!item) throw new Error('Reference unavailable.')
          return { itemId, language, expectedSourceKey: literatureOverviewSource(item).key }
        })
      )
      signal.throwIfAborted()
      locked.current = false
      await execute({ action: 'start', entries }, signal)
    } catch {
      if (!signal.aborted) {
        setError(true)
        setBusy(false)
        setPausing(false)
      }
      locked.current = false
    }
  }
  const failureDescription = (issue?: string): string => {
    switch (issue) {
      case 'busy':
        return t('Too many overviews are being generated. Try again shortly.')
      case 'source-changed':
        return t('Source changed')
      case 'source-unavailable':
        return t('Add an abstract or readable full-text PDF to generate an overview.')
      case 'input-too-large':
        return t('The available source exceeds the overview input limit.')
      default:
        return t('Could not generate the overview. Please try again.')
    }
  }
  const unfinished = job?.rows.some((row) => row.status === 'pending' || row.status === 'running')
  const activeRows =
    job?.rows.filter(
      (row) =>
        !error &&
        (row.status === 'running' ||
          (busy && row.status === 'pending' && activeItemIds.includes(row.request.itemId)))
    ) ?? []
  const succeeded = job?.rows.filter((row) => row.status === 'succeeded').length ?? 0
  const failed = job?.rows.filter((row) => row.status === 'failed').length ?? 0
  const completed = succeeded + failed
  const total = job?.rows.length ?? 0
  const working = busy || (hasRunningRows && !error)
  const complete = Boolean(job && !working && !unfinished && !failed)
  const status = pausing
    ? t('Pausing…')
    : working
      ? t('Running')
      : unfinished
        ? t('Paused')
        : failed
          ? t('Failed')
          : t('Completed')
  const generateAction = hasSelection ? (
    <Button size="sm" variant="ghost" disabled={working || unfinished} onClick={() => void start()}>
      <Sparkles className="size-3.5" aria-hidden="true" />
      {t('Generate overviews')}
    </Button>
  ) : null
  const actions = (
    <>
      {((job && (!complete || open)) || busy || error || selectionError) && (
        <Dialog.Trigger asChild>
          <Button
            ref={triggerRef}
            size="sm"
            variant="ghost"
            aria-label={t('Batch overviews')}
            className="shrink-0 gap-2"
          >
            {working ? (
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : failed || error || selectionError ? (
              <CircleAlert
                className="size-3.5 text-status-warning-foreground dark:text-status-warning-dark-foreground"
                aria-hidden="true"
              />
            ) : unfinished ? (
              <Pause className="size-3.5" aria-hidden="true" />
            ) : (
              <Check
                className="size-3.5 text-status-success-foreground dark:text-status-success-dark-foreground"
                aria-hidden="true"
              />
            )}
            {t('Batch overviews')}
            {job && (
              <span className="text-muted-foreground tabular-nums">
                {completed}/{total}
              </span>
            )}
            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </Dialog.Trigger>
      )}
    </>
  )
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) {
          setRetryHeights(null)
          setExpandedItems([])
        }
      }}
    >
      {children ? (
        children(actions, generateAction)
      ) : (
        <>
          {generateAction}
          {actions}
        </>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            const opening = openingOverview.current
            openingOverview.current = null
            if (opening && onOpenOverview) {
              event.preventDefault()
              onOpenOverview(opening.item, opening.initiator)
            } else if (complete && returnFocusRef?.current) {
              event.preventDefault()
              returnFocusRef.current.focus()
            }
          }}
          className={dialogPanelClassName(
            'flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>{t('Batch overviews')}</Dialog.Title>
            <Dialog.Close asChild>
              <Button size="icon-sm" variant="ghost" aria-label={t('Close')}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 overflow-y-auto">
            {selectionError ? (
              <div className="p-5">
                <ErrorNotice
                  inline
                  tone="amber"
                  description={t('Select up to {{limit}} references.', {
                    limit: OVERVIEW_BATCH_LIMIT
                  })}
                />
              </div>
            ) : null}
            {error ? (
              <div className="p-5">
                <ErrorNotice
                  inline
                  tone="amber"
                  description={t(
                    'Could not generate batch overviews. Check the selection and try again.'
                  )}
                  primaryButton={{
                    label: t('Retry'),
                    onClick: () => {
                      const signal = lifetime.current.signal
                      const currentGeneration = generation.current
                      void api.literature
                        .overviewBatch({ action: 'read' })
                        .then((value) => {
                          if (!signal.aborted && generation.current === currentGeneration) {
                            setJob(value)
                            setError(false)
                          }
                        })
                        .catch(() => {})
                    }
                  }}
                />
              </div>
            ) : null}
            {!selectionError && (job || busy) && (
              <div
                ref={progressRef}
                className="space-y-3 px-5 py-4"
                style={{
                  minHeight: retryHeights?.jobId === job?.id ? retryHeights?.progress : undefined
                }}
                role="status"
                aria-live="polite"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>{status}</span>
                  {job && (
                    <span className="text-muted-foreground tabular-nums">
                      {t('{{done}} of {{total}} finished', { done: completed, total })}
                    </span>
                  )}
                </div>
                {job && (
                  <ProgressBar
                    label={t('Batch overviews')}
                    value={total > 0 ? (completed / total) * 100 : 0}
                  />
                )}
                {failed > 0 && (
                  <p className="text-sm text-status-warning-foreground dark:text-status-warning-dark-foreground">
                    {t('{{count}} failed overviews', {
                      count: failed,
                      defaultValue_one: '{{count}} failed overview'
                    })}
                  </p>
                )}
              </div>
            )}
            {job && !selectionError && (
              <ol ref={rowsRef} className="divide-y divide-border border-t border-border">
                {job.rows.map((row, index) => {
                  const item = references[row.request.itemId]
                  const title = item?.item.title ?? row.request.itemId
                  const active = activeRows.includes(row)
                  const expanded = expandedItems.includes(row.request.itemId)
                  const Icon =
                    row.status === 'succeeded'
                      ? Check
                      : row.status === 'failed'
                        ? CircleAlert
                        : active
                          ? Loader2
                          : Circle
                  return (
                    <li
                      key={row.request.itemId}
                      className={row.status === 'succeeded' ? undefined : 'space-y-2 px-5 py-4'}
                      style={{
                        minHeight:
                          retryHeights?.jobId === job.id ? retryHeights.rows[index] : undefined
                      }}
                    >
                      {row.status === 'succeeded' ? (
                        <button
                          type="button"
                          className="flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-accent focus-visible:keyboard-focus focus-visible:-outline-offset-2"
                          style={{
                            minHeight:
                              !expanded && retryHeights?.jobId === job.id
                                ? retryHeights.rows[index]
                                : undefined
                          }}
                          aria-label={title}
                          aria-expanded={expanded}
                          aria-controls={`${detailsId}-${index}`}
                          onClick={() => {
                            setExpandedItems((ids) =>
                              expanded
                                ? ids.filter((id) => id !== row.request.itemId)
                                : [...ids, row.request.itemId]
                            )
                            if (expanded)
                              setRetryHeights((heights) =>
                                heights?.jobId === job.id
                                  ? {
                                      ...heights,
                                      rows: heights.rows.map((height, rowIndex) =>
                                        rowIndex === index ? undefined : height
                                      )
                                    }
                                  : heights
                              )
                          }}
                        >
                          <Icon
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-status-success-foreground dark:text-status-success-dark-foreground"
                          />
                          <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                            {title}
                          </span>
                          {(!item || !onOpenOverview) && (
                            <span className="max-w-[40%] shrink-0 text-right text-xs leading-5 text-muted-foreground">
                              {t('Overview saved')}
                            </span>
                          )}
                          <ChevronRight
                            aria-hidden="true"
                            className={`mt-0.5 size-4 shrink-0 ${expanded ? 'rotate-90' : ''}`}
                          />
                        </button>
                      ) : (
                        <div className="flex items-start gap-3">
                          <Icon
                            aria-hidden="true"
                            className={`mt-0.5 size-4 shrink-0 ${active ? 'animate-spin motion-reduce:animate-none' : ''} ${row.status === 'failed' ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground' : 'text-muted-foreground'}`}
                          />
                          <p className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                            {title}
                          </p>
                          <span className="max-w-[40%] shrink-0 text-right text-xs leading-5 text-muted-foreground">
                            {row.status === 'failed'
                              ? t('Overview failed')
                              : active
                                ? t('Generating overview…')
                                : t('Pending')}
                          </span>
                        </div>
                      )}
                      {row.status === 'succeeded' && expanded && (
                        <div id={`${detailsId}-${index}`} className="space-y-3 pr-5 pb-4 pl-12">
                          <SavedOverview key={JSON.stringify(row.request)} request={row.request} />
                          {item && onOpenOverview && (
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const initiator =
                                    (complete ? returnFocusRef?.current : triggerRef.current) ??
                                    triggerRef.current
                                  if (!initiator) return
                                  openingOverview.current = { item, initiator }
                                  setOpen(false)
                                  setRetryHeights(null)
                                  setExpandedItems([])
                                }}
                              >
                                {t('View details')}
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                      {row.status === 'failed' && (
                        <div className="pl-7">
                          <ErrorNotice
                            inline
                            tone="amber"
                            description={failureDescription(row.issue)}
                          />
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
          <div className={dialogFooterClassName}>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                {t('Close')}
              </Button>
            </Dialog.Close>
            {busy ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pausing}
                onClick={() => {
                  stop.current = true
                  setPausing(true)
                }}
              >
                {pausing ? t('Pausing…') : t('Pause')}
              </Button>
            ) : job && !selectionError ? (
              <>
                {unfinished && (
                  <Button
                    size="sm"
                    variant={failed ? 'outline' : 'default'}
                    disabled={hasRunningRows && !error}
                    onClick={() => void execute({ action: 'resume', jobId: job.id })}
                  >
                    {t('Continue remaining')}
                  </Button>
                )}
                {failed > 0 && (
                  <Button
                    size="sm"
                    disabled={hasRunningRows && !error}
                    onClick={() => {
                      // Keep the current rows steady while retry clears and replaces error details.
                      setRetryHeights({
                        jobId: job.id,
                        progress: progressRef.current?.getBoundingClientRect().height ?? 0,
                        rows: Array.from(
                          rowsRef.current?.children ?? [],
                          (row) => row.getBoundingClientRect().height
                        )
                      })
                      void execute({ action: 'retry', jobId: job.id })
                    }}
                  >
                    {t('Retry failed overviews')}
                  </Button>
                )}
              </>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SavedOverview({ request }: { request: LiteratureOverviewRequest }): React.JSX.Element {
  const { api } = useLiteratureHost()
  const { t } = useTranslation()
  const [overview, setOverview] = useState<LiteratureOverviewData>()
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const { itemId, expectedSourceKey, language } = request
  useEffect(() => {
    let current = true
    void api.literature
      .studySnapshot({ itemId, expectedSourceKey, language, mode: 'read' })
      .then((value) => {
        if (!current) return
        if ('issue' in value || value.sourceKey !== expectedSourceKey) setFailed(true)
        else setOverview(value)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
    return () => {
      current = false
    }
  }, [api, itemId, expectedSourceKey, language, revision])
  if (failed)
    return (
      <ErrorNotice
        inline
        tone="amber"
        description={t('Could not load the overview. Try again.')}
        primaryButton={{
          label: t('Retry'),
          onClick: () => {
            setFailed(false)
            setOverview(undefined)
            setRevision((value) => value + 1)
          }
        }}
      />
    )
  if (!overview)
    return (
      <p role="status" className="py-2 text-sm text-muted-foreground">
        {t('Loading…')}
      </p>
    )
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {overview.coverage === 'abstract'
          ? t('Based on abstract')
          : overview.coverage === 'full-text'
            ? t('Based on full text')
            : t('Based on selected passages')}
      </p>
      <LiteratureOverviewDetails overview={overview} />
    </>
  )
}
