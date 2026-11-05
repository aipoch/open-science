import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureHost } from '../renderer-host'
import {
  literatureSnapshotSource,
  type LiteratureSnapshotRequest
} from '../../../../../shared/literature-snapshot'
import {
  SNAPSHOT_BATCH_CONCURRENCY,
  SNAPSHOT_BATCH_LIMIT,
  type SnapshotBatch,
  type SnapshotBatchRequest
} from '../../../../../shared/literature-snapshot-batch'

export function LiteratureSnapshotBatch({
  resolveSelection,
  hasSelection,
  onSnapshotSaved,
  onActiveRequestsChange
}: {
  resolveSelection(): Promise<string[]>
  hasSelection: boolean
  onSnapshotSaved?(request: LiteratureSnapshotRequest): void
  onActiveRequestsChange?(requests: LiteratureSnapshotRequest[]): void
}): React.JSX.Element {
  const { api } = useLiteratureHost()
  const { t, i18n } = useTranslation()
  const resultsId = useId()
  const [resultsExpanded, setResultsExpanded] = useState(false)
  const [job, setJob] = useState<SnapshotBatch | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
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
    if (!job || !onSnapshotSaved) return
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
      onSnapshotSaved(row.request)
    }
  }, [job, onSnapshotSaved])
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    const initialGeneration = generation.current
    void api.literature
      .snapshotBatch({ action: 'read' })
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
          return [itemId, item?.item.title ?? itemId] as const
        })
      )
        .then((rows) => {
          if (current) setTitles(Object.fromEntries(rows))
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
        .snapshotBatch({ action: 'read' })
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
    request: SnapshotBatchRequest,
    signal = lifetime.current.signal
  ): Promise<void> => {
    if (locked.current || signal.aborted) return
    generation.current++
    locked.current = true
    // Preserve a pause requested during start's asynchronous selection preparation.
    if (request.action !== 'start') stop.current = false
    setBusy(true)
    setError(false)
    try {
      let value = await api.literature.snapshotBatch(request)
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
            .slice(0, SNAPSHOT_BATCH_CONCURRENCY)
            .map((row) => row.request.itemId)
        )
        value = await api.literature.snapshotBatch({ action: 'advance', jobId: value.id })
        generation.current++
        if (!signal.aborted) setJob(value)
      }
      if (!signal.aborted && stop.current && value) {
        value = await api.literature.snapshotBatch({ action: 'pause', jobId: value.id })
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
      }
    }
  }
  const start = async (): Promise<void> => {
    if (locked.current) return
    const signal = lifetime.current.signal
    stop.current = false
    generation.current++
    locked.current = true
    setBusy(true)
    setError(false)
    try {
      const ids = await resolveSelection()
      signal.throwIfAborted()
      if (!ids.length || ids.length > SNAPSHOT_BATCH_LIMIT)
        throw new Error('Batch selection limit exceeded.')
      const language = i18n.resolvedLanguage ?? i18n.language
      const entries = await Promise.all(
        ids.map(async (itemId) => {
          const item = await api.literature.get(itemId)
          if (!item) throw new Error('Reference unavailable.')
          return { itemId, language, expectedSourceKey: literatureSnapshotSource(item).key }
        })
      )
      signal.throwIfAborted()
      locked.current = false
      await execute({ action: 'start', entries }, signal)
    } catch {
      if (!signal.aborted) {
        setError(true)
        setBusy(false)
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
  return (
    <section
      aria-label={t('Batch snapshots')}
      className="@container/snapshot-batch max-h-[40svh] w-full min-w-0 shrink-0 overflow-y-auto border-b p-3 focus-visible:-outline-offset-2"
      tabIndex={0}
      aria-busy={busy}
    >
      <div className="space-y-1 @min-[640px]/snapshot-batch:space-y-2">
        <div className="flex flex-wrap items-center gap-1 @min-[640px]/snapshot-batch:gap-2">
          <Button
            size="sm"
            className="h-auto min-h-7 max-w-full whitespace-normal px-2 text-xs @min-[640px]/snapshot-batch:min-h-8 @min-[640px]/snapshot-batch:px-2.5 @min-[640px]/snapshot-batch:text-[0.8rem]"
            disabled={busy || !hasSelection || unfinished}
            onClick={() => void start()}
          >
            {t('Generate batch snapshots')}
          </Button>
          <span
            className={`${job ? 'hidden @min-[640px]/snapshot-batch:inline' : ''} text-xs text-muted-foreground`}
          >
            {t('Select up to {{limit}} references.', { limit: SNAPSHOT_BATCH_LIMIT })}
          </span>
          {busy ? (
            <Button
              size="sm"
              className="h-auto min-h-7 max-w-full whitespace-normal px-2 text-xs @min-[640px]/snapshot-batch:min-h-8 @min-[640px]/snapshot-batch:px-2.5 @min-[640px]/snapshot-batch:text-[0.8rem]"
              variant="outline"
              onClick={() => {
                stop.current = true
              }}
            >
              {t('Pause after active references')}
            </Button>
          ) : job ? (
            <>
              {unfinished ? (
                <Button
                  size="sm"
                  className="h-auto min-h-7 max-w-full whitespace-normal px-2 text-xs @min-[640px]/snapshot-batch:min-h-8 @min-[640px]/snapshot-batch:px-2.5 @min-[640px]/snapshot-batch:text-[0.8rem]"
                  variant="outline"
                  disabled={hasRunningRows && !error}
                  onClick={() => void execute({ action: 'resume', jobId: job.id })}
                >
                  {t('Resume')}
                </Button>
              ) : null}
              {job.rows.some((row) => row.status === 'failed') ? (
                <Button
                  size="sm"
                  className="h-auto min-h-7 max-w-full whitespace-normal px-2 text-xs @min-[640px]/snapshot-batch:min-h-8 @min-[640px]/snapshot-batch:px-2.5 @min-[640px]/snapshot-batch:text-[0.8rem]"
                  variant="outline"
                  disabled={hasRunningRows && !error}
                  onClick={() => void execute({ action: 'retry', jobId: job.id })}
                >
                  {t('Retry failed snapshots')}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
        {!busy && job?.paused && job.rows.some((row) => row.status === 'failed') ? (
          <p className="text-xs text-muted-foreground" role="note">
            {t('Batch paused after a reference failed.')}
          </p>
        ) : null}
        {error ? (
          <ErrorNotice
            inline
            tone="amber"
            primaryButton={{
              label: t('Retry'),
              onClick: () => {
                const signal = lifetime.current.signal
                const currentGeneration = generation.current
                void api.literature
                  .snapshotBatch({ action: 'read' })
                  .then((value) => {
                    if (!signal.aborted && generation.current === currentGeneration) {
                      setJob(value)
                      setError(false)
                    }
                  })
                  .catch(() => {})
              }
            }}
            description={t(
              'Could not generate batch snapshots. Check the selection and try again.'
            )}
          />
        ) : null}
        {job ? (
          <>
            <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5 @min-[640px]/snapshot-batch:hidden">
              <div className="min-w-0 space-y-1 text-xs" role="status" aria-live="polite">
                <div className="flex flex-wrap gap-x-2 gap-y-1 tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    {t('Saved')}
                    <span className="rounded bg-muted px-1 tabular-nums">
                      {job.rows.filter((row) => row.status === 'succeeded').length}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {t('Failed')}
                    <span className="rounded bg-muted px-1 tabular-nums">
                      {job.rows.filter((row) => row.status === 'failed').length}
                    </span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    {t('Pending')}
                    <span className="rounded bg-muted px-1 tabular-nums">
                      {
                        job.rows.filter(
                          (row) => row.status === 'pending' && !activeRows.includes(row)
                        ).length
                      }
                    </span>
                  </span>
                </div>
                {activeRows.length ? (
                  <p className="line-clamp-1 min-w-0 [overflow-wrap:anywhere]">
                    <span aria-hidden="true" className="mr-1 rounded bg-muted px-1 tabular-nums">
                      {activeRows.length}
                    </span>
                    <span>
                      {t('Current references: {{titles}}', {
                        titles: activeRows
                          .map((row) => titles[row.request.itemId] ?? row.request.itemId)
                          .join(' / ')
                      })}
                    </span>
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-auto min-h-6 max-w-full whitespace-normal px-2 py-0 text-xs"
                aria-expanded={resultsExpanded}
                aria-controls={resultsId}
                onClick={() => setResultsExpanded((current) => !current)}
              >
                {resultsExpanded ? t('Hide reference results') : t('Show reference results')}
              </Button>
            </div>
            <ol
              id={resultsId}
              className={`${resultsExpanded ? 'block' : 'hidden'} space-y-1 text-xs @min-[640px]/snapshot-batch:block`}
              aria-live="polite"
            >
              {job.rows.map((row) => (
                <li key={row.request.itemId} className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                      {titles[row.request.itemId] ?? row.request.itemId}
                    </span>
                    <span className="shrink-0">
                      {row.status === 'succeeded'
                        ? t('Snapshot saved')
                        : row.status === 'failed'
                          ? t('Snapshot failed')
                          : activeRows.includes(row)
                            ? t('Generating overview…')
                            : t('Pending')}
                    </span>
                  </div>
                  {row.status === 'failed' ? (
                    <ErrorNotice inline tone="amber" description={failureDescription(row.issue)} />
                  ) : null}
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </div>
    </section>
  )
}
