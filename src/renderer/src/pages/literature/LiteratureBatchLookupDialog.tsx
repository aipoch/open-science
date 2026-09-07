import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { Button } from '@/components/ui/button'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogDescriptionClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import type { LiteratureItemView, LiteratureMetadataField } from '../../../../shared/literature'
import { formatBytes } from '../../../../shared/update'
import {
  literatureJobProgress,
  type LiteratureJobRequest
} from '../../../../shared/literature-jobs'

type BatchLookupMode = 'metadata' | 'full-text'
const progressClassName =
  'h-1.5 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary'
type Row = import('../../../../shared/literature-jobs').LiteratureJobRow
type Job = import('../../../../shared/literature-jobs').LiteratureJob

export const LiteratureBatchLookupDialog = ({
  itemIds,
  initialItems,
  mode,
  jobId: existingJobId,
  fieldLabel,
  onClose,
  onChanged
}: {
  itemIds: string[]
  initialItems: LiteratureItemView[]
  mode: BatchLookupMode
  jobId?: string
  fieldLabel: (field: LiteratureMetadataField) => string
  onClose: () => void
  onChanged: (itemIds: string[]) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [requestId] = useState(() => crypto.randomUUID())
  const [job, setJob] = useState<Job>()
  const [rows, setRows] = useState<Row[]>(() =>
    itemIds.map((id) => ({
      id,
      item: initialItems.find((item) => item.id === id),
      status: 'pending',
      checked: true
    }))
  )
  const [error, setError] = useState(false)
  const [sending, setSending] = useState(false)
  const jobRef = useRef<Job | undefined>(undefined)
  const failedCommand = useRef<LiteratureJobRequest | undefined>(undefined)
  const draftWrites = useRef(Promise.resolve())
  const pendingDrafts = useRef(
    new Map<string, { itemId: string; checked: boolean; candidateId?: string }>()
  )
  const receive = (value: Job): void => {
    const prior = jobRef.current
    if (prior && value.updatedAt < prior.updatedAt) return
    const changedRows = prior
      ? value.rows
          .filter((row, index) => row.status === 'done' && prior.rows[index]?.status !== 'done')
          .map((row) => row.id)
      : []
    jobRef.current = value
    if (!prior || prior.state !== value.state)
      window.dispatchEvent(new Event('literature-jobs-changed'))
    setJob(value)
    setRows((current) => {
      const byId = new Map(current.map((row) => [row.id, row]))
      return value.rows.map((row) => {
        const local = byId.get(row.id)
        return local && local.status === 'ready' && row.status === 'ready'
          ? {
              ...row,
              checked: local.checked,
              candidateId: row.candidates?.some(({ id }) => id === local.candidateId)
                ? local.candidateId
                : row.candidateId
            }
          : row
      })
    })
    if (changedRows.length) onChanged(changedRows)
  }
  const receiveFromPoll = useEffectEvent(receive)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let id = existingJobId
    let inFlight = false
    const poll = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await window.api.literature.jobs(
          id
            ? { action: 'get', jobId: id, ifUpdatedAt: jobRef.current?.updatedAt }
            : { action: 'create', mode, itemIds, requestId }
        )
        if (!active) return
        const value = result.jobs[0]
        if (value) {
          id = value.id
          receiveFromPoll(value)
        } else if (!jobRef.current) throw new Error('Task unavailable')
        else if (result.progress || jobRef.current.progress)
          setJob((current) => (current ? { ...current, progress: result.progress } : current))
        if (pendingDrafts.current.size === 0 && !failedCommand.current) setError(false)
      } catch {
        if (active) setError(true)
      } finally {
        inFlight = false
        const running =
          jobRef.current && ['queued', 'running', 'pausing'].includes(jobRef.current.state)
        if (active)
          timer = setTimeout(() => void poll(), !document.hidden && running ? 1000 : 30_000)
      }
    }
    timer = setTimeout(() => void poll(), 0)
    const wake = (): void => {
      if (!document.hidden) {
        clearTimeout(timer)
        void poll()
      }
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    window.addEventListener('literature-job-refresh', wake)
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('focus', wake)
      window.removeEventListener('literature-job-refresh', wake)
    }
  }, [existingJobId, requestId, mode, itemIds])
  const busy = !job || ['queued', 'running', 'pausing'].includes(job.state) || sending
  const stopping = job?.state === 'pausing'
  const progress = job?.progress?.value
  const download = job?.progress
  const saveDrafts = (): Promise<void> => {
    const write = async (): Promise<void> => {
      const currentJob = jobRef.current
      const selections = [...pendingDrafts.current.values()]
      if (!currentJob || selections.length === 0) return
      await window.api.literature.jobs({
        action: 'review',
        jobId: currentJob.id,
        selections
      })
      for (const selection of selections) {
        if (pendingDrafts.current.get(selection.itemId) === selection)
          pendingDrafts.current.delete(selection.itemId)
      }
    }
    // Retain failed selections so Retry and later commands can persist them again.
    draftWrites.current = draftWrites.current.then(write, write)
    return draftWrites.current
  }
  const update = (id: string, patch: Partial<Row>): void => {
    const row = rows.find((row) => row.id === id)
    if (!job || !row) return
    failedCommand.current = undefined
    const selected = { ...row, ...patch }
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    pendingDrafts.current.set(id, {
      itemId: id,
      checked: selected.checked,
      candidateId: selected.candidateId
    })
    void saveDrafts().then(
      () => setError(false),
      () => setError(true)
    )
  }
  const sendCommand = async (request: LiteratureJobRequest): Promise<void> => {
    if (sending) return
    setSending(true)
    try {
      await saveDrafts()
      failedCommand.current = request
      const result = await window.api.literature.jobs(request)
      failedCommand.current = undefined
      if (result.jobs[0]) receive(result.jobs[0])
      setError(false)
    } catch {
      setError(true)
    } finally {
      setSending(false)
    }
  }
  const command = async (action: 'apply' | 'retry' | 'resume' | 'pause'): Promise<void> => {
    if (!job) return
    await sendCommand(
      action === 'apply'
        ? {
            action,
            jobId: job.id,
            selections: rows
              .filter((row) => row.status === 'ready' && row.checked)
              .map((row) => ({ itemId: row.id, candidateId: row.candidateId }))
          }
        : { action, jobId: job.id }
    )
  }
  const messageLabels: Record<string, string> = {
    'Search again to refresh this older metadata review.': t(
      'Search again to refresh this older metadata review.'
    ),
    'Needs identifiers': t('Needs identifiers'),
    'No missing metadata was found.': t('No missing metadata was found.'),
    'PDF already attached': t('PDF already attached'),
    'Some sources were unavailable. Results may be incomplete.': t(
      'Some sources were unavailable. Results may be incomplete.'
    ),
    'No freely accessible full-text PDF was found.': t(
      'No freely accessible full-text PDF was found.'
    ),
    'Source rate limit reached. Search again later.': t(
      'Source rate limit reached. Search again later.'
    ),
    'The selected source changed. Search again and review the results.': t(
      'The selected source changed. Search again and review the results.'
    ),
    'Metadata could not be completed.': t('Metadata could not be completed.'),
    'PDF could not be added': t('PDF could not be added'),
    'Full-text search failed. Try again.': t('Full-text search failed. Try again.')
  }

  const ready = rows.filter((row) => row.status === 'ready' && row.checked).length
  const checked = rows.filter((row) => !['pending', 'searching'].includes(row.status)).length
  const done = rows.filter((row) => row.status === 'done').length
  const failed = rows.filter((row) => row.status === 'error').length
  const skipped = rows.filter((row) => row.status === 'skipped').length
  const title = mode === 'metadata' ? t('Complete metadata') : t('Find full-text PDF')
  const phaseProgress = job ? literatureJobProgress(job) : { processed: 0, phaseTotal: rows.length }
  const labels = {
    pending: t('Pending'),
    searching: t('Searching…'),
    ready: t('Awaiting review'),
    skipped: t('Skipped'),
    error: t('Failed'),
    saving: t('Saving…'),
    done: t('Completed')
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[85vh] w-[min(52rem,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <header className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{title}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {mode === 'metadata'
                  ? t('Review missing fields before applying. Existing values are kept.')
                  : t(
                      'Review a source for each reference before downloading. References with PDFs are skipped.'
                    )}
              </Dialog.Description>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('Close')}>
              <X aria-hidden="true" />
            </Button>
          </header>
          <div
            className="space-y-2 border-b border-border-300/60 px-5 py-3 text-xs text-muted-foreground"
            role="status"
          >
            {job ? (
              <p>{t('You can close this window. Tasks continue in the background.')}</p>
            ) : null}
            {error ? (
              <LiteratureErrorNotice
                title={t('Background task could not be updated. Try again.')}
                primaryButton={{
                  label: t('Retry'),
                  disabled: sending,
                  onClick: () => {
                    if (failedCommand.current) {
                      void sendCommand(failedCommand.current)
                      return
                    }
                    void saveDrafts().then(
                      () => window.dispatchEvent(new Event('literature-job-refresh')),
                      () => setError(true)
                    )
                  }
                }}
              />
            ) : null}
            <div className="flex flex-wrap justify-between gap-2 tabular-nums">
              <span>
                {job?.state === 'queued'
                  ? t('Queued')
                  : job?.phase === 'apply'
                    ? mode === 'full-text'
                      ? t('Downloading…')
                      : t('Saving…')
                    : t('Checked {{checked}} of {{total}}', { checked, total: rows.length })}
                {job?.phase === 'apply'
                  ? ` ${phaseProgress.processed}/${phaseProgress.phaseTotal}`
                  : ''}
              </span>
              <span>
                {t('Completed {{done}} · Skipped {{skipped}} · Failed {{failed}}', {
                  done,
                  skipped,
                  failed
                })}
              </span>
            </div>
            <progress
              className={progressClassName}
              max={phaseProgress.phaseTotal || 1}
              value={phaseProgress.processed}
              aria-label={
                job?.phase === 'apply'
                  ? mode === 'full-text'
                    ? t('Downloading…')
                    : t('Saving…')
                  : t('Search progress')
              }
            />
          </div>
          <ol className="min-h-0 flex-1 divide-y divide-border-300/60 overflow-y-auto px-5">
            {rows.map((row, index) => {
              const candidate = row.candidates?.find(({ id }) => id === row.candidateId)
              return (
                <li key={row.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 py-3">
                  <div className="pt-0.5 text-xs text-muted-foreground">
                    {row.status === 'ready' ? (
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={row.checked}
                        disabled={busy}
                        aria-label={`${t('Select reference')}: ${row.item?.item.title ?? row.id}`}
                        onChange={(event) => update(row.id, { checked: event.target.checked })}
                      />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <div className="min-w-0 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 text-sm font-medium leading-5">
                        {row.item?.item.title ?? t('Reference')}
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {labels[row.status]}
                      </span>
                    </div>
                    {row.message ? (
                      <p className="text-xs text-muted-foreground">
                        {messageLabels[row.message] ?? row.message}
                      </p>
                    ) : null}
                    {row.notices?.includes('openalex-not-configured') ? (
                      <p className="text-xs text-muted-foreground">
                        {t('OpenAlex')}: {t('API key required')}
                      </p>
                    ) : null}
                    {row.notices?.includes('unpaywall-not-configured') ? (
                      <p className="text-xs text-muted-foreground">
                        {t('Unpaywall')}: {t('Contact email required')}
                      </p>
                    ) : null}
                    {row.metadata ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-primary">
                          {t('View details')} ·{' '}
                          {row.metadata.provider === 'crossref' ? 'Crossref' : 'PubMed'} ·{' '}
                          {t('{{count}} missing fields', {
                            count: row.metadata.filled.length,
                            defaultValue_one: '{{count}} missing field'
                          })}
                        </summary>
                        <dl className="mt-2 space-y-2">
                          {row.metadata.filled.map(({ field, value }) => (
                            <div key={field}>
                              <dt className="text-muted-foreground">{fieldLabel(field)}</dt>
                              <dd className="break-words">{value}</dd>
                            </div>
                          ))}
                          {row.metadata.conflicts.length ? (
                            <div>
                              <dt className="font-medium">{t('Existing values kept')}</dt>
                              <dd className="mt-1 space-y-1">
                                {row.metadata.conflicts.map(({ field, currentValue }) => (
                                  <p key={field}>
                                    {fieldLabel(field)}: {currentValue}
                                  </p>
                                ))}
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      </details>
                    ) : null}
                    {candidate ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={row.candidateId}
                          disabled={busy || row.status === 'done'}
                          onValueChange={(candidateId) => update(row.id, { candidateId })}
                        >
                          <SelectTrigger
                            className="h-8 min-w-0 flex-1 text-xs"
                            aria-label={`${t('Source')}: ${row.item?.item.title ?? row.id}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {row.candidates?.map((source) => (
                              <SelectItem key={source.id} value={source.id}>
                                {source.source} · {new URL(source.sourceUrl ?? source.url).hostname}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <ExternalTextLink
                          href={candidate.sourceUrl ?? new URL(candidate.url).origin}
                          className="shrink-0 text-xs"
                        >
                          {t('Open source')}
                        </ExternalTextLink>
                      </div>
                    ) : null}
                    {download?.itemId === row.id && progress ? (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <progress
                          className={progressClassName}
                          max={progress.totalBytes}
                          value={progress.totalBytes ? progress.receivedBytes : undefined}
                          aria-label={t('Downloading…')}
                        />
                        <p>
                          {formatBytes(progress.receivedBytes)}
                          {progress.totalBytes
                            ? ` / ${formatBytes(progress.totalBytes)}`
                            : ''} · {formatBytes(progress.bytesPerSecond)}/s
                        </p>
                      </div>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
          <footer
            className={`${dialogFooterClassName} flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
          >
            {error && !job ? (
              <Button variant="ghost" onClick={onClose}>
                {t('Close')}
              </Button>
            ) : busy ? (
              <>
                <Button variant="ghost" onClick={onClose}>
                  {t('Run in background')}
                </Button>
                {job?.state !== 'queued' ? (
                  <LoaderCircle
                    className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : null}
                <Button
                  variant="outline"
                  disabled={stopping}
                  onClick={() => {
                    void command('pause')
                  }}
                >
                  {stopping ? t('Pausing after the current reference…') : t('Pause')}
                </Button>
              </>
            ) : (
              <>
                {job?.state === 'paused' ? (
                  <Button onClick={() => void command('resume')}>{t('Resume')}</Button>
                ) : null}
                <Button variant="ghost" onClick={onClose}>
                  {t('Close')}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void command('retry')}
                  disabled={done === rows.length}
                >
                  {checked ? t('Search again') : t('Search')}
                </Button>
                <Button disabled={!ready} onClick={() => void command('apply')}>
                  {mode === 'metadata' ? t('Apply metadata') : t('Add attachment')} ({ready})
                </Button>
              </>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export type { BatchLookupMode }
